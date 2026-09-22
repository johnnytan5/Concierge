'use client';

import React, { useEffect } from 'react';
import { s } from '../lib/css';
import { MONO, tag } from '../lib/ui';
import { hhmmss, duration, roomForCall } from '../lib/format';
import CallFlow, { taskIdFrom } from './CallFlow';
import CallDeliveries from './CallDeliveries';
import type {
  SessionRow, ToolCallRow, TranscriptRow, DeliveryRow, RobotRow,
} from '../lib/types';

/**
 * One call, opened from the Call log.
 *
 * A modal rather than an inline expansion: a call carries a flow summary, a
 * full transcript and whatever it put on the floor, and unfolding all of that
 * inside a table row pushed the rest of the list off screen and left the
 * reader with no boundary between the call and the list around it.
 *
 * Three stacked panels, each answering one question — what happened, what
 * went out, what was said — instead of one continuous column.
 */

type Props = {
  session: SessionRow;
  calls: ToolCallRow[];
  turns: TranscriptRow[];
  deliveries: DeliveryRow[];
  robots: RobotRow[];
  dev: boolean;
  onClose: () => void;
};

export default function CallModal({
  session, calls, turns, deliveries, robots, dev, onClose,
}: Props) {
  // Escape closes. Registered on document because focus could be anywhere in
  // the dialog, and a scroll container is not focusable by default.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const room = roomForCall(session, calls);
  const escalated = calls.some((c) => c.tool_name === 'escalate_to_frontdesk');
  const orphan = session.id === '__ungrouped__';

  const taskIds = new Set(
    calls.map((c) => taskIdFrom(c)).filter(Boolean) as string[],
  );
  const spawned = deliveries.filter((d) => taskIds.has(d.task_id));

  return (
    <div
      className="dialog-backdrop"
      // Backdrop click closes; clicks inside the panel must not bubble out to
      // here, or selecting transcript text would dismiss the call.
      onClick={onClose}
    >
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        style={s('width:min(1080px,100%);max-height:88vh;padding:0;gap:0;overflow:hidden;background:var(--color-bg)')}
      >
        {/* header */}
        <div style={s('flex:none;display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:16px 20px;border-bottom:2px solid var(--color-divider);background:var(--color-surface)')}>
          <span style={s('font-family:var(--font-heading);font-weight:800;font-size:16px;letter-spacing:.02em;text-transform:uppercase')}>
            {orphan
              ? (dev ? 'session_id null' : 'Older calls')
              : (dev ? session.id : 'Call ' + session.id.replace(/^sess_/, '').toUpperCase())}
          </span>

          {room && (
            <span style={s('display:flex;align-items:baseline;gap:8px')}>
              <span style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)')}>
                {dev ? 'room' : 'Guest in'}
              </span>
              <span style={s('font-family:var(--font-heading);font-weight:800;font-size:28px;line-height:1;letter-spacing:-.02em')}>{room}</span>
            </span>
          )}

          {escalated && <span className="tag" style={s(tag('alert'))}>{dev ? 'escalated' : 'Escalated'}</span>}

          <span style={s('margin-left:auto;display:flex;gap:18px;align-items:center;flex-wrap:wrap;font-family:' + MONO + ';font-size:12px;color:var(--color-neutral-700)')}>
            <span>{hhmmss(session.started_at)}</span>
            {session.ended_at && <span>{duration(session.started_at, session.ended_at)}</span>}
            <span>{turns.length} {dev ? 'turns' : 'said'}</span>
            <span>{calls.length} {dev ? 'tool calls' : 'actions'}</span>
            <button className="btn btn-secondary" onClick={onClose}>Close</button>
          </span>
        </div>

        {/* body — the only thing that scrolls */}
        <div style={s('flex:1;min-height:0;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:14px')}>
          <CallFlow session={session} calls={calls} turns={turns} dev={dev} variant="compact" />

          {spawned.length > 0 && (
            <section style={s('border:2px solid var(--color-divider);background:var(--color-bg)')}>
              <div style={s('padding:10px 14px;border-bottom:2px solid var(--color-divider);background:var(--color-surface);font-family:var(--font-heading);font-weight:800;font-size:12px;letter-spacing:.1em;text-transform:uppercase')}>
                {dev ? 'deliveries created' : 'What went out'}
              </div>
              <CallDeliveries deliveries={spawned} robots={robots} dev={dev} bare />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
