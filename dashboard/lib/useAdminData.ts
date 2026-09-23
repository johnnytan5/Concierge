'use client';
import { useEffect, useState } from 'react';
import { useRealtimeTable } from './useRealtimeTable';
import type {
  RobotRow, DeliveryRow, ToolCallRow, SessionRow,
  TranscriptRow, EscalationRow, ItemRow, AuditRow,
} from './types';

/** Every table the admin surface reads, kept live, plus rolled-up status. */
export function useAdminData() {
  const robots = useRealtimeTable<RobotRow>('robots', { orderBy: 'id' });
  const deliveries = useRealtimeTable<DeliveryRow>('deliveries', {
    orderBy: 'created_at', ascending: false,
  });
  const toolCalls = useRealtimeTable<ToolCallRow>('tool_call_events', {
    orderBy: 'created_at', ascending: false, limit: 500,
  });
  const sessions = useRealtimeTable<SessionRow>('voice_sessions', {
    orderBy: 'started_at', ascending: false, limit: 100,
  });
  const transcripts = useRealtimeTable<TranscriptRow>('transcript_turns', {
    orderBy: 'created_at', ascending: true, limit: 2000,
  });
  const escalations = useRealtimeTable<EscalationRow>('frontdesk_escalations', {
    orderBy: 'created_at', ascending: false,
  });
  const items = useRealtimeTable<ItemRow>('inventory_items', { orderBy: 'name' });
  const audit = useRealtimeTable<AuditRow>('inventory_audit_log', {
    orderBy: 'created_at', ascending: false, limit: 100,
  });

  const all = [robots, deliveries, toolCalls, sessions, transcripts, escalations, items, audit];

  // The fleet is the screen's reason to exist: if robots failed to load,
  // this is an error screen even when the menu came back fine. Everything
  // else failing is degraded, not broken.
  const dataState: 'loading' | 'ready' | 'error' =
    robots.status === 'error' ? 'error'
      : all.some((t) => t.status === 'loading') ? 'loading'
      : 'ready';

  // A 1s ticker for everything that renders elapsed time (call timers,
  // "updated 3s ago").
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const newestLoad = Math.max(...all.map((t) => t.lastLoadedAt ?? 0));
  const anyOffline = all.some((t) => t.channel === 'offline');
  const allConnecting = all.every((t) => t.channel === 'connecting');

  // Stale means "the channels have not come up yet", not "nothing changed
  // lately". It used to also fire after 45s without any row changing, but a
  // healthy, subscribed channel on a quiet floor produces no events, so that
  // rule flagged every lull in the demo as "Falling behind". A dropped
  // channel is caught directly: Supabase reports CHANNEL_ERROR / TIMED_OUT /
  // CLOSED, which is 'offline' above.
  const connection: 'live' | 'stale' | 'offline' =
    anyOffline ? 'offline'
      : allConnecting ? 'stale'
      : 'live';

  const refetchAll = () => all.forEach((t) => t.refetch());

  return {
    robots: robots.rows,
    deliveries: deliveries.rows,
    toolCalls: toolCalls.rows,
    sessions: sessions.rows,
    transcripts: transcripts.rows,
    escalations: escalations.rows,
    items: items.rows,
    audit: audit.rows,
    dataState,
    connection,
    now,
    lastLoadedAt: newestLoad || null,
    error: all.find((t) => t.error)?.error ?? null,
    refetchAll,
  };
}
