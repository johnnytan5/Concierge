# Admin CRUD + Judge Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live judge-facing dashboard (LangGraph-Studio-style flow
diagram, real events, no polling), an admin page for inventory CRUD, and
per-robot "LED screen" pages for loading/collection confirmation — all
built on Sub-project A's schema and `tool_call_events` log.

**Architecture:** Two new processes. `admin_api/` (FastAPI) holds the
Supabase service-role key and is the only path for any write (admin CRUD,
robot-screen button presses) — Sub-project A's RLS locks
`anon`/`authenticated` out of writes entirely. `dashboard/` (Next.js)
handles every read, subscribing directly to Supabase Realtime with the
public anon/publishable key — no backend round-trip for display.

**Tech Stack:** FastAPI + `supabase-py` (Python, reuses this project's
existing `.venv`/`requirements.txt`). Next.js (App Router) +
`@supabase/supabase-js`, plain CSS (no component library — a fixed
8-node diagram doesn't need one).

**Spec:** `docs/superpowers/specs/2026-09-11-admin-dashboard-design.md`

## Global Constraints

- FastAPI is the **only** thing that writes to Supabase from this
  plan's code — every write uses the service-role key from `.env`
  (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, already present from
  Sub-project A). Next.js never holds that key — only
  `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`, safe to
  expose to the browser.
- Admin endpoints (`/admin/*`) require the `X-Admin-Password` header to
  match `ADMIN_PASSWORD` from `.env`. Robot endpoints
  (`/robot/{id}/complete_loading`, `/robot/{id}/complete_collection`)
  require no auth — physical presence at the robot is the access
  control, per the spec.
- `robot_commands` is never read from the browser — no Realtime
  subscription to it anywhere in this plan (it has no
  `anon`/`authenticated` read policy; Sub-project A's `task_engine`
  polls it directly).
- Anon/publishable key for `dashboard/.env.local`:
  `sb_publishable_ZZS6WNx3tejWPpwHZjeerQ_p8jGD2SW` — fetched live from
  the Supabase project, safe to commit (this is what publishable keys
  are for), but still goes in a gitignored `.env.local` per Next.js
  convention, not hardcoded in source.
- Supabase project URL: `https://hcutwuwlzuspbitllhlw.supabase.co`.

---

## Task 1: `admin_api/` — FastAPI backend (auth, CRUD, robot commands)

**Files:**
- Create: `admin_api/main.py`
- Modify: `requirements.txt` (add `fastapi`, `uvicorn`)
- Modify: `.env.example` (add `ADMIN_PASSWORD`)
- Modify: `.env` (add a real `ADMIN_PASSWORD` value)

**Interfaces:**
- Produces: a FastAPI app on port 8000 exposing `POST /admin/items`,
  `PATCH /admin/items/{item_id}`, `DELETE /admin/items/{item_id}`,
  `POST /robot/{robot_id}/complete_loading`,
  `POST /robot/{robot_id}/complete_collection`. Consumed by Task 4
  (admin page) and Task 5 (robot screens) via plain `fetch()` calls —
  no shared Python interface, this is a network boundary.

- [ ] **Step 1: Add dependencies and the password env var**

Add to `requirements.txt`, in a new section:
```
# Admin API (4th process — admin_api/)
fastapi
uvicorn
```

Add to `.env.example`:
```
# Admin API — shared password for admin CRUD writes (not real auth, see
# docs/superpowers/specs/2026-09-11-admin-dashboard-design.md's Auth
# section for why that's an acceptable tradeoff here).
ADMIN_PASSWORD=
```

Add a real value to `.env` (any string you choose — this is a local
demo password, not a secret with real stakes; do not ask the user for
it, just pick one and use it consistently).

Run: `uv pip install --python .venv -r requirements.txt`

- [ ] **Step 2: Write `admin_api/main.py`**

```python
"""admin_api — FastAPI backend for Sub-project B. The only process on
this side that holds the Supabase service-role key (orchestrator and
task_engine hold their own copies for their own writes, per Sub-project
A). Every admin CRUD write and every robot-screen button press goes
through here, since Sub-project A's RLS locks anon/authenticated out of
writes entirely. Reads (dashboard, admin item list, robot screen status)
go directly from the browser to Supabase via Realtime + the anon key —
this app has no read/GET endpoints at all.
"""
import os

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client

load_dotenv()

ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
ROBOT_IDS = ["robot_1", "robot_2"]

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # hackathon demo scope, see spec's Auth section
    allow_methods=["*"],
    allow_headers=["*"],
)

_client: Client | None = None


def _get_client() -> Client:
    global _client
    if _client is None:
        _client = create_client(
            os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        )
    return _client


def require_admin_password(x_admin_password: str = Header(...)):
    if x_admin_password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="wrong password")


class ItemIn(BaseModel):
    name: str
    category: str
    price: float | None = None
    dietary_tags: list[str] = []
    available: bool = True
    stock_count: int | None = None


class ItemPatch(BaseModel):
    name: str | None = None
    category: str | None = None
    price: float | None = None
    dietary_tags: list[str] | None = None
    available: bool | None = None
    stock_count: int | None = None


@app.post("/admin/items", dependencies=[Depends(require_admin_password)])
def create_item(item: ItemIn):
    resp = _get_client().table("inventory_items").insert(item.model_dump()).execute()
    return resp.data[0]


@app.patch("/admin/items/{item_id}", dependencies=[Depends(require_admin_password)])
def update_item(item_id: str, patch: ItemPatch):
    fields = {k: v for k, v in patch.model_dump().items() if v is not None}
    resp = _get_client().table("inventory_items").update(fields).eq("id", item_id).execute()
    if not resp.data:
        raise HTTPException(status_code=404, detail="item not found")
    return resp.data[0]


@app.delete("/admin/items/{item_id}", dependencies=[Depends(require_admin_password)])
def delete_item(item_id: str):
    _get_client().table("inventory_items").delete().eq("id", item_id).execute()
    return {"ack": True}


@app.post("/robot/{robot_id}/complete_loading")
def complete_loading(robot_id: str):
    if robot_id not in ROBOT_IDS:
        raise HTTPException(status_code=404, detail="unknown robot_id")
    _get_client().table("robot_commands").insert(
        {"robot_id": robot_id, "cmd": "complete_loading"}
    ).execute()
    return {"ack": True}


@app.post("/robot/{robot_id}/complete_collection")
def complete_collection(robot_id: str):
    if robot_id not in ROBOT_IDS:
        raise HTTPException(status_code=404, detail="unknown robot_id")
    _get_client().table("robot_commands").insert(
        {"robot_id": robot_id, "cmd": "complete_collection"}
    ).execute()
    return {"ack": True}
```

- [ ] **Step 3: Run it and verify by hand**

Run in the background: `.venv/bin/uvicorn admin_api.main:app --port 8000 &`

Then, in a separate shell:
```bash
curl -s -X POST http://localhost:8000/admin/items \
  -H "X-Admin-Password: <whatever you put in .env>" \
  -H "Content-Type: application/json" \
  -d '{"name": "test-towel", "category": "amenity"}'
```
Expected: `201`-shaped JSON body echoing the inserted row (with a real
`id`). Then:
```bash
curl -s -X POST http://localhost:8000/admin/items \
  -H "X-Admin-Password: wrong" \
  -H "Content-Type: application/json" \
  -d '{"name": "test-towel-2", "category": "amenity"}'
```
Expected: `{"detail":"wrong password"}`, HTTP 401.

Clean up the test row:
```bash
curl -s -X DELETE http://localhost:8000/admin/items/<the id from the first response> \
  -H "X-Admin-Password: <whatever you put in .env>"
```

Stop the background uvicorn process (`kill %1` or find its PID).

- [ ] **Step 4: Commit**

```bash
git add admin_api/main.py requirements.txt .env.example
git commit -m "Add admin_api: FastAPI backend for admin CRUD + robot commands

Only this process holds the service-role key on the frontend side --
every write (inventory CRUD, robot-screen button presses) goes through
here, since Sub-project A's RLS locks anon/authenticated out of writes
entirely. Verified live: correct row on valid password, 401 on wrong
password, robot command insert.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 2: `dashboard/` scaffold — Next.js, Supabase client, shared Realtime hooks

**Files:**
- Create: `dashboard/` (via `create-next-app`)
- Create: `dashboard/lib/supabase.ts`
- Create: `dashboard/lib/useRealtimeTable.ts`
- Create: `dashboard/lib/useRealtimeEvent.ts`
- Create: `dashboard/.env.local`

**Interfaces:**
- Produces: `supabase` (a configured `SupabaseClient`),
  `useRealtimeTable<T>(table: string, orderBy?: string): T[]` (fetches +
  keeps a table's rows live-updated), `useRealtimeEvent(table: string,
  event?: 'INSERT'|'UPDATE'|'*'): {lastEventAt: number|null, lastPayload:
  any}` (tracks the most recent matching event, for pulse animations) —
  both consumed by Tasks 3, 4, 5.

- [ ] **Step 1: Scaffold the Next.js app**

From the repo root:
```bash
npx create-next-app@latest dashboard --typescript --tailwind --app --no-src-dir --import-alias "@/*" --eslint --use-npm
```
When prompted, accept the defaults. This creates a working, empty
Next.js app at `dashboard/`.

Run: `cd dashboard && npm install @supabase/supabase-js && cd ..`

- [ ] **Step 2: Add the env file**

Create `dashboard/.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=https://hcutwuwlzuspbitllhlw.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_ZZS6WNx3tejWPpwHZjeerQ_p8jGD2SW
```
(`create-next-app` already gitignores `.env*.local` — verify with
`cat dashboard/.gitignore | grep env` before moving on; if it's somehow
missing, add `.env*.local` to `dashboard/.gitignore` yourself.)

- [ ] **Step 3: Write the Supabase client**

Create `dashboard/lib/supabase.ts`:
```typescript
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)
```

- [ ] **Step 4: Write the two shared hooks**

Create `dashboard/lib/useRealtimeTable.ts`:
```typescript
'use client'
import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export function useRealtimeTable<T extends Record<string, any>>(
  table: string,
  orderBy?: string
): T[] {
  const [rows, setRows] = useState<T[]>([])

  useEffect(() => {
    let mounted = true

    async function load() {
      let query = supabase.from(table).select('*')
      if (orderBy) query = query.order(orderBy)
      const { data } = await query
      if (mounted && data) setRows(data as T[])
    }
    load()

    const channel = supabase
      .channel(`realtime:${table}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        load()
      })
      .subscribe()

    return () => {
      mounted = false
      supabase.removeChannel(channel)
    }
  }, [table, orderBy])

  return rows
}
```

Create `dashboard/lib/useRealtimeEvent.ts`:
```typescript
'use client'
import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export function useRealtimeEvent(
  table: string,
  event: 'INSERT' | 'UPDATE' | '*' = '*'
) {
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const [lastPayload, setLastPayload] = useState<any>(null)

  useEffect(() => {
    const channel = supabase
      .channel(`event:${table}:${event}`)
      .on('postgres_changes', { event, schema: 'public', table }, (payload) => {
        setLastEventAt(Date.now())
        setLastPayload((payload as any).new)
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [table, event])

  return { lastEventAt, lastPayload }
}
```

- [ ] **Step 5: Verify the dev server starts clean**

Run: `cd dashboard && npm run dev &` (background), then `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000` after a few seconds.
Expected: `200`. Stop the dev server afterward (`kill %1` or find its PID).

- [ ] **Step 6: Commit**

```bash
git add dashboard/
git commit -m "Scaffold dashboard/: Next.js app + Supabase client + shared Realtime hooks

useRealtimeTable (live-updating row list) and useRealtimeEvent (most
recent matching event, for pulse animations) are the two primitives
every page in this plan builds on -- one Realtime subscription pattern,
not one per page.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 3: Judge dashboard page — flow diagram

**Files:**
- Modify: `dashboard/app/page.tsx`
- Create: `dashboard/components/FlowDiagram.tsx`
- Create: `dashboard/components/FlowDiagram.module.css`

**Interfaces:**
- Consumes: `useRealtimeTable`, `useRealtimeEvent` (Task 2).
- Produces: the `/` page — no interface other tasks depend on (this is
  a leaf page).

- [ ] **Step 1: Write the flow diagram component**

Create `dashboard/components/FlowDiagram.tsx`:
```typescript
'use client'
import { useRealtimeTable } from '@/lib/useRealtimeTable'
import { useRealtimeEvent } from '@/lib/useRealtimeEvent'
import styles from './FlowDiagram.module.css'

type Robot = { id: string; phase: string; current_task_id: string | null }
type ToolEvent = { tool_name: string }

const PHASE_COLOR: Record<string, string> = {
  IDLE: '#9ca3af',
  COLLECTING: '#eab308',
  EN_ROUTE: '#3b82f6',
  ARRIVED: '#22c55e',
  RETURNING: '#3b82f6',
  RECALLED: '#ef4444',
  AT_DESK: '#9ca3af',
}

function isRecent(t: number | null, ms = 1500) {
  return t !== null && Date.now() - t < ms
}

function Node({ label, active, color }: { label: string; active: boolean; color?: string }) {
  return (
    <div
      className={`${styles.node} ${active ? styles.active : ''}`}
      style={color ? { borderColor: color, color } : undefined}
    >
      {label}
    </div>
  )
}

export default function FlowDiagram() {
  const toolEvents = useRealtimeEvent('tool_call_events')
  const robots = useRealtimeTable<Robot>('robots', 'id')
  const inventoryEvent = useRealtimeEvent('inventory_items', 'UPDATE')
  const deliveryEvent = useRealtimeEvent('deliveries', 'INSERT')

  const toolName: string | undefined = toolEvents.lastPayload?.tool_name
  const voiceAgentActive = isRecent(toolEvents.lastEventAt)
  const checkMenuActive = voiceAgentActive && toolName === 'check_menu'
  const dispatchActive =
    voiceAgentActive &&
    ['dispatch_delivery', 'amend_delivery', 'recall_robot'].includes(toolName ?? '')
  const escalateActive = voiceAgentActive && toolName === 'escalate_to_frontdesk'
  const inventoryActive = isRecent(inventoryEvent.lastEventAt) || isRecent(deliveryEvent.lastEventAt)

  return (
    <div className={styles.diagram}>
      <div className={styles.column}>
        <Node label="Guest" active={voiceAgentActive} />
        <Node label="Voice Agent" active={voiceAgentActive} />
      </div>
      <div className={styles.column}>
        <Node label="Check Menu" active={checkMenuActive} />
        <Node label="Dispatch / Amend / Recall" active={dispatchActive} />
        <Node label="Escalate to Front Desk" active={escalateActive} />
      </div>
      <div className={styles.column}>
        {robots.map((r) => (
          <Node
            key={r.id}
            label={`${r.id} — ${r.phase}`}
            active={r.phase !== 'IDLE'}
            color={PHASE_COLOR[r.phase] ?? '#9ca3af'}
          />
        ))}
      </div>
      <div className={styles.column}>
        <Node label="Inventory" active={inventoryActive} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Write the CSS module**

Create `dashboard/components/FlowDiagram.module.css`:
```css
.diagram {
  display: flex;
  gap: 3rem;
  padding: 2rem;
  align-items: center;
}
.column {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.node {
  border: 2px solid #d1d5db;
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  font-family: system-ui, sans-serif;
  font-size: 0.9rem;
  background: white;
  transition: box-shadow 0.2s, border-color 0.2s;
}
.active {
  box-shadow: 0 0 0 3px currentColor;
}
```

- [ ] **Step 3: Wire it into the page**

Replace the contents of `dashboard/app/page.tsx` with:
```typescript
import FlowDiagram from '@/components/FlowDiagram'

export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Concierge — Live</h1>
      <FlowDiagram />
    </main>
  )
}
```

- [ ] **Step 4: Verify by hand — this is the real test**

Realtime subscriptions aren't meaningfully unit-testable (per the spec).
Run `cd dashboard && npm run dev`, open `http://localhost:3000` in a
browser. With the dev server still running, in a separate terminal at
the repo root, trigger a real event via the `mcp__supabase__execute_sql`
tool (or `psql`/the dashboard SQL editor if MCP isn't available in this
context):
```sql
insert into tool_call_events (tool_name, arguments, result_summary)
values ('check_menu', '{"items": ["towel"]}', 'test');
```
Expected: the "Voice Agent" and "Check Menu" nodes visibly highlight in
the browser within ~1-2 seconds, then fade back after ~1.5s, with no
page refresh. If nothing happens, this is a real integration failure —
check the browser console for Realtime connection errors before
assuming the code is wrong (a common cause: the anon key or project URL
in `.env.local` doesn't match, or the publication step from the spec
wasn't applied — it was already applied live during spec-writing, but
confirm with `select * from pg_publication_tables where pubname =
'supabase_realtime';` if this fails).

- [ ] **Step 5: Commit**

```bash
git add dashboard/app/page.tsx dashboard/components/
git commit -m "Judge dashboard: LangGraph-Studio-style flow diagram

Fixed 8-node topology (Guest -> Voice Agent -> {Check Menu, Dispatch,
Escalate} -> Robot 1/2 -> Inventory), driven by useRealtimeEvent on
tool_call_events/inventory_items/deliveries and useRealtimeTable on
robots. Verified live: a real tool_call_events insert visibly pulses
the correct nodes with no page refresh.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 4: Admin page — inventory CRUD

**Files:**
- Create: `dashboard/app/admin/page.tsx`

**Interfaces:**
- Consumes: `useRealtimeTable` (Task 2), Task 1's FastAPI endpoints
  (plain `fetch()`, no shared TS types across the network boundary).

- [ ] **Step 1: Write the admin page**

Create `dashboard/app/admin/page.tsx`:
```typescript
'use client'
import { useState } from 'react'
import { useRealtimeTable } from '@/lib/useRealtimeTable'

type Item = {
  id: string
  name: string
  category: string
  price: number | null
  dietary_tags: string[]
  available: boolean
  stock_count: number | null
}

const API = 'http://localhost:8000'

export default function AdminPage() {
  const [password, setPassword] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const items = useRealtimeTable<Item>('inventory_items', 'name')
  const [newItem, setNewItem] = useState({ name: '', category: 'amenity', price: '' })

  async function addItem() {
    await fetch(`${API}/admin/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
      body: JSON.stringify({
        name: newItem.name,
        category: newItem.category,
        price: newItem.price ? parseFloat(newItem.price) : null,
      }),
    })
    setNewItem({ name: '', category: 'amenity', price: '' })
  }

  async function patchItem(id: string, fields: Partial<Item>) {
    await fetch(`${API}/admin/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
      body: JSON.stringify(fields),
    })
  }

  async function toggleAvailable(item: Item) {
    await patchItem(item.id, { available: !item.available })
  }

  async function deleteItem(id: string) {
    await fetch(`${API}/admin/items/${id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Password': password },
    })
  }

  if (!unlocked) {
    return (
      <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1>Admin</h1>
        <input
          type="password"
          placeholder="Admin password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button onClick={() => setUnlocked(true)}>Unlock</button>
      </main>
    )
  }

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Inventory</h1>
      <table cellPadding={8}>
        <thead>
          <tr>
            <th>Name</th><th>Category</th><th>Price</th><th>Available</th><th>Stock</th><th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.name}</td>
              <td>{item.category}</td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  defaultValue={item.price ?? ''}
                  style={{ width: '5rem' }}
                  onBlur={(e) =>
                    patchItem(item.id, { price: e.target.value ? parseFloat(e.target.value) : null })
                  }
                />
              </td>
              <td>
                <button onClick={() => toggleAvailable(item)}>
                  {item.available ? 'Available' : 'Unavailable'}
                </button>
              </td>
              <td>
                <input
                  type="number"
                  defaultValue={item.stock_count ?? ''}
                  placeholder="∞"
                  style={{ width: '4rem' }}
                  onBlur={(e) =>
                    patchItem(item.id, { stock_count: e.target.value ? parseInt(e.target.value) : null })
                  }
                />
              </td>
              <td><button onClick={() => deleteItem(item.id)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Add item</h2>
      <input
        placeholder="name"
        value={newItem.name}
        onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
      />
      <select
        value={newItem.category}
        onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}
      >
        <option value="amenity">amenity</option>
        <option value="food">food</option>
        <option value="beverage">beverage</option>
      </select>
      <input
        placeholder="price (optional)"
        value={newItem.price}
        onChange={(e) => setNewItem({ ...newItem, price: e.target.value })}
      />
      <button onClick={addItem}>Add</button>
    </main>
  )
}
```

- [ ] **Step 2: Verify by hand**

With `dashboard/` dev server and `admin_api` (Task 1) both running
(`.venv/bin/uvicorn admin_api.main:app --port 8000` in one terminal,
`npm run dev` in `dashboard/` in another), open
`http://localhost:3000/admin`, enter the password from `.env`, add an
item, edit its price and stock count (tab out of the field to trigger
the save), toggle its availability, delete it. Expected: the table
updates immediately after each action (Realtime picking up the
FastAPI-driven write), no manual refresh needed. Stop both dev servers
afterward.

- [ ] **Step 3: Commit**

```bash
git add dashboard/app/admin/
git commit -m "Admin page: inventory CRUD via admin_api, live table via Realtime

Password-gated (client-side prompt + X-Admin-Password header on every
write, per the spec's Auth section). The item table itself is the same
useRealtimeTable hook as the dashboard -- writes go through FastAPI,
the resulting row change comes back the same way every other live
update does.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 5: Robot screen pages

**Files:**
- Create: `dashboard/app/robot/[id]/page.tsx`

**Interfaces:**
- Consumes: `useRealtimeTable` (Task 2), Task 1's
  `/robot/{id}/complete_loading` and `/robot/{id}/complete_collection`
  endpoints.

- [ ] **Step 1: Write the robot screen page**

Create `dashboard/app/robot/[id]/page.tsx`:
```typescript
'use client'
import { useParams } from 'next/navigation'
import { useRealtimeTable } from '@/lib/useRealtimeTable'

type Robot = { id: string; phase: string; current_task_id: string | null }
// items is a plain array of item-name strings, not objects -- matches
// Sub-project A's dispatch_delivery, which stores item_names (a list of
// strings pulled from the validated/dispatched item dicts), not the
// full dicts, in deliveries.items.
type Delivery = { task_id: string; room: string; items: string[] }

const API = 'http://localhost:8000'

const PHASE_MESSAGE: Record<string, string> = {
  IDLE: 'Waiting for next order.',
  EN_ROUTE: 'En route.',
  RETURNING: 'Returning to desk.',
  RECALLED: 'Returning to desk.',
  AT_DESK: 'At desk.',
}

export default function RobotScreen() {
  const params = useParams<{ id: string }>()
  const robotId = params.id
  const robots = useRealtimeTable<Robot>('robots', 'id')
  const deliveries = useRealtimeTable<Delivery>('deliveries', 'task_id')

  const robot = robots.find((r) => r.id === robotId)
  const task = robot?.current_task_id
    ? deliveries.find((d) => d.task_id === robot.current_task_id)
    : undefined

  async function completeLoading() {
    await fetch(`${API}/robot/${robotId}/complete_loading`, { method: 'POST' })
  }
  async function completeCollection() {
    await fetch(`${API}/robot/${robotId}/complete_collection`, { method: 'POST' })
  }

  if (!robot) {
    return <main style={{ padding: '2rem' }}>Unknown robot: {robotId}</main>
  }

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>
      <h1>{robot.id}</h1>
      <p style={{ fontSize: '1.5rem' }}>{robot.phase}</p>

      {robot.phase === 'COLLECTING' && task && (
        <>
          <p>Room {task.room}: {task.items.join(', ')}</p>
          <button style={{ fontSize: '1.5rem', padding: '1rem 2rem' }} onClick={completeLoading}>
            Complete Loading
          </button>
        </>
      )}

      {robot.phase === 'ARRIVED' && (
        <button style={{ fontSize: '1.5rem', padding: '1rem 2rem' }} onClick={completeCollection}>
          Complete Collection
        </button>
      )}

      {PHASE_MESSAGE[robot.phase] && <p>{PHASE_MESSAGE[robot.phase]}</p>}
    </main>
  )
}
```

- [ ] **Step 2: Verify by hand**

With `admin_api` and `dashboard`'s dev server running, and Sub-project
A's `task_engine` also running against the same live Supabase project
(so `robots`/`deliveries` rows are real), open
`http://localhost:3000/robot/robot_1`. Trigger a dispatch (via Sub-
project A's live voice agent, or directly via `ToolHandlers` in a
script) so `robot_1` enters `COLLECTING`. Expected: the page shows the
task's items and a "Complete Loading" button; clicking it should (a)
call the endpoint successfully and (b) `task_engine`'s next sync tick
(~1s) should pick up the command and advance the robot to `EN_ROUTE`,
visible on this same page and on `/` without a refresh.

- [ ] **Step 3: Commit**

```bash
git add dashboard/app/robot/
git commit -m "Robot screen pages: loading/collection confirmation UI

The physical 'LED screen' simulation -- shows current phase + the
button appropriate to it, posts to admin_api's robot command endpoints.
No auth (physical presence at the robot is the access control, per the
spec).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RKMd6CfzZwg23w1Pe6PDRt"
```

---

## Task 6: Live end-to-end check

**Files:** none (manual verification, not committed — same pattern as
every other live-system check in this project)

- [ ] **Step 1: Run everything together**

In separate terminals, from the repo root:
```bash
.venv/bin/python -m orchestrator.agent        # Sub-project A's voice agent
.venv/bin/uvicorn admin_api.main:app --port 8000   # Task 1
cd dashboard && npm run dev                    # Tasks 2-5
```

- [ ] **Step 2: Walk through the real flow**

1. Open `http://localhost:3000` (dashboard) and
   `http://localhost:3000/robot/robot_1` in two browser windows/tabs.
2. Talk to the voice agent: "please send a towel to room 1204."
3. Watch the dashboard: "Voice Agent" and "Dispatch/Amend/Recall" nodes
   should pulse, then `robot_1`'s node should turn yellow
   (`COLLECTING`).
4. Switch to the robot_1 screen tab: it should show the towel order and
   a "Complete Loading" button. Click it.
5. Watch the dashboard: `robot_1` should turn blue (`EN_ROUTE`), then
   green (`ARRIVED`) once the simulated drive completes.
6. On the robot_1 screen, click "Complete Collection" once it appears.
7. Watch `robot_1` return to gray (`IDLE`) after driving home.
8. Open `http://localhost:3000/admin`, confirm the towel's `stock_count`
   (if tracked) reflects the dispatch.

Expected: every step is visible live, no manual refresh anywhere. If
any step doesn't reflect within a couple seconds, use
`superpowers:systematic-debugging` — check the browser console first
(Realtime connection state), then whether the underlying Supabase row
actually changed (`execute_sql` a plain `select`) before assuming the
frontend code is wrong.

- [ ] **Step 3: If it fails**

Report back precisely what step failed and what you observed instead —
this is the first time all six tasks run together, a failure here is
real signal about an integration gap between this plan and Sub-project
A's actual running system, not something to silently patch around.

## Self-Review Notes

**Spec coverage:** FastAPI backend with password-gated admin writes +
open robot-command writes (Task 1), Next.js scaffold + the two shared
Realtime primitives every page needs (Task 2), the flow diagram (Task
3), admin CRUD page (Task 4), robot screens (Task 5), and a live
end-to-end walkthrough tying it to Sub-project A's actual running
system (Task 6).

**Type/shape consistency:** `Robot`/`Delivery`/`Item` TypeScript shapes
match Sub-project A's actual column names (`phase`, `current_task_id`,
`pose_frac`, `room`, `items`, `dietary_tags`, `stock_count`) throughout
Tasks 3-5, not invented field names. Two real fixes made during this
review, not left for a task's implementer to trip over: (1) Task 3's
`FlowDiagram.tsx` was importing both hooks from
`@/lib/useRealtimeTable`, but `useRealtimeEvent` lives in its own file
per Task 2 — fixed to two separate imports. (2) Task 5's `Delivery` type
had `items: {name: string}[]`, but Sub-project A's `dispatch_delivery`
actually stores `items` as a plain array of name strings (`item_names`,
not the full item dicts) — fixed the type and the `.join()` call that
depended on it.

**Deliberate scope cut:** the admin page (Task 4) doesn't expose an
editor for `dietary_tags` — add/price/stock/availability/delete are all
there, but changing an item's dietary tags after creation requires
going around the UI (a direct `PATCH` call, or the Supabase dashboard).
`admin_api`'s `ItemPatch` already accepts it; only the Next.js form is
missing that one field. Reasonable to leave out for a hackathon admin
page — flagged here so it reads as a choice, not an oversight.

**No placeholders:** every step has real, complete code or a real,
complete command — checked. Scaffolding steps (`create-next-app`, `npm
install`) use the actual tool rather than hand-authoring generated
boilerplate, which is the appropriate level of detail for that kind of
step, not a placeholder.
