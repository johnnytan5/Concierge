# Hotel Corridor Scene + Waypoint Navigation — Design Spec

Status: approved by user in chat 2026-09-11.
Depends on: nothing new — builds on the already-shipped, calibrated
`sim/delivery_bot_v2.xml` / `sim/concierge_sim.py` and the already-shipped
multi-robot `task_engine/engine.py` FSM (Sub-project A). Independent of
Sub-project B (admin dashboard); no shared files.

## Context

`task_engine/engine.py` has always used a placeholder for navigation: a
fixed straight-line distance (`NOMINAL_TRIP_METERS`) stands in for "desk to
room," documented in the file's own `ponytail:` comment as a known stub.
This was intentional — Days 1-3's gate (both halves alive independently,
RQ1 audio test) had to clear first, per `PLAN.md`'s schedule. It's cleared.
This is Days 8-14's committed work: `sim/scene_corridor.xml` and
`task_engine/nav.py`, both listed as "pending" in `ARCHITECTURE.md`'s file
tree since the project's earliest planning.

## Goals

- A real hotel corridor scene the robot visibly drives through — not a
  bare floor — with a real 90° turn, so a delivery to the far wing looks
  different from one to the near wing, on camera.
- Real per-room navigation distance, replacing the single constant trip
  length: `dispatch_delivery`'s ETA and `pose_frac`'s progress both reflect
  the room's actual path length.
- The robot's bin-loading door opens and closes visibly at *both* ends of
  a delivery (desk and room), not just the room — this is a real, small
  gap in the current sim (`open_door()` is only called on arrival today,
  confirmed by inspection of `engine.py`'s `_advance()`).
- A demo-recordable result: two named fixed cameras (`top`, `chase`) so a
  recording script can cut between a floor-plan overview and a
  robot-following shot, instead of relying on live mouse control.

## Non-goals

- **No shared multi-robot scene.** Each robot keeps its own independent
  `DeliveryBotSimulator`/`MjModel` instance (today's architecture,
  unchanged) — both instances just load `scene_corridor.xml` instead of
  the plain floor. A judge wanting to see both robots at once watches two
  viewer windows, not one combined scene. Explicitly rejected: restructuring
  `engine.py` to one shared `MjModel` with two robot bodies is a real
  architecture change this spec does not need.
- **No robot-robot collision avoidance.** The two robots are not even in
  the same physics world (see above), so this was never reachable, not
  merely deprioritized.
- **No graph search / pathfinding.** `nav.py` does not compute routes —
  `waypoints.json` *is* the route, one hand-authored ordered point list
  per room. Adding a new room later means hand-authoring its path, not
  updating a graph.
- **No functional (openable) room doors.** They're a static colored wall
  recess + a `site`-based room-number label. The robot never enters or
  manipulates a room door in this interaction model (per `CLAUDE.md`
  constraint 4) — only its own bin door, which already exists and is
  already calibrated.
- **No SLAM, no localization uncertainty.** The robot's pose comes
  directly from MuJoCo's own simulated state (`sim.pull_status()`), exactly
  as today. Pure pursuit here means "follow this known point sequence,"
  not "localize against a map."

## Scene layout (`sim/scene_corridor.xml`)

Desk-at-the-end layout (chosen over a desk-at-the-corner hub after visual
comparison): one hallway from the desk, turning 90° at a junction partway
along into a second wing.

- **Rooms:** `0803`, `0804` on the near arm (desk side); `1204`, `1205` on
  the far arm (past the junction). Four rooms — enough to make the L-shape
  matter (the far arm is genuinely farther) without inventing rooms no
  scenario references. `1204`/`0803` match `PLAN.md`'s named scenarios and
  `agent.py`'s `KEYTERMS`; `0804`/`1205` are new, added only to make "a
  floor" rather than "two doors."
- **Corridor width:** 0.6m — the robot's known footprint is ~0.3m wide
  (measured from `delivery_bot_v2.xml`'s existing geometry), so this gives
  real clearance without inventing a new scale.
- **Construction:** `scene_corridor.xml` is a new top-level MJCF file that
  `<include>`s `delivery_bot_v2.xml` (a robot file is a complete,
  standalone `<mujoco>` document *and* includable — the standard MuJoCo
  Menagerie pattern) and replaces the included file's plain 6×6m checker
  floor plane with real wall geometry: static `box` geoms forming both
  corridor arms and the turn, plus one shallow colored recess + labeling
  `site` per room door.
- **Cameras:** two named `<camera>` elements — `top` (fixed bird's-eye over
  the whole floor plan) and `chase` (`mode="track"`, following the robot
  body from behind/beside). A recording script selects between them;
  the interactive viewer (`mujoco.viewer.launch_passive`) remains
  free-orbit by default regardless — these are additional fixed options,
  not a restriction on manual control.
- `sim/concierge_sim.py`/`DeliveryBotSimulator` is **unchanged** — it
  already takes a model path as a constructor argument.

## Waypoints (`task_engine/waypoints.json`)

One entry per room name, each an ordered list of `[x, y]` points from the
desk (implicit origin, `[0, 0]`) to that room's door — hand-authored to
match the actual wall/junction coordinates in `scene_corridor.xml`, not
computed. Far-arm rooms' lists pass through the junction point explicitly;
near-arm rooms' lists don't. Example shape (illustrative, not final
coordinates — the implementation task fixes exact values against the
actual MJCF geometry):

```json
{
  "0803": [[0, 0], [1.2, 0]],
  "0804": [[0, 0], [1.6, 0]],
  "1204": [[0, 0], [1.8, 0], [1.8, 2.4], [1.8, 3.6]],
  "1205": [[0, 0], [1.8, 0], [1.8, 2.4], [1.8, 4.0]]
}
```

## Navigation (`task_engine/nav.py`)

Two functions, both pure/stateless aside from a cached read of
`waypoints.json`:

- `path_for(room: str) -> list[tuple[float, float]]` — reads and caches
  `waypoints.json` on first call; raises (not silently returns empty) on
  an unknown room name, since a missing waypoint path for a room that
  passed inventory validation is a real bug, not a "not offered" case.
- `pure_pursuit_step(sim, path, progress_m, speed_mps, lookahead_m=0.15) ->
  (new_progress_m, frac, done)` — advances a fixed arc-length step along
  `path` each tick (reusing this project's existing tick-rate assumptions),
  finds the look-ahead point at `progress_m + lookahead_m` along the
  path's cumulative arc length, computes the heading error between the
  robot's current yaw (from `sim.pull_status()`) and the bearing to that
  point, and calls the *already-calibrated* `sim.drive(v=speed_mps,
  omega=k * heading_error)` — no new drive-calibration work, this reuses
  `CLAUDE.md` constraint 3's existing `drive()` contract exactly. Returns
  `frac = progress_m / total_length(path)`, preserving `pose_frac`'s
  existing 0→1 semantics, and `done = True` once `progress_m` reaches the
  path's total length within the existing `arrival_tolerance_m` pattern.

## Engine integration (`task_engine/engine.py`)

- `MODEL_PATH` now points at `scene_corridor.xml` instead of
  `delivery_bot_v2.xml`.
- `_advance()`'s `EN_ROUTE`, `RETURNING`, and `RECALLED` branches replace
  `_dist_from_origin`/`_drive_home`'s straight-line math with
  `nav.pure_pursuit_step()` over `nav.path_for(task["room"])`. The phase
  FSM itself — `QUEUED → COLLECTING → EN_ROUTE → ARRIVED → RETURNING →
  DONE`, or `→ RECALLED → AT_DESK`, confirmed-gated at `COLLECTING`/
  `ARRIVED` — is unchanged; only how "how far along" is computed changes.
- **Door-open symmetry (new behavior, not just internal plumbing):** while
  `task["phase"] == "COLLECTING"`, call `sim.open_door()` every tick
  (idempotent ctrl target, same pattern already used for `close_door()` at
  a recall from `ARRIVED`); on the `COLLECTING → EN_ROUTE` transition
  (confirmed loading), call `sim.close_door()` once before the robot
  starts moving. This mirrors the existing `ARRIVED`/`RETURNING` open/close
  pattern exactly, so the full visible sequence becomes: desk — lid opens,
  loading confirmed, lid closes, departs → real waypoint path with a real
  turn → room — lid opens, collection confirmed, lid closes, returns home.
- **Per-room ETA:** `dispatch_delivery`'s returned `eta_seconds` and each
  task's `eta_seconds` field become `total_length(nav.path_for(room)) /
  DRIVE_SPEED_MPS`, replacing the current single `BASE_ETA_SECONDS`
  constant. This is a real, observable behavior change (a room on the far
  arm now correctly reports a longer ETA than one on the near arm) — not
  hidden internal refactoring. `orchestrator/tools.py`'s tool contract
  (`dispatch_delivery` returns `task_id, eta_seconds, dispatched_items[],
  unavailable_items[]`) does not change shape, only the value's source.
  Mechanically, this is the same pattern already in place today
  (`orchestrator/tools.py:11` does `from task_engine.engine import
  BASE_ETA_SECONDS` — a plain Python import, not a live cross-process
  call): `tools.py` imports `nav.path_for` and a `total_length()` helper
  directly and computes ETA locally from the static `waypoints.json`
  data. No new IPC, no violation of the three-process boundary —
  `task_engine`'s own running simulator state is never queried from the
  orchestrator.

## Testing / verification approach

Following this project's established convention (real self-checks against
real physics, never mocked theater):

- `nav.py`'s own `__main__` self-check: drive a real path (via a real
  `DeliveryBotSimulator`) end to end, assert `frac` increases monotonically
  tick over tick, assert `done` becomes `True` only once the robot's real
  measured position is within `arrival_tolerance_m` of the path's final
  waypoint — not a "didn't throw" proxy.
- `engine.py`'s self-check extended: dispatch to two rooms with genuinely
  different path lengths (one near-arm, one far-arm), assert both robots'
  `pose_frac` independently reach `1.0`, and assert the two tasks'
  `eta_seconds` differ and are each proportional to their own path's real
  length — proving per-room ETA isn't a constant in disguise.
- A live-viewer smoke run (`run_viewer.py`, updated to load
  `scene_corridor.xml`): visually confirm the 90° turn renders and drives
  correctly, and that the bin door visibly opens at the desk *and* at the
  room in one recorded pass — the actual acceptance criterion for the
  "door symmetry" goal, since a viewer's own eyes are the only thing that
  meaningfully checks "does this look right on camera."

## Risks

- **Pure-pursuit tuning at the corner.** A 90° turn is the one place
  pure-pursuit's look-ahead distance genuinely matters — too large and the
  robot cuts the corner into the wall; too small and it oscillates. Mitigate
  by testing the turn specifically (not just straight-line legs) before
  calling `nav.py` done, and by keeping `lookahead_m` a named constant that
  can be tuned empirically, the same way `CTRL_PER_MPS`/`CTRL_PER_RADPS`
  were empirically calibrated for `drive()`.
- **Wall geometry vs. robot footprint.** The 0.6m corridor width is a
  reasoned estimate, not a verified fit — the first implementation task
  should confirm the robot doesn't clip the walls at the turn before
  building the rest of the scene on top of that width.
- **Camera `mode="track"` behavior with two independent physics worlds.**
  Each robot has its own copy of the scene including its own `chase`
  camera — confirmed to be the intended design (independent copies, not
  shared), but worth stating so it isn't mistaken for a bug when two
  viewer windows both show a "chase" view of their own robot, not of each
  other.
