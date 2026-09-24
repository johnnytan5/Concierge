# Web demo on Vercel — plan

Goal: a public page where a judge can phone Concierge from the browser and
watch the robot deliver, with no server of our own. Next.js on Vercel (free
Hobby plan) serves the page and a few short API routes; everything long-
running happens in the visitor's browser.

## Decisions (2026-09-24)

- **Robot:** real MuJoCo in the browser via `@mujoco/mujoco` (official WASM
  bindings, 3.14). Proven: our `scene_corridor.xml` loads and matches the
  Python sim exactly (drive 2 s → x 0.3135, turn 1 s → 40.42°, door 1.5 s →
  0.1477 m); 1000 steps in ~19 ms. Scene is boxes/cylinders/spheres/plane
  only, so rendering is a direct three.js mapping (no meshes).
- **Judges' calls** go to the same Supabase and show in the shared call log.
- **Access:** open page (no passcode), 3-minute cap per call, plus a global
  daily call limit from an env var (`DEMO_DAILY_CALL_LIMIT`, default 100).
- **Python stack stays** as the local/offline version; the web version reuses
  its prompt, tools, menu and hotel facts so both behave the same.
- **Hard constraints still hold in the browser:** physics in a Web Worker,
  never on the thread holding the AssemblyAI WebSocket; tool handlers return
  immediately; client-side tools, not AssemblyAI HTTP tools.

## Architecture

| Piece | Where it runs |
|---|---|
| Mic in / speaker out, AssemblyAI WebSocket | Browser main thread (AudioWorklet, echo cancellation on) |
| Temporary AssemblyAI token, stored agent (prompt + live menu + OpenRouter key) | Next.js route handlers (server-only env vars) |
| Tool handlers (dispatch, menu, hotel info, escalate, end call…) | Browser, ported from `orchestrator/tools.py` |
| Robot engine (FSM, pure pursuit, loading/arrival scenes) | Web Worker, ported from `task_engine/engine.py` + `nav.py` |
| MuJoCo physics | Same Web Worker |
| 3D view (follow cam, desk cam, room cams) | Browser main thread, three.js from worker state |
| Audit trail (voice_sessions, transcript_turns, tool_call_events, deliveries, escalations, stock) | Route handler with the service-role key |
| Dashboard | Existing Next.js app, reads Supabase with the anon key |

## Schedule (5 days)

- [x] **Day 1** — Vercel-ready dashboard with read-only demo mode; MuJoCo WASM
      + three.js rendering the corridor in a worker (`/demo` prototype).
- [ ] **Day 2** — Engine port to TypeScript (phases, pure pursuit, desk and
      room scenes, door and camera cuts); port the engine self-check scenarios.
- [ ] **Day 3** — Voice in the browser: token + agent routes, mic/speaker
      worklets, tool handlers, nudge, end_call, barge-in; audit writes.
- [ ] **Day 4** — `/demo` split screen (call + dashboard left, 3D right), Bin
      loaded wired to the worker, 3-min cap, daily limit, error states.
- [ ] **Day 5** — Clean-browser and Vercel testing, fixes, submission link.

## Needs the user

- Vercel account and the repo linked (root directory `dashboard/`).
- Env vars on Vercel: `ASSEMBLYAI_API_KEY`, `OPENROUTER_API_KEY`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, optional `DEMO_DAILY_CALL_LIMIT`.
