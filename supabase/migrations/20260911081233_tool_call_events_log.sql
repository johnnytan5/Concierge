create table tool_call_events (
  id uuid primary key default gen_random_uuid(),
  tool_name text not null,
  arguments jsonb not null,
  result_summary text,
  created_at timestamptz not null default now()
);

alter table tool_call_events enable row level security;
create policy "public read" on tool_call_events for select to anon, authenticated using (true);
