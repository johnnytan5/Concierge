'use client';

import React, { useMemo, useState } from 'react';
import { s } from '../lib/css';
import {
  MONO, HATCH, ALERT_CHIP, PRIMARY_BTN, EDIT_BTN, DELETE_BTN,
  tabStyle, chip, tag,
} from '../lib/ui';
import {
  PHASE_STEPS, STEP_HUMAN, phaseStep, humanPhase, TERMINAL_HUMAN, isTerminal,
  formatItems, hhmmss, duration, ago, formatPrice, medianDeskToDoor,
  pickLiveSession, lastActivityBySession, roomForCall,
} from '../lib/format';
import { TOOL_HUMAN, CATS, TAGS } from '../lib/vocab';
import { useAdminData } from '../lib/useAdminData';
import * as api from '../lib/adminApi';
import CallModal from './CallModal';
import CallControl from './CallControl';
import LiveCall from './LiveCall';
import type { ToolCallRow, TranscriptRow, SessionRow } from '../lib/types';

export type RobotAdminProps = {
  /** Dev view exposes table names, ids and endpoints. Staff view hides them. */
  devMode?: boolean;
  navLayout?: 'sidebar' | 'topbar';
  fleetViz?: 'steps' | 'strip' | 'bar';
  /** Shows the inventory stock ledger (inventory_audit_log). */
  showProposals?: boolean;
  /** Tab to open on. Set to 'live' when recording the demo, so the first
   *  frame is the call rather than the fleet. */
  initialTab?: Tab;
};

type Tab = 'live' | 'fleet' | 'deliveries' | 'calls' | 'escalations' | 'inventory';
type Dialog = null | 'recall' | 'item' | 'delete';

/**
 * Working copy behind whichever dialog is open. One shape with optional
 * fields rather than a discriminated union: the three dialogs share `id`,
 * and the form binds text inputs, so price/stock are held as strings and
 * only parsed on save.
 */
type Draft = {
  id?: string;
  name?: string;
  category?: string;
  price?: string;
  tags?: string[];
  stock?: string;
  avail?: boolean;
  reason?: string;
};

const SUPABASE_HOST = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/^https?:\/\//, '');

export default function RobotAdmin(props: RobotAdminProps) {
  const {
    navLayout = 'sidebar', fleetViz = 'steps', showProposals = true, initialTab = 'fleet',
  } = props;

  const d = useAdminData();

  const [tab, setTab] = useState<Tab>(initialTab);
  const [delFilter, setDelFilter] = useState('All');
  const [callFilter, setCallFilter] = useState('All');
  const [openCall, setOpenCall] = useState<string | null>(null);
  const [escFilter, setEscFilter] = useState('Open');
  const [invCat, setInvCat] = useState<string>('All');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [devOverride, setDevOverride] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const dev = devOverride !== undefined ? devOverride : props.devMode === true;
  const ready = d.dataState === 'ready';
  const side = navLayout === 'sidebar';

  const closeDialog = () => { setDialog(null); setDraft(null); };
  const oid = (id: string | null) =>
    !id ? '—' : dev ? id : 'Order ' + String(id).replace(/^tsk_/, '').toUpperCase();

  /**
   * Every write funnels through here. admin_api has no auth any more (see its
   * module docstring); this just carries the busy/error/refresh plumbing that
   * every action needs.
   */
  const guarded = (fn: () => Promise<unknown>) => () => { void run(fn); };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      closeDialog();
      d.refetchAll(); // realtime covers this, but don't make the operator wait on it
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Alias kept for the robot's own kiosk confirmations, which read better
   *  named for what they are rather than sharing `run`'s name. */
  const runOpen = run;

  // ---------------------------------------------------------------- fleet
  const robotVMs = d.robots.map((r) => {
    const task = d.deliveries.find((x) => x.task_id === r.current_task_id) ?? null;
    const step = phaseStep(r.phase);
    const moving = step >= 0;
    const frac = Math.max(0, Math.min(1, Number(r.pose_frac ?? 0)));
    const pct = Math.round(frac * 100);
    const battery = Number(r.battery ?? 0);
    const updated = ago(r.updated_at, d.now);

    return {
      key: r.id,
      id: dev ? r.id : r.id.replace(/^robot_/, 'Robot '),
      phase: dev ? r.phase : humanPhase(r.phase),
      phaseWord: dev ? r.phase.replace(/_/g, ' ') : humanPhase(r.phase),
      legCaption: dev ? 'pose_frac — fraction of the whole trip' : 'Progress',
      stepCaption: dev ? 'phase' : 'Stage',
      roomCaption: dev ? 'room' : 'Delivering to',
      batteryLabel: (dev ? 'bat ' : 'Battery ') + Math.round(battery) + '%',
      metaLine: dev
        ? 'dispatched ' + hhmmss(task?.dispatched_at ?? null) + ' · updated ' + updated
        : 'Sent ' + hhmmss(task?.dispatched_at ?? null) + ' · updated ' + updated,
      noTaskLine: dev
        ? 'current_task_id = null · updated ' + updated
        : 'Waiting at the desk · updated ' + updated,
      // live motion is the ONE thing that reads red
      phaseTagStyle: moving
        ? 'display:inline-block;padding:3px 7px;background:var(--color-accent);color:#fff;font-family:' + MONO + ';font-size:11px;font-weight:600'
        : 'display:inline-block;padding:3px 7px;border:1px solid var(--color-neutral-500);color:var(--color-neutral-800);font-family:' + MONO + ';font-size:11px;font-weight:600',
      // low battery is an alert, so it hatches rather than turning red
      batteryBar: 'display:block;height:100%;width:' + Math.round(battery) + '%;background:' +
        (battery < 25 ? HATCH : 'var(--color-text)'),
      showSteps: fleetViz === 'steps',
      showStrip: fleetViz === 'strip',
      showLeg: fleetViz !== 'strip',
      steps: PHASE_STEPS.map((label, n) => {
        const done = moving && n < step;
        const now = moving && n === step;
        let bg = 'var(--color-surface)';
        let fg = 'var(--color-neutral-600)';
        if (done) { bg = 'var(--color-neutral-300)'; fg = 'var(--color-neutral-800)'; }
        if (now) {
          bg = 'linear-gradient(to right,var(--color-accent) ' + pct + '%,var(--color-accent-200) ' + pct + '%)';
          fg = pct > 55 ? '#fff' : 'var(--color-accent-900)';
        }
        return {
          key: label,
          label: dev ? label.replace(/_/g, ' ') : STEP_HUMAN[label],
          box: 'flex:1;min-width:0;padding:8px 6px;font-family:' + MONO + ';font-size:9.5px;letter-spacing:.06em;' +
            'text-transform:uppercase;border:1px solid var(--color-divider);white-space:nowrap;overflow:hidden;' +
            'text-overflow:ellipsis;background:' + bg + ';color:' + fg,
        };
      }),
      cells: PHASE_STEPS.map((label, n) => {
        const done = moving && n < step;
        const now = moving && n === step;
        return {
          key: label,
          sq: 'width:16px;height:16px;display:block;border:1px solid var(--color-divider);background:' +
            (now ? 'var(--color-accent)' : done ? 'var(--color-neutral-400)' : 'var(--color-surface)') +
            (now ? ';animation:livePulse 1.2s ease-in-out infinite' : ''),
        };
      }),
      legLabel: moving ? pct + '%' : '—',
      legBar: 'display:block;height:100%;width:' + (moving ? pct : 0) + '%;background:var(--color-accent)',
      hasTask: !!task,
      room: task?.room ?? null,
      priority: task?.priority ?? null,
      taskId: oid(r.current_task_id),
      itemsText: formatItems(task?.items),
      recallDisabled: !moving || busy,
      onRecall: () => { setActionError(null); setDialog('recall'); setDraft({ id: r.id, reason: '' }); },
      // The robot's own kiosk confirmation, surfaced here because there is no
      // separate robot screen. COLLECTING is a hard gate: the FSM will not
      // leave the desk until a human says the bin is loaded, and ARRIVED will
      // not release the robot until the guest says they took it.
      kioskAction: r.phase === 'COLLECTING'
        ? { label: dev ? 'complete_loading' : 'Bin loaded — send it', fn: () => api.completeLoading(r.id) }
        : r.phase === 'ARRIVED'
          ? { label: dev ? 'complete_collection' : 'Guest collected it', fn: () => api.completeCollection(r.id) }
          : null,
    };
  });

  const movingCount = d.robots.filter((r) => phaseStep(r.phase) >= 0).length;
  const inFlight = d.deliveries.filter((x) => !isTerminal(x.phase) && x.phase !== 'QUEUED');
  const queued = d.deliveries.filter((x) => x.phase === 'QUEUED');
  const openEsc = d.escalations.filter((e) => e.status === 'open');

  const statDefs: Array<{ label: string; value: string; alert?: boolean }> = [
    { label: dev ? 'robots moving' : 'Robots moving', value: movingCount + ' / ' + (d.robots.length || 0) },
    { label: dev ? 'in flight' : 'In flight', value: String(inFlight.length) },
    { label: dev ? 'queued' : 'Queued', value: String(queued.length) },
    { label: dev ? 'open escalations' : 'Needs attention', value: String(openEsc.length), alert: openEsc.length > 0 },
    { label: dev ? 'median desk→door' : 'Median delivery', value: medianDeskToDoor(d.deliveries) },
  ];
  const stats = statDefs.map((k) => ({
    ...k,
    vstyle: 'display:inline-block;font-family:var(--font-heading);font-weight:800;font-size:26px;' +
      'line-height:1;letter-spacing:-.02em;color:var(--color-text)' +
      (k.alert ? ';box-shadow:inset 0 -5px 0 0 var(--color-text);padding-bottom:2px' : ''),
  }));

  // ----------------------------------------------------------- deliveries
  const dels = d.deliveries
    .filter((x) => {
      if (delFilter === 'All') return true;
      if (delFilter === 'In flight') return !isTerminal(x.phase);
      if (delFilter === 'Delivered') return x.phase === 'DONE';
      return isTerminal(x.phase) && x.phase !== 'DONE';
    })
    .map((x) => {
      const active = !isTerminal(x.phase);
      return {
        key: x.task_id,
        id: oid(x.task_id),
        room: x.room,
        items: formatItems(x.items),
        phase: dev ? x.phase : (active ? humanPhase(x.phase) : TERMINAL_HUMAN[x.phase] ?? humanPhase(x.phase)),
        priority: x.priority,
        robot: x.robot_id ? (dev ? x.robot_id : x.robot_id.replace(/^robot_/, 'Robot ')) : '—',
        created: hhmmss(x.created_at),
        dispatched: hhmmss(x.dispatched_at),
        arrived: hhmmss(x.arrived_at),
        dur: active ? (dev ? 'in flight' : 'In flight') : duration(x.dispatched_at, x.arrived_at),
        tag: 'display:inline-block;padding:3px 7px;font-family:' + MONO + ';font-size:11px;font-weight:600;' +
          (active ? 'background:var(--color-accent);color:#fff'
            : x.phase === 'DONE' ? 'background:var(--color-neutral-200);color:var(--color-neutral-800)'
            : 'border:1px solid var(--color-neutral-500);color:var(--color-neutral-700)'),
        row: active ? 'background:var(--color-neutral-200)' : '',
      };
    });

  // ------------------------------------------------------------- call log
  /** Sessions, each with the tool calls and transcript turns carrying its id. */
  const callGroups = useMemo(() => {
    const byCall = new Map<string, ToolCallRow[]>();
    for (const c of d.toolCalls) {
      const k = c.session_id ?? '__ungrouped__';
      (byCall.get(k) ?? byCall.set(k, []).get(k)!).push(c);
    }
    const byTurn = new Map<string, TranscriptRow[]>();
    for (const t of d.transcripts) {
      (byTurn.get(t.session_id) ?? byTurn.set(t.session_id, []).get(t.session_id)!).push(t);
    }

    const groups = d.sessions.map((sess) => ({
      session: sess,
      calls: (byCall.get(sess.id) ?? []).slice().sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
      turns: byTurn.get(sess.id) ?? [],
    }));

    // Tool calls written before voice_sessions existed have no session to
    // belong to. Surfaced as one synthetic group rather than dropped.
    const orphans = byCall.get('__ungrouped__') ?? [];
    if (orphans.length) {
      const oldest = orphans[orphans.length - 1];
      groups.push({
        session: {
          id: '__ungrouped__',
          agent_id: null,
          started_at: oldest.created_at,
          ended_at: null,
        } as SessionRow,
        calls: orphans.slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
        turns: [],
      });
    }
    return groups;
  }, [d.sessions, d.toolCalls, d.transcripts]);

  /** Filter chips built from the tools actually present — no dead chips. */
  const toolsPresent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of d.toolCalls) counts.set(c.tool_name, (counts.get(c.tool_name) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 5);
  }, [d.toolCalls]);

  const visibleGroups = callGroups.filter(
    (g) => callFilter === 'All' || g.calls.some((c) => c.tool_name === callFilter),
  );

  // ----------------------------------------------------------- escalations
  const escRows = d.escalations.filter((e) =>
    escFilter === 'All' ? true : escFilter === 'Open' ? e.status === 'open' : e.status === 'resolved');

  // ------------------------------------------------------------ inventory
  // Category sub-tabs. Built from the categories actually present rather than
  // from CATS, so a row whose category somehow falls outside the constraint
  // still gets a tab instead of becoming unreachable.
  const invCounts = new Map<string, number>();
  for (const i of d.items) invCounts.set(i.category, (invCounts.get(i.category) ?? 0) + 1);
  const invCatDefs: Array<[string, string]> = [
    ['All', String(d.items.length)],
    ...Array.from(invCounts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([c, n]) => [c, String(n)] as [string, string]),
  ];
  // Count of what needs restocking in the current view — the reason an
  // operator opens this tab at all.
  const needsAttention = d.items.filter(
    (i) => (invCat === 'All' || i.category === invCat) &&
      i.stock_count !== null && i.stock_count <= 3,
  ).length;

  const itemVMs = d.items.filter((i) => invCat === 'All' || i.category === invCat).map((i) => {
    const stock = i.stock_count;
    return {
      key: i.id,
      name: i.name,
      category: i.category,
      price: formatPrice(i.price),
      tags: i.dietary_tags?.length ? i.dietary_tags.join(', ') : '—',
      stock: stock === null ? (dev ? 'unlimited' : 'Unlimited') : String(stock),
      // out of stock = alert chip; low = heavy ink underline; neither uses red
      stockStyle: stock === 0
        ? ALERT_CHIP
        : 'font-family:' + MONO + ';font-size:13px;font-weight:600;color:' +
          (stock === null ? 'var(--color-neutral-600)' : 'var(--color-text)') +
          (stock !== null && stock <= 3 ? ';box-shadow:inset 0 -3px 0 0 var(--color-text);padding-bottom:1px' : ''),
      stockNote: stock === 0 ? 'out' : (stock !== null && stock <= 3 ? 'low' : ''),
      stockNoteStyle: 'margin-left:7px;font-size:10px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;color:' +
        (stock === 0 || (stock !== null && stock <= 3) ? 'var(--color-text)' : 'transparent'),
      avail: dev ? String(i.available) : (i.available ? 'On menu' : 'Hidden'),
      availStyle: 'display:inline-block;white-space:nowrap;padding:3px 8px;font-family:' + MONO + ';font-size:11px;font-weight:600;' +
        (!i.available
          ? 'border:1px solid var(--color-neutral-500);color:var(--color-neutral-700)'
          : 'background:var(--color-neutral-200);color:var(--color-neutral-800)'),
      onEdit: () => {
        setActionError(null);
        setDialog('item');
        setDraft({
          id: i.id, name: i.name, category: i.category,
          price: i.price === null ? '' : String(i.price),
          tags: i.dietary_tags ?? [],
          stock: stock === null ? '' : String(stock),
          avail: i.available,
        });
      },
      onDelete: () => { setActionError(null); setDialog('delete'); setDraft({ id: i.id, name: i.name }); },
    };
  });

  // Badge on the Live tab: the point is "is someone on the line right now",
  // so it shows live/— rather than a count of anything.
  const liveSession = pickLiveSession(
    d.sessions, lastActivityBySession(d.transcripts, d.toolCalls), d.now);

  const tabDefs: Array<[Tab, string, string]> = [
    ['live', 'Live call', liveSession ? 'on' : '—'],
    ['fleet', 'Fleet', movingCount + '/' + (d.robots.length || 0)],
    ['deliveries', 'Deliveries', String(d.deliveries.length)],
    ['calls', 'Call log', String(callGroups.length)],
    ['escalations', 'Escalations', String(openEsc.length)],
    ['inventory', 'Inventory', String(d.items.length)],
  ];

  // ------------------------------------------------------------- dialogs
  const priceNum = draft?.price !== undefined && draft?.price !== ''
    ? Number(String(draft.price).replace(/[^0-9.]/g, '')) || 0 : 0;
  const stockVal = draft && draft.stock !== '' && draft.stock !== null && draft.stock !== undefined
    ? Number(draft.stock) : null;
  const draftTitle = draft
    ? (draft.name !== undefined ? (draft.id === undefined ? 'New item' : draft.name) : draft.id) : '';
  const reqLine = dialog === 'delete'
    ? 'DELETE /admin/items/' + (draft?.id ?? '{id}')
    : (draft?.id !== undefined ? 'PATCH /admin/items/' + draft.id : 'POST /admin/items');
  // Only ever built for a draft that has a name — the Save button is
  // disabled without one, so the fallbacks below are belt-and-braces rather
  // than a real path.
  const itemPayload: api.ItemPayload | null = draft && dialog === 'item' ? {
    name: draft.name ?? '', category: draft.category ?? 'food', price: priceNum,
    dietary_tags: draft.tags ?? [], stock_count: stockVal, available: draft.avail !== false,
  } : null;
  const reqBody = itemPayload ? JSON.stringify(itemPayload, null, 2) : '';

  const lbl = dev
    ? { name: 'name', price: 'price', stock: 'stock_count — blank = unlimited', category: 'category', tags: 'dietary_tags', avail: 'available' }
    : { name: 'Item name', price: 'Price', stock: 'In stock — leave blank for unlimited', category: 'Category', tags: 'Dietary tags', avail: 'Show on menu' };

  const subStyle = 'font-size:11px;color:var(--color-neutral-700)' + (dev ? ';font-family:' + MONO : '');

  const saveItem = guarded(async () => {
    if (!itemPayload) return;
    // An id means editing an existing row; without one this is a new item.
    if (draft?.id) await api.updateItem(draft.id, itemPayload);
    else await api.createItem(itemPayload);
  });

  const confirmDelete = guarded(async () => {
    if (!draft?.id) return;
    await api.deleteItem(draft.id);
  });

  const confirmRecall = guarded(async () => {
    if (!draft?.id) return;
    await api.recallRobot(
      draft.id, draft.reason?.trim() || 'Recalled from the admin dashboard');
  });

  const conn = {
    show: d.connection !== 'live' && ready,
    style: 'display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:11px 20px;border-bottom:2px solid ' +
      (d.connection === 'offline' ? 'var(--color-text)' : 'var(--color-divider)') +
      ';background:' + (d.connection === 'offline' ? 'var(--color-neutral-200)' : 'var(--color-neutral-100)') +
      (d.connection === 'offline'
        ? ';background-image:' + HATCH + ';background-size:100% 6px;background-repeat:no-repeat;' +
          'background-position:top left;padding-top:15px'
        : ''),
    title: d.connection === 'offline' ? (dev ? 'disconnected' : 'Connection lost') : (dev ? 'stale' : 'Falling behind'),
    body: d.connection === 'offline'
      ? (dev ? 'realtime channel closed — values below are the last known payload'
             : 'These numbers stopped updating. Robots on the floor are unaffected.')
      : (dev ? 'no payload for >45s — expected on every table write'
             : 'Last update was a while ago. Positions may have moved since.'),
  };

  return (
    <div style={s('font-family:var(--font-body);color:var(--color-text);background:var(--color-bg)')}>
      <header style={s('display:flex;align-items:center;gap:16px;padding:13px 20px;border-bottom:2px solid var(--color-divider);flex-wrap:wrap')}>
        <div style={s('font-family:var(--font-heading);font-weight:800;font-size:18px;letter-spacing:-.015em')}>ROOM SERVICE OPS</div>
        {dev && SUPABASE_HOST && (
          <div style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600);border-left:1px solid var(--color-divider);padding-left:16px;font-family:' + MONO)}>
            {SUPABASE_HOST}
          </div>
        )}
        <div style={s('margin-left:auto;display:flex;align-items:center;gap:16px;flex-wrap:wrap')}>
          <div style={s('display:flex;align-items:center;gap:7px')}>
            <span style={s('width:9px;height:9px;display:block;background:' +
              (d.connection === 'live' ? 'var(--color-accent);animation:livePulse 1.4s ease-in-out infinite' : 'var(--color-neutral-500)'))} />
            <span style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:600')}>
              {d.connection === 'live' ? 'live' : d.connection}
            </span>
          </div>
          {dev && <span className="tag tag-neutral" style={s('font-family:' + MONO)}>{api.adminApiBase()}</span>}
          <button onClick={() => setDevOverride(!dev)} style={s(chip(dev))}>
            {dev ? 'Dev view' : 'Staff view'}
          </button>
        </div>
      </header>

      {conn.show && (
        <div style={s(conn.style)}>
          <span style={s('font-family:var(--font-heading);font-weight:800;font-size:13px;letter-spacing:.02em;text-transform:uppercase')}>{conn.title}</span>
          <span style={s('font-size:13px')}>{conn.body}</span>
          <button className="btn btn-secondary" onClick={d.refetchAll} style={s('margin-left:auto')}>Reconnect</button>
        </div>
      )}

      {actionError && (
        <div style={s('display:flex;align-items:center;gap:14px;padding:11px 20px;border-bottom:2px solid var(--color-text);background:var(--color-neutral-200)')}>
          <span className="tag" style={s(tag('alert'))}>{dev ? 'write failed' : 'Didn’t save'}</span>
          <span style={s('font-size:13px')}>{actionError}</span>
          <button className="btn btn-secondary" onClick={() => setActionError(null)} style={s('margin-left:auto')}>Dismiss</button>
        </div>
      )}

      <div style={s((side ? 'display:flex;align-items:stretch;' : 'display:flex;flex-direction:column;') + 'min-height:calc(100vh - 54px)')}>
        <nav style={s(side
          ? 'width:190px;flex:none;display:flex;flex-direction:column;border-right:2px solid var(--color-divider);background:var(--color-surface)'
          : 'display:flex;flex-wrap:wrap;border-bottom:2px solid var(--color-divider);background:var(--color-surface)')}>
          {tabDefs.map(([id, label, count]) => (
            <button key={id} onClick={() => setTab(id)} style={s(tabStyle(tab === id, side))}>
              {label}
              <span style={s('margin-left:auto;font-family:' + MONO + ';font-size:11px;font-weight:600;opacity:.72')}>{count}</span>
            </button>
          ))}
        </nav>

        <main style={s('flex:1;min-width:0;padding:20px 20px 40px')}>
          {d.dataState === 'loading' && (
            <div>
              <div style={s('height:15px;width:190px;background:var(--color-neutral-400);animation:skel 1.3s ease-in-out infinite;margin-bottom:18px')} />
              <div style={s('display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:2px;background:var(--color-divider);border:2px solid var(--color-divider)')}>
                {[0, 1, 2, 3].map((n) => (
                  <div key={n} style={s('background:var(--color-bg);padding:18px;display:flex;flex-direction:column;gap:11px')}>
                    <div style={s('height:13px;width:' + (40 + n * 9) + '%;background:var(--color-neutral-400);animation:skel 1.3s ease-in-out infinite')} />
                    <div style={s('height:9px;width:' + (66 - n * 5) + '%;background:var(--color-neutral-300);animation:skel 1.3s ease-in-out infinite;animation-delay:.15s')} />
                    <div style={s('height:9px;width:' + (30 + n * 7) + '%;background:var(--color-neutral-300);animation:skel 1.3s ease-in-out infinite;animation-delay:.3s')} />
                  </div>
                ))}
              </div>
              <div style={s('margin-top:14px;font-size:12px;color:var(--color-neutral-700)')}>
                {dev ? 'awaiting first payload from public.robots' : 'Connecting to the floor…'}
              </div>
            </div>
          )}

          {d.dataState === 'error' && (
            <div style={s('border:2px solid var(--color-text);background-image:' + HATCH + ';background-size:100% 8px;background-repeat:no-repeat;background-position:top left;padding:28px;max-width:620px;display:flex;flex-direction:column;gap:12px;align-items:flex-start')}>
              <span className="tag" style={s(tag('alert'))}>{dev ? 'fetch failed' : 'Can’t reach the robots'}</span>
              <div style={s('font-family:var(--font-heading);font-weight:800;font-size:27px;line-height:1.15;letter-spacing:-.02em')}>
                {dev ? 'No response from Supabase' : 'We’ve lost the live connection'}
              </div>
              <div style={s('font-size:15px;max-width:52ch')}>
                {dev
                  ? 'public.robots could not be read. Displayed values, if any, are from the last successful payload.'
                  : 'Nothing on this screen is updating. Orders already placed are still running — the robots keep going without us. Call the floor if a guest is waiting.'}
              </div>
              <div style={s('display:flex;gap:8px')}>
                <button onClick={d.refetchAll} style={s(PRIMARY_BTN)}>{dev ? 'Retry connection' : 'Try again'}</button>
              </div>
              {dev && d.error && (
                <div style={s('background:var(--color-neutral-200);border:1px solid var(--color-divider);padding:9px 11px;font-family:' + MONO + ';font-size:12px')}>
                  {d.error}
                </div>
              )}
            </div>
          )}

          {ready && tab === 'live' && (
            <div>
              <SectionHead
                title={dev ? 'Front desk line' : 'Live call'}
                sub={dev
                  ? 'newest open voice_sessions row · transcript_turns + tool_call_events over realtime'
                  : 'What the assistant is doing right now, as it happens'}
                subStyle={subStyle}
              />
              <div style={s('display:flex;flex-direction:column;gap:14px')}>
                <CallControl dev={dev} />
                <LiveCall
                  sessions={d.sessions}
                  toolCalls={d.toolCalls}
                  transcripts={d.transcripts}
                  deliveries={d.deliveries}
                  robots={d.robots}
                  dev={dev}
                  now={d.now}
                />
              </div>
            </div>
          )}

          {ready && tab === 'fleet' && (
            <div>
              <SectionHead
                title={dev ? 'Fleet status' : 'Robots'}
                sub={dev ? 'public.robots · realtime · mirrored ~1 Hz · read-only' : 'Live from the floor, updating continuously'}
                subStyle={subStyle}
              />
              <div style={s('display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:2px;background:var(--color-divider);border:2px solid var(--color-divider)')}>
                {robotVMs.length === 0 && (
                  <Empty
                    title={dev ? 'No rows in public.robots' : 'No robots are reporting'}
                    body={dev ? 'The table is empty, or the task engine has never mirrored its state.' : 'Nothing is on the floor right now. Deliveries will queue until a robot comes online.'}
                  />
                )}
                {robotVMs.map((r) => (
                  <section key={r.key} style={s('background:var(--color-bg);padding:18px;display:flex;flex-direction:column;gap:16px')}>
                    <div style={s('display:flex;align-items:center;gap:10px;flex-wrap:wrap')}>
                      <h5 style={s('margin:0;font-family:' + MONO + ';font-size:14px;letter-spacing:0')}>{r.id}</h5>
                      <span style={s(r.phaseTagStyle)}>{r.phase}</span>
                      <span style={s('margin-left:auto;display:flex;align-items:center;gap:8px')}>
                        <span style={s('font-size:11px;font-family:' + MONO + ';color:var(--color-neutral-700)')}>{r.batteryLabel}</span>
                        <span style={s('width:46px;height:8px;border:1px solid var(--color-divider);display:block')}>
                          <span style={s(r.batteryBar)} />
                        </span>
                      </span>
                    </div>

                    {r.showSteps && (
                      <div>
                        <div style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600);margin-bottom:6px')}>{r.stepCaption}</div>
                        <div style={s('display:flex;gap:2px')}>
                          {r.steps.map((st) => <div key={st.key} style={s(st.box)}>{st.label}</div>)}
                        </div>
                      </div>
                    )}

                    {r.showStrip && (
                      <div style={s('display:flex;align-items:center;gap:10px')}>
                        <div style={s('display:flex;gap:3px')}>
                          {r.cells.map((c) => <span key={c.key} style={s(c.sq)} />)}
                        </div>
                        <div style={s('font-family:var(--font-heading);font-weight:800;font-size:20px;letter-spacing:-.015em')}>{r.phaseWord}</div>
                        <div style={s('margin-left:auto;font-size:11px;font-family:' + MONO + ';color:var(--color-neutral-700)')}>leg {r.legLabel}</div>
                      </div>
                    )}

                    {r.showLeg && (
                      <div>
                        <div style={s('display:flex;justify-content:space-between;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600);margin-bottom:6px')}>
                          <span>{r.legCaption}</span>
                          <span style={s('font-family:' + MONO + ';letter-spacing:0;color:var(--color-text)')}>{r.legLabel}</span>
                        </div>
                        <div style={s('height:10px;border:1px solid var(--color-divider);background:var(--color-surface)')}>
                          <span style={s(r.legBar)} />
                        </div>
                      </div>
                    )}

                    <div style={s('border-top:2px solid var(--color-divider);padding-top:14px')}>
                      {r.hasTask ? (
                        <div style={s('display:flex;flex-direction:column;gap:9px')}>
                          <div style={s('display:flex;align-items:baseline;gap:10px;flex-wrap:wrap')}>
                            <span style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)')}>{r.roomCaption}</span>
                            <span style={s('font-family:var(--font-heading);font-weight:800;font-size:32px;line-height:1;letter-spacing:-.02em')}>{r.room}</span>
                            {r.priority && <span className="tag" style={s('align-self:center;' + tag('neutral'))}>{r.priority}</span>}
                            <span style={s('margin-left:auto;font-size:11px;font-family:' + MONO + ';color:var(--color-neutral-600)')}>{r.taskId}</span>
                          </div>
                          <div style={s('font-size:14px')}>{r.itemsText}</div>
                          <div style={s('font-size:11px;font-family:' + MONO + ';color:var(--color-neutral-600)')}>{r.metaLine}</div>
                        </div>
                      ) : (
                        <div style={s('display:flex;flex-direction:column;gap:6px')}>
                          <div style={s('font-family:var(--font-heading);font-weight:800;font-size:20px;color:var(--color-neutral-500)')}>No current task</div>
                          <div style={s('font-size:11px;font-family:' + MONO + ';color:var(--color-neutral-600)')}>{r.noTaskLine}</div>
                        </div>
                      )}
                    </div>

                    <div style={s('display:flex;gap:8px;align-items:center')}>
                      {r.kioskAction && (
                        <button
                          onClick={() => void runOpen(() => r.kioskAction!.fn())}
                          disabled={busy}
                          style={s(PRIMARY_BTN)}
                        >
                          {r.kioskAction.label}
                        </button>
                      )}
                      <button className="btn btn-secondary" onClick={r.onRecall} disabled={r.recallDisabled}>Recall this robot</button>
                      {dev && <span style={s('font-size:10px;color:var(--color-neutral-700);letter-spacing:.04em;font-family:' + MONO)}>POST /admin/robots/{r.key}/recall</span>}
                    </div>
                  </section>
                ))}
              </div>

              <div style={s('display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:2px;background:var(--color-divider);border:2px solid var(--color-divider);border-top:0')}>
                {stats.map((k) => (
                  <div key={k.label} style={s('background:var(--color-bg);padding:14px 16px')}>
                    <div style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600);margin-bottom:4px')}>{k.label}</div>
                    <div><span style={s(k.vstyle)}>{k.value}</span></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {ready && tab === 'deliveries' && (
            <div>
              <SectionHead
                title={dev ? 'Dispatch log' : 'Orders'}
                sub={dev ? 'public.deliveries order by created_at desc · never deleted · read-only' : 'Every order tonight, newest first'}
                subStyle={subStyle}
              />
              <div style={s('display:flex;gap:2px;margin-bottom:12px;flex-wrap:wrap')}>
                {['All', 'In flight', 'Delivered', 'Other'].map((f) => (
                  <button key={f} onClick={() => setDelFilter(f)} style={s(chip(delFilter === f))}>{f}</button>
                ))}
              </div>
              <div style={s('border:2px solid var(--color-divider);overflow-x:auto')}>
                <table className="table">
                  <thead>
                    <tr>
                      {(dev
                        ? ['task_id', 'room', 'items', 'phase', 'priority', 'robot', 'created', 'dispatched', 'arrived', 'desk→door']
                        : ['Order', 'Room', 'Items', 'Status', 'Priority', 'Robot', 'Placed', 'Sent', 'Delivered', 'Took']
                      ).map((h, n) => <th key={n}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {dels.length === 0 && (
                      <tr><td colSpan={10} style={s('padding:36px 16px')}>
                        <div style={s('font-family:var(--font-heading);font-weight:800;font-size:18px;letter-spacing:-.01em;margin-bottom:5px')}>
                          {delFilter === 'All' ? (dev ? 'No rows' : 'No orders yet tonight') : (dev ? 'No rows match this filter' : 'Nothing matches this filter')}
                        </div>
                        <div style={s('font-size:13px;color:var(--color-neutral-700);max-width:46ch')}>
                          {delFilter === 'All'
                            ? (dev ? 'public.deliveries is empty.' : 'Orders appear here the moment the assistant takes one.')
                            : (dev ? 'Clear the filter to see the full table.' : 'Try “All” to see every order.')}
                        </div>
                      </td></tr>
                    )}
                    {dels.map((x) => (
                      <tr key={x.key} style={s(x.row)}>
                        <td style={s('font-family:' + MONO + ';font-size:12px;white-space:nowrap')}>{x.id}</td>
                        <td style={s('font-weight:600')}>{x.room}</td>
                        <td style={s('font-size:13px;min-width:170px')}>{x.items}</td>
                        <td><span style={s(x.tag)}>{x.phase}</span></td>
                        <td style={s('font-size:12px;text-transform:uppercase;letter-spacing:.04em')}>{x.priority}</td>
                        <td style={s('font-family:' + MONO + ';font-size:12px')}>{x.robot}</td>
                        <td style={s('font-family:' + MONO + ';font-size:12px;color:var(--color-neutral-700)')}>{x.created}</td>
                        <td style={s('font-family:' + MONO + ';font-size:12px;color:var(--color-neutral-700)')}>{x.dispatched}</td>
                        <td style={s('font-family:' + MONO + ';font-size:12px;color:var(--color-neutral-700)')}>{x.arrived}</td>
                        <td style={s('font-family:' + MONO + ';font-size:12px')}>{x.dur}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {ready && tab === 'calls' && (
            <div>
              <SectionHead
                title={dev ? 'Voice call log' : 'Guest calls'}
                sub={dev
                  ? 'public.voice_sessions · tool_call_events + transcript_turns grouped by session_id'
                  : 'Every call the assistant handled. Open one to see exactly what it did.'}
                subStyle={subStyle}
              />
              <div style={s('display:flex;gap:2px;margin-bottom:12px;flex-wrap:wrap')}>
                {['All', ...toolsPresent].map((f) => (
                  <button key={f} onClick={() => setCallFilter(f)} style={s(chip(callFilter === f))}>
                    {dev || f === 'All' ? f : (TOOL_HUMAN[f] ?? f)}
                  </button>
                ))}
              </div>
              <div style={s('border:2px solid var(--color-divider)')}>
                {visibleGroups.length === 0 && (
                  <Empty
                    title={callFilter === 'All' ? (dev ? 'No rows' : 'No calls yet') : (dev ? 'No sessions match this filter' : 'No calls of this kind')}
                    body={callFilter === 'All'
                      ? (dev ? 'public.voice_sessions is empty — run orchestrator/agent.py to record one.' : 'Every guest call the assistant handles shows up here.')
                      : (dev ? 'Clear the filter to see all sessions.' : 'Try “All” to see every call.')}
                    bare
                  />
                )}
                {visibleGroups.map((g) => {
                  const orphan = g.session.id === '__ungrouped__';
                  const escalated = g.calls.some((c) => c.tool_name === 'escalate_to_frontdesk');
                  const guestFirst = g.turns.find((t) => t.role === 'guest');
                  const room = roomForCall(g.session, g.calls);
                  const live = !g.session.ended_at && !orphan;
                  return (
                    <button
                      key={g.session.id}
                      onClick={() => setOpenCall(g.session.id)}
                      style={s('width:100%;display:flex;gap:16px;padding:13px 16px;align-items:center;flex-wrap:wrap;' +
                        'background:transparent;border:0;border-bottom:1px solid var(--color-divider);' +
                        'cursor:pointer;text-align:left;font-family:var(--font-body);color:var(--color-text)')}
                    >
                      <span style={s('width:74px;flex:none;font-family:' + MONO + ';font-size:12px;color:var(--color-neutral-600)')}>
                        {hhmmss(g.session.started_at)}
                      </span>
                      {/* room reads first: it is how staff identify a call */}
                      <span style={s('width:62px;flex:none;font-family:var(--font-heading);font-weight:800;font-size:19px;line-height:1;letter-spacing:-.01em;color:' + (room ? 'var(--color-text)' : 'var(--color-neutral-500)'))}>
                        {room ?? '—'}
                      </span>
                      <span style={s('flex:1;min-width:200px;font-size:13.5px;color:var(--color-neutral-800)')}>
                        {guestFirst ? '“' + guestFirst.text + '”' : (dev ? 'no transcript rows' : 'No transcript')}
                      </span>
                      <span style={s('display:flex;gap:8px;align-items:center;flex:none')}>
                        {live && (
                          <span style={s('display:flex;align-items:center;gap:6px')}>
                            <span style={s('width:8px;height:8px;display:block;background:var(--color-accent);animation:livePulse 1.4s ease-in-out infinite')} />
                            <span style={s('font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:700')}>live</span>
                          </span>
                        )}
                        {escalated && <span className="tag" style={s(tag('alert'))}>{dev ? 'escalated' : 'Escalated'}</span>}
                        <span style={s('font-family:' + MONO + ';font-size:11px;color:var(--color-neutral-700)')}>
                          {g.calls.length}{dev ? ' calls' : ' actions'}
                        </span>
                        <span style={s('font-family:' + MONO + ';font-size:11px;color:var(--color-neutral-700)')}>
                          {g.turns.length}{dev ? ' turns' : ' said'}
                        </span>
                        {dev && (
                          <span style={s('font-family:' + MONO + ';font-size:11px;color:var(--color-neutral-600)')}>
                            {orphan ? 'session_id null' : g.session.id}
                          </span>
                        )}
                        <span style={s('font-family:var(--font-heading);font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--color-divider);padding:4px 9px')}>
                          Open
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {ready && tab === 'escalations' && (
            <div>
              <SectionHead
                title={dev ? 'Front desk escalations' : 'Needs your attention'}
                sub={dev ? 'public.frontdesk_escalations · resolve via admin_api' : 'Calls the assistant handed to the desk'}
                subStyle={subStyle}
              />
              <div style={s('display:flex;gap:2px;margin-bottom:12px;flex-wrap:wrap')}>
                {['Open', 'Resolved', 'All'].map((f) => (
                  <button key={f} onClick={() => setEscFilter(f)} style={s(chip(escFilter === f))}>{f}</button>
                ))}
              </div>
              <div style={s('border:2px solid var(--color-divider)')}>
                {escRows.length === 0 && (
                  <Empty
                    title={escFilter === 'Open' ? (dev ? 'No open rows' : 'Nothing needs you') : (dev ? 'No rows' : 'Nothing here')}
                    body={escFilter === 'Open'
                      ? (dev ? 'No frontdesk_escalations with status = open.' : 'The assistant is handling calls on its own. Anything it can’t resolve lands here.')
                      : (dev ? 'public.frontdesk_escalations has no rows for this filter.' : 'Try another filter.')}
                    bare
                  />
                )}
                {escRows.map((x) => {
                  const isOpen = x.status === 'open';
                  return (
                    <div key={x.id} style={s('display:flex;gap:18px;padding:16px 16px 16px 0;border-bottom:1px solid var(--color-divider);align-items:stretch;flex-wrap:wrap')}>
                      {/* hazard spine — the alert treatment, never red */}
                      <div style={s('flex:none;width:10px;align-self:stretch;min-height:44px;background:' +
                        (isOpen ? HATCH : 'var(--color-neutral-300)'))} />
                      <div style={s('flex:none;width:58px;font-family:var(--font-heading);font-weight:800;font-size:22px;line-height:1;color:' +
                        (x.room ? 'var(--color-text)' : 'var(--color-neutral-500)'))}>
                        {x.room ?? '—'}
                      </div>
                      <div style={s('flex:1;min-width:220px')}>
                        <div style={s('font-family:var(--font-heading);font-weight:800;font-size:17px;line-height:1.2;margin-bottom:5px')}>{x.reason}</div>
                        <div style={s('font-size:11px;font-family:' + MONO + ';color:var(--color-neutral-600)')}>
                          {(dev ? x.id + ' · ' : '') + hhmmss(x.created_at) + ' · ' + ago(x.created_at, d.now)}
                          {x.resolved_at ? ' · resolved ' + hhmmss(x.resolved_at) : ''}
                        </div>
                      </div>
                      <span style={s('flex:none;display:flex;gap:8px;align-items:center')}>
                        <span className="tag" style={s(isOpen ? tag('alert') : tag('ghost'))}>
                          {dev ? x.status : (isOpen ? 'Open' : 'Resolved')}
                        </span>
                        <button
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={guarded(() => isOpen
                            ? api.resolveEscalation(x.id)
                            : api.reopenEscalation(x.id))}
                        >
                          {isOpen ? 'Resolve' : 'Reopen'}
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {ready && tab === 'inventory' && (
            <div>
              <div style={s('display:flex;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap')}>
                <h4 style={s('margin:0')}>Inventory</h4>
                <span style={s(subStyle)}>{dev ? 'public.inventory_items · reads live · writes via admin_api' : 'What guests can order right now'}</span>
                <button
                  onClick={() => {
                    setActionError(null);
                    setDialog('item');
                    // pre-pick the category being viewed, so adding to a
                    // filtered list doesn't default into a different one
                    setDraft({
                      name: '', category: invCat === 'All' ? 'food' : invCat,
                      price: '', tags: [], stock: '', avail: true,
                    });
                  }}
                  style={s('margin-left:auto;' + PRIMARY_BTN)}
                >
                  New item
                </button>
              </div>

              <div style={s('display:flex;gap:2px;margin-bottom:12px;flex-wrap:wrap;align-items:center')}>
                {invCatDefs.map(([c, n]) => (
                  <button key={c} onClick={() => setInvCat(c)} style={s(chip(invCat === c))}>
                    {c}
                    <span style={s('margin-left:7px;font-family:' + MONO + ';opacity:.7')}>{n}</span>
                  </button>
                ))}
                {needsAttention > 0 && (
                  <span style={s('margin-left:auto;font-size:11px;font-family:' + MONO + ';color:var(--color-neutral-700)')}>
                    {needsAttention} {dev ? 'at or below 3' : 'running low'}
                  </span>
                )}
              </div>

              <div style={s('border:2px solid var(--color-divider);overflow-x:auto')}>
                <table className="table">
                  <thead>
                    <tr>
                      {(dev
                        ? ['name', 'category', 'price', 'dietary_tags', 'stock_count', 'available', '']
                        : ['Item', 'Category', 'Price', 'Dietary', 'In stock', 'On menu', '']
                      ).map((h, n) => <th key={n}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {itemVMs.length === 0 && (
                      <tr><td colSpan={7} style={s('padding:36px 16px')}>
                        <div style={s('font-family:var(--font-heading);font-weight:800;font-size:18px;letter-spacing:-.01em;margin-bottom:5px')}>
                          {invCat !== 'All'
                            ? (dev ? 'No rows in this category' : 'Nothing in ' + invCat)
                            : (dev ? 'No rows' : 'The menu is empty')}
                        </div>
                        <div style={s('font-size:13px;color:var(--color-neutral-700);max-width:46ch')}>
                          {invCat !== 'All'
                            ? (dev ? 'Switch to All to see every row.' : 'Try “All” to see the whole menu.')
                            : (dev ? 'public.inventory_items has no rows — the voice agent will return nothing.' : 'Guests can’t order anything until you add an item.')}
                        </div>
                      </td></tr>
                    )}
                    {itemVMs.map((i) => (
                      <tr key={i.key}>
                        <td style={s('font-weight:600')}>{i.name}</td>
                        <td style={s('font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--color-neutral-700)')}>{i.category}</td>
                        <td style={s('font-family:' + MONO + ';font-size:13px')}>{i.price}</td>
                        <td style={s('font-size:12px;font-family:' + MONO + ';color:var(--color-neutral-700)')}>{i.tags}</td>
                        <td style={s('white-space:nowrap')}>
                          <span style={s(i.stockStyle)}>{i.stock}</span>
                          <span style={s(i.stockNoteStyle)}>{i.stockNote}</span>
                        </td>
                        <td style={s('white-space:nowrap')}><span style={s(i.availStyle)}>{i.avail}</span></td>
                        <td style={s('text-align:right;white-space:nowrap')}>
                          <span style={s('display:inline-flex;gap:4px;justify-content:flex-end')}>
                            <button onClick={i.onEdit} style={s(EDIT_BTN)}>Edit</button>
                            <button onClick={i.onDelete} style={s(DELETE_BTN)}>Delete</button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {showProposals && (
                <div style={s('margin-top:28px;border:2px solid var(--color-divider)')}>
                  <div style={s('padding:14px 16px;border-bottom:2px solid var(--color-divider);display:flex;align-items:baseline;gap:12px;flex-wrap:wrap')}>
                    <h5 style={s('margin:0')}>Stock ledger</h5>
                    <span style={s('font-size:11px;font-family:' + MONO + ';color:var(--color-neutral-700);flex:1;min-width:240px')}>
                      {dev
                        ? 'public.inventory_audit_log · one row per item per stock change, with before/after'
                        : 'Every stock change, and what caused it'}
                    </span>
                  </div>
                  <div style={s('overflow-x:auto')}>
                    <table className="table">
                      <thead>
                        <tr>
                          {(dev
                            ? ['created_at', 'item_name', 'delta', 'before_count', 'after_count', 'source']
                            : ['Time', 'Item', 'Change', 'Before', 'After', 'Why']
                          ).map((h, n) => <th key={n}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {d.audit.length === 0 && (
                          <tr><td colSpan={6} style={s('padding:28px 16px;font-size:13px;color:var(--color-neutral-700)')}>
                            {dev ? 'public.inventory_audit_log is empty.' : 'No stock has changed yet.'}
                          </td></tr>
                        )}
                        {d.audit.map((l) => (
                          <tr key={l.id}>
                            <td style={s('font-family:' + MONO + ';font-size:12px')}>{hhmmss(l.created_at)}</td>
                            <td style={s('font-weight:600')}>{l.item_name}</td>
                            <td style={s('font-family:' + MONO + ';font-size:13px;font-weight:600')}>
                              {l.delta > 0 ? '+' + l.delta : '−' + Math.abs(l.delta)}
                            </td>
                            <td style={s('font-family:' + MONO + ';font-size:13px')}>{l.before_count ?? '—'}</td>
                            <td style={s('font-family:' + MONO + ';font-size:13px')}>{l.after_count ?? '—'}</td>
                            <td style={s('font-family:' + MONO + ';font-size:12px;color:var(--color-neutral-700)')}>
                              {l.source + (l.task_id ? ' ' + (dev ? l.task_id : l.task_id.toUpperCase()) : '')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {openCall && (() => {
        const g = callGroups.find((x) => x.session.id === openCall);
        if (!g) return null;   // the call vanished under a filter change
        return (
          <CallModal
            session={g.session}
            calls={g.calls}
            turns={g.turns}
            deliveries={d.deliveries}
            robots={d.robots}
            dev={dev}
            onClose={() => setOpenCall(null)}
          />
        );
      })()}

      {dialog === 'recall' && draft && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <div className="dialog-title">Recall {dev ? draft.id : String(draft.id).replace(/^robot_/, 'Robot ')}?</div>
            <div className="dialog-body">
              The robot drops its current leg and drives back to the desk. Its delivery
              stays in the log, ending at the desk rather than the room.
            </div>
            <div className="field">
              <label>{dev ? 'reason' : 'Why are you recalling it?'}</label>
              <input
                className="input"
                autoFocus
                value={draft.reason}
                onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
              />
            </div>
            {dev && (
              <div style={s('background:var(--color-neutral-200);border:1px solid var(--color-divider);padding:10px 12px;font-family:' + MONO + ';font-size:12px;line-height:1.6')}>
                <div>POST /admin/robots/{draft.id}/recall</div>
                <div style={s('color:var(--color-neutral-700)')}>X-Admin-Password: ••••••••</div>
              </div>
            )}
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={closeDialog}>Cancel</button>
              <button onClick={confirmRecall} disabled={busy} style={s(PRIMARY_BTN)}>
                {busy ? 'Recalling…' : 'Recall robot'}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog === 'item' && draft && (
        <div className="dialog-backdrop">
          <div className="dialog" style={s('width:min(520px,100%)')}>
            <div className="dialog-title">{draftTitle}</div>
            <div className="field">
              <label>{lbl.name}</label>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div style={s('display:flex;gap:12px;flex-wrap:wrap')}>
              <div className="field" style={s('flex:1;min-width:150px')}>
                <label>{lbl.price}</label>
                <input className="input" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
              </div>
              <div className="field" style={s('flex:1;min-width:150px')}>
                <label>{lbl.stock}</label>
                <input className="input" value={draft.stock} onChange={(e) => setDraft({ ...draft, stock: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>{lbl.category}</label>
              <div style={s('display:flex;gap:2px;flex-wrap:wrap')}>
                {CATS.map((c) => (
                  <button key={c} onClick={() => setDraft({ ...draft, category: c })} style={s(chip(draft.category === c))}>{c}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>{lbl.tags}</label>
              <div style={s('display:flex;gap:2px;flex-wrap:wrap')}>
                {TAGS.map((t) => {
                  const on = (draft.tags || []).indexOf(t) > -1;
                  return (
                    <button key={t} style={s(chip(on))} onClick={() => {
                      const cur = (draft.tags || []).slice();
                      const n = cur.indexOf(t);
                      if (n > -1) cur.splice(n, 1); else cur.push(t);
                      setDraft({ ...draft, tags: cur });
                    }}>{t}</button>
                  );
                })}
              </div>
            </div>
            <div className="field">
              <label>{lbl.avail}</label>
              <div style={s('display:flex;gap:2px')}>
                {([['true', true], ['false', false]] as Array<[string, boolean]>).map(([label, val]) => (
                  <button key={label} onClick={() => setDraft({ ...draft, avail: val })}
                    style={s(chip((draft.avail !== false) === val))}>
                    {dev ? label : (val ? 'Yes' : 'No')}
                  </button>
                ))}
              </div>
            </div>
            {dev && (
              <div style={s('background:var(--color-neutral-200);border:1px solid var(--color-divider);padding:10px 12px;font-family:' + MONO + ';font-size:12px;line-height:1.6;overflow-x:auto')}>
                <div>{reqLine}</div>
                <div style={s('color:var(--color-neutral-700);white-space:pre-wrap')}>{reqBody}</div>
              </div>
            )}
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={closeDialog}>Cancel</button>
              <button onClick={saveItem} disabled={busy || !draft.name} style={s(PRIMARY_BTN)}>
                {busy ? 'Saving…' : 'Save item'}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog === 'delete' && draft && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <div className="dialog-title">Delete {draft.name}?</div>
            <div className="dialog-body">
              Removed from the menu the voice agent reads. In-flight deliveries that
              already contain it are unaffected.
            </div>
            {dev && (
              <div style={s('background:var(--color-neutral-200);border:1px solid var(--color-divider);padding:10px 12px;font-family:' + MONO + ';font-size:12px')}>{reqLine}</div>
            )}
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={closeDialog}>Cancel</button>
              <button onClick={confirmDelete} disabled={busy}
                style={s(PRIMARY_BTN + ';box-shadow:inset 0 -5px 0 0 var(--color-neutral-600)')}>
                {busy ? 'Deleting…' : 'Delete item'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHead({ title, sub, subStyle }: { title: string; sub: string; subStyle: string }) {
  return (
    <div style={s('display:flex;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap')}>
      <h4 style={s('margin:0')}>{title}</h4>
      <span style={s(subStyle)}>{sub}</span>
    </div>
  );
}

function Empty({ title, body, bare }: { title: string; body: string; bare?: boolean }) {
  return (
    <div style={s((bare ? '' : 'background:var(--color-bg);') + 'padding:38px 18px')}>
      <div style={s('font-family:var(--font-heading);font-weight:800;font-size:19px;letter-spacing:-.01em;margin-bottom:6px')}>{title}</div>
      <div style={s('font-size:13px;color:var(--color-neutral-700);max-width:48ch')}>{body}</div>
    </div>
  );
}
