create table inventory_audit_log (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references inventory_items(id),
  item_name text not null,
  delta integer not null,
  before_count integer,
  after_count integer,
  task_id text,
  source text not null default 'dispatch_delivery',
  created_at timestamptz not null default now()
);

alter table inventory_audit_log enable row level security;
create policy "public read" on inventory_audit_log for select to anon, authenticated using (true);

alter publication supabase_realtime add table inventory_audit_log;
