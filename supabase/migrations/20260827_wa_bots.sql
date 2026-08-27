-- Bot-Erkennung fuer Web-Analytics (27.8.): Kaltakquise-Mails werden von
-- Mail-Sicherheits-Scannern (Outlook SafeLinks etc.) geoeffnet — echte Browser,
-- echte User-Agents, aber US-Rechenzentren. Befund: 153 von ~190 Sessions mit
-- Zeitzone America/* — 6 Klicks gesamt, 0 Conversions. Zielgruppe ist DACH;
-- US-/UTC-Zeitzonen werden als Bot markiert (gespeichert, aber aus allen
-- Auswertungen gefiltert). wa-track setzt das Flag beim Ingest.

alter table web_sessions add column if not exists is_bot boolean not null default false;
create index if not exists idx_web_sessions_bot on web_sessions(is_bot) where is_bot;

-- Backfill: bisherige Scanner-Sessions markieren.
update web_sessions set is_bot = true
where (tz like 'America/%' or tz like 'US/%' or tz = 'UTC') and not is_bot;

-- ── Alle Auswertungs-RPCs: Bots raus ────────────────────────────────────────
create or replace function public.hp_wa_kpis(p_from timestamptz, p_to timestamptz, p_site text default null)
returns jsonb language sql stable as $$
with s as (
  select * from public.web_sessions
  where started_at >= p_from and started_at < p_to
    and not is_bot
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
    and not is_bot
    and (p_site is null or site = p_site)
  group by 1 order by 1;
$$;

create or replace function public.hp_wa_pages(p_from timestamptz, p_to timestamptz, p_site text default null, p_limit int default 20)
returns table(site text, path text, views bigint, sessions bigint)
language sql stable as $$
  select e.site, e.path, count(*) as views, count(distinct e.session_id) as sessions
  from public.web_events e
  join public.web_sessions ws on ws.id = e.session_id and not ws.is_bot
  where e.type = 'pageview' and e.ts >= p_from and e.ts < p_to
    and (p_site is null or e.site = p_site)
  group by 1, 2 order by 3 desc limit p_limit;
$$;

create or replace function public.hp_wa_sources(p_from timestamptz, p_to timestamptz, p_site text default null)
returns table(source text, sessions bigint, visitors bigint)
language sql stable as $$
  select coalesce(
           nullif(utm->>'utm_source', ''),
           nullif(utm->>'src', ''),
           nullif(regexp_replace(coalesce(referrer, ''), '^https?://(www\.)?([^/]+).*$', '\2'), ''),
           'direkt') as source,
         count(*) as sessions, count(distinct visitor_id) as visitors
  from public.web_sessions
  where started_at >= p_from and started_at < p_to
    and not is_bot
    and (p_site is null or site = p_site)
  group by 1 order by 2 desc;
$$;

create or replace function public.hp_wa_devices(p_from timestamptz, p_to timestamptz, p_site text default null)
returns table(device text, browser text, sessions bigint)
language sql stable as $$
  select coalesce(device, 'Unbekannt'), coalesce(browser, 'Unbekannt'), count(*)
  from public.web_sessions
  where started_at >= p_from and started_at < p_to
    and not is_bot
    and (p_site is null or site = p_site)
  group by 1, 2 order by 3 desc;
$$;

create or replace function public.hp_wa_sites(p_from timestamptz, p_to timestamptz)
returns table(site text, sessions bigint)
language sql stable as $$
  select site, count(*) from public.web_sessions
  where started_at >= p_from and started_at < p_to and not is_bot
  group by 1 order by 2 desc;
$$;

create or replace function public.hp_wa_heatmap(
  p_site text, p_path text, p_type text,
  p_from timestamptz, p_to timestamptz,
  p_device text default null, p_limit int default 20000)
returns table(x int, y int, vw int, dh int)
language sql stable as $$
  select e.x, e.y, e.vw, e.dh
  from public.web_events e
  join public.web_sessions s on s.id = e.session_id and not s.is_bot
  where e.site = p_site and e.path = p_path and e.type = p_type
    and e.ts >= p_from and e.ts < p_to
    and e.x is not null and e.y is not null and e.vw > 0
    and (p_device is null or s.device = p_device)
  order by e.ts desc limit p_limit;
$$;

create or replace function public.hp_wa_scrolldepth(
  p_site text, p_path text, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable as $$
with m as (
  select e.session_id, max(coalesce((e.meta->>'pct')::int, 0)) as pct
  from public.web_events e
  join public.web_sessions ws on ws.id = e.session_id and not ws.is_bot
  where e.site = p_site and e.path = p_path and e.type = 'scroll'
    and e.ts >= p_from and e.ts < p_to
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

create or replace function public.hp_wa_segments(p_from timestamptz, p_to timestamptz, p_site text default null)
returns table(session_id uuid, segment text)
language sql stable as $$
with s as (
  select ws.id, ws.lead_id, ws.duration_s, ws.pageviews, ws.max_scroll_pct,
    exists(select 1 from public.web_events e where e.session_id = ws.id
           and e.type = 'c:booking_done') as booked,
    exists(select 1 from public.web_events e where e.session_id = ws.id
           and e.type = 'pageview' and e.path like '/termin%') as funnel_seen,
    exists(select 1 from public.web_events e where e.session_id = ws.id
           and e.type = 'pageview'
           and (e.path ~ '^/(deck|rechnung|strategie)/'
                or e.path ~* 'rechner|projekt|immobilie|expose|objekt')) as objekt_seen
  from public.web_sessions ws
  where ws.started_at >= p_from and ws.started_at < p_to
    and not ws.is_bot
    and (p_site is null or ws.site = p_site)
)
select id, case
  when booked then 'gebucht'
  when funnel_seen then 'funnel_abbruch'
  when objekt_seen and duration_s < 120 then 'expose_jaeger'
  when duration_s >= 60 and (pageviews >= 2 or max_scroll_pct >= 50) then 'interessent'
  when objekt_seen then 'interessent'
  when duration_s >= 20 or max_scroll_pct >= 25 then 'kurzbesucher'
  else 'absprung'
end
from s;
$$;
