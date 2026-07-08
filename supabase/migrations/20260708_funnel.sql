-- Eigener Termin-Funnel (ersetzt Typeform + Calendly): Sessions + Schritt-Events
-- für Drop-off-Tracking. Kein Public-Zugriff — alles läuft über die funnel-api Edge.
create table if not exists funnel_sessions (
  id uuid primary key default gen_random_uuid(),
  utm jsonb,
  referrer text,
  user_agent text,
  lead_id uuid references leads(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create table if not exists funnel_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references funnel_sessions(id) on delete cascade,
  step int not null,
  question_key text not null,
  answer text,
  created_at timestamptz not null default now()
);
create index if not exists idx_funnel_events_session on funnel_events(session_id);
alter table funnel_sessions enable row level security;
alter table funnel_events enable row level security;
create policy funnel_sessions_read on funnel_sessions for select to authenticated using (true);
create policy funnel_events_read on funnel_events for select to authenticated using (true);
