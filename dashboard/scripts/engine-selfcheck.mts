/**
 * Self-check for the browser engine port (lib/sim/engine.ts + mjsim.ts),
 * mirroring task_engine/engine.py's demo(): real MuJoCo WASM, the real corridor
 * scene, 5 Hz ticks at the live drive speed. One robot, so the scenarios run
 * back to back instead of two robots at once.
 *
 *   npm run sync-sim && node scripts/engine-selfcheck.mts
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Engine, TICK_HZ, type Paths } from '../lib/sim/engine.ts';
import { MjSim } from '../lib/sim/mjsim.ts';

const root = new URL('..', import.meta.url);
const { default: loadMujoco } = await import(new URL('public/mujoco/mujoco.js', root).href);
const mj = await loadMujoco();
mj.FS.mkdir('/sim');
for (const f of ['scene_corridor.xml', 'delivery_bot_v2.xml']) {
  mj.FS.writeFile(`/sim/${f}`, readFileSync(new URL(`public/sim/${f}`, root), 'utf8'));
}
const model = mj.MjModel.from_xml_path('/sim/scene_corridor.xml');
const data = new mj.MjData(model);
mj.mj_resetDataKeyframe(model, data, 0);
mj.mj_forward(model, data);

const sim = new MjSim(mj, model, data);
const paths: Paths = JSON.parse(readFileSync(new URL('public/sim/waypoints.json', root), 'utf8'));
const eng = new Engine(sim, paths);
const stepsPerTick = Math.round(1 / TICK_HZ / model.opt.timestep);
const deg = (r: number) => r * 180 / Math.PI;

const cams: string[] = [];
function tick(confirmed = false) {
  for (let i = 0; i < stepsPerTick; i++) sim.step();
  eng.tick(data.time, confirmed);
  if (cams[cams.length - 1] !== sim.camera) cams.push(sim.camera);
}
function until(pred: () => boolean, max: number, confirmed = false) {
  for (let i = 0; i < max; i++) { if (pred()) return i; tick(confirmed); }
  assert.fail(`timed out after ${max} ticks: ${JSON.stringify(eng.robot)} ${JSON.stringify(eng.tasks[eng.robot.current_task ?? ''])}`);
}
const phase = (id: string) => eng.tasks[id].phase;

// amend keeps quantities (a list, not a set) -- pure logic, before physics
eng.handle({ cmd: 'dispatch', task_id: 'q', room: '0804', items: ['towel', 'towel', 'soap'] }, 0);
eng.handle({ cmd: 'amend', task_id: 'q', remove: ['towel'], add: ['towel', 'water'] }, 0);
assert.deepEqual(eng.tasks.q.items, ['towel', 'soap', 'towel', 'water']);
eng.handle({ cmd: 'recall', task_id: 'q' }, 0);
assert.equal(phase('q'), 'AT_DESK', 'recall while QUEUED cancels');

// two orders: the robot takes the first, the second waits QUEUED
eng.handle({ cmd: 'dispatch', task_id: 't1', room: '1204', items: ['towel'] }, data.time);
eng.handle({ cmd: 'dispatch', task_id: 't2', room: '0803', items: ['nasi lemak'] }, data.time);
assert.ok(eng.tasks.t1.eta_seconds > eng.tasks.t2.eta_seconds, 'far-arm room has the longer ETA');

// loading scene: turns to the counter, door opens and STAYS open without the button
tick();
assert.equal(phase('t1'), 'COLLECTING');
assert.equal(phase('t2'), 'QUEUED');
until(() => eng.tasks.t1._load === 'open', 100);
assert.ok(Math.abs(deg(sim.pose().yaw) + 90) <= 5, `presented to the counter at ${deg(sim.pose().yaw)}`);
assert.equal(sim.camera, 'desk_staff');
for (let i = 0; i < 40; i++) tick(); // 8 s, no Bin loaded
assert.equal(phase('t1'), 'COLLECTING');
assert.ok(sim.doorFraction() >= 0.9, 'cargo door open for loading');
until(() => phase('t1') === 'EN_ROUTE', 100, true);
assert.ok(sim.doorFraction() <= 0.05, 'left the desk with the door shut');
assert.equal(sim.camera, 'follow');

let n = until(() => phase('t1') === 'ARRIVED', 800);
console.log(`[measured] t1 (1204) EN_ROUTE->ARRIVED: ${n} ticks (${(n / TICK_HZ).toFixed(0)} s, ETA said ${eng.tasks.t1.eta_seconds.toFixed(0)} s)`);

// hand-over: room door + cargo door open, hold, close, then home
let roomOpen = false, cargoOpen = false;
n = until(() => {
  roomOpen ||= sim.roomDoorFraction('1204') >= 0.98;
  cargoOpen ||= sim.doorFraction() >= 0.9;
  return phase('t1') === 'RETURNING';
}, 200);
assert.ok(roomOpen && cargoOpen, 'room door and cargo door both opened');
assert.ok(sim.roomDoorFraction('1204') <= 0.02 && sim.doorFraction() <= 0.05, 'doors shut after the hand-over');
assert.ok(cams.includes('room_1204'), 'cut to the room camera');
console.log(`[measured] t1 hand-over: ${n} ticks`);
n = until(() => phase('t1') === 'DONE', 1000);
assert.ok(Math.abs(deg(sim.pose().yaw)) <= 5, 'parked facing +x');
console.log(`[measured] t1 RETURNING->DONE: ${n} ticks`);

// the queued order starts by itself; recall it at the door (nobody answered)
until(() => phase('t2') === 'COLLECTING', 3);
until(() => phase('t2') === 'EN_ROUTE', 200, true);
until(() => phase('t2') === 'ARRIVED', 600);
until(() => sim.roomDoorFraction('0803') >= 0.5, 60);
eng.handle({ cmd: 'recall', task_id: 't2', reason: 'guest not answering' }, data.time);
assert.equal(phase('t2'), 'RETURNING');
n = until(() => phase('t2') === 'DONE', 600);
for (let i = 0; i < 10; i++) tick(); // door animation finishes after the robot parks
assert.ok(sim.roomDoorFraction('0803') <= 0.02, '0803 door closed after the recall');
assert.equal(sim.camera, 'follow');
console.log(`[measured] t2 (0803) recall-from-ARRIVED ->DONE: ${n} ticks`);

// recall mid-loading: door shut, heading straightened, AT_DESK
eng.handle({ cmd: 'dispatch', task_id: 't3', room: '0804', items: ['towel'] }, data.time);
until(() => eng.tasks.t3._load === 'open', 100);
eng.handle({ cmd: 'recall', task_id: 't3', reason: 'changed mind' }, data.time);
until(() => phase('t3') === 'AT_DESK', 100);
for (let i = 0; i < 10; i++) tick();
assert.ok(sim.doorFraction() <= 0.05 && sim.camera === 'follow');

// recall mid-route on the far arm
eng.handle({ cmd: 'dispatch', task_id: 't4', room: '1205', items: ['towel'] }, data.time);
until(() => phase('t4') === 'EN_ROUTE', 200, true);
for (let i = 0; i < 60; i++) tick();
assert.equal(phase('t4'), 'EN_ROUTE');
eng.handle({ cmd: 'recall', task_id: 't4', reason: 'wrong room' }, data.time);
assert.equal(phase('t4'), 'RECALLED');
n = until(() => phase('t4') === 'AT_DESK', 600);
console.log(`[measured] t4 (1205) mid-route recall ->AT_DESK: ${n} ticks`);
assert.equal(eng.robot.phase, 'IDLE');

console.log('engine port self-check OK (loading gated on Bin loaded, both arms through the corner, hand-over doors + camera cuts, recall from QUEUED/COLLECTING/EN_ROUTE/ARRIVED, amend quantities)');
