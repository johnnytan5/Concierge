"""Process 2 — task FSM + navigation.

Runs in its own process, owning TWO DeliveryBotSimulator instances (one
per robot) — never touched from the orchestrator (Process 1), per
physics never runs on the voice loop. `cmd_queue` carries voice-triggered commands
from the orchestrator (dispatch/amend/recall/announce) on the existing
direct path; human-confirmation events (complete_loading/
complete_collection, from a robot's own screen) arrive separately via
Supabase polling (see Task 6b / supabase_sync.py) since they originate
from a different process. `state` is a multiprocessing.Manager() dict
the orchestrator reads directly for check_delivery_status/
get_fleet_state — no round trip through the queue for reads
(tool handlers stay under ~100 ms).

Real corridor navigation: "desk to room" is a hand-authored waypoint path
per room (task_engine/waypoints.json), followed via pure pursuit
(task_engine/nav.py). The phase/state contract
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
        "_leg_oriented": False,  # see _initial_bearing()'s docstring -- reset to
                                  # False at the start of every leg (EN_ROUTE,
                                  # RETURNING, RECALLED)
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
        # A list, not a set: duplicates ARE the quantity (["towel","towel"] is
        # 2x towel), and a set silently turned any amended 2x into 1x. Remove
        # takes out one occurrence per mention, add appends.
        items = list(t["items"])
        for x in cmd.get("remove") or []:
            if x in items:
                items.remove(x)
        t["items"] = items + list(cmd.get("add") or [])
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
        if phase == "QUEUED":
            # never even got a robot -- just cancel
            t["phase"] = "AT_DESK"
        elif phase == "COLLECTING":
            # never left the desk, but may be mid-loading-scene: turned to
            # the counter, cargo door open, viewer on the staff camera. Tidy
            # all of that (PARKING straightens the heading) before AT_DESK.
            t["phase"] = "PARKING"
            t["_parking_terminal_phase"] = "AT_DESK"
            t["_restore_view"] = True
            t.pop("_load", None)
        elif phase == "EN_ROUTE":
            t["phase"] = "RECALLED"
            t["dispatched_at"] = time.time()
            t["_leg_oriented"] = False
        elif phase == "ARRIVED":
            t["phase"] = "RETURNING"  # _drive_home closes the door on the way
            t["_leg_oriented"] = False
            t.pop("_arr", None)
            t.pop("_arr_t", None)
            t["_restore_view"] = True  # mid-hand-over: room door + camera
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


def _bearing_from_here(sim, path: list[tuple[float, float]], lookahead_m: float = 0.15) -> float:
    """Bearing (radians) from the robot's REAL current position toward a
    lookahead point on `path` -- the exact same projection
    (`nav._closest_arc_length` -> `nav._point_at_arc_length`) that
    `pure_pursuit_step` itself uses internally, just called before driving
    starts (v=0 rotation) rather than during (v>0 driving).

    Real bug this exists to fix, in two stages:

    1. Both EN_ROUTE and `_drive_home` used to hand a path straight to
       `pure_pursuit_step` (v=speed_mps>0) with whatever heading error the
       robot happened to already have -- for EN_ROUTE right after
       COLLECTING's turn-to-face-the-desk, that's a full ~180 degrees.
       `pure_pursuit_step` drives forward while steering, so a large
       heading error traces a wide swinging arc rather than turning on the
       spot -- fine in open space, but the corridor is narrow enough that
       the swing clips a wall before the steering catches up. Fixed by
       rotating in place (v=0, via `_rotate_toward`) to the right bearing
       FIRST, and only starting real pure-pursuit driving once already
       close to it -- see the `_leg_oriented` gate in `_advance`'s
       EN_ROUTE branch and in `_drive_home`.

    2. The first version of this fix computed the bearing from `path`'s
       fixed FIRST segment (point 0 to point 1) -- correct when the robot
       is actually starting at the path's first point (true for a fresh
       EN_ROUTE dispatch, and true for RETURNING/RECALLED-from-ARRIVED,
       where the robot really is at the reversed path's start), but wrong
       for a RECALLED-mid-route trip: the robot sits somewhere in the
       MIDDLE of the reversed path there, not at either end, so the path's
       fixed first-segment bearing points in a direction that doesn't
       match where the robot actually is. Found live (a mid-route recall
       self-check failed to arrive within its tick budget, sitting at
       ~97% progress). Fixed by projecting from the robot's real current
       position, same as `pure_pursuit_step` already does -- this is now
       correct regardless of where along the path the robot happens to be.
    """
    status = sim.pull_status()
    x, y = status.base.xy
    s = nav._closest_arc_length(path, x, y)
    look_x, look_y = nav._point_at_arc_length(path, s + lookahead_m)
    return math.atan2(look_y - y, look_x - x)


def _drive_home(sim, task, now, terminal_phase, drive_speed, arrival_tolerance_m):
    sim.close_door()  # idempotent ctrl target; covers a recall straight out of ARRIVED
    if task.pop("_restore_view", False):
        # recalled mid-hand-over: never leave a room door open or the viewer
        # parked inside the room
        sim.set_room_door(task["room"], False)
        sim.set_camera("follow")
    path = list(reversed(nav.path_for(task["room"])))
    if not task["_leg_oriented"]:
        # Rotate toward the reversed path first -- see _bearing_from_here()'s
        # docstring. Projected from the robot's REAL current position, not
        # the path's fixed start: a recall straight out of ARRIVED has the
        # robot AT the reversed path's start, but a mid-route recall has it
        # somewhere in the MIDDLE of the reversed path, and the two need
        # different bearings.
        if _rotate_toward(sim, _bearing_from_here(sim, path)):
            task["_leg_oriented"] = True
        return task, 1.0  # return trip hasn't started yet -- frac stays at "just left"
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
DESK_FACE_YAW_RAD = math.pi  # facing -x -- the front desk sits on the corridor
                              # centerline directly behind the parking spot
                              # (scene_corridor.xml's front_desk body at
                              # x=-0.6), i.e. opposite CANONICAL_PARK_YAW_RAD.
                              # At this heading the robot's door (local -y,
                              # see delivery_bot_v2.xml) faces world +y --
                              # that's why the guest_view camera sits north
                              # of the parking spot, not at the desk itself.
HEADING_TOLERANCE_DEG = 5.0

# Arrival presentation: the robot's cargo door is on its local -y side
# (delivery_bot_v2.xml), so to show it to the room it turns so that side
# faces the room door: yaw = (direction of the room) + 90 degrees.
ROOM_PRESENT_YAW_RAD = {
    "0803": 0.0,            # room to the south (-y)
    "0804": math.pi,        # room to the north (+y)
    "1204": math.pi / 2,    # room to the east (+x)
    "1205": -math.pi / 2,   # room to the west (-x)
}
# Loading at the front desk: the desk is behind the parking spot (-x), so the
# cargo side faces it at yaw = 180 + 90 = -90 degrees.
DESK_PRESENT_YAW_RAD = -math.pi / 2
# How long the cargo door stays open for the guest before closing by itself.
# "Guest collected it" (complete_collection) skips the rest of the wait.
CARGO_HOLD_S = 4.0


def _rotate_toward(sim, target_yaw: float, steer_gain: float = 2.0) -> bool:
    """Pure in-place rotation toward `target_yaw` -- v=0.0 always. This is
    arrival/waiting polish, not navigation: there is no path to stay on
    here, only a heading to reach, and re-running pure_pursuit_step in
    either of this function's two call sites would immediately re-measure
    arc length off whatever path happens to be lying around and could pull
    the robot off the spot it's meant to be holding. Returns True once
    within `HEADING_TOLERANCE_DEG` of `target_yaw` (and stops the base at
    that point); callers decide what "settled" means for their own phase --
    this function only ever touches heading, never `task["phase"]`."""
    status = sim.pull_status()
    yaw = math.radians(status.base.yaw_deg)
    heading_error = math.atan2(math.sin(target_yaw - yaw), math.cos(target_yaw - yaw))
    if abs(math.degrees(heading_error)) <= HEADING_TOLERANCE_DEG:
        sim.stop_base()
        return True
    sim.drive(v=0.0, omega=steer_gain * heading_error)
    return False


def _settle_heading(sim, task, steer_gain: float = 2.0):
    """Real bug this exists to fix (found live, reproducibly, tracing a
    robot's exact position tick-by-tick): `pure_pursuit_step`'s arrival check only ever
    constrained POSITION (`hypot(...) <= arrival_tolerance_m`), never
    heading. A robot driving home along a path that approaches the desk
    from +x (every room's reversed path does) ends up parked facing
    ~180 degrees -- backward relative to where the NEXT dispatch needs to
    head. That robot then starts its next task already needing an
    unplanned course-reversal, and in the worst case (confirmed live) that
    compounds badly enough to drive the robot into a corridor wall, where
    it physically wedges.

    Fix: once position has arrived (`_drive_home` sets phase to PARKING),
    rotate in place until heading is within `HEADING_TOLERANCE_DEG` of
    `CANONICAL_PARK_YAW_RAD`, THEN stop and apply the real terminal phase.
    """
    if _rotate_toward(sim, CANONICAL_PARK_YAW_RAD, steer_gain):
        task["phase"] = task.pop("_parking_terminal_phase")
        return task, True
    return task, False


def _loading_sequence(sim, task, now, confirmed: bool):
    """Loading at the front desk, the mirror of _arrival_sequence (phase
    stays COLLECTING throughout, so the dashboard shows "Loading"):

      turn        a quarter turn to present the cargo side to the counter,
                  then cut the viewer to the staff camera behind the desk
                  and open the cargo door
      open        wait for complete_loading ("Bin loaded -- send it")
      closing     wait for the cargo door, cut back to the top view, and
                  set off (EN_ROUTE pre-rotates toward the corridor)

    Gated on the kiosk button on purpose (demo choice): a person loading the
    bin is the moment the robot leaves, so the door stays open until then.
    The room hand-over, by contrast, closes on a timer (CARGO_HOLD_S)."""
    step = task.get("_load", "turn")
    if step == "turn":
        if _rotate_toward(sim, DESK_PRESENT_YAW_RAD):
            sim.set_camera("desk_staff")
            sim.open_door()
            step = "open"
    elif step == "open":
        if confirmed:
            sim.close_door()
            step = "closing"
    elif step == "closing":
        if sim.pull_status().door.fraction_open <= 0.05:
            sim.set_camera("follow")
            task["phase"] = "EN_ROUTE"
            task["dispatched_at"] = now
            task["_leg_oriented"] = False
            step = None
    if step is None:
        task.pop("_load", None)
    else:
        task["_load"] = step
    return task


def _arrival_sequence(sim, task, now, confirmed: bool):
    """The hand-over at the room, one step per tick (phase stays ARRIVED
    throughout, so the dashboard just shows "At the door"):

      turn            present the cargo-door side to the room, then cut the
                      viewer to the in-room guest camera and swing the room
                      door open
      room_opening    wait for the room door, then open the cargo door
      cargo_open      hold CARGO_HOLD_S (or until complete_collection)
      cargo_closing   wait for the cargo door, then close the room door
      room_closing    wait for the room door, cut back to the top view,
                      and head home (RETURNING)

    Doors animate inside the sim's step loop; this only sets targets and
    watches them, so every tick still returns immediately."""
    room = task["room"]
    step = task.get("_arr", "turn")
    if step == "turn":
        yaw = ROOM_PRESENT_YAW_RAD.get(room)
        if yaw is None or _rotate_toward(sim, yaw):
            sim.set_camera("room_" + room)
            sim.set_room_door(room, True)
            step = "room_opening"
    elif step == "room_opening":
        if not sim.has_room_door(room) or sim.room_door_fraction(room) >= 0.98:
            sim.open_door()
            task["_arr_t"] = now
            step = "cargo_open"
    elif step == "cargo_open":
        if confirmed or now - task["_arr_t"] >= CARGO_HOLD_S:
            sim.close_door()
            step = "cargo_closing"
    elif step == "cargo_closing":
        if sim.pull_status().door.fraction_open <= 0.05:
            sim.set_room_door(room, False)
            step = "room_closing"
    elif step == "room_closing":
        if sim.room_door_fraction(room) <= 0.02:
            sim.set_camera("follow")
            task.pop("_arr_t", None)
            task["phase"] = "RETURNING"
            task["_leg_oriented"] = False
            step = None
    if step is None:
        task.pop("_arr", None)
    else:
        task["_arr"] = step
    return task


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
        return _loading_sequence(sim, task, now, confirmed), 0.0

    if task["phase"] == "EN_ROUTE":
        path = nav.path_for(task["room"])
        if not task["_leg_oriented"]:
            # Rotate toward the path first -- see _bearing_from_here()'s
            # docstring. A fresh EN_ROUTE dispatch always starts exactly at
            # the path's first point, so this reduces to the same bearing
            # every room's forward path already starts with (+x, same as
            # CANONICAL_PARK_YAW_RAD) -- computed from the real path rather
            # than assumed, so it stays correct if that ever changes.
            if _rotate_toward(sim, _bearing_from_here(sim, path)):
                task["_leg_oriented"] = True
            return task, 0.0
        task["progress_m"], frac, done = nav.pure_pursuit_step(
            sim, path, task["progress_m"], drive_speed,
            arrival_tolerance_m=arrival_tolerance_m)
        if done:
            sim.stop_base()
            task["phase"] = "ARRIVED"
            task["arrived_at"] = now
            task["_arr"] = "turn"
        return task, frac

    if task["phase"] == "ARRIVED":
        return _arrival_sequence(sim, task, now, confirmed), 1.0

    if task["phase"] == "RETURNING":
        return _drive_home(sim, task, now, "DONE", drive_speed, arrival_tolerance_m)

    if task["phase"] == "RECALLED":
        return _drive_home(sim, task, now, "AT_DESK", drive_speed, arrival_tolerance_m)

    if task["phase"] == "PARKING":
        if task.pop("_restore_view", False):  # recalled mid-loading-scene
            sim.close_door()
            sim.set_camera("follow")
        task, _settled = _settle_heading(sim, task)
        return task, 1.0

    return task, None  # QUEUED / DONE / AT_DESK — no motion


def run(cmd_queue, state, viewer_robot=None):
    """Entry point for Process 2. Polls Supabase for human-confirmation
    events (~once per second, not every tick) and mirrors robots/
    deliveries state back; the phase-transition logic above is
    unchanged by that.

    `viewer_robot` opens the MuJoCo viewer on that robot's sim -- the SAME
    physics the dashboard reads, so the window and the admin UI can't
    disagree. Each robot is its own MuJoCo world, so only one is shown. On
    macOS this process must have been spawned by mjpython (see
    orchestrator/agent.py main()); launch_passive refuses otherwise."""
    sims = {rid: DeliveryBotSimulator(MODEL_PATH) for rid in ROBOT_IDS}
    for rid, sim in sims.items():
        sim.start(headless=(rid != viewer_robot), show_ui=False)
    if viewer_robot in sims:
        sims[viewer_robot].set_camera("follow")

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

            # the loading scene: quarter turn to the counter, cargo door opens
            # and STAYS open with no button press (well past any timer), then
            # "Bin loaded" closes it and the robot sets off
            presented = {"t1": None, "t2": None}
            opened = {"t1": False, "t2": False}
            for _ in range(160):  # 8s, no confirmation
                for rid, tid in (("robot_1", "t1"), ("robot_2", "t2")):
                    tasks[tid], _ = _advance(sims[rid], tasks[tid], time.time(),
                                               drive_speed=speed, arrival_tolerance_m=tol_m)
                    if tasks[tid].get("_load") == "open" and presented[tid] is None:
                        presented[tid] = sims[rid].pull_status().base.yaw_deg
                    opened[tid] |= sims[rid].pull_status().door.fraction_open >= 0.9
                time.sleep(0.05)
            for rid, tid in (("robot_1", "t1"), ("robot_2", "t2")):
                assert tasks[tid]["phase"] == "COLLECTING" and tasks[tid]["_load"] == "open", (
                    rid, "left the desk without Bin loaded", tasks[tid])
            for _ in range(300):
                for rid, tid in (("robot_1", "t1"), ("robot_2", "t2")):
                    if tasks[tid]["phase"] != "COLLECTING":
                        continue
                    tasks[tid], _ = _advance(sims[rid], tasks[tid], time.time(), confirmed=True,
                                               drive_speed=speed, arrival_tolerance_m=tol_m)
                    if tasks[tid].get("_load") == "open" and presented[tid] is None:
                        presented[tid] = sims[rid].pull_status().base.yaw_deg
                    opened[tid] |= sims[rid].pull_status().door.fraction_open >= 0.9
                if tasks["t1"]["phase"] == "EN_ROUTE" and tasks["t2"]["phase"] == "EN_ROUTE":
                    break
                time.sleep(0.05)
            for rid, tid in (("robot_1", "t1"), ("robot_2", "t2")):
                assert tasks[tid]["phase"] == "EN_ROUTE", (rid, tasks[tid])
                assert opened[tid], f"{rid}: cargo door never opened for loading"
                assert sims[rid].pull_status().door.fraction_open <= 0.05, f"{rid}: left the desk with the door open"
                err = abs(presented[tid] - math.degrees(DESK_PRESENT_YAW_RAD))
                assert err <= HEADING_TOLERANCE_DEG, (rid, "not presented to the counter", presented[tid])
            print(f"[measured] loading scene: presented to counter at {presented}, door held open until Bin loaded, then closed and left")

            i = 0
            for i in range(1000):  # real margin over measured arrival (~695-696 ticks).
                                     # EN_ROUTE now pre-rotates (v=0) to face the path
                                     # before driving (_leg_oriented gate, see
                                     # _bearing_from_here()'s docstring) instead of
                                     # correcting a ~180-degree error while already
                                     # driving forward -- this is why the budget is back
                                     # down near the original pre-desk-facing measurement
                                     # (~665-669 ticks) despite COLLECTING's desk-facing
                                     # turn adding a full reversal to correct
                # hold each robot at ARRIVED once it gets there: the hand-over
                # sequence would otherwise run to RETURNING on the shorter
                # 0803 leg before the far-arm robot even arrives
                for rid, tid in (("robot_1", "t1"), ("robot_2", "t2")):
                    if tasks[tid]["phase"] != "ARRIVED":
                        tasks[tid], _ = _advance(sims[rid], tasks[tid], time.time(),
                                                   drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t1"]["phase"] == "ARRIVED" and tasks["t2"]["phase"] == "ARRIVED":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "ARRIVED", tasks["t1"]
            assert tasks["t2"]["phase"] == "ARRIVED", tasks["t2"]
            print(f"[measured] both EN_ROUTE->ARRIVED: {i} ticks")

            # complete_collection -> RETURNING -> drive home -> DONE
            # the hand-over sequence: turn to the room, room door opens, cargo
            # door opens, holds, closes, room door closes, then RETURNING
            door_seen_open = cargo_seen_open = False
            for i in range(300):
                tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                door_seen_open |= sims["robot_1"].room_door_fraction("1204") >= 0.98
                cargo_seen_open |= sims["robot_1"].pull_status().door.fraction_open >= 0.9
                if tasks["t1"]["phase"] == "RETURNING":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "RETURNING", tasks["t1"]
            assert door_seen_open and cargo_seen_open, (door_seen_open, cargo_seen_open)
            assert sims["robot_1"].room_door_fraction("1204") <= 0.02, "room door left open"
            assert sims["robot_1"].pull_status().door.fraction_open <= 0.05, "cargo door left open"
            print(f"[measured] t1 (1204) hand-over: room door + cargo door opened and closed, {i} ticks")
            for i in range(1200):  # real margin over measured arrival (~805-808 ticks,
                                     # including the pre-rotation and PARKING
                                     # settle-heading steps). Same pre-rotate-then-drive
                                     # pattern as EN_ROUTE above keeps this near the
                                     # straight drive-home time despite the corner and the
                                     # ~180-degree reversal ARRIVED leaves it facing
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
            assert tasks["t3"]["phase"] == "PARKING", tasks["t3"]
            for _ in range(100):  # tidy-up: door shut, heading straightened
                tasks["t3"], _ = _advance(sims["robot_2"], tasks["t3"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t3"]["phase"] == "AT_DESK":
                    break
                time.sleep(0.05)
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
            for _ in range(200):  # loading scene, skipped ahead by complete_loading
                tasks["t4"], _ = _advance(sims["robot_1"], tasks["t4"], time.time(), confirmed=True,
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t4"]["phase"] == "EN_ROUTE":
                    break
                time.sleep(0.05)
            for _ in range(40):  # partway through the near arm, well before the junction
                tasks["t4"], _ = _advance(sims["robot_1"], tasks["t4"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                time.sleep(0.05)
            assert tasks["t4"]["phase"] == "EN_ROUTE", tasks["t4"]
            _handle({"cmd": "recall", "task_id": "t4", "reason": "wrong room number"}, tasks)
            assert tasks["t4"]["phase"] == "RECALLED", tasks["t4"]
            for i in range(500):  # real margin over measured arrival (~259 ticks). This is
                                    # the scenario that used to stall forever before
                                    # _settle_heading() existed, and later needed a wrong
                                    # fixed-first-segment bearing fix before
                                    # _bearing_from_here() (projected from the robot's
                                    # real position) made it fast and correct
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
            for i in range(600):  # real margin over measured arrival (~361 ticks) -- same
                                    # ARRIVED-facing-in reversal as t1 above, over 0803's
                                    # shorter ~2m near-arm path
                tasks["t2"], _ = _advance(sims["robot_2"], tasks["t2"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t2"]["phase"] == "DONE":
                    break
                time.sleep(0.05)
            assert tasks["t2"]["phase"] == "DONE", tasks["t2"]
            print(f"[measured] t2 (0803) recall-from-ARRIVED RETURNING->DONE: {i} ticks")
            door = sims["robot_2"].pull_status().door
            print(f"robot_2 door after recall-from-ARRIVED: {door}")
            assert sims["robot_2"].room_door_fraction("0803") <= 0.02, "0803 door left open after recall"

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
