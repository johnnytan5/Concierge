"""Process 2 — task FSM + navigation, per ARCHITECTURE.md.

Runs in its own process, owning TWO DeliveryBotSimulator instances (one
per robot) — never touched from the orchestrator (Process 1), per
CLAUDE.md constraint 1. `cmd_queue` carries voice-triggered commands
from the orchestrator (dispatch/amend/recall/announce) on the existing
direct path; human-confirmation events (complete_loading/
complete_collection, from a robot's own screen) arrive separately via
Supabase polling (see Task 6b / supabase_sync.py) since they originate
from a different process. `state` is a multiprocessing.Manager() dict
the orchestrator reads directly for check_delivery_status/
get_fleet_state — no round trip through the queue for reads (CLAUDE.md
constraint 2).

Real corridor navigation: "desk to room" is a hand-authored waypoint path
per room (task_engine/waypoints.json), followed via pure pursuit
(task_engine/nav.py) -- see docs/superpowers/specs/2026-09-11-hotel-
corridor-scene-nav-design.md for the full design. The phase/state contract
below is unchanged from the straight-line-distance version it replaced.
"""
import math
import os
import queue
import sys
import time
import uuid

_SIM_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "sim"))
sys.path.insert(0, _SIM_DIR)
from concierge_sim import DeliveryBotSimulator  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import supabase_sync
import nav

MODEL_PATH = os.path.join(_SIM_DIR, "scene_corridor.xml")

ROBOT_IDS = ["robot_1", "robot_2"]
TICK_HZ = 5.0

DRIVE_SPEED_MPS = 0.11


def _new_robot():
    return {"phase": "IDLE", "pose_frac": 0.0, "battery": 100.0, "current_task": None}


def eta_seconds_for(room: str) -> float:
    """Real per-room delivery estimate, from that room's actual path length.

    Replaces the old single BASE_ETA_SECONDS constant, which assumed every
    room was the same fixed distance from the desk. With an L-shaped corridor
    that is plainly false — the far wing is genuinely farther, and the whole
    point of the scene is that it shows on camera.

    Raises KeyError for a room with no path; callers that take a room from a
    guest must handle that (see orchestrator/tools.py dispatch_delivery)."""
    return nav.total_length(nav.path_for(room)) / DRIVE_SPEED_MPS


def _new_task(task_id, room, items, priority):
    return {
        "task_id": task_id,
        "room": room,
        "items": list(items),
        "priority": priority,
        "phase": "QUEUED",   # QUEUED -> COLLECTING -> EN_ROUTE -> ARRIVED -> RETURNING -> PARKING -> DONE
                              #                                 \-> RECALLED -----------> PARKING -> AT_DESK
                              # PARKING is a brief in-place re-orientation once position
                              # has arrived home but before the task is considered fully
                              # over -- see _settle_heading()'s docstring for why this
                              # exists (a robot's parked heading was previously whatever
                              # it happened to be, not standardized, and that caused a
                              # real bug for the next task dispatched to the same robot).
        "dispatched_at": None,
        "arrived_at": None,
        "progress_m": 0.0,   # arc length covered along nav.path_for(room), reset each leg
        "eta_seconds": eta_seconds_for(room),
        "announced": False,
        "reason": None,
        "speech_done_collecting": False,
        "speech_done_arrived": False,
    }


def _handle(cmd, tasks):
    kind = cmd.get("cmd")

    if kind == "dispatch":
        tasks[cmd["task_id"]] = _new_task(
            cmd["task_id"], cmd["room"], cmd.get("items", []),
            cmd.get("priority", "normal"))

    elif kind == "amend":
        t = tasks.get(cmd["task_id"])
        if not t or t["phase"] in ("ARRIVED", "RETURNING", "PARKING", "DONE", "AT_DESK"):
            return
        items = (set(t["items"]) - set(cmd.get("remove") or [])) | set(cmd.get("add") or [])
        t["items"] = sorted(items)
        if cmd.get("new_room"):
            t["room"] = cmd["new_room"]
        if t["phase"] == "EN_ROUTE":
            t["dispatched_at"] = time.time()
        tasks[cmd["task_id"]] = t

    elif kind == "recall":
        # Recall is TOTAL over every phase a robot can physically be
        # recalled from -- a recall that silently does nothing still gets
        # acked to the guest by the LLM. ARRIVED matters most: with
        # DWELL_SECONDS gone, an unattended screen would otherwise wedge a
        # robot at the door for the rest of the demo with no voice-side
        # recovery at all.
        t = tasks.get(cmd["task_id"])
        if not t:
            return
        phase = t["phase"]
        if phase in ("QUEUED", "COLLECTING"):
            # never left the desk (or never even got a robot) -- just cancel
            t["phase"] = "AT_DESK"
        elif phase == "EN_ROUTE":
            t["phase"] = "RECALLED"
            t["dispatched_at"] = time.time()
        elif phase == "ARRIVED":
            t["phase"] = "RETURNING"  # _drive_home closes the door on the way
        else:
            return  # RETURNING / RECALLED / PARKING / DONE / AT_DESK -- already coming back or over
        t["reason"] = cmd.get("reason")
        tasks[cmd["task_id"]] = t

    elif kind == "announce":
        t = tasks.get(cmd["task_id"])
        if t:
            t["announced"] = True
            tasks[cmd["task_id"]] = t


def _route_command(cmd_row: dict, robots: dict, tasks: dict, confirmed: dict):
    """Dispatch one `robot_commands` row.

    Three commands share this table and they are NOT interchangeable:
    complete_loading/complete_collection are the robot screen's human
    confirmations, recall is the admin dashboard pulling a robot off its run.
    Before recall existed every pending row was treated as a confirmation, so
    routing it wrong would make an operator recalling a robot at the door
    register instead as the guest collecting their order — the delivery would
    complete as if it had been handed over.
    """
    rid = cmd_row["robot_id"]
    if rid not in robots:
        return  # a command for a robot this process doesn't own

    if cmd_row["cmd"] == "recall":
        # The dashboard recalls a ROBOT; the FSM recalls a TASK. Resolve one
        # to the other here — an idle robot has nothing to recall, which is a
        # no-op rather than an error.
        tid = robots[rid]["current_task"]
        if tid is not None:
            _handle({"cmd": "recall", "task_id": tid,
                     "reason": cmd_row.get("reason")}, tasks)
    else:
        confirmed[rid] = True


def _drive_home(sim, task, now, terminal_phase, drive_speed, arrival_tolerance_m):
    sim.close_door()  # idempotent ctrl target; covers a recall straight out of ARRIVED
    path = list(reversed(nav.path_for(task["room"])))
    # task["progress_m"] here is whatever stale value the outbound leg left
    # it at -- that's fine and needs no special handling. pure_pursuit_step
    # never reads the incoming progress_m for its computation (see its own
    # docstring on the max()-floor removal); new_progress_m is always
    # derived fresh from the robot's real measured position every call.
    task["progress_m"], _, done = nav.pure_pursuit_step(
        sim, path, task["progress_m"], drive_speed,
        arrival_tolerance_m=arrival_tolerance_m)
    total = nav.total_length(path)
    frac = 1.0 - min(task["progress_m"] / total, 1.0) if total > 0 else 0.0  # walks 1 -> 0 on the way home
    if done:
        # Arriving in POSITION is not the same as being parked -- see
        # _settle_heading()'s docstring. Hand off to PARKING instead of
        # finalizing terminal_phase directly; _settle_heading applies it
        # once heading is also standardized.
        task["phase"] = "PARKING"
        task["_parking_terminal_phase"] = terminal_phase
    return task, frac


CANONICAL_PARK_YAW_RAD = 0.0  # facing +x -- every room's waypoints.json path
                                # leaves the desk heading +x first (confirmed:
                                # every entry's first two points increase x),
                                # so this is the one heading that's actually
                                # "ready to go" for whatever gets dispatched next
PARK_HEADING_TOLERANCE_DEG = 5.0


def _settle_heading(sim, task, steer_gain: float = 2.0):
    """Real bug this exists to fix (found live, reproducibly, tracing a
    robot's exact position tick-by-tick -- see the ledger and
    HANDOFF-2026-09-13.md): `pure_pursuit_step`'s arrival check only ever
    constrained POSITION (`hypot(...) <= arrival_tolerance_m`), never
    heading. A robot driving home along a path that approaches the desk
    from +x (every room's reversed path does) ends up parked facing
    ~180 degrees -- backward relative to where the NEXT dispatch needs to
    head. That robot then starts its next task already needing an
    unplanned course-reversal, and in the worst case (confirmed live) that
    compounds badly enough to drive the robot into a corridor wall, where
    it physically wedges.

    Fix: once position has arrived (`_drive_home` sets phase to PARKING),
    rotate in place (v=0, pure yaw correction) until heading is within
    `PARK_HEADING_TOLERANCE_DEG` of `CANONICAL_PARK_YAW_RAD`, THEN stop and
    apply the real terminal phase. `v=0` deliberately -- this is arrival
    polish, not navigation; there is no path to stay on, only a heading to
    fix, and re-running pure_pursuit_step here would immediately re-measure
    arc length off the (now-behind-it) reversed path and could pull the
    robot back off the spot it just arrived at.
    """
    status = sim.pull_status()
    yaw = math.radians(status.base.yaw_deg)
    heading_error = math.atan2(math.sin(CANONICAL_PARK_YAW_RAD - yaw),
                                math.cos(CANONICAL_PARK_YAW_RAD - yaw))
    if abs(math.degrees(heading_error)) <= PARK_HEADING_TOLERANCE_DEG:
        sim.stop_base()
        task["phase"] = task.pop("_parking_terminal_phase")
        return task, True
    sim.drive(v=0.0, omega=steer_gain * heading_error)
    return task, False


def _advance(sim: DeliveryBotSimulator, task, now, confirmed: bool = False,
             drive_speed: float = DRIVE_SPEED_MPS,
             arrival_tolerance_m: float = 0.05):
    """`confirmed` is this tick's human-confirmation flag for this
    task's robot (complete_loading while COLLECTING, complete_collection
    while ARRIVED) — see module docstring for where it comes from.
    ponytail: no timeout fallback yet if a confirmation never arrives
    (robot waits at COLLECTING/ARRIVED forever) -- acceptable for the
    demo, flagged as a follow-up, not silently ignored."""
    if task["phase"] == "COLLECTING":
        sim.open_door()  # idempotent ctrl target -- safe every tick, matches close_door()'s pattern
        if confirmed:
            sim.close_door()
            task["phase"] = "EN_ROUTE"
            task["dispatched_at"] = now
        return task, 0.0

    if task["phase"] == "EN_ROUTE":
        path = nav.path_for(task["room"])
        task["progress_m"], frac, done = nav.pure_pursuit_step(
            sim, path, task["progress_m"], drive_speed,
            arrival_tolerance_m=arrival_tolerance_m)
        if done:
            sim.stop_base()
            sim.open_door()
            task["phase"] = "ARRIVED"
            task["arrived_at"] = now
        return task, frac

    if task["phase"] == "ARRIVED":
        if confirmed:
            sim.close_door()
            task["phase"] = "RETURNING"
        return task, 1.0

    if task["phase"] == "RETURNING":
        return _drive_home(sim, task, now, "DONE", drive_speed, arrival_tolerance_m)

    if task["phase"] == "RECALLED":
        return _drive_home(sim, task, now, "AT_DESK", drive_speed, arrival_tolerance_m)

    if task["phase"] == "PARKING":
        task, _settled = _settle_heading(sim, task)
        return task, 1.0

    return task, None  # QUEUED / DONE / AT_DESK — no motion


def run(cmd_queue, state):
    """Entry point for Process 2. Polls Supabase for human-confirmation
    events (~once per second, not every tick) and mirrors robots/
    deliveries state back; the phase-transition logic above is
    unchanged by that."""
    sims = {rid: DeliveryBotSimulator(MODEL_PATH) for rid in ROBOT_IDS}
    for sim in sims.values():
        sim.start(headless=True)

    tasks = {}
    task_robot = {}  # task_id -> robot_id, kept after the task ends (see I3)
    robots = {rid: _new_robot() for rid in ROBOT_IDS}
    state["tasks"] = {}
    state["robots"] = {rid: dict(r) for rid, r in robots.items()}

    tick = 1.0 / TICK_HZ
    tick_count = 0
    try:
        while True:
            while True:
                try:
                    _handle(cmd_queue.get_nowait(), tasks)
                except queue.Empty:
                    break

            now = time.time()
            tick_count += 1

            confirmed = {rid: False for rid in ROBOT_IDS}
            sync_this_tick = (tick_count % 5 == 0)  # ~once per second at 5Hz, not every tick
            if sync_this_tick:
                # A DNS blip or a 5xx must not take the whole process down:
                # this is a daemon proc nobody checks is_alive() on, so an
                # uncaught exception here leaves the voice agent happily
                # acking dispatches against a state dict frozen forever.
                # Keep driving; the robot matters more than the mirror.
                try:
                    for cmd_row in supabase_sync.poll_pending_commands(ROBOT_IDS):
                        _route_command(cmd_row, robots, tasks, confirmed)
                        supabase_sync.mark_command_done(cmd_row["id"])
                except Exception as e:
                    print(f"[task_engine] supabase poll failed, continuing: {e!r}")

            idle_ids = [rid for rid, r in robots.items() if r["phase"] == "IDLE"]
            for tid, t in tasks.items():
                if t["phase"] == "QUEUED" and idle_ids:
                    rid = idle_ids.pop(0)
                    t["phase"] = "COLLECTING"
                    tasks[tid] = t
                    robots[rid]["current_task"] = tid
                    robots[rid]["phase"] = "COLLECTING"
                    # remembered past completion: robots[rid]["current_task"]
                    # is cleared when the task ends, but deliveries.robot_id
                    # should still say who ran it
                    task_robot[tid] = rid

            for rid, r in robots.items():
                tid = r["current_task"]
                if tid is None:
                    continue
                tasks[tid], frac = _advance(sims[rid], tasks[tid], now, confirmed[rid])
                if frac is not None:
                    r["pose_frac"] = frac
                r["phase"] = tasks[tid]["phase"]
                if tasks[tid]["phase"] in ("DONE", "AT_DESK"):
                    r["current_task"] = None
                    r["phase"] = "IDLE"

            state["tasks"] = dict(tasks)
            state["robots"] = {rid: dict(r) for rid, r in robots.items()}

            if sync_this_tick:
                try:
                    for rid, r in robots.items():
                        supabase_sync.mirror_robot(rid, r["phase"], r["current_task"],
                                                     r["pose_frac"], r["battery"])
                    for t in tasks.values():
                        supabase_sync.mirror_delivery(t, task_robot.get(t["task_id"]))
                except Exception as e:
                    print(f"[task_engine] supabase mirror failed, continuing: {e!r}")

            time.sleep(tick)
    finally:
        for sim in sims.values():
            sim.stop()


if __name__ == "__main__":
    def routing_demo():
        """Pure logic, no physics — runs first so it fails fast.

        The thing under test is that the three robot_commands commands stay
        distinguishable. Recall arriving as a confirmation is the dangerous
        confusion: it would complete a delivery that nobody collected.
        """
        robots = {
            "robot_1": {"phase": "ARRIVED", "current_task": "t1"},
            "robot_2": {"phase": "IDLE", "current_task": None},
        }
        tasks = {}
        _handle({"cmd": "dispatch", "task_id": "t1", "room": "1204", "items": ["towel"]}, tasks)
        tasks["t1"]["phase"] = "ARRIVED"

        # a recall must recall, and must NOT read as a collection confirmation
        confirmed = {"robot_1": False, "robot_2": False}
        _route_command({"id": "c1", "robot_id": "robot_1", "cmd": "recall",
                        "reason": "guest not answering"}, robots, tasks, confirmed)
        assert confirmed["robot_1"] is False, "recall must not set the confirmation flag"
        assert tasks["t1"]["phase"] == "RETURNING", tasks["t1"]
        assert tasks["t1"]["reason"] == "guest not answering", tasks["t1"]

        # the two human confirmations still route as confirmations
        for cmd in ("complete_loading", "complete_collection"):
            confirmed = {"robot_1": False, "robot_2": False}
            _route_command({"id": "c2", "robot_id": "robot_1", "cmd": cmd, "reason": None},
                           robots, tasks, confirmed)
            assert confirmed["robot_1"] is True, cmd

        # recalling an idle robot is a no-op, not a crash
        confirmed = {"robot_1": False, "robot_2": False}
        _route_command({"id": "c3", "robot_id": "robot_2", "cmd": "recall", "reason": "idle"},
                       robots, tasks, confirmed)
        assert confirmed["robot_2"] is False

        # a command for a robot this process doesn't own is ignored
        confirmed = {"robot_1": False, "robot_2": False}
        _route_command({"id": "c4", "robot_id": "robot_99", "cmd": "complete_loading",
                        "reason": None}, robots, tasks, confirmed)
        assert confirmed == {"robot_1": False, "robot_2": False}

        print("command routing OK (recall vs confirmations kept distinct)")

    # ponytail: real physics, two real sims — this is the actual
    # integration point. `confirmed=True` passed directly here stands in
    # for Task 6b's Supabase polling, which this self-check doesn't need.
    def demo():
        sims = {rid: DeliveryBotSimulator(MODEL_PATH) for rid in ROBOT_IDS}
        for sim in sims.values():
            sim.start(headless=True)
        try:
            speed, tol_m = 0.3, 0.05
            tasks = {}

            # two tasks at once, one per robot, prove they run independently --
            # one near-arm room, one far-arm room (through the real corner)
            _handle({"cmd": "dispatch", "task_id": "t1", "room": "1204", "items": ["towel"]}, tasks)
            _handle({"cmd": "dispatch", "task_id": "t2", "room": "0803", "items": ["nasi lemak"]}, tasks)
            tasks["t1"]["phase"] = "COLLECTING"
            tasks["t2"]["phase"] = "COLLECTING"
            assert tasks["t1"]["eta_seconds"] > tasks["t2"]["eta_seconds"], (
                "far-arm room (1204) should report a longer ETA than near-arm (0803)",
                tasks["t1"]["eta_seconds"], tasks["t2"]["eta_seconds"])

            # complete_loading for both -> EN_ROUTE; door should already be
            # open from the COLLECTING branch's every-tick open_door()
            tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(), confirmed=True,
                                        drive_speed=speed, arrival_tolerance_m=tol_m)
            tasks["t2"], _ = _advance(sims["robot_2"], tasks["t2"], time.time(), confirmed=True,
                                        drive_speed=speed, arrival_tolerance_m=tol_m)
            assert tasks["t1"]["phase"] == "EN_ROUTE"
            assert tasks["t2"]["phase"] == "EN_ROUTE"

            i = 0
            for i in range(1200):
                tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                tasks["t2"], _ = _advance(sims["robot_2"], tasks["t2"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t1"]["phase"] == "ARRIVED" and tasks["t2"]["phase"] == "ARRIVED":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "ARRIVED", tasks["t1"]
            assert tasks["t2"]["phase"] == "ARRIVED", tasks["t2"]
            print(f"[measured] both EN_ROUTE->ARRIVED: {i} ticks")

            # complete_collection -> RETURNING -> drive home -> DONE
            tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(), confirmed=True,
                                        drive_speed=speed, arrival_tolerance_m=tol_m)
            assert tasks["t1"]["phase"] == "RETURNING"
            for i in range(3200):  # real margin over measured arrival (~2111-2225 ticks,
                                     # including the PARKING settle-heading step).
                                     # ARRIVED means facing INTO the room, so driving home
                                     # needs the same kind of ~180-degree U-turn as a
                                     # mid-route recall, plus the full 4m back through the
                                     # corner -- much larger than a straight-line drive of
                                     # the same distance would need
                tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t1"]["phase"] == "DONE":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "DONE", tasks["t1"]
            print(f"[measured] t1 (1204) RETURNING->DONE: {i} ticks")

            # recall while still COLLECTING -> immediate AT_DESK, no motion
            _handle({"cmd": "dispatch", "task_id": "t3", "room": "0804", "items": ["towel"]}, tasks)
            tasks["t3"]["phase"] = "COLLECTING"
            _handle({"cmd": "recall", "task_id": "t3", "reason": "guest changed mind"}, tasks)
            assert tasks["t3"]["phase"] == "AT_DESK", tasks["t3"]

            # recall MID-EN_ROUTE -- the real proof that reversing the path
            # actually steers home rather than continuing toward the room.
            # pure_pursuit_step derives progress from the robot's real
            # measured position every call and never reads task["progress_m"]
            # for its computation (see nav.py's docstring), so this confirms
            # the reversed-path lookahead correctly re-targets the desk
            # direction from the very first call after recall, with no
            # progress_m reset needed anywhere. robot_1 is free again (t1
            # finished above) -- and this is also the scenario that
            # originally exposed the need for _settle_heading()/PARKING: t1
            # parked facing ~180 degrees (nothing previously canonicalized
            # heading on arrival), so t4 dispatching straight after started
            # already facing backward, and under recall that compounded into
            # a real wall-wedge (confirmed live, traced tick-by-tick).
            # _settle_heading() closes this by re-orienting to a canonical
            # heading before a task is considered fully parked -- this
            # sub-test is what actually proves that fix works end-to-end,
            # not just in isolation.
            _handle({"cmd": "dispatch", "task_id": "t4", "room": "1205", "items": ["towel"]}, tasks)
            tasks["t4"]["phase"] = "COLLECTING"
            tasks["t4"], _ = _advance(sims["robot_1"], tasks["t4"], time.time(), confirmed=True,
                                        drive_speed=speed, arrival_tolerance_m=tol_m)
            for _ in range(40):  # partway through the near arm, well before the junction
                tasks["t4"], _ = _advance(sims["robot_1"], tasks["t4"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                time.sleep(0.05)
            assert tasks["t4"]["phase"] == "EN_ROUTE", tasks["t4"]
            _handle({"cmd": "recall", "task_id": "t4", "reason": "wrong room number"}, tasks)
            assert tasks["t4"]["phase"] == "RECALLED", tasks["t4"]
            for i in range(2400):  # real margin over measured arrival (~1577 ticks, including
                                     # PARKING) -- this is the scenario that used to stall
                                     # forever before _settle_heading() existed
                tasks["t4"], _ = _advance(sims["robot_1"], tasks["t4"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t4"]["phase"] == "AT_DESK":
                    break
                time.sleep(0.05)
            assert tasks["t4"]["phase"] == "AT_DESK", tasks["t4"]
            print(f"[measured] t4 (1205) mid-recall RECALLED->AT_DESK: {i} ticks")

            # recall while ARRIVED (nobody came to the door) -> drives home
            assert tasks["t2"]["phase"] == "ARRIVED"
            _handle({"cmd": "recall", "task_id": "t2", "reason": "guest not answering"}, tasks)
            assert tasks["t2"]["phase"] == "RETURNING", tasks["t2"]
            for i in range(2400):  # real margin over measured arrival (~1565-1679 ticks,
                                     # including PARKING) -- same ARRIVED-facing-in U-turn
                                     # as t1 above, over 0803's shorter ~2m near-arm path
                tasks["t2"], _ = _advance(sims["robot_2"], tasks["t2"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t2"]["phase"] == "DONE":
                    break
                time.sleep(0.05)
            assert tasks["t2"]["phase"] == "DONE", tasks["t2"]
            print(f"[measured] t2 (0803) recall-from-ARRIVED RETURNING->DONE: {i} ticks")
            door = sims["robot_2"].pull_status().door
            print(f"robot_2 door after recall-from-ARRIVED: {door}")

            print("engine self-check OK (real corridor scene: near-arm + far-arm "
                  "rooms through the real corner, differing per-room ETA, "
                  "door-open symmetry, recall from COLLECTING/EN_ROUTE/ARRIVED "
                  "-- including a mid-EN_ROUTE recall on a robot reused right "
                  "after its prior delivery, which needs _settle_heading()'s "
                  "canonical-parking fix to succeed)")
        finally:
            for sim in sims.values():
                sim.stop()

    routing_demo()
    demo()
