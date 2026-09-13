"""Local inventory cache + fire-and-forget Supabase writes for Process 1.

Tool handlers in orchestrator/tools.py read via lookup_items()/
all_items() — instant, local, no network — and never await a Supabase
call before returning tool.result (CLAUDE.md constraint 2). The cache is
refreshed periodically by start_refresh_loop() (call once as an asyncio
task alongside the main WS loop); writes go out via run_in_executor so a
slow Supabase response can never block the event loop.
"""
import asyncio
import os
import uuid
from collections import Counter
from datetime import datetime, timezone

from supabase import create_client, Client

REFRESH_SECONDS = 30.0  # staleness window for admin-edited inventory —
                          # fine for a hotel menu, avoids a second async
                          # subsystem (Realtime) this project doesn't need yet

_client: Client | None = None
_cache: dict[str, dict] = {}  # name.lower() -> raw inventory_items row


def _get_client() -> Client:
    global _client
    if _client is None:
        _client = create_client(
            os.environ["SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        )
    return _client


def refresh_cache_sync():
    """Blocking network call — only call via run_in_executor, never
    directly from the asyncio event loop."""
    global _cache
    resp = _get_client().table("inventory_items").select("*").execute()
    _cache = {row["name"].lower(): row for row in resp.data}


async def start_refresh_loop():
    """Run as an asyncio task: `asyncio.create_task(start_refresh_loop())`.

    One failed refresh must not kill the task — an uncaught exception here
    ends the loop silently and freezes the cache at whatever it last held,
    with nothing in the demo indicating the menu has stopped updating. Warn
    and keep looping instead; the previous cache contents stay serviceable."""
    loop = asyncio.get_running_loop()
    while True:
        try:
            await loop.run_in_executor(None, refresh_cache_sync)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[inventory] cache refresh failed, keeping previous cache: {e!r}")
        await asyncio.sleep(REFRESH_SECONDS)


def _to_public(row: dict) -> dict:
    return {
        "name": row["name"],
        "category": row["category"],
        "price": row["price"],
        "dietary_tags": row["dietary_tags"],
        "available": row["available"],
        "in_stock": row["stock_count"] is None or row["stock_count"] > 0,
    }


def lookup_items(names: list[str]) -> list[dict]:
    """Local cache only — instant. Unknown names come back with
    available=False rather than being omitted, so a caller can report
    "not offered" instead of silently saying nothing."""
    out = []
    for name in names:
        row = _cache.get(name.lower())
        if row is None:
            out.append({"name": name, "category": None, "price": None,
                        "dietary_tags": [], "available": False, "in_stock": False})
        else:
            out.append(_to_public(row))
    return out


def all_items() -> list[dict]:
    return [_to_public(row) for row in _cache.values()]


def decrement_stock(item_names: list[str], task_id: str | None = None,
                     source: str = "dispatch_delivery"):
    """Fire-and-forget: submitted to a thread pool, not awaited.

    Counts duplicates first ("two bottles of water" is one call with the
    name twice): decrementing per-occurrence off the cached value would
    write `stock-1` twice from the same stale base and lose one unit. The
    in-place cache write afterwards keeps a same-window second order
    honest too, until the next refresh.

    Also writes one `inventory_audit_log` row per distinct item changed --
    this is the only place a stock change is recorded with its before/after
    value and what triggered it. `stock_count` itself is updated in place
    with no history; without this, "customer ordered 2 towels -> stock -2"
    is unrecoverable after the fact. `task_id` correlates an audit row back
    to `deliveries.task_id` when the change came from a real dispatch."""
    def _do():
        for name, n in Counter(x.lower() for x in item_names).items():
            row = _cache.get(name)
            if row and row.get("stock_count") is not None:
                before = row["stock_count"]
                new = max(before - n, 0)
                _get_client().table("inventory_items").update(
                    {"stock_count": new}
                ).eq("id", row["id"]).execute()
                row["stock_count"] = new
                _get_client().table("inventory_audit_log").insert({
                    "item_id": row["id"], "item_name": row["name"],
                    "delta": new - before, "before_count": before,
                    "after_count": new, "task_id": task_id, "source": source,
                }).execute()
    # returns the Future so a test can await it; production ignores it
    return asyncio.get_running_loop().run_in_executor(None, _do)


def insert_delivery(task: dict):
    def _do():
        _get_client().table("deliveries").insert({
            "task_id": task["task_id"],
            "room": task["room"],
            "items": task["items"],
            "phase": task["phase"],
            "priority": task["priority"],
        }).execute()
    # returns the Future so a test can await it; production ignores it
    return asyncio.get_running_loop().run_in_executor(None, _do)


def insert_escalation(reason: str, room: str | None):
    def _do():
        _get_client().table("frontdesk_escalations").insert(
            {"reason": reason, "room": room}
        ).execute()
    # returns the Future so a test can await it; production ignores it
    return asyncio.get_running_loop().run_in_executor(None, _do)


def insert_voice_session(session_id: str, agent_id: str | None = None):
    """BLOCKING on purpose, and the only write in this module that is.

    tool_call_events.session_id and transcript_turns.session_id are both
    real FKs onto this row, so it has to land before the first tool call
    or transcript turn of the session -- all of which go out
    fire-and-forget through the thread pool with nobody awaiting their
    result. Called once at startup, before the WS event loop begins, so
    the cost is paid where nothing is waiting on it. Let it raise: a
    session that cannot register is a session with no audit trail, and
    that should be loud at startup rather than silent for the whole call.
    """
    _get_client().table("voice_sessions").insert(
        {"id": session_id, "agent_id": agent_id}
    ).execute()


def end_voice_session(session_id: str):
    """Best-effort close-out. A missing ended_at just renders the call as
    still open in the dashboard, which is not worth crashing a shutdown
    path over."""
    try:
        _get_client().table("voice_sessions").update(
            {"ended_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", session_id).execute()
    except Exception as e:
        print(f"[inventory] could not close voice session {session_id}: {e!r}")


def insert_transcript_turn(session_id: str, role: str, text: str):
    """One row per transcript.user / transcript.agent event. Fire-and-forget
    like every other write here -- CLAUDE.md constraint 2 covers the whole
    event loop, not just tool handlers, and a transcript row is never on
    any critical path."""
    def _do():
        _get_client().table("transcript_turns").insert({
            "session_id": session_id, "role": role, "text": text,
        }).execute()
    # returns the Future so a test can await it; production ignores it
    return asyncio.get_running_loop().run_in_executor(None, _do)


def insert_tool_call_event(tool_name: str, arguments: dict, result_summary: str,
                            session_id: str | None = None, result=None):
    """`result_summary` is one plain sentence (see tools.summarize_result) for
    the dashboard's staff view; `result` is the handler's structured return,
    stored as jsonb for dev view. Storing only str(result) in the summary
    column, as this once did, left a Python repr on a staff-facing screen."""
    def _do():
        _get_client().table("tool_call_events").insert({
            "tool_name": tool_name, "arguments": arguments,
            "session_id": session_id,
            "result": result,
            "result_summary": result_summary[:500],
        }).execute()
    # returns the Future so a test can await it; production ignores it
    return asyncio.get_running_loop().run_in_executor(None, _do)


if __name__ == "__main__":
    # ponytail: real Supabase, not a mock — this is the actual
    # integration point. Requires Task 1's schema + real .env values.
    from dotenv import load_dotenv
    load_dotenv()

    async def _duplicate_decrement_roundtrip():
        """Real Supabase round trip: order the same item twice in ONE call
        and prove stock drops by 2, not 1. Restores the original count
        afterwards so the seeded demo data is left as found."""
        name, row = next(((n, r) for n, r in _cache.items()
                          if r.get("stock_count") is not None and r["stock_count"] >= 2), (None, None))
        if row is None:
            print("no stock-tracked item with count >= 2 — skipping duplicate-decrement check")
            return
        before = row["stock_count"]
        audit_id = None
        try:
            await decrement_stock([name, name], task_id="selfcheck_task")
            after = (_get_client().table("inventory_items").select("stock_count")
                     .eq("id", row["id"]).execute().data[0]["stock_count"])
            assert after == before - 2, f"{name}: {before} -> {after}, expected {before - 2}"
            assert _cache[name]["stock_count"] == after, "cache not updated in place"
            print(f"duplicate-item decrement OK ({name}: {before} -> {after})")

            audit_rows = (_get_client().table("inventory_audit_log").select("*")
                          .eq("item_id", row["id"]).eq("task_id", "selfcheck_task")
                          .order("created_at", desc=True).limit(1).execute().data)
            assert audit_rows, "no inventory_audit_log row written for the decrement"
            audit = audit_rows[0]
            audit_id = audit["id"]
            assert audit["before_count"] == before, audit
            assert audit["after_count"] == after, audit
            assert audit["delta"] == after - before, audit
            assert audit["source"] == "dispatch_delivery", audit
            print(f"inventory_audit_log OK (before={audit['before_count']}, "
                  f"after={audit['after_count']}, delta={audit['delta']})")
        finally:
            _get_client().table("inventory_items").update(
                {"stock_count": before}).eq("id", row["id"]).execute()
            _cache[name]["stock_count"] = before
            if audit_id:
                _get_client().table("inventory_audit_log").delete().eq("id", audit_id).execute()

    async def _voice_session_roundtrip():
        """The Call log's whole premise: that tool calls and transcript turns
        written during one WS session can be grouped back into one
        conversation afterwards. Proves the session row, both child writes,
        the FK, and the grouping read -- live, then cleans up after itself."""
        session_id = "sess_selfcheck_" + uuid.uuid4().hex[:8]
        client = _get_client()

        insert_voice_session(session_id, agent_id="selfcheck-agent")
        try:
            row = (client.table("voice_sessions").select("*")
                   .eq("id", session_id).execute().data[0])
            assert row["agent_id"] == "selfcheck-agent", row
            assert row["started_at"] and row["ended_at"] is None, row

            # children reference the session; awaited here, fire-and-forget live
            await insert_transcript_turn(session_id, "guest", "two towels to 1204 please")
            await insert_transcript_turn(session_id, "agent", "Sending two towels up now.")
            await insert_tool_call_event(
                "dispatch_delivery", {"room": "1204", "items": ["towel", "towel"]},
                "{'task_id': 'selfchk1'}", session_id=session_id)

            turns = (client.table("transcript_turns").select("*")
                     .eq("session_id", session_id).order("created_at").execute().data)
            assert [t["role"] for t in turns] == ["guest", "agent"], turns
            assert turns[0]["text"].startswith("two towels"), turns

            calls = (client.table("tool_call_events").select("*")
                     .eq("session_id", session_id).execute().data)
            assert len(calls) == 1 and calls[0]["tool_name"] == "dispatch_delivery", calls
            # arguments must survive the round trip as real jsonb, not a string
            assert calls[0]["arguments"]["items"] == ["towel", "towel"], calls[0]

            end_voice_session(session_id)
            closed = (client.table("voice_sessions").select("ended_at")
                      .eq("id", session_id).execute().data[0])
            assert closed["ended_at"], closed
            print(f"voice-session round trip OK ({len(turns)} turns, {len(calls)} tool call, "
                  "grouped by session_id)")
        finally:
            # tool_call_events.session_id is ON DELETE SET NULL, so that row
            # outlives the session and has to go explicitly; transcript_turns
            # is ON DELETE CASCADE and goes with it.
            client.table("tool_call_events").delete().eq("session_id", session_id).execute()
            client.table("voice_sessions").delete().eq("id", session_id).execute()

    def demo():
        refresh_cache_sync()
        print(f"cache loaded: {len(_cache)} items")

        result = lookup_items(["definitely_not_a_real_item_xyz"])
        assert result[0]["available"] is False
        assert result[0]["in_stock"] is False
        print("unknown-item lookup OK")

        asyncio.run(_duplicate_decrement_roundtrip())
        asyncio.run(_voice_session_roundtrip())

        print("inventory self-check OK (schema + cache read confirmed live)")

    demo()
