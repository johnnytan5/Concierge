"""Process 1 tool schema + handlers — eight client-side function tools per
CLAUDE.md's tool table (plus check_menu and escalate_to_frontdesk). Every
handler either puts one command on task_engine's cmd_queue or reads its
shared `state` dict, and returns immediately — never waits on the robot
(CLAUDE.md constraint 2).
"""
import time
import uuid

from orchestrator import inventory
from task_engine.engine import BASE_ETA_SECONDS

# Flat schema per AssemblyAI Voice Agent API (session.tools) — NOT OpenAI's
# nested {"type":"function","function":{...}} form.
SESSION_TOOLS = [
    {
        "type": "function",
        "name": "check_menu",
        "description": "Look up price, dietary tags, and availability for one or more items (or the whole menu if none given).",
        "parameters": {
            "type": "object",
            "properties": {
                "items": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
    {
        "type": "function",
        "name": "dispatch_delivery",
        "description": "Send a delivery robot to a room with the given items. Unavailable items are reported back, not sent.",
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
        "name": "get_fleet_state",
        "description": "Current status of every robot: phase, room, active task, battery.",
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
    {
        "type": "function",
        "name": "escalate_to_frontdesk",
        "description": "Route a non-delivery request (late checkout, lost card, billing, etc.) to a human front-desk staff member.",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {"type": "string", "description": "What the guest needs, in plain language."},
            },
            "required": ["reason"],
        },
    },
]


class ToolHandlers:
    """Bound to one task_engine cmd_queue + shared state dict for the life
    of a voice session."""

    def __init__(self, cmd_queue, state):
        self._q = cmd_queue
        self._state = state

    def check_menu(self, items=None):
        if items:
            return inventory.lookup_items(items)
        return inventory.all_items()

    def dispatch_delivery(self, room, items, priority="normal"):
        looked_up = inventory.lookup_items(items)
        dispatched = [i for i in looked_up if i["available"] and i["in_stock"]]
        unavailable = [
            {"name": i["name"], "reason": "not_offered" if i["category"] is None
                                            or not i["available"] else "out_of_stock"}
            for i in looked_up if not (i["available"] and i["in_stock"])
        ]

        if not dispatched:
            return {"task_id": None, "dispatched_items": [], "unavailable_items": unavailable}

        task_id = uuid.uuid4().hex[:8]
        item_names = [i["name"] for i in dispatched]
        self._q.put({"cmd": "dispatch", "task_id": task_id, "room": room,
                     "items": item_names, "priority": priority})

        inventory.decrement_stock(item_names)
        inventory.insert_delivery({"task_id": task_id, "room": room, "items": item_names,
                                    "phase": "QUEUED", "priority": priority})

        return {"task_id": task_id, "eta_seconds": BASE_ETA_SECONDS,
                "dispatched_items": dispatched, "unavailable_items": unavailable}

    def _newest_for_room(self, room):
        """Newest still-live task for a room. `tasks` is never purged, so
        the first match is the OLDEST one — on a second order to the same
        room that means answering about the delivery that already finished.
        Terminal phases are skipped; ties break on dispatched_at."""
        tasks = self._state.get("tasks", {})
        return max(
            (t for t in tasks.values()
             if t["room"] == room and t["phase"] not in ("DONE", "AT_DESK")),
            key=lambda t: t.get("dispatched_at") or 0, default=None)

    def check_delivery_status(self, task_id=None, room=None):
        tasks = self._state.get("tasks", {})
        t = tasks.get(task_id) if task_id else self._newest_for_room(room)
        if not t:
            return {"error": "not_found"}
        remaining = t["eta_seconds"]
        if t["dispatched_at"] is not None:
            remaining = max(t["eta_seconds"] - (time.time() - t["dispatched_at"]), 0.0)
        # position comes from the robot that OWNS this task — state["robot"]
        # (singular) is gone, and with two robots "the" robot is meaningless
        r = next((r for r in self._state.get("robots", {}).values()
                  if r.get("current_task") == t["task_id"]), {})
        return {
            "task_id": t["task_id"],
            "phase": t["phase"],
            "position": round(r.get("pose_frac", 0.0), 2),
            "eta_seconds": round(remaining, 1),
        }

    def amend_delivery(self, task_id, add=None, remove=None, new_room=None):
        self._q.put({"cmd": "amend", "task_id": task_id, "add": add or [],
                     "remove": remove or [], "new_room": new_room})
        return {"task_id": task_id, "status": "amend_queued"}

    def recall_robot(self, task_id, reason):
        # Never ack a no-op: the prompt tells the model to trust tool
        # results, so a blanket {"ack": True} makes it confidently tell a
        # guest the robot was recalled when nothing happened. The engine
        # recalls from QUEUED/COLLECTING/EN_ROUTE/ARRIVED; only a finished
        # task or an unknown id is genuinely un-recallable.
        t = self._state.get("tasks", {}).get(task_id)
        if not t:
            return {"ack": False, "reason": "task_not_found"}
        if t["phase"] in ("DONE", "AT_DESK"):
            return {"ack": False, "reason": f"already_finished:{t['phase']}"}
        self._q.put({"cmd": "recall", "task_id": task_id, "reason": reason})
        return {"ack": True, "phase": t["phase"]}

    def get_fleet_state(self):
        tasks = self._state.get("tasks", {})
        robots = self._state.get("robots", {})
        return {"robots": [
            {"robot_id": rid, "phase": r.get("phase"), "current_task_id": r.get("current_task"),
             # room the robot is working, from its active task — the tool
             # description promises this field, so it has to actually arrive
             "room": tasks.get(r.get("current_task"), {}).get("room"),
             "battery": r.get("battery", 100.0), "pose_frac": r.get("pose_frac", 0.0)}
            for rid, r in robots.items()
        ]}

    def announce_arrival(self, room):
        t = self._newest_for_room(room)  # newest live task, not the oldest stale one
        if not t:
            # same reasoning as recall_robot: don't ack an announce that
            # was never enqueued
            return {"ack": False, "reason": "no_active_delivery_for_room"}
        self._q.put({"cmd": "announce", "task_id": t["task_id"]})
        return {"ack": True, "task_id": t["task_id"]}

    def escalate_to_frontdesk(self, reason):
        inventory.insert_escalation(reason, None)
        return {"ack": True}

    def dispatch(self, name, arguments):
        """Look up and call a handler by the tool name the agent sent in tool.call."""
        fn = getattr(self, name, None)
        if fn is None:
            result = {"error": f"unknown_tool:{name}"}
        else:
            result = fn(**arguments)
        inventory.insert_tool_call_event(name, arguments, str(result))
        return result


if __name__ == "__main__":
    # ponytail: one runnable self-check — fake queue/state, no multiprocessing needed.
    class _FakeQueue:
        def __init__(self):
            self.items = []

        def put(self, item):
            self.items.append(item)

    def demo():
        q = _FakeQueue()
        state = {"tasks": {}, "robots": {"robot_1": {"phase": "IDLE", "pose_frac": 0.0,
                                                        "current_task": None, "battery": 100.0}}}
        h = ToolHandlers(q, state)

        # fake inventory cache directly, no live Supabase needed for this check
        inventory._cache = {
            "towel": {"name": "towel", "category": "amenity", "price": None,
                       "dietary_tags": [], "available": True, "stock_count": None},
            "nasi lemak": {"name": "nasi lemak", "category": "food", "price": 8.0,
                             "dietary_tags": ["halal"], "available": True, "stock_count": 3},
            "toothbrush": {"name": "toothbrush", "category": "amenity", "price": None,
                             "dietary_tags": [], "available": False, "stock_count": 0},
        }

        # insert_tool_call_event uses asyncio.get_running_loop() internally
        # (fire-and-forget, per the spec) -- there's no running loop in this
        # plain synchronous self-check, so stub it out rather than adding an
        # asyncio.run() wrapper just for this. Same offline-check philosophy
        # as the fake inventory cache above: no live Supabase needed here.
        logged_events = []
        inventory.insert_tool_call_event = lambda name, args, summary: logged_events.append(name)
        inventory.decrement_stock = lambda item_names: None
        inventory.insert_delivery = lambda task: None
        inventory.insert_escalation = lambda reason, room: None

        menu = h.dispatch("check_menu", {"items": ["nasi lemak"]})
        assert menu[0]["price"] == 8.0 and "halal" in menu[0]["dietary_tags"]

        result = h.dispatch("dispatch_delivery",
                             {"room": "1204", "items": ["towel", "toothbrush"]})
        assert result["task_id"] is not None
        assert [i["name"] for i in result["dispatched_items"]] == ["towel"]
        assert result["unavailable_items"][0]["name"] == "toothbrush"
        assert q.items[-1]["cmd"] == "dispatch"
        assert q.items[-1]["items"] == ["towel"]  # only the valid item reached task_engine

        all_unavailable = h.dispatch("dispatch_delivery",
                                       {"room": "1204", "items": ["toothbrush"]})
        assert all_unavailable["task_id"] is None
        assert len(q.items) == 1, "no dispatch command should be enqueued for zero valid items"

        tid = result["task_id"]
        state["tasks"][tid] = {"task_id": tid, "room": "1204", "phase": "EN_ROUTE",
                                "dispatched_at": time.time(), "eta_seconds": 90.0}
        # the robot that owns the task is where `position` has to come from
        state["robots"]["robot_1"].update({"phase": "EN_ROUTE", "current_task": tid,
                                            "pose_frac": 0.73})

        status = h.dispatch("check_delivery_status", {"task_id": tid})
        assert status["phase"] == "EN_ROUTE"
        assert status["position"] == 0.73, status  # not the deleted state["robot"] -> 0.0

        # a finished task for the same room must not shadow a live one
        state["tasks"]["stale"] = {"task_id": "stale", "room": "1204", "phase": "DONE",
                                    "dispatched_at": 1.0, "eta_seconds": 90.0}
        by_room = h.dispatch("check_delivery_status", {"room": "1204"})
        assert by_room["task_id"] == tid, by_room

        announced = h.dispatch("announce_arrival", {"room": "1204"})
        assert announced["ack"] is True and q.items[-1]["task_id"] == tid, (announced, q.items[-1])
        no_such_room = h.dispatch("announce_arrival", {"room": "9999"})
        assert no_such_room["ack"] is False, no_such_room

        fleet = h.dispatch("get_fleet_state", {})
        assert fleet["robots"][0]["robot_id"] == "robot_1"
        assert fleet["robots"][0]["room"] == "1204", fleet  # description promises `room`

        # recall must not ack a no-op: unknown id and finished task both fail
        assert h.dispatch("recall_robot", {"task_id": "nope", "reason": "x"})["ack"] is False
        assert h.dispatch("recall_robot", {"task_id": "stale", "reason": "x"})["ack"] is False
        assert q.items[-1]["cmd"] == "announce", "no recall command for a no-op recall"

        ack = h.dispatch("recall_robot", {"task_id": tid, "reason": "guest cancelled"})
        assert ack == {"ack": True, "phase": "EN_ROUTE"}, ack
        assert q.items[-1]["cmd"] == "recall"

        esc = h.dispatch("escalate_to_frontdesk", {"reason": "late checkout"})
        assert esc == {"ack": True}

        unknown = h.dispatch("not_a_real_tool", {})
        assert "error" in unknown

        assert logged_events == ["check_menu", "dispatch_delivery", "dispatch_delivery",
                                   "check_delivery_status", "check_delivery_status",
                                   "announce_arrival", "announce_arrival", "get_fleet_state",
                                   "recall_robot", "recall_robot", "recall_robot",
                                   "escalate_to_frontdesk", "not_a_real_tool"], logged_events

        print("tools self-check OK")

    demo()
