'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { s } from '../lib/css';
import { MONO, HATCH, PRIMARY_BTN, tag } from '../lib/ui';
import * as api from '../lib/adminApi';

/**
 * The switchboard.
 *
 * Answering a call launches orchestrator/agent.py on whatever machine runs
 * admin_api, which opens THAT machine's microphone and holds the AssemblyAI
 * WebSocket. So this panel is the switchboard, not the handset — you type the
 * room the way reception sees it on the display when the phone rings, press
 * Answer, and then speak into the laptop.
 *
 * The room is sent at launch rather than left for the guest to say, because a
 * hotel PBX already knows which extension is ringing. The agent is told up
 * front and will not ask.
 */

type Props = {
  dev: boolean;
};

const POLL_MS = 3000;

export default function CallControl({ dev }: Props) {
  const [room, setRoom] = useState('1204');
  const [status, setStatus] = useState<api.CallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const st = await api.getCallStatus();
      if (mounted.current) setStatus(st);
    } catch {
      // A dead admin_api is reported by the action buttons; polling should
      // not paint an error banner on its own every 3 seconds.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Whether an agent process is alive cannot come from the database — it is
    // local to the machine running admin_api — so this polls. That is the
    // rule's own blessed shape ("subscribe for updates from some external
    // system"); only the immediate first poll trips it, and waiting a full
    // interval before showing the real state would be worse.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => { mounted.current = false; clearInterval(id); };
  }, [refresh]);

  const run = async (fn: () => Promise<api.CallStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const live = status?.running === true;
  const roomOk = /^[A-Za-z0-9-]{1,10}$/.test(room.trim());

  return (
    <div style={s('border:2px solid var(--color-divider);background-color:var(--color-surface)' +
      (live ? ';background-image:' + HATCH + ';background-size:100% 4px;background-repeat:no-repeat;background-position:top left' : ''))}>
      <div style={s('padding:16px 20px;display:flex;align-items:center;gap:18px;flex-wrap:wrap')}>
        <span style={s('font-family:var(--font-heading);font-weight:800;font-size:13px;letter-spacing:.1em;text-transform:uppercase')}>
          {dev ? 'orchestrator/agent.py' : 'Front desk line'}
        </span>

        {!live && (
          <>
            <label style={s('display:flex;align-items:center;gap:9px')}>
              <span style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)')}>
                {dev ? '--room' : 'Calling from'}
              </span>
              <input
                className="input"
                value={room}
                onChange={(e) => setRoom(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && roomOk && !busy) void run(() => api.startCall(room.trim())); }}
                style={s('width:110px;font-family:' + MONO + ';font-size:17px;font-weight:700;text-align:center')}
              />
            </label>
            <button
              onClick={() => void run(() => api.startCall(room.trim() || null))}
              disabled={busy || !roomOk}
              style={s(PRIMARY_BTN)}
            >
              {busy ? 'Connecting…' : 'Answer call'}
            </button>
            {dev && (
              <span style={s('font-size:12px;color:var(--color-neutral-700);max-width:44ch')}>
                Launches the agent with --room; it opens the mic on the machine running admin_api.
              </span>
            )}
          </>
        )}

        {live && (
          <>
            <span style={s('display:flex;align-items:center;gap:10px')}>
              <span style={s('width:11px;height:11px;display:block;background:var(--color-accent);animation:livePulse 1.4s ease-in-out infinite')} />
              <span style={s('font-family:var(--font-heading);font-weight:800;font-size:14px;letter-spacing:.05em;text-transform:uppercase')}>
                {dev ? 'agent running' : 'Line open — speak now'}
              </span>
            </span>
            {status?.room && (
              <span style={s('display:flex;align-items:baseline;gap:8px')}>
                <span style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)')}>room</span>
                <span style={s('font-family:var(--font-heading);font-weight:800;font-size:30px;line-height:1;letter-spacing:-.02em')}>{status.room}</span>
              </span>
            )}
            <button
              onClick={() => void run(() => api.stopCall())}
              disabled={busy}
              className="btn btn-secondary"
            >
              {busy ? 'Hanging up…' : 'Hang up'}
            </button>
            {dev && status?.pid && (
              <span style={s('font-family:' + MONO + ';font-size:11px;color:var(--color-neutral-700)')}>pid {status.pid}</span>
            )}
          </>
        )}

        {status?.finishing && (
          <span style={s('margin-left:auto')} className="tag">
            {dev ? 'guest hung up · engine alive until robot is idle' : 'Call ended · robot finishing delivery'}
          </span>
        )}

        {status && !status.running && status.exit_code !== undefined && status.exit_code !== null && (
          <span style={s('margin-left:auto;display:flex;align-items:center;gap:8px')}>
            <span className="tag" style={s(tag('ghost'))}>
              {dev ? `last call exited ${status.exit_code}` : 'Last call ended'}
            </span>
            <button className="btn btn-secondary" onClick={() => setShowLog(!showLog)}>
              {showLog ? 'Hide log' : 'Log'}
            </button>
          </span>
        )}
      </div>

      {error && (
        <div style={s('padding:11px 20px;border-top:1px solid var(--color-divider);display:flex;gap:12px;align-items:center;flex-wrap:wrap')}>
          <span className="tag" style={s(tag('alert'))}>{dev ? 'start failed' : 'Couldn’t open the line'}</span>
          <span style={s('font-size:13px')}>{error}</span>
        </div>
      )}

      {showLog && status?.log?.length ? (
        <pre style={s('margin:0;padding:12px 20px;border-top:1px solid var(--color-divider);font-family:' + MONO +
          ';font-size:11.5px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;color:var(--color-neutral-800)')}>
          {status.log.join('\n')}
        </pre>
      ) : null}
    </div>
  );
}
