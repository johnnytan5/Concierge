# Sub-project B: Admin CRUD + Judge Dashboard — Design Spec

Status: approved by user in chat 2026-09-11, pending spec review.
Depends on: Sub-project A's schema and `tool_call_events` log (see
`docs/superpowers/specs/2026-09-11-inventory-tooling-fleet-design.md`).

## Context

Sub-project A gives the voice agent a real inventory, tool-call
validation, and a two-robot fleet with physical loading/collection
confirmation steps — but all of that currently happens invisibly, in a
terminal. This spec builds:

1. An admin page for hotel staff to manage the menu/inventory (add,
   edit, delete, toggle availability, adjust stock).
2. A live, judge-facing dashboard: a fixed flow diagram (LangGraph-
   Studio style) that lights up in real time as the voice agent calls
   tools, robots move through their phases, and inventory changes.
3. A "robot screen" page per robot — the physical LED-screen simulation
   staff/guests use to confirm loading and collection (this is what
   drives `task_engine`'s `robot_commands` polling from Sub-project A's
   spec).

## Goals

- Every real event in the system (a tool call, a phase change, a stock
  change, an escalation) is visible somewhere live, without polling —
  Supabase Realtime, not a refresh button.
- Hotel staff can manage the menu without touching code or the Supabase
  dashboard directly.
- The flow diagram reads as an honest trace of what's actually
  happening — no fabricated/simulated events, no delay beyond Realtime's
  own latency.
- Physical-button interactions (loading/collection confirmation) work
  exactly as Sub-project A's `task_engine` already expects — inserting
  into `robot_commands`, nothing more.

## Non-goals

- No new database tables beyond what this spec's own findings required
  (`tool_call_events`, already added to Sub-project A's spec/schema
  before this document was written — see that spec's changelog note).
- No real user accounts / multi-admin permissions — a single shared
  password for the admin page, not a login system.
- No changes to the voice agent, `task_engine`, or the robot simulator —
  this is purely a new read/write surface on top of what Sub-project A
  already built.
- No mobile-specific design — a hackathon demo runs on a laptop screen
  and, for the robot-screen pages, whatever device is propped up as the
  "robot's touchscreen" (likely also a laptop or tablet browser, not a
  custom embedded UI).

## Architecture

**Two services, one clear split by read vs. write:**

- **Next.js** — every *read*. Subscribes directly to Supabase Realtime
  from the browser using the **anon/publishable key** (safe to expose —
  this is exactly what that key is for). No backend round-trip for
  display; the dashboard, the admin page's item list, and each robot
  screen's current phase all come from the same Realtime subscriptions.
- **FastAPI** — every *write*. Sub-project A's RLS design deliberately
  locks `anon`/`authenticated` out of every write (`insert`/`update`/
  `delete`) on every table — only the **service role** key can write.
  FastAPI is the only thing holding that key, so it's the only path for:
  admin inventory changes, and the two robot-screen button actions
  (`complete_loading`, `complete_collection`, which insert into
  `robot_commands`).

This mirrors Sub-project A's own orchestrator/task_engine split: each
process holds exactly the credential its job requires, nothing more.

**Realtime requires an explicit publication step**, not just RLS —
confirmed live against Supabase's own docs and already applied:
`inventory_items`, `robots`, `deliveries`, `frontdesk_escalations`,
`tool_call_events` are added to the `supabase_realtime` publication.
(`robot_commands` deliberately excluded — it has no `anon`/
`authenticated` read policy at all, so a browser subscription to it
would receive nothing regardless.)

## Pages

### `/` — Judge dashboard (public, read-only)

The flow diagram (see below) plus: a stat row (active deliveries, robots
busy vs. idle, low-stock items), and the two robots' current phase
shown prominently. No auth — this is the page you'd put on a screen at
a demo table.

### `/admin` — Inventory management

A table of `inventory_items` (read via Realtime, same as the dashboard)
with add/edit/delete controls and stock/availability toggles. Gated by
a single shared password (see Auth below). Every write action calls a
FastAPI endpoint; the table updates live via the same Realtime
subscription once the write lands (no manual refresh, no optimistic-UI
special-casing needed — the row you just wrote is the row Realtime
pushes back).

### `/robot/robot_1`, `/robot/robot_2` — Robot screens

Reads that one robot's row from `robots` via Realtime. Shows:
- `IDLE`: "Waiting for next order."
- `COLLECTING`: item list for the current task (joined from
  `deliveries` by `current_task_id`) + a **"Complete Loading"** button.
- `EN_ROUTE`/`RETURNING`: "En route" / "Returning" with no button.
- `ARRIVED`: **"Complete Collection"** button.
- `RECALLED`/`AT_DESK`: "Returning to desk" / "At desk."

No auth on these pages — physical presence at the robot is the access
control, matching how the real hardware works (per PLAN.md's own
description of real Keenon/Pudu touchscreens).

## Flow diagram

Fixed topology, not a dynamically-generated graph — five node groups:

```
Guest → Voice Agent → ┬→ Check Menu
                       ├→ Dispatch / Amend / Recall → Robot 1 ↘
                       └→ Escalate to Front Desk       Robot 2 ↗→ Inventory
```

- **Voice Agent** node pulses on *any* `tool_call_events` insert (every
  tool call, unconditionally — this is exactly why that table exists).
- The three branch nodes (**Check Menu**, **Dispatch/Amend/Recall**,
  **Escalate to Front Desk**) pulse when `tool_call_events.tool_name`
  matches: `check_menu`; `dispatch_delivery`/`amend_delivery`/
  `recall_robot`; `escalate_to_frontdesk`, respectively.
- **Robot 1** / **Robot 2** nodes are colored continuously by
  `robots.phase` (gray=`IDLE`, yellow=`COLLECTING`, blue=`EN_ROUTE`,
  green=`ARRIVED`, blue=`RETURNING`, red=`RECALLED`/`AT_DESK`) — this is
  state, not a pulse, since a robot's phase persists between events.
- **Inventory** node pulses on any `inventory_items` update (a stock
  decrement) or `deliveries` insert.

Implementation: a single `useEffect` per table setting up one Realtime
channel each (5 channels: `tool_call_events`, `robots`, `deliveries`,
`inventory_items`, `frontdesk_escalations`), each event setting a
`lastEventAt`/`activeNode` piece of state that drives a CSS pulse
animation for ~1.5s before fading — no diagramming library needed for a
fixed 8-node layout; plain SVG/HTML with CSS transitions is enough
(matches this project's established "boring, debuggable" preference —
YAGNI on pulling in a graph-visualization dependency for a topology that
never changes shape).

## FastAPI endpoints

All under one small app (`admin_api/main.py` in Sub-project B's own
directory, separate from `orchestrator`/`task_engine` — a fourth
process, matching CLAUDE.md constraint 1's spirit of clear process
boundaries even though that constraint's letter is specifically about
MuJoCo/the voice WebSocket, neither of which this app touches).

| Endpoint | Auth | Effect |
|---|---|---|
| `POST /admin/items` | password header | insert into `inventory_items` |
| `PATCH /admin/items/{id}` | password header | update one item |
| `DELETE /admin/items/{id}` | password header | delete one item |
| `POST /robot/{robot_id}/complete_loading` | none | insert `{robot_id, cmd: "complete_loading"}` into `robot_commands` |
| `POST /robot/{robot_id}/complete_collection` | none | insert `{robot_id, cmd: "complete_collection"}` into `robot_commands` |

FastAPI holds `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (same env vars
Sub-project A's processes use) in its own `.env` — a third process
holding this credential, alongside orchestrator and task_engine.

## Auth

**My call, flagged for objection in spec review:** a single shared
password (`ADMIN_PASSWORD` env var on the FastAPI side), checked via a
header (`X-Admin-Password`) on every `/admin/*` request, no session/JWT
machinery. The Next.js `/admin` page prompts for it once client-side and
keeps it in `sessionStorage`, attaching it to each write request. This
is not real security (it's a shared secret sent as a plain header) —
appropriate for a hackathon demo behind a password a stranger can't
guess, not for a system holding real guest data. If this needs to be
stronger, say so before implementation starts.

## Data flow (env vars, by process)

| Process | Vars | Key type |
|---|---|---|
| Next.js (browser) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable/anon — safe to expose |
| FastAPI (`admin_api`) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_PASSWORD` | service role — secret, backend-only |

The anon/publishable key is fetched via `get_publishable_keys` at
implementation time, not written into this spec (it's not a secret, but
there's no reason to hardcode it here either — the implementation task
fetches it live).

## Testing / verification approach

Following this project's established pattern (real self-checks against
real dependencies, not mocked theater):
- FastAPI endpoints: a live integration script (same style as Sub-
  project A's Task 9) that POSTs to each endpoint against the real
  Supabase project and verifies the row actually landed — including the
  negative case (wrong/missing `X-Admin-Password` returns 401 and
  writes nothing).
- Next.js Realtime wiring: manually verified by running the dev server,
  triggering a change via `execute_sql` (an `UPDATE`/`INSERT` on a
  watched table) from the controller, and confirming the page updates
  without a refresh — Realtime subscriptions aren't meaningfully
  unit-testable, live observation is the real check here, same as this
  project's `run_headless.py`/live-agent verifications.

## Risks

- **Realtime channel count** — 5 channels open per page load (fewer on
  `/admin` and `/robot/*`, which only need 1-2 tables each). Fine at
  hackathon/demo scale; not designed for many concurrent dashboard
  viewers.
- **Shared-password auth is genuinely weak** — acceptable per the Auth
  section's explicit call-out, not a silent gap.
- **FastAPI is a 4th long-running process** for the full demo (voice
  orchestrator, task_engine, Next.js dev server, FastAPI) — more moving
  parts to have running simultaneously during a live demo. Worth a
  single combined "start everything" script when this is implemented,
  not a design change.
