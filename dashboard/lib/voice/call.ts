/**
 * A phone call to the front desk, from the browser: a port of
 * orchestrator/agent.py's _run_session (event loop, hold-mode tool results,
 * the announced-but-never-called nudge, end_call, barge-in).
 *
 * Runs on the main thread next to the page; the robot's physics stays in
 * the sim worker (physics never shares the voice thread) and tools only post commands to it.
 * Secrets stay on the server: /api/call/start hands back a one-time token
 * whose session AssemblyAI ends at `seconds` (the 3-minute cap), and every
 * audit write goes through /api/call/event.
 */
import config from './agent-config.json';
import { ToolHandlers, needsNudge, nudgeInstruction, type EngineSnapshot } from './tools';
import type { MenuItem } from './menu';
import { clientId, fingerprint } from './visitor';
import type { Cmd, Paths } from '../sim/engine';

const TERMINAL = ['DONE', 'AT_DESK'];

export type CallStatus = 'connecting' | 'live' | 'ended' | 'error';

export type CallHooks = {
  send: (cmd: Cmd) => void;                 // to the sim worker
  snapshot: () => EngineSnapshot | null;    // latest engine state
  onStatus: (s: CallStatus, detail?: string) => void;
  onTurn?: (role: 'guest' | 'agent', text: string) => void;
  onTool?: (name: string, summary: string) => void;
};

export type Call = {
  sessionId: string;
  endsAt: number;          // epoch ms
  hangup: () => void;
  onEngineState: (s: EngineSnapshot) => void;  // feed every worker state message
};

function b64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unb64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function startCall(room: string, hooks: CallHooks): Promise<Call> {
  hooks.onStatus('connecting');

  // Mic first: a denied permission should fail before we spend an agent.
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  let res: Response;
  try {
    const body = { room, client_id: clientId(), fingerprint: await fingerprint() };
    res = await fetch('/api/call/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    mic.getTracks().forEach((t) => t.stop());
    throw e;
  }
  const start = await res.json().catch(() => ({}));
  if (!res.ok) {
    mic.getTracks().forEach((t) => t.stop());
    throw new Error(start.error ?? `call could not start (${res.status})`);
  }
  const { session_id: sessionId, agent_id: agentId, token, ws_url: wsUrl, menu, seconds } =
    start as { session_id: string; agent_id: string; token: string; ws_url: string; menu: MenuItem[]; seconds: number };
  const paths: Paths = await (await fetch('/sim/waypoints.json')).json();

  // ---- audit trail, batched ------------------------------------------------
  let outbox: Record<string, unknown>[] = [];
  const record = (e: Record<string, unknown>) => { outbox.push(e); };
  const flush = (keepalive = false) => {
    if (!outbox.length) return;
    const events = outbox; outbox = [];
    fetch('/api/call/event', {
      method: 'POST', keepalive, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, events }),
    }).catch(() => { /* best effort, like the Python fire-and-forget writes */ });
  };
  const flushTimer = setInterval(flush, 1000);

  // Delivery rows follow the engine, the job task_engine's mirror_delivery does.
  // Engine times are sim seconds; convert against the latest snapshot.
  const phases: Record<string, string> = {};
  let mirroring = true;
  let ready = false;   // session.ready seen: start streaming the mic
  let closed = false;  // the call is over (the robot may still be finishing)
  const onEngineState = (s: EngineSnapshot) => {
    if (!mirroring) return;
    const epoch = (t: number | null) => (t === null ? null : Date.now() - (s.time - t) * 1000);
    for (const t of Object.values(s.tasks)) {
      if (!t.task_id.startsWith('w') || phases[t.task_id] === t.phase) continue;
      phases[t.task_id] = t.phase;
      record({ kind: 'delivery', task_id: t.task_id, room: t.room, items: t.items, phase: t.phase,
        priority: t.priority, dispatched_at: epoch(t.dispatched_at), arrived_at: epoch(t.arrived_at) });
    }
    // After hang-up, keep mirroring until the robot has finished its runs.
    if (closed && Object.keys(phases).every((id) => TERMINAL.includes(phases[id]))) stopMirroring();
  };
  const stopMirroring = () => { mirroring = false; clearInterval(flushTimer); flush(true); };

  const handlers = new ToolHandlers(menu, paths, hooks.send, hooks.snapshot, (e) => {
    record(e);
    if (e.kind === 'tool') hooks.onTool?.(String(e.name), String(e.summary));
  });

  // ---- audio ----------------------------------------------------------------
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/voice/pcm-worklet.js');
  const micNode = new AudioWorkletNode(ctx, 'mic');
  const player = new AudioWorkletNode(ctx, 'player', { outputChannelCount: [ctx.destination.channelCount >= 2 ? 2 : 1] });
  ctx.createMediaStreamSource(mic).connect(micNode);
  player.connect(ctx.destination);
  await ctx.resume();
  let drainedResolve: (() => void) | null = null;
  player.port.onmessage = (e) => { if (e.data?.drained) drainedResolve?.(); };
  const drained = (limitMs: number) => new Promise<void>((r) => { drainedResolve = r; setTimeout(r, limitMs); });

  // ---- the session ------------------------------------------------------------
  const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
  const sendWs = (m: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  micNode.port.onmessage = (e) => { if (ready) sendWs({ type: 'input.audio', audio: b64(e.data) }); };

  // AssemblyAI enforces the cap via the token; this timer is the backstop.
  const endsAt = Date.now() + seconds * 1000;
  const capTimer = setTimeout(() => cleanup('ended', 'The 3-minute demo call ended.'), seconds * 1000 + 3000);

  const cleanup = (status: CallStatus, detail?: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(capTimer);
    record({ kind: 'end' });
    mic.getTracks().forEach((t) => t.stop());
    micNode.disconnect();
    setTimeout(() => ctx.close().catch(() => {}), 300);
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'session.end' })); } catch { /* closing anyway */ }
      ws.close();
    }
    flush(true);
    const s = hooks.snapshot();
    const busy = s && Object.values(s.tasks).some((t) => t.task_id.startsWith('w') && !TERMINAL.includes(t.phase));
    if (!busy) stopMirroring();
    hooks.onStatus(status, detail);
  };

  let currentReply: string | null = null;
  const replyTexts: Record<string, string[]> = {};
  const repliesWithTool = new Set<string>();
  let guestSpeaking = false;
  let nudges = 0;
  let lastGuest = '';
  let parcelBooked = false;
  let ending = false;
  let forceClose: ReturnType<typeof setTimeout> | null = null;

  ws.onopen = () => sendWs({ type: 'session.update', session: { agent_id: agentId } });
  ws.onerror = () => cleanup('error', 'The call connection failed.');
  ws.onclose = () => { if (forceClose) clearTimeout(forceClose); cleanup('ended'); };

  ws.onmessage = async (msg) => {
    const ev = JSON.parse(msg.data);
    const rid: string = ev.reply_id ?? currentReply;
    switch (ev.type) {
      case 'session.ready':
        ready = true;
        hooks.onStatus('live');
        break;
      case 'error': case 'session.error':
        console.warn('[call] session error', ev);
        if (!ready) cleanup('error', 'The assistant could not join the call.');
        break;
      case 'session.ended':
        cleanup('ended', 'The 3-minute demo call ended.');
        break;
      case 'reply.audio':
        player.port.postMessage(unb64(ev.data));
        break;
      case 'reply.started':
        currentReply = ev.reply_id;
        break;
      case 'transcript.agent.delta':
        (replyTexts[rid] ??= []).push(ev.delta ?? '');
        break;
      case 'input.speech.started': guestSpeaking = true; break;
      case 'input.speech.stopped': guestSpeaking = false; break;
      case 'tool.call': {
        repliesWithTool.add(rid);
        if (ev.name === 'deliver_parcel') parcelBooked = true;
        const args = typeof ev.arguments === 'string' ? JSON.parse(ev.arguments || '{}') : (ev.arguments ?? {});
        const result = handlers.dispatch(ev.name, args);
        if (ev.name === 'end_call' && !ending) {
          ending = true;
          forceClose = setTimeout(() => cleanup('ended'), 12000); // no goodbye ever came
        }
        // hold mode: the result goes straight back and fires the spoken reply;
        // `result` is a JSON-encoded string (agent.py, verified live)
        sendWs({ type: 'tool.result', call_id: ev.call_id, result: JSON.stringify(result) });
        break;
      }
      case 'reply.done': {
        const said = (replyTexts[rid] ?? []).join('');
        delete replyTexts[rid];
        if (ending && (!repliesWithTool.has(rid) || said.trim())) {
          await drained(15000); // let the goodbye finish playing
          cleanup('ended');
          break;
        }
        if (ev.status === 'interrupted') {
          player.port.postMessage({ clear: true }); // barge-in: stop talking now
        } else if (!repliesWithTool.has(rid) && nudges < config.max_nudges && !guestSpeaking && needsNudge(said)) {
          nudges++;
          sendWs({ type: 'reply.create', instructions: nudgeInstruction(lastGuest, parcelBooked) });
        }
        break;
      }
      case 'transcript.user': case 'transcript.agent': {
        const role = ev.type === 'transcript.user' ? 'guest' : 'agent';
        const text: string = ev.text ?? '';
        if (role === 'guest') { nudges = 0; lastGuest = text; }
        if (text) { record({ kind: 'turn', role, text }); hooks.onTurn?.(role, text); }
        break;
      }
    }
  };

  return { sessionId, endsAt, hangup: () => cleanup('ended'), onEngineState };
}
