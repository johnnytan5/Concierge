'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

export type TableStatus = 'loading' | 'ready' | 'error';
export type ChannelState = 'connecting' | 'live' | 'offline';

export type RealtimeOptions = {
  orderBy?: string;
  ascending?: boolean;
  limit?: number;
};

export type RealtimeResult<T> = {
  rows: T[];
  status: TableStatus;
  channel: ChannelState;
  error: string | null;
  /** Wall-clock ms of the last successful load — drives the stale banner. */
  lastLoadedAt: number | null;
  refetch: () => void;
};

/**
 * One table, kept live.
 *
 * Refetches the whole table on any change rather than patching rows from the
 * payload: these tables are small (tens of rows in a demo) and a full reload
 * cannot drift out of sync with the server the way incremental patching can.
 *
 * Bursts are coalesced. The task engine mirrors robots and deliveries about
 * once a second, and each upsert is its own realtime event, so without this
 * a two-robot fleet would trigger several full refetches per second.
 */
export function useRealtimeTable<T extends Record<string, unknown>>(
  table: string,
  options: RealtimeOptions = {},
): RealtimeResult<T> {
  const { orderBy, ascending = true, limit } = options;

  const [rows, setRows] = useState<T[]>([]);
  const [status, setStatus] = useState<TableStatus>('loading');
  const [channel, setChannel] = useState<ChannelState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    let query = supabase.from(table).select('*');
    if (orderBy) query = query.order(orderBy, { ascending });
    if (limit) query = query.limit(limit);

    const { data, error: err } = await query;
    if (!mounted.current) return;

    if (err) {
      // Keep whatever rows we already have. A transient read failure should
      // blank the connection banner, not the operator's screen.
      setError(err.message);
      setStatus((prev) => (prev === 'ready' ? 'ready' : 'error'));
      return;
    }
    setRows((data ?? []) as T[]);
    setError(null);
    setStatus('ready');
    setLastLoadedAt(Date.now());
  }, [table, orderBy, ascending, limit]);

  useEffect(() => {
    mounted.current = true;

    const scheduleReload = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 250);
    };

    const ch = supabase
      .channel(`realtime:${table}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, scheduleReload)
      .subscribe((state) => {
        if (!mounted.current) return;
        if (state === 'SUBSCRIBED') {
          setChannel('live');
          // First load happens AFTER the subscription is established, not
          // before it. Loading first leaves a gap: any write landing between
          // the read returning and the channel opening is in neither, and the
          // table would sit stale until some later unrelated change arrived.
          void load();
        } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
          setChannel('offline');
          // Realtime is unavailable, but the table is still readable over
          // plain HTTP — show data without live updates rather than an empty
          // screen. The connection banner tells the operator it is not live.
          void load();
        }
      });

    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      void supabase.removeChannel(ch);
    };
  }, [table, load]);

  return { rows, status, channel, error, lastLoadedAt, refetch: () => void load() };
}
