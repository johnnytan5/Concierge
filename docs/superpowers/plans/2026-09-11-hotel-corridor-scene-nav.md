# Hotel Corridor Scene + Waypoint Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `task_engine/engine.py`'s straight-line-distance stand-in
with a real hotel corridor MJCF scene and waypoint-based pure-pursuit
navigation, add door-open symmetry at loading (today only happens on
arrival), and add demo-recording-only robot speech at both door-open
moments.

**Architecture:** `sim/scene_corridor.xml` adds real wall/door geometry on
top of `delivery_bot_v2.xml`'s existing checker floor via `<include>`;
`task_engine/nav.py` + `task_engine/waypoints.json` replace the straight-line
math in `engine.py`'s `_advance()`; `task_engine/speech.py` is a new,
demo-only, fire-and-forget `say`-shelling module gated by a `speak` flag
that defaults off in production.

**Tech Stack:** MuJoCo MJCF (existing), Python 3.10 (existing venv), macOS
`say` via `subprocess.Popen` (new, zero pip deps, demo-only).

**Spec:** `docs/superpowers/specs/2026-09-11-hotel-corridor-scene-nav-design.md`

## Global Constraints

- Three separate processes, never violated (`CLAUDE.md` constraint 1) —
  none of this work touches the asyncio event loop that holds the
  AssemblyAI WebSocket.
- Every orchestrator tool handler returns in <100ms (`CLAUDE.md` constraint
  2) — Task 4's ETA computation is a pure in-memory read of a cached JSON
  file, exactly like today's `BASE_ETA_SECONDS` import.
- `drive(v, omega)` takes real m/s/rad-s, already calibrated — `nav.py`
  reuses it exactly, no new calibration.
- Real self-checks against real MuJoCo physics throughout, never mocked —
  this project's established convention, held in every prior task.
- Never print/log secrets (no task here touches any API key, flagged only
  because it's a standing project-wide rule).
- **Correction to the approved spec, discovered while writing this plan:**
  the spec said `delivery_bot_v2.xml` stays fully unchanged. That's true
  for the robot's physics/geometry, but MuJoCo's `mode="track"` camera
  behavior requires a tracking camera to be a *child of the body it
  tracks* — a `<camera>` element cannot be injected into an already-defined
  body from an external file via `<include>` (include only splices content
  at the point it appears, it cannot reach into a named element elsewhere).
  So Task 1 makes one small, additive, backward-compatible change to
  `delivery_bot_v2.xml`: two new `<camera>` children (`chase`, `lid`) on
  the existing `<body name="robot">`. Nothing else in that file changes;
  every existing self-check (physics, door, drive calibration) is
  unaffected. The `top` camera needs no such change — it's a fixed
  world-space camera, added directly in `scene_corridor.xml`.

---

## Task 1: `sim/scene_corridor.xml` — corridor walls, room doors, cameras

**Files:**
- Create: `sim/scene_corridor.xml`
- Modify: `sim/delivery_bot_v2.xml` (add `chase`/`lid` cameras only — see
  Global Constraints correction above)

**Interfaces:**
- Produces: a model file loadable by the existing, unchanged
  `DeliveryBotSimulator(model_path)` — no API change. Camera names `top`,
  `chase`, `lid` — consumed by Task 6's recording script.
- Consumes: nothing from later tasks.

**Layout** (world coordinates, meters; desk/origin at `(0, 0)`, matching
the robot's existing spawn keyframe):

- Near arm: centerline `y = 0`, `x` from `0` to `3.0`. Corridor clear width
  0.6m (walls at `y = ±0.3`).
- Far arm: centerline `x = 3.0`, `y` from `0` to `3.0`. Same 0.6m width
  (walls at `x = 2.7` / `x = 3.3`).
- Junction: the point `(3.0, 0)` where the two centerlines meet — a real
  90° corner, not a smoothed curve (pure-pursuit in Task 2 smooths the
  *driven* path; the *walls* form a sharp corner, like a real hallway).
- Room `0803`: south wall of the near arm, door gap centered `x = 1.0`
  (gap `x: 0.8` to `1.2`).
- Room `0804`: north wall of the near arm, door gap centered `x = 2.0`
  (gap `x: 1.8` to `2.2`) — the near arm's north wall only runs
  `x: -0.1` to `2.7` (it must stop before the junction opens into the far
  arm), so this gap sits safely inside that range.
- Room `1204`: east wall of the far arm, door gap centered `y = 1.0` (gap
  `y: 0.8` to `1.2`).
- Room `1205`: west wall of the far arm, door gap centered `y = 2.0` (gap
  `y: 1.8` to `2.2`) — the far arm's west wall only runs `y: 0.3` to
  `3.3` (must stop where the near arm's region begins), so this gap sits
  safely inside that range.
- North end-cap wall at `y = 3.3` (`x: 2.7` to `3.3`) closes the dead end
  past room 1205. The desk end (`x = -0.1`) is deliberately open — the
  desk is a conceptual start point, not modeled furniture, per the spec's
  non-goals.
- Wall thickness 0.05m, height 1.0m (robot's tallest point is ~0.87m —
  see `delivery_bot_v2.xml`'s `tower_collision`, so 1.0m clears it with
  margin). Corridor width 0.6m against the robot's ~0.34m footprint
  (`tower_collision` radius 0.17m ×2) leaves ~0.13m clearance per side —
  confirmed by Step 4's drive-through check, not just assumed.

- [ ] **Step 1: Add `chase`/`lid` cameras to `delivery_bot_v2.xml`**

Add these two lines as children of the existing `<body name="robot">`,
right after the existing `<site name="base_imu" .../>` line (still inside
that body, before its closing `</body>`):

```xml
      <!-- Demo-recording cameras (Days 8-14 corridor work). Both track
           this body's position; "chase" follows from behind/beside for
           the corridor drive, "lid" frames close on the door mechanism
           (local y=-0.17, the -y side where lid_top/lid_bottom sit) so
           it stays correctly framed at both open moments (desk, room)
           without retargeting. Starting values, empirically verified in
           Step 4 below -- MuJoCo camera axis convention (look down local
           -z) is exactly the kind of thing this project verifies rather
           than assumes, same as drive()'s ctrl-to-velocity ratio. -->
      <camera name="chase" mode="track" pos="-0.8 0.5 0.6" xyaxes="-0.5 -0.87 0  0.3 -0.17 0.94"/>
      <camera name="lid" mode="track" pos="0 -0.7 0.4" xyaxes="-1 0 0  0 0.3 0.95"/>
```

- [ ] **Step 2: Write `sim/scene_corridor.xml`**

```xml
<mujoco model="concierge_hotel_corridor">
  <!--
    Adds real corridor geometry on top of delivery_bot_v2.xml's existing
    checker floor (that floor is a 6x6m plane centered at the origin --
    already big enough to cover this corridor's ~3.4m x 3.4m footprint,
    so there's no floor to replace here, only walls/doors/cameras to add).
    See sim/delivery_bot_v2.xml for the robot model itself, unchanged
    except for the two camera additions in Task 1 Step 1.
  -->
  <include file="delivery_bot_v2.xml"/>

  <asset>
    <material name="wall_paint" rgba="0.85 0.83 0.78 1"/>
    <material name="door_panel" rgba="0.55 0.35 0.2 1"/>
  </asset>

  <worldbody>
    <!-- Fixed top-down camera: bird's-eye over the whole floor plan.
         xyaxes="1 0 0  0 1 0" -> local z = world +z -> camera looks
         straight down (MuJoCo cameras look down local -z). Empirically
         verify in Step 4, adjust height/xyaxes if the framing is off. -->
    <camera name="top" mode="fixed" pos="1.5 1.5 6" xyaxes="1 0 0  0 1 0"/>

    <!-- ============ Near arm (desk -> junction), centerline y=0 ============ -->

    <!-- South wall (y=-0.3 inner face), broken by room 0803's door gap
         (x: 0.8 to 1.2) -->
    <geom name="wall_s_near_a" type="box" pos="0.35 -0.325 0.5" size="0.45 0.025 0.5" material="wall_paint"/>
    <geom name="wall_s_near_b" type="box" pos="2.25 -0.325 0.5" size="1.05 0.025 0.5" material="wall_paint"/>
    <geom name="0803" type="box" pos="1.0 -0.325 0.5" size="0.2 0.025 0.5" material="door_panel"/>

    <!-- North wall (y=+0.3 inner face), runs only to x=2.7 (must stop
         where the far arm's corridor opens up), broken by 0804's gap -->
    <geom name="wall_n_near_a" type="box" pos="0.85 0.325 0.5" size="0.95 0.025 0.5" material="wall_paint"/>
    <geom name="wall_n_near_b" type="box" pos="2.45 0.325 0.5" size="0.25 0.025 0.5" material="wall_paint"/>
    <geom name="0804" type="box" pos="2.0 0.325 0.5" size="0.2 0.025 0.5" material="door_panel"/>

    <!-- ============ Far arm (junction -> dead end), centerline x=3.0 ============ -->

    <!-- East wall (x=+3.3 inner face), broken by room 1204's door gap -->
    <geom name="wall_e_far_a" type="box" pos="3.325 0.35 0.5" size="0.025 0.45 0.5" material="wall_paint"/>
    <geom name="wall_e_far_b" type="box" pos="3.325 2.25 0.5" size="0.025 1.05 0.5" material="wall_paint"/>
    <geom name="1204" type="box" pos="3.325 1.0 0.5" size="0.025 0.2 0.5" material="door_panel"/>

    <!-- West wall (x=+2.7 inner face), runs only from y=0.3 (must stop
         where the near arm's corridor opens up), broken by 1205's gap -->
    <geom name="wall_w_far_a" type="box" pos="2.675 1.05 0.5" size="0.025 0.75 0.5" material="wall_paint"/>
    <geom name="wall_w_far_b" type="box" pos="2.675 2.75 0.5" size="0.025 0.55 0.5" material="wall_paint"/>
    <geom name="1205" type="box" pos="2.675 2.0 0.5" size="0.025 0.2 0.5" material="wall_paint"/>

    <!-- Dead-end cap past room 1205 -->
    <geom name="wall_end_far" type="box" pos="3.0 3.325 0.5" size="0.3 0.025 0.5" material="wall_paint"/>
  </worldbody>
</mujoco>
```

- [ ] **Step 3: Verify the model loads and the robot spawns correctly**

```bash
.venv/bin/python -c "
from sim.concierge_sim import DeliveryBotSimulator
sim = DeliveryBotSimulator('sim/scene_corridor.xml')
sim.start(headless=True)
status = sim.pull_status()
print('spawn position:', status.base.xy)
assert status.base.xy == (0.0, 0.0), status.base.xy
sim.stop()
print('scene_corridor.xml loads OK, robot spawns at the desk origin')
"
```

Expected: no MuJoCo compile errors (a wall/door overlap or a bad
`<include>` reference raises immediately here), spawn position `(0.0,
0.0)`.

- [ ] **Step 4: Drive-through check — confirm the robot doesn't clip walls at the turn, empirically verify the three cameras**

This is a real, physical check, not a proxy — drive the robot along the
*intended* route by hand (straight legs + an explicit turn), through the
narrowest part of the layout (the junction), and confirm it doesn't get
stuck or visibly clip:

```bash
.venv/bin/python -c "
import time
from sim.concierge_sim import DeliveryBotSimulator

sim = DeliveryBotSimulator('sim/scene_corridor.xml')
sim.start(headless=False)  # viewer open -- also eyeball the 3 cameras here
try:
    sim.drive(v=0.12, omega=0.0)
    time.sleep(25)  # ~3m near arm at 0.12 m/s
    sim.drive(v=0.0, omega=0.4)
    time.sleep(4)   # turn ~90 degrees in place at the junction
    sim.drive(v=0.12, omega=0.0)
    time.sleep(25)  # ~3m far arm
    sim.stop_base()
    status = sim.pull_status()
    print('final position:', status.base.xy)
    assert status.base.xy[0] > 2.5 and status.base.xy[1] > 2.5, status.base.xy
finally:
    sim.stop()
"
```

While the viewer is open, manually cycle cameras (MuJoCo viewer: `[`/`]`
or the camera dropdown) to `top`, `chase`, and `lid` and confirm each
shows a sensible view (top: whole floor plan from above; chase: robot
from behind/beside as it drives; lid: framed close on the door area).
**If any camera's framing is wrong, adjust its `pos`/`xyaxes` values and
re-run this step** — these starting values are a reasoned guess, not a
verified fit, exactly like every other empirically-tuned constant in this
project (`CTRL_PER_MPS`, the door `kp`/`kv` values). Do not proceed to
Task 2 until the robot visibly clears the turn without clipping and all
three cameras look right.

- [ ] **Step 5: Commit**

```bash
git add sim/scene_corridor.xml sim/delivery_bot_v2.xml
git commit -m "Add sim/scene_corridor.xml: hotel corridor MJCF (L-shaped, 4 rooms, 3 cameras)

Includes delivery_bot_v2.xml (reusing its existing checker floor -- already
big enough, no floor to replace) and adds real wall/door geometry: near arm
(desk to junction, rooms 0803/0804) and far arm (junction to dead end,
rooms 1204/1205), 0.6m corridor width against the robot's ~0.34m footprint.
Also adds chase/lid cameras to delivery_bot_v2.xml itself -- MuJoCo's
mode=\"track\" requires the camera to be a child of the body it tracks,
which <include> can't inject into an already-defined body from outside;
this is the one small, additive, backward-compatible exception to the
design's original 'delivery_bot_v2.xml stays unchanged' framing, flagged
explicitly in this plan's Global Constraints. Verified live: robot spawns
at the desk origin, drives the full near-arm/turn/far-arm route without
clipping, all three named cameras (top/chase/lid) visually confirmed in
the viewer.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 2: `task_engine/waypoints.json` + `task_engine/nav.py`

**Files:**
- Create: `task_engine/waypoints.json`
- Create: `task_engine/nav.py`

**Interfaces:**
- Consumes: `sim.pull_status()` → `BaseStatus(xy, yaw_deg, ...)`,
  `sim.drive(v, omega)` — both from `sim/concierge_sim.py`, unchanged.
- Produces: `path_for(room: str) -> list[tuple[float, float]]`,
  `total_length(path: list[tuple[float, float]]) -> float`,
  `pure_pursuit_step(sim, path, progress_m, speed_mps, dt, lookahead_m=0.15,
  arrival_tolerance_m=0.05) -> tuple[float, float, bool]` — returns the
  already-advanced `new_progress_m` (the caller stores it directly, no
  follow-up arithmetic), plus `frac, done`. Consumed by Task 3
  (`engine.py`) and Task 4 (`tools.py`, `total_length` only, for ETA).

- [ ] **Step 1: Write `task_engine/waypoints.json`**

Coordinates match Task 1's actual wall/door geometry exactly (door-gap
centers, and the junction point `(3.0, 0)` for far-arm rooms):

```json
{
  "0803": [[0, 0], [1.0, 0]],
  "0804": [[0, 0], [2.0, 0]],
  "1204": [[0, 0], [3.0, 0], [3.0, 1.0]],
  "1205": [[0, 0], [3.0, 0], [3.0, 2.0]]
}
```

- [ ] **Step 2: Write `task_engine/nav.py`**

```python
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
        dt = 0.05  # this self-check's own loop rate -- nav.py has no
                    # dependency on engine.py's real TICK_HZ, any dt works
                    # as long as it matches the actual sleep below

        # Straight-leg room: no corner, sanity check the basic loop.
        sim = DeliveryBotSimulator(model)
        sim.start(headless=True)
        try:
            path = path_for("0803")
            progress = 0.0
            speed = 0.1
            fracs = []
            for _ in range(200):
                progress, frac, done = pure_pursuit_step(sim, path, progress, speed, dt)
                fracs.append(frac)
                if done:
                    break
                time.sleep(dt)
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
            for _ in range(400):
                progress, frac, done = pure_pursuit_step(sim, path, progress, speed, dt)
                if done:
                    break
                time.sleep(dt)
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
```

- [ ] **Step 3: Run the self-check**

```bash
.venv/bin/python task_engine/nav.py
```

Expected: both room drives report `arrived`, ending with `nav.py self-check
OK ...`. **If the corner drive doesn't arrive within the tick budget, or
the robot's `yaw`/position readout suggests it clipped a wall (check
against Task 1's wall coordinates), tune `lookahead_m`/`steer_gain` here**
— this is the pure-pursuit tuning risk the spec flagged explicitly, and
this self-check is exactly the place to catch it, not the demo recording.

- [ ] **Step 4: Commit**

```bash
git add task_engine/waypoints.json task_engine/nav.py
git commit -m "Add task_engine/nav.py + waypoints.json: hand-authored per-room paths, pure pursuit

path_for()/total_length() read the static JSON (no pathfinding -- the
file IS the route, per the spec's non-goals). pure_pursuit_step() reuses
drive()'s already-calibrated m/s/rad-s contract exactly, closing the loop
every call off measured heading error from sim.pull_status(). Verified
live with real physics: a straight-leg room (0803) and a room through the
real 90-degree corner (1204) both arrive within tolerance, frac increases
monotonically, and the far-arm room's real path length is genuinely
longer than the near-arm one's.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 3: Wire `nav.py` into `engine.py`, add door-open symmetry

**Files:**
- Modify: `task_engine/engine.py`

**Interfaces:**
- Consumes: `nav.path_for`, `nav.total_length`, `nav.pure_pursuit_step`
  (Task 2).
- Produces: no interface change to `run(cmd_queue, state)` or the
  `state["tasks"]`/`state["robots"]` shape — `pose_frac`'s 0→1 semantics
  are preserved, just computed differently. Task 4 depends on
  `nav.total_length` directly (not on anything new in `engine.py`).

- [ ] **Step 1: Point `MODEL_PATH` at the corridor scene**

In `task_engine/engine.py`, change:

```python
MODEL_PATH = os.path.join(_SIM_DIR, "delivery_bot_v2.xml")
```

to:

```python
MODEL_PATH = os.path.join(_SIM_DIR, "scene_corridor.xml")
```

- [ ] **Step 2: Import `nav`, replace the straight-line task fields**

Add, right after the existing `import supabase_sync` block:

```python
import nav
```

Change `_new_task`'s `eta_seconds` field (currently
`"eta_seconds": BASE_ETA_SECONDS`) to compute a real per-room value:

```python
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
        "progress_m": 0.0,   # arc length covered along nav.path_for(room), reset each leg
        "eta_seconds": nav.total_length(nav.path_for(room)) / DRIVE_SPEED_MPS,
        "announced": False,
        "reason": None,
        "speech_done_collecting": False,
        "speech_done_arrived": False,
    }
```

(`speech_done_*` fields are added here, in this task, even though
`speech.py` doesn't exist until Task 5 — they default to `False` and are
simply unread until Task 5 wires them up, same as how this file's
existing fields are all always present regardless of which phase actually
uses them.)

- [ ] **Step 3: Replace `_dist_from_origin`/`_drive_home`'s straight-line math**

Delete `_dist_from_origin` entirely (nothing needs raw distance-from-origin
once paths are per-room). Replace `_drive_home` with a version that drives
the room's own path *backward* (from the room's door back to the desk) via
the same `pure_pursuit_step`, by reversing the path once:

```python
def _drive_home(sim, task, now, terminal_phase, drive_speed, arrival_tolerance_m):
    sim.close_door()  # idempotent ctrl target; covers a recall straight out of ARRIVED
    path = list(reversed(nav.path_for(task["room"])))
    task["progress_m"], _, done = nav.pure_pursuit_step(
        sim, path, task["progress_m"], drive_speed, 1.0 / TICK_HZ,
        arrival_tolerance_m=arrival_tolerance_m)
    total = nav.total_length(path)
    frac = 1.0 - min(task["progress_m"] / total, 1.0) if total > 0 else 0.0  # walks 1 -> 0 on the way home
    if done:
        sim.stop_base()
        task["phase"] = terminal_phase
    return task, frac
```

Replace `_advance`'s `EN_ROUTE` branch:

```python
    if task["phase"] == "EN_ROUTE":
        path = nav.path_for(task["room"])
        task["progress_m"], frac, done = nav.pure_pursuit_step(
            sim, path, task["progress_m"], drive_speed, 1.0 / TICK_HZ,
            arrival_tolerance_m=arrival_tolerance_m)
        if done:
            sim.stop_base()
            sim.open_door()
            task["phase"] = "ARRIVED"
            task["arrived_at"] = now
        return task, frac
```

And update the two remaining call sites (`RETURNING`, `RECALLED`) to drop
the now-removed `trip_meters` argument:

```python
    if task["phase"] == "RETURNING":
        return _drive_home(sim, task, now, "DONE", drive_speed, arrival_tolerance_m)

    if task["phase"] == "RECALLED":
        return _drive_home(sim, task, now, "AT_DESK", drive_speed, arrival_tolerance_m)
```

Update `_advance`'s own signature to drop `trip_meters` (no longer
meaningful — path length now comes from `nav.path_for`, not a caller-passed
constant):

```python
def _advance(sim: DeliveryBotSimulator, task, now, confirmed: bool = False,
             drive_speed: float = DRIVE_SPEED_MPS,
             arrival_tolerance_m: float = 0.05):
```

**Re-anchor `progress_m` at every point where the direction of travel
flips** — this is not a simple reset to `0.0`. `_drive_home` walks the
*reversed* path, and a reversed path's arc length from ITS start equals
`total_length(original_path) - <arc length already covered on the
original path>`. For a `RETURNING` transition (guest confirmed collection
— the robot has genuinely finished the outbound path, `progress_m` already
equals the total), this formula happens to reduce to `0.0`, matching
intuition. But for a `RECALLED` transition (voice recall *mid-EN_ROUTE* —
the robot is only partway there), it does **not** reduce to `0.0`: the
robot is physically somewhere in the middle of the corridor, and the
reversed path's progress needs to reflect that, or pure pursuit's
lookahead would aim at a point near the *original* path's far end (the
room door) instead of back toward the desk — steering the wrong way. Use
the same general formula at both transition points, in `_advance`'s
`ARRIVED` branch:

```python
    if task["phase"] == "ARRIVED":
        if confirmed:
            sim.close_door()
            total = nav.total_length(nav.path_for(task["room"]))
            task["progress_m"] = total - task["progress_m"]
            task["phase"] = "RETURNING"
        return task, 1.0
```

and in `_handle`'s `recall` branch, at **both** the `EN_ROUTE` and
`ARRIVED` cases — these are two separate code locations from `_advance`'s
own `ARRIVED` branch above (that one fires on *guest-confirmed* collection;
these fire on a *voice recall*), so the re-anchor has to be added in both
places independently, not inherited from one by the other:

```python
        elif phase == "EN_ROUTE":
            total = nav.total_length(nav.path_for(t["room"]))
            t["progress_m"] = total - t["progress_m"]
            t["phase"] = "RECALLED"
            t["dispatched_at"] = time.time()
        elif phase == "ARRIVED":
            total = nav.total_length(nav.path_for(t["room"]))
            t["progress_m"] = total - t["progress_m"]
            t["phase"] = "RETURNING"  # _drive_home closes the door on the way
```

(`QUEUED`/`COLLECTING` → `AT_DESK` doesn't touch `progress_m` — the robot
never left the desk, so there's no outbound progress to re-anchor. For
the `EN_ROUTE` case the formula computes a genuine partial value; for the
`ARRIVED` case it reduces to `0.0` since `progress_m` already equals
`total` there — same reasoning as `_advance`'s `ARRIVED` branch, computed
independently because it's separate code, not shared.)

- [ ] **Step 4: Door-open symmetry at `COLLECTING`**

Replace `_advance`'s `COLLECTING` branch:

```python
    if task["phase"] == "COLLECTING":
        sim.open_door()  # idempotent ctrl target -- safe every tick, matches close_door()'s pattern
        if confirmed:
            sim.close_door()
            task["phase"] = "EN_ROUTE"
            task["dispatched_at"] = now
        return task, 0.0
```

- [ ] **Step 5: Update the module docstring's `ponytail:` note**

Replace the module docstring's second paragraph (the one starting
`ponytail: there's no real corridor/waypoint graph yet...`) — this is no
longer true and should say so plainly:

```python
Real corridor navigation: "desk to room" is a hand-authored waypoint path
per room (task_engine/waypoints.json), followed via pure pursuit
(task_engine/nav.py) -- see docs/superpowers/specs/2026-09-11-hotel-
corridor-scene-nav-design.md for the full design. The phase/state contract
below is unchanged from the straight-line-distance version it replaced.
```

- [ ] **Step 6: Update the self-check for real corridor distances**

The existing `if __name__ == "__main__": demo()` self-check dispatches to
made-up rooms (`"1204"`, `"0803"`, `"1500"`, `"1501"`) with a tiny
`trip_meters=0.05` override that no longer exists as a parameter. Replace
the whole `demo()` function body's dispatch/drive section to use the four
real rooms directly (their real path lengths are already short — 1.0m to
5.0m — so no `trip_meters` override is needed at all, just a faster
`drive_speed` so the self-check doesn't take minutes):

```python
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

            for _ in range(400):
                tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                tasks["t2"], _ = _advance(sims["robot_2"], tasks["t2"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t1"]["phase"] == "ARRIVED" and tasks["t2"]["phase"] == "ARRIVED":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "ARRIVED", tasks["t1"]
            assert tasks["t2"]["phase"] == "ARRIVED", tasks["t2"]

            # complete_collection -> RETURNING -> drive home -> DONE
            tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(), confirmed=True,
                                        drive_speed=speed, arrival_tolerance_m=tol_m)
            assert tasks["t1"]["phase"] == "RETURNING"
            for _ in range(400):
                tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t1"]["phase"] == "DONE":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "DONE", tasks["t1"]

            # recall while still COLLECTING -> immediate AT_DESK, no motion
            _handle({"cmd": "dispatch", "task_id": "t3", "room": "0804", "items": ["towel"]}, tasks)
            tasks["t3"]["phase"] = "COLLECTING"
            _handle({"cmd": "recall", "task_id": "t3", "reason": "guest changed mind"}, tasks)
            assert tasks["t3"]["phase"] == "AT_DESK", tasks["t3"]

            # recall MID-EN_ROUTE (the case the progress_m re-anchor formula
            # exists for -- without it, pure pursuit would aim the reversed
            # path's lookahead at the room door instead of back toward the
            # desk). robot_1 is free again (t1 finished above).
            _handle({"cmd": "dispatch", "task_id": "t4", "room": "1205", "items": ["towel"]}, tasks)
            tasks["t4"]["phase"] = "COLLECTING"
            tasks["t4"], _ = _advance(sims["robot_1"], tasks["t4"], time.time(), confirmed=True,
                                        drive_speed=speed, arrival_tolerance_m=tol_m)
            for _ in range(30):  # partway through the near arm, well before the junction
                tasks["t4"], _ = _advance(sims["robot_1"], tasks["t4"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                time.sleep(0.05)
            assert tasks["t4"]["phase"] == "EN_ROUTE", tasks["t4"]
            pos_before_recall = sims["robot_1"].pull_status().base.xy
            _handle({"cmd": "recall", "task_id": "t4", "reason": "wrong room number"}, tasks)
            assert tasks["t4"]["phase"] == "RECALLED", tasks["t4"]
            for _ in range(30):  # a few ticks back toward the desk
                tasks["t4"], _ = _advance(sims["robot_1"], tasks["t4"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                time.sleep(0.05)
            pos_after_recall = sims["robot_1"].pull_status().base.xy
            dist_before = (pos_before_recall[0] ** 2 + pos_before_recall[1] ** 2) ** 0.5
            dist_after = (pos_after_recall[0] ** 2 + pos_after_recall[1] ** 2) ** 0.5
            assert dist_after < dist_before, (
                "recall mid-EN_ROUTE should steer back toward the desk (distance from "
                "origin decreasing), not toward the room -- progress_m re-anchor is wrong if "
                "this fails", pos_before_recall, pos_after_recall)
            for _ in range(400):
                tasks["t4"], _ = _advance(sims["robot_1"], tasks["t4"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t4"]["phase"] == "DONE":
                    break
                time.sleep(0.05)
            assert tasks["t4"]["phase"] == "DONE", tasks["t4"]

            # recall while ARRIVED (nobody came to the door) -> drives home
            assert tasks["t2"]["phase"] == "ARRIVED"
            _handle({"cmd": "recall", "task_id": "t2", "reason": "guest not answering"}, tasks)
            assert tasks["t2"]["phase"] == "RETURNING", tasks["t2"]
            for _ in range(400):
                tasks["t2"], _ = _advance(sims["robot_2"], tasks["t2"], time.time(),
                                            drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t2"]["phase"] == "DONE":
                    break
                time.sleep(0.05)
            assert tasks["t2"]["phase"] == "DONE", tasks["t2"]
            door = sims["robot_2"].pull_status().door
            print(f"robot_2 door after recall-from-ARRIVED: {door}")

            print("engine self-check OK (real corridor scene: near-arm + far-arm "
                  "rooms through the real corner, differing per-room ETA, "
                  "door-open symmetry, recall from COLLECTING/EN_ROUTE/ARRIVED "
                  "-- including the mid-EN_ROUTE progress_m re-anchor)")
        finally:
            for sim in sims.values():
                sim.stop()

    demo()
```

- [ ] **Step 7: Run the self-check**

```bash
.venv/bin/python task_engine/engine.py
```

Expected: `engine self-check OK ...`, both ETA and door-open-symmetry
assertions pass.

- [ ] **Step 8: Commit**

```bash
git add task_engine/engine.py
git commit -m "engine.py: wire nav.py's pure pursuit in, add door-open symmetry at COLLECTING

MODEL_PATH now points at scene_corridor.xml. _dist_from_origin/the old
_drive_home's straight-line math are gone -- EN_ROUTE/RETURNING/RECALLED
now call nav.pure_pursuit_step() over nav.path_for(task['room']), tracked
via a new per-task progress_m field. Per-room eta_seconds replaces the
single BASE_ETA_SECONDS constant. sim.open_door() now fires every tick
while COLLECTING (idempotent, same pattern as close_door()), mirroring the
existing ARRIVED open/close symmetry -- previously the door only ever
opened on arrival.

Every point where travel direction flips re-anchors progress_m to
total_length(path) - progress_m before switching to the reversed path --
not a plain reset to 0. For a recall from ARRIVED (or guest-confirmed
collection) that reduces to 0 since progress_m already equals the total,
but a recall mid-EN_ROUTE needs the real partial value, or pure pursuit's
lookahead aims at the room door instead of back toward the desk. Verified
live: two robots to a near-arm and a far-arm room (through the real
90-degree corner) both arrive, far-arm ETA is genuinely longer,
door-open-at-loading confirmed; recall from COLLECTING, mid-EN_ROUTE (the
re-anchor's own test -- asserts distance-from-desk actually decreases
after recall, not just that the phase flag changed), and ARRIVED all
correctly return the robot home.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 4: `orchestrator/tools.py` — per-room ETA

**Files:**
- Modify: `orchestrator/tools.py`

**Interfaces:**
- Consumes: `nav.total_length`, `nav.path_for` (Task 2).
- Produces: no shape change to `dispatch_delivery`'s return value
  (`task_id, eta_seconds, dispatched_items[], unavailable_items[]`), only
  a different `eta_seconds` source. `check_delivery_status`'s
  `eta_seconds` field (computed from `t["eta_seconds"]`, already a task
  field per Task 3) needs no change here.

- [ ] **Step 1: Swap the ETA import and computation**

Change the top-of-file import from:

```python
from task_engine.engine import BASE_ETA_SECONDS
```

to:

```python
from task_engine import nav
from task_engine.engine import DRIVE_SPEED_MPS
```

Change `dispatch_delivery`'s return statement from:

```python
        return {"task_id": task_id, "eta_seconds": BASE_ETA_SECONDS,
                "dispatched_items": dispatched, "unavailable_items": unavailable}
```

to:

```python
        eta_seconds = nav.total_length(nav.path_for(room)) / DRIVE_SPEED_MPS
        return {"task_id": task_id, "eta_seconds": eta_seconds,
                "dispatched_items": dispatched, "unavailable_items": unavailable}
```

(Same pattern already in place today — a plain Python import from
`task_engine`, not a live cross-process call. This computation is a
static-JSON read, well under the <100ms handler budget.)

- [ ] **Step 2: Update the self-check for differing per-room ETA**

The existing `if __name__ == "__main__": demo()` self-check dispatches
against a fake inventory cache and asserts on the returned shape. Add one
assertion right after the existing `dispatch_delivery` call that checks
`eta_seconds` for two different real rooms differs and is proportional to
path length:

```python
        result_near = h.dispatch_delivery(room="0803", items=["towel"])
        result_far = h.dispatch_delivery(room="1204", items=["towel"])
        assert result_far["eta_seconds"] > result_near["eta_seconds"], (
            "1204 (far arm, through the corner) should report a longer ETA than 0803 (near arm)",
            result_far["eta_seconds"], result_near["eta_seconds"])
```

(Insert this alongside the existing `dispatch_delivery` assertions in the
self-check — exact insertion point is wherever the existing self-check
already calls `dispatch_delivery` and checks its return shape; add this
as an additional call+assertion there, don't replace the existing checks.)

- [ ] **Step 3: Run the self-check**

```bash
.venv/bin/python -m orchestrator.tools
```

Expected: `tools self-check OK`, including the new ETA-differs assertion.

- [ ] **Step 4: Commit**

```bash
git add orchestrator/tools.py
git commit -m "tools.py: dispatch_delivery reports real per-room ETA, not a shared constant

Same import pattern as before (plain Python import from task_engine, not
a live cross-process call -- still well under the <100ms handler budget,
just a static-JSON read via nav.total_length/nav.path_for instead of a
single BASE_ETA_SECONDS constant). Verified live: 1204 (far arm, through
the real corner) reports a longer ETA than 0803 (near arm) -- previously
both would have reported the identical constant, which becomes a real lie
once rooms have genuinely different distances.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 5: `task_engine/speech.py` — robot speech at both door-open moments

**Files:**
- Create: `task_engine/speech.py`
- Modify: `task_engine/engine.py`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `announce(text: str)`. Consumed by `engine.py`'s `_advance()`
  (this task) and Task 6's recording script (which turns `speak=True` on).

- [ ] **Step 1: Write `task_engine/speech.py`**

```python
"""Robot speech -- demo-recording only, never in production. Distinct
from orchestrator/tools.py's announce_arrival tool: that's the voice agent
telling the GUEST, over the phone, that a delivery arrived (LLM-triggered,
conversational). This is the ROBOT ITSELF speaking out loud, automatically,
tied directly to the FSM's door-open transitions -- for whoever is
physically standing at the robot (front-desk worker loading it, guest
collecting from it), not for the phone call.

engine.run()'s `speak` parameter defaults False; production's spawned
multiprocessing.Process never passes speak=True. Only a demo-recording
entry point turns this on. See docs/superpowers/specs/2026-09-11-hotel-
corridor-scene-nav-design.md's "Robot speech" section.
"""
import subprocess
import sys


def announce(text: str):
    """Fire-and-forget: never blocks the caller. `say` takes multiple
    seconds to finish a sentence, and this is called from inside
    engine.py's 5Hz tick loop shared by both robots' physics stepping --
    subprocess.run would freeze both robots' simulation for the duration
    of the sentence. Popen fires it and returns immediately, same
    fire-and-forget spirit as this project's existing Supabase writes."""
    if sys.platform == "darwin":
        subprocess.Popen(["say", text])
    else:
        print(f"[speech, no 'say' on this platform] {text}")


if __name__ == "__main__":
    # ponytail: real subprocess, not mocked -- confirms Popen returns
    # near-instantly (the whole point over subprocess.run) and the
    # non-macOS fallback path doesn't raise.
    import time

    def demo():
        t0 = time.perf_counter()
        announce("Speech self check.")
        elapsed = time.perf_counter() - t0
        assert elapsed < 0.5, f"announce() took {elapsed:.2f}s -- Popen should return near-instantly"
        print(f"announce() returned in {elapsed*1000:.0f}ms (real subprocess launch, not the "
              f"sentence's full speaking time) -- speech.py self-check OK")

    demo()
```

- [ ] **Step 2: Wire `speak` into `engine.py`**

Add a module-level import at the top of `task_engine/engine.py` (near the
existing `import nav`):

```python
import speech
```

Change `run()`'s signature to accept the new flag:

```python
def run(cmd_queue, state, speak: bool = False):
```

In `_advance()`'s `COLLECTING` branch (from Task 3 Step 4), add the
one-shot loading announcement — this needs the task's own `items`/`room`,
so pass `speak` through as an `_advance()` parameter too:

```python
def _advance(sim: DeliveryBotSimulator, task, now, confirmed: bool = False,
             drive_speed: float = DRIVE_SPEED_MPS,
             arrival_tolerance_m: float = 0.05,
             speak: bool = False):
    if task["phase"] == "COLLECTING":
        sim.open_door()
        if speak and not task["speech_done_collecting"]:
            speech.announce(f"Please load: {', '.join(task['items'])} for room {task['room']}.")
            task["speech_done_collecting"] = True
        if confirmed:
            sim.close_door()
            task["phase"] = "EN_ROUTE"
            task["dispatched_at"] = now
        return task, 0.0
```

And in the `EN_ROUTE` branch, right where it transitions to `ARRIVED`:

```python
        if done:
            sim.stop_base()
            sim.open_door()
            task["phase"] = "ARRIVED"
            task["arrived_at"] = now
```

add the arrival announcement immediately after — since this fires exactly
once, on the tick the transition happens (not gated by `speech_done_arrived`
being checked every tick like `COLLECTING`'s open_door() is, because this
branch itself only runs this assignment once, on the transition tick):

```python
        if done:
            sim.stop_base()
            sim.open_door()
            task["phase"] = "ARRIVED"
            task["arrived_at"] = now
            if speak:
                speech.announce(f"Delivery for room {task['room']} has arrived. Please collect your items.")
            task["speech_done_arrived"] = True
```

Finally, thread `speak` through from `run()`'s loop to every `_advance()`
call site (the single call inside `run()`'s main loop):

```python
                tasks[tid], frac = _advance(sims[rid], tasks[tid], now, confirmed[rid], speak=speak)
```

- [ ] **Step 3: Test the one-shot guard specifically**

The real risk here (per the spec's Risks section) is the guard firing
every tick instead of once. Add a throwaway check (not committed) that
holds a task in `COLLECTING` for several ticks and counts how many times
`speech.announce` would have fired:

```bash
.venv/bin/python -c "
import time
from unittest.mock import patch
from task_engine.engine import _advance, _new_task, _handle

tasks = {}
_handle({'cmd': 'dispatch', 'task_id': 't1', 'room': '0803', 'items': ['towel']}, tasks)
tasks['t1']['phase'] = 'COLLECTING'

calls = []
with patch('task_engine.speech.announce', side_effect=lambda text: calls.append(text)):
    from sim.concierge_sim import DeliveryBotSimulator
    sim = DeliveryBotSimulator('sim/scene_corridor.xml')
    sim.start(headless=True)
    try:
        for _ in range(10):  # 10 ticks, still COLLECTING, not confirmed
            tasks['t1'], _ = _advance(sim, tasks['t1'], time.time(), confirmed=False, speak=True)
            time.sleep(0.05)
    finally:
        sim.stop()

assert len(calls) == 1, f'expected exactly 1 announce() call across 10 ticks, got {len(calls)}: {calls}'
print('one-shot guard OK:', calls[0])
"
```

Expected: `one-shot guard OK: Please load: towel for room 0803.` — exactly
one call despite 10 ticks.

- [ ] **Step 4: Run `speech.py`'s own self-check and the full `engine.py` self-check**

```bash
.venv/bin/python task_engine/speech.py
.venv/bin/python task_engine/engine.py
```

Expected: both pass (the `engine.py` self-check from Task 3 doesn't pass
`speak=True`, so it should still pass unchanged — confirming `speak`
defaulting `False` doesn't alter existing behavior).

- [ ] **Step 5: Commit**

```bash
git add task_engine/speech.py task_engine/engine.py
git commit -m "Add task_engine/speech.py: robot speech at both door-open moments (demo-only)

Distinct from the existing announce_arrival tool (guest-facing, phone,
LLM-triggered) -- this is the robot's own physical voice, automatic, tied
to the FSM's door-open transitions. Popen, not run, since 'say' takes
multiple seconds and _advance() runs inside the shared 5Hz physics tick.
speak defaults False everywhere; production's engine.run() invocation
never turns it on. Verified live: Popen returns near-instantly (not the
sentence's real speaking time), the one-shot guard fires exactly once
across 10 ticks of a held COLLECTING phase (not once per tick), and the
existing engine.py self-check still passes unchanged with speak defaulting
off.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 6: Demo recording script + live end-to-end check

**Files:**
- Create: `sim/record_demo.py`

**Interfaces:** none — this is a leaf script, not imported by anything.

- [ ] **Step 1: Write `sim/record_demo.py`**

```python
"""Demo-recording entry point: runs one real robot through a real
dispatch (corridor scene, speech on, viewer open) so the result is
recordable on camera. NOT part of production -- orchestrator/agent.py's
spawned task_engine.engine.run() call never passes speak=True or
headless=False; this script is a standalone alternative entry point for
making the submission video, per docs/superpowers/specs/2026-09-11-hotel-
corridor-scene-nav-design.md's "Robot speech" section.

Run from the repo root: .venv/bin/python sim/record_demo.py
"""
import os
import sys
import time

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _REPO_ROOT)

from task_engine.engine import _advance, _handle  # noqa: E402
from sim.concierge_sim import DeliveryBotSimulator  # noqa: E402

MODEL = os.path.join(os.path.dirname(__file__), "scene_corridor.xml")


def main():
    sim = DeliveryBotSimulator(MODEL)
    sim.start(headless=False)  # viewer open -- this is the recording
    try:
        tasks = {}
        _handle({"cmd": "dispatch", "task_id": "demo", "room": "1204",
                 "items": ["towel", "toothbrush"]}, tasks)
        tasks["demo"]["phase"] = "COLLECTING"

        print("COLLECTING -- lid opening, speaking loading directions. "
              "Cut to the 'lid' camera now.")
        for _ in range(15):  # a few seconds of real dwell before confirming
            tasks["demo"], _ = _advance(sim, tasks["demo"], time.time(), speak=True)
            time.sleep(0.2)

        print("Confirming complete_loading -- lid closing, departing. "
              "Cut to 'chase' or 'top'.")
        tasks["demo"], _ = _advance(sim, tasks["demo"], time.time(), confirmed=True, speak=True)

        while tasks["demo"]["phase"] == "EN_ROUTE":
            tasks["demo"], _ = _advance(sim, tasks["demo"], time.time(), speak=True)
            time.sleep(0.2)

        print("ARRIVED -- lid opening, speaking arrival announcement. "
              "Cut to the 'lid' camera now.")
        for _ in range(15):
            tasks["demo"], _ = _advance(sim, tasks["demo"], time.time(), speak=True)
            time.sleep(0.2)

        print("Confirming complete_collection -- lid closing, returning home.")
        tasks["demo"], _ = _advance(sim, tasks["demo"], time.time(), confirmed=True, speak=True)

        while tasks["demo"]["phase"] == "RETURNING":
            tasks["demo"], _ = _advance(sim, tasks["demo"], time.time(), speak=True)
            time.sleep(0.2)

        print(f"DONE. Final phase: {tasks['demo']['phase']}")
        time.sleep(2.0)  # hold the viewer open a moment
    finally:
        sim.stop()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it — this is the real acceptance test**

```bash
.venv/bin/python sim/record_demo.py
```

While it runs: watch the viewer (cycle `top`/`chase`/`lid` per the printed
cues) and listen for both spoken lines. Expected, all of which are things
to actually see/hear, not infer from exit code: the lid visibly opens at
the desk with a spoken loading instruction naming both items and the room;
the robot drives the near arm, turns the real 90° corner, and drives the
far arm to room 1204; the lid opens again at the room with a spoken
arrival line; the robot returns all the way home. If any step doesn't
happen — use `superpowers:systematic-debugging`, this is the first time
every piece from Tasks 1-5 runs together in one real pass, so a failure
here is genuine signal, not something to guess-patch.

- [ ] **Step 3: Commit**

```bash
git add sim/record_demo.py
git commit -m "Add sim/record_demo.py: standalone recording entry point for the submission video

Runs one real dispatch through the real FSM (corridor scene, speak=True,
viewer open) -- demo-only, never imported by or wired into production
(orchestrator/agent.py's spawned engine.run() still never passes
speak=True or headless=False). Verified live: full desk-to-1204-and-back
run with both door-open moments producing real speech and the real
90-degree corner drive, watched and listened to end to end.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 7: Docs sync

**Files:**
- Modify: `PLAN.md`
- Modify: `ARCHITECTURE.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update `PLAN.md`**

Line 150's `| Scenes | Hand-built MJCF corridor | Corridor + 3 doors is
enough — pending, Day 8-14 |` → drop the "pending" framing since it's now
built with 4 rooms, not 3:

```
| Scenes | Hand-built MJCF corridor (`sim/scene_corridor.xml`) | L-shaped, 4 rooms across two arms, done |
```

Line 199's schedule table row (`| 8–14 | Hotel scene, waypoint nav, task
queue, all eight tools, S1 + S2 end to end | |`) — mark the scene/nav
portion done in the notes column:

```
| 8–14 | Hotel scene, waypoint nav, task queue, all eight tools, S1 + S2 end to end | Scene + nav done (`sim/scene_corridor.xml`, `task_engine/nav.py`) |
```

- [ ] **Step 2: Update `ARCHITECTURE.md`**

Line 65's stack table row, same fix as `PLAN.md`'s:

```
| Scenes | Hand-built corridor MJCF (`sim/scene_corridor.xml`) | L-shaped, 4 rooms across two arms, done |
```

Lines 290-291 and 297 (the file-tree block) — drop every "pending, Day
8-14" annotation on `nav.py`, `waypoints.json`, and `scene_corridor.xml`,
and add the two new files this plan introduced that weren't in the
original tree at all:

```
│   ├── nav.py             # waypoint graph + pure pursuit
│   ├── waypoints.json     # per-room hand-authored paths
│   └── speech.py          # demo-recording-only robot speech (say via subprocess.Popen)
```

```
│   ├── scene_corridor.xml    # hotel corridor: L-shaped, 4 rooms, 3 cameras
│   └── record_demo.py        # standalone demo-recording entry point
```

- [ ] **Step 3: Commit**

```bash
git add PLAN.md ARCHITECTURE.md
git commit -m "Docs: mark hotel corridor scene + waypoint nav done, drop stale 'pending' tags

PLAN.md/ARCHITECTURE.md both said 'pending, Day 8-14' for exactly the
files this plan just built. Also documents the two files this plan added
beyond the original file tree's guess (waypoints.json's actual sibling
speech.py, and scene_corridor.xml's sibling record_demo.py).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

## Self-Review Notes

**Spec coverage:** Scene layout + 3 cameras (Task 1), hand-authored
waypoints + pure pursuit (Task 2), engine integration + door-open symmetry
+ per-room ETA's engine-side field (Task 3), per-room ETA's
orchestrator-side consumption (Task 4), robot speech at both door-open
moments (Task 5), a real recordable demo tying all five together (Task
6), doc sync (Task 7). Every section of the approved spec (including both
amendments — the `lid` camera and robot speech) maps to a task.

**Correction discovered while writing this plan, not left for an
implementer to trip over:** the spec said `delivery_bot_v2.xml` stays
fully unchanged; writing Task 1's actual MJCF revealed that MuJoCo's
`mode="track"` camera requires the camera to be a child of the tracked
body, which `<include>` cannot inject from outside. Fixed by making Task
1's `delivery_bot_v2.xml` change explicit, small, and justified (see
Global Constraints) rather than silently deviating from what was approved.

**Second correction, caught the same way:** the first draft of
`pure_pursuit_step` returned `progress_m` *unchanged* (labeled
`new_progress_m` in its own docstring, which it wasn't), pushing the
advance-by-one-tick arithmetic onto every caller redundantly. Fixed to
have the function own its own advance (`dt` as an explicit parameter,
since `nav.py` has zero dependency on `engine.py`'s `TICK_HZ` this way).
Re-deriving the fix surfaced a real, separate bug it would otherwise have
hidden: re-anchoring `task["progress_m"]` to `0.0` at every direction
reversal (`RETURNING`/`RECALLED`) is only correct when the robot has
already finished the outbound leg (guest-confirmed collection, or a
recall from `ARRIVED`) — a recall *mid*-`EN_ROUTE` needs the general
`total_length(path) - progress_m` formula, or pure pursuit's lookahead
aims at the room door instead of back toward the desk. This case wasn't
in the plan's first draft of the engine self-check at all; Task 3 Step 6
now has a dedicated assertion for it (distance-from-desk must actually
decrease after a mid-route recall, not just the phase flag).

**Type/shape consistency:** `nav.path_for`/`nav.total_length`/
`nav.pure_pursuit_step`'s signatures are identical everywhere they're
referenced (Task 2 defines them; Tasks 3 and 4 consume them by these exact
names, including the corrected `dt` parameter in every call site).
`task["progress_m"]` is introduced in Task 3 Step 2 and consumed
consistently by every later reference in Task 3 (Steps 3-4) and never
referenced again outside `engine.py`. `speech.announce`'s signature
(`text: str`) is identical in its Task 5 definition and both Task 5/6 call
sites.

**No placeholders:** every step has real, complete code — the MJCF wall
coordinates in Task 1 are concrete numbers derived from the layout section
directly above them (not "TODO: figure out wall positions"), the camera
`pos`/`xyaxes` values are explicitly flagged as reasoned-but-unverified
starting points with a required empirical-adjustment step, matching this
project's own established pattern for exactly this kind of physical
constant (never silently assumed, always the subject of an explicit
verification step).

**Deliberate scope cut, stated plainly:** this plan does not add collision
avoidance between robots (both robots have their own independent physics
world, per the spec's non-goals — the corridor scene is loaded twice, not
shared) and does not make room doors functional (static/cosmetic, per the
spec). Neither is an oversight.
