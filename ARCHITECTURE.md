# Architecture Reference

Technical detail only. Narrative, scenarios, and schedule live in `PLAN.md`.
Constraints that must never be violated live in `CLAUDE.md`.

## Process diagram

```
  Guest phone ──SIP──> Twilio trunk
                          │
                          ▼
              AssemblyAI Voice Agent API
              (Universal-3 Pro STT, turn detection,
               VAD, LLM routing, native PCM16 audio out)
                          │
              tool.call ↕ tool.result   (wss://agents.assemblyai.com/v1/ws)
                          │
   ┌──────────────────────▼──────────────────────┐
   │  PROCESS 1 — Orchestrator (asyncio)          │
   │  · holds the WebSocket                       │
   │  · client-side function tool handlers        │
   │  · returns in <100ms, always                 │
   └──────────────────────┬──────────────────────┘
                          │  multiprocessing.Queue (commands)
                          │  shared dict / Queue (state)
   ┌──────────────────────▼──────────────────────┐
   │  PROCESS 2 — Task engine + navigator         │
   │  · task queue, FSM per task                  │
   │  · waypoint graph over the floor plan         │
   │  · pure-pursuit → set_base_velocity()        │
   └──────────────────────┬──────────────────────┘
                          │
   ┌──────────────────────▼──────────────────────┐
   │  PROCESS 3 — MuJoCo (stretch_mujoco)         │
   │  · viewer for demo, headless for dev         │
   └──────────────────────────────────────────────┘
```

## Inter-process contract

- **Orchestrator → Task engine:** `multiprocessing.Queue`, one command per
  tool call. Command shape: `{"cmd": "dispatch", "task_id": ..., "room": ...,
  "items": [...]}`.
- **Task engine → Orchestrator:** shared state (dict behind a `Manager`, or
  a second Queue for events) so `check_delivery_status` and
  `get_robot_state` can read current position/phase without blocking on
  the task engine's own loop.
- **Task engine → MuJoCo:** direct Python calls if Process 2 and 3 are
  merged (acceptable — the hard boundary is Process 1 vs. everything else,
  since Process 1 is the one with a live WebSocket to a paid, latency-
  sensitive API). Merging 2 and 3 into one process is fine as an
  implementation shortcut; keeping 1 separate is not optional.

## Stack

| Layer | Choice | Note |
|---|---|---|
| Voice | AssemblyAI Voice Agent API | Stored agent via `POST /v1/agents`, bind by `agent_id` |
| LLM | Claude via AssemblyAI gateway (`byo-llm`) | See CLAUDE.md constraint 6 |
| Telephony | Twilio SIP trunk | No media server, no webhook; env vars only |
| Physics | MuJoCo 3.x + `stretch_mujoco` | Python 3.10 |
| Scenes | Hand-built corridor MJCF (default) or RoboCasa | Corridor + 3 doors is enough |
| Nav | Waypoint graph + pure pursuit | Not Nav2, not SLAM |
| Recording | AssemblyAI session artifacts API + MuJoCo offscreen render | Free demo material |

## AssemblyAI Voice Agent API — reference

- WebSocket endpoint: `wss://agents.assemblyai.com/v1/ws`
- Agents REST: `https://agents.assemblyai.com/v1/agents`
- Two config modes, mutually exclusive: stored agent (`{"agent_id": "..."}`)
  or inline (`system_prompt`, `greeting`, `tools`, `input`, `output` sent
  directly in `session.update`).
- Client-side function tools: declare inline in `session.tools`. Agent
  emits `tool.call`; you run it and reply with `tool.result`. Return the
  result once `reply.done` is the latest event received.
- Barge-in: on interruption, server stops generating audio and sends
  `reply.done` with `status: "interrupted"`.
- Every call is stored as a **session** with artifacts: OGG/Opus audio,
  timeline JSON (`user_transcript` paired with `agent_text`), metadata.
  `GET /v1/sessions` to list, `GET /v1/sessions/{id}` for artifact URLs
  (pre-signed, short TTL — re-fetch for fresh links, don't cache the URL).
- Sample starter agents worth reading before writing your own:
  `keyterms` (bias transcription toward names/jargon — use for room
  numbers, guest names, local dish names), `turn-taking` (silence
  thresholds, interruption sensitivity), `byo-llm`, `http-tools`.
- Pricing: $4.50/hr ($0.075/min). $50 free credit on signup. Credit card
  required to access the API at all.
- Starter repos: `voice-agent-starter-python` (3.9+, stdlib only),
  `voice-agent-starter-js` (Node 18+, no deps).

## Stretch / MuJoCo — reference

```python
from stretch_mujoco import StretchMujocoSimulator
sim = StretchMujocoSimulator()
sim.start(headless=False)          # viewer window; use headless=True for dev/CI

sim.stow(); sim.home()             # canned poses
sim.move_to('lift', 1.0)           # position control
sim.move_by('head_pan', -1.1)
sim.move_by('base_translate', 0.1)
sim.wait_until_at_setpoint('lift')
sim.wait_while_is_moving('base_translate')

sim.set_base_velocity(0.3, -0.1)   # v_linear (m/s), v_angular (rad/s)

sim.pull_status()                  # dict: base/lift/arm/head_pan/head_tilt/wrist_yaw pos+vel
sim.pull_sensor_data()             # gyro, accel, 2D lidar rangefinder
sim.pull_camera_data()             # calibrated RGB + depth
```

Models live in `stretch_mujoco/models/`: `stretch.xml` (robot),
`scene.xml` (robot + dock + table + objects + floor), `docking_station.xml`,
`assets/` (meshes, textures). Python 3.10 required.

### Dumping joint parameters (don't hand-copy from docs)

```python
import mujoco, pandas as pd
m = mujoco.MjModel.from_xml_path("stretch_mujoco/models/scene.xml")

rows = []
for i in range(m.njnt):
    name = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_JOINT, i)
    rows.append({
        "joint": name,
        "type": ["free", "ball", "slide", "hinge"][m.jnt_type[i]],
        "limited": bool(m.jnt_limited[i]),
        "range_lo": m.jnt_range[i][0],
        "range_hi": m.jnt_range[i][1],
        "axis": m.jnt_axis[i].tolist(),
        "damping": m.dof_damping[m.jnt_dofadr[i]],
        "armature": m.dof_armature[m.jnt_dofadr[i]],
        "frictionloss": m.dof_frictionloss[m.jnt_dofadr[i]],
    })
print(pd.DataFrame(rows).to_markdown(index=False))
```

Second pass over `m.nu` actuators for `actuator_ctrlrange`,
`actuator_gainprm` (kp), `actuator_biasprm` (kv) when motion looks wrong.

## Tool schema

See `CLAUDE.md` — kept there since it's a constraint, not just reference,
and both files must stay in sync if it changes.

## Fallback: custom cabinet-bot MJCF

If `stretch_mujoco` install or behaviour blocks progress for more than
half a day: box body with `freejoint`, two hinge-driven wheels with
velocity actuators, two spherical casters, a hinged lid, a `site` for the
payload bin. ~80 lines of MJCF, no meshes required. Looks authentically
like a Keenon/Pudu-style delivery robot.

## Repo layout

```
hotel-voice-robot/
├── CLAUDE.md
├── PLAN.md
├── ARCHITECTURE.md
├── .env.example
├── requirements.txt
├── orchestrator/          # Process 1 — WebSocket + tool handlers
│   ├── agent.py
│   ├── tools.py
│   └── session_config.json
├── task_engine/           # Process 2 — task FSM + navigation
│   ├── engine.py
│   ├── nav.py             # waypoint graph + pure pursuit
│   └── waypoints.json
├── sim/                   # Process 3 — MuJoCo
│   ├── scene_corridor.xml # hand-built fallback scene
│   ├── run_headless.py
│   └── run_viewer.py
├── audio_tests/           # RQ1/RQ2 test sets + results
│   ├── scripts/           # utterances to record
│   ├── recordings/
│   └── results.md
└── demo/                  # recorded clips for submission
```
