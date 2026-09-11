# Sub-project A: Inventory, Ordering & Fleet Tooling — Design Spec

Status: approved by user in chat 2026-09-11, pending spec review.
Depends on: nothing (foundational). Sub-project B (Next.js/FastAPI admin +
judge dashboard) depends on this spec's schema and event plumbing.

## Context

The voice agent currently has six tools (`dispatch_delivery`,
`check_delivery_status`, `amend_delivery`, `recall_robot`,
`get_robot_state`, `announce_arrival`) operating on a single simulated
robot with no concept of inventory, pricing, dietary needs, or non-delivery
requests. This spec adds:

1. A real inventory/menu backed by Supabase, so `dispatch_delivery`
   actually validates what it's asked to send instead of blindly
   dispatching anything.
2. Price quoting + dietary-preference conversation for food/beverage
   orders, handled by the LLM's own reasoning over tool output — not a
   scripted dialogue tree.
3. A `escalate_to_frontdesk` tool for requests outside the delivery
   domain (late checkout, lost card, billing, etc.).
4. A two-robot fleet, replacing the current single-robot model, with a
   physical "LED screen" interaction step (staff confirms loading, guest
   confirms collection) instead of the current timer-based phase
   transitions.

Out of scope for this spec: the Next.js/FastAPI admin webpage and the
judge-facing live visualization dashboard — that is Sub-project B, built
against the schema and events this spec defines.

## Goals

- `dispatch_delivery` only ever sends items that are real and in stock;
  unavailable items are reported back per-item, not silently dropped or
  silently sent.
- Food/beverage orders let the LLM naturally quote price and ask about
  dietary preferences, using data from a new `check_menu` tool.
- Non-delivery requests get routed to a logged, acknowledged human
  hand-off instead of the LLM improvising an answer it can't act on.
- Two robots, each with real, trackable status; a new order goes to
  whichever is free, or queues if both are busy.
- Loading and collection are real human-confirmed steps (via a
  "robot screen" that Sub-project B will build), not fixed timers.
- Every constraint in `CLAUDE.md` still holds: 3 separate processes,
  tool handlers return in <100ms, task_engine never touches inventory
  concepts, robot platform/model unchanged.

## Non-goals

- No changes to `sim/delivery_bot_v2.xml` or `sim/concierge_sim.py` — the
  physical robot model and its calibration are untouched. Multi-robot
  means multiple *instances* of the existing simulator, not a new model.
- No real payment processing — "price" is quoted conversationally, not
  charged.
- No Twilio/real telephony — unrelated to this spec, already decided
  against in `PLAN.md`.
- No building of the admin webpage, LED-screen UI, or live dashboard —
  that's Sub-project B. This spec only defines the schema and events
  those UIs will read/write.

## Data model (Supabase, `public` schema)

```sql
create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null check (category in ('amenity','food','beverage')),
  price numeric(10,2),               -- null for amenities (free/complimentary)
  dietary_tags text[] not null default '{}',   -- e.g. {halal,vegetarian}
  available boolean not null default true,     -- admin on/off switch
  stock_count integer,               -- null = untracked/unlimited; else decremented per order
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table robots (
  id text primary key,               -- 'robot_1', 'robot_2' — static, not admin-editable
  phase text not null default 'IDLE'
    check (phase in ('IDLE','COLLECTING','EN_ROUTE','ARRIVED','RETURNING','RECALLED','AT_DESK')),
  current_task_id text,
  pose_frac numeric,
  battery numeric,
  updated_at timestamptz not null default now()
);

create table deliveries (
  task_id text primary key,
  robot_id text references robots(id),
  room text not null,
  items jsonb not null,              -- [{"name": "towel", "price": null}, ...]
  phase text not null,               -- same enum as robots.phase, plus 'QUEUED','DONE'
  priority text not null default 'normal',
  dispatched_at timestamptz,
  arrived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table robot_commands (
  id uuid primary key default gen_random_uuid(),
  robot_id text not null references robots(id),
  cmd text not null check (cmd in ('complete_loading','complete_collection')),
  status text not null default 'pending' check (status in ('pending','done')),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table frontdesk_escalations (
  id uuid primary key default gen_random_uuid(),
  reason text not null,
  room text,
  created_at timestamptz not null default now()
);
```

RLS (per the Supabase security checklist — enable on every exposed table):
- `inventory_items`, `robots`, `deliveries`, `frontdesk_escalations`: RLS
  enabled, a `select` policy for `anon`/`authenticated` (public read — no
  sensitive data, needed so Sub-project B's dashboard/LED screens can
  read live via the anon key). No `insert`/`update`/`delete` policy for
  `anon`/`authenticated` — writes only happen from trusted backend
  processes (orchestrator, task_engine) using the **service role** key,
  which bypasses RLS by design.
- `robot_commands`: RLS enabled, no `anon`/`authenticated` policies at
  all for now — Sub-project B's FastAPI backend (a trusted server, not
  the browser) writes here using the service role key too. If B later
  needs the *browser* to write directly (skipping its own backend),
  that requires its own `insert` policy — decide that in B's spec, not
  here.

Robot identity (`robot_1`, `robot_2`) is a **static constant in code**
(`task_engine/engine.py`), not looked up from the `robots` table — the
table is an output (state task_engine writes to), not an input config.

## Tool changes (`orchestrator/tools.py`)

`check_menu` and `dispatch_delivery` share one internal helper,
`_lookup_items(names) -> list[{name, category, price, dietary_tags,
available, in_stock}]`, reading the local inventory cache — so the
lookup logic exists exactly once. `check_menu` exposes it directly as a
read for the LLM's conversational use (price/dietary questions).
`dispatch_delivery` calls the same helper to validate every request
itself, rather than trusting that `check_menu` was called first — the
model has no guaranteed reason to check an unambiguous item like
"towel" before dispatching it, so the "unavailable items are reported,
not silently sent" guarantee has to hold at the point of dispatch, not
just when the model happens to check first.

### `check_menu(items?: list[str])` — new
Reads the orchestrator's local inventory cache (see below), returns
matching entries (or the whole catalog if `items` omitted):
`[{name, category, price, dietary_tags, available}, ...]`. **Includes
unavailable items in the results** (with `available: false`), not just
in-stock ones — the LLM needs to know an item exists but is out of stock
to say so correctly, not just stay silent about it. This is the only
inventory-reading tool — the LLM uses its own reasoning over this data
to quote price, ask about dietary preferences, or say something isn't
available, the same way it already asks "which room are you in?" without
a dedicated tool for that.

### `dispatch_delivery(room, items[], priority)` — changed behavior
1. Call the shared `_lookup_items` helper (case-insensitive names)
   itself — regardless of whether `check_menu` was already called this
   turn.
2. Split into `dispatched_items` (found, `available=true`, and
   `stock_count` is null or `>0`) and `unavailable_items` (everything
   else, with a reason: `not_offered` or `out_of_stock`).
3. If `dispatched_items` is empty, return immediately with no task
   created — nothing to send.
4. Enqueue the existing direct `cmd_queue` dispatch command (unchanged
   path/latency — this is the voice-triggered, latency-sensitive route,
   deliberately *not* going through Supabase) with only the validated
   items — always as a new `QUEUED` task, same as today's single-robot
   behavior. The orchestrator does **not** pick a robot itself and keeps
   no fleet-availability cache; robot assignment is entirely
   `task_engine`'s job (see Fleet model below), exactly like the
   existing single-robot promotion logic already works — this avoids
   two places deciding the same thing.
5. Fire-and-forget (not awaited before returning): decrement
   `stock_count` for dispatched items, insert the `deliveries` row.
6. Return `{task_id, eta_seconds, dispatched_items, unavailable_items}`
   so the LLM can correctly narrate partial fulfillment. `eta_seconds` is
   always the standard per-trip estimate (`BASE_ETA_SECONDS`) — the
   orchestrator returns before `task_engine`'s next tick runs, so it
   cannot yet know whether the task will be picked up immediately or
   queued behind a busy robot (that's decided asynchronously, up to
   ~200ms later, per constraint 2). If the guest asks again, that's what
   `check_delivery_status` is for — it reads the real, current phase
   (`QUEUED` vs `EN_ROUTE`) from `task_engine`'s mirrored state, so the
   LLM can say "still waiting for a robot to free up" accurately at that
   point, same as any other status check.

### `escalate_to_frontdesk(reason: str)` — new
Fire-and-forget insert into `frontdesk_escalations`. Returns `{ack:
true}` instantly. System prompt updated to route here for anything that
isn't a delivery/inventory request (late checkout, lost card, billing,
complaints, etc.).

### `get_robot_state` → `get_fleet_state` — renamed, changed shape
Was: no args, returns one robot's `{pose, payload, battery,
current_task}`. Now: no args, returns
`{robots: [{robot_id, phase, room, current_task_id, battery, pose_frac}, ...]}`
for both robots. **This is a breaking change to the tool schema table in
`CLAUDE.md`** — that table must be updated as part of this work, kept in
sync with `orchestrator/tools.py` per its own header comment.

### `check_delivery_status`, `amend_delivery`, `recall_robot`
Unchanged in shape; `amend_delivery`'s item-add path should reuse the
same inventory validation as `dispatch_delivery` (reject/report
unavailable additions the same way), everything else as today.

## Orchestrator-side inventory cache

`CLAUDE.md` constraint 2 (tool handlers return in <100ms) rules out a
live Supabase round-trip inside `check_menu`/`dispatch_delivery`. The
orchestrator instead keeps a **local in-memory cache** of
`inventory_items` and the fleet's `IDLE`/busy state, refreshed by
**periodic polling** (every ~30s, plain REST fetch) rather than a
Realtime subscription — a 30-second staleness window is fine for a
hotel admin editing a menu, and periodic polling is simpler to build and
reason about than adding a second async subsystem alongside the
AssemblyAI WebSocket loop (YAGNI: build Realtime later only if 30s
staleness genuinely becomes a problem). All *writes* from tool handlers
(stock decrement, delivery/escalation rows) are fire-and-forget — issued
without `await`ing the response before returning `tool.result`.

## Fleet model (`task_engine/engine.py`)

- `run()` now owns a dict of `{robot_id: {sim: DeliveryBotSimulator,
  ...}}` for `robot_1`/`robot_2` instead of one `sim`. **Risk, verify
  early:** running two `DeliveryBotSimulator` instances (two background
  physics threads) in one process has never been tested — the
  implementation plan should verify this works in isolation before the
  rest of the fleet logic is built on it. If it doesn't work cleanly,
  the fallback is two separate `task_engine`-like processes, one per
  robot, which changes the process-count constraint and needs a
  conversation before proceeding, not a silent workaround.
- Phase model per task now includes `COLLECTING` before `EN_ROUTE`:
  `QUEUED → (assigned to an idle robot) → COLLECTING → EN_ROUTE →
  ARRIVED → RETURNING → DONE`, or `EN_ROUTE → RECALLED → AT_DESK` as
  today. A robot's own `phase` mirrors whichever task it's actively
  running, or `IDLE` when free.
- `COLLECTING → EN_ROUTE` and `ARRIVED → RETURNING` are no longer
  timer-driven (the current `DWELL_SECONDS` auto-transition is removed)
  — they wait for a `complete_loading` / `complete_collection` command
  respectively. `DWELL_SECONDS`/timer logic can be kept as a **timeout
  fallback** (e.g., auto-recall/flag after N minutes with no
  confirmation) to avoid a robot sitting stuck forever if a button is
  never pressed — mirrors S5's existing "no answer → timeout" scenario
  in `PLAN.md`. Exact timeout duration is an implementation detail, not
  a design constraint.
- Every ~1s (every 5th tick at the current 5Hz `TICK_HZ`, not every
  tick — avoids hammering Supabase 5x/second for no benefit):
  1. Poll `robot_commands` for `status='pending'` rows targeting this
     process's robot ids; apply matching phase transitions; mark
     `status='done'`.
  2. Upsert current `robots` and any changed `deliveries` rows to
     Supabase.
  This is task_engine's own tick loop, not a tool handler — the <100ms
  constraint applies to orchestrator's tool handlers, not here, so
  plain synchronous Supabase calls are fine in this loop.
- Assignment logic: when a robot becomes `IDLE` (finishes a task) or a
  new task is `QUEUED`, scan for the oldest `QUEUED` task and the first
  `IDLE` robot; assign if both exist. Same pattern as the current
  single-robot promotion logic, just no longer assuming exactly one
  robot.

## Error handling & conversational behavior

- Item not in catalog at all, or `available=false`/`stock_count<=0`:
  `dispatch_delivery` reports it in `unavailable_items`; the LLM says
  something like "we don't have toothbrushes right now" rather than
  claiming to have sent one.
- Food/beverage item with `dietary_tags`: the LLM asks about relevant
  preferences (halal, vegetarian, etc.) using `check_menu`'s data before
  confirming — this is conversational, not a separate tool/state
  machine step.
- Requests with no delivery/inventory shape at all (late checkout, lost
  card, billing): system prompt directs the LLM to call
  `escalate_to_frontdesk` rather than improvise.
- Both robots busy: task sits `QUEUED`; `check_delivery_status` already
  reports phase, so "your order is queued, a robot will pick it up
  shortly" falls out naturally from existing status-reporting behavior.

## Testing / verification approach

Following this project's existing pattern (real self-checks, not mocked
theater, for anything with real branching logic):
- `task_engine/engine.py`'s self-check extended to real physics with
  **two** simulators running concurrently — dispatch two tasks at once,
  verify both robots move independently, verify a third task queues
  correctly when both are busy.
- `orchestrator/tools.py`'s self-check extended with a fake inventory
  cache (no live Supabase call needed for the unit-level check) covering:
  full availability, partial availability, complete unavailability,
  `escalate_to_frontdesk`.
- One live integration check against the real Supabase project (schema
  applied, a few seed rows) exercising `dispatch_delivery` end-to-end
  through to a real `stock_count` decrement and a real `deliveries` row
  — mirrors how `run_headless.py`/live-agent checks were verified earlier
  in this project, not skipped in favor of only unit-level mocking.

## Risks

- **Two concurrent MuJoCo sims, unverified** — see Fleet model section;
  first implementation task should be a standalone spike proving this
  works before anything else in this spec is built on top of it.
- **Supabase write latency inside task_engine's tick loop** — if writes
  ever take long enough to noticeably slow the 5Hz tick (unlikely for
  small upserts, but unverified), the mitigation is to move state
  mirroring to a separate thread within task_engine rather than
  blocking the physics tick loop — not a redesign, a follow-up
  optimization if it's actually observed.
- **`get_robot_state` → `get_fleet_state` is a breaking tool-schema
  change** — anything relying on the old single-robot shape (none
  currently, but worth stating) needs updating alongside this.
