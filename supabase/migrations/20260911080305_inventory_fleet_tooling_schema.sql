create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null check (category in ('amenity','food','beverage')),
  price numeric(10,2),
  dietary_tags text[] not null default '{}',
  available boolean not null default true,
  stock_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table robots (
  id text primary key,
  phase text not null default 'IDLE'
    check (phase in ('IDLE','COLLECTING','EN_ROUTE','ARRIVED','RETURNING','RECALLED','AT_DESK')),
  current_task_id text,
  pose_frac numeric,
  battery numeric,
  updated_at timestamptz not null default now()
);

create table deliveries (
  task_id text primary key,
  robot_id text references robots(id),
  room text not null,
  items jsonb not null,
  phase text not null,
  priority text not null default 'normal',
  dispatched_at timestamptz,
  arrived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table robot_commands (
  id uuid primary key default gen_random_uuid(),
  robot_id text not null references robots(id),
  cmd text not null check (cmd in ('complete_loading','complete_collection')),
  status text not null default 'pending' check (status in ('pending','done')),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table frontdesk_escalations (
  id uuid primary key default gen_random_uuid(),
  reason text not null,
  room text,
  created_at timestamptz not null default now()
);

alter table inventory_items enable row level security;
alter table robots enable row level security;
alter table deliveries enable row level security;
alter table robot_commands enable row level security;
alter table frontdesk_escalations enable row level security;

create policy "public read" on inventory_items for select to anon, authenticated using (true);
create policy "public read" on robots for select to anon, authenticated using (true);
create policy "public read" on deliveries for select to anon, authenticated using (true);
create policy "public read" on frontdesk_escalations for select to anon, authenticated using (true);

insert into robots (id) values ('robot_1'), ('robot_2');
