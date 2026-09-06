"""Process 1 tool schema + handlers — six client-side function tools per
CLAUDE.md's tool table. Every handler either puts one command on
task_engine's cmd_queue or reads its shared `state` dict, and returns
immediately — never waits on the robot (CLAUDE.md constraint 2).
"""
import time
import uuid

from task_engine.engine import BASE_ETA_SECONDS

# Flat schema per AssemblyAI Voice Agent API (session.tools) — NOT OpenAI's
# nested {"type":"function","function":{...}} form.
SESSION_TOOLS = [
    {
        "type": "function",
        "name": "dispatch_delivery",
        "description": "Send the delivery robot to a room with the given items.",
        "parameters": {
            "type": "object",
            "properties": {
                "room": {"type": "string", "description": "Room number, e.g. '1204'."},
                "items": {"type": "array", "items": {"type": "string"}},
                "priority": {"type": "string", "enum": ["normal", "urgent"]},
            },
            "required": ["room", "items"],
        },
    },
    {
        "type": "function",
        "name": "check_delivery_status",
        "description": "Look up the phase, position, and ETA of a task by id or room.",
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "room": {"type": "string"},
            },
        },
    },
    {
        "type": "function",
        "name": "amend_delivery",
        "description": "Add or remove items, or change the destination room, of a task already in flight.",
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "add": {"type": "array", "items": {"type": "string"}},
                "remove": {"type": "array", "items": {"type": "string"}},
                "new_room": {"type": "string"},
            },
            "required": ["task_id"],
        },
    },
    {
        "type": "function",
        "name": "recall_robot",
        "description": "Call the robot back to the desk mid-task.",
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": ["task_id", "reason"],
        },
    },
    {
        "type": "function",
        "name": "get_robot_state",
        "description": "Current robot pose, payload, battery, and active task.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "announce_arrival",
        "description": "Mark a delivery as announced to the guest (chime/message played at the door).",
        "parameters": {
            "type": "object",
            "properties": {"room": {"type": "string"}},
            "required": ["room"],
        },
    },
]


class ToolHandlers:
    """Bound to one task_engine cmd_queue + shared state dict for the life
    of a voice session."""

    def __init__(self, cmd_queue, state):
        self._q = cmd_queue
        self._state = state

    def dispatch_delivery(self, room, items, priority="normal"):
        task_id = uuid.uuid4().hex[:8]
        self._q.put({"cmd": "dispatch", "task_id": task_id, "room": room,
                     "items": items, "priority": priority})
        return {"task_id": task_id, "eta_seconds": BASE_ETA_SECONDS}

    def check_delivery_status(self, task_id=None, room=None):
        tasks = self._state.get("tasks", {})
        t = tasks.get(task_id) if task_id else next(
            (t for t in tasks.values() if t["room"] == room), None)
        if not t:
            return {"error": "not_found"}
        remaining = t["eta_seconds"]
        if t["dispatched_at"] is not None:
            remaining = max(t["eta_seconds"] - (time.time() - t["dispatched_at"]), 0.0)
        return {
            "task_id": t["task_id"],
            "phase": t["phase"],
            "position": round(self._state.get("robot", {}).get("pose_frac", 0.0), 2),
            "eta_seconds": round(remaining, 1),
        }

    def amend_delivery(self, task_id, add=None, remove=None, new_room=None):
        self._q.put({"cmd": "amend", "task_id": task_id, "add": add or [],
                     "remove": remove or [], "new_room": new_room})
        return {"task_id": task_id, "status": "amend_queued"}

    def recall_robot(self, task_id, reason):
        self._q.put({"cmd": "recall", "task_id": task_id, "reason": reason})
        return {"ack": True}

    def get_robot_state(self):
        robot = self._state.get("robot", {})
        return {
            "pose": {"frac": robot.get("pose_frac", 0.0)},
            "payload": robot.get("payload", []),
            "battery": robot.get("battery", 100.0),
            "current_task": robot.get("current_task"),
        }

    def announce_arrival(self, room):
        tasks = self._state.get("tasks", {})
        t = next((t for t in tasks.values() if t["room"] == room), None)
        if t:
            self._q.put({"cmd": "announce", "task_id": t["task_id"]})
        return {"ack": True}

    def dispatch(self, name, arguments):
        """Look up and call a handler by the tool name the agent sent in tool.call."""
        fn = getattr(self, name, None)
        if fn is None:
            return {"error": f"unknown_tool:{name}"}
        return fn(**arguments)


if __name__ == "__main__":
    # ponytail: one runnable self-check — fake queue/state, no multiprocessing needed.
    class _FakeQueue:
        def __init__(self):
            self.items = []

        def put(self, item):
            self.items.append(item)

    def demo():
        q = _FakeQueue()
        state = {"tasks": {}, "robot": {"pose_frac": 0.0}}
        h = ToolHandlers(q, state)

        result = h.dispatch("dispatch_delivery", {"room": "1204", "items": ["towel"]})
        assert "task_id" in result and result["eta_seconds"] == BASE_ETA_SECONDS
        assert q.items[-1]["cmd"] == "dispatch"

        # simulate task_engine having created the task
        tid = result["task_id"]
        state["tasks"][tid] = {"task_id": tid, "room": "1204", "phase": "EN_ROUTE",
                                "dispatched_at": time.time(), "eta_seconds": 90.0}

        status = h.dispatch("check_delivery_status", {"task_id": tid})
        assert status["phase"] == "EN_ROUTE"

        ack = h.dispatch("recall_robot", {"task_id": tid, "reason": "guest cancelled"})
        assert ack == {"ack": True}
        assert q.items[-1]["cmd"] == "recall"

        unknown = h.dispatch("not_a_real_tool", {})
        assert "error" in unknown

        print("tools self-check OK")

    demo()
