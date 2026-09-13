'use client';

import React from 'react';
import { s } from '../lib/css';
import { MONO, ALERT_CHIP } from '../lib/ui';
import {
  hhmmss, replyLatencyMs, latencyLabel, median, roomFromCalls, guestLabel, argPairsFor,
} from '../lib/format';
import { TOOL_HUMAN, TOOL_GROUP, ARG_HUMAN } from '../lib/vocab';
import type { ToolCallRow, TranscriptRow, SessionRow } from '../lib/types';

/**
 * One call, replayed.
 *
 * This is the old live FlowDiagram's topology (SOURCE -> TOOL CALL ->
 * OUTCOME) inverted from "what is flashing right now" to "what did this call
 * actually touch". The live version lit a node for 1.5s off a realtime event
 * and kept no history, which made it undemonstrable after the fact — exactly
 * the wrong shape for an audit trail.
 *
 * Two panels, deliberately separated rather than run together: the flow is a
 * summary you read at a glance, the conversation is a record you read line by
 * line. They answer different questions and were hard to tell apart when
 * stacked without a boundary.
 *
 * Two sizes, one component:
 *   'compact' — the Call log's modal, sized for reading.
 *   'stage'   — the Live call tab, sized to stay legible in a 1080p screen
 *               recording. Same data, same structure, bigger type.
 */

type Variant = 'compact' | 'stage';

type Props = {
  session: SessionRow;
  calls: ToolCallRow[];
  turns: TranscriptRow[];
  dev: boolean;
  variant?: Variant;
  /** Hide the flow panel — for surfaces that show it separately. */
  hideFlow?: boolean;
};

type Entry =
  | { kind: 'turn'; at: number; turn: TranscriptRow }
  | { kind: 'call'; at: number; call: ToolCallRow };

/**
 * The task a tool call created, if any.
 *
 * Reads the structured `result` column. Rows written before that column
 * existed only have result_summary, which back then was Python's `str(dict)`
 * of the handler return — hence the regex fallback. Deliberately tolerant: a
 * miss means no cross-reference, never a broken row.
 */
function taskIdFrom(call: Pick<ToolCallRow, 'result' | 'result_summary'>): string | null {
  const direct = call.result?.task_id;
  if (typeof direct === 'string' && direct) return direct;

  const m = call.result_summary?.match(/['"]task_id['"]\s*:\s*['"]([A-Za-z0-9_]+)['"]/);
  return m ? m[1] : null;
}

const argPairs = (args: Record<string, unknown> | null, dev: boolean) =>
  argPairsFor(args, dev, ARG_HUMAN);

/**
 * What the tool call produced.
 *
 * Staff see the sentence `tools.py` wrote. Dev sees the structured return,
 * pretty-printed — and falls back to result_summary for rows written before
 * the `result` column existed, which for those rows is the old Python repr.
 */
function ResultCell({ call, dev, z }: { call: ToolCallRow; dev: boolean; z: Z }) {
  if (dev) {
    const body = call.result !== null && call.result !== undefined
      ? JSON.stringify(call.result, null, 2)
      : (call.result_summary ?? '—');
    return (
      <pre style={s('flex:1;min-width:180px;margin:0;font-size:' + z.argText + ';font-family:' + MONO +
        ';color:var(--color-neutral-800);white-space:pre-wrap;word-break:break-word;max-height:210px;overflow:auto')}>
        {body}
      </pre>
    );
  }
  return (
    <div style={s('flex:1;min-width:180px;font-size:' + z.resultText + ';color:var(--color-neutral-800)')}>
      {call.result_summary ?? '—'}
    </div>
  );
}

/** Every size that differs between the two variants, in one place. */
function sizes(v: Variant) {
  const stage = v === 'stage';
  return {
    stage,
    gutter: stage ? 96 : 72,
    roleCol: stage ? 132 : 104,
    turnText: stage ? '20px' : '14.5px',
    metaText: stage ? '13px' : '11px',
    toolText: stage ? '16px' : '13px',
    argText: stage ? '14px' : '12px',
    resultText: stage ? '14px' : '12.5px',
    rowPad: stage ? '14px 18px' : '11px 14px',
    nodePad: stage ? '11px 14px' : '8px 11px',
    nodeText: stage ? '13px' : '11px',
    label: stage ? '11px' : '10px',
    panelPad: stage ? '20px' : '16px',
  };
}

type Z = ReturnType<typeof sizes>;

/** A titled block. The thing that makes flow and conversation read as two
 *  separate ideas rather than one long column. */
function Panel({ title, aside, children, z }: {
  title: string; aside?: React.ReactNode; children: React.ReactNode; z: Z;
}) {
  return (
    <section style={s('border:2px solid var(--color-divider);background:var(--color-bg)')}>
      <div style={s('display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;border-bottom:2px solid var(--color-divider);background:var(--color-surface)')}>
        <span style={s('font-family:var(--font-heading);font-weight:800;font-size:' + (z.stage ? '13px' : '12px') + ';letter-spacing:.1em;text-transform:uppercase')}>
          {title}
        </span>
        {aside && <span style={s('margin-left:auto;font-family:' + MONO + ';font-size:' + z.metaText + ';color:var(--color-neutral-700)')}>{aside}</span>}
      </div>
      <div style={s('padding:' + z.panelPad)}>{children}</div>
    </section>
  );
}

function Node({ label, lit, count, alert, z }: {
  label: string; lit: boolean; count?: number; alert?: boolean; z: Z;
}) {
  const base =
    'padding:' + z.nodePad + ';border:1px solid var(--color-divider);font-family:' + MONO +
    ';font-size:' + z.nodeText + ';display:flex;align-items:center;gap:8px;white-space:nowrap;';
  const style = !lit
    ? base + 'background:var(--color-surface);color:var(--color-neutral-600)'
    : alert
      ? base + 'background:var(--color-text);color:var(--color-bg);font-weight:700'
      : base + 'background:var(--color-neutral-200);color:var(--color-text);font-weight:600';
  return (
    <div style={s(style)}>
      <span>{label}</span>
      {count !== undefined && count > 0 && (
        <span style={s('margin-left:auto;opacity:.7')}>{'×' + count}</span>
      )}
    </div>
  );
}

function Column({ label, children, z }: { label: string; children: React.ReactNode; z: Z }) {
  return (
    <div style={s('display:flex;flex-direction:column;gap:6px;min-width:170px;flex:1')}>
      <div style={s('font-size:' + z.label + ';letter-spacing:.12em;text-transform:uppercase;color:var(--color-neutral-600);border-bottom:1px solid var(--color-divider);padding-bottom:5px')}>
        {label}
      </div>
      {children}
    </div>
  );
}

/** Latency against the preceding guest turn — RQ3's measure, per row. */
function LatencyBadge({ ms, z }: { ms: number | null; z: Z }) {
  const label = latencyLabel(ms);
  if (!label) return null;
  // Slow enough to feel broken gets the ink treatment; red stays reserved
  // for live motion.
  const slow = ms !== null && ms >= 2500;
  return (
    <span style={s('font-family:' + MONO + ';font-size:' + (z.stage ? '12px' : '10px') +
      ';padding:1px 5px;white-space:nowrap;' +
      (slow
        ? 'background:var(--color-text);color:var(--color-bg);font-weight:700'
        : 'color:var(--color-neutral-600);border:1px solid var(--color-divider)'))}>
      {label}
    </span>
  );
}

export default function CallFlow({
  session, calls, turns, dev, variant = 'compact', hideFlow,
}: Props) {
  const z = sizes(variant);
  const room = roomFromCalls(calls);
  const guest = guestLabel(room, dev);

  const entries: Entry[] = [
    ...turns.map((t): Entry => ({ kind: 'turn', at: Date.parse(t.created_at), turn: t })),
    ...calls.map((c): Entry => ({ kind: 'call', at: Date.parse(c.created_at), call: c })),
  ].sort((a, b) => a.at - b.at);

  const guestTimes = turns
    .filter((t) => t.role === 'guest')
    .map((t) => Date.parse(t.created_at));

  const groupCounts = new Map<string, number>();
  for (const c of calls) {
    const g = TOOL_GROUP[c.tool_name] ?? 'other';
    groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
  }

  const taskIds = Array.from(
    new Set(calls.map((c) => taskIdFrom(c)).filter(Boolean) as string[]),
  );
  const escalated = (groupCounts.get('escalate') ?? 0) > 0;

  // Call-level latency summary: how fast the agent answered, across turns.
  const replyLatencies = entries
    .filter((e) => (e.kind === 'call') || (e.kind === 'turn' && e.turn.role === 'agent'))
    .map((e) => replyLatencyMs(e.at, guestTimes))
    .filter((n): n is number => n !== null);
  const medianReply = median(replyLatencies);

  return (
    <div style={s('display:flex;flex-direction:column;gap:14px')}>
      {!hideFlow && (
        <Panel z={z} title={dev ? 'flow' : 'What happened'}
          aside={dev ? `${calls.length} tool calls · ${turns.length} turns` : undefined}>
          <div style={s('display:flex;gap:6px;align-items:stretch;flex-wrap:wrap')}>
            <Column label={dev ? 'source' : 'Who'} z={z}>
              <Node z={z} label={guest} lit={turns.some((t) => t.role === 'guest')} />
              <Node z={z} label={dev ? 'voice_agent' : 'Assistant'} lit={turns.some((t) => t.role === 'agent')} />
            </Column>
            <div aria-hidden="true" style={s('display:flex;align-items:center;padding:0 4px;font-family:' + MONO + ';color:var(--color-neutral-500);font-size:12px')}>&gt;&gt;</div>
            <Column label={dev ? 'tool_call' : 'What it did'} z={z}>
              <Node z={z} label={dev ? 'check_menu' : 'Menu lookup'}
                lit={(groupCounts.get('menu') ?? 0) > 0} count={groupCounts.get('menu')} />
              <Node z={z} label={dev ? 'dispatch / amend / recall' : 'Order handling'}
                lit={(groupCounts.get('dispatch') ?? 0) > 0} count={groupCounts.get('dispatch')} />
              <Node z={z} label={dev ? 'escalate_to_frontdesk' : 'Escalated to desk'}
                lit={escalated} count={groupCounts.get('escalate')} alert />
            </Column>
            <div aria-hidden="true" style={s('display:flex;align-items:center;padding:0 4px;font-family:' + MONO + ';color:var(--color-neutral-500);font-size:12px')}>&gt;&gt;</div>
            <Column label={dev ? 'outcome' : 'Result'} z={z}>
              {taskIds.length > 0 ? (
                taskIds.map((t) => (
                  <Node key={t} z={z} label={dev ? t : 'Order ' + t.toUpperCase()} lit />
                ))
              ) : (
                <Node z={z} label={dev ? 'no task created' : 'No order placed'} lit={false} />
              )}
            </Column>
          </div>
        </Panel>
      )}

      <Panel
        z={z}
        title={dev ? 'conversation' : 'How the call went'}
        aside={medianReply !== null
          ? (dev
            ? 'median reply ' + (medianReply / 1000).toFixed(1) + 's (n=' + replyLatencies.length + ')'
            : 'Typically answered in ' + (medianReply / 1000).toFixed(1) + 's')
          : undefined}
      >
        {entries.length === 0 ? (
          <div style={s('font-size:13px;color:var(--color-neutral-700)')}>
            {dev
              ? 'no transcript_turns or tool_call_events rows carry this session_id'
              : 'Nothing was recorded for this call.'}
          </div>
        ) : (
          <div style={s('display:flex;flex-direction:column;gap:1px;background:var(--color-divider);border:1px solid var(--color-divider)')}>
            {entries.map((e) => {
              const lat = replyLatencyMs(e.at, guestTimes);

              if (e.kind === 'turn') {
                const isGuest = e.turn.role === 'guest';
                return (
                  <div key={'t' + e.turn.id} style={s('background:var(--color-bg);display:flex;gap:14px;padding:' + z.rowPad + ';align-items:baseline')}>
                    <span style={s('width:' + z.gutter + 'px;flex:none;font-family:' + MONO + ';font-size:' + z.metaText + ';color:var(--color-neutral-600)')}>
                      {hhmmss(e.turn.created_at)}
                    </span>
                    <span style={s('width:' + z.roleCol + 'px;flex:none;font-size:' + (z.stage ? '12px' : '10.5px') + ';letter-spacing:.07em;text-transform:uppercase;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + (isGuest ? 'var(--color-text)' : 'var(--color-neutral-600)'))}>
                      {isGuest ? guest : (dev ? 'agent' : 'Assistant')}
                    </span>
                    <span style={s('flex:1;min-width:180px;font-size:' + z.turnText + (isGuest ? ';font-weight:600' : ''))}>
                      {e.turn.text}
                    </span>
                    {!isGuest && <LatencyBadge ms={lat} z={z} />}
                  </div>
                );
              }

              const c = e.call;
              const isEscalation = c.tool_name === 'escalate_to_frontdesk';
              return (
                <div key={'c' + c.id} style={s('background:var(--color-bg);display:flex;gap:14px;padding:' + z.rowPad + ';align-items:flex-start')}>
                  <span style={s('width:' + z.gutter + 'px;flex:none;font-family:' + MONO + ';font-size:' + z.metaText + ';color:var(--color-neutral-600);padding-top:2px')}>
                    {hhmmss(c.created_at)}
                  </span>
                  <span style={s('width:' + z.roleCol + 'px;flex:none')}>
                    <span style={s(isEscalation
                      ? ALERT_CHIP
                      : 'display:inline-block;padding:2px 6px;border:1px solid var(--color-text);font-family:' + MONO + ';font-size:' + (z.stage ? '12px' : '10px') + ';font-weight:600')}>
                      {dev ? 'tool' : 'Action'}
                    </span>
                  </span>
                  <div style={s('flex:1;min-width:180px;display:flex;flex-direction:column;gap:4px')}>
                    <div style={s('display:flex;align-items:center;gap:8px;flex-wrap:wrap')}>
                      <span style={s('font-family:' + MONO + ';font-size:' + z.toolText + ';font-weight:700')}>
                        {dev ? c.tool_name : (TOOL_HUMAN[c.tool_name] ?? c.tool_name)}
                      </span>
                      <LatencyBadge ms={lat} z={z} />
                    </div>
                    {argPairs(c.arguments, dev).map((a, n) => (
                      <div key={n} style={s('display:flex;gap:8px;font-size:' + z.argText + ';font-family:' + MONO)}>
                        <span style={s('color:var(--color-neutral-600);min-width:64px')}>{a.k}</span>
                        <span>{a.v}</span>
                      </div>
                    ))}
                  </div>
                  <ResultCell call={c} dev={dev} z={z} />
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {dev && (
        <div style={s('font-family:' + MONO + ';font-size:11px;color:var(--color-neutral-700)')}>
          session_id {session.id}
          {session.agent_id ? ' · agent ' + session.agent_id : ''}
          {' · '}
          {session.ended_at ? 'closed ' + hhmmss(session.ended_at) : 'still open'}
        </div>
      )}
    </div>
  );
}

export { taskIdFrom };
