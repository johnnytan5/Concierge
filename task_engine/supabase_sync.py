"""Supabase read/write glue for Process 2 (task_engine). Called from
task_engine's own tick loop, not from orchestrator's tool handlers —
The <100ms tool-handler rule applies to tool handlers, not here, so
plain synchronous Supabase calls are fine in this module.
"""
import os
import time
import uuid
from datetime import datetime, timezone

from supabase import create_client, Client

_client: Client | None = None


def _get_client() -> Client:
    global _client
    if _client is None:
        _client = create_client(
            os.environ["SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        )
    return _client


def poll_pending_commands(robot_ids: list[str]) -> list[dict]:
    """`cmd` is one of complete_loading / complete_collection (the robot
    screen's human confirmations) or recall (the admin dashboard's Fleet
    tab). `reason` only accompanies recall. Ordered so a burst of commands
    for one robot is applied in the order an operator issued them."""
    resp = (_get_client().table("robot_commands")
            .select("id,robot_id,cmd,reason")
            .eq("status", "pending")
            .in_("robot_id", robot_ids)
            .order("created_at")
            .execute())
    return resp.data


def mark_command_done(command_id: str):
    _get_client().table("robot_commands").update({
        "status": "done",
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", command_id).execute()


def mirror_robot(robot_id: str, phase: str, current_task_id, pose_frac: float, battery: float):
    _get_client().table("robots").upsert({
        "id": robot_id, "phase": phase, "current_task_id": current_task_id,
        "pose_frac": pose_frac, "battery": battery,
    }).execute()


def _iso(epoch: float | None) -> str | None:
    """Engine timestamps are epoch floats (time.time()); the deliveries
    columns are timestamptz. None-safe — a task that hasn't left the desk
    has no dispatched_at yet."""
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat() if epoch else None


def mirror_delivery(task: dict, robot_id: str | None = None):
    """`robot_id` is the robot that owns (or last owned) this task — the
    engine knows it, so the deliveries FK should not be left NULL for the
    dashboards in Sub-project B to guess at. Same for the two timestamps."""
    _get_client().table("deliveries").upsert({
        "task_id": task["task_id"], "room": task["room"], "items": task["items"],
        "phase": task["phase"], "priority": task["priority"],
        "robot_id": robot_id,
        "dispatched_at": _iso(task.get("dispatched_at")),
        "arrived_at": _iso(task.get("arrived_at")),
    }).execute()


if __name__ == "__main__":
    # ponytail: real Supabase, not a mock. Requires Task 1's schema.
    from dotenv import load_dotenv
    load_dotenv()

    def demo():
        mirror_robot("robot_1", "IDLE", None, 0.0, 100.0)
        row = _get_client().table("robots").select("*").eq("id", "robot_1").execute().data[0]
        assert row["phase"] == "IDLE"

        pending = poll_pending_commands(["robot_1", "robot_2"])
        assert isinstance(pending, list)  # empty is fine — no commands inserted yet

        # robot_id + both timestamps must actually land (they were dropped
        # on the floor before the final review's I3)
        tid = "selfcheck_" + uuid.uuid4().hex[:8]
        dispatched, arrived = time.time() - 60, time.time()
        mirror_delivery({"task_id": tid, "room": "1204", "items": ["towel"],
                          "phase": "ARRIVED", "priority": "normal",
                          "dispatched_at": dispatched, "arrived_at": arrived}, "robot_1")
        try:
            got = (_get_client().table("deliveries").select("*")
                   .eq("task_id", tid).execute().data[0])
            assert got["robot_id"] == "robot_1", got
            assert got["dispatched_at"] and got["arrived_at"], got
            assert got["dispatched_at"][:4] == _iso(dispatched)[:4], got
        finally:
            _get_client().table("deliveries").delete().eq("task_id", tid).execute()

        # a task still at the desk has no timestamps yet — must not blow up
        mirror_delivery({"task_id": tid, "room": "1204", "items": ["towel"],
                          "phase": "QUEUED", "priority": "normal",
                          "dispatched_at": None, "arrived_at": None}, None)
        _get_client().table("deliveries").delete().eq("task_id", tid).execute()

        print("supabase_sync self-check OK (schema + mirror/poll round trip confirmed live, "
              "including robot_id + dispatched_at/arrived_at)")

    demo()
