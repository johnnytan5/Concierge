-- Rate limiting for the hosted web demo (/api/call/start). One row per web
-- call, with who placed it. Raw IP on purpose (the owner wants to be able to
-- look up / block a specific abuser); rows older than 7 days are deleted by
-- the start route itself.
--
-- Deliberately NOT readable by anon: voice_sessions is public-read for the
-- dashboard, so the IP lives here instead. RLS on with no policies = only the
-- service-role key (server side) can touch it.
create table public.call_limits (
  session_id  text primary key references public.voice_sessions(id) on delete cascade,
  ip          text not null,
  client_id   text,
  fingerprint text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);

create index call_limits_ip_idx          on public.call_limits (ip, started_at desc);
create index call_limits_client_idx      on public.call_limits (client_id, started_at desc);
create index call_limits_fingerprint_idx on public.call_limits (fingerprint, started_at desc);

alter table public.call_limits enable row level security;
