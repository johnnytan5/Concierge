"""Waypoint navigation for Process 2 -- pure pursuit over a hand-authored
per-room path (task_engine/waypoints.json). No graph, no pathfinding: the
JSON file *is* the route. See docs/superpowers/specs/2026-09-11-hotel-
corridor-scene-nav-design.md's Non-goals for why (topology is small and
fixed; a search algorithm buys nothing here).

Pure pursuit here means "follow this known point sequence" -- the robot's
pose comes straight from MuJoCo's own simulated state (sim.pull_status()),
not from any kind of localization. drive()'s ctrl-to-velocity ratio is
already calibrated (concierge_sim.py) and reused exactly; this module only
ever calls it with real m/s / rad/s, closing the loop every tick off
*measured* heading error -- which is also why drive()'s own module comment
already said the turn-ratio calibration didn't need to be lab-exact.
"""
import json
import math
import os

_WAYPOINTS_PATH = os.path.join(os.path.dirname(__file__), "waypoints.json")
_cache: dict[str, list[tuple[float, float]]] | None = None


def _load() -> dict[str, list[tuple[float, float]]]:
    global _cache
    if _cache is None:
        with open(_WAYPOINTS_PATH) as f:
            raw = json.load(f)
        _cache = {room: [tuple(p) for p in path] for room, path in raw.items()}
    return _cache


def path_for(room: str) -> list[tuple[float, float]]:
    """Raises KeyError on an unknown room -- a missing waypoint path for a
    room that already passed inventory validation is a real bug, not a
    'not offered' case, so this does not silently return an empty list."""
    paths = _load()
    if room not in paths:
        raise KeyError(f"no waypoint path for room {room!r}")
    return paths[room]


def total_length(path: list[tuple[float, float]]) -> float:
    return sum(
        math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1])
        for i in range(len(path) - 1)
    )


def _point_at_arc_length(path: list[tuple[float, float]], s: float) -> tuple[float, float]:
    """The point on `path` at cumulative arc length `s` from the start.
    Clamps to the final point once s exceeds the path's total length."""
    remaining = s
    for i in range(len(path) - 1):
        x0, y0 = path[i]
        x1, y1 = path[i + 1]
        seg_len = math.hypot(x1 - x0, y1 - y0)
        if remaining <= seg_len:
            t = remaining / seg_len if seg_len > 0 else 0.0
            return (x0 + t * (x1 - x0), y0 + t * (y1 - y0))
        remaining -= seg_len
    return path[-1]


def pure_pursuit_step(sim, path: list[tuple[float, float]], progress_m: float,
                       speed_mps: float, dt: float, lookahead_m: float = 0.15,
                       arrival_tolerance_m: float = 0.05,
                       steer_gain: float = 2.0) -> tuple[float, float, bool]:
    """Advance one step along `path`. Returns (new_progress_m, frac, done)
    -- `new_progress_m` really is the advanced value (`progress_m +
    speed_mps * dt`, clamped to the path's total length); the caller
    stores it directly, no follow-up arithmetic needed on its end.

    `progress_m` is arc-length already covered so far, tracked by the
    caller (engine.py) across ticks -- this function is otherwise
    stateless. `dt` is the caller's own tick duration (engine.py passes
    `1.0 / TICK_HZ`) -- kept as an explicit parameter rather than a
    constant here so nav.py has zero dependency on engine.py's tick rate;
    a self-check or any other caller can drive this at whatever rate it
    wants by passing its own matching `dt`.

    Steering uses the CURRENT (pre-advance) position -- look ahead from
    where the robot actually is this tick, then advance progress for the
    next call.
    """
    status = sim.pull_status()
    x, y = status.base.xy
    yaw = math.radians(status.base.yaw_deg)

    look_x, look_y = _point_at_arc_length(path, progress_m + lookahead_m)
    bearing = math.atan2(look_y - y, look_x - x)
    heading_error = math.atan2(math.sin(bearing - yaw), math.cos(bearing - yaw))

    sim.drive(v=speed_mps, omega=steer_gain * heading_error)

    total = total_length(path)
    new_progress_m = min(progress_m + speed_mps * dt, total) if total > 0 else 0.0
    frac = min(new_progress_m / total, 1.0) if total > 0 else 1.0
    final_x, final_y = path[-1]
    done = math.hypot(final_x - x, final_y - y) <= arrival_tolerance_m
    return new_progress_m, frac, done


if __name__ == "__main__":
    # ponytail: real MuJoCo, real drive() -- this is the actual
    # integration point. Requires Task 1's scene_corridor.xml.
    import time
    import sys

    _SIM_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "sim"))
    sys.path.insert(0, _SIM_DIR)
    from concierge_sim import DeliveryBotSimulator  # noqa: E402

    def demo():
        model = os.path.join(_SIM_DIR, "scene_corridor.xml")
        loop_sleep_s = 0.05  # this self-check's own wall-clock polling rate --
                              # nav.py has no dependency on engine.py's real
                              # TICK_HZ, any rate works here

        # NOTE on `dt`: measured live (real evidence, not assumed) that this
        # machine's mj_step realtime-pacing loop lags wall-clock -- Task 1's
        # report already flagged ~80% on this machine; a direct measurement
        # here (via status.time deltas across a fixed-tick loop) came out
        # ~0.69-0.77, same phenomenon. Passing a fixed dt=loop_sleep_s to
        # pure_pursuit_step (assuming 1:1 wall-clock/sim-time) makes
        # progress_m's dead-reckoned accumulation (speed_mps * dt per call)
        # run ahead of the robot's real physical position by a growing
        # margin every tick. For the straight-leg room this is benign --
        # `done` is checked against real measured position, not progress_m,
        # so it only costs extra ticks (confirmed: 0803 arrives at ~248
        # ticks, not the 200 a naive 1:1-pacing estimate would budget).
        # For the corner room it is NOT benign: verified with real contact
        # data (mj `data.contact` naming `wall_n_near_b <-> chassis_collision`
        # at xy~(2.59, 0.30)) that the drifted progress_m pulls the
        # lookahead carrot onto the second leg while the robot is still
        # physically inside the narrow near-arm corridor, so it curves in
        # too early and clips the same inside corner Task 1's report
        # diagnosed. Fix verified empirically: measuring the ACTUAL sim-time
        # elapsed per tick (status.time delta) and passing THAT as `dt`
        # keeps progress_m in lockstep with the robot's real physical
        # position (confirmed: progress_m tracks measured x to within
        # ~0.01m through the whole straight leg) -- with this fix, the
        # brief's own default lookahead_m=0.15/steer_gain=2.0 clear the
        # corner with zero wall contacts, so no pure-pursuit retuning was
        # needed once the actual root cause (dt mismatch, not steering law)
        # was found.

        def measured_dt(sim, prev_t):
            cur_t = sim.pull_status().time
            dt = cur_t - prev_t
            return (dt if dt > 0 else loop_sleep_s), cur_t

        # Straight-leg room: no corner, sanity check the basic loop.
        sim = DeliveryBotSimulator(model)
        sim.start(headless=True)
        try:
            path = path_for("0803")
            progress = 0.0
            speed = 0.1
            fracs = []
            prev_t = sim.pull_status().time
            for _ in range(400):  # measured arrival ~248 ticks with real dt;
                                   # 400 gives ~60% margin over that
                dt, prev_t = measured_dt(sim, prev_t)
                progress, frac, done = pure_pursuit_step(sim, path, progress, speed, dt)
                fracs.append(frac)
                if done:
                    break
                time.sleep(loop_sleep_s)
            assert done, "did not arrive at 0803 within the tick budget"
            assert all(b >= a - 1e-9 for a, b in zip(fracs, fracs[1:])), "frac not monotonic"
            print(f"0803 (straight leg): arrived, {len(fracs)} ticks, frac reached {fracs[-1]:.2f}")
        finally:
            sim.stop()

        # Far-arm room: exercises the real 90-degree corner.
        sim = DeliveryBotSimulator(model)
        sim.start(headless=True)
        try:
            path = path_for("1204")
            progress = 0.0
            speed = 0.1
            prev_t = sim.pull_status().time
            for _ in range(1500):  # measured arrival ~1007-1012 ticks with
                                    # real dt; 1500 gives ~40% margin
                dt, prev_t = measured_dt(sim, prev_t)
                progress, frac, done = pure_pursuit_step(sim, path, progress, speed, dt)
                if done:
                    break
                time.sleep(loop_sleep_s)
            assert done, "did not arrive at 1204 (through the corner) within the tick budget"
            print(f"1204 (through the corner): arrived at frac={frac:.2f}")
        finally:
            sim.stop()

        assert total_length(path_for("1204")) > total_length(path_for("0803")), (
            "far-arm room should have a longer real path than a near-arm room"
        )
        print("nav.py self-check OK (straight leg + real corner, both arrive; "
              "far-arm path genuinely longer)")

    demo()
