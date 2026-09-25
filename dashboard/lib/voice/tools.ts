/**
 * The voice agent's client-side tools, in the browser: a port of
 * orchestrator/tools.py (handlers, result summaries, the nudge heuristics).
 * Keep the two in step. Every handler returns immediately (CLAUDE.md
 * constraint 2): it posts a command to the sim worker and reads the last
 * engine state it reported; it never waits on the robot.
 *
 * Differences from the Python stack: one robot (the browser runs one sim).
 * Stock is decremented for real, like inventory.decrement_stock: the local
 * count here keeps the rest of the call honest, and a 'stock' audit event has
 * /api/call/event write inventory_items + inventory_audit_log.
 */
import config from './agent-config.json';
import { totalLength, DRIVE_SPEED_MPS, type Cmd, type Paths, type Task } from '../sim/engine';
import type { MenuItem } from './menu';

export type EngineSnapshot = {
  time: number; // sim seconds, the clock the engine's timestamps use
  robot: { robot_id: string; phase: string; pose_frac: number; battery: number; current_task: string | null };
  tasks: Record<string, Task>;
};

type Args = Record<string, unknown>;
type Result = Record<string, unknown> | Record<string, unknown>[];

const PHASE_WORDS: Record<string, string> = {
  QUEUED: 'waiting for a robot', COLLECTING: 'being loaded', EN_ROUTE: 'on the way',
  ARRIVED: 'at the door', RETURNING: 'heading back', RECALLED: 'recalled',
  AT_DESK: 'back at the desk', DONE: 'delivered',
};
const HOTEL_FACTS: Record<string, string> = config.hotel_facts;

const qty = (items: unknown[]) => {
  if (!items.length) return 'nothing';
  const counts = new Map<string, number>();
  for (const i of items) counts.set(String(i), (counts.get(String(i)) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${n}× ${name}`).join(', ');
};

/** One plain sentence for the dashboard's staff view (tools.py summarize_result). Never throws. */
export function summarize(name: string, a: Args, r: Result): string {
  try { return summarizeInner(name, a ?? {}, r); } catch { return `${name} completed.`; }
}

function summarizeInner(name: string, a: Args, r: Result): string {
  if (name === 'check_menu') {
    const items = Array.isArray(r) ? r : [];
    if (items.length === 1) {
      const it = items[0] as MenuItem;
      const bits = it.price ? [`$${Number(it.price).toFixed(2)}`] : [];
      bits.push(it.available && it.in_stock ? 'available' : 'not available');
      if (it.dietary_tags?.length) bits.push(it.dietary_tags.join(', '));
      return `${it.name ?? 'Item'} — ${bits.join(', ')}.`;
    }
    return `Checked the menu: ${items.length} item(s).`;
  }
  if (Array.isArray(r)) return `${name} completed.`;
  if ('error' in r && name !== 'dispatch_delivery') return `Couldn't do that: ${r.error}.`;
  const room = a.room ?? '?';
  switch (name) {
    case 'dispatch_delivery': {
      if (r.error === 'unknown_room') return `No route to room ${room} — the robot can only reach ${(r.deliverable_rooms as string[] ?? []).join(', ')}.`;
      const missing = (r.unavailable_items as { name: string }[]) ?? [];
      const missingTxt = missing.map((m) => m.name).join(', ');
      if (!r.task_id) return `Nothing sent to room ${room} — ${missingTxt || 'no items available'} not available.`;
      let line = `Sent ${qty(((r.dispatched_items as { name: string }[]) ?? []).map((i) => i.name))} to room ${room}.`;
      if (missing.length) line += ` Couldn't send ${missingTxt}.`;
      return line;
    }
    case 'deliver_parcel': {
      const what = (r.dispatched_items as { name: string }[])?.[0]?.name ?? a.source ?? 'delivery';
      if (r.joined_existing_order) return `Added the ${what} to room ${room}'s order waiting at the desk — one trip.`;
      return `Robot booked to take the ${what} up to room ${room} once it reaches the desk.`;
    }
    case 'check_delivery_status': {
      const eta = r.eta_seconds as number;
      const tail = eta > 0 ? `, about ${Math.round(eta / 60)} min away` : '';
      return `Order is ${PHASE_WORDS[r.phase as string] ?? String(r.phase).toLowerCase()}${tail}.`;
    }
    case 'amend_delivery': {
      const bits = [];
      if ((a.add as unknown[])?.length) bits.push(`added ${qty(a.add as unknown[])}`);
      if ((a.remove as unknown[])?.length) bits.push(`removed ${qty(a.remove as unknown[])}`);
      if (a.new_room) bits.push(`moved to room ${a.new_room}`);
      return `Changed the order: ${bits.join(', ') || 'no changes'}.`;
    }
    case 'recall_robot':
      return r.ack ? 'Robot called back to the desk.' : `Couldn't recall the robot — ${String(r.reason ?? '').replaceAll('_', ' ') || 'not possible'}.`;
    case 'get_fleet_state': {
      const robots = (r.robots as { current_task_id: string | null }[]) ?? [];
      return `Checked the fleet: ${robots.filter((x) => x.current_task_id).length} of ${robots.length} robot(s) busy.`;
    }
    case 'announce_arrival': return r.ack ? `Announced arrival at room ${room}.` : 'Nothing to announce for that room.';
    case 'hotel_info': return `Answered a question about ${String(a.topic ?? '').replaceAll('_', ' ')}.`;
    case 'end_call': return 'Call ended.';
    case 'escalate_to_frontdesk': return `Passed to the front desk${a.room ? ` from room ${a.room}` : ''}: ${a.reason ?? ''}.`;
  }
  return `${name} completed.`;
}

// ---- nudge (tools.py needs_nudge / nudge_instruction) ----------------------

const ACTIONS = "check|look|pass|send|put|get|find|arrange|request|flag|confirm|have|book|bring|" +
  'carry|take|add|sort|organi[sz]e|handle|dispatch|order|set|make|note|escalate|' +
  'forward|notify|tell|call|update|change|cancel|recall|ask|see|pull|grab|let(?!\\s+you\\b)';
const ANNOUNCE = new RegExp(
  "\\b(one moment|just a moment|give me a (sec|second|moment)|" +
  `(let me|i'?ll|i will|i'?m going to|i am going to)\\s+(just\\s+|now\\s+|quickly\\s+)?(${ACTIONS})\\b|` +
  'checking (on|that|now)|passing (that|this|it)|' +
  '(sending|booking|bringing|adding|dispatching|arranging) (that|this|it|those|them|the|your|up|now|over))', 'i');
const DELIVERY_APP = /uber\s*eats|doordash|grab|foodpanda|meituan|deliveroo|外卖|美团|饿了么/i;

export function needsNudge(reply: string) {
  const text = (reply ?? '').trim();
  if (!text || text.includes('?')) return false;
  const sentences = text.split(/(?<=[.!])\s+/);
  return ANNOUNCE.test(sentences[sentences.length - 1]);
}

export function nudgeInstruction(guestText: string, parcelBooked: boolean) {
  if (DELIVERY_APP.test(guestText ?? '') && !parcelBooked) {
    return "The guest's delivery-app order is NOT booked yet -- you did not call " +
      'deliver_parcel. Call deliver_parcel for their room right now. Do not say ' +
      'anything before the tool call.';
  }
  return 'You told the guest you would do something but did not call the tool. Call ' +
    'the right tool right now. Do not say anything before the tool call, and do ' +
    'not repeat yourself.';
}

// ---- handlers ---------------------------------------------------------------

const LIVE_DONE = ['DONE', 'AT_DESK'];
const newTaskId = () => 'w' + crypto.randomUUID().replaceAll('-', '').slice(0, 7);

export class ToolHandlers {
  endRequested = false;
  private menu: Map<string, MenuItem>;
  private stock = new Map<string, number | null>();
  // Tasks sent to the worker but not yet reported back in a state message
  // (the engine ticks at 5 Hz); merged under the engine's own view.
  private sent: Record<string, Task> = {};

  private paths: Paths;
  private send: (cmd: Cmd) => void;
  private snapshot: () => EngineSnapshot | null;
  private record: (e: Record<string, unknown>) => void;

  constructor(menu: MenuItem[], paths: Paths, send: (cmd: Cmd) => void,
    snapshot: () => EngineSnapshot | null, record: (e: Record<string, unknown>) => void) {
    this.menu = new Map(menu.map(({ stock, ...m }) => {
      this.stock.set(m.name.toLowerCase(), stock ?? null);
      return [m.name.toLowerCase(), m];
    }));
    this.paths = paths; this.send = send; this.snapshot = snapshot; this.record = record;
  }

  private rooms() { return Object.keys(this.paths).sort(); }
  private eta(room: string) { return totalLength(this.paths[room]) / DRIVE_SPEED_MPS; }
  private tasks(): Record<string, Task> { return { ...this.sent, ...(this.snapshot()?.tasks ?? {}) }; }

  private newestForRoom(room: unknown) {
    const live = Object.values(this.tasks()).filter((t) => t.room === room && !LIVE_DONE.includes(t.phase));
    return live.sort((a, b) => (b.dispatched_at ?? Infinity) - (a.dispatched_at ?? Infinity))[0] ?? null;
  }

  private lookup(names: unknown[]): MenuItem[] {
    return names.map((n) => this.menu.get(String(n).toLowerCase())
      ?? { name: String(n), category: null, price: null, dietary_tags: [], available: false, in_stock: false });
  }

  /** inventory.decrement_stock: duplicates are the quantity. */
  private takeStock(names: string[], task_id: string) {
    for (const n of names) {
      const k = n.toLowerCase(), left = this.stock.get(k);
      if (left === null || left === undefined) continue;
      this.stock.set(k, Math.max(left - 1, 0));
      if (left - 1 <= 0) { const m = this.menu.get(k); if (m) m.in_stock = false; }
    }
    this.record({ kind: 'stock', task_id, items: names });
  }

  private dispatchTask(room: string, items: string[], priority: string) {
    const task_id = newTaskId();
    this.send({ cmd: 'dispatch', task_id, room, items, priority });
    this.sent[task_id] = {
      task_id, room, items, priority, phase: 'QUEUED', dispatched_at: null, arrived_at: null,
      progress_m: 0, eta_seconds: this.eta(room), announced: false, reason: null, _leg: false,
    };
    this.record({ kind: 'delivery', task_id, room, items, phase: 'QUEUED', priority });
    return task_id;
  }

  private join(live: Task, add: string[]) {
    const everything = [...live.items, ...add];
    this.send({ cmd: 'amend', task_id: live.task_id, add, remove: [] });
    if (this.sent[live.task_id]) this.sent[live.task_id].items = everything;
    return everything;
  }

  check_menu({ items }: Args) {
    return Array.isArray(items) && items.length ? this.lookup(items) : [...this.menu.values()];
  }

  dispatch_delivery({ room, items, priority }: Args) {
    if (typeof room !== 'string' || !this.paths[room]) {
      return { task_id: null, dispatched_items: [], unavailable_items: [], error: 'unknown_room', deliverable_rooms: this.rooms() };
    }
    const looked = this.lookup(Array.isArray(items) ? items : []);
    const dispatched = looked.filter((i) => i.available && i.in_stock);
    const unavailable = looked.filter((i) => !(i.available && i.in_stock))
      .map((i) => ({ name: i.name, reason: i.category === null || !i.available ? 'not_offered' : 'out_of_stock' }));
    if (!dispatched.length) return { task_id: null, dispatched_items: [], unavailable_items: unavailable };
    const names = dispatched.map((i) => i.name);

    const live = this.newestForRoom(room);
    if (live && (live.phase === 'QUEUED' || live.phase === 'COLLECTING')) {
      const everything = this.join(live, names);
      this.takeStock(names, live.task_id);
      return {
        task_id: live.task_id, eta_seconds: this.eta(room), dispatched_items: dispatched, unavailable_items: unavailable,
        joined_existing_order: true, trip_items: everything, status: 'waiting at the front desk to be loaded',
        tell_guest: 'Added to the order already waiting at the front desk -- it all goes up in one trip once staff ' +
          'load it: ' + everything.join(', ') + '. Do not say it is already on the way.',
      };
    }
    const task_id = this.dispatchTask(room, names, priority === 'urgent' ? 'urgent' : 'normal');
    this.takeStock(names, task_id);
    return {
      task_id, eta_seconds: this.eta(room), dispatched_items: dispatched, unavailable_items: unavailable,
      status: 'waiting at the front desk to be loaded',
      tell_guest: 'It is being loaded at the front desk now and leaves as soon as staff load it; eta_seconds is ' +
        'the trip once it sets off. Do not say it is already on the way.',
    };
  }

  deliver_parcel({ room, source, description }: Args) {
    if (typeof room !== 'string' || !this.paths[room]) return { task_id: null, error: 'unknown_room', deliverable_rooms: this.rooms() };
    const src = String(source ?? 'delivery');
    const desc = String(description ?? 'food order').trim() || 'food order';
    const label = desc.toLowerCase().includes(src.toLowerCase()) ? desc : `${src} ${desc}`.trim();
    const live = this.newestForRoom(room);
    if (live && (live.phase === 'QUEUED' || live.phase === 'COLLECTING')) {
      const everything = [...live.items.filter((i) => i !== label), label];
      this.join(live, [label]);
      const listed = everything.length > 1 ? everything.slice(0, -1).join(', ') + ' and ' + everything[everything.length - 1] : label;
      return {
        task_id: live.task_id, eta_seconds: this.eta(room), dispatched_items: [{ name: label }], joined_existing_order: true,
        trip_items: everything, waiting_for: 'the rider to drop it at the front desk',
        tell_guest: `Say, in these words or close: 'Your ${listed} will all go up together in one trip, as soon as ` +
          `the rider drops the ${label} at the front desk and staff load it.' Name every item; do not say anything ` +
          'is already on its way.',
      };
    }
    const task_id = this.dispatchTask(room, [label], 'normal');
    return {
      task_id, eta_seconds: this.eta(room), dispatched_items: [{ name: label }],
      waiting_for: 'the rider to drop it at the front desk; staff load it into the robot',
    };
  }

  check_delivery_status({ task_id, room }: Args) {
    const t = task_id ? this.tasks()[String(task_id)] : this.newestForRoom(room);
    if (!t) return { error: 'not_found' };
    const snap = this.snapshot();
    let remaining = t.eta_seconds;
    if (t.dispatched_at !== null && snap) remaining = Math.max(t.eta_seconds - (snap.time - t.dispatched_at), 0);
    const pos = snap?.robot.current_task === t.task_id ? snap.robot.pose_frac : 0;
    return { task_id: t.task_id, phase: t.phase, position: Math.round(pos * 100) / 100, eta_seconds: Math.round(remaining * 10) / 10 };
  }

  amend_delivery({ task_id, add, remove, new_room }: Args) {
    const str = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    this.send({ cmd: 'amend', task_id: String(task_id), add: str(add), remove: str(remove), new_room: new_room ? String(new_room) : undefined });
    return { task_id, status: 'amend_queued' };
  }

  recall_robot({ task_id, reason }: Args) {
    const t = this.tasks()[String(task_id)];
    if (!t) return { ack: false, reason: 'task_not_found' };
    if (LIVE_DONE.includes(t.phase)) return { ack: false, reason: `already_finished:${t.phase}` };
    this.send({ cmd: 'recall', task_id: t.task_id, reason: String(reason ?? '') });
    return { ack: true, phase: t.phase };
  }

  get_fleet_state() {
    const r = this.snapshot()?.robot;
    if (!r) return { robots: [] };
    return { robots: [{
      robot_id: r.robot_id, phase: r.phase, current_task_id: r.current_task,
      room: r.current_task ? this.tasks()[r.current_task]?.room ?? null : null,
      battery: r.battery, pose_frac: r.pose_frac,
    }] };
  }

  announce_arrival({ room }: Args) {
    const t = this.newestForRoom(room);
    if (!t) return { ack: false, reason: 'no_active_delivery_for_room' };
    this.send({ cmd: 'announce', task_id: t.task_id });
    return { ack: true, task_id: t.task_id };
  }

  hotel_info({ topic }: Args) {
    const answer = HOTEL_FACTS[String(topic)];
    if (answer === undefined) return { error: 'unknown_topic', topics: Object.keys(HOTEL_FACTS) };
    return { topic, answer, tell_guest: 'Give the guest this answer with its exact figures -- do not round, change or invent any price, time or limit.' };
  }

  end_call() {
    this.endRequested = true;
    return { ack: true, instruction: 'The line is closing and you have already said goodbye. Say nothing more.' };
  }

  escalate_to_frontdesk({ reason, room }: Args) {
    this.record({ kind: 'escalation', reason, room });
    return { ack: true, room: room ?? null };
  }

  /** Never throws (tools.py dispatch): unknown arguments are dropped and noted. */
  dispatch(name: string, args: Args): Result {
    const params: Record<string, string[]> = Object.fromEntries(
      config.tools.map((t) => [t.name, Object.keys(t.parameters.properties ?? {})]));
    let result: Result;
    const known = params[name];
    const a: Args = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(args ?? {})) {
      if (known?.includes(k)) a[k] = v; else dropped.push(k);
    }
    const fn = (this as unknown as Record<string, (a: Args) => Result>)[name];
    if (!known || typeof fn !== 'function') result = { error: `unknown_tool:${name}` };
    else {
      try { result = fn.call(this, a); } catch (e) { result = { error: String(e) }; }
      if (dropped.length && !Array.isArray(result)) result = { ...result, ignored_arguments: dropped.sort() };
    }
    this.record({ kind: 'tool', name, arguments: a, summary: summarize(name, a, result), result });
    return result;
  }
}
