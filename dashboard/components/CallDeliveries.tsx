'use client';

import React from 'react';
import { s } from '../lib/css';
import { MONO } from '../lib/ui';
import { humanPhase, formatItems, phaseStep, PHASE_STEPS } from '../lib/format';
import type { DeliveryRow, RobotRow } from '../lib/types';

/**
 * What a call actually put on the floor.
 *
 * Shared by the Live call tab and the Call log's modal so the two cannot
 * drift: it is the same question in both places ("this call said words —
 * what physically happened?"), and it was written twice before this.
 */
export default function CallDeliveries({ deliveries, robots, dev, bare }: {
  deliveries: DeliveryRow[];
  robots: RobotRow[];
  dev: boolean;
  /** true inside the modal, where the surrounding panel draws the border. */
  bare?: boolean;
}) {
  if (deliveries.length === 0) {
    return (
      <div style={s('padding:18px 22px;font-size:13px;color:var(--color-neutral-700)')}>
        {dev
          ? 'no deliveries reference a task_id from this call'
          : 'This call didn’t send anything out.'}
      </div>
    );
  }

  return (
    <div style={s(bare ? '' : 'border:2px solid var(--color-divider);border-top:0')}>
      {!bare && (
        <div style={s('padding:12px 22px;border-bottom:1px solid var(--color-divider);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--color-neutral-600)')}>
          {dev ? 'deliveries created by this call' : 'What went out because of this call'}
        </div>
      )}
      {deliveries.map((d) => {
        const step = phaseStep(d.phase);
        const robot = robots.find((r) => r.id === d.robot_id);
        const pct = Math.round(Number(robot?.pose_frac ?? 0) * 100);
        return (
          <div key={d.task_id} style={s('padding:16px 22px;display:flex;gap:20px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--color-divider)')}>
            <span style={s('font-family:var(--font-heading);font-weight:800;font-size:26px;line-height:1;letter-spacing:-.02em;min-width:70px')}>{d.room}</span>
            <span style={s('font-size:15px;flex:1;min-width:180px')}>{formatItems(d.items)}</span>
            <span style={s('display:flex;gap:2px;flex:none')}>
              {PHASE_STEPS.map((label, n) => (
                <span key={label} style={s('width:26px;height:9px;display:block;border:1px solid var(--color-divider);background:' +
                  (step === n ? 'var(--color-accent)' : step > n ? 'var(--color-neutral-400)' : 'var(--color-surface)') +
                  (step === n ? ';animation:livePulse 1.2s ease-in-out infinite' : ''))} />
              ))}
            </span>
            <span style={s('font-family:' + MONO + ';font-size:13px;min-width:120px')}>
              {dev ? d.phase : humanPhase(d.phase)}
            </span>
            <span style={s('font-family:' + MONO + ';font-size:12px;color:var(--color-neutral-700);min-width:110px')}>
              {d.robot_id
                ? (dev ? d.robot_id : d.robot_id.replace(/^robot_/, 'Robot ')) + (step >= 0 ? ' · ' + pct + '%' : '')
                : (dev ? 'unassigned' : 'Waiting for a robot')}
            </span>
          </div>
        );
      })}
    </div>
  );
}
