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

ponytail: there's no real corridor/waypoint graph yet
(sim/scene_corridor.xml and task_engine/nav.py are both still empty).
Until then, "desk to room" is a fixed straight-line distance
(NOMINAL_TRIP_METERS) — drive forward, open the door on arrival, wait
for guest confirmation, close the door, drive straight back. Swap
`_advance`'s straight-line distance math for nav.py's pure-pursuit +
per-room waypoint distance once that exists; the phase/state contract
below doesn't need to change when it does.
"""
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

MODEL_PATH = os.path.join(_SIM_DIR, "delivery_bot_v2.xml")

ROBOT_IDS = ["robot_1", "robot_2"]
TICK_HZ = 5.0

DRIVE_SPEED_MPS = 0.11
NOMINAL_TRIP_METERS = 10.0
BASE_ETA_SECONDS = NOMINAL_TRIP_METERS / DRIVE_SPEED_MPS
ORIGIN_XY = (0.0, 0.0)


def _new_robot():
    return {"phase": "IDLE", "pose_frac": 0.0, "battery": 100.0, "current_task": None}


def _new_task(task_id, room, items, priority):
    return {
        "task_id": task_id,
        "room": room,
        "items": list(items),
        "priority": priority,
        "phase": "QUEUED",   # QUEUED -> COLLECTING -> EN_ROUTE -> ARRIVED -> RETURNING -> DONE
                              #                                 \-> RECALLED -> AT_DESK
        "dispatched_at": None,
        "arrived_at": None,
        "eta_seconds": BASE_ETA_SECONDS,
        "announced": False,
        "reason": None,
    }


def _handle(cmd, tasks):
    kind = cmd.get("cmd")

    if kind == "dispatch":
        tasks[cmd["task_id"]] = _new_task(
            cmd["task_id"], cmd["room"], cmd.get("items", []),
            cmd.get("priority", "normal"))

    elif kind == "amend":
        t = tasks.get(cmd["task_id"])
        if not t or t["phase"] in ("ARRIVED", "RETURNING", "DONE", "AT_DESK"):
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
            return  # RETURNING / RECALLED / DONE / AT_DESK -- already coming back or over
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


def _dist_from_origin(sim: DeliveryBotSimulator) -> float:
    x, y = sim.pull_status().base.xy
    return ((x - ORIGIN_XY[0]) ** 2 + (y - ORIGIN_XY[1]) ** 2) ** 0.5


def _drive_home(sim, task, now, terminal_phase, trip_meters, drive_speed, arrival_tolerance_m):
    sim.close_door()  # idempotent ctrl target; covers a recall straight out of ARRIVED
    sim.drive(v=-drive_speed, omega=0.0)
    remaining = _dist_from_origin(sim)
    frac = min(remaining / trip_meters, 1.0)
    if remaining <= arrival_tolerance_m:
        sim.stop_base()
        task["phase"] = terminal_phase
    return task, frac


def _advance(sim: DeliveryBotSimulator, task, now, confirmed: bool = False,
             trip_meters: float = NOMINAL_TRIP_METERS,
             drive_speed: float = DRIVE_SPEED_MPS,
             arrival_tolerance_m: float = 0.05):
    """`confirmed` is this tick's human-confirmation flag for this
    task's robot (complete_loading while COLLECTING, complete_collection
    while ARRIVED) — see module docstring for where it comes from.
    ponytail: no timeout fallback yet if a confirmation never arrives
    (robot waits at COLLECTING/ARRIVED forever) -- acceptable for the
    demo, flagged as a follow-up, not silently ignored."""
    if task["phase"] == "COLLECTING":
        if confirmed:
            task["phase"] = "EN_ROUTE"
            task["dispatched_at"] = now
        return task, 0.0

    if task["phase"] == "EN_ROUTE":
        sim.drive(v=drive_speed, omega=0.0)
        frac = min(_dist_from_origin(sim) / trip_meters, 1.0)
        if frac >= 1.0:
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
        return _drive_home(sim, task, now, "DONE", trip_meters, drive_speed, arrival_tolerance_m)

    if task["phase"] == "RECALLED":
        return _drive_home(sim, task, now, "AT_DESK", trip_meters, drive_speed, arrival_tolerance_m)

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
            trip_m, speed, tol_m = 0.05, 0.05, 0.005
            tasks = {}

            # two tasks at once, one per robot, prove they run independently
            _handle({"cmd": "dispatch", "task_id": "t1", "room": "1204", "items": ["towel"]}, tasks)
            _handle({"cmd": "dispatch", "task_id": "t2", "room": "0803", "items": ["nasi lemak"]}, tasks)
            tasks["t1"]["phase"] = "COLLECTING"
            tasks["t2"]["phase"] = "COLLECTING"

            # complete_loading for both -> EN_ROUTE
            tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(), confirmed=True,
                                        trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
            tasks["t2"], _ = _advance(sims["robot_2"], tasks["t2"], time.time(), confirmed=True,
                                        trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
            assert tasks["t1"]["phase"] == "EN_ROUTE"
            assert tasks["t2"]["phase"] == "EN_ROUTE"

            for _ in range(200):
                tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(),
                                            trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
                tasks["t2"], _ = _advance(sims["robot_2"], tasks["t2"], time.time(),
                                            trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t1"]["phase"] == "ARRIVED" and tasks["t2"]["phase"] == "ARRIVED":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "ARRIVED", tasks["t1"]
            assert tasks["t2"]["phase"] == "ARRIVED", tasks["t2"]

            # both robots should have actually moved independently
            d1 = _dist_from_origin(sims["robot_1"])
            d2 = _dist_from_origin(sims["robot_2"])
            assert d1 > tol_m and d2 > tol_m, (d1, d2)

            # complete_collection -> RETURNING -> drive home -> DONE
            tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(), confirmed=True,
                                        trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
            assert tasks["t1"]["phase"] == "RETURNING"
            for _ in range(200):
                tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(),
                                            trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t1"]["phase"] == "DONE":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "DONE", tasks["t1"]

            # recall while still COLLECTING -> immediate AT_DESK, no motion
            _handle({"cmd": "dispatch", "task_id": "t3", "room": "1500", "items": ["towel"]}, tasks)
            tasks["t3"]["phase"] = "COLLECTING"
            _handle({"cmd": "recall", "task_id": "t3", "reason": "guest changed mind"}, tasks)
            assert tasks["t3"]["phase"] == "AT_DESK", tasks["t3"]

            # recall while still QUEUED (no robot ever assigned) -> cancelled
            _handle({"cmd": "dispatch", "task_id": "t4", "room": "1501", "items": ["towel"]}, tasks)
            _handle({"cmd": "recall", "task_id": "t4", "reason": "ordered by mistake"}, tasks)
            assert tasks["t4"]["phase"] == "AT_DESK", tasks["t4"]
            assert tasks["t4"]["reason"] == "ordered by mistake"

            # recall of an already-finished task is a no-op, not a phase flip
            _handle({"cmd": "recall", "task_id": "t1", "reason": "too late"}, tasks)
            assert tasks["t1"]["phase"] == "DONE", tasks["t1"]

            # recall while ARRIVED (nobody came to the door) -> drives home
            assert tasks["t2"]["phase"] == "ARRIVED"
            _handle({"cmd": "recall", "task_id": "t2", "reason": "guest not answering"}, tasks)
            assert tasks["t2"]["phase"] == "RETURNING", tasks["t2"]
            for _ in range(200):
                tasks["t2"], _ = _advance(sims["robot_2"], tasks["t2"], time.time(),
                                            trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t2"]["phase"] == "DONE":
                    break
                time.sleep(0.05)
            assert tasks["t2"]["phase"] == "DONE", tasks["t2"]
            door = sims["robot_2"].pull_status().door
            print(f"robot_2 door after recall-from-ARRIVED: {door}")

            print("engine self-check OK (two concurrent robots: dispatch, collect, "
                  "arrive, collect-confirm, return, and recall from QUEUED / "
                  "COLLECTING / ARRIVED)")
        finally:
            for sim in sims.values():
                sim.stop()

    routing_demo()
    demo()
