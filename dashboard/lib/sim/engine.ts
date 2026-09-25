/**
 * The robot's task engine, in the browser: a straight port of
 * task_engine/engine.py + nav.py (phases, pure pursuit over the hand-authored
 * waypoints, the desk loading scene, the room hand-over, parking). Keep the
 * two in step -- the docstrings on the Python side explain every "why".
 *
 * One robot only: the browser runs one MuJoCo world, so a second order waits
 * QUEUED until the robot is free (the Python stack runs two).
 *
 * Pure logic over the `Sim` interface; lib/sim/mjsim.ts is the MuJoCo side.
 * `now` is sim time in seconds, so the Node self-check runs deterministically.
 */

export type Pt = [number, number];
export type Paths = Record<string, Pt[]>;

export interface Sim {
  pose(): { x: number; y: number; yaw: number }; // yaw in radians
  drive(v: number, omega: number): void;
  stopBase(): void;
  openDoor(): void;
  closeDoor(): void;
  doorFraction(): number;
  hasRoomDoor(room: string): boolean;
  setRoomDoor(room: string, open: boolean): void;
  roomDoorFraction(room: string): number;
  setCamera(name: string): void;
}

export const TICK_HZ = 5;
export const DRIVE_SPEED_MPS = 0.11;
const CANONICAL_PARK_YAW = 0;
const HEADING_TOLERANCE_DEG = 5;
const ROOM_PRESENT_YAW: Record<string, number> = {
  '0803': 0, '0804': Math.PI, '1204': Math.PI / 2, '1205': -Math.PI / 2,
};
const DESK_PRESENT_YAW = -Math.PI / 2;
export const CARGO_HOLD_S = 4;

// ---- nav.py ----------------------------------------------------------------

export function totalLength(p: Pt[]) {
  let s = 0;
  for (let i = 0; i < p.length - 1; i++) s += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
  return s;
}

function pointAt(p: Pt[], s: number): Pt {
  let rem = s;
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (rem <= len) { const t = len > 0 ? rem / len : 0; return [x0 + t * (x1 - x0), y0 + t * (y1 - y0)]; }
    rem -= len;
  }
  return p[p.length - 1];
}

function closestArc(p: Pt[], x: number, y: number) {
  let best = 0, bestD = Infinity, cum = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len > 0) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / (len * len)));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      if (d < bestD) { bestD = d; best = cum + t * len; }
    }
    cum += len;
  }
  return best;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function bearingFromHere(sim: Sim, p: Pt[], look = 0.15) {
  const { x, y } = sim.pose();
  const [lx, ly] = pointAt(p, closestArc(p, x, y) + look);
  return Math.atan2(ly - y, lx - x);
}

function purePursuit(sim: Sim, p: Pt[], speed: number, tol = 0.05, gain = 2) {
  const { x, y, yaw } = sim.pose();
  const s = closestArc(p, x, y);
  const [lx, ly] = pointAt(p, s + 0.15);
  sim.drive(speed, gain * wrap(Math.atan2(ly - y, lx - x) - yaw));
  const total = totalLength(p);
  const [fx, fy] = p[p.length - 1];
  return { progress: s, frac: total > 0 ? Math.min(s / total, 1) : 1, done: Math.hypot(fx - x, fy - y) <= tol };
}

function rotateToward(sim: Sim, target: number, gain = 2) {
  const err = wrap(target - sim.pose().yaw);
  if (Math.abs(err) * 180 / Math.PI <= HEADING_TOLERANCE_DEG) { sim.stopBase(); return true; }
  sim.drive(0, gain * err);
  return false;
}

// ---- engine.py -------------------------------------------------------------

export type Phase = 'QUEUED' | 'COLLECTING' | 'EN_ROUTE' | 'ARRIVED' | 'RETURNING' | 'RECALLED' | 'PARKING' | 'DONE' | 'AT_DESK';

export type Task = {
  task_id: string; room: string; items: string[]; priority: string; phase: Phase;
  dispatched_at: number | null; arrived_at: number | null; progress_m: number; eta_seconds: number;
  announced: boolean; reason: string | null;
  _leg: boolean; _load?: string; _arr?: string; _arrT?: number; _park?: Phase; _restore?: boolean;
};

export type Cmd =
  | { cmd: 'dispatch'; task_id: string; room: string; items?: string[]; priority?: string }
  | { cmd: 'amend'; task_id: string; add?: string[]; remove?: string[]; new_room?: string }
  | { cmd: 'recall'; task_id: string; reason?: string }
  | { cmd: 'announce'; task_id: string };

export class Engine {
  tasks: Record<string, Task> = {};
  robot = { robot_id: 'robot_1', phase: 'IDLE' as Phase | 'IDLE', pose_frac: 0, battery: 100, current_task: null as string | null };
  private sim: Sim; private paths: Paths; private speed: number;
  constructor(sim: Sim, paths: Paths, speed = DRIVE_SPEED_MPS) { this.sim = sim; this.paths = paths; this.speed = speed; }

  path(room: string) {
    const p = this.paths[room];
    if (!p) throw new Error(`no waypoint path for room ${room}`);
    return p;
  }
  etaFor(room: string) { return totalLength(this.path(room)) / DRIVE_SPEED_MPS; }

  handle(c: Cmd, now: number) {
    const t = this.tasks[c.task_id];
    if (c.cmd === 'dispatch') {
      this.tasks[c.task_id] = {
        task_id: c.task_id, room: c.room, items: [...(c.items ?? [])], priority: c.priority ?? 'normal',
        phase: 'QUEUED', dispatched_at: null, arrived_at: null, progress_m: 0, eta_seconds: this.etaFor(c.room),
        announced: false, reason: null, _leg: false,
      };
    } else if (c.cmd === 'amend') {
      if (!t || ['ARRIVED', 'RETURNING', 'PARKING', 'DONE', 'AT_DESK'].includes(t.phase)) return;
      const items = [...t.items]; // a list: duplicates are the quantity
      for (const x of c.remove ?? []) { const i = items.indexOf(x); if (i >= 0) items.splice(i, 1); }
      t.items = [...items, ...(c.add ?? [])];
      if (c.new_room) { t.room = c.new_room; t.eta_seconds = this.etaFor(c.new_room); }
      if (t.phase === 'EN_ROUTE') t.dispatched_at = now;
    } else if (c.cmd === 'recall') {
      if (!t) return;
      if (t.phase === 'QUEUED') t.phase = 'AT_DESK';
      else if (t.phase === 'COLLECTING') { t.phase = 'PARKING'; t._park = 'AT_DESK'; t._restore = true; delete t._load; }
      else if (t.phase === 'EN_ROUTE') { t.phase = 'RECALLED'; t.dispatched_at = now; t._leg = false; }
      else if (t.phase === 'ARRIVED') { t.phase = 'RETURNING'; t._leg = false; delete t._arr; delete t._arrT; t._restore = true; }
      else return;
      t.reason = c.reason ?? null;
    } else if (c.cmd === 'announce') {
      if (t) t.announced = true;
    }
  }

  /** One 5 Hz tick. `confirmed` = the kiosk button (Bin loaded / collected). */
  tick(now: number, confirmed = false) {
    const r = this.robot;
    if (r.current_task === null) {
      const next = Object.values(this.tasks).find((t) => t.phase === 'QUEUED');
      if (next) { next.phase = 'COLLECTING'; r.current_task = next.task_id; }
    }
    if (r.current_task === null) { r.phase = 'IDLE'; return; }
    const t = this.tasks[r.current_task];
    const frac = this.advance(t, now, confirmed);
    if (frac !== null) r.pose_frac = frac;
    r.phase = t.phase;
    if (t.phase === 'DONE' || t.phase === 'AT_DESK') { r.current_task = null; r.phase = 'IDLE'; }
  }

  advance(t: Task, now: number, confirmed: boolean): number | null {
    const sim = this.sim;
    switch (t.phase) {
      case 'COLLECTING': this.loading(t, now, confirmed); return 0;
      case 'EN_ROUTE': {
        const p = this.path(t.room);
        if (!t._leg) { if (rotateToward(sim, bearingFromHere(sim, p))) t._leg = true; return 0; }
        const r = purePursuit(sim, p, this.speed);
        t.progress_m = r.progress;
        if (r.done) { sim.stopBase(); t.phase = 'ARRIVED'; t.arrived_at = now; t._arr = 'turn'; }
        return r.frac;
      }
      case 'ARRIVED': this.arrival(t, now, confirmed); return 1;
      case 'RETURNING': return this.driveHome(t, 'DONE');
      case 'RECALLED': return this.driveHome(t, 'AT_DESK');
      case 'PARKING':
        if (t._restore) { delete t._restore; sim.closeDoor(); sim.setCamera('follow'); }
        if (rotateToward(sim, CANONICAL_PARK_YAW)) { t.phase = t._park!; delete t._park; }
        return 1;
      default: return null;
    }
  }

  private driveHome(t: Task, terminal: Phase) {
    const sim = this.sim;
    sim.closeDoor();
    if (t._restore) { delete t._restore; sim.setRoomDoor(t.room, false); sim.setCamera('follow'); }
    const p = [...this.path(t.room)].reverse();
    if (!t._leg) { if (rotateToward(sim, bearingFromHere(sim, p))) t._leg = true; return 1; }
    const r = purePursuit(sim, p, this.speed);
    t.progress_m = r.progress;
    if (r.done) { t.phase = 'PARKING'; t._park = terminal; }
    return 1 - r.frac;
  }

  private loading(t: Task, now: number, confirmed: boolean) {
    const sim = this.sim;
    const step = t._load ?? 'turn';
    if (step === 'turn') {
      if (rotateToward(sim, DESK_PRESENT_YAW)) { sim.setCamera('desk_staff'); sim.openDoor(); t._load = 'open'; }
    } else if (step === 'open') {
      if (confirmed) { sim.closeDoor(); t._load = 'closing'; }
    } else if (step === 'closing' && sim.doorFraction() <= 0.05) {
      sim.setCamera('follow');
      t.phase = 'EN_ROUTE'; t.dispatched_at = now; t._leg = false; delete t._load;
    }
  }

  private arrival(t: Task, now: number, confirmed: boolean) {
    const sim = this.sim, room = t.room;
    const step = t._arr ?? 'turn';
    if (step === 'turn') {
      const yaw = ROOM_PRESENT_YAW[room];
      if (yaw === undefined || rotateToward(sim, yaw)) { sim.setCamera('room_' + room); sim.setRoomDoor(room, true); t._arr = 'room_opening'; }
    } else if (step === 'room_opening') {
      if (!sim.hasRoomDoor(room) || sim.roomDoorFraction(room) >= 0.98) { sim.openDoor(); t._arrT = now; t._arr = 'cargo_open'; }
    } else if (step === 'cargo_open') {
      if (confirmed || now - t._arrT! >= CARGO_HOLD_S) { sim.closeDoor(); t._arr = 'cargo_closing'; }
    } else if (step === 'cargo_closing') {
      if (sim.doorFraction() <= 0.05) { sim.setRoomDoor(room, false); t._arr = 'room_closing'; }
    } else if (step === 'room_closing' && sim.roomDoorFraction(room) <= 0.02) {
      sim.setCamera('follow');
      delete t._arrT; delete t._arr; t.phase = 'RETURNING'; t._leg = false;
    }
  }
}
