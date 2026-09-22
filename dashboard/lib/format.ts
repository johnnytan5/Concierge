/**
 * Translation layer between the task engine's vocabulary and the UI's.
 *
 * The engine FSM has 7 phases; the mockup drew 5 progress steps. Rather
 * than inventing engine states to match the drawing, the steps collapse to
 * the 4 that have a real physical referent in the sim. The dropped one was
 * TO_KITCHEN — the robot never drives to a kitchen, it waits at the desk to
 * be loaded, which is what COLLECTING already means.
 */
import type { DeliveryRow, SessionRow } from './types';

/** The 4 UI progress steps, in order. Index === step number. */
export const PHASE_STEPS = ['LOADING', 'TO_ROOM', 'AT_DOOR', 'RETURNING'] as const;

export const STEP_HUMAN: Record<string, string> = {
  LOADING: 'Loading',
  TO_ROOM: 'On the way',
  AT_DOOR: 'At the door',
  RETURNING: 'Returning',
};

/** Engine phase -> UI step index. -1 means "not on a run". */
const PHASE_TO_STEP: Record<string, number> = {
  COLLECTING: 0,
  EN_ROUTE: 1,
  ARRIVED: 2,
  RETURNING: 3,
  RECALLED: 3, // driving home early — same leg, different reason
};

export function phaseStep(phase: string | null | undefined): number {
  if (!phase) return -1;
  const n = PHASE_TO_STEP[phase];
  return n === undefined ? -1 : n;
}

/** Staff-facing wording for any engine phase, moving or not. */
export const PHASE_HUMAN: Record<string, string> = {
  IDLE: 'Idle',
  QUEUED: 'Waiting for a robot',
  COLLECTING: 'Loading',
  EN_ROUTE: 'On the way',
  ARRIVED: 'At the door',
  RETURNING: 'Returning',
  RECALLED: 'Recalled',
  AT_DESK: 'Back at desk',
  DONE: 'Delivered',
};

export function humanPhase(phase: string | null | undefined): string {
  if (!phase) return '—';
  return PHASE_HUMAN[phase] ?? phase;
}

/**
 * Terminal delivery phases, for the Deliveries tab's status column.
 * DONE is a completed delivery; AT_DESK is where a recalled or cancelled
 * task ends up. Nothing currently writes an "escalated" delivery phase —
 * escalations live in their own table with no link back to a task — so
 * there is deliberately no mapping for one here.
 */
export const TERMINAL_HUMAN: Record<string, string> = {
  DONE: 'Delivered',
  AT_DESK: 'Cancelled',
};

export function isTerminal(phase: string): boolean {
  return phase === 'DONE' || phase === 'AT_DESK';
}

/**
 * `deliveries.items` is a flat jsonb list with duplicates standing in for
 * quantity — ordering two towels is ['towel','towel'], because that is what
 * the voice agent's dispatch_delivery receives. Collapse to "2× towel",
 * keeping first-appearance order so the list reads the way it was spoken.
 */
export function formatItems(items: string[] | null | undefined): string {
  if (!items || items.length === 0) return '—';
  const counts = new Map<string, number>();
  for (const raw of items) {
    const name = String(raw);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([name, n]) => `${n}× ${name}`).join(', ');
}

/** Clock time, for log columns. Empty input renders as an em dash. */
export function hhmmss(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

/** Desk-to-door time. Both ends required; either missing reads as em dash. */
export function duration(from: string | null, to: string | null): string {
  if (!from || !to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

/**
 * Relative age. `now` is injectable so this stays a pure function — the
 * caller passes a value from a client-side ticker, which also keeps it out
 * of server-rendered markup where it would cause a hydration mismatch.
 */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Price column. numeric(10,2) arrives from PostgREST as a string. */
export function formatPrice(price: number | string | null | undefined): string {
  if (price === null || price === undefined || price === '') return '—';
  const n = typeof price === 'string' ? Number(price) : price;
  if (!Number.isFinite(n) || n === 0) return '—';
  return `$${n.toFixed(2)}`;
}

/** Median of a numeric list, for the fleet stat strip. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The call currently in progress, if any.
 *
 * `ended_at is null` alone is not enough: orchestrator/agent.py closes the
 * session in a `finally`, which a hard kill (SIGKILL, laptop asleep, crash)
 * never reaches — so a dead session can sit open forever and the live view
 * would keep presenting it as active. A session also has to have shown signs
 * of life recently, which is what `lastActivityById` carries: the newest
 * transcript-turn or tool-call timestamp seen for that session.
 */
export function pickLiveSession(
  sessions: SessionRow[],
  lastActivityById: Record<string, number>,
  now: number,
  staleMs = 90_000,
): SessionRow | null {
  const open = sessions
    .filter((s) => !s.ended_at)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));

  for (const s of open) {
    const last = Math.max(lastActivityById[s.id] ?? 0, Date.parse(s.started_at));
    if (Number.isFinite(last) && now - last < staleMs) return s;
  }
  return null;
}

/**
 * The room a call is about, as last stated to a tool.
 *
 * The guest never says their room to the database — it reaches us only as an
 * argument the model passed to `dispatch_delivery`, `check_delivery_status`
 * or `escalate_to_frontdesk`. Last one wins: on a call that amends the room
 * mid-flight, the later value is the one that matters.
 */
export function roomForCall(
  session: Pick<SessionRow, 'room'> | null | undefined,
  calls: Array<{ arguments: Record<string, unknown> | null }>,
): string | null {
  // The switchboard's value wins. It is known before anyone speaks, whereas
  // the derived one is whatever room happened to be passed to a tool — which
  // is the right answer only when nobody told us up front.
  return session?.room?.trim() || roomFromCalls(calls);
}

export function roomFromCalls(
  calls: Array<{ arguments: Record<string, unknown> | null }>,
): string | null {
  let room: string | null = null;
  for (const c of calls) {
    const v = c.arguments?.room;
    if (typeof v === 'string' && v.trim()) room = v.trim();
    else if (typeof v === 'number') room = String(v);
  }
  return room;
}

/**
 * Tool arguments, rendered for whoever is reading.
 *
 * Staff view collapses an item list to quantities the way the guest actually
 * said it ("2× towel", not "towel, towel"), makes an order id readable, and
 * drops keys that mean nothing to a front-desk worker. Dev view is verbatim.
 */
export function argPairsFor(
  args: Record<string, unknown> | null,
  dev: boolean,
  argHuman: Record<string, string>,
): Array<{ k: string; v: string }> {
  if (!args) return [];
  const out: Array<{ k: string; v: string }> = [];

  for (const [k, raw] of Object.entries(args)) {
    if (raw === null || raw === undefined || raw === '') continue;
    if (Array.isArray(raw) && raw.length === 0) continue;

    let v: string;
    if (Array.isArray(raw)) {
      // item lists carry quantity as repeats — collapse for staff, keep raw for dev
      v = dev ? raw.join(', ') : formatItems(raw.map(String));
    } else if (!dev && (k === 'task_id') && typeof raw === 'string') {
      v = 'Order ' + raw.replace(/^tsk_/, '').toUpperCase();
    } else {
      v = String(raw);
    }
    out.push({ k: dev ? k : (argHuman[k] ?? k), v });
  }
  return out;
}

/** "Guest · 1204", or just "Guest" when the room never came up. */
export function guestLabel(room: string | null, dev: boolean): string {
  const base = dev ? 'guest' : 'Guest';
  return room ? `${base} · ${room}` : base;
}

/**
 * Newest row timestamp seen per session, across both child tables — the
 * "sign of life" input `pickLiveSession` needs. Rows carrying no session id
 * (written before voice_sessions existed) are skipped.
 */
export function lastActivityBySession(
  ...rowSets: Array<Array<{ session_id: string | null; created_at: string }>>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rows of rowSets) {
    for (const r of rows) {
      if (!r.session_id) continue;
      const t = Date.parse(r.created_at);
      if (Number.isFinite(t)) out[r.session_id] = Math.max(out[r.session_id] ?? 0, t);
    }
  }
  return out;
}

/**
 * Milliseconds from the most recent guest turn at or before `at`.
 *
 * This is RQ3's measure — end of the guest's turn to the thing that answered
 * it, whether that is a tool firing or the agent speaking. Approximate by
 * construction: the timestamps are when the orchestrator wrote the row, not
 * when audio left the speaker, so read it as an upper bound on the round
 * trip rather than a precise figure.
 */
export function replyLatencyMs(at: number, guestTurnTimes: number[]): number | null {
  let best: number | null = null;
  for (const t of guestTurnTimes) {
    if (t <= at && (best === null || t > best)) best = t;
  }
  return best === null ? null : at - best;
}

/** Compact latency badge text: "+0.8s". Null input renders as empty. */
export function latencyLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  return '+' + (ms / 1000).toFixed(1) + 's';
}

/** Median desk→door across delivered tasks, pre-formatted. */
export function medianDeskToDoor(deliveries: DeliveryRow[]): string {
  const secs = deliveries
    .filter((d) => d.dispatched_at && d.arrived_at)
    .map((d) => (new Date(d.arrived_at!).getTime() - new Date(d.dispatched_at!).getTime()) / 1000)
    .filter((n) => Number.isFinite(n) && n >= 0);
  const m = median(secs);
  if (m === null) return '—';
  return `${Math.floor(m / 60)}m ${String(Math.round(m % 60)).padStart(2, '0')}s`;
}
