'use client';

import React, { useEffect, useRef, useState } from 'react';
import SimView, { type EngineState, type SimHandle } from '../../components/SimView';
import { startCall, type Call, type CallStatus } from '../../lib/voice/call';

/**
 * Web demo: call the front desk from the browser and watch the real MuJoCo
 * robot deliver. The split-screen dashboard layout lands on Day 4
 * (docs/WEB-DEMO-PLAN.md); this is the working call + sim.
 */
const ROOMS = ['1204', '0803', '0804', '1205'];

export default function DemoPage() {
  const sim = useRef<SimHandle | null>(null);
  const state = useRef<EngineState | null>(null);
  const call = useRef<Call | null>(null);
  const [ready, setReady] = useState(false);
  const [st, setSt] = useState<EngineState | null>(null);
  const [room, setRoom] = useState(ROOMS[0]);
  const [status, setStatus] = useState<CallStatus | 'idle'>('idle');
  const [note, setNote] = useState('');
  const [log, setLog] = useState<{ who: string; text: string }[]>([]);
  const [left, setLeft] = useState(0);

  const current = st?.robot.current_task ? st.tasks[st.robot.current_task] : null;
  const inCall = status === 'connecting' || status === 'live';

  useEffect(() => {
    if (status !== 'live') return;
    const id = setInterval(() => setLeft(Math.max(0, Math.round(((call.current?.endsAt ?? 0) - Date.now()) / 1000))), 500);
    return () => clearInterval(id);
  }, [status]);

  const onState = (s: EngineState) => { state.current = s; call.current?.onEngineState(s); setSt(s); };

  async function dial() {
    if (!sim.current) return;
    setLog([]); setNote('');
    try {
      call.current = await startCall(room, {
        send: (cmd) => sim.current?.send(cmd),
        snapshot: () => state.current,
        onStatus: (s, detail) => { setStatus(s); if (detail) setNote(detail); },
        onTurn: (role, text) => setLog((l) => [...l, { who: role === 'guest' ? 'You' : 'Front desk', text }]),
        onTool: (_name, summary) => setLog((l) => [...l, { who: '→', text: summary }]),
      });
    } catch (e) {
      setStatus('error');
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  const btn = { padding: '10px 14px', border: '1px solid #444', background: '#2d2a29', color: '#f3f2f2', cursor: 'pointer', fontFamily: 'ui-monospace, Menlo, monospace' } as const;
  const mono = { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#201e1d', color: '#f3f2f2' }}>
      <div style={{ display: 'flex', gap: 8, padding: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ marginRight: 12 }}>Concierge</b>
        <select value={room} disabled={inCall} onChange={(e) => setRoom(e.target.value)} style={btn} aria-label="Room">
          {ROOMS.map((r) => <option key={r} value={r}>Room {r}</option>)}
        </select>
        {inCall
          ? <button style={{ ...btn, background: '#7a2d2d' }} onClick={() => call.current?.hangup()}>Hang up{status === 'live' ? ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '…'}</button>
          : <button style={{ ...btn, background: '#2d5a3a' }} disabled={!ready} onClick={dial}>Call the front desk</button>}
        <button style={btn} disabled={!ready} onClick={() => sim.current?.confirm()}>Bin loaded</button>
        <span style={{ ...mono, marginLeft: 'auto', color: '#b8b4b3' }}>
          {st ? `${st.robot.phase}${current ? ` · ${current.room} · ${current.items.join(', ')}` : ''}` : '…'}
        </span>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ width: 340, overflowY: 'auto', padding: 12, borderRight: '1px solid #333', ...mono }}>
          <div style={{ color: '#b8b4b3', marginBottom: 8 }}>{status === 'connecting' ? 'Connecting…' : status === 'live' ? 'On the line — speak normally.' : note || 'Pick a room and call.'}</div>
          {log.map((l, i) => (
            <div key={i} style={{ marginBottom: 8, color: l.who === '→' ? '#8fb3a0' : undefined }}>
              <b>{l.who}</b> {l.text}
            </div>
          ))}
        </div>
        <div style={{ flex: 1 }}>
          <SimView onReady={(h) => { sim.current = h; setReady(true); }} onState={onState} />
        </div>
      </div>
    </div>
  );
}
