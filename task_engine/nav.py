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


def _closest_arc_length(path: list[tuple[float, float]], x: float, y: float) -> float:
    """Project the real point (x, y) onto `path`'s polyline; return the
    arc-length coordinate of the closest point on it. This is what makes
    `pure_pursuit_step` immune to any mismatch between an assumed tick
    duration and the sim's real elapsed time -- there is no assumed tick
    duration, progress comes from where the robot actually is."""
    best_s = 0.0
    best_dist = float("inf")
    cumulative = 0.0
    for i in range(len(path) - 1):
        x0, y0 = path[i]
        x1, y1 = path[i + 1]
        seg_len = math.hypot(x1 - x0, y1 - y0)
        if seg_len > 0:
            t = ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / (seg_len ** 2)
            t = max(0.0, min(1.0, t))
            px, py = x0 + t * (x1 - x0), y0 + t * (y1 - y0)
            dist = math.hypot(x - px, y - py)
            if dist < best_dist:
                best_dist = dist
                best_s = cumulative + t * seg_len
        cumulative += seg_len
    return best_s


def pure_pursuit_step(sim, path: list[tuple[float, float]], progress_m: float,
                       speed_mps: float, lookahead_m: float = 0.15,
                       arrival_tolerance_m: float = 0.05,
                       steer_gain: float = 2.0) -> tuple[float, float, bool]:
    """Advance one step along `path`. Returns (new_progress_m, frac, done).

    `new_progress_m` is derived from the robot's REAL measured position
    this call (via `_closest_arc_length`), not dead-reckoned from
    `speed_mps` and an assumed tick duration -- an earlier version of this
    function did dead-reckon (`progress_m + speed_mps * dt`), and Task 2's
    own implementation found a real bug because of it: on a machine where
    `mj_step`'s realtime pacing runs slower than wall-clock (confirmed
    ~70-80% here), a fixed nominal `dt` drifts the dead-reckoned estimate
    ahead of the robot's real position, pulling the lookahead point onto
    the *next* leg of the path while the robot is still physically inside
    the previous corridor segment -- which visibly clips a wall at any
    corner. Deriving progress from real measured position eliminates this
    bug class outright rather than requiring every caller to supply a
    carefully-measured `dt` to avoid it, and it's the more standard
    pure-pursuit technique anyway (project from real position, don't
    integrate an open-loop estimate). `progress_m` is passed in only so a
    caller can still track/expose it (e.g. `pose_frac`) between calls --
    this function does not use the incoming value for anything except as
    the pre-advance value to return if the path is degenerate.

    `speed_mps` still drives the actual motor command (`sim.drive`) --
    only the *progress-tracking* arithmetic changes, not the driving
    speed itself.
    """
    status = sim.pull_status()
    x, y = status.base.xy
    yaw = math.radians(status.base.yaw_deg)

    measured_s = _closest_arc_length(path, x, y)
    new_progress_m = max(progress_m, measured_s)  # never regress from a noisy projection

    look_x, look_y = _point_at_arc_length(path, new_progress_m + lookahead_m)
    bearing = math.atan2(look_y - y, look_x - x)
    heading_error = math.atan2(math.sin(bearing - yaw), math.cos(bearing - yaw))

    sim.drive(v=speed_mps, omega=steer_gain * heading_error)

    total = total_length(path)
    frac = min(new_progress_m / total, 1.0) if total > 0 else 1.0
    final_x, final_y = path[-1]
    done = math.hypot(final_x - x, final_y - y) <= arrival_tolerance_m
    return new_progress_m, frac, done


if __name__ == "__main__":
    # ponytail: real MuJoCo, real drive() -- this is the actual
    # integration point. Requires Task 1's scene_corridor.xml.
    import time
    import sys

    import mujoco

    _SIM_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "sim"))
    sys.path.insert(0, _SIM_DIR)
    from concierge_sim import DeliveryBotSimulator  # noqa: E402

    def demo():
        model = os.path.join(_SIM_DIR, "scene_corridor.xml")
        loop_sleep_s = 0.05  # this self-check's own polling rate -- pure_pursuit_step
                              # has no time-step dependency at all now (progress comes
                              # from real measured position, not dead-reckoning), so
                              # this only paces how often the self-check *checks*, not
                              # anything the navigation math depends on being accurate

        # Straight-leg room: no corner, sanity check the basic loop. Tick
        # budget (400) has real margin over the measured real-physics
        # arrival (~248 ticks at loop_sleep_s=0.05) -- this machine's
        # mj_step runs slower than wall-clock (confirmed ~70-80%, see
        # Task 1's report), so a naive 1:1-pacing estimate (~200) undercounts.
        sim = DeliveryBotSimulator(model)
        sim.start(headless=True)
        try:
            path = path_for("0803")
            progress = 0.0
            speed = 0.1
            fracs = []
            for _ in range(400):
                progress, frac, done = pure_pursuit_step(sim, path, progress, speed)
                fracs.append(frac)
                if done:
                    break
                time.sleep(loop_sleep_s)
            assert done, "did not arrive at 0803 within the tick budget"
            assert all(b >= a - 1e-9 for a, b in zip(fracs, fracs[1:])), "frac not monotonic"
            print(f"0803 (straight leg): arrived, {len(fracs)} ticks, frac reached {fracs[-1]:.2f}")
        finally:
            sim.stop()

        # Far-arm room: exercises the real 90-degree corner. Tick budget
        # (1500) has real margin over the measured real-physics arrival
        # (~1007-1014 ticks) -- this is also the case that would have hit
        # the dead-reckoning bug the redesigned pure_pursuit_step avoids
        # (see this task's docstring/ledger note): with progress derived
        # from real measured position, no wall clipping occurs even
        # though the underlying step rate is the same slower-than-realtime
        # physics that exposed the original bug.
        sim = DeliveryBotSimulator(model)
        sim.start(headless=True)
        try:
            path = path_for("1204")
            progress = 0.0
            speed = 0.1
            wall_hits = []
            for _ in range(1500):
                progress, frac, done = pure_pursuit_step(sim, path, progress, speed)
                # The actual regression test for the dead-reckoning bug this
                # task's design fix exists for: check for a real wall contact
                # every tick, not just narrate it in a report. Direct
                # data/model access (not pull_status()) is read-only in
                # intent, but `sim.data.ncon`/`sim.data.contact` are mutated
                # by the background mj_step thread at every step (MuJoCo
                # resizes the contact array per step, it is not a fixed-size
                # buffer) -- reading them here without the sim's own lock is
                # racy. Confirmed live: an unlocked version of this exact
                # loop raised IndexError *inside* `sim.data.contact[i]`
                # itself (not in mj_id2name) on a real run, reproducibly,
                # because ncon can shrink between reading it and indexing.
                # Snapshot the (geom1, geom2) pairs atomically under the
                # sim's lock (the same lock pull_status() uses internally),
                # then resolve names outside it -- mj_id2name only reads
                # immutable model data, not step-mutated sim data, so it's
                # safe unlocked.
                with sim._lock:
                    contact_pairs = [(c.geom1, c.geom2) for c in sim.data.contact[:sim.data.ncon]]
                for g1, g2 in contact_pairs:
                    name1 = mujoco.mj_id2name(sim.model, mujoco.mjtObj.mjOBJ_GEOM, g1)
                    name2 = mujoco.mj_id2name(sim.model, mujoco.mjtObj.mjOBJ_GEOM, g2)
                    if any(n and n.startswith("wall_") for n in (name1, name2)):
                        wall_hits.append((name1, name2))
                if done:
                    break
                time.sleep(loop_sleep_s)
            assert done, "did not arrive at 1204 (through the corner) within the tick budget"
            assert not wall_hits, f"clipped a wall during the corner drive: {wall_hits[:3]}"
            print(f"1204 (through the corner): arrived at frac={frac:.2f}, zero wall contacts")
        finally:
            sim.stop()

        assert total_length(path_for("1204")) > total_length(path_for("0803")), (
            "far-arm room should have a longer real path than a near-arm room"
        )
        print("nav.py self-check OK (straight leg + real corner, both arrive; "
              "far-arm path genuinely longer)")

    demo()
