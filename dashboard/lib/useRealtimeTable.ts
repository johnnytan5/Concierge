'use client'
import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export function useRealtimeTable<T extends Record<string, any>>(
  table: string,
  orderBy?: string
): T[] {
  const [rows, setRows] = useState<T[]>([])

  useEffect(() => {
    let mounted = true

    async function load() {
      let query = supabase.from(table).select('*')
      if (orderBy) query = query.order(orderBy)
      const { data } = await query
      if (mounted && data) setRows(data as T[])
    }
    load()

    const channel = supabase
      .channel(`realtime:${table}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        load()
      })
      .subscribe()

    return () => {
      mounted = false
      supabase.removeChannel(channel)
    }
  }, [table, orderBy])

  return rows
}
