"""Supabase read/write glue for Process 2 (task_engine). Called from
task_engine's own tick loop, not from orchestrator's tool handlers —
CLAUDE.md constraint 2 (<100ms) applies to tool handlers, not here, so
plain synchronous Supabase calls are fine in this module.
"""
import os
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
    resp = (_get_client().table("robot_commands")
            .select("id,robot_id,cmd")
            .eq("status", "pending")
            .in_("robot_id", robot_ids)
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


def mirror_delivery(task: dict):
    _get_client().table("deliveries").upsert({
        "task_id": task["task_id"], "room": task["room"], "items": task["items"],
        "phase": task["phase"], "priority": task["priority"],
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

        print("supabase_sync self-check OK (schema + mirror/poll round trip confirmed live)")

    demo()
