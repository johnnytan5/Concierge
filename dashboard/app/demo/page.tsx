'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import RobotAdmin from '../../components/RobotAdmin';
import SimView, { type EngineState, type SimHandle } from '../../components/SimView';
import WebCallPanel, { ROOMS } from '../../components/WebCallPanel';
import { startCall, type Call, type CallStatus } from '../../lib/voice/call';
import { s } from '../../lib/css';
import { MONO, PRIMARY_BTN } from '../../lib/ui';
import { humanPhase } from '../../lib/format';
import type { DeliveryRow, RobotRow } from '../../lib/types';

/**
 * The hosted demo: the full admin UI on the left, the real MuJoCo robot on
 * the right, and the phone call in this browser. No backend of our own --
 * see docs/WEB-DEMO-PLAN.md. The shared tabs (deliveries, call log,
 * escalations, inventory) read the same Supabase as the local stack; the
 * robot and the live call are this visitor's own.
 */
const CAMERA_LABEL: Record<string, string> = {
  follow: 'Top view · following the robot',
  desk_staff: 'Front desk · loading the bin',
};

export default function DemoPage() {
  const sim = useRef<SimHandle | null>(null);
  const state = useRef<EngineState | null>(null);
  const call = useRef<Call | null>(null);
  const [simReady, setSimReady] = useState(false);
  const [st, setSt] = useState<EngineState | null>(null);
  const [camera, setCamera] = useState('follow');
  const [room, setRoom] = useState(ROOMS[0]);
  const [status, setStatus] = useState<CallStatus | 'idle'>('idle');
  const [note, setNote] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (status !== 'live') return;
    const tick = () => setLeft(Math.max(0, Math.round(((call.current?.endsAt ?? 0) - Date.now()) / 1000)));
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [status]);

  // Leaving the page mid-call: end the session rather than leave it billing.
  useEffect(() => {
    const bye = () => call.current?.hangup();
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, []);

  const onState = (x: EngineState) => { state.current = x; call.current?.onEngineState(x); setSt(x); };

  const task = st?.robot.current_task ? st.tasks[st.robot.current_task] : null;
  // This browser's robot, in the shape of a public.robots row.
  const robots: RobotRow[] = useMemo(() => st ? [{
    id: st.robot.robot_id, phase: st.robot.phase, current_task_id: st.robot.current_task,
    pose_frac: st.robot.pose_frac, battery: st.robot.battery, updated_at: new Date().toISOString(),
  }] : [], [st]);
  const tasks: DeliveryRow[] = useMemo(() => st ? Object.values(st.tasks).map((t) => ({
    task_id: t.task_id, robot_id: st.robot.robot_id, room: t.room, items: t.items, phase: t.phase,
    priority: t.priority, dispatched_at: null, arrived_at: null, created_at: '', updated_at: '',
  })) : [], [st]);

  async function dial() {
    if (!sim.current) return;
    setNote('');
    try {
      call.current = await startCall(room, {
        send: (cmd) => sim.current?.send(cmd),
        snapshot: () => state.current,
        onStatus: (x, detail) => { setStatus(x); if (detail) setNote(detail); },
      });
      setSessionId(call.current.sessionId);
      setLeft(Math.round((call.current.endsAt - Date.now()) / 1000));
    } catch (e) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : String(e);
      setNote(/denied|NotAllowed|Permission/i.test(msg) ? 'Microphone access was blocked. Allow it in the address bar and try again.' : msg);
    }
  }

  // The robot's kiosk, over the camera that shows the moment it is for.
  const kiosk = task?.phase === 'COLLECTING' && task._load === 'open'
    ? 'Bin loaded — send it'
    : task?.phase === 'ARRIVED' && task._arr === 'cargo_open' ? 'Guest collected it' : null;
  const camLabel = CAMERA_LABEL[camera] ?? (camera.startsWith('room_') ? `Room ${camera.slice(5)} · hand-over` : camera);

  return (
    <div className="demo-split">
      <div className="demo-admin">
        <RobotAdmin
          devMode={false}
          navLayout="sidebar"
          fleetViz="steps"
          showProposals
          initialTab="live"
          web={{
            robots,
            tasks,
            sessionId,
            confirm: () => sim.current?.confirm(),
            recall: (_robotId, reason) => { if (task) sim.current?.send({ cmd: 'recall', task_id: task.task_id, reason }); },
            callPanel: (dev) => (
              <WebCallPanel
                dev={dev} room={room} setRoom={setRoom} status={status} secondsLeft={left} note={note}
                ready={simReady} robotBusy={!!task && status === 'ended'} onCall={dial} onHangUp={() => call.current?.hangup()}
              />
            ),
          }}
        />
      </div>
      <div className="demo-sim">
        <SimView
          onReady={(h) => {
            sim.current = h;
            setSimReady(true);
            // dev only: drive the robot from the console / automated checks
            if (process.env.NODE_ENV !== 'production') (window as unknown as { __concierge: SimHandle }).__concierge = h;
          }}
          onState={onState}
          onCamera={setCamera}
          style={{ position: 'absolute', inset: 0, minHeight: 0 }}
        />
        <div style={s('position:absolute;top:12px;left:12px;display:flex;gap:6px;flex-wrap:wrap;pointer-events:none')}>
          <span style={s('padding:5px 9px;background:rgba(32,30,29,.82);color:#f3f2f2;font-family:' + MONO + ';font-size:11px;letter-spacing:.04em')}>
            MuJoCo · live in your browser
          </span>
          <span style={s('padding:5px 9px;background:rgba(32,30,29,.82);color:#f3f2f2;font-family:' + MONO + ';font-size:11px')}>
            {camLabel}
          </span>
          {st && (
            <span style={s('padding:5px 9px;font-family:' + MONO + ';font-size:11px;font-weight:600;' +
              (task ? 'background:var(--color-accent);color:#fff' : 'background:rgba(32,30,29,.82);color:#f3f2f2'))}>
              {task ? `${humanPhase(st.robot.phase)} · ${task.room}` : 'Waiting at the desk'}
            </span>
          )}
        </div>
        {kiosk && (
          <button
            onClick={() => sim.current?.confirm()}
            style={s(PRIMARY_BTN + ';position:absolute;bottom:18px;left:50%;transform:translateX(-50%);' +
              'font-size:15px;padding:12px 22px;background:var(--color-accent);border-color:var(--color-accent);color:#fff')}
          >
            {kiosk}
          </button>
        )}
      </div>
    </div>
  );
}
