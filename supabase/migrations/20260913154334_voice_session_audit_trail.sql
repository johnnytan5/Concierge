-- One row per Voice Agent WebSocket session -- "a guest call". The Call log
-- tab groups tool calls and transcript turns by this id to replay one
-- conversation end to end.
create table voice_sessions (
  id text primary key,
  agent_id text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

-- What was actually SAID, in order, within one call. orchestrator/agent.py
-- only print()ed transcript.user/transcript.agent before this table existed,
-- so the guest's words were never recoverable after the process exited.
create table transcript_turns (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references voice_sessions(id) on delete cascade,
  role text not null check (role in ('guest','agent')),
  text text not null,
  created_at timestamptz not null default now()
);
create index on transcript_turns (session_id, created_at);

-- Groups existing per-tool-call rows into a conversation. Nullable: rows
-- written before this migration have no session, and the dashboard renders
-- those as "ungrouped".
alter table tool_call_events
  add column session_id text references voice_sessions(id) on delete set null;
create index on tool_call_events (session_id, created_at);

alter table voice_sessions enable row level security;
alter table transcript_turns enable row level security;
create policy "public read" on voice_sessions for select to anon, authenticated using (true);
create policy "public read" on transcript_turns for select to anon, authenticated using (true);

alter publication supabase_realtime add table voice_sessions;
alter publication supabase_realtime add table transcript_turns;
