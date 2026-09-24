/// <reference lib="webworker" />
/**
 * The robot's physics, in the browser: the official MuJoCo WASM build running
 * our own sim/scene_corridor.xml (copied to public/sim by
 * scripts/sync-sim-assets.mjs). A Web Worker on purpose -- the same rule as
 * the Python stack (CLAUDE.md constraint 1): physics never runs on the thread
 * that holds the voice connection.
 *
 * Protocol
 *   in : { type: 'drive', v, omega }   m/s, rad/s -- calibrated like concierge_sim.drive()
 *        { type: 'door', open }
 *   out: { type: 'static', ... }       once: what to draw for every geom
 *        { type: 'frame', xpos, xmat, robot }   ~30 Hz
 *        { type: 'error', message }
 */

// Mirrors sim/concierge_sim.py -- keep in step if the model's actuators change.
const CTRL_PER_MPS = 50.0;
const CTRL_PER_RADPS = 12.0;
const DOOR_TOP_RANGE_M = 0.16;
const DOOR_BOTTOM_RANGE_M = 0.04;
const FRAME_HZ = 30;

type Mj = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let mj: Mj, model: Mj, data: Mj;
const act: Record<string, number> = {};
let lastWall = 0;
let lastFrame = 0;

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
  model = mj.MjModel.from_xml_path('/sim/scene_corridor.xml');
  data = new mj.MjData(model);
  mj.mj_resetDataKeyframe(model, data, 0);
  mj.mj_forward(model, data);

  const ACT = mj.mjtObj.mjOBJ_ACTUATOR.value;
  for (const n of ['forward', 'turn', 'lid_top_pos', 'lid_bottom_pos']) act[n] = mj.mj_name2id(model, ACT, n);

  const ngeom: number = model.ngeom;
  const rgba = new Float32Array(ngeom * 4);
  const matid: Int32Array = model.geom_matid, geomRgba: Float32Array = model.geom_rgba, matRgba: Float32Array = model.mat_rgba;
  for (let i = 0; i < ngeom; i++) {
    const src = matid[i] >= 0 ? matRgba.subarray(matid[i] * 4, matid[i] * 4 + 4) : geomRgba.subarray(i * 4, i * 4 + 4);
    rgba.set(src, i * 4);
  }
  (self as DedicatedWorkerGlobalScope).postMessage({
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
  setInterval(tick, 1000 / 120);
}

function tick() {
  // Step to wall-clock time (capped, so a backgrounded tab doesn't try to
  // catch up minutes of physics at once).
  const now = performance.now();
  const dt = model.opt.timestep;
  let n = Math.min(Math.floor((now - lastWall) / 1000 / dt), 200);
  if (n > 0) lastWall += n * dt * 1000;
  while (n-- > 0) mj.mj_step(model, data);

  if (now - lastFrame >= 1000 / FRAME_HZ) {
    lastFrame = now;
    const q: Float64Array = data.qpos;
    const [w, x, y, z] = [q[3], q[4], q[5], q[6]];
    const xpos = Float64Array.from(data.geom_xpos);
    const xmat = Float64Array.from(data.geom_xmat);
    (self as DedicatedWorkerGlobalScope).postMessage(
      { type: 'frame', xpos, xmat,
        robot: { x: q[0], y: q[1], yawDeg: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180 / Math.PI } },
      [xpos.buffer, xmat.buffer]);
  }
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (!data) return;
  const c: Float64Array = data.ctrl;
  if (msg.type === 'drive') {
    c[act.forward] = msg.v * CTRL_PER_MPS;
    c[act.turn] = msg.omega * CTRL_PER_RADPS;
  } else if (msg.type === 'door') {
    c[act.lid_top_pos] = msg.open ? DOOR_TOP_RANGE_M : 0;
    c[act.lid_bottom_pos] = msg.open ? DOOR_BOTTOM_RANGE_M : 0;
  }
};

init().catch((err) => (self as DedicatedWorkerGlobalScope).postMessage({ type: 'error', message: String(err?.message ?? err) }));
