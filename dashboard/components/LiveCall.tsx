'use client';

import React from 'react';
import { s } from '../lib/css';
import { MONO, HATCH, tag } from '../lib/ui';
import {
  pickLiveSession, lastActivityBySession, hhmmss, duration, roomFromCalls,
} from '../lib/format';
import CallFlow, { taskIdFrom } from './CallFlow';
import CallDeliveries from './CallDeliveries';
import type {
  SessionRow, ToolCallRow, TranscriptRow, DeliveryRow, RobotRow,
} from '../lib/types';

/**
 * The front-desk line, as it happens.
 *
 * Deliberately NOT a mock phone UI. There is no telephony here and PLAN.md
 * §9 cut the phone number on purpose — this is a local mic session framed as
 * the front-desk line. A dialpad would advertise a capability that does not
 * exist, which is worse than showing what is really going on.
 *
 * What it is instead: the same CallFlow the Call log renders, at recording
 * scale, following whichever session is currently open, plus the deliveries
 * that call put on the floor. One screen showing speech -> tool call ->
 * robot, which is the whole claim of the project in a single frame.
 *
 * Everything here arrives over Supabase Realtime, so it trails the spoken
 * audio by the write + push round trip. Close enough to feel live, not
 * frame-accurate against the recorded audio.
 */

type Props = {
  sessions: SessionRow[];
  toolCalls: ToolCallRow[];
  transcripts: TranscriptRow[];
  deliveries: DeliveryRow[];
  robots: RobotRow[];
  dev: boolean;
  now: number;
};

function elapsed(fromIso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(fromIso));
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

export default function LiveCall({
  sessions, toolCalls, transcripts, deliveries, robots, dev, now,
}: Props) {
  // Last sign of life per session — pickLiveSession needs it to tell a call
  // in progress from one whose process died before it could close itself.
  const live = pickLiveSession(
    sessions, lastActivityBySession(transcripts, toolCalls), now);
  const newest = sessions.length
    ? sessions.reduce((a, b) => (Date.parse(a.started_at) >= Date.parse(b.started_at) ? a : b))
    : null;
  const shown = live ?? newest;

  if (!shown) {
    return (
      <div style={s('border:2px solid var(--color-divider);padding:48px 28px;display:flex;flex-direction:column;gap:14px;align-items:flex-start')}>
        <span style={s('display:inline-block;padding:4px 9px;border:1px solid var(--color-neutral-500);font-family:' + MONO + ';font-size:12px;color:var(--color-neutral-700)')}>
          {dev ? 'no open session' : 'Line is quiet'}
        </span>
        <div style={s('font-family:var(--font-heading);font-weight:800;font-size:34px;line-height:1.1;letter-spacing:-.02em')}>
          Waiting for a call
        </div>
        <div style={s('font-size:16px;max-width:54ch;color:var(--color-neutral-800)')}>
          {dev
            ? 'public.voice_sessions is empty. Run orchestrator/agent.py and speak into the mic — the session row appears here the moment it connects.'
            : 'Nothing on the line right now. This screen fills in by itself as soon as a guest calls the front desk.'}
        </div>
        {dev && (
          <div style={s('background:var(--color-neutral-200);border:1px solid var(--color-divider);padding:10px 12px;font-family:' + MONO + ';font-size:13px')}>
            .venv/bin/python -m orchestrator.agent
          </div>
        )}
      </div>
    );
  }

  const calls = toolCalls
    .filter((c) => c.session_id === shown.id)
    .slice()
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const turns = transcripts.filter((t) => t.session_id === shown.id);

  // Room the guest is calling from, as last stated to a tool.
  const room = roomFromCalls(calls);

  // What this call actually put on the floor.
  const taskIds = new Set(
    calls.map((c) => taskIdFrom(c)).filter(Boolean) as string[],
  );
  const spawned = deliveries.filter((d) => taskIds.has(d.task_id));
  const escalated = calls.some((c) => c.tool_name === 'escalate_to_frontdesk');

  return (
    <div style={s('display:flex;flex-direction:column;gap:2px')}>
      {/* status header */}
      <div style={s('border:2px solid var(--color-divider);padding:20px 22px;display:flex;align-items:center;gap:20px;flex-wrap:wrap')}>
        <span style={s('display:flex;align-items:center;gap:10px')}>
          <span style={s('width:13px;height:13px;display:block;background:' +
            (live ? 'var(--color-accent);animation:livePulse 1.4s ease-in-out infinite' : 'var(--color-neutral-500)'))} />
          <span style={s('font-family:var(--font-heading);font-weight:800;font-size:15px;letter-spacing:.06em;text-transform:uppercase')}>
            {live ? (dev ? 'session open' : 'On the line') : (dev ? 'session closed' : 'Last call')}
          </span>
        </span>

        {room && (
          <span style={s('display:flex;align-items:baseline;gap:9px')}>
            <span style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)')}>
              {dev ? 'room' : 'Calling from'}
            </span>
            <span style={s('font-family:var(--font-heading);font-weight:800;font-size:38px;line-height:1;letter-spacing:-.02em')}>{room}</span>
          </span>
        )}

        {escalated && <span className="tag" style={s(tag('alert'))}>{dev ? 'escalated' : 'Escalated'}</span>}

        <span style={s('margin-left:auto;display:flex;gap:22px;align-items:baseline;flex-wrap:wrap;font-family:' + MONO + ';font-size:13px;color:var(--color-neutral-700)')}>
          <span>
            {live
              ? elapsed(shown.started_at, now)
              : (shown.ended_at ? duration(shown.started_at, shown.ended_at) : '—')}
          </span>
          <span>{turns.length} {dev ? 'turns' : 'said'}</span>
          <span>{calls.length} {dev ? 'tool calls' : 'actions'}</span>
          <span>{dev ? shown.id : hhmmss(shown.started_at)}</span>
        </span>
      </div>

      {/* what the call put on the floor — the payoff of the whole chain */}
      {spawned.length > 0 && (
        <CallDeliveries deliveries={spawned} robots={robots} dev={dev} />
      )}

      {/* the call itself, at recording scale */}
      <CallFlow session={shown} calls={calls} turns={turns} dev={dev} variant="stage" />

      {!live && newest && (
        <div style={s('display:flex;align-items:center;gap:12px;padding:12px 22px;border:2px solid var(--color-divider);border-top:0;background-image:' + HATCH + ';background-size:100% 5px;background-repeat:no-repeat;background-position:top left')}>
          <span style={s('font-size:13px;color:var(--color-neutral-800)')}>
            {dev
              ? 'No session is open. Showing the most recent one; a new call replaces it here automatically.'
              : 'Nobody is on the line. This is the last call that came in — a new one takes over this screen by itself.'}
          </span>
        </div>
      )}
    </div>
  );
}
