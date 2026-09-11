# Inventory, Ordering & Fleet Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the voice agent a real inventory/menu, price+dietary
conversation for food orders, a human-escalation path for non-delivery
requests, and a two-robot fleet with human-confirmed loading/collection
steps instead of today's single-robot, timer-driven model.

**Architecture:** Supabase (Postgres) is the shared data store. The
orchestrator (Process 1) keeps a local, periodically-refreshed inventory
cache so tool handlers never hit the network in the hot path; all writes
from tool handlers are fire-and-forget. `task_engine` (Process 2) owns
two `DeliveryBotSimulator` instances, assigns queued tasks to whichever
robot is idle, and every ~1s polls Supabase for human-confirmation
events and mirrors its own state back — the only place Supabase touches
task_engine's tick loop, which is not latency-sensitive the way tool
handlers are.

**Tech Stack:** Python (existing), `supabase` (official `supabase-py`
client, both processes get their own client instance), Supabase Postgres
+ RLS. No new frameworks.

**Spec:** `docs/superpowers/specs/2026-09-11-inventory-tooling-fleet-design.md`

## Global Constraints

- Tool handlers in `orchestrator/tools.py` return in <100ms, no
  exceptions — no awaited Supabase network call in that path (CLAUDE.md
  constraint 2). Reads come from the local cache; writes are
  fire-and-forget via `asyncio.get_running_loop().run_in_executor`.
- `task_engine` never becomes aware of inventory/pricing concepts —
  validation happens entirely in `orchestrator/tools.py` before a
  command is ever enqueued.
- Voice-triggered commands (dispatch/amend/recall) stay on the existing
  direct `cmd_queue` path, unchanged — never routed through Supabase.
  Only human-paced physical-button events (`complete_loading`/
  `complete_collection`) go through the `robot_commands` table.
- Robot ids (`robot_1`, `robot_2`) are static constants in code, not
  looked up from the `robots` table.
- RLS enabled on every table; `anon`/`authenticated` get `select` only;
  all writes use the service-role key from trusted backend processes.
- Two concurrent `DeliveryBotSimulator` instances in one process is
  unverified before this plan — Task 2 proves it before anything else
  depends on it.

---

## Task 1: Apply the Supabase schema

**Files:** none (remote Postgres schema via MCP tools)

**Interfaces:**
- Produces: 5 tables (`inventory_items`, `robots`, `deliveries`,
  `robot_commands`, `frontdesk_escalations`) that every later task reads
  or writes.

- [ ] **Step 1: Apply the migration**

Call the `apply_migration` MCP tool (project already connected — see
`.mcp.json`) with this exact SQL:

```sql
create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null check (category in ('amenity','food','beverage')),
  price numeric(10,2),
  dietary_tags text[] not null default '{}',
  available boolean not null default true,
  stock_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table robots (
  id text primary key,
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
  items jsonb not null,
  phase text not null,
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

alter table inventory_items enable row level security;
alter table robots enable row level security;
alter table deliveries enable row level security;
alter table robot_commands enable row level security;
alter table frontdesk_escalations enable row level security;

create policy "public read" on inventory_items for select to anon, authenticated using (true);
create policy "public read" on robots for select to anon, authenticated using (true);
create policy "public read" on deliveries for select to anon, authenticated using (true);
create policy "public read" on frontdesk_escalations for select to anon, authenticated using (true);
-- robot_commands: no anon/authenticated policy at all — only the
-- service role (which bypasses RLS) reads/writes this table.

insert into robots (id) values ('robot_1'), ('robot_2');
```

- [ ] **Step 2: Verify with a live query**

Call `mcp__supabase__execute_sql` with:
```sql
select id, phase from robots order by id;
```
Expected: two rows, `robot_1` and `robot_2`, both `phase = 'IDLE'`.

- [ ] **Step 3: Run advisors**

Call `mcp__supabase__get_advisors` (type: `security`). Fix any reported
issue before continuing — most likely none, since RLS is enabled with
explicit policies on every table.

- [ ] **Step 4: Get the API URL and service role key for later tasks**

Call `mcp__supabase__get_project_url` and note the URL. Get the service
role key from the Supabase dashboard (Project Settings → API) — this
cannot be fetched via MCP (it's a secret), the user needs to provide it
for `.env` in Task 3.

- [ ] **Step 5: Commit**

Nothing to commit yet (remote-only change) — note the applied migration
in the next task's commit message instead.

---

## Task 2: Verify two concurrent simulators (spike — do not skip)

**Files:** none (throwaway script, not committed)

**Interfaces:**
- Produces: confidence that Task 6's fleet rewrite is buildable as
  designed. If this fails, STOP and report back before continuing —
  the fallback (two separate processes) is a real architecture change
  that needs a conversation, not a silent workaround.

- [ ] **Step 1: Write and run the spike script**

Save to your scratchpad (not the repo) as `dual_sim_check.py`:

```python
import sys
import time

sys.path.insert(0, "/Users/johnnytan5/Downloads/Concierge/sim")
from concierge_sim import DeliveryBotSimulator

MODEL = "/Users/johnnytan5/Downloads/Concierge/sim/delivery_bot_v2.xml"

sim_a = DeliveryBotSimulator(MODEL)
sim_b = DeliveryBotSimulator(MODEL)
sim_a.start(headless=True)
sim_b.start(headless=True)

try:
    sim_a.drive(v=0.1, omega=0.0)
    sim_b.drive(v=-0.1, omega=0.0)  # opposite direction, so we can tell them apart
    time.sleep(2.0)

    xa, ya = sim_a.pull_status().base.xy
    xb, yb = sim_b.pull_status().base.xy
    print(f"sim_a xy: ({xa:.3f}, {ya:.3f})")
    print(f"sim_b xy: ({xb:.3f}, {yb:.3f})")

    assert xa > 0.05, f"sim_a should have moved forward, got x={xa}"
    assert xb < -0.05, f"sim_b should have moved backward, got x={xb}"
    print("DUAL SIM CHECK OK — two concurrent simulators work independently")
finally:
    sim_a.stop()
    sim_b.stop()
```

Run: `.venv/bin/python /path/to/scratchpad/dual_sim_check.py`

Expected: `DUAL SIM CHECK OK` printed, both assertions pass, no
exceptions, no hang on shutdown.

- [ ] **Step 2: If it fails**

Stop. Do not proceed to Task 6. Report the exact failure (exception,
hang, or one sim's movement affecting the other) — this is a real
architectural risk the spec flagged, not something to work around
inline.

---

## Task 3: `orchestrator/inventory.py` — cache, lookup, fire-and-forget writes

**Files:**
- Create: `orchestrator/inventory.py`
- Modify: `requirements.txt` (add `supabase`)
- Modify: `.env.example` (add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
- Modify: `.env` (add real values — not committed, ask the user for the
  service role key from Task 1 Step 4 if not already provided)

**Interfaces:**
- Consumes: nothing from earlier tasks except the live schema (Task 1).
- Produces: `lookup_items(names: list[str]) -> list[dict]`,
  `all_items() -> list[dict]`, `refresh_cache_sync()`,
  `start_refresh_loop()` (async), `decrement_stock(item_names: list[str])`,
  `insert_delivery(task: dict)`, `insert_escalation(reason: str, room:
  str | None)` — all used by Task 4's `orchestrator/tools.py` changes.
  Each item dict from `lookup_items`/`all_items` has keys: `name`,
  `category`, `price`, `dietary_tags`, `available`, `in_stock`.

- [ ] **Step 1: Add the dependency and env vars**

Add to `requirements.txt`, in the "Orchestrator (Process 1)" section:
```
supabase
```

Add to `.env.example`, after the OpenRouter section:
```
# Supabase — inventory/menu, fleet state, escalations. Service role key
# (not anon/publishable) since orchestrator and task_engine are trusted
# backend processes writing past RLS. Get it from the dashboard: Project
# Settings -> API -> service_role key.
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Add the real values to `.env` (ask the user for the service role key if
you don't have it from Task 1 Step 4 — never print it once you do).

Run: `uv pip install --python .venv -r requirements.txt`
Expected: `supabase` and its dependencies install cleanly.

- [ ] **Step 2: Write `orchestrator/inventory.py`**

```python
"""Local inventory cache + fire-and-forget Supabase writes for Process 1.

Tool handlers in orchestrator/tools.py read via lookup_items()/
all_items() — instant, local, no network — and never await a Supabase
call before returning tool.result (CLAUDE.md constraint 2). The cache is
refreshed periodically by start_refresh_loop() (call once as an asyncio
task alongside the main WS loop); writes go out via run_in_executor so a
slow Supabase response can never block the event loop.
"""
import asyncio
import os

from supabase import create_client, Client

REFRESH_SECONDS = 30.0  # staleness window for admin-edited inventory —
                          # fine for a hotel menu, avoids a second async
                          # subsystem (Realtime) this project doesn't need yet

_client: Client | None = None
_cache: dict[str, dict] = {}  # name.lower() -> raw inventory_items row


def _get_client() -> Client:
    global _client
    if _client is None:
        _client = create_client(
            os.environ["SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        )
    return _client


def refresh_cache_sync():
    """Blocking network call — only call via run_in_executor, never
    directly from the asyncio event loop."""
    global _cache
    resp = _get_client().table("inventory_items").select("*").execute()
    _cache = {row["name"].lower(): row for row in resp.data}


async def start_refresh_loop():
    """Run as an asyncio task: `asyncio.create_task(start_refresh_loop())`."""
    loop = asyncio.get_running_loop()
    while True:
        await loop.run_in_executor(None, refresh_cache_sync)
        await asyncio.sleep(REFRESH_SECONDS)


def _to_public(row: dict) -> dict:
    return {
        "name": row["name"],
        "category": row["category"],
        "price": row["price"],
        "dietary_tags": row["dietary_tags"],
        "available": row["available"],
        "in_stock": row["stock_count"] is None or row["stock_count"] > 0,
    }


def lookup_items(names: list[str]) -> list[dict]:
    """Local cache only — instant. Unknown names come back with
    available=False rather than being omitted, so a caller can report
    "not offered" instead of silently saying nothing."""
    out = []
    for name in names:
        row = _cache.get(name.lower())
        if row is None:
            out.append({"name": name, "category": None, "price": None,
                        "dietary_tags": [], "available": False, "in_stock": False})
        else:
            out.append(_to_public(row))
    return out


def all_items() -> list[dict]:
    return [_to_public(row) for row in _cache.values()]


def decrement_stock(item_names: list[str]):
    """Fire-and-forget: submitted to a thread pool, not awaited."""
    def _do():
        for name in item_names:
            row = _cache.get(name.lower())
            if row and row.get("stock_count") is not None:
                _get_client().table("inventory_items").update(
                    {"stock_count": max(row["stock_count"] - 1, 0)}
                ).eq("id", row["id"]).execute()
    asyncio.get_running_loop().run_in_executor(None, _do)


def insert_delivery(task: dict):
    def _do():
        _get_client().table("deliveries").insert({
            "task_id": task["task_id"],
            "room": task["room"],
            "items": task["items"],
            "phase": task["phase"],
            "priority": task["priority"],
        }).execute()
    asyncio.get_running_loop().run_in_executor(None, _do)


def insert_escalation(reason: str, room: str | None):
    def _do():
        _get_client().table("frontdesk_escalations").insert(
            {"reason": reason, "room": room}
        ).execute()
    asyncio.get_running_loop().run_in_executor(None, _do)


if __name__ == "__main__":
    # ponytail: real Supabase, not a mock — this is the actual
    # integration point. Requires Task 1's schema + real .env values.
    from dotenv import load_dotenv
    load_dotenv()

    def demo():
        refresh_cache_sync()
        print(f"cache loaded: {len(_cache)} items")

        result = lookup_items(["definitely_not_a_real_item_xyz"])
        assert result[0]["available"] is False
        assert result[0]["in_stock"] is False
        print("unknown-item lookup OK")

        print("inventory self-check OK (schema + cache read confirmed live)")

    demo()
```

- [ ] **Step 3: Run the self-check**

Run: `.venv/bin/python -m orchestrator.inventory`
Expected: `inventory self-check OK ...` printed. (The cache will be empty
— 0 items — since no rows exist yet; that's fine, this only proves the
connection and lookup logic work. Seed rows come in Task 9.)

- [ ] **Step 4: Commit**

```bash
git add orchestrator/inventory.py requirements.txt .env.example
git commit -m "Add orchestrator inventory cache + Supabase schema (Task 1+3)

Applies the 5-table Supabase schema (inventory_items, robots,
deliveries, robot_commands, frontdesk_escalations) and adds the
orchestrator-side local cache: reads are instant/local (constraint 2),
writes are fire-and-forget via run_in_executor.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 4: `orchestrator/tools.py` — check_menu, dispatch validation, escalation, fleet state

**Files:**
- Modify: `orchestrator/tools.py` (whole file — this task rewrites most
  of it against the current version read at plan-writing time)

**Interfaces:**
- Consumes: `orchestrator.inventory.lookup_items`,
  `orchestrator.inventory.all_items`,
  `orchestrator.inventory.decrement_stock`,
  `orchestrator.inventory.insert_delivery`,
  `orchestrator.inventory.insert_escalation` (Task 3).
- Produces: `SESSION_TOOLS` (updated tool schema, 8 tools now),
  `ToolHandlers` with `check_menu`, `dispatch_delivery` (new return
  shape), `escalate_to_frontdesk`, `get_fleet_state` (replaces
  `get_robot_state`) — all consumed by `orchestrator/agent.py`
  unchanged (it just calls `handlers.dispatch(name, arguments)`, no
  changes needed there).

- [ ] **Step 1: Replace the `SESSION_TOOLS` list**

In `orchestrator/tools.py`, replace the `dispatch_delivery` and
`get_robot_state` entries and add three new ones. The full new
`SESSION_TOOLS` list:

```python
SESSION_TOOLS = [
    {
        "type": "function",
        "name": "check_menu",
        "description": "Look up price, dietary tags, and availability for one or more items (or the whole menu if none given).",
        "parameters": {
            "type": "object",
            "properties": {
                "items": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
    {
        "type": "function",
        "name": "dispatch_delivery",
        "description": "Send a delivery robot to a room with the given items. Unavailable items are reported back, not sent.",
        "parameters": {
            "type": "object",
            "properties": {
                "room": {"type": "string", "description": "Room number, e.g. '1204'."},
                "items": {"type": "array", "items": {"type": "string"}},
                "priority": {"type": "string", "enum": ["normal", "urgent"]},
            },
            "required": ["room", "items"],
        },
    },
    {
        "type": "function",
        "name": "check_delivery_status",
        "description": "Look up the phase, position, and ETA of a task by id or room.",
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "room": {"type": "string"},
            },
        },
    },
    {
        "type": "function",
        "name": "amend_delivery",
        "description": "Add or remove items, or change the destination room, of a task already in flight.",
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "add": {"type": "array", "items": {"type": "string"}},
                "remove": {"type": "array", "items": {"type": "string"}},
                "new_room": {"type": "string"},
            },
            "required": ["task_id"],
        },
    },
    {
        "type": "function",
        "name": "recall_robot",
        "description": "Call the robot back to the desk mid-task.",
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": ["task_id", "reason"],
        },
    },
    {
        "type": "function",
        "name": "get_fleet_state",
        "description": "Current status of every robot: phase, room, active task, battery.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "announce_arrival",
        "description": "Mark a delivery as announced to the guest (chime/message played at the door).",
        "parameters": {
            "type": "object",
            "properties": {"room": {"type": "string"}},
            "required": ["room"],
        },
    },
    {
        "type": "function",
        "name": "escalate_to_frontdesk",
        "description": "Route a non-delivery request (late checkout, lost card, billing, etc.) to a human front-desk staff member.",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {"type": "string", "description": "What the guest needs, in plain language."},
            },
            "required": ["reason"],
        },
    },
]
```

- [ ] **Step 2: Add the import**

At the top of `orchestrator/tools.py`, add:
```python
from orchestrator import inventory
```

- [ ] **Step 3: Add `check_menu`, change `dispatch_delivery`, add `escalate_to_frontdesk`, rename `get_robot_state`**

Replace the `dispatch_delivery` and `get_robot_state` methods on
`ToolHandlers`, and add `check_menu` + `escalate_to_frontdesk`:

```python
    def check_menu(self, items=None):
        if items:
            return inventory.lookup_items(items)
        return inventory.all_items()

    def dispatch_delivery(self, room, items, priority="normal"):
        looked_up = inventory.lookup_items(items)
        dispatched = [i for i in looked_up if i["available"] and i["in_stock"]]
        unavailable = [
            {"name": i["name"], "reason": "not_offered" if i["category"] is None
                                            or not i["available"] else "out_of_stock"}
            for i in looked_up if not (i["available"] and i["in_stock"])
        ]

        if not dispatched:
            return {"task_id": None, "dispatched_items": [], "unavailable_items": unavailable}

        task_id = uuid.uuid4().hex[:8]
        item_names = [i["name"] for i in dispatched]
        self._q.put({"cmd": "dispatch", "task_id": task_id, "room": room,
                     "items": item_names, "priority": priority})

        inventory.decrement_stock(item_names)
        inventory.insert_delivery({"task_id": task_id, "room": room, "items": item_names,
                                    "phase": "QUEUED", "priority": priority})

        return {"task_id": task_id, "eta_seconds": BASE_ETA_SECONDS,
                "dispatched_items": dispatched, "unavailable_items": unavailable}

    def get_fleet_state(self):
        robots = self._state.get("robots", {})
        return {"robots": [
            {"robot_id": rid, "phase": r.get("phase"), "current_task_id": r.get("current_task"),
             "battery": r.get("battery", 100.0), "pose_frac": r.get("pose_frac", 0.0)}
            for rid, r in robots.items()
        ]}

    def escalate_to_frontdesk(self, reason):
        inventory.insert_escalation(reason, None)
        return {"ack": True}
```

Remove the old `get_robot_state` method entirely (replaced by
`get_fleet_state` above — reads `self._state["robots"]`, the new
multi-robot shape Task 6 produces, not the old `self._state["robot"]`
singular key).

- [ ] **Step 4: Update the self-check**

The existing `if __name__ == "__main__":` block's `demo()` references
`get_robot_state`-shaped state (`state = {"tasks": {}, "robot": {...}}`)
and the old `dispatch_delivery` return shape. Replace the whole `demo()`
function:

```python
    def demo():
        q = _FakeQueue()
        state = {"tasks": {}, "robots": {"robot_1": {"phase": "IDLE", "pose_frac": 0.0,
                                                        "current_task": None, "battery": 100.0}}}
        h = ToolHandlers(q, state)

        # fake inventory cache directly, no live Supabase needed for this check
        inventory._cache = {
            "towel": {"name": "towel", "category": "amenity", "price": None,
                       "dietary_tags": [], "available": True, "stock_count": None},
            "nasi lemak": {"name": "nasi lemak", "category": "food", "price": 8.0,
                             "dietary_tags": ["halal"], "available": True, "stock_count": 3},
            "toothbrush": {"name": "toothbrush", "category": "amenity", "price": None,
                             "dietary_tags": [], "available": False, "stock_count": 0},
        }

        menu = h.dispatch("check_menu", {"items": ["nasi lemak"]})
        assert menu[0]["price"] == 8.0 and "halal" in menu[0]["dietary_tags"]

        result = h.dispatch("dispatch_delivery",
                             {"room": "1204", "items": ["towel", "toothbrush"]})
        assert result["task_id"] is not None
        assert [i["name"] for i in result["dispatched_items"]] == ["towel"]
        assert result["unavailable_items"][0]["name"] == "toothbrush"
        assert q.items[-1]["cmd"] == "dispatch"
        assert q.items[-1]["items"] == ["towel"]  # only the valid item reached task_engine

        all_unavailable = h.dispatch("dispatch_delivery",
                                       {"room": "1204", "items": ["toothbrush"]})
        assert all_unavailable["task_id"] is None
        assert len(q.items) == 1, "no dispatch command should be enqueued for zero valid items"

        tid = result["task_id"]
        state["tasks"][tid] = {"task_id": tid, "room": "1204", "phase": "EN_ROUTE",
                                "dispatched_at": time.time(), "eta_seconds": 90.0}

        status = h.dispatch("check_delivery_status", {"task_id": tid})
        assert status["phase"] == "EN_ROUTE"

        ack = h.dispatch("recall_robot", {"task_id": tid, "reason": "guest cancelled"})
        assert ack == {"ack": True}
        assert q.items[-1]["cmd"] == "recall"

        fleet = h.dispatch("get_fleet_state", {})
        assert fleet["robots"][0]["robot_id"] == "robot_1"

        esc = h.dispatch("escalate_to_frontdesk", {"reason": "late checkout"})
        assert esc == {"ack": True}

        unknown = h.dispatch("not_a_real_tool", {})
        assert "error" in unknown

        print("tools self-check OK")

    demo()
```

- [ ] **Step 5: Run the self-check**

Run: `.venv/bin/python -m orchestrator.tools`
Expected: `tools self-check OK` printed, no exceptions. This runs fully
offline (fake queue, fake inventory cache set directly on the module) —
no live Supabase needed for this check.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/tools.py
git commit -m "orchestrator/tools.py: check_menu, dispatch validation, escalation, fleet state

dispatch_delivery now validates against the inventory cache and only
enqueues real, in-stock items -- unavailable ones come back in
unavailable_items instead of being silently sent. New check_menu (price/
dietary lookup) and escalate_to_frontdesk tools. get_robot_state renamed
to get_fleet_state, returns an array (Task 6 makes state[\"robots\"] real).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 5: `task_engine/supabase_sync.py` — command polling + state mirroring

**Files:**
- Create: `task_engine/supabase_sync.py`

**Interfaces:**
- Produces: `poll_pending_commands(robot_ids: list[str]) -> list[dict]`
  (each `{id, robot_id, cmd}`), `mark_command_done(command_id: str)`,
  `mirror_robot(robot_id, phase, current_task_id, pose_frac, battery)`,
  `mirror_delivery(task: dict)` — all consumed by Task 6's
  `task_engine/engine.py` changes.

- [ ] **Step 1: Write the module**

```python
"""Supabase read/write glue for Process 2 (task_engine). Called from
task_engine's own tick loop, not from orchestrator's tool handlers —
CLAUDE.md constraint 2 (<100ms) applies to tool handlers, not here, so
plain synchronous Supabase calls are fine in this module.
"""
import os
from datetime import datetime, timezone

from supabase import create_client, Client

_client: Client | None = None


def _get_client() -> Client:
    global _client
    if _client is None:
        _client = create_client(
            os.environ["SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        )
    return _client


def poll_pending_commands(robot_ids: list[str]) -> list[dict]:
    resp = (_get_client().table("robot_commands")
            .select("id,robot_id,cmd")
            .eq("status", "pending")
            .in_("robot_id", robot_ids)
            .execute())
    return resp.data


def mark_command_done(command_id: str):
    _get_client().table("robot_commands").update({
        "status": "done",
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", command_id).execute()


def mirror_robot(robot_id: str, phase: str, current_task_id, pose_frac: float, battery: float):
    _get_client().table("robots").upsert({
        "id": robot_id, "phase": phase, "current_task_id": current_task_id,
        "pose_frac": pose_frac, "battery": battery,
    }).execute()


def mirror_delivery(task: dict):
    _get_client().table("deliveries").upsert({
        "task_id": task["task_id"], "room": task["room"], "items": task["items"],
        "phase": task["phase"], "priority": task["priority"],
    }).execute()


if __name__ == "__main__":
    # ponytail: real Supabase, not a mock. Requires Task 1's schema.
    from dotenv import load_dotenv
    load_dotenv()

    def demo():
        mirror_robot("robot_1", "IDLE", None, 0.0, 100.0)
        row = _get_client().table("robots").select("*").eq("id", "robot_1").execute().data[0]
        assert row["phase"] == "IDLE"

        pending = poll_pending_commands(["robot_1", "robot_2"])
        assert isinstance(pending, list)  # empty is fine — no commands inserted yet

        print("supabase_sync self-check OK (schema + mirror/poll round trip confirmed live)")

    demo()
```

- [ ] **Step 2: Run the self-check**

Run: `.venv/bin/python -m task_engine.supabase_sync`
Expected: `supabase_sync self-check OK ...` printed.

- [ ] **Step 3: Commit**

```bash
git add task_engine/supabase_sync.py
git commit -m "Add task_engine/supabase_sync.py: command polling + state mirroring

Process 2's own Supabase glue -- separate from orchestrator's
inventory.py since task_engine's tick loop isn't on the <100ms
tool-handler hot path, so plain synchronous calls are fine here.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 6a: `task_engine/engine.py` — multi-robot, event-driven phases (no Supabase yet)

**Files:**
- Modify: `task_engine/engine.py` (whole file — rewritten against the
  current version read at plan-writing time)

**Interfaces:**
- Consumes: Task 2's proof that two simulators work concurrently.
- Produces: `ROBOT_IDS`, `_advance(sim, task, now, confirmed=False,
  ...)` (new `confirmed` param — human-confirmation flag for this tick),
  `run(cmd_queue, state)` writing `state["robots"]` (dict of robot_id ->
  status) instead of the old singular `state["robot"]` — this is what
  Task 4's `get_fleet_state` reads. Task 6b adds Supabase polling/mirror
  calls on top of this without changing the phase-transition logic
  itself.

- [ ] **Step 1: Replace the module**

Replace `task_engine/engine.py` in full:

```python
"""Process 2 — task FSM + navigation, per ARCHITECTURE.md.

Runs in its own process, owning TWO DeliveryBotSimulator instances (one
per robot) — never touched from the orchestrator (Process 1), per
CLAUDE.md constraint 1. `cmd_queue` carries voice-triggered commands
from the orchestrator (dispatch/amend/recall/announce) on the existing
direct path; human-confirmation events (complete_loading/
complete_collection, from a robot's own screen) arrive separately via
Supabase polling (see Task 6b / supabase_sync.py) since they originate
from a different process. `state` is a multiprocessing.Manager() dict
the orchestrator reads directly for check_delivery_status/
get_fleet_state — no round trip through the queue for reads (CLAUDE.md
constraint 2).

ponytail: there's no real corridor/waypoint graph yet
(sim/scene_corridor.xml and task_engine/nav.py are both still empty).
Until then, "desk to room" is a fixed straight-line distance
(NOMINAL_TRIP_METERS) — drive forward, open the door on arrival, wait
for guest confirmation, close the door, drive straight back. Swap
`_advance`'s straight-line distance math for nav.py's pure-pursuit +
per-room waypoint distance once that exists; the phase/state contract
below doesn't need to change when it does.
"""
import os
import queue
import sys
import time
import uuid

_SIM_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "sim"))
sys.path.insert(0, _SIM_DIR)
from concierge_sim import DeliveryBotSimulator  # noqa: E402

MODEL_PATH = os.path.join(_SIM_DIR, "delivery_bot_v2.xml")

ROBOT_IDS = ["robot_1", "robot_2"]
TICK_HZ = 5.0

DRIVE_SPEED_MPS = 0.11
NOMINAL_TRIP_METERS = 10.0
BASE_ETA_SECONDS = NOMINAL_TRIP_METERS / DRIVE_SPEED_MPS
ORIGIN_XY = (0.0, 0.0)


def _new_robot():
    return {"phase": "IDLE", "pose_frac": 0.0, "battery": 100.0, "current_task": None}


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
        "eta_seconds": BASE_ETA_SECONDS,
        "announced": False,
        "reason": None,
    }


def _handle(cmd, tasks):
    kind = cmd.get("cmd")

    if kind == "dispatch":
        tasks[cmd["task_id"]] = _new_task(
            cmd["task_id"], cmd["room"], cmd.get("items", []),
            cmd.get("priority", "normal"))

    elif kind == "amend":
        t = tasks.get(cmd["task_id"])
        if not t or t["phase"] in ("ARRIVED", "RETURNING", "DONE", "AT_DESK"):
            return
        items = (set(t["items"]) - set(cmd.get("remove") or [])) | set(cmd.get("add") or [])
        t["items"] = sorted(items)
        if cmd.get("new_room"):
            t["room"] = cmd["new_room"]
        if t["phase"] == "EN_ROUTE":
            t["dispatched_at"] = time.time()
        tasks[cmd["task_id"]] = t

    elif kind == "recall":
        t = tasks.get(cmd["task_id"])
        if not t:
            return
        if t["phase"] == "COLLECTING":
            # never left the desk -- no motion needed, just cancel
            t["phase"] = "AT_DESK"
            t["reason"] = cmd.get("reason")
            tasks[cmd["task_id"]] = t
        elif t["phase"] == "EN_ROUTE":
            t["phase"] = "RECALLED"
            t["dispatched_at"] = time.time()
            t["reason"] = cmd.get("reason")
            tasks[cmd["task_id"]] = t

    elif kind == "announce":
        t = tasks.get(cmd["task_id"])
        if t:
            t["announced"] = True
            tasks[cmd["task_id"]] = t


def _dist_from_origin(sim: DeliveryBotSimulator) -> float:
    x, y = sim.pull_status().base.xy
    return ((x - ORIGIN_XY[0]) ** 2 + (y - ORIGIN_XY[1]) ** 2) ** 0.5


def _drive_home(sim, task, now, terminal_phase, trip_meters, drive_speed, arrival_tolerance_m):
    sim.drive(v=-drive_speed, omega=0.0)
    remaining = _dist_from_origin(sim)
    frac = min(remaining / trip_meters, 1.0)
    if remaining <= arrival_tolerance_m:
        sim.stop_base()
        task["phase"] = terminal_phase
    return task, frac


def _advance(sim: DeliveryBotSimulator, task, now, confirmed: bool = False,
             trip_meters: float = NOMINAL_TRIP_METERS,
             drive_speed: float = DRIVE_SPEED_MPS,
             arrival_tolerance_m: float = 0.05):
    """`confirmed` is this tick's human-confirmation flag for this
    task's robot (complete_loading while COLLECTING, complete_collection
    while ARRIVED) — see module docstring for where it comes from.
    ponytail: no timeout fallback yet if a confirmation never arrives
    (robot waits at COLLECTING/ARRIVED forever) -- acceptable for the
    demo, flagged as a follow-up, not silently ignored."""
    if task["phase"] == "COLLECTING":
        if confirmed:
            task["phase"] = "EN_ROUTE"
            task["dispatched_at"] = now
        return task, 0.0

    if task["phase"] == "EN_ROUTE":
        sim.drive(v=drive_speed, omega=0.0)
        frac = min(_dist_from_origin(sim) / trip_meters, 1.0)
        if frac >= 1.0:
            sim.stop_base()
            sim.open_door()
            task["phase"] = "ARRIVED"
            task["arrived_at"] = now
        return task, frac

    if task["phase"] == "ARRIVED":
        if confirmed:
            sim.close_door()
            task["phase"] = "RETURNING"
        return task, 1.0

    if task["phase"] == "RETURNING":
        return _drive_home(sim, task, now, "DONE", trip_meters, drive_speed, arrival_tolerance_m)

    if task["phase"] == "RECALLED":
        return _drive_home(sim, task, now, "AT_DESK", trip_meters, drive_speed, arrival_tolerance_m)

    return task, None  # QUEUED / DONE / AT_DESK — no motion


def run(cmd_queue, state):
    """Entry point for Process 2. Task 6b adds Supabase polling/mirror
    calls inside this loop; the phase-transition logic above is
    unchanged by that."""
    sims = {rid: DeliveryBotSimulator(MODEL_PATH) for rid in ROBOT_IDS}
    for sim in sims.values():
        sim.start(headless=True)

    tasks = {}
    robots = {rid: _new_robot() for rid in ROBOT_IDS}
    state["tasks"] = {}
    state["robots"] = {rid: dict(r) for rid, r in robots.items()}

    tick = 1.0 / TICK_HZ
    try:
        while True:
            while True:
                try:
                    _handle(cmd_queue.get_nowait(), tasks)
                except queue.Empty:
                    break

            now = time.time()
            confirmed = {rid: False for rid in ROBOT_IDS}  # Task 6b fills this from Supabase

            idle_ids = [rid for rid, r in robots.items() if r["phase"] == "IDLE"]
            for tid, t in tasks.items():
                if t["phase"] == "QUEUED" and idle_ids:
                    rid = idle_ids.pop(0)
                    t["phase"] = "COLLECTING"
                    tasks[tid] = t
                    robots[rid]["current_task"] = tid
                    robots[rid]["phase"] = "COLLECTING"

            for rid, r in robots.items():
                tid = r["current_task"]
                if tid is None:
                    continue
                tasks[tid], frac = _advance(sims[rid], tasks[tid], now, confirmed[rid])
                if frac is not None:
                    r["pose_frac"] = frac
                r["phase"] = tasks[tid]["phase"]
                if tasks[tid]["phase"] in ("DONE", "AT_DESK"):
                    r["current_task"] = None
                    r["phase"] = "IDLE"

            state["tasks"] = dict(tasks)
            state["robots"] = {rid: dict(r) for rid, r in robots.items()}
            time.sleep(tick)
    finally:
        for sim in sims.values():
            sim.stop()


if __name__ == "__main__":
    # ponytail: real physics, two real sims — this is the actual
    # integration point. `confirmed=True` passed directly here stands in
    # for Task 6b's Supabase polling, which this self-check doesn't need.
    def demo():
        sims = {rid: DeliveryBotSimulator(MODEL_PATH) for rid in ROBOT_IDS}
        for sim in sims.values():
            sim.start(headless=True)
        try:
            trip_m, speed, tol_m = 0.05, 0.05, 0.005
            tasks = {}

            # two tasks at once, one per robot, prove they run independently
            _handle({"cmd": "dispatch", "task_id": "t1", "room": "1204", "items": ["towel"]}, tasks)
            _handle({"cmd": "dispatch", "task_id": "t2", "room": "0803", "items": ["nasi lemak"]}, tasks)
            tasks["t1"]["phase"] = "COLLECTING"
            tasks["t2"]["phase"] = "COLLECTING"

            # complete_loading for both -> EN_ROUTE
            tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(), confirmed=True,
                                        trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
            tasks["t2"], _ = _advance(sims["robot_2"], tasks["t2"], time.time(), confirmed=True,
                                        trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
            assert tasks["t1"]["phase"] == "EN_ROUTE"
            assert tasks["t2"]["phase"] == "EN_ROUTE"

            for _ in range(200):
                tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(),
                                            trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
                tasks["t2"], _ = _advance(sims["robot_2"], tasks["t2"], time.time(),
                                            trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t1"]["phase"] == "ARRIVED" and tasks["t2"]["phase"] == "ARRIVED":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "ARRIVED", tasks["t1"]
            assert tasks["t2"]["phase"] == "ARRIVED", tasks["t2"]

            # both robots should have actually moved independently
            d1 = _dist_from_origin(sims["robot_1"])
            d2 = _dist_from_origin(sims["robot_2"])
            assert d1 > tol_m and d2 > tol_m, (d1, d2)

            # complete_collection -> RETURNING -> drive home -> DONE
            tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(), confirmed=True,
                                        trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
            assert tasks["t1"]["phase"] == "RETURNING"
            for _ in range(200):
                tasks["t1"], _ = _advance(sims["robot_1"], tasks["t1"], time.time(),
                                            trip_meters=trip_m, drive_speed=speed, arrival_tolerance_m=tol_m)
                if tasks["t1"]["phase"] == "DONE":
                    break
                time.sleep(0.05)
            assert tasks["t1"]["phase"] == "DONE", tasks["t1"]

            # recall while still COLLECTING -> immediate AT_DESK, no motion
            _handle({"cmd": "dispatch", "task_id": "t3", "room": "1500", "items": ["towel"]}, tasks)
            tasks["t3"]["phase"] = "COLLECTING"
            _handle({"cmd": "recall", "task_id": "t3", "reason": "guest changed mind"}, tasks)
            assert tasks["t3"]["phase"] == "AT_DESK", tasks["t3"]

            print("engine self-check OK (two concurrent robots: dispatch, collect, "
                  "arrive, collect-confirm, return, and collecting-phase recall)")
        finally:
            for sim in sims.values():
                sim.stop()

    demo()
```

- [ ] **Step 2: Run the self-check**

Run: `.venv/bin/python task_engine/engine.py`
Expected: `engine self-check OK ...` printed. This may take longer than
the old single-robot check (two sims running).

- [ ] **Step 3: Commit**

```bash
git add task_engine/engine.py
git commit -m "task_engine: two-robot fleet, event-driven collecting/arrived phases

Replaces the single-robot model with ROBOT_IDS-driven dict of
simulators. COLLECTING and ARRIVED no longer auto-transition on a
timer -- they wait for a 'confirmed' flag (Task 6b wires this to real
robot_commands polling). state[\"robots\"] replaces the old singular
state[\"robot\"] key.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 6b: Wire `task_engine/engine.py` to real Supabase polling + mirroring

**Files:**
- Modify: `task_engine/engine.py`

**Interfaces:**
- Consumes: Task 5's `supabase_sync.poll_pending_commands`,
  `supabase_sync.mark_command_done`, `supabase_sync.mirror_robot`,
  `supabase_sync.mirror_delivery`.
- Produces: same `run()` signature as Task 6a, now actually
  polling/mirroring every 5th tick (~1s at 5Hz).

- [ ] **Step 1: Add the import and polling/mirroring calls to `run()`**

Add near the top imports:
```python
from task_engine import supabase_sync
```

Replace the `run()` function's body with this version (only the parts
inside the `while True:` loop change — add a `tick_count` counter, real
polling instead of the placeholder `confirmed = {rid: False ...}` line,
and mirroring at the end of each loop iteration):

```python
def run(cmd_queue, state):
    sims = {rid: DeliveryBotSimulator(MODEL_PATH) for rid in ROBOT_IDS}
    for sim in sims.values():
        sim.start(headless=True)

    tasks = {}
    robots = {rid: _new_robot() for rid in ROBOT_IDS}
    state["tasks"] = {}
    state["robots"] = {rid: dict(r) for rid, r in robots.items()}

    tick = 1.0 / TICK_HZ
    tick_count = 0
    try:
        while True:
            while True:
                try:
                    _handle(cmd_queue.get_nowait(), tasks)
                except queue.Empty:
                    break

            now = time.time()
            tick_count += 1

            confirmed = {rid: False for rid in ROBOT_IDS}
            sync_this_tick = (tick_count % 5 == 0)  # ~once per second at 5Hz, not every tick
            if sync_this_tick:
                for cmd_row in supabase_sync.poll_pending_commands(ROBOT_IDS):
                    confirmed[cmd_row["robot_id"]] = True
                    supabase_sync.mark_command_done(cmd_row["id"])

            idle_ids = [rid for rid, r in robots.items() if r["phase"] == "IDLE"]
            for tid, t in tasks.items():
                if t["phase"] == "QUEUED" and idle_ids:
                    rid = idle_ids.pop(0)
                    t["phase"] = "COLLECTING"
                    tasks[tid] = t
                    robots[rid]["current_task"] = tid
                    robots[rid]["phase"] = "COLLECTING"

            for rid, r in robots.items():
                tid = r["current_task"]
                if tid is None:
                    continue
                tasks[tid], frac = _advance(sims[rid], tasks[tid], now, confirmed[rid])
                if frac is not None:
                    r["pose_frac"] = frac
                r["phase"] = tasks[tid]["phase"]
                if tasks[tid]["phase"] in ("DONE", "AT_DESK"):
                    r["current_task"] = None
                    r["phase"] = "IDLE"

            state["tasks"] = dict(tasks)
            state["robots"] = {rid: dict(r) for rid, r in robots.items()}

            if sync_this_tick:
                for rid, r in robots.items():
                    supabase_sync.mirror_robot(rid, r["phase"], r["current_task"],
                                                 r["pose_frac"], r["battery"])
                for t in tasks.values():
                    supabase_sync.mirror_delivery(t)

            time.sleep(tick)
    finally:
        for sim in sims.values():
            sim.stop()
```

- [ ] **Step 2: Verify the self-check still passes**

Task 6a's `demo()` doesn't call `run()` (it calls `_advance` directly,
matching the existing pattern), so it needs no changes and should still
pass unmodified. Run: `.venv/bin/python task_engine/engine.py`
Expected: `engine self-check OK ...` printed, same as Task 6a — this
step exists to confirm the `run()` edit didn't break the module import
or introduce a syntax error, not to test the new Supabase wiring
directly (that's Task 9's job, against the real running process).

- [ ] **Step 3: Commit**

```bash
git add task_engine/engine.py
git commit -m "task_engine: wire real Supabase command polling + state mirroring

run() now polls robot_commands (~1/sec, not every tick) for
complete_loading/complete_collection events and mirrors robots/
deliveries state back to Supabase -- the confirmed dict Task 6a left as
a placeholder is now real.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 7: Update `CLAUDE.md`'s tool schema table

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none (documentation only)

- [ ] **Step 1: Replace the tool schema table**

Find the `## Tool schema` section's table in `CLAUDE.md` and replace it
with:

```markdown
| Tool | Args | Returns | Blocking? |
|---|---|---|---|
| `check_menu` | `items[]?` | list of `{name, category, price, dietary_tags, available, in_stock}` | No |
| `dispatch_delivery` | `room, items[], priority` | `task_id, eta_seconds, dispatched_items[], unavailable_items[]` | No |
| `check_delivery_status` | `task_id \| room` | `phase, position, eta` | No |
| `amend_delivery` | `task_id, add[], remove[], new_room` | updated task | No |
| `recall_robot` | `task_id, reason` | `ack` | No |
| `get_fleet_state` | — | `robots: [{robot_id, phase, current_task_id, battery, pose_frac}, ...]` | No |
| `announce_arrival` | `room` | `ack` | No |
| `escalate_to_frontdesk` | `reason` | `ack` | No |
```

Also update the header note above the table if it references the old
6-tool count or `get_robot_state` by name — search for both and fix any
mention.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md: update tool schema table for inventory/fleet tooling

get_robot_state -> get_fleet_state, dispatch_delivery's new return
shape, check_menu and escalate_to_frontdesk added. Matches
orchestrator/tools.py from Task 4.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 9: Live end-to-end integration check

**Files:** none (throwaway script, not committed — same pattern this
project has used for every prior live integration check)

**Interfaces:** exercises the real, wired-together system from Tasks
1-6b: real Supabase, real `ToolHandlers`, real `task_engine.run()` in a
real `multiprocessing.Process`, real physics.

- [ ] **Step 1: Seed real inventory rows**

Call `mcp__supabase__execute_sql`:
```sql
insert into inventory_items (name, category, price, dietary_tags, available, stock_count) values
  ('towel', 'amenity', null, '{}', true, null),
  ('toothbrush', 'amenity', null, '{}', false, 0),
  ('nasi lemak', 'food', 8.00, '{halal}', true, 3);
```

- [ ] **Step 2: Write and run the integration script**

Save to scratchpad as `fleet_integration_check.py`:

```python
import multiprocessing as mp
import sys
import time

sys.path.insert(0, "/Users/johnnytan5/Downloads/Concierge")


def main():
    from dotenv import load_dotenv
    load_dotenv("/Users/johnnytan5/Downloads/Concierge/.env")

    from orchestrator import inventory
    from orchestrator.tools import ToolHandlers
    from task_engine.engine import run as run_task_engine

    inventory.refresh_cache_sync()
    assert len(inventory._cache) >= 3, "seed rows from Step 1 not found"

    cmd_queue = mp.Queue()
    manager = mp.Manager()
    state = manager.dict()

    proc = mp.Process(target=run_task_engine, args=(cmd_queue, state), daemon=True)
    proc.start()

    try:
        time.sleep(2.0)  # let both sims start
        handlers = ToolHandlers(cmd_queue, state)

        # partial availability: towel real, toothbrush not
        result = handlers.dispatch("dispatch_delivery",
                                     {"room": "1204", "items": ["towel", "toothbrush"]})
        print("dispatch result:", result)
        assert result["task_id"] is not None
        assert [i["name"] for i in result["dispatched_items"]] == ["towel"]
        assert result["unavailable_items"][0]["name"] == "toothbrush"
        task_id = result["task_id"]

        time.sleep(1.0)
        fleet = handlers.dispatch("get_fleet_state", {})
        print("fleet state:", fleet)
        assigned = next((r for r in fleet["robots"] if r["current_task_id"] == task_id), None)
        assert assigned is not None, "task should have been picked up by an idle robot"
        assert assigned["phase"] == "COLLECTING"

        # simulate the robot's own screen: staff presses "complete loading"
        from task_engine import supabase_sync
        supabase_sync._get_client().table("robot_commands").insert(
            {"robot_id": assigned["robot_id"], "cmd": "complete_loading"}
        ).execute()

        time.sleep(2.0)  # a couple sync ticks
        fleet = handlers.dispatch("get_fleet_state", {})
        assigned = next(r for r in fleet["robots"] if r["robot_id"] == assigned["robot_id"])
        print("fleet state after complete_loading:", fleet)
        assert assigned["phase"] == "EN_ROUTE", assigned

        # stock decrement should have landed in Supabase
        row = (supabase_sync._get_client().table("inventory_items")
               .select("stock_count").eq("name", "towel").execute().data[0])
        print("towel stock_count:", row["stock_count"])  # expect None (untracked, not decremented)

        row = (supabase_sync._get_client().table("deliveries")
               .select("*").eq("task_id", task_id).execute().data)
        assert len(row) == 1, "delivery row should have been mirrored"
        print("deliveries row:", row[0])

        print("FLEET INTEGRATION CHECK OK")
    finally:
        proc.terminate()
        proc.join(timeout=2)


if __name__ == "__main__":
    main()
```

Run: `.venv/bin/python /path/to/scratchpad/fleet_integration_check.py`

Expected: `FLEET INTEGRATION CHECK OK` printed, all asserts pass. This
proves the full chain: voice-tool validation -> real dispatch -> real
robot assignment -> real Supabase command polling -> real phase
transition -> real state mirroring back to Supabase.

- [ ] **Step 2: If anything fails**

This is the first time everything runs together — a failure here is
real signal, not a fluke. Use `superpowers:systematic-debugging` (same
discipline this project has used for every live-API surprise so far):
read the actual error, reproduce it, don't guess-fix. Report back rather
than silently patching around an unexplained failure.

- [ ] **Step 3: Clean up the seed data (optional)**

If you want a clean slate for Sub-project B's work, delete the seeded
rows via `execute_sql`:
```sql
delete from deliveries;
delete from robot_commands;
update robots set phase = 'IDLE', current_task_id = null;
```
Leave `inventory_items` seeded — Sub-project B's admin CRUD will want
real rows to demo against.

---

## Self-Review Notes

**Spec coverage:** schema (Task 1), inventory cache + fire-and-forget
writes (Task 3), check_menu/dispatch validation/escalation/fleet state
(Task 4), fleet model + event-driven phases (Task 6a), Supabase command
polling + mirroring (Task 6b), dual-sim risk verified first (Task 2),
tool schema doc sync (Task 7), live end-to-end proof (Task 9). The
spec's `amend_delivery` note ("should reuse the same inventory
validation as dispatch_delivery") is intentionally **not** implemented
in this plan — flagging it here rather than silently dropping it: adding
item-validation to `amend_delivery`'s `add` path is a small, separate
follow-up once this plan's core path is proven live, not bundled into
an already-large Task 4.

**Type/shape consistency:** `lookup_items`/`all_items` return dicts with
`name, category, price, dietary_tags, available, in_stock` throughout —
Task 3 defines it, Task 4 consumes it, Task 9's integration check
exercises it live. `state["robots"]` (dict keyed by robot id) is
produced by Task 6a/6b and consumed by Task 4's `get_fleet_state` and
Task 9's integration check consistently.

**No placeholders:** every step has real, complete code — checked.
