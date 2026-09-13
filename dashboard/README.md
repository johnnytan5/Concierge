# Room Service Ops — admin dashboard

The admin surface for the voice-dispatched hotel delivery fleet. Five tabs:
Fleet, Deliveries, Call log, Escalations, Inventory. Next.js 16 (App Router),
reading live Supabase state.

## Run

```bash
npm install
npm run dev            # http://localhost:3000
```

Needs `dashboard/.env.local` (see `../.env.example` for the block to copy):

| Var | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings → API → **anon/public** |
| `NEXT_PUBLIC_ADMIN_API_URL` | `http://localhost:8000` |

**Use the anon key, never the service-role key.** Anything prefixed
`NEXT_PUBLIC_` is compiled into the browser bundle and served to every
visitor. The anon key is designed for that and RLS is what protects the data;
the service-role key bypasses RLS entirely and belongs only in the repo-root
`.env`, read server-side by `admin_api` / `orchestrator` / `task_engine`.

Writes also need `admin_api` running:

```bash
cd .. && .venv/bin/uvicorn admin_api.main:app --reload   # port 8000
```

## How data flows

Reads go **straight from the browser to Supabase** with the anon key, over
Realtime — every table is select-only for `anon`, so there is nothing to
protect beyond that. Writes go **through `admin_api`**, which holds the
service-role key server-side and gates on an `X-Admin-Password` header.

The header's Locked/Unlocked toggle holds that password in `sessionStorage`
for the tab's lifetime only — a front-desk terminal is shared, so a password
that outlives the browser session is the wrong default. Clicking a write
action while locked parks it, prompts, and replays it on unlock.

## Tabs

| Tab | Reads | Writes |
|---|---|---|
| Live call | the open `voice_sessions` row + its turns, calls and deliveries | — |
| Fleet | `robots` + the `deliveries` row for each robot's current task | `POST /admin/robots/{id}/recall` |
| Deliveries | `deliveries` | — |
| Call log | `voice_sessions` + `tool_call_events` + `transcript_turns`, grouped by `session_id` | — |
| Escalations | `frontdesk_escalations` | resolve / reopen |
| Inventory | `inventory_items` (category sub-tabs) + `inventory_audit_log` | create / update / delete item |

### Live call — the front desk line

Follows whichever session is currently open and renders it at recording
scale, with the deliveries it put on the floor underneath. One screen showing
speech → tool call → robot, which is the project's whole claim in one frame.

Deliberately **not** a mock phone UI. There is no telephony here and
`PLAN.md` §9 cut the phone number on purpose — this is a local mic session
framed as the front-desk line. A dialpad would advertise a capability that
does not exist.

"Live" needs more than `ended_at is null`: `agent.py` closes the session in a
`finally` that a hard kill never reaches, so an abandoned session would sit
open forever. `pickLiveSession` also requires a transcript turn or tool call
within the last 90s.

Everything arrives over Realtime, so it trails the spoken audio by the write
+ push round trip — close enough to feel live, not frame-accurate against
recorded audio. Updates land turn-by-turn, not word-by-word: AssemblyAI sends
partials on a separate `transcript.user.delta` event that the orchestrator
does not persist (verified against `assemblyAiDocumentation.md`), so each
stored row is one finished turn.

Set `initialTab="live"` in `app/page.tsx` when recording, so the first frame
is the call rather than the fleet.

### Latency badges

Each tool call and agent turn carries the time since the guest's preceding
turn, with a call-level median in the header. That is **RQ3** — "perceived
latency ceiling for tool round trips" — which `PLAN.md` already commits to
measuring, so the live view doubles as evidence for it.

Read them as an upper bound: the timestamps are when the orchestrator wrote
the row, not when audio left the speaker. Anything at or above 2.5s gets the
ink treatment rather than red, since red stays reserved for live motion.

### Call log — the audit trail

One row per **call**, not per tool call. Expanding one replays that
conversation: the flow topology showing which tool groups it exercised, then
guest speech, agent speech and tool calls merged in timestamp order.

This is where the old live `FlowDiagram` went. That component lit a node for
1.5s off a realtime event and kept no history, which made it impossible to
review after the fact. Same topology, inverted from "what is flashing now" to
"what did this call do" — see `components/CallFlow.tsx`.

Grouping depends on `session_id`, which `orchestrator/agent.py` generates per
WebSocket session. Tool calls written before that column existed have no
session and are collected under a single "Older calls" group rather than
dropped.

## Structure

```
app/
  layout.tsx        root layout (Archivo comes from globals.css's @import)
  page.tsx          mounts <RobotAdmin />
  globals.css       Modernist design-system tokens + component classes
components/
  RobotAdmin.tsx    the whole admin surface (client component)
  CallFlow.tsx      per-call replay for the Call log tab
lib/
  types.ts          row shapes — mirrors supabase/migrations/*.sql
  format.ts         engine-phase -> UI translation, durations, quantities
  format.test.ts    self-check: node --test lib/format.test.ts
  vocab.ts          tool/arg wording, category + dietary-tag options
  useAdminData.ts   every table, live, plus rolled-up status + password hook
  useRealtimeTable.ts  one table, live, debounced
  adminApi.ts       the write path
  supabase.ts       anon-key browser client
  ui.ts / css.ts    shared style strings + CSS-string -> React style helper
```

## Checks

```bash
node --test lib/format.test.ts   # phase mapping, quantities, durations, live-session pick, latency
npx tsc --noEmit
npx eslint app components lib
npm run build
```

## Demo data

No microphone needed to see every tab populated:

```bash
cd .. && .venv/bin/python scripts/seed_demo_calls.py           # 3 past calls
cd .. && .venv/bin/python scripts/seed_demo_calls.py --live    # one in progress
cd .. && .venv/bin/python scripts/seed_demo_calls.py --remove  # undo, restores stock
```

It drives the real `ToolHandlers.dispatch` — the same entry point `agent.py`
uses on a `tool.call` — so stock decrements, audit rows, deliveries and
tool-call events are all genuinely produced by production code. Only the
timestamps are backdated. `--live` leaves one session open, which reads as
live for ~90s before the staleness rule retires it; re-run for another window.

## Design system

`app/globals.css` is the Modernist stylesheet: flat, zero radius, Archivo
throughout, 2px rules. Take colors, type and spacing from its `var(--*)`
tokens rather than hard-coding values.

Two meanings are deliberately kept apart, because the palette is monochrome
plus a single red:

- **Red (`--color-accent`) means live motion only** — the live dot, the active
  phase step filling with `pose_frac`, the leg bar, in-flight chips.
- **Urgency uses form, not hue** — an inverted ink chip (`ALERT_CHIP`) and a
  45° hazard hatch (`HATCH`): escalations, out-of-stock, low battery,
  connection lost, the error screen. "Low but not out" gets a heavy ink
  underline, a step below the alert treatment.

Keep that split when adding screens. Do not introduce a third role for red.

Styling is inline CSS strings passed through `lib/css.ts`, carried over from
the mockup so the port stayed visually faithful. Migrate to CSS modules if
these screens outlive the hackathon.

## Known gaps

- `robots.battery` is hardcoded `100.0` in `task_engine/engine.py` and never
  decrements, so the battery bar is real but static and the low-battery hatch
  never fires.
- Nothing writes an "escalated" delivery phase — escalations live in their own
  table with no foreign key back to a task — so the Deliveries tab's status
  column has Delivered and Cancelled but no Escalated.
- `pose_frac` is progress across the whole trip, not the current leg, so the
  active step's fill is approximate.
