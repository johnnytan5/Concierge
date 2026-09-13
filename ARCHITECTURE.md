# Architecture Reference

Technical detail only. Narrative, scenarios, and schedule live in `PLAN.md`.
Constraints that must never be violated live in `CLAUDE.md`.

## Process diagram

```
  Guest mic/speaker (local — simulated front-desk line, no Twilio/SIP)
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
  `get_fleet_state` can read current position/phase without blocking on
  the task engine's own loop. Two keys: `state["tasks"]` (task_id → task
  dict) and `state["robots"]` (robot_id → `{phase, pose_frac, battery,
  current_task}`) — one entry per robot in the fleet, not a single
  `state["robot"]`.
- **Task engine → MuJoCo:** direct Python calls if Process 2 and 3 are
  merged (acceptable — the hard boundary is Process 1 vs. everything else,
  since Process 1 is the one with a live WebSocket to a paid, latency-
  sensitive API). Merging 2 and 3 into one process is fine as an
  implementation shortcut; keeping 1 separate is not optional.

## Stack

| Layer | Choice | Note |
|---|---|---|
| Voice | AssemblyAI Voice Agent API | Inline `session.update` config (not a stored agent) — see `orchestrator/agent.py` |
| LLM | BYO-LLM via OpenRouter (`qwen/qwen3.8-flash`) | See CLAUDE.md constraint 6 — not AssemblyAI's own gateway, that account has zero model access there. Verified end-to-end incl. tool-calling; cheap model chosen deliberately |
| Call input | Local mic/speaker (simulated front-desk line) | No Twilio/SIP — raw API key + `Bearer` header, no browser/token needed |
| Physics | MuJoCo 3.x + custom cabinet-bot MJCF | `sim/delivery_bot_v2.xml` + `sim/concierge_sim.py`, Python 3.10 |
| Scenes | Hand-built corridor MJCF | Corridor + 3 doors is enough — pending, Day 8-14 |
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
- `tool.call`'s fields are `{call_id, name, arguments}`, confirmed live —
  `arguments` is a real object (dict), no encoding gotcha there. But the
  **client's `tool.result` `result` field is a JSON-encoded string**, not
  a raw object: `{"type": "tool.result", "call_id": "...", "result":
  "{\"eta_seconds\": 90}"}`, not `{"result": {"eta_seconds": 90}}`.
  `orchestrator/agent.py` had this wrong until checked against the live
  events-reference doc — wrap the handler's return dict with
  `json.dumps()` before sending.
- `transcript.user` / `transcript.user.delta` / `transcript.agent` carry
  their text in a **`text`** field, not `transcript` — another one
  `agent.py` had wrong initially (no crash, just silently printed empty
  strings; only caught by actually running a live session and reading
  real output, not by reasoning about the docs).
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
- **AssemblyAI's own LLM Gateway (`llm-gateway.assemblyai.com`) has zero
  model access on this account — do not use it.** Confirmed live
  2026-09-11: a direct chat-completions call to the gateway with every
  Claude/Gemini model string from `/docs/llm-gateway/available-models`
  came back `400 {"metadata": {"errors": ["Your account does not have
  access to this LLM Gateway model"]}}` — every one, no exceptions.
  (GPT model strings came back a *different* error, `"model X is not
  supported"` — those names just aren't recognized by this gateway at
  all, a separate thing from the access restriction.) Inside the Voice
  Agent API this failure was invisible: every LLM-driven turn came back
  `reply.done: status="completed"` with zero `transcript.agent`, zero
  `tool.call`, and near-silent `reply.audio` (measured peak amplitude
  ~2/32767, against ~20000+/32767 for real speech) — no `session.error`
  at all. **If a live session ever looks like that again** — replies
  that "complete" but say and do nothing — test the LLM endpoint
  directly and in isolation (a bare `curl`/`urllib` POST to its
  `/chat/completions`) before assuming it's a bug in this codebase;
  that one request is what actually found this, not reasoning about the
  voice pipeline.
- **Fixed with OpenRouter** (`https://openrouter.ai/api/v1`,
  `OPENROUTER_API_KEY` in `.env`) — a genuinely OpenAI-Chat-Completions-
  shaped endpoint (unlike Anthropic's own API, which uses a different
  wire format and isn't a drop-in fit for `llm.base_url`). Verified in
  three stages, each before moving to the next: (1) a bare completion
  against OpenRouter directly — real content back; (2) OpenAI-style
  tool-calling against OpenRouter directly — correct `tool_calls` with
  right name/arguments; (3) the full stack through the Voice Agent API
  — real multi-item, multi-turn conversation, correct `dispatch_delivery`
  (asked for the room number when missing, then called the tool once
  given). Stage 3 is the one that mattered most: it confirms the Voice
  Agent API *does* correctly bridge tool-calling through to a BYO-LLM
  backend, which was unverified before (the AssemblyAI-gateway path
  never got that far). First confirmed working with
  `anthropic/claude-fable-5.1` (the only `anthropic/*` model in
  OpenRouter's catalog at the time — searched live, no sonnet/opus/haiku
  entries there currently). **Current model: `qwen/qwen3.8-flash`** —
  switched for cost (~$0.5/M completion tokens vs. Claude's, ~40x
  cheaper), re-verified with the same 3-stage process including
  tool-calling on a multi-item request before wiring in. Re-check
  OpenRouter's `/api/v1/models` for pricing/availability if either model
  ever 404s or costs look off.
- BYO-LLM **requires a stored agent** (`POST /v1/agents`) regardless of
  which provider it points at — confirmed live 2026-09-07 that sending
  `llm` on inline `session.update` is rejected outright: `session.error`
  `{"code": "invalid_value", "message": "BYO LLM config is not allowed
  on session.update; define it on a stored agent via POST /v1/agents",
  "param": "llm"}`. `session.llm` is an **array**, not a single object —
  `[{"base_url": "...", "model": "...", "api_key": "..."}]`. Send
  `"llm": []` (or omit it) for AssemblyAI's own managed default model
  instead. `orchestrator/agent.py`'s `USE_BYO_LLM` flag controls whether
  the `llm` block is sent at all.
- **Stored agent creation** (`POST /v1/agents`, see
  `orchestrator/agent.py`'s `agent_definition()`/`ensure_agent()`):
  required top-level fields are `name`, `system_prompt`, and `voice`
  (`{"voice_id": "anna"}` — **not** the same shape as inline
  `session.update`, which has no top-level `voice` at all). The create
  response's id field is `id`, not `agent_id`. Connect by sending
  `session.update` with `{"agent_id": "<id>"}` and nothing else —
  everything else (system_prompt, tools, llm, keyterms, ...) comes from
  the stored definition. `session.updated` fires once before
  `session.ready`; it's not the connect confirmation itself. The stored
  agent's own POST/GET response can show a different placeholder in
  `output.voice` (e.g. `"ivy"`) than the top-level `voice.voice_id` you
  set (e.g. `"anna"`) — confirmed live that the actual session voice at
  connect time correctly follows the top-level `voice_id`; that mismatch
  in the stored record is cosmetic, not a bug to chase.
  **Caution:** a malformed create request (missing required fields) gets
  its full body — including any `api_key` inside `llm` — echoed back
  in the 422 error response. Never log/print that response unredacted;
  `agent.py`'s `_redact()` exists because this happened once already
  during verification.
  **Stored agents observed to expire** — a created agent 404'd on both
  direct `GET` and WS connect (`agent_not_found`) within roughly one to
  two minutes, on this account, with no session ever having used it.
  Confirmed it's not instant (a fresh one still `GET`s fine at +10s) and
  not tied to session use. AssemblyAI's docs don't mention any TTL,
  expiry, or per-account limit at all, so the exact cause is
  unconfirmed — could be a free/trial-tier limit, could be something
  else. Consequence: don't cache a created agent id across runs and
  assume it still works. `agent.py`'s `ensure_agent()` creates fresh by
  default (an `ASSEMBLYAI_AGENT_ID` env var is honored only as a manual
  override), and `run_agent()` self-heals by recreating once if
  `agent_not_found` arrives immediately after connecting.
- Pricing: $4.50/hr ($0.075/min). $50 free credit on signup. Credit card
  required to access the API at all.
- Starter repos: `voice-agent-starter-python` (3.9+, stdlib only),
  `voice-agent-starter-js` (Node 18+, no deps).

## Custom cabinet-bot — reference

`sim/delivery_bot_v2.xml` (model — self-contained: robot + floor plane,
no external assets/meshes) + `sim/concierge_sim.py` (control wrapper).

```python
from concierge_sim import DeliveryBotSimulator

sim = DeliveryBotSimulator("sim/delivery_bot_v2.xml")
sim.start(headless=True)          # background thread runs mj_step at realtime pace
                                    # headless=False opens the interactive viewer

sim.drive(v=0.1, omega=0.0)       # real m/s / rad/s — see calibration note below
sim.open_door()
sim.close_door()
sim.set_door_fraction(0.5)        # 0.0 closed, 1.0 fully open

status = sim.pull_status()        # BotStatus: base (xy, yaw_deg, linear_vel,
                                    # angular_vel), door (top/bottom position, fraction_open)
sim.stop()
```

**Threading model:** `start()` runs `mj_step` in a background thread
inside whatever process calls it — that process must be task_engine
(Process 2), never the orchestrator (Process 1), per CLAUDE.md
constraint 1. All public methods write into `ctrl` or read out of
`qpos`/`qvel` and return immediately; nothing blocks on motion completing.

**macOS gotcha:** `headless=False` (the interactive viewer) needs the
GUI on the main thread, so it must be launched via `mjpython`, not plain
`python` — `python sim/run_viewer.py` raises `RuntimeError: launch_passive
requires that the Python script be run under mjpython on macOS`.
`mjpython` ships inside the `mujoco` pip package at `.venv/bin/mjpython`;
use `.venv/bin/mjpython sim/run_viewer.py`. `headless=True` (task_engine's
actual runtime mode) is unaffected — plain `python` is fine there.

**Calibration (measured, not assumed):** the base/turn actuators are
force-controlled (`motor` + tendon, inherited from MuJoCo's own
`model/car/car.xml` on purpose — that skeleton is the one thing in this
model deliberately left untouched). `drive()` converts real m/s/rad-s
into `ctrl` via `CTRL_PER_MPS=50.0` / `CTRL_PER_RADPS≈12.0`, clamped to
the model's actual physical ceiling (`MAX_LINEAR_MPS≈0.16`,
`MAX_ANGULAR_RADPS≈0.67` at full `ctrlrange`). Re-measure these two
constants — hold `ctrl` steady, read the settled `linear_vel`/
`angular_vel` (they converge in ~1-2s and hold flat, so this is fast to
redo) — if the model's mass, damping, or wheel geometry ever changes;
don't assume they still hold.

**Door:** two independent slide joints, not a hinged lid —
`lid_top_slide` moves up to open (closes *with* gravity assisting),
`lid_bottom_slide` moves down to open (closes *against* gravity). Neither
panel swings out into the corridor. The bottom panel's position actuator
needs enough `kp` to fully overcome its own weight on close — a position
actuator's steady-state offset under a constant force is `weight/kp`; at
the original kp=200 that left the panel ~31% "open" after a close
command. Currently kp=3000/kv=80, verified residual <0.001m. If the panel
mass or travel range ever changes, recheck the same way: command closed,
wait ~3s for settle, read `pull_status().door.bottom_position_m` — a
steady-state offset doesn't fix itself with more wait time.

## Considered and dropped: Hello Robot Stretch 3

`stretch_mujoco` (`pip install
git+https://github.com/hello-robot/stretch_mujoco.git`) installed clean
and drove correctly in headless mode (~0.93x realtime) — this was a scope
call, not a broken-install fallback (see PLAN.md Section 3). If the
custom model above ever becomes a blocker, Stretch is a *proven*
fallback, not a hypothetical one:

```python
from stretch_mujoco import StretchMujocoSimulator
sim = StretchMujocoSimulator()
sim.start(headless=False)
sim.set_base_velocity(0.3, -0.1)   # v_linear (m/s), v_angular (rad/s)
sim.pull_status()                  # dict: base/lift/arm/head_pan/head_tilt/wrist_yaw pos+vel
```

Models live in `stretch_mujoco/models/`: `stretch.xml`, `scene.xml`
(robot + dock + table + objects + floor), `docking_station.xml`. Python
3.10 required — same interpreter this project already uses.

## Tool schema

See `CLAUDE.md` — kept there since it's a constraint, not just reference,
and both files must stay in sync if it changes.

## Repo layout

```
hotel-voice-robot/
├── CLAUDE.md
├── PLAN.md
├── ARCHITECTURE.md
├── .env.example
├── requirements.txt
├── orchestrator/          # Process 1 — WebSocket + tool handlers
│   ├── agent.py           # session config, mic/speaker I/O, tool.call loop,
│   │                      #   voice_sessions + transcript_turns persistence
│   ├── tools.py           # 8-tool schema + handlers (task_engine cmd_queue + shared state)
│   └── inventory.py       # local menu cache + fire-and-forget Supabase writes
├── task_engine/           # Process 2 — task FSM + navigation
│   ├── engine.py          # task FSM, shared-state contract for orchestrator reads
│   ├── supabase_sync.py   # command polling + robot/delivery mirroring
│   ├── nav.py             # waypoint graph + pure pursuit — pending, Day 8-14
│   └── waypoints.json     # pending, Day 8-14
├── sim/                   # Process 3 — MuJoCo
│   ├── delivery_bot_v2.xml   # robot model (self-contained: robot + floor)
│   ├── concierge_sim.py      # control wrapper — DeliveryBotSimulator
│   ├── run_headless.py       # dev: drive/turn/door smoke test, no window
│   ├── run_viewer.py         # demo: same, with the interactive viewer
│   └── scene_corridor.xml    # hotel corridor + waypoint doors — pending, Day 8-14
├── admin_api/             # Process 4 — FastAPI, the only write path for the UI
│   └── main.py            # item CRUD, robot recall, escalation resolve/reopen
├── dashboard/             # Next.js 16 admin surface — see dashboard/README.md
│   ├── app/               # layout + the single page that mounts RobotAdmin
│   ├── components/        # RobotAdmin (5 tabs), CallFlow (per-call replay)
│   └── lib/               # types, formatting, realtime hooks, write client
├── supabase/migrations/   # the literal applied SQL, not reconstructions
├── audio_tests/           # RQ1/RQ2 test sets + results
│   ├── scripts/           # utterances to record
│   ├── recordings/
│   └── results.md
└── demo/                  # recorded clips for submission
```

## Database

Supabase project `hcutwuwlzuspbitllhlw`. All tables RLS-enabled with
select-only policies for `anon`/`authenticated`; every write goes through a
service-role client held by `orchestrator`, `task_engine` or `admin_api`.
Schema lives in `supabase/migrations/`.

| Table | Written by | Read by |
|---|---|---|
| `inventory_items` | admin_api (CRUD), orchestrator (stock decrement) | orchestrator cache, dashboard |
| `inventory_audit_log` | orchestrator (`decrement_stock`) | dashboard stock ledger |
| `robots` | task_engine (mirror ~1 Hz) | dashboard Fleet |
| `deliveries` | orchestrator (insert), task_engine (mirror) | dashboard Deliveries/Fleet |
| `robot_commands` | admin_api (`complete_loading` / `complete_collection` / `recall`) | task_engine poll |
| `frontdesk_escalations` | orchestrator (raise), admin_api (resolve/reopen) | dashboard Escalations |
| `voice_sessions` | orchestrator (one per WS session) | dashboard Call log |
| `transcript_turns` | orchestrator (guest/agent utterances) | dashboard Call log |
| `tool_call_events` | orchestrator (every tool.call) | dashboard Call log |

`voice_sessions.id` is the join key that turns isolated tool calls into a
reviewable conversation — `tool_call_events.session_id` and
`transcript_turns.session_id` are both FKs onto it, which is why
`insert_voice_session` is the one blocking write in `orchestrator/inventory.py`
(the parent row must exist before the fire-and-forget children reference it).
