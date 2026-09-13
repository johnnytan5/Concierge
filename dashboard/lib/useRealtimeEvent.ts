'use client'
import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export function useRealtimeEvent(
  table: string,
  event: 'INSERT' | 'UPDATE' | '*' = '*'
) {
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const [lastPayload, setLastPayload] = useState<any>(null)

  useEffect(() => {
    const channel = supabase
      .channel(`event:${table}:${event}`)
      .on('postgres_changes', { event, schema: 'public', table }, (payload) => {
        setLastEventAt(Date.now())
        setLastPayload((payload as any).new)
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [table, event])

  return { lastEventAt, lastPayload }
}
