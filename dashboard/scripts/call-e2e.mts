/**
 * End-to-end check of the web call without a browser or a person: macOS `say`
 * speaks the guest's lines, streamed as 24 kHz PCM to the real Voice Agent
 * session that /api/call/start sets up. Tool calls are answered by the same
 * lib/voice/tools.ts the browser uses, driving the real MuJoCo engine
 * (lib/sim/*) headless, and the audit trail goes through /api/call/event.
 *
 *   BASE=http://localhost:3000 npm run e2e:call      (or the Vercel URL)
 *
 * Costs one real call (AssemblyAI + OpenRouter). Prints the session id; the
 * rows it wrote are real and show in the Call log.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, TICK_HZ, type Paths } from '../lib/sim/engine.ts';
import { MjSim } from '../lib/sim/mjsim.ts';
import { ToolHandlers, type EngineSnapshot } from '../lib/voice/tools.ts';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const ROOM = process.env.ROOM ?? '1204';
// GUEST_LINES="a|b|c" overrides the guest's script
const LINES = process.env.GUEST_LINES ? process.env.GUEST_LINES.split('|') : [
  'Hi, could I get two towels and a toothbrush sent up please?',
  'Yes, a dental kit is fine. Please send it.',
  'Also, I ordered some food on Uber Eats. Can the robot bring it up when it gets here?',
  'What time is checkout?',
  "That's everything, thank you. Bye!",
];
const root = new URL('..', import.meta.url);

// ---- robot: real engine, stepped in real time ---------------------------------
const { default: loadMujoco } = await import(new URL('public/mujoco/mujoco.js', root).href);
const mj = await loadMujoco();
mj.FS.mkdir('/sim');
for (const f of ['scene_corridor.xml', 'delivery_bot_v2.xml']) {
  mj.FS.writeFile(`/sim/${f}`, readFileSync(new URL(`public/sim/${f}`, root), 'utf8'));
}
const model = mj.MjModel.from_xml_path('/sim/scene_corridor.xml');
const data = new mj.MjData(model);
mj.mj_resetDataKeyframe(model, data, 0);
const sim = new MjSim(mj, model, data);
const paths: Paths = JSON.parse(readFileSync(new URL('public/sim/waypoints.json', root), 'utf8'));
const engine = new Engine(sim, paths);
let loadedAt = 0;
setInterval(() => {
  for (let i = 0; i < Math.round(1 / TICK_HZ / model.opt.timestep); i++) sim.step();
  const t = engine.robot.current_task ? engine.tasks[engine.robot.current_task] : null;
  // staff loads the bin a few seconds after the loading scene opens
  const confirm = !!t && t._load === 'open' && (loadedAt ||= data.time) + 3 < data.time;
  engine.tick(data.time, confirm);
  if (confirm) loadedAt = 0;
}, 1000 / TICK_HZ);
const snapshot = (): EngineSnapshot => ({ time: data.time, robot: { ...engine.robot }, tasks: structuredClone(engine.tasks) });

// ---- the guest's voice ---------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'concierge-e2e-'));
const speech = LINES.map((line, i) => {
  const aiff = join(dir, `${i}.aiff`), raw = join(dir, `${i}.wav`);
  execFileSync('say', ['-v', 'Samantha', '-o', aiff, line]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', aiff, raw]);
  const wav = readFileSync(raw);
  return wav.subarray(wav.indexOf('data') + 8); // PCM after the data chunk header
});

// ---- the call ------------------------------------------------------------------
const t0 = Date.now();
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const res = await fetch(`${BASE}/api/call/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: ROOM }) });
const start = await res.json();
if (!res.ok) throw new Error(`start failed: ${res.status} ${JSON.stringify(start)}`);
console.log(`[${ms()}] session ${start.session_id} (menu ${start.menu.length} items, cap ${start.seconds}s)`);

let outbox: Record<string, unknown>[] = [];
const flush = async () => {
  if (!outbox.length) return;
  const events = outbox; outbox = [];
  const r = await fetch(`${BASE}/api/call/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: start.session_id, events }) });
  if (!r.ok) console.log('  audit write failed', r.status, await r.text());
};
const flushTimer = setInterval(flush, 1000);
const phases: Record<string, string> = {};
const mirror = setInterval(() => {
  for (const t of Object.values(engine.tasks)) {
    if (phases[t.task_id] === t.phase) continue;
    phases[t.task_id] = t.phase;
    outbox.push({ kind: 'delivery', task_id: t.task_id, room: t.room, items: t.items, phase: t.phase, priority: t.priority });
    console.log(`[${ms()}] robot: ${t.task_id} ${t.phase}`);
  }
}, 500);
const handlers = new ToolHandlers(start.menu, paths, (c) => engine.handle(c, data.time), snapshot, (e) => outbox.push(e));

const ws = new WebSocket(`${start.ws_url}?token=${encodeURIComponent(start.token)}`);
const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
let ready = false, replying = false, lastDone = 0, ended = false;
let followups = 0; // tool results whose spoken reply has not finished yet
let lastResultAt = 0, replyStartedAt = 0;
const tools: string[] = [];
// Per reply: seconds of audio received (24 kHz PCM16 = 48000 B/s). A reply
// whose text is long but whose audio is ~0 is one the guest never heard.
let curReply = '';
const audioByReply: Record<string, number> = {};
// Per guest turn: what the assistant said vs how much audio came back. Audio
// can ride under a later reply's id, so the turn is the honest unit.
let turn = 0;
const turnAudio: number[] = [0], turnWords: number[] = [0], turnText: string[] = [''];
ws.onopen = () => send({ type: 'session.update', session: { agent_id: start.agent_id } });
ws.onmessage = (m) => {
  const ev = JSON.parse(String(m.data));
  if (ev.type === 'session.ready') { ready = true; console.log(`[${ms()}] ready`); }
  else if (ev.type === 'reply.started') { replying = true; replyStartedAt = Date.now(); curReply = ev.reply_id; console.log(`[${ms()}]   reply.started ${ev.reply_id}`); }
  else if (ev.type === 'reply.audio') {
    const r = ev.reply_id ?? curReply;
    if (!audioByReply[r]) console.log(`[${ms()}]   first audio ${r}${ev.reply_id ? '' : ' (no reply_id on audio)'}`);
    const secs = Buffer.from(ev.data, 'base64').length / 48000;
    audioByReply[r] = (audioByReply[r] ?? 0) + secs;
    turnAudio[turn] += secs;
  }
  else if (ev.type === 'reply.done') { console.log(`[${ms()}]   reply.done ${ev.reply_id ?? curReply} ${ev.status} audio ${(audioByReply[ev.reply_id ?? curReply] ?? 0).toFixed(2)}s`); replying = false; lastDone = Date.now(); if (followups && replyStartedAt > lastResultAt) followups = 0; }
  else if (ev.type === 'transcript.user' || ev.type === 'transcript.agent') {
    const who = ev.type === 'transcript.user' ? 'guest' : 'agent';
    if (who === 'agent' && ev.text) {
      turnWords[turn] += ev.text.split(/\s+/).length;
      turnText[turn] += ev.text.slice(0, 40) + '… ';
    }
    if (who === 'guest' && ev.text) { turn++; turnAudio[turn] = 0; turnWords[turn] = 0; turnText[turn] = ''; }
    if (ev.text) { console.log(`[${ms()}] ${who}${ev.reply_id ? ` (${ev.reply_id})` : ''}: ${ev.text}`); outbox.push({ kind: 'turn', role: who, text: ev.text }); }
  } else if (ev.type === 'tool.call') {
    const args = typeof ev.arguments === 'string' ? JSON.parse(ev.arguments || '{}') : ev.arguments ?? {};
    const result = handlers.dispatch(ev.name, args);
    tools.push(ev.name);
    console.log(`[${ms()}] tool ${ev.name}(${JSON.stringify(args)})`);
    send({ type: 'tool.result', call_id: ev.call_id, result: JSON.stringify(result) });
    followups++;
    lastResultAt = Date.now();
  } else if (ev.type === 'session.ended' || ev.type.includes('error')) console.log(`[${ms()}] ${ev.type}`, ev.code ?? '');
};
ws.onclose = () => { ended = true; };

// Stream 50 ms frames in real time: speech when it is the guest's turn,
// silence otherwise (turn detection needs the silence to end a turn).
const FRAME = 2400; // bytes = 1200 samples = 50 ms
const silence = Buffer.alloc(FRAME);
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
async function stream(buf: Buffer) {
  for (let i = 0; i < buf.length; i += FRAME) {
    const chunk = buf.subarray(i, i + FRAME);
    send({ type: 'input.audio', audio: (chunk.length === FRAME ? chunk : Buffer.concat([chunk, silence.subarray(chunk.length)])).toString('base64') });
    await sleep(50);
  }
}
const idle = async () => { // wait for the assistant to finish, streaming silence meanwhile
  const until = Date.now() + 30_000; // end_call's result gets no spoken follow-up, so cap the wait
  while (!ended && Date.now() < until && (replying || (followups > 0 && !handlers.endRequested) || Date.now() - lastDone < 2500)) {
    await stream(silence);
  }
};

while (!ready && !ended) await sleep(50);
await stream(Buffer.alloc(FRAME * 10));
await idle(); // the greeting
for (const s of speech) {
  if (ended) break;
  await stream(s);
  await stream(Buffer.alloc(FRAME * 24)); // 1.2 s of quiet: end of turn
  await idle();
}
if (!handlers.endRequested) send({ type: 'session.end' });
await sleep(1500);
ws.close();
outbox.push({ kind: 'end' });

// Let the robot finish the run so the delivery rows reach DONE.
const deadline = Date.now() + (process.env.WAIT_ROBOT === '0' ? 0 : 240_000); // WAIT_ROBOT=0: skip
while (Date.now() < deadline && Object.values(engine.tasks).some((t) => !['DONE', 'AT_DESK'].includes(t.phase))) await sleep(500);
await sleep(1000);
clearInterval(mirror); clearInterval(flushTimer);
await flush();
console.log(`[${ms()}] tools called: ${tools.join(', ') || 'none'}`);
console.log(`[${ms()}] tasks: ${Object.values(engine.tasks).map((t) => `${t.task_id} ${t.room} [${t.items.join(', ')}] ${t.phase}`).join(' | ')}`);
// ~0.37 s of speech per word; under half that means the guest missed most of it
const silent = turnWords.flatMap((w, i) => w >= 6 && turnAudio[i] < w * 0.18
  ? [`turn ${i}: ${turnAudio[i].toFixed(1)}s audio for ${w} words (${turnText[i].trim()})`] : []);
console.log(silent.length ? `CUT-OFF TURNS (${silent.length}):\n  ${silent.join('\n  ')}` : 'every turn fully voiced');
console.log(`audio/word per turn: ${turnWords.map((w, i) => (w ? (turnAudio[i] / w).toFixed(2) : '-')).join(' ')}`);
console.log(`SESSION ${start.session_id}`);
process.exit(0);
