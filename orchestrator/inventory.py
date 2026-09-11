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
from collections import Counter

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


def decrement_stock(item_names: list[str]):
    """Fire-and-forget: submitted to a thread pool, not awaited.

    Counts duplicates first ("two bottles of water" is one call with the
    name twice): decrementing per-occurrence off the cached value would
    write `stock-1` twice from the same stale base and lose one unit. The
    in-place cache write afterwards keeps a same-window second order
    honest too, until the next refresh."""
    def _do():
        for name, n in Counter(x.lower() for x in item_names).items():
            row = _cache.get(name)
            if row and row.get("stock_count") is not None:
                new = max(row["stock_count"] - n, 0)
                _get_client().table("inventory_items").update(
                    {"stock_count": new}
                ).eq("id", row["id"]).execute()
                row["stock_count"] = new
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
    asyncio.get_running_loop().run_in_executor(None, _do)


def insert_escalation(reason: str, room: str | None):
    def _do():
        _get_client().table("frontdesk_escalations").insert(
            {"reason": reason, "room": room}
        ).execute()
    asyncio.get_running_loop().run_in_executor(None, _do)


def insert_tool_call_event(tool_name: str, arguments: dict, result_summary: str):
    def _do():
        _get_client().table("tool_call_events").insert({
            "tool_name": tool_name, "arguments": arguments,
            "result_summary": result_summary[:500],
        }).execute()
    asyncio.get_running_loop().run_in_executor(None, _do)


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
        try:
            await decrement_stock([name, name])
            after = (_get_client().table("inventory_items").select("stock_count")
                     .eq("id", row["id"]).execute().data[0]["stock_count"])
            assert after == before - 2, f"{name}: {before} -> {after}, expected {before - 2}"
            assert _cache[name]["stock_count"] == after, "cache not updated in place"
            print(f"duplicate-item decrement OK ({name}: {before} -> {after})")
        finally:
            _get_client().table("inventory_items").update(
                {"stock_count": before}).eq("id", row["id"]).execute()
            _cache[name]["stock_count"] = before

    def demo():
        refresh_cache_sync()
        print(f"cache loaded: {len(_cache)} items")

        result = lookup_items(["definitely_not_a_real_item_xyz"])
        assert result[0]["available"] is False
        assert result[0]["in_stock"] is False
        print("unknown-item lookup OK")

        asyncio.run(_duplicate_decrement_roundtrip())

        print("inventory self-check OK (schema + cache read confirmed live)")

    demo()
