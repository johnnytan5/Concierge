'use client'
import { useEffect, useState } from 'react'
import { useRealtimeTable } from '@/lib/useRealtimeTable'
import { useRealtimeEvent } from '@/lib/useRealtimeEvent'
import styles from './FlowDiagram.module.css'

type Robot = { id: string; phase: string; current_task_id: string | null }
type ToolEvent = { tool_name: string }

// Semantic phase -> color mapping. Values kept exactly as specified upstream
// (do not change without updating the task-engine/orchestrator contract).
// A tactical-telemetry HUD reading multiple status hues per phase (nominal /
// caution / in-transit / alert) is consistent with the visual reference
// class this dashboard is styled after, so these are left as literal
// per-phase accent colors rather than collapsed into the chrome's red/green
// restraint — see task-3-report.md for the full reasoning.
const PHASE_COLOR: Record<string, string> = {
  IDLE: '#9ca3af',
  COLLECTING: '#eab308',
  EN_ROUTE: '#3b82f6',
  ARRIVED: '#22c55e',
  RETURNING: '#3b82f6',
  RECALLED: '#ef4444',
  AT_DESK: '#9ca3af',
}

function isRecent(t: number | null, ms = 1500) {
  return t !== null && Date.now() - t < ms
}

function Node({ label, active, color }: { label: string; active: boolean; color?: string }) {
  return (
    <div
      className={`${styles.node} ${active ? styles.active : ''}`}
      style={color ? { borderColor: color, color } : undefined}
    >
      <span className={styles.nodeLabel}>{label}</span>
    </div>
  )
}

export default function FlowDiagram() {
  // Realtime pushes are the only thing that triggers a re-render, but
  // isRecent()'s window needs to expire on the clock even when no new
  // event arrives, or an activated node would stay lit forever. This tick
  // does not change any derived state below -- it only forces
  // re-evaluation of isRecent() on an interval so nodes fade back down.
  const [, forceTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 250)
    return () => clearInterval(id)
  }, [])

  const toolEvents = useRealtimeEvent('tool_call_events')
  const robots = useRealtimeTable<Robot>('robots', 'id')
  const inventoryEvent = useRealtimeEvent('inventory_items', 'UPDATE')
  const deliveryEvent = useRealtimeEvent('deliveries', 'INSERT')

  const toolName: string | undefined = toolEvents.lastPayload?.tool_name
  const voiceAgentActive = isRecent(toolEvents.lastEventAt)
  const checkMenuActive = voiceAgentActive && toolName === 'check_menu'
  const dispatchActive =
    voiceAgentActive &&
    ['dispatch_delivery', 'amend_delivery', 'recall_robot'].includes(toolName ?? '')
  const escalateActive = voiceAgentActive && toolName === 'escalate_to_frontdesk'
  const inventoryActive = isRecent(inventoryEvent.lastEventAt) || isRecent(deliveryEvent.lastEventAt)

  return (
    <div className={styles.diagram}>
      <div className={styles.column}>
        <div className={styles.columnLabel}>SOURCE</div>
        <Node label="Guest" active={voiceAgentActive} />
        <Node label="Voice Agent" active={voiceAgentActive} />
      </div>

      <div className={styles.connector} aria-hidden="true">
        &gt;&gt;&gt;
      </div>

      <div className={styles.column}>
        <div className={styles.columnLabel}>TOOL CALL</div>
        <Node label="Check Menu" active={checkMenuActive} />
        <Node label="Dispatch / Amend / Recall" active={dispatchActive} />
        <Node label="Escalate to Front Desk" active={escalateActive} />
      </div>

      <div className={styles.connector} aria-hidden="true">
        &gt;&gt;&gt;
      </div>

      <div className={styles.column}>
        <div className={styles.columnLabel}>FLEET</div>
        {robots.map((r) => (
          <Node
            key={r.id}
            label={`${r.id} — ${r.phase}`}
            active={r.phase !== 'IDLE'}
            color={PHASE_COLOR[r.phase] ?? '#9ca3af'}
          />
        ))}
      </div>

      <div className={styles.connector} aria-hidden="true">
        &gt;&gt;&gt;
      </div>

      <div className={styles.column}>
        <div className={styles.columnLabel}>STATE</div>
        <Node label="Inventory" active={inventoryActive} />
      </div>
    </div>
  )
}
