/**
 * Self-check for the browser tool handlers (lib/voice/tools.ts), mirroring
 * orchestrator/tools.py's __main__ demo: fake sim + fake engine state, no
 * network. Run: npm run selfcheck:tools
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ToolHandlers, needsNudge, nudgeInstruction, summarize, type EngineSnapshot } from '../lib/voice/tools.ts';
import type { Cmd, Paths, Task } from '../lib/sim/engine.ts';
import { refusal, clientIp, type LimitRow } from '../lib/voice/limits.ts';

const paths: Paths = JSON.parse(readFileSync(new URL('../public/sim/waypoints.json', import.meta.url), 'utf8'));
const menu = [
  { name: 'towel', category: 'amenity', price: null, dietary_tags: [], available: true, in_stock: true },
  { name: 'nasi lemak', category: 'food', price: 8, dietary_tags: ['halal'], available: true, in_stock: true },
  { name: 'toothbrush', category: 'amenity', price: null, dietary_tags: [], available: false, in_stock: false },
  { name: 'water', category: 'drink', price: 2, dietary_tags: [], available: true, in_stock: true, stock: 1 },
];
const sent: Cmd[] = [];
const recorded: Record<string, unknown>[] = [];
let snap: EngineSnapshot = { time: 100, robot: { robot_id: 'robot_1', phase: 'IDLE', pose_frac: 0, battery: 100, current_task: null }, tasks: {} };
const h = new ToolHandlers(menu, paths, (c) => sent.push(c), () => snap, (e) => recorded.push(e));

const menuRes = h.dispatch('check_menu', { items: ['Nasi Lemak'] }) as { price: number; dietary_tags: string[] }[];
assert.equal(menuRes[0].price, 8);

// partial dispatch: only the available item reaches the engine
const r = h.dispatch('dispatch_delivery', { room: '1204', items: ['towel', 'toothbrush'] }) as Record<string, unknown>;
assert.ok(r.task_id && /^w[0-9a-f]{7}$/.test(String(r.task_id)));
assert.deepEqual((r.unavailable_items as { name: string }[]).map((i) => i.name), ['toothbrush']);
assert.equal(sent.length, 1);
assert.deepEqual((sent[0] as { items: string[] }).items, ['towel']);
assert.match(summarize('dispatch_delivery', { room: '1204' }, r), /Sent 1× towel to room 1204\. Couldn't send toothbrush/);

// nothing available -> nothing enqueued; unknown room -> nothing enqueued
assert.equal((h.dispatch('dispatch_delivery', { room: '1204', items: ['toothbrush'] }) as Record<string, unknown>).task_id, null);
assert.equal((h.dispatch('dispatch_delivery', { room: '9999', items: ['towel'] }) as Record<string, unknown>).error, 'unknown_room');
assert.equal(sent.length, 1);

// same room, still at the desk (not yet in engine state) -> joins, one trip
const again = h.dispatch('dispatch_delivery', { room: '1204', items: ['nasi lemak'] }) as Record<string, unknown>;
assert.equal(again.task_id, r.task_id);
assert.equal(again.joined_existing_order, true);
assert.deepEqual(again.trip_items, ['towel', 'nasi lemak']);
assert.equal(sent[1].cmd, 'amend');
const parcel = h.dispatch('deliver_parcel', { room: '1204', source: 'Uber Eats', description: 'Uber Eats food order' }) as Record<string, unknown>;
assert.equal(parcel.task_id, r.task_id);
assert.match(String(parcel.tell_guest), /towel, nasi lemak and Uber Eats food order/);

// far wing has the longer ETA
const near = h.dispatch('deliver_parcel', { room: '0803', source: 'Grab' }) as Record<string, number>;
const far = h.dispatch('deliver_parcel', { room: '1205', source: 'Grab' }) as Record<string, number>;
assert.ok(far.eta_seconds > near.eta_seconds);

// status by room reads the engine's view; position from the robot on the task
const tid = String(r.task_id);
const task = { task_id: tid, room: '1204', items: ['towel'], priority: 'normal', phase: 'EN_ROUTE', dispatched_at: 90,
  arrived_at: null, progress_m: 1, eta_seconds: 36, announced: false, reason: null, _leg: true } as Task;
snap = { time: 100, robot: { ...snap.robot, phase: 'EN_ROUTE', current_task: tid, pose_frac: 0.73 }, tasks: { [tid]: task } };
const st = h.dispatch('check_delivery_status', { room: '1204' }) as Record<string, unknown>;
assert.deepEqual([st.phase, st.position, st.eta_seconds], ['EN_ROUTE', 0.73, 26]);

// recall acks only something recallable; an invented argument is dropped, not fatal
assert.equal((h.dispatch('recall_robot', { task_id: 'nope', reason: 'x' }) as Record<string, unknown>).ack, false);
const rec = h.dispatch('recall_robot', { task_id: tid, reason: 'wrong room', urgency: 'high' }) as Record<string, unknown>;
assert.equal(rec.ack, true);
assert.deepEqual(rec.ignored_arguments, ['urgency']);
assert.equal(sent[sent.length - 1].cmd, 'recall');

// hotel facts come back with exact figures; escalation is recorded
assert.match(String((h.dispatch('hotel_info', { topic: 'late_checkout' }) as Record<string, unknown>).answer), /\$30/);
assert.equal((h.dispatch('hotel_info', { topic: 'spa' }) as Record<string, unknown>).error, 'unknown_topic');
h.dispatch('escalate_to_frontdesk', { reason: 'late checkout 2pm', room: '1204' });
assert.ok(recorded.some((e) => e.kind === 'escalation' && e.room === '1204'));
assert.equal((h.dispatch('no_such_tool', {}) as Record<string, unknown>).error, 'unknown_tool:no_such_tool');
h.dispatch('end_call', {});
assert.equal(h.endRequested, true);
assert.equal(recorded.filter((e) => e.kind === 'tool').length, 16, 'every tool call is audited');

// nudge heuristics: a trailing promise nudges; a question or "let me know" doesn't
assert.equal(needsNudge('Sure. Let me check that for you.'), true);
assert.equal(needsNudge('Want me to put that request in?'), false);
assert.equal(needsNudge('Let me know if you need anything else.'), false);
assert.match(nudgeInstruction('I ordered Uber Eats', false), /deliver_parcel/);
assert.doesNotMatch(nudgeInstruction('I ordered Uber Eats', true), /deliver_parcel/);

// stock is real: the last bottle goes, the next order is told it is out, and
// the stock count never reaches what the model sees
const w1 = h.dispatch('dispatch_delivery', { room: '0804', items: ['water'] }) as Record<string, unknown>;
assert.ok(w1.task_id);
assert.ok(recorded.some((e) => e.kind === 'stock' && (e.items as string[]).includes('water')));
const w2 = h.dispatch('dispatch_delivery', { room: '0804', items: ['water'] }) as Record<string, unknown>;
assert.deepEqual(w2.unavailable_items, [{ name: 'water', reason: 'out_of_stock' }]);
assert.ok(!JSON.stringify(h.dispatch('check_menu', {})).includes('"stock"'), 'stock count stays private');

// rate limits: IP is the main signal; client id and fingerprint assist
const NOW = Date.parse('2026-09-24T12:00:00Z');
const ago = (min: number, lenMin: number | null, over: Partial<LimitRow> = {}): LimitRow => ({
  ip: '1.2.3.4', client_id: null, fingerprint: null, ...over,
  started_at: new Date(NOW - min * 60e3).toISOString(),
  ended_at: lenMin === null ? null : new Date(NOW - (min - lenMin) * 60e3).toISOString(),
});
const me = { ip: '1.2.3.4', clientId: 'c1', fingerprint: 'f1' };
assert.equal(refusal([], me, NOW), null);
assert.equal(refusal([ago(60, 1), ago(30, 1)], me, NOW), null, 'two short calls: a third is allowed');
assert.match(String(refusal([ago(90, 1), ago(60, 1), ago(30, 1)], me, NOW)), /calls/, 'fourth call by IP refused');
assert.equal(refusal([ago(60, 3), ago(30, 3)], me, NOW), null, 'two full calls (6 min): a third is allowed');
assert.match(String(refusal([ago(60, 12)], me, NOW)), /minutes/, 'one call held open 12 min (page timer skipped) uses up the day');
assert.match(String(refusal([ago(1, null)], me, NOW)), /already have a call open/);
assert.equal(refusal([ago(5, null)], me, NOW), null, 'a 5-min unclosed call (tab crashed) no longer blocks');
assert.equal(refusal([ago(600, null), ago(300, null)], me, NOW), null, 'crashed calls cost 3 min each, not the day');
assert.match(String(refusal([ago(600, null), ago(300, null), ago(200, null)], me, NOW)), /calls/);
assert.equal(refusal([ago(25 * 60, 1), ago(25 * 60, 1), ago(25 * 60, 1)], me, NOW), null, 'rolling 24 h');
const vpn = { ip: '9.9.9.9', clientId: 'c1', fingerprint: 'f1' };
assert.match(String(refusal([ago(90, 1), ago(60, 1), ago(30, 1)].map((r) => ({ ...r, client_id: 'c1' })), vpn, NOW)), /calls/, 'new IP, same browser id');
const sixFp = Array.from({ length: 6 }, (_, i) => ago(100 - i * 10, 1, { ip: `5.5.5.${i}`, fingerprint: 'f1' }));
assert.match(String(refusal(sixFp, { ip: '9.9.9.9', clientId: null, fingerprint: 'f1' }, NOW)), /calls/, 'VPN hopper caught by fingerprint');
assert.equal(refusal(sixFp.slice(0, 5), { ip: '9.9.9.9', clientId: null, fingerprint: 'f1' }, NOW), null, 'identical laptops: 5 shared-fingerprint calls still fine');
assert.equal(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7');

console.log('tools port self-check OK (partial dispatch, joins at the desk, parcel labels, status/recall/facts, dropped args, nudges)');
