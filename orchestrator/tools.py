"""Process 1 tool schema + handlers — client-side function tools per
CLAUDE.md's tool table (plus check_menu and escalate_to_frontdesk). Every
handler either puts one command on task_engine's cmd_queue or reads its
shared `state` dict, and returns immediately — never waits on the robot
(CLAUDE.md constraint 2).
"""
import re
import time
import uuid
from collections import Counter

from orchestrator import inventory
from orchestrator.hotel_facts import HOTEL_FACTS
from task_engine import nav
from task_engine.engine import eta_seconds_for

# Engine phase -> what a front-desk worker would call it. Mirrors the
# dashboard's own PHASE_HUMAN (dashboard/lib/format.ts); keep them in step.
_PHASE_WORDS = {
    "QUEUED": "waiting for a robot",
    "COLLECTING": "being loaded",
    "EN_ROUTE": "on the way",
    "ARRIVED": "at the door",
    "RETURNING": "heading back",
    "RECALLED": "recalled",
    "AT_DESK": "back at the desk",
    "DONE": "delivered",
}


def _qty(items) -> str:
    """['towel','towel'] -> '2x towel'. Duplicates ARE the quantity — that is
    the shape dispatch_delivery receives from the model."""
    if not items:
        return "nothing"
    counts = Counter(str(i) for i in items)
    return ", ".join(f"{n}× {name}" for name, n in counts.items())


def summarize_result(name: str, arguments: dict, result) -> str:
    """One plain sentence describing what the tool actually did.

    This is what lands in tool_call_events.result_summary and what the admin
    dashboard shows a front-desk worker. The structured return is stored
    separately in `result` (jsonb) for dev view, so nothing is lost — before
    this, the column held Python's str(dict) of the return value and the
    staff-facing screen rendered a raw repr.

    Never raises: a summary is a nice-to-have on an audit row, and a
    formatting slip must not take down a tool call that already succeeded.
    """
    try:
        return _summarize(name, arguments or {}, result)
    except Exception:  # noqa: BLE001 - deliberately total
        return f"{name} completed."


def _summarize(name: str, a: dict, r) -> str:
    # check_menu returns a LIST of items, not a dict — handled before the
    # dict guard below, which it would otherwise fall straight through.
    if name == "check_menu":
        items = r if isinstance(r, list) else []
        if len(items) == 1:
            it = items[0]
            price = it.get("price")
            bits = [f"${float(price):.2f}"] if price else []
            bits.append("available" if it.get("available") and it.get("in_stock")
                        else "not available")
            if it.get("dietary_tags"):
                bits.append(", ".join(str(t) for t in it["dietary_tags"]))
            return f"{it.get('name', 'Item')} — {', '.join(bits)}."
        return f"Checked the menu: {len(items)} item(s)."

    if not isinstance(r, dict):
        return f"{name} completed."

    if "error" in r and name != "dispatch_delivery":
        return f"Couldn't do that: {r['error']}."

    if name == "dispatch_delivery":
        room = a.get("room", "?")
        if r.get("error") == "unknown_room":
            rooms = ", ".join(r.get("deliverable_rooms") or [])
            return f"No route to room {room} — the robot can only reach {rooms}."
        missing = r.get("unavailable_items") or []
        missing_txt = ", ".join(str(m.get("name")) for m in missing)
        if not r.get("task_id"):
            return f"Nothing sent to room {room} — {missing_txt or 'no items available'} not available."
        sent = _qty([i.get("name") for i in (r.get("dispatched_items") or [])])
        line = f"Sent {sent} to room {room}."
        if missing:
            line += f" Couldn't send {missing_txt}."
        return line

    if name == "deliver_parcel":
        room = a.get("room", "?")
        if r.get("error") == "unknown_room":
            return f"No route to room {room} for the {a.get('source', 'delivery')} order."
        what = (r.get("dispatched_items") or [{}])[0].get("name") or a.get("source", "delivery")
        if r.get("joined_existing_order"):
            return f"Added the {what} to room {room}'s order waiting at the desk — one trip."
        return f"Robot booked to take the {what} up to room {room} once it reaches the desk."

    if name == "check_delivery_status":
        if r.get("error"):
            return "No matching order found."
        phase = _PHASE_WORDS.get(r.get("phase"), str(r.get("phase", "")).lower())
        eta = r.get("eta_seconds")
        tail = f", about {round(eta / 60)} min away" if isinstance(eta, (int, float)) and eta > 0 else ""
        return f"Order is {phase}{tail}."

    if name == "amend_delivery":
        bits = []
        if a.get("add"):
            bits.append(f"added {_qty(a['add'])}")
        if a.get("remove"):
            bits.append(f"removed {_qty(a['remove'])}")
        if a.get("new_room"):
            bits.append(f"moved to room {a['new_room']}")
        return "Changed the order: " + (", ".join(bits) if bits else "no changes") + "."

    if name == "recall_robot":
        if not r.get("ack"):
            reason = str(r.get("reason", "")).replace("_", " ")
            return f"Couldn't recall the robot — {reason or 'not possible'}."
        return "Robot called back to the desk."

    if name == "get_fleet_state":
        robots = r.get("robots") or []
        busy = sum(1 for x in robots if x.get("current_task_id"))
        return f"Checked the fleet: {busy} of {len(robots)} robot(s) busy."

    if name == "announce_arrival":
        if not r.get("ack"):
            return "Nothing to announce for that room."
        return f"Announced arrival at room {a.get('room', '?')}."

    if name == "hotel_info":
        if r.get("error"):
            return "No answer on file for that — should go to the front desk."
        return f"Answered a question about {str(a.get('topic', '')).replace('_', ' ')}."

    if name == "end_call":
        return "Call ended."

    if name == "escalate_to_frontdesk":
        room = a.get("room")
        where = f" from room {room}" if room else ""
        return f"Passed to the front desk{where}: {a.get('reason', '')}."

    return f"{name} completed."

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
        "name": "deliver_parcel",
        "description": "The guest has ordered food (or a parcel) from an outside delivery app and wants it brought up. The rider can't go upstairs, so they leave it at the front desk; this books a robot to carry it to the room once staff load it. Never use this to place an order -- only to deliver one the guest already made.",
        "parameters": {
            "type": "object",
            "properties": {
                "room": {"type": "string", "description": "Room number, e.g. '1204'."},
                "source": {"type": "string", "description": "The app or courier, e.g. 'Uber Eats', 'Grab', 'Meituan', 'Foodpanda'."},
                "description": {"type": "string", "description": "What it is, in a few words, e.g. 'food order', 'pizza', 'parcel'."},
            },
            "required": ["room", "source"],
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
        "name": "hotel_info",
        "description": "Hotel policy and facility facts: check-in/out times, late checkout, which floor each facility is on and its hours, wifi, breakfast, parking, laundry. Answer general questions ONLY from this.",
        "parameters": {
            "type": "object",
            "properties": {"topic": {"type": "string", "enum": list(HOTEL_FACTS)}},
            "required": ["topic"],
        },
    },
    {
        "type": "function",
        "name": "end_call",
        "description": "Hang up the phone. Call this only when the guest says goodbye or asks to end the call, and only after every request in the call is handled. Say your short goodbye in the same reply as this call; the line closes right after.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "escalate_to_frontdesk",
        "description": "Hand something to a human front-desk staff member when a person has to act: granting a late checkout, lost key card, billing, something broken, a complaint. Never for an item that is unavailable or not on the menu — tell the guest instead.",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {"type": "string", "description": "What the guest needs, in plain language."},
                "room": {"type": "string", "description": "Room number the guest is calling from, if they gave one."},
            },
            "required": ["reason"],
        },
    },
]

# "hold", not the default "interactive": interactive makes the agent say a
# filler line and only accepts tool.result after that reply is done. With
# BYO-LLM the filler came back as 5-9s of silence, so every tool call cost
# that much dead air plus a follow-up that often never came. Every handler
# here returns in <100ms (CLAUDE.md constraint 2), so there is nothing to
# fill: hold takes the result immediately and auto-fires the reply.
for _t in SESSION_TOOLS:
    _t["execution_mode"] = "hold"
    _t["timeout_seconds"] = 10


# A spoken promise of an action ("let me pass that on", "one moment") in a
# reply that carried no tool call. Measured 2026-09-23: 2-6 of 16 replies do
# this whatever the prompt says, and then nothing happens until the guest
# speaks again (37s of silence on a real call). The agent nudges once when
# it sees one. Deliberately narrow: "let me know if..." must not match.
_ANNOUNCE = re.compile(
    r"\b(one moment|just a moment|give me a (sec|second|moment)|"
    r"let me (check|look|pass|send|see|get|put|find|arrange|sort|request|note|flag|confirm)|"
    r"i'?ll (check|look|pass|send|put|get|find|arrange|request|flag|confirm|have)|"
    r"checking (on|that|now)|passing (that|this|it))\b", re.I)


def announces_action(text: str) -> bool:
    return bool(_ANNOUNCE.search(text or ""))


def needs_nudge(reply_text: str) -> bool:
    """True only when a reply ENDS on a promised action and asks nothing.

    A reply that asks the guest something ("Want me to put that request
    in?") is waiting for them, and nudging it made the model act without a
    yes -- on a real call it escalated a late checkout unasked, told the
    guest it was "confirmed", and escalated again. So: no question mark
    anywhere, and the announcement must be the last sentence."""
    text = (reply_text or "").strip()
    if not text or "?" in text:
        return False
    last = re.split(r"(?<=[.!])\s+", text)[-1]
    return announces_action(last)


class ToolHandlers:
    """Bound to one task_engine cmd_queue + shared state dict for the life
    of a voice session.

    `session_id` is the voice_sessions row for this call; every tool call
    is stamped with it so the admin dashboard's Call log can group a
    conversation's tool calls (and its transcript turns) back together.
    Defaults to None so the offline self-check below, and any other
    caller that isn't a real WS session, still works unchanged.
    """

    def __init__(self, cmd_queue, state, session_id=None):
        self._q = cmd_queue
        self._state = state
        self._session_id = session_id
        # Set by end_call; agent.py closes the line once the goodbye plays.
        self.end_requested = False

    def check_menu(self, items=None):
        if items:
            return inventory.lookup_items(items)
        return inventory.all_items()

    def dispatch_delivery(self, room, items, priority="normal"):
        # Every room used to be the same fixed distance from the desk, so any
        # room string "worked". Now a delivery follows that room's own
        # hand-authored waypoint path, and there is no pathfinding — a room
        # with no path cannot be reached at all. Check before touching stock:
        # otherwise an undeliverable order would still decrement inventory.
        if room not in nav.known_rooms():
            return {"task_id": None, "dispatched_items": [], "unavailable_items": [],
                    "error": "unknown_room",
                    "deliverable_rooms": nav.known_rooms()}

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

        inventory.decrement_stock(item_names, task_id=task_id)
        inventory.insert_delivery({"task_id": task_id, "room": room, "items": item_names,
                                    "phase": "QUEUED", "priority": priority})

        # Per-room estimate from that room's real path length — the far wing
        # is genuinely farther than the near one.
        return {"task_id": task_id, "eta_seconds": eta_seconds_for(room),
                "dispatched_items": dispatched, "unavailable_items": unavailable}

    def deliver_parcel(self, room, source, description="food order"):
        """A delivery-app order dropped at the front desk, carried up by the
        robot -- the thing hotel robots in China mostly do. Same robot
        journey as dispatch_delivery (loading at the counter waits for "Bin
        loaded", which is staff putting the rider's bag in), but the item is
        not ours: no menu lookup, no stock decrement."""
        if room not in nav.known_rooms():
            return {"task_id": None, "error": "unknown_room",
                    "deliverable_rooms": nav.known_rooms()}
        # The model sometimes repeats the app in the description ("Grab food
        # order"); don't label it "Grab Grab food order".
        description = (description or "food order").strip()
        label = description if source.lower() in description.lower() else f"{source} {description}".strip()
        # Guest already has an order for this room still at the counter?
        # Put the bag in the same bin: one trip, one "Bin loaded", and it
        # stays on the robot the viewer shows (a second task would go to
        # robot_2, which has no window).
        live = self._newest_for_room(room)
        if live and live["phase"] in ("QUEUED", "COLLECTING"):
            self._q.put({"cmd": "amend", "task_id": live["task_id"], "add": [label],
                         "remove": [], "new_room": None})
            return {"task_id": live["task_id"], "eta_seconds": eta_seconds_for(room),
                    "dispatched_items": [{"name": label}], "joined_existing_order": True,
                    "waiting_for": "the rider to drop it at the front desk; it goes up in the "
                                   "same trip as the order already waiting there"}
        task_id = uuid.uuid4().hex[:8]
        self._q.put({"cmd": "dispatch", "task_id": task_id, "room": room,
                     "items": [label], "priority": "normal"})
        inventory.insert_delivery({"task_id": task_id, "room": room, "items": [label],
                                    "phase": "QUEUED", "priority": "normal"})
        return {"task_id": task_id, "eta_seconds": eta_seconds_for(room),
                "dispatched_items": [{"name": label}],
                "waiting_for": "the rider to drop it at the front desk; staff load it into the robot"}

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

    def hotel_info(self, topic):
        answer = HOTEL_FACTS.get(topic)
        if answer is None:
            return {"error": "unknown_topic", "topics": list(HOTEL_FACTS)}
        return {"topic": topic, "answer": answer}

    def end_call(self):
        self.end_requested = True
        return {"ack": True, "instruction": "The line is closing and you have already said goodbye. Say nothing more."}

    def escalate_to_frontdesk(self, reason, room=None):
        # `room` was hardcoded None here until the admin dashboard needed
        # it: the Escalations tab leads each row with the room number, so
        # every escalation rendered against a blank. The tool now asks the
        # model for it, and it stays optional -- plenty of escalations
        # ("the lobby wifi is down") legitimately have no room.
        inventory.insert_escalation(reason, room)
        return {"ack": True, "room": room}

    def dispatch(self, name, arguments):
        """Look up and call a handler by the tool name the agent sent in tool.call."""
        fn = getattr(self, name, None)
        if fn is None:
            result = {"error": f"unknown_tool:{name}"}
        else:
            result = fn(**arguments)
        # A readable sentence for the dashboard's staff view, plus the
        # structured return for dev view — not str(result) for both.
        inventory.insert_tool_call_event(
            name, arguments, summarize_result(name, arguments, result),
            session_id=self._session_id, result=result)
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
        h = ToolHandlers(q, state, session_id="sess_selfcheck")

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
        logged_sessions = []
        logged_summaries = []
        logged_results = []
        escalations = []

        def _fake_tool_event(name, args, summary, session_id=None, result=None):
            logged_events.append(name)
            logged_sessions.append(session_id)
            logged_summaries.append(summary)
            logged_results.append(result)

        inventory.insert_tool_call_event = _fake_tool_event
        inventory.decrement_stock = lambda item_names, task_id=None, source="dispatch_delivery": None
        inventory.insert_delivery = lambda task: None
        inventory.insert_escalation = lambda reason, room: escalations.append((reason, room))

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

        # A room with no waypoint path cannot be reached at all. Rejected
        # BEFORE stock is touched -- an undeliverable order must not decrement
        # inventory. (Before the corridor scene every room was the same fixed
        # distance from the desk, so any string "worked".)
        no_route = h.dispatch("dispatch_delivery",
                               {"room": "9999", "items": ["towel"]})
        assert no_route["task_id"] is None, no_route
        assert no_route["error"] == "unknown_room", no_route
        assert "1204" in no_route["deliverable_rooms"], no_route
        assert len(q.items) == 1, "no dispatch command for an unreachable room"

        # ETA is per-room now: the far wing is genuinely farther than the near
        # one, which is the whole reason the corridor is L-shaped.
        near = h.dispatch("dispatch_delivery", {"room": "0803", "items": ["towel"]})
        far = h.dispatch("dispatch_delivery", {"room": "1205", "items": ["towel"]})
        assert far["eta_seconds"] > near["eta_seconds"], (near["eta_seconds"], far["eta_seconds"])

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

        # escalation without a room still works -- plenty of them have none
        esc = h.dispatch("escalate_to_frontdesk", {"reason": "late checkout"})
        assert esc == {"ack": True, "room": None}, esc
        assert escalations[-1] == ("late checkout", None), escalations

        # ...and when the guest gives one it must actually reach the row,
        # instead of the hardcoded None the dashboard used to render blank
        esc_room = h.dispatch("escalate_to_frontdesk",
                                {"reason": "aircon broken", "room": "1204"})
        assert esc_room == {"ack": True, "room": "1204"}, esc_room
        assert escalations[-1] == ("aircon broken", "1204"), escalations

        unknown = h.dispatch("not_a_real_tool", {})
        assert "error" in unknown

        assert logged_events == ["check_menu",
                                   "dispatch_delivery",   # towel + toothbrush
                                   "dispatch_delivery",   # all unavailable
                                   "dispatch_delivery",   # unknown room
                                   "dispatch_delivery",   # near wing
                                   "dispatch_delivery",   # far wing
                                   "check_delivery_status", "check_delivery_status",
                                   "announce_arrival", "announce_arrival", "get_fleet_state",
                                   "recall_robot", "recall_robot", "recall_robot",
                                   "escalate_to_frontdesk", "escalate_to_frontdesk",
                                   "not_a_real_tool"], logged_events

        # every tool call must carry the session stamp the Call log groups on
        assert set(logged_sessions) == {"sess_selfcheck"}, logged_sessions

        # Nothing a front-desk worker reads may be a Python repr. This is the
        # regression that put {'task_id': ..., 'dispatched_items': [{...}]} on
        # a staff-facing screen.
        for summary in logged_summaries:
            assert not summary.startswith(("{", "[")), summary
            assert "'" not in summary or "Couldn't" in summary or "can't" in summary, summary
            assert summary.endswith("."), summary
        # ...while the structured return is still captured, for dev view
        assert any(isinstance(r, dict) and "task_id" in r for r in logged_results), logged_results

        # spot-check the wording of the two that matter most
        sent = next(s for s, n in zip(logged_summaries, logged_events)
                    if n == "dispatch_delivery")
        assert sent == "Sent 1× towel to room 1204. Couldn't send toothbrush.", sent
        esc = [s for s, n in zip(logged_summaries, logged_events)
               if n == "escalate_to_frontdesk"]
        assert esc[-1] == "Passed to the front desk from room 1204: aircon broken.", esc[-1]

        # quantities collapse the way the transcript reads them
        assert _qty(["towel", "towel", "nasi lemak"]) == "2× towel, 1× nasi lemak"
        assert _qty([]) == "nothing"

        # check_menu returns a LIST, not a dict -- it fell through the dict
        # guard and summarized as "check_menu completed." until this was caught
        one = summarize_result("check_menu", {"items": ["nasi lemak"]},
                                [{"name": "nasi lemak", "price": 8.0, "available": True,
                                  "in_stock": True, "dietary_tags": ["halal"]}])
        assert one == "nasi lemak — $8.00, available, halal.", one
        many = summarize_result("check_menu", {}, [{"name": "a"}, {"name": "b"}])
        assert many == "Checked the menu: 2 item(s).", many

        # a handler that returned something unexpected must still summarize
        assert summarize_result("dispatch_delivery", {"room": "1"}, None) \
            == "dispatch_delivery completed."
        assert summarize_result("not_a_tool", {}, {"error": "unknown_tool:x"}) \
            == "Couldn't do that: unknown_tool:x."

        info = h.dispatch("hotel_info", {"topic": "late_checkout"})
        assert "$30" in info["answer"] and "5pm" in info["answer"], info
        assert h.hotel_info("spa")["error"] == "unknown_topic"
        assert summarize_result("hotel_info", {"topic": "late_checkout"}, info) \
            == "Answered a question about late checkout."

        # the filler-without-a-tool-call detector
        assert announces_action("One moment, let me pass that to the front desk.")
        assert announces_action("I'll check our checkout policy for you right away.")
        assert not announces_action("Let me know if you need anything else!")
        assert not announces_action("Your towel is on the way. Anything else?")
        assert needs_nudge("One moment, let me pass that to the front desk.")
        assert not needs_nudge("Let me check our policy. 3pm is $90. Want me to request it?")
        assert not needs_nudge("One moment, let me check. Your towel is on the way.")

        # delivery-app hand-off: not a menu item, no stock touched
        stock_calls = []
        inventory.decrement_stock = lambda *a, **k: stock_calls.append(a)
        parcel = h.dispatch("deliver_parcel", {"room": "1204", "source": "Uber Eats", "description": "food order"})
        assert parcel["task_id"] and parcel["dispatched_items"] == [{"name": "Uber Eats food order"}], parcel
        assert q.items[-1]["items"] == ["Uber Eats food order"] and not stock_calls, (q.items[-1], stock_calls)
        assert h.deliver_parcel("9999", "Grab")["error"] == "unknown_room"
        assert h.deliver_parcel("1204", "Grab", "Grab food order")["dispatched_items"] == [{"name": "Grab food order"}]
        # an order for the same room still at the counter: joins it, no new task
        state["tasks"] = {"t9": {"task_id": "t9", "room": "0803", "phase": "COLLECTING",
                                  "items": ["towel"], "dispatched_at": None}}
        joined = h.deliver_parcel("0803", "Grab")
        assert joined["task_id"] == "t9" and joined["joined_existing_order"], joined
        assert q.items[-1] == {"cmd": "amend", "task_id": "t9", "add": ["Grab food order"],
                               "remove": [], "new_room": None}, q.items[-1]
        state["tasks"]["t9"]["phase"] = "EN_ROUTE"   # already left: a new trip instead
        assert h.deliver_parcel("0803", "Grab")["task_id"] != "t9"
        assert summarize_result("deliver_parcel", {"room": "1204", "source": "Uber Eats"}, parcel) \
            == "Robot booked to take the Uber Eats food order up to room 1204 once it reaches the desk."

        assert h.dispatch("end_call", {})["ack"] is True and h.end_requested
        assert summarize_result("end_call", {}, {"ack": True}) == "Call ended."

        print("tools self-check OK")

    demo()
