/**
 * Row shapes for the tables this dashboard reads. These mirror
 * `supabase/migrations/*.sql` exactly — that SQL is the source of truth,
 * not this file. If a column changes there, change it here.
 */

/** public.robots — mirrored from the task engine ~1×/s. */
export type RobotRow = {
  id: string;
  phase: string;
  current_task_id: string | null;
  pose_frac: number | null;
  battery: number | null;
  updated_at: string;
};

/** public.deliveries — one row per dispatched task, never deleted. */
export type DeliveryRow = {
  task_id: string;
  robot_id: string | null;
  room: string;
  /** jsonb: a flat list of item names, duplicates preserved as quantity. */
  items: string[] | null;
  phase: string;
  priority: string;
  dispatched_at: string | null;
  arrived_at: string | null;
  created_at: string;
  updated_at: string;
};

/** public.tool_call_events — one row per tool.call the voice agent made. */
export type ToolCallRow = {
  id: string;
  tool_name: string;
  arguments: Record<string, unknown> | null;
  /** One plain sentence — orchestrator/tools.py summarize_result(). */
  result_summary: string | null;
  /** The handler's structured return, for dev view. Null on rows written
   *  before the column existed; fall back to result_summary there. */
  result: Record<string, unknown> | null;
  session_id: string | null;
  created_at: string;
};

/** public.voice_sessions — one row per WebSocket session, i.e. one call. */
export type SessionRow = {
  id: string;
  agent_id: string | null;
  /** Extension the call came in on, known at connect time the way a hotel
   *  PBX hands reception the room. Null for a call with no caller ID. */
  room: string | null;
  started_at: string;
  ended_at: string | null;
};

/** public.transcript_turns — what was actually said, in order. */
export type TranscriptRow = {
  id: string;
  session_id: string;
  role: 'guest' | 'agent';
  text: string;
  created_at: string;
};

/** public.frontdesk_escalations. */
export type EscalationRow = {
  id: string;
  reason: string;
  room: string | null;
  status: 'open' | 'resolved';
  resolved_at: string | null;
  created_at: string;
};

/** public.inventory_items — the menu the voice agent reads. */
export type ItemRow = {
  id: string;
  name: string;
  category: string;
  price: number | string | null;
  dietary_tags: string[];
  available: boolean;
  /** null means "not stock-tracked", which reads as unlimited. */
  stock_count: number | null;
  created_at: string;
  updated_at: string;
};

/** public.inventory_audit_log — before/after for every stock change. */
export type AuditRow = {
  id: string;
  item_id: string | null;
  item_name: string;
  delta: number;
  before_count: number | null;
  after_count: number | null;
  task_id: string | null;
  source: string;
  created_at: string;
};
