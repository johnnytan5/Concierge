'use client';

import React from 'react';
import { s } from '../lib/css';
import { MONO, HATCH, PRIMARY_BTN, tag } from '../lib/ui';
import type { CallStatus } from '../lib/voice/call';

/**
 * The front-desk line on the hosted demo: the call happens in this browser
 * (lib/voice/call.ts), so this is the handset, unlike CallControl, which
 * launches the Python agent on the machine running admin_api. Same look.
 */
export const ROOMS = ['1204', '0803', '0804', '1205'];

type Props = {
  dev: boolean;
  room: string;
  setRoom: (r: string) => void;
  status: CallStatus | 'idle';
  secondsLeft: number;
  note: string;
  ready: boolean;            // the sim has loaded
  robotBusy: boolean;        // still finishing a delivery after the call
  onCall: () => void;
  onHangUp: () => void;
};

export default function WebCallPanel({ dev, room, setRoom, status, secondsLeft, note, ready, robotBusy, onCall, onHangUp }: Props) {
  const live = status === 'live';
  const connecting = status === 'connecting';
  const mmss = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;

  return (
    <div style={s('border:2px solid var(--color-divider);background-color:var(--color-surface)' +
      (live ? ';background-image:' + HATCH + ';background-size:100% 4px;background-repeat:no-repeat;background-position:top left' : ''))}>
      <div style={s('padding:16px 20px;display:flex;align-items:center;gap:18px;flex-wrap:wrap')}>
        <span style={s('font-family:var(--font-heading);font-weight:800;font-size:13px;letter-spacing:.1em;text-transform:uppercase')}>
          {dev ? 'browser voice session' : 'Front desk line'}
        </span>

        {!live && (
          <>
            <label style={s('display:flex;align-items:center;gap:9px')}>
              <span style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)')}>
                {dev ? 'room' : 'Calling from'}
              </span>
              <select
                className="input"
                value={room}
                disabled={connecting}
                onChange={(e) => setRoom(e.target.value)}
                style={s('width:110px;font-family:' + MONO + ';font-size:17px;font-weight:700;text-align:center')}
              >
                {ROOMS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <button onClick={onCall} disabled={!ready || connecting} style={s(PRIMARY_BTN)}>
              {connecting ? 'Connecting…' : !ready ? 'Loading the robot…' : 'Call the front desk'}
            </button>
            <span style={s('font-size:12px;color:var(--color-neutral-700);max-width:46ch')}>
              {dev ? 'mic → AssemblyAI Voice Agent (token from /api/call/start), tools run in this tab'
                : 'Uses your microphone. Ask for towels, an Uber Eats pickup, or late checkout. Up to 3 calls (9 minutes) a day; calls end after 3 minutes. Your IP address is logged to enforce this.'}
            </span>
          </>
        )}

        {live && (
          <>
            <span style={s('display:flex;align-items:center;gap:10px')}>
              <span style={s('width:11px;height:11px;display:block;background:var(--color-accent);animation:livePulse 1.4s ease-in-out infinite')} />
              <span style={s('font-family:var(--font-heading);font-weight:800;font-size:14px;letter-spacing:.05em;text-transform:uppercase')}>
                {dev ? 'session live' : 'Line open — speak now'}
              </span>
            </span>
            <span style={s('display:flex;align-items:baseline;gap:8px')}>
              <span style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)')}>room</span>
              <span style={s('font-family:var(--font-heading);font-weight:800;font-size:30px;line-height:1;letter-spacing:-.02em')}>{room}</span>
            </span>
            <span style={s('font-family:' + MONO + ';font-size:13px;color:var(--color-neutral-700)')}>{mmss} left</span>
            <button onClick={onHangUp} className="btn btn-secondary">Hang up</button>
          </>
        )}

        {!live && robotBusy && (
          <span style={s('margin-left:auto')} className="tag">
            {dev ? 'engine running · task not terminal' : 'Robot finishing delivery'}
          </span>
        )}
      </div>

      {note && !live && (
        <div style={s('padding:11px 20px;border-top:1px solid var(--color-divider);display:flex;gap:12px;align-items:center;flex-wrap:wrap')}>
          <span className="tag" style={s(tag(status === 'error' ? 'alert' : 'ghost'))}>
            {status === 'error' ? (dev ? 'start failed' : 'Couldn’t open the line') : (dev ? 'session ended' : 'Call ended')}
          </span>
          <span style={s('font-size:13px')}>{note}</span>
        </div>
      )}
    </div>
  );
}
