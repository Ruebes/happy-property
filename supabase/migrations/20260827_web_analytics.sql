-- Web-Analytics (eigenes GA + Mouseflow): Besucher-Sessions, Events
-- (Pageviews, Klicks, Mausbewegung, Scrolltiefe), rrweb-Session-Replays und
-- Wochenreports. Ingest laeuft AUSSCHLIESSLICH ueber die Edge Function
-- wa-track (service role) — kein Public-Insert. Lesen: authentifizierte
-- CRM-Nutzer (wie funnel_sessions/funnel_events).

-- ── Sessions ─────────────────────────────────────────────────────────────────
create table if not exists web_sessions (
  id uuid primary key,
  visitor_id text not null,
  site text not null,                -- Hostname (happy-property.de, ...)
  entry_path text,
  referrer text,
  utm jsonb,
  device text, browser text, os text,
  screen_w int, screen_h int,
  lang text, tz text,
  user_agent text,
  lead_id uuid references leads(id) on delete set null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  duration_s int not null default 0,       -- aktive Sekunden (Tab sichtbar)
  pageviews int not null default 0,
  clicks int not null default 0,
  max_scroll_pct int not null default 0,
  has_replay boolean not null default false
);
create index if not exists idx_web_sessions_site_start on web_sessions(site, started_at desc);
create index if not exists idx_web_sessions_visitor on web_sessions(visitor_id);
create index if not exists idx_web_sessions_lead on web_sessions(lead_id) where lead_id is not null;

-- ── Events ───────────────────────────────────────────────────────────────────
create table if not exists web_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references web_sessions(id) on delete cascade,
  site text not null,
  type text not null,                -- pageview | click | move | scroll | custom
  path text,
  ts timestamptz not null default now(),
  x int, y int,                      -- Dokument-Koordinaten (px)
  vw int, vh int, dh int,            -- Viewport-Breite/-Hoehe, Dokument-Hoehe
  selector text, txt text,           -- Klickziel (CSS-Pfad, sichtbarer Text)
  meta jsonb
);
create index if not exists idx_web_events_session on web_events(session_id);
create index if not exists idx_web_events_site_ts on web_events(site, ts desc);
create index if not exists idx_web_events_heat on web_events(site, path, type, ts);

-- ── Replay-Chunks (rrweb) ────────────────────────────────────────────────────
create table if not exists web_replay_chunks (
  id bigint generated always as identity primary key,
  session_id uuid not null references web_sessions(id) on delete cascade,
  seq int not null,
  events jsonb not null,             -- Array von rrweb-Events
  created_at timestamptz not null default now()
);
create index if not exists idx_web_replay_session on web_replay_chunks(session_id, seq);

-- ── Wochenreports ────────────────────────────────────────────────────────────
create table if not exists web_reports (
  id uuid primary key default gen_random_uuid(),
  token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  week_start date not null,
  week_end date not null,
  html text not null,
  stats jsonb,
  sent_to text[],
  created_at timestamptz not null default now()
);
create index if not exists idx_web_reports_week on web_reports(week_start desc);

-- ── RLS: lesen fuer eingeloggte CRM-Nutzer, schreiben nur service role ───────
alter table web_sessions      enable row level security;
alter table web_events        enable row level security;
alter table web_replay_chunks enable row level security;
alter table web_reports       enable row level security;
drop policy if exists web_sessions_read on web_sessions;
drop policy if exists web_events_read on web_events;
drop policy if exists web_replay_read on web_replay_chunks;
drop policy if exists web_reports_read on web_reports;
create policy web_sessions_read on web_sessions      for select to authenticated using (true);
create policy web_events_read   on web_events        for select to authenticated using (true);
create policy web_replay_read   on web_replay_chunks for select to authenticated using (true);
create policy web_reports_read  on web_reports       for select to authenticated using (true);

-- ── Aggregations-RPCs fuer Dashboard + Wochenreport ──────────────────────────
-- p_site null = alle Sites.

create or replace function public.hp_wa_kpis(p_from timestamptz, p_to timestamptz, p_site text default null)
returns jsonb language sql stable as $$
with s as (
  select * from public.web_sessions
  where started_at >= p_from and started_at < p_to
    and (p_site is null or site = p_site)
)
select jsonb_build_object(
  'sessions',  (select count(*) from s),
  'visitors',  (select count(distinct visitor_id) from s),
  'pageviews', (select coalesce(sum(pageviews), 0) from s),
  'clicks',    (select coalesce(sum(clicks), 0) from s),
  'avg_duration_s', (select coalesce(round(avg(duration_s)), 0) from s where duration_s > 0),
  'bounce_pct', (select case when count(*) = 0 then 0
                 else round(100.0 * count(*) filter (where pageviews <= 1 and clicks = 0) / count(*)) end
                 from s),
  'avg_scroll_pct', (select coalesce(round(avg(max_scroll_pct)), 0) from s where pageviews > 0),
  'with_replay', (select count(*) from s where has_replay)
);
$$;

create or replace function public.hp_wa_daily(p_from timestamptz, p_to timestamptz, p_site text default null)
returns table(day date, sessions bigint, visitors bigint, pageviews bigint)
language sql stable as $$
  select (started_at at time zone 'Asia/Nicosia')::date as day,
         count(*) as sessions,
         count(distinct visitor_id) as visitors,
         coalesce(sum(pageviews), 0) as pageviews
  from public.web_sessions
  where started_at >= p_from and started_at < p_to
    and (p_site is null or site = p_site)
  group by 1 order by 1;
$$;

create or replace function public.hp_wa_pages(p_from timestamptz, p_to timestamptz, p_site text default null, p_limit int default 20)
returns table(site text, path text, views bigint, sessions bigint)
language sql stable as $$
  select e.site, e.path, count(*) as views, count(distinct e.session_id) as sessions
  from public.web_events e
  where e.type = 'pageview' and e.ts >= p_from and e.ts < p_to
    and (p_site is null or e.site = p_site)
  group by 1, 2 order by 3 desc limit p_limit;
$$;

create or replace function public.hp_wa_sources(p_from timestamptz, p_to timestamptz, p_site text default null)
returns table(source text, sessions bigint, visitors bigint)
language sql stable as $$
  select coalesce(
           nullif(utm->>'utm_source', ''),
           nullif(regexp_replace(coalesce(referrer, ''), '^https?://(www\.)?([^/]+).*$', '\2'), ''),
           'direkt') as source,
         count(*) as sessions, count(distinct visitor_id) as visitors
  from public.web_sessions
  where started_at >= p_from and started_at < p_to
    and (p_site is null or site = p_site)
  group by 1 order by 2 desc;
$$;

create or replace function public.hp_wa_devices(p_from timestamptz, p_to timestamptz, p_site text default null)
returns table(device text, browser text, sessions bigint)
language sql stable as $$
  select coalesce(device, 'Unbekannt'), coalesce(browser, 'Unbekannt'), count(*)
  from public.web_sessions
  where started_at >= p_from and started_at < p_to
    and (p_site is null or site = p_site)
  group by 1, 2 order by 3 desc;
$$;

create or replace function public.hp_wa_sites(p_from timestamptz, p_to timestamptz)
returns table(site text, sessions bigint)
language sql stable as $$
  select site, count(*) from public.web_sessions
  where started_at >= p_from and started_at < p_to
  group by 1 order by 2 desc;
$$;

-- Heatmap-Punkte: Klicks oder Bewegungs-Samples einer Seite.
create or replace function public.hp_wa_heatmap(
  p_site text, p_path text, p_type text,
  p_from timestamptz, p_to timestamptz,
  p_device text default null, p_limit int default 20000)
returns table(x int, y int, vw int, dh int)
language sql stable as $$
  select e.x, e.y, e.vw, e.dh
  from public.web_events e
  join public.web_sessions s on s.id = e.session_id
  where e.site = p_site and e.path = p_path and e.type = p_type
    and e.ts >= p_from and e.ts < p_to
    and e.x is not null and e.y is not null and e.vw > 0
    and (p_device is null or s.device = p_device)
  order by e.ts desc limit p_limit;
$$;

-- Scrolltiefe einer Seite: wie viel % der Besucher erreichen 25/50/75/100.
create or replace function public.hp_wa_scrolldepth(
  p_site text, p_path text, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable as $$
with m as (
  select session_id, max(coalesce((meta->>'pct')::int, 0)) as pct
  from public.web_events
  where site = p_site and path = p_path and type = 'scroll'
    and ts >= p_from and ts < p_to
  group by 1
)
select jsonb_build_object(
  'sessions', (select count(*) from m),
  'p25',  (select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where pct >= 25)  / count(*)) end from m),
  'p50',  (select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where pct >= 50)  / count(*)) end from m),
  'p75',  (select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where pct >= 75)  / count(*)) end from m),
  'p100', (select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where pct >= 90)  / count(*)) end from m)
);
$$;

do $$ begin
  perform 1;
  revoke all on function public.hp_wa_kpis(timestamptz, timestamptz, text) from public, anon;
  revoke all on function public.hp_wa_daily(timestamptz, timestamptz, text) from public, anon;
  revoke all on function public.hp_wa_pages(timestamptz, timestamptz, text, int) from public, anon;
  revoke all on function public.hp_wa_sources(timestamptz, timestamptz, text) from public, anon;
  revoke all on function public.hp_wa_devices(timestamptz, timestamptz, text) from public, anon;
  revoke all on function public.hp_wa_sites(timestamptz, timestamptz) from public, anon;
  revoke all on function public.hp_wa_heatmap(text, text, text, timestamptz, timestamptz, text, int) from public, anon;
  revoke all on function public.hp_wa_scrolldepth(text, text, timestamptz, timestamptz) from public, anon;
  grant execute on function public.hp_wa_kpis(timestamptz, timestamptz, text) to authenticated, service_role;
  grant execute on function public.hp_wa_daily(timestamptz, timestamptz, text) to authenticated, service_role;
  grant execute on function public.hp_wa_pages(timestamptz, timestamptz, text, int) to authenticated, service_role;
  grant execute on function public.hp_wa_sources(timestamptz, timestamptz, text) to authenticated, service_role;
  grant execute on function public.hp_wa_devices(timestamptz, timestamptz, text) to authenticated, service_role;
  grant execute on function public.hp_wa_sites(timestamptz, timestamptz) to authenticated, service_role;
  grant execute on function public.hp_wa_heatmap(text, text, text, timestamptz, timestamptz, text, int) to authenticated, service_role;
  grant execute on function public.hp_wa_scrolldepth(text, text, timestamptz, timestamptz) to authenticated, service_role;
end $$;

-- ── Aufraeumen: Replays 60 Tage, Move-Events 90 Tage, Sessions 13 Monate ─────
create or replace function public.hp_wa_purge()
returns void language sql as $$
  delete from public.web_replay_chunks where created_at < now() - interval '60 days';
  delete from public.web_events where type = 'move' and ts < now() - interval '90 days';
  delete from public.web_sessions where started_at < now() - interval '13 months';
$$;
revoke all on function public.hp_wa_purge() from public, anon, authenticated;

-- pg_cron: monatlich aufraeumen (Job-Anlage idempotent).
-- Der Wochenreport-Cron (wa-weekly-report, sonntags) wird separat per
-- cron.schedule mit net.http_post + Service-Role-Bearer angelegt (enthaelt
-- Secret, gehoert nicht in die Migration).
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'hp-wa-purge') then
      perform cron.schedule('hp-wa-purge', '30 2 1 * *', 'select public.hp_wa_purge()');
    end if;
  end if;
end $$;
