import { db, liveWebSession } from '../../../../lib/voice/server';

/**
 * The web call's audit trail, written with the service-role key so the
 * browser never holds it. Same tables and shapes as orchestrator/inventory.py
 * and task_engine/supabase_sync.py, so web calls show in the shared Call log.
 *
 * Body: { session_id, events: [{ kind, ... }] }, batched by the browser.
 * kind: turn | tool | delivery | escalation | stock | end.
 * Only accepted for a live web session (lib/voice/server.ts liveWebSession).
 */
type Ev = Record<string, unknown>;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
const small = (v: unknown) => (JSON.stringify(v ?? null).length <= 8000 ? v : { truncated: true });
const TASK_ID = /^w[0-9a-f]{7}$/;
const ROOM = /^\d{4}$/;
const iso = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v).toISOString() : null);

export async function POST(request: Request) {
  try {
    return await handle(request);
  } catch (e) {
    console.error('[call/event]', e);
    return Response.json({ error: 'audit write failed' }, { status: 500 });
  }
}

async function handle(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || !(await liveWebSession(body.session_id))) return Response.json({ error: 'no live session' }, { status: 403 });
  const sid: string = body.session_id;
  const events: Ev[] = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
  const d = db();
  const ops: (() => PromiseLike<{ error: unknown }>)[] = [];

  for (const e of events) {
    if (e.kind === 'turn' && (e.role === 'guest' || e.role === 'agent') && str(e.text, 2000)) {
      ops.push(() => d.from('transcript_turns').insert({ session_id: sid, role: e.role, text: str(e.text, 2000) }));
    } else if (e.kind === 'tool' && str(e.name, 64)) {
      ops.push(() => d.from('tool_call_events').insert({
        session_id: sid, tool_name: str(e.name, 64), arguments: small(e.arguments ?? {}),
        result: small(e.result), result_summary: str(e.summary, 500),
      }));
    } else if (e.kind === 'delivery' && TASK_ID.test(String(e.task_id)) && ROOM.test(String(e.room))) {
      ops.push(() => d.from('deliveries').upsert({
        task_id: e.task_id, room: e.room, items: small(Array.isArray(e.items) ? e.items : []),
        phase: str(e.phase, 20), priority: e.priority === 'urgent' ? 'urgent' : 'normal',
        dispatched_at: iso(e.dispatched_at), arrived_at: iso(e.arrived_at),
      }, { onConflict: 'task_id' }));
    } else if (e.kind === 'escalation' && str(e.reason, 500)) {
      ops.push(() => d.from('frontdesk_escalations').insert({
        reason: str(e.reason, 500), room: ROOM.test(String(e.room)) ? e.room : null,
      }));
    } else if (e.kind === 'stock' && TASK_ID.test(String(e.task_id)) && Array.isArray(e.items)) {
      // inventory.decrement_stock: count duplicates first, one audit row per item
      const counts = new Map<string, number>();
      for (const n of e.items.slice(0, 20)) {
        const k = String(n).toLowerCase().slice(0, 100);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      for (const [name, n] of counts) ops.push(() => takeStock(name, n, String(e.task_id)));
    } else if (e.kind === 'end') {
      const now = new Date().toISOString();
      ops.push(() => d.from('voice_sessions').update({ ended_at: now }).eq('id', sid).is('ended_at', null));
      ops.push(() => d.from('call_limits').update({ ended_at: now }).eq('session_id', sid).is('ended_at', null));
    }
  }
  // One at a time: created_at orders the Call log, so turns must land in order.
  let failed = 0;
  for (const op of ops) {
    const { error } = await op();
    if (error) { failed++; console.error('[call/event]', error); }
  }
  return Response.json({ ok: failed === 0 });
}

/** ponytail: read-then-write like inventory.py; two calls ordering the same
 *  item in the same instant can lose one decrement. An RPC doing it in SQL
 *  closes that if it ever matters. */
async function takeStock(name: string, n: number, taskId: string): Promise<{ error: unknown }> {
  const d = db();
  const { data: row, error } = await d.from('inventory_items').select('id,name,stock_count').ilike('name', name.replace(/[\\%_]/g, '\\$&')).maybeSingle();
  if (error || !row || row.stock_count === null) return { error };
  const before: number = row.stock_count, after = Math.max(before - n, 0);
  const upd = await d.from('inventory_items').update({ stock_count: after }).eq('id', row.id);
  if (upd.error) return upd;
  return d.from('inventory_audit_log').insert({
    item_id: row.id, item_name: row.name, delta: after - before, before_count: before,
    after_count: after, task_id: taskId, source: 'dispatch_delivery',
  });
}
