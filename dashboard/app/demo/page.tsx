'use client';

import React, { useRef, useState } from 'react';
import SimView, { type SimHandle } from '../../components/SimView';

/**
 * Web demo, day 1 prototype: the real MuJoCo scene running in the browser.
 * The drive buttons are a bench test for the physics port; the robot engine
 * and the voice call replace them (docs/WEB-DEMO-PLAN.md).
 */
export default function DemoPage() {
  const sim = useRef<SimHandle | null>(null);
  const [pose, setPose] = useState({ x: 0, y: 0, yawDeg: 0 });
  const [ready, setReady] = useState(false);
  const btn = { padding: '10px 14px', border: '1px solid #444', background: '#2d2a29', color: '#f3f2f2', cursor: 'pointer', fontFamily: 'ui-monospace, Menlo, monospace' } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#201e1d', color: '#f3f2f2' }}>
      <div style={{ display: 'flex', gap: 8, padding: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ marginRight: 12 }}>MuJoCo in the browser</b>
        <button style={btn} disabled={!ready} onClick={() => sim.current?.drive(0.3, 0)}>Forward</button>
        <button style={btn} disabled={!ready} onClick={() => sim.current?.drive(0, 1.0)}>Turn</button>
        <button style={btn} disabled={!ready} onClick={() => sim.current?.drive(0, 0)}>Stop</button>
        <button style={btn} disabled={!ready} onClick={() => sim.current?.door(true)}>Open bin</button>
        <button style={btn} disabled={!ready} onClick={() => sim.current?.door(false)}>Close bin</button>
        <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, color: '#b8b4b3' }}>
          x {pose.x.toFixed(3)} · y {pose.y.toFixed(3)} · yaw {pose.yawDeg.toFixed(1)}°
        </span>
      </div>
      <div style={{ flex: 1 }}>
        <SimView onReady={(h) => { sim.current = h; setReady(true); }} onRobot={setPose} />
      </div>
    </div>
  );
}
