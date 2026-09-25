'use client';

import React, { useRef, useState } from 'react';
import SimView, { type EngineState, type SimHandle } from '../../components/SimView';

/**
 * Web demo bench: the real MuJoCo scene and the ported task engine, running
 * in the browser. The buttons stand in for the voice agent's tool calls until
 * the call lands here (Day 3, docs/WEB-DEMO-PLAN.md).
 */
const ROOMS = ['0803', '0804', '1204', '1205'];

export default function DemoPage() {
  const sim = useRef<SimHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [st, setSt] = useState<EngineState | null>(null);
  const btn = { padding: '10px 14px', border: '1px solid #444', background: '#2d2a29', color: '#f3f2f2', cursor: 'pointer', fontFamily: 'ui-monospace, Menlo, monospace' } as const;
  const current = st?.robot.current_task ? st.tasks[st.robot.current_task] : null;
  const queued = st ? Object.values(st.tasks).filter((t) => t.phase === 'QUEUED').length : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#201e1d', color: '#f3f2f2' }}>
      <div style={{ display: 'flex', gap: 8, padding: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ marginRight: 12 }}>Concierge robot</b>
        {ROOMS.map((room) => (
          <button key={room} style={btn} disabled={!ready} onClick={() =>
            sim.current?.send({ cmd: 'dispatch', task_id: crypto.randomUUID(), room, items: ['towel'] })}>
            Send to {room}
          </button>
        ))}
        <button style={btn} disabled={!ready} onClick={() => sim.current?.confirm()}>Bin loaded</button>
        <button style={btn} disabled={!current} onClick={() =>
          current && sim.current?.send({ cmd: 'recall', task_id: current.task_id, reason: 'bench' })}>Recall</button>
        <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, color: '#b8b4b3' }}>
          {st ? `${st.robot.phase}${current ? ` · ${current.room}` : ''} · ${(st.robot.pose_frac * 100).toFixed(0)}%${queued ? ` · ${queued} queued` : ''}` : '…'}
        </span>
      </div>
      <div style={{ flex: 1 }}>
        <SimView onReady={(h) => { sim.current = h; setReady(true); }} onState={setSt} />
      </div>
    </div>
  );
}
