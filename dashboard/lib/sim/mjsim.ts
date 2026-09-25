/**
 * The engine's `Sim` over a MuJoCo WASM model -- the browser twin of
 * sim/concierge_sim.py's DeliveryBotSimulator. Shared by the worker and the
 * Node self-check (scripts/engine-selfcheck.mts), so both drive the same code.
 */
import type { Sim } from './engine';

// Mirrors sim/concierge_sim.py -- keep in step if the model's actuators change.
const CTRL_PER_MPS = 50.0;
const CTRL_PER_RADPS = 12.0;
const DOOR_TOP_RANGE_M = 0.16;
const DOOR_BOTTOM_RANGE_M = 0.04;
const ROOM_DOOR_OPEN_RAD = 1.75;
const ROOM_DOOR_RADPS = ROOM_DOOR_OPEN_RAD / 1.5;

type Mj = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export class MjSim implements Sim {
  camera = 'follow';
  private act: Record<string, number> = {};
  private jnt: Record<string, number> = {}; // cargo slide joints -> qpos adr
  private rooms: Record<string, { q: number; d: number; target: number }> = {};

  private mj: Mj; model: Mj; data: Mj;
  constructor(mj: Mj, model: Mj, data: Mj) {
    this.mj = mj; this.model = model; this.data = data;
    const ACT = mj.mjtObj.mjOBJ_ACTUATOR.value, JNT = mj.mjtObj.mjOBJ_JOINT.value;
    for (const n of ['forward', 'turn', 'lid_top_pos', 'lid_bottom_pos']) this.act[n] = mj.mj_name2id(model, ACT, n);
    this.jnt.lid_top_pos = model.jnt_qposadr[mj.mj_name2id(model, JNT, 'lid_top_slide')];
    this.jnt.lid_bottom_pos = model.jnt_qposadr[mj.mj_name2id(model, JNT, 'lid_bottom_slide')];
    for (const room of ['0803', '0804', '1204', '1205']) {
      const j = mj.mj_name2id(model, JNT, 'door_hinge_' + room);
      if (j >= 0) this.rooms[room] = { q: model.jnt_qposadr[j], d: model.jnt_dofadr[j], target: 0 };
    }
  }

  /** One physics step, with the kinematic room doors (like _step_room_doors). */
  step() {
    const dt = this.model.opt.timestep, qpos = this.data.qpos, qvel = this.data.qvel;
    for (const r of Object.values(this.rooms)) {
      const err = r.target - qpos[r.q];
      if (err) { const s = ROOM_DOOR_RADPS * dt; qpos[r.q] += Math.max(-s, Math.min(s, err)); }
      qvel[r.d] = 0;
    }
    this.mj.mj_step(this.model, this.data);
  }

  pose() {
    const q = this.data.qpos;
    const [w, x, y, z] = [q[3], q[4], q[5], q[6]];
    return { x: q[0], y: q[1], yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) };
  }
  drive(v: number, omega: number) {
    const c = this.data.ctrl;
    c[this.act.forward] = v * CTRL_PER_MPS;
    c[this.act.turn] = omega * CTRL_PER_RADPS;
  }
  stopBase() { this.drive(0, 0); }
  private door(open: boolean) {
    const c = this.data.ctrl;
    c[this.act.lid_top_pos] = open ? DOOR_TOP_RANGE_M : 0;
    c[this.act.lid_bottom_pos] = open ? DOOR_BOTTOM_RANGE_M : 0;
  }
  openDoor() { this.door(true); }
  closeDoor() { this.door(false); }
  doorFraction() {
    const q = this.data.qpos, clamp = (v: number) => Math.max(0, Math.min(1, v));
    return (clamp(q[this.jnt.lid_top_pos] / DOOR_TOP_RANGE_M) + clamp(q[this.jnt.lid_bottom_pos] / DOOR_BOTTOM_RANGE_M)) / 2;
  }
  hasRoomDoor(room: string) { return room in this.rooms; }
  setRoomDoor(room: string, open: boolean) { if (this.rooms[room]) this.rooms[room].target = open ? ROOM_DOOR_OPEN_RAD : 0; }
  roomDoorFraction(room: string) { return this.rooms[room] ? this.data.qpos[this.rooms[room].q] / ROOM_DOOR_OPEN_RAD : 0; }
  setCamera(name: string) { this.camera = name; }
}
