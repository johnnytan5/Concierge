/**
 * Self-check for the engine<->UI translation layer.
 *
 * Run with the platform's own runner, no framework and no new dependency:
 *   node --test lib/format.test.ts
 *
 * format.ts has no runtime imports (its only import is `import type`, which
 * type-stripping erases), so Node executes it directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  phaseStep, humanPhase, formatItems, duration, ago,
  formatPrice, median, medianDeskToDoor, isTerminal, PHASE_STEPS,
  pickLiveSession, replyLatencyMs, latencyLabel, roomFromCalls, guestLabel,
  argPairsFor, roomForCall, outcomesFor,
} from './format.ts';

test('phaseStep maps every engine phase onto a real step or none', () => {
  assert.equal(phaseStep('COLLECTING'), 0);
  assert.equal(phaseStep('EN_ROUTE'), 1);
  assert.equal(phaseStep('ARRIVED'), 2);
  assert.equal(phaseStep('RETURNING'), 3);
  // a recalled robot is driving home — same leg as RETURNING
  assert.equal(phaseStep('RECALLED'), 3);
  // not on a run
  assert.equal(phaseStep('IDLE'), -1);
  assert.equal(phaseStep('QUEUED'), -1);
  assert.equal(phaseStep('AT_DESK'), -1);
  assert.equal(phaseStep(null), -1);
  // an engine phase this UI has never heard of must not render as step 0
  assert.equal(phaseStep('SOME_FUTURE_PHASE'), -1);
});

test('every mapped step index is in range of the drawn steps', () => {
  for (const phase of ['COLLECTING', 'EN_ROUTE', 'ARRIVED', 'RETURNING', 'RECALLED']) {
    const n = phaseStep(phase);
    assert.ok(n >= 0 && n < PHASE_STEPS.length, `${phase} -> ${n}`);
  }
});

test('humanPhase falls through to the raw phase rather than blanking', () => {
  assert.equal(humanPhase('EN_ROUTE'), 'On the way');
  assert.equal(humanPhase('WHAT_IS_THIS'), 'WHAT_IS_THIS');
  assert.equal(humanPhase(null), '—');
});

test('formatItems collapses duplicates into quantities, in spoken order', () => {
  // this is the shape dispatch_delivery actually writes: duplicates, not counts
  assert.equal(formatItems(['towel', 'towel', 'nasi lemak']), '2× towel, 1× nasi lemak');
  assert.equal(formatItems(['towel']), '1× towel');
  // first-appearance order preserved, not alphabetical or count order
  assert.equal(formatItems(['b', 'a', 'a']), '1× b, 2× a');
  assert.equal(formatItems([]), '—');
  assert.equal(formatItems(null), '—');
});

test('duration needs both ends and never renders negative time', () => {
  const t0 = '2026-09-13T20:41:55.000Z';
  const t1 = '2026-09-13T20:47:12.000Z';
  assert.equal(duration(t0, t1), '5m 17s');
  // zero-padded seconds, so the column stays aligned
  assert.equal(duration(t0, '2026-09-13T20:42:03.000Z'), '0m 08s');
  assert.equal(duration(t0, null), '—');
  assert.equal(duration(null, t1), '—');
  // clock skew between processes must not print "-1m"
  assert.equal(duration(t1, t0), '—');
});

test('ago is pure — the caller supplies now', () => {
  const now = Date.parse('2026-09-13T21:00:00.000Z');
  assert.equal(ago('2026-09-13T20:59:30.000Z', now), '30s ago');
  assert.equal(ago('2026-09-13T20:55:00.000Z', now), '5m ago');
  assert.equal(ago('2026-09-13T18:00:00.000Z', now), '3h ago');
  assert.equal(ago('2026-09-11T21:00:00.000Z', now), '2d ago');
  // a row written a moment in the future (clock skew) clamps to 0, not -3s
  assert.equal(ago('2026-09-13T21:00:03.000Z', now), '0s ago');
  assert.equal(ago(null, now), '—');
});

test('formatPrice handles the string numerics PostgREST returns', () => {
  assert.equal(formatPrice('8.00'), '$8.00');
  assert.equal(formatPrice(21), '$21.00');
  // amenities are free — a $0.00 price column is noise, not information
  assert.equal(formatPrice(0), '—');
  assert.equal(formatPrice(null), '—');
});

test('median handles both parities and an empty set', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('medianDeskToDoor ignores tasks that never arrived', () => {
  const rows = [
    { dispatched_at: '2026-09-13T20:00:00Z', arrived_at: '2026-09-13T20:05:00Z' },
    { dispatched_at: '2026-09-13T20:10:00Z', arrived_at: '2026-09-13T20:17:00Z' },
    // in flight / cancelled — must not count as a 0s delivery
    { dispatched_at: '2026-09-13T20:20:00Z', arrived_at: null },
    { dispatched_at: null, arrived_at: null },
  ] as never[];
  assert.equal(medianDeskToDoor(rows), '6m 00s');
  assert.equal(medianDeskToDoor([]), '—');
});

test('isTerminal marks exactly the two end states', () => {
  assert.ok(isTerminal('DONE'));
  assert.ok(isTerminal('AT_DESK'));
  assert.ok(!isTerminal('EN_ROUTE'));
  assert.ok(!isTerminal('RECALLED')); // still driving home
});

const sess = (id: string, started: string, ended: string | null = null) =>
  ({ id, agent_id: null, room: null, started_at: started, ended_at: ended }) as never;

test('pickLiveSession takes the newest genuinely-active open session', () => {
  const now = Date.parse('2026-09-13T21:00:00Z');
  const sessions = [
    sess('older', '2026-09-13T20:58:00Z'),
    sess('newer', '2026-09-13T20:59:30Z'),
  ];
  const live = pickLiveSession(sessions, { older: now - 5000, newer: now - 2000 }, now);
  assert.equal(live?.id, 'newer');
});

test('pickLiveSession ignores a closed session even if it is newest', () => {
  const now = Date.parse('2026-09-13T21:00:00Z');
  const sessions = [
    sess('open', '2026-09-13T20:58:00Z'),
    sess('closed', '2026-09-13T20:59:30Z', '2026-09-13T20:59:50Z'),
  ];
  assert.equal(pickLiveSession(sessions, { open: now - 3000 }, now)?.id, 'open');
});

test('pickLiveSession drops an open session that went quiet', () => {
  // agent.py closes the session in a finally; a SIGKILL never runs it, so an
  // abandoned session stays ended_at null forever. It must not read as live.
  const now = Date.parse('2026-09-13T21:00:00Z');
  const sessions = [sess('abandoned', '2026-09-13T18:00:00Z')];
  assert.equal(pickLiveSession(sessions, { abandoned: now - 600_000 }, now), null);
  // with no activity recorded at all, started_at is the fallback clock
  assert.equal(pickLiveSession(sessions, {}, now), null);
  // ...and a session that just started counts as live even with no rows yet
  const fresh = [sess('fresh', '2026-09-13T20:59:50Z')];
  assert.equal(pickLiveSession(fresh, {}, now)?.id, 'fresh');
});

test('replyLatencyMs measures from the most recent preceding guest turn', () => {
  const guest = [1000, 5000, 9000];
  assert.equal(replyLatencyMs(5800, guest), 800);   // answered the 5000 turn
  assert.equal(replyLatencyMs(9400, guest), 400);   // answered the 9000 turn
  assert.equal(replyLatencyMs(1200, guest), 200);
  // nothing said before it — the agent's greeting, for instance
  assert.equal(replyLatencyMs(500, guest), null);
  assert.equal(replyLatencyMs(5800, []), null);
});

test('latencyLabel formats to one decimal and hides nonsense', () => {
  assert.equal(latencyLabel(800), '+0.8s');
  assert.equal(latencyLabel(1240), '+1.2s');
  assert.equal(latencyLabel(null), '');
  assert.equal(latencyLabel(-5), ''); // clock skew, not a negative round trip
});

test('roomFromCalls takes the last room any tool was given', () => {
  assert.equal(roomFromCalls([{ arguments: { room: '1204', items: ['towel'] } }]), '1204');
  // amended mid-call: the later room is the one that matters
  assert.equal(roomFromCalls([
    { arguments: { room: '1204' } },
    { arguments: { items: ['towel'] } },   // no room — must not clear it
    { arguments: { new_room: '0803' } },   // different key — not a room
    { arguments: { room: '1512' } },
  ]), '1512');
  assert.equal(roomFromCalls([{ arguments: { items: ['towel'] } }]), null);
  assert.equal(roomFromCalls([{ arguments: null }]), null);
  assert.equal(roomFromCalls([]), null);
  // a model that sent the room as a number still reads
  assert.equal(roomFromCalls([{ arguments: { room: 1204 } }]), '1204');
  // whitespace-only is not a room
  assert.equal(roomFromCalls([{ arguments: { room: '   ' } }]), null);
});

test('argPairsFor reads a hotel_info topic as words for staff', () => {
  assert.deepEqual(argPairsFor({ topic: 'late_checkout' }, false, { topic: 'Topic' }),
    [{ k: 'Topic', v: 'late checkout' }]);
  assert.deepEqual(argPairsFor({ topic: 'late_checkout' }, true, { topic: 'Topic' }),
    [{ k: 'topic', v: 'late_checkout' }]);
});

test('argPairsFor keeps staff view free of machine detail', () => {
  const human = { room: 'Room', items: 'Items', task_id: 'Order', priority: 'Priority' };
  const args = { room: '1204', items: ['towel', 'towel'], priority: 'normal', task_id: 'tsk_4d33' };

  const staff = argPairsFor(args, false, human);
  assert.deepEqual(staff, [
    { k: 'Room', v: '1204' },
    // duplicates are the quantity — "towel, towel" is how the data is stored,
    // not how anyone says it
    { k: 'Items', v: '2× towel' },
    { k: 'Priority', v: 'normal' },
    { k: 'Order', v: 'Order 4D33' },
  ]);

  // dev sees the raw keys and the unchanged list
  const devPairs = argPairsFor(args, true, human);
  assert.deepEqual(devPairs[1], { k: 'items', v: 'towel, towel' });
  assert.equal(devPairs[3].v, 'tsk_4d33');
});

test('argPairsFor drops empties rather than printing null', () => {
  const pairs = argPairsFor(
    { room: '1204', add: [], remove: null, reason: '' }, false, { room: 'Room' });
  assert.deepEqual(pairs, [{ k: 'Room', v: '1204' }]);
  assert.deepEqual(argPairsFor(null, false, {}), []);
});

test('roomForCall prefers the switchboard over the derived room', () => {
  const withRoom = { room: '1204' };
  const noRoom = { room: null };
  const calls = [{ arguments: { room: '0803' } }];

  // the PBX knew before anyone spoke — that wins over whatever a tool got
  assert.equal(roomForCall(withRoom, calls), '1204');
  // no caller ID: fall back to what the guest told a tool
  assert.equal(roomForCall(noRoom, calls), '0803');
  assert.equal(roomForCall(null, calls), '0803');
  // neither
  assert.equal(roomForCall(noRoom, []), null);
  // a blank room on the session is not a room
  assert.equal(roomForCall({ room: '  ' }, calls), '0803');
});

test('guestLabel names the room when we know it', () => {
  assert.equal(guestLabel('1204', false), 'Guest · 1204');
  assert.equal(guestLabel('1204', true), 'guest · 1204');
  assert.equal(guestLabel(null, false), 'Guest');
  assert.equal(guestLabel(null, true), 'guest');
});

test('outcomesFor lists every outcome of a call, not just the order', () => {
  const calls = [
    { tool_name: 'check_menu', arguments: { items: ['towel'] }, result: [] },
    { tool_name: 'dispatch_delivery', arguments: { room: '1204', items: ['towel', 'shampoo'] },
      result: { task_id: '543a3e29', dispatched_items: [{ name: 'towel' }] } },
    { tool_name: 'amend_delivery', arguments: { task_id: '543a3e29', add: ['mee goreng'] }, result: {} },
    { tool_name: 'escalate_to_frontdesk', arguments: { reason: 'Aircon is broken', room: '1204' }, result: { ack: true } },
    { tool_name: 'hotel_info', arguments: { topic: 'late_checkout' }, result: {} },
  ];
  assert.deepEqual(outcomesFor(calls, false), [
    // what was actually SENT (shampoo was refused), plus the amendment
    { key: 'o543a3e29', label: 'Order 543A3E29 · 1× towel, 1× mee goreng' },
    { key: 'e0', label: 'Front desk · Aircon is broken', alert: true },
    { key: 'i', label: 'Answered · late checkout' },
  ]);
  // a refused dispatch (no task_id) is not an order
  assert.deepEqual(outcomesFor([{ tool_name: 'dispatch_delivery', arguments: {}, result: { task_id: null } }], false), []);
});

test('outcomesFor treats a delivery-app hand-off as an order', () => {
  const calls = [{ tool_name: 'deliver_parcel', arguments: { room: '1204', source: 'Uber Eats' },
    result: { task_id: 'ab12cd34', dispatched_items: [{ name: 'Uber Eats food order' }] } }];
  assert.deepEqual(outcomesFor(calls, false),
    [{ key: 'oab12cd34', label: 'Order AB12CD34 · 1× Uber Eats food order' }]);
});

test('outcomesFor folds a joined delivery-app bag into the waiting order', () => {
  const calls = [
    { tool_name: 'dispatch_delivery', arguments: { room: '1204', items: ['towel', 'conditioner'] },
      result: { task_id: 'aa11bb22', dispatched_items: [{ name: 'towel' }, { name: 'conditioner' }] } },
    { tool_name: 'deliver_parcel', arguments: { room: '1204', source: 'Grab' },
      result: { task_id: 'aa11bb22', joined_existing_order: true, dispatched_items: [{ name: 'Grab food order' }] } },
  ];
  assert.deepEqual(outcomesFor(calls, false),
    [{ key: 'oaa11bb22', label: 'Order AA11BB22 · 1× towel, 1× conditioner, 1× Grab food order' }]);
});
