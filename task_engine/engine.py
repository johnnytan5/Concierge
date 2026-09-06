"""Process 2 — task FSM + navigation, per ARCHITECTURE.md.

Runs in its own process, owning one DeliveryBotSimulator instance
(`sim/concierge_sim.py`) — never touched from the orchestrator (Process
1), per CLAUDE.md constraint 1. `cmd_queue` carries commands from the
orchestrator (dispatch/amend/recall/announce); `state` is a
multiprocessing.Manager() dict the orchestrator reads directly for
check_delivery_status/get_robot_state — no round trip through the queue
for reads, so those tool handlers stay non-blocking (CLAUDE.md
constraint 2).

ponytail: there's no real corridor/waypoint graph yet
(sim/scene_corridor.xml and task_engine/nav.py are both still empty —
Day 8-14 work). Until then, "desk to room" is a fixed straight-line
distance (NOMINAL_TRIP_METERS) — drive forward, open the door on
arrival, dwell, close the door, drive straight back on recall. Swap
`_advance`'s straight-line distance math for nav.py's pure-pursuit +
per-room waypoint distance once that exists; the phase/state contract
below (what orchestrator/tools.py reads) doesn't need to change when it
does.
"""
import os
import queue
import sys
import time
import uuid

_SIM_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "sim"))
sys.path.insert(0, _SIM_DIR)  # concierge_sim.py is a plain script-dir module, not an
                                # installed package — see its own docstring's usage convention
from concierge_sim import DeliveryBotSimulator  # noqa: E402 (path insert must come first)

MODEL_PATH = os.path.join(_SIM_DIR, "delivery_bot_v2.xml")

DWELL_SECONDS = 10.0  # time the door stays open at the room before freeing the robot
TICK_HZ = 5.0

DRIVE_SPEED_MPS = 0.11          # within concierge_sim's MAX_LINEAR_MPS (~0.16)
NOMINAL_TRIP_METERS = 10.0      # placeholder single-corridor distance, see module docstring
BASE_ETA_SECONDS = NOMINAL_TRIP_METERS / DRIVE_SPEED_MPS  # ~90.9s — matches
                                  # PLAN.md's "up to 90 seconds" framing
ORIGIN_XY = (0.0, 0.0)           # desk / dock position


def _new_task(task_id, room, items, priority):
    return {
        "task_id": task_id,
        "room": room,
        "items": list(items),
        "priority": priority,
        "phase": "QUEUED",   # QUEUED -> EN_ROUTE -> ARRIVED -> DONE
                              #        \-> RECALLED -> AT_DESK
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
            return  # too late — caller already sees current phase via check_delivery_status
        items = (set(t["items"]) - set(cmd.get("remove") or [])) | set(cmd.get("add") or [])
        t["items"] = sorted(items)
        if cmd.get("new_room"):
            t["room"] = cmd["new_room"]
        if t["phase"] == "EN_ROUTE":
            t["dispatched_at"] = time.time()  # restart countdown: "reverses and re-departs" (S4)
        tasks[cmd["task_id"]] = t

    elif kind == "recall":
        t = tasks.get(cmd["task_id"])
        if t and t["phase"] == "EN_ROUTE":
            t["phase"] = "RECALLED"
            t["dispatched_at"] = time.time()
            t["reason"] = cmd.get("reason")
            tasks[cmd["task_id"]] = t

    elif kind == "announce":
        t = tasks.get(cmd["task_id"])
        if t:
            t["announced"] = True
            tasks[cmd["task_id"]] = t


def _dist_from_origin(sim: DeliveryBotSimulator) -> float:
    x, y = sim.pull_status().base.xy
    return ((x - ORIGIN_XY[0]) ** 2 + (y - ORIGIN_XY[1]) ** 2) ** 0.5


def _drive_home(sim, task, now, terminal_phase, trip_meters, drive_speed, arrival_tolerance_m):
    """Reverse-drive-to-origin, shared by RECALLED (guest cancelled) and
    RETURNING (normal post-delivery return) — same physical motion,
    different terminal phase name. Both matter for `_dist_from_origin`'s
    fixed-distance-from-origin math to stay valid on the *next* dispatch:
    without an explicit return leg, a task that finished DONE at the room
    would leave the robot parked away from origin, and the next EN_ROUTE
    task would measure its own progress from that stale position instead
    of a fresh trip — silently "arriving" almost immediately."""
    sim.drive(v=-drive_speed, omega=0.0)
    remaining = _dist_from_origin(sim)
    frac = min(remaining / trip_meters, 1.0)
    if remaining <= arrival_tolerance_m:
        sim.stop_base()
        task["phase"] = terminal_phase
    return task, frac


def _advance(sim: DeliveryBotSimulator, task, now,
             trip_meters: float = NOMINAL_TRIP_METERS,
             drive_speed: float = DRIVE_SPEED_MPS,
             arrival_tolerance_m: float = 0.05):
    """Real-physics version: drives `sim`, reads real position back. Same
    phase contract as before — only how `frac`/phase transitions are
    computed changed, not what callers see in `state`. QUEUED -> EN_ROUTE
    -> ARRIVED -> RETURNING -> DONE, or EN_ROUTE -> RECALLED -> AT_DESK."""
    if task["phase"] == "EN_ROUTE":
        sim.drive(v=drive_speed, omega=0.0)
        frac = min(_dist_from_origin(sim) / trip_meters, 1.0)
        if frac >= 1.0:
            sim.stop_base()
            sim.open_door()  # bin-loading: guest retrieves the item at the door
            task["phase"] = "ARRIVED"
            task["arrived_at"] = now
        return task, frac

    if task["phase"] == "ARRIVED":
        if now - task["arrived_at"] >= DWELL_SECONDS:
            sim.close_door()
            task["phase"] = "RETURNING"  # guest has the item; robot still needs to come back
        return task, 1.0

    if task["phase"] == "RETURNING":
        return _drive_home(sim, task, now, "DONE", trip_meters, drive_speed, arrival_tolerance_m)

    if task["phase"] == "RECALLED":
        return _drive_home(sim, task, now, "AT_DESK", trip_meters, drive_speed, arrival_tolerance_m)

    return task, None  # QUEUED / DONE / AT_DESK — no motion


def run(cmd_queue, state):
    """Entry point for Process 2 (spawn as `multiprocessing.Process(target=run, ...)`)."""
    sim = DeliveryBotSimulator(MODEL_PATH)
    sim.start(headless=True)  # background thread inside THIS process only — constraint 1

    tasks = {}
    robot = {"pose_frac": 0.0, "payload": [], "battery": 100.0, "current_task": None}
    state["tasks"] = {}
    state["robot"] = dict(robot)

    tick = 1.0 / TICK_HZ
    try:
        while True:
            while True:
                try:
                    _handle(cmd_queue.get_nowait(), tasks)
                except queue.Empty:
                    break

            now = time.time()
            active_id = robot["current_task"]

            if active_id is None:
                for tid, t in tasks.items():
                    if t["phase"] == "QUEUED":
                        t["dispatched_at"] = now
                        t["phase"] = "EN_ROUTE"
                        tasks[tid] = t
                        robot["current_task"] = tid
                        active_id = tid
                        break

            if active_id is not None:
                tasks[active_id], frac = _advance(sim, tasks[active_id], now)
                if frac is not None:
                    robot["pose_frac"] = frac
                if tasks[active_id]["phase"] in ("DONE", "AT_DESK"):
                    robot["current_task"] = None

            state["tasks"] = dict(tasks)
            state["robot"] = dict(robot)
            time.sleep(tick)
    finally:
        sim.stop()


if __name__ == "__main__":
    # ponytail: real headless sim, not a mocked position function — this is
    # the actual integration point, so the self-check exercises the real
    # thing. Small trip_meters/drive_speed overrides keep it a few seconds,
    # not ~90s.
    def demo():
        sim = DeliveryBotSimulator(MODEL_PATH)
        sim.start(headless=True)
        try:
            # trip long enough (relative to speed/tick) to have a real
            # multi-tick EN_ROUTE window to amend/recall inside, not so
            # long the self-check is slow
            trip_m, speed, tol_m = 0.05, 0.05, 0.005

            tasks = {}
            _handle({"cmd": "dispatch", "task_id": "t1", "room": "1204", "items": ["towel"]}, tasks)
            assert tasks["t1"]["phase"] == "QUEUED"

            tasks["t1"]["dispatched_at"] = time.time()
            tasks["t1"]["phase"] = "EN_ROUTE"

            # a couple ticks out (still EN_ROUTE), then amend mid-flight — S4
            for _ in range(3):
                tasks["t1"], _ = _advance(sim, tasks["t1"], time.time(), trip_m, speed, tol_m)
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "EN_ROUTE", tasks["t1"]

            _handle({"cmd": "amend", "task_id": "t1", "add": ["toothbrush"]}, tasks)
            assert "toothbrush" in tasks["t1"]["items"]

            for _ in range(200):
                tasks["t1"], _ = _advance(sim, tasks["t1"], time.time(), trip_m, speed, tol_m)
                if tasks["t1"]["phase"] == "ARRIVED":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "ARRIVED", tasks["t1"]
            time.sleep(2.0)  # door panels take ~2s to physically move, see concierge_sim.py
            door_open = sim.pull_status().door.fraction_open
            assert door_open > 0.5, f"door should be open on arrival, got {door_open}"

            tasks["t1"], _ = _advance(sim, tasks["t1"], tasks["t1"]["arrived_at"] + DWELL_SECONDS, trip_m, speed, tol_m)
            assert tasks["t1"]["phase"] == "RETURNING"
            time.sleep(3.0)  # bottom door panel takes ~3s to settle against gravity, see concierge_sim.py
            door_closed = sim.pull_status().door.fraction_open
            assert door_closed < 0.1, f"door should be closed after dwell, got {door_closed}"

            # drive the return leg for real — this is the bug that would bite
            # a second dispatch otherwise: without it, the robot stays parked
            # at the room and the next task's distance-from-origin math starts
            # from there instead of a fresh trip, "arriving" almost instantly
            for _ in range(200):
                tasks["t1"], _ = _advance(sim, tasks["t1"], time.time(), trip_m, speed, tol_m)
                if tasks["t1"]["phase"] == "DONE":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "DONE", tasks["t1"]
            assert _dist_from_origin(sim) <= tol_m * 1.5, "should be back near origin before next dispatch"

            # recall path: dispatch again, let it get partway, then recall and
            # verify it actually drives back down to the desk
            _handle({"cmd": "dispatch", "task_id": "t2", "room": "0803", "items": ["towel"]}, tasks)
            tasks["t2"]["dispatched_at"] = time.time()
            tasks["t2"]["phase"] = "EN_ROUTE"
            for _ in range(3):  # a few ticks out, not all the way
                tasks["t2"], _ = _advance(sim, tasks["t2"], time.time(), trip_m, speed, tol_m)
                time.sleep(0.05)
            assert tasks["t2"]["phase"] == "EN_ROUTE", tasks["t2"]
            partway_dist = _dist_from_origin(sim)
            assert partway_dist > tol_m, f"expected to have moved away from origin, got {partway_dist}"

            _handle({"cmd": "recall", "task_id": "t2", "reason": "guest cancelled"}, tasks)
            assert tasks["t2"]["phase"] == "RECALLED"
            for _ in range(200):
                tasks["t2"], _ = _advance(sim, tasks["t2"], time.time(), trip_m, speed, tol_m)
                if tasks["t2"]["phase"] == "AT_DESK":
                    break
                time.sleep(0.05)
            assert tasks["t2"]["phase"] == "AT_DESK", tasks["t2"]
            assert _dist_from_origin(sim) <= tol_m * 1.5

            print("engine self-check OK (real physics: drive, arrive, door, amend, recall)")
        finally:
            sim.stop()

    demo()
