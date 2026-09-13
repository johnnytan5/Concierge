-- The Escalations tab is "Needs your attention" -- without a resolution
-- state every escalation stays on it forever. The mockup hardcoded
-- state:'open' because nothing here stored one.
alter table frontdesk_escalations
  add column status text not null default 'open' check (status in ('open','resolved')),
  add column resolved_at timestamptz;

create index on frontdesk_escalations (status, created_at desc);
