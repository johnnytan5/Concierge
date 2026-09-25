/// <reference lib="webworker" />
/**
 * The robot, in the browser: the official MuJoCo WASM build running our own
 * sim/scene_corridor.xml (copied to public/sim by scripts/sync-sim-assets.mjs)
 * plus the task engine (engine.ts, a port of task_engine/engine.py). A Web
 * Worker on purpose -- CLAUDE.md constraint 1: physics never runs on the
 * thread that holds the voice connection.
 *
 * Protocol
 *   in : { type: 'cmd', cmd: Cmd }     dispatch / amend / recall / announce (engine.ts)
 *        { type: 'confirm' }           the kiosk button: Bin loaded / collected
 *   out: { type: 'static', ... }       once: what to draw for every geom
 *        { type: 'frame', xpos, xmat, robot, camera }   ~30 Hz
 *        { type: 'state', time, robot, tasks }           every engine tick (5 Hz)
 *        { type: 'cmdError', message }   a command the engine rejected
 *        { type: 'error', message }      failed to start
 */
import { Engine, TICK_HZ, type Paths } from './engine';
import { MjSim } from './mjsim';

const FRAME_HZ = 30;

type Mj = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let mj: Mj, model: Mj, data: Mj, sim: MjSim, engine: Engine;
let lastWall = 0, lastFrame = 0, nextTick = 0;
// The kiosk button, held until the phase it was pressed in is over: a press
// while the robot is still turning to the counter must not be lost (the
// Python engine reads it once per tick from Supabase, same effect).
let confirmedPhase: string | null = null;
const post = (msg: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

async function init() {
  // A runtime URL, not a bundled import: the WASM build is a static asset.
  const url = '/mujoco/mujoco.js';
  const { default: loadMujoco } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
  mj = await loadMujoco();
  mj.FS.mkdir('/sim');
  for (const f of ['scene_corridor.xml', 'delivery_bot_v2.xml']) {
    const res = await fetch(`/sim/${f}`);
    if (!res.ok) throw new Error(`could not load /sim/${f} (${res.status})`);
    mj.FS.writeFile(`/sim/${f}`, await res.text());
  }
  const paths: Paths = await (await fetch('/sim/waypoints.json')).json();
  model = mj.MjModel.from_xml_path('/sim/scene_corridor.xml');
  data = new mj.MjData(model);
  mj.mj_resetDataKeyframe(model, data, 0);
  mj.mj_forward(model, data);
  sim = new MjSim(mj, model, data);
  engine = new Engine(sim, paths);

  const ngeom: number = model.ngeom;
  const rgba = new Float32Array(ngeom * 4);
  const matid: Int32Array = model.geom_matid, geomRgba: Float32Array = model.geom_rgba, matRgba: Float32Array = model.mat_rgba;
  for (let i = 0; i < ngeom; i++) {
    const src = matid[i] >= 0 ? matRgba.subarray(matid[i] * 4, matid[i] * 4 + 4) : geomRgba.subarray(i * 4, i * 4 + 4);
    rgba.set(src, i * 4);
  }
  post({
    type: 'static',
    ngeom,
    geomType: Int32Array.from(model.geom_type),
    geomSize: Float64Array.from(model.geom_size),
    geomGroup: Int32Array.from(model.geom_group),
    geomBody: Int32Array.from(model.geom_bodyid),
    rgba,
    robotBody: mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'robot'),
  });

  lastWall = performance.now();
  setInterval(loop, 1000 / 120);
}

function cameraPose() {
  // "follow" is drawn by the view itself; named cameras come from the model
  // (targetbodycom cameras re-aim every step, so read data, not model).
  if (sim.camera === 'follow') return { name: 'follow' };
  const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_CAMERA.value, sim.camera);
  if (id < 0) return { name: 'follow' };
  return {
    name: sim.camera,
    pos: Array.from(data.cam_xpos.subarray(id * 3, id * 3 + 3)),
    mat: Array.from(data.cam_xmat.subarray(id * 9, id * 9 + 9)),
    fovy: model.cam_fovy[id],
  };
}

function loop() {
  // Step to wall-clock time (capped, so a backgrounded tab doesn't try to
  // catch up minutes of physics at once). The engine ticks on sim time.
  const now = performance.now();
  const dt = model.opt.timestep;
  let n = Math.min(Math.floor((now - lastWall) / 1000 / dt), 200);
  if (n > 0) lastWall += n * dt * 1000;
  while (n-- > 0) {
    sim.step();
    if (data.time >= nextTick) {
      nextTick = data.time + 1 / TICK_HZ;
      const phaseNow = () => (engine.robot.current_task ? engine.tasks[engine.robot.current_task].phase : null);
      engine.tick(data.time, confirmedPhase !== null && confirmedPhase === phaseNow());
      if (confirmedPhase !== phaseNow()) confirmedPhase = null;
      post({ type: 'state', time: data.time, robot: { ...engine.robot }, tasks: structuredClone(engine.tasks) });
    }
  }

  if (now - lastFrame >= 1000 / FRAME_HZ) {
    lastFrame = now;
    const p = sim.pose();
    const xpos = Float64Array.from(data.geom_xpos);
    const xmat = Float64Array.from(data.geom_xmat);
    post({ type: 'frame', xpos, xmat, robot: { x: p.x, y: p.y, yawDeg: p.yaw * 180 / Math.PI }, camera: cameraPose() },
      [xpos.buffer, xmat.buffer]);
  }
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (!engine) return;
  if (msg.type === 'cmd') {
    try { engine.handle(msg.cmd, data.time); } catch (err) { post({ type: 'cmdError', message: String(err) }); }
  } else if (msg.type === 'confirm') {
    const t = engine.robot.current_task ? engine.tasks[engine.robot.current_task] : null;
    if (t && (t.phase === 'COLLECTING' || t.phase === 'ARRIVED')) confirmedPhase = t.phase;
  }
};

init().catch((err) => post({ type: 'error', message: String(err?.message ?? err) }));
