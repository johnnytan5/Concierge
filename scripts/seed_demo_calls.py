"""Seed a few realistic guest calls, so the admin dashboard's Call log,
Deliveries and Escalations tabs show something without needing a microphone.

Drives the REAL code paths, not raw SQL inserts: `ToolHandlers.dispatch` is
the same entry point `orchestrator/agent.py` calls on a `tool.call` event, so
every side effect is genuinely produced by production code — availability
validation, stock decrement, the `inventory_audit_log` row, the `deliveries`
row and the `tool_call_events` row all happen the way they do on a live call.
Transcript turns and the session row go through `inventory.py`'s own helpers.

The one thing that is NOT production behaviour is the timestamp backdating at
the end: rows are written now, then moved onto an evening timeline so the Call
log reads like a shift rather than like three calls in the same second.

    .venv/bin/python scripts/seed_demo_calls.py            # seed
    .venv/bin/python scripts/seed_demo_calls.py --remove   # undo, restoring stock

Everything it creates is reachable from the `sess_demo_` session ids, which is
how --remove finds it again.
"""
import argparse
import asyncio
import os
import re
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from dotenv import load_dotenv

load_dotenv()

from orchestrator import inventory  # noqa: E402
from orchestrator.tools import ToolHandlers  # noqa: E402

SESSION_PREFIX = "sess_demo_"
LIVE_SESSION_ID = SESSION_PREFIX + "inprogress"
AGENT_ID = "demo-seed"

# An in-progress call, for looking at the Live call tab. Left OPEN (no
# end_voice_session) with timestamps at now, which is exactly what a real
# call in flight looks like to the dashboard.
#
# The dashboard treats an open session with no activity for 90s as abandoned
# rather than live -- agent.py closes sessions in a `finally` that a hard kill
# never reaches, so "ended_at is null" alone cannot mean "live". That makes
# this seed a ~90 second window by design. Re-run --live for another one.
LIVE_SCRIPT = [
    ("guest", "Hi, room one two zero four again. Can I add a teh tarik to that order?"),
    ("tool", "check_menu", {"items": ["teh tarik"]}),
    ("agent", "Teh tarik is five ringgit and it's halal. Want me to send one up?"),
]


class _FakeQueue:
    """Stands in for task_engine's cmd_queue. The engine is not running during
    a seed, so dispatch commands are collected and dropped — the `deliveries`
    rows they would have produced are written by the handler itself."""

    def __init__(self):
        self.items = []

    def put(self, item):
        self.items.append(item)


# Three calls, oldest first. `turns` interleave with `calls` by position:
# each entry is ("guest"|"agent", text) or ("tool", tool_name, arguments).
CALLS = [
    {
        "id": SESSION_PREFIX + "towels1204",
        "minutes_ago": 96,
        "script": [
            ("guest", "Hi, this is room one two zero four. Can I get two extra towels sent up please?"),
            ("agent", "Of course — two extra towels to room 1204. Anything else?"),
            ("guest", "No, that's all. Thanks."),
            ("tool", "dispatch_delivery", {"room": "1204", "items": ["towel", "towel"], "priority": "normal"}),
            ("agent", "Two towels are on the way to room 1204. They should reach you in about a minute and a half."),
        ],
    },
    {
        # PLAN.md's S3 — Manglish with mid-utterance code switching, and the
        # exact dish agent.py biases for in KEYTERMS.
        "id": SESSION_PREFIX + "ckt0803",
        "minutes_ago": 41,
        "script": [
            ("guest", "Boss, can you hantar satu towel to my room ah, then also I want the char kuey teow. Room oh eight oh three."),
            ("tool", "check_menu", {"items": ["char kuey teow"]}),
            ("agent", "Char kuey teow is twelve ringgit and it's halal. Shall I send that up with a towel to room 0803?"),
            ("guest", "Yes yes, can. Thank you ah."),
            ("tool", "dispatch_delivery", {"room": "0803", "items": ["towel", "char kuey teow"], "priority": "normal"}),
            ("agent", "One towel and one char kuey teow heading to room 0803 now."),
        ],
    },
    {
        # Ends in an escalation, so the Escalations tab has an open row and the
        # Call log shows the alert treatment on a call.
        "id": SESSION_PREFIX + "latechk1512",
        "minutes_ago": 13,
        "script": [
            ("guest", "Hello, room one five one two. I want to ask about late checkout tomorrow, can extend until 3pm?"),
            ("agent", "Late checkout isn't something I can arrange myself — let me pass this to the front desk."),
            ("tool", "escalate_to_frontdesk", {"reason": "Guest requesting late checkout until 3pm tomorrow", "room": "1512"}),
            ("agent", "I've passed that to the front desk. Someone will call you back shortly."),
        ],
    },
]


async def seed():
    client = inventory._get_client()
    await asyncio.get_running_loop().run_in_executor(None, inventory.refresh_cache_sync)
    print(f"menu cache primed: {len(inventory.all_items())} items")

    state = {"tasks": {}, "robots": {}}

    for call in CALLS:
        sid = call["id"]
        base = datetime.now(timezone.utc) - timedelta(minutes=call["minutes_ago"])

        inventory.insert_voice_session(sid, agent_id=AGENT_ID)
        handlers = ToolHandlers(_FakeQueue(), state, session_id=sid)

        offset = 0
        for step in call["script"]:
            if step[0] == "tool":
                _, name, args = step
                result = handlers.dispatch(name, args)
                print(f"  {sid}: {name} -> {str(result)[:90]}")
            else:
                role, text = step
                await inventory.insert_transcript_turn(sid, role, text)
            offset += 1

        # let the fire-and-forget writes land before we start backdating
        await asyncio.sleep(1.5)
        inventory.end_voice_session(sid)
        _backdate(client, sid, base)
        print(f"  {sid}: backdated to {base:%H:%M:%S} UTC")

    _shape_deliveries(client)
    _shape_robots(client)
    print("\nseeded. open the Call log tab.")


async def seed_live():
    """Seed (or refresh) the one in-progress call. Safe to re-run: it clears
    the previous live session first, so you never end up with two."""
    client = inventory._get_client()
    await asyncio.get_running_loop().run_in_executor(None, inventory.refresh_cache_sync)
    _drop_live(client)

    inventory.insert_voice_session(LIVE_SESSION_ID, agent_id=AGENT_ID)
    handlers = ToolHandlers(_FakeQueue(), {"tasks": {}, "robots": {}},
                            session_id=LIVE_SESSION_ID)
    for step in LIVE_SCRIPT:
        if step[0] == "tool":
            _, name, args = step
            handlers.dispatch(name, args)
        else:
            await inventory.insert_transcript_turn(LIVE_SESSION_ID, step[0], step[1])
    await asyncio.sleep(1.5)

    # deliberately NOT ended: this is a call in flight
    print(f"live call seeded as {LIVE_SESSION_ID} -- open the Live call tab.\n"
          "It reads as live for ~90s, then falls back to 'Last call'. "
          "Re-run with --live for another window.")


def _drop_live(client):
    client.table("tool_call_events").delete().eq("session_id", LIVE_SESSION_ID).execute()
    client.table("voice_sessions").delete().eq("id", LIVE_SESSION_ID).execute()


def _shape_robots(client):
    """Put the fleet in step with the deliveries just shaped.

    Without this the Deliveries tab shows a task EN_ROUTE on robot_2 while the
    Fleet tab shows robot_2 idle with no task — the two tabs disagreeing about
    the same robot. Also gives the Fleet tab a card with real progress, so the
    phase steps and leg bar render as something other than empty.

    The task engine overwrites all of this within a second of starting, which
    is correct: it is the authority on robot state, this is only a still life
    for when it is not running.
    """
    live = (client.table("deliveries").select("task_id,robot_id")
            .eq("phase", "EN_ROUTE").execute().data)
    for row in live:
        if not row["robot_id"]:
            continue
        client.table("robots").update({
            "phase": "EN_ROUTE",
            "current_task_id": row["task_id"],
            "pose_frac": 0.42,
            "battery": 78,
        }).eq("id", row["robot_id"]).execute()
    print(f"put {len(live)} robot(s) on their delivery")


def _backdate(client, session_id: str, base: datetime):
    """Spread one call's rows over a plausible ~40s conversation, and move the
    session itself onto the evening timeline."""
    turns = (client.table("transcript_turns").select("id")
             .eq("session_id", session_id).order("created_at").execute().data)
    calls = (client.table("tool_call_events").select("id")
             .eq("session_id", session_id).order("created_at").execute().data)

    # Interleave roughly: turns every ~8s, tool calls nudged between them.
    for n, row in enumerate(turns):
        ts = (base + timedelta(seconds=8 * n)).isoformat()
        client.table("transcript_turns").update({"created_at": ts}).eq("id", row["id"]).execute()
    for n, row in enumerate(calls):
        ts = (base + timedelta(seconds=8 * n + 5)).isoformat()
        client.table("tool_call_events").update({"created_at": ts}).eq("id", row["id"]).execute()

    span = 8 * max(len(turns), 1)
    client.table("voice_sessions").update({
        "started_at": base.isoformat(),
        "ended_at": (base + timedelta(seconds=span + 4)).isoformat(),
    }).eq("id", session_id).execute()

    # the escalation this call raised, if any
    client.table("frontdesk_escalations").update({
        "created_at": (base + timedelta(seconds=span)).isoformat(),
    }).eq("room", "1512").eq("status", "open").execute()


def _shape_deliveries(client):
    """Move the seeded deliveries onto the timeline and finish the older one,
    so the Deliveries tab has both a completed and an in-flight row and the
    fleet's median desk->door actually computes."""
    task_ids = _demo_task_ids(client)
    if not task_ids:
        return
    rows = (client.table("deliveries").select("*")
            .in_("task_id", task_ids).order("created_at").execute().data)

    for n, row in enumerate(rows):
        base = datetime.now(timezone.utc) - timedelta(minutes=96 - n * 55)
        patch = {
            "created_at": base.isoformat(),
            "dispatched_at": (base + timedelta(seconds=40)).isoformat(),
            "robot_id": "robot_1" if n % 2 == 0 else "robot_2",
        }
        if n == 0:
            # oldest one completed, giving the Delivered filter a row
            patch["phase"] = "DONE"
            patch["arrived_at"] = (base + timedelta(seconds=40 + 347)).isoformat()
        else:
            patch["phase"] = "EN_ROUTE"
        client.table("deliveries").update(patch).eq("task_id", row["task_id"]).execute()
    print(f"shaped {len(rows)} deliveries ({task_ids})")


TASK_ID_RE = re.compile(r"['\"]task_id['\"]\s*:\s*['\"]([A-Za-z0-9_]+)['\"]")


def _demo_task_ids(client) -> list[str]:
    """Task ids belong to the demo if the tool call that created them carried
    a demo session id.

    Read from the structured `result` column. The regex fallback covers rows
    written before that column existed, when result_summary held Python's
    str(dict) of the handler's return — same two-step CallFlow.tsx does.
    """
    rows = (client.table("tool_call_events").select("session_id,result,result_summary")
            .like("session_id", SESSION_PREFIX + "%").execute().data)
    out = []
    for r in rows:
        result = r.get("result")
        if isinstance(result, dict) and result.get("task_id"):
            out.append(str(result["task_id"]))
            continue
        m = TASK_ID_RE.search(r.get("result_summary") or "")
        if m:
            out.append(m.group(1))
    return sorted(set(out))


def remove():
    client = inventory._get_client()
    task_ids = _demo_task_ids(client)

    # Put the stock back before deleting the audit rows that record it.
    restored = 0
    if task_ids:
        audit = (client.table("inventory_audit_log").select("*")
                 .in_("task_id", task_ids).execute().data)
        for row in audit:
            if row["item_id"] is None:
                continue
            cur = (client.table("inventory_items").select("stock_count")
                   .eq("id", row["item_id"]).execute().data)
            if cur and cur[0]["stock_count"] is not None:
                client.table("inventory_items").update({
                    "stock_count": cur[0]["stock_count"] - row["delta"],  # delta is negative
                }).eq("id", row["item_id"]).execute()
                restored += 1
        client.table("inventory_audit_log").delete().in_("task_id", task_ids).execute()
        client.table("deliveries").delete().in_("task_id", task_ids).execute()

    client.table("frontdesk_escalations").delete().eq("room", "1512").execute()
    client.table("tool_call_events").delete().like("session_id", SESSION_PREFIX + "%").execute()
    # transcript_turns go with the session (ON DELETE CASCADE)
    client.table("voice_sessions").delete().like("id", SESSION_PREFIX + "%").execute()

    # park the fleet again, so Fleet doesn't keep claiming a deleted task
    for rid in ("robot_1", "robot_2"):
        client.table("robots").update({
            "phase": "IDLE", "current_task_id": None, "pose_frac": 0, "battery": 100,
        }).eq("id", rid).execute()

    print(f"removed demo calls; restored stock on {restored} item(s); "
          f"deleted {len(task_ids)} delivery row(s)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--remove", action="store_true", help="undo a previous seed")
    ap.add_argument("--live", action="store_true",
                    help="seed only the in-progress call, for the Live call tab")
    args = ap.parse_args()

    if args.remove:
        remove()
    elif args.live:
        asyncio.run(seed_live())
    else:
        asyncio.run(seed())
