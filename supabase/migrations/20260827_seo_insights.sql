-- SEO-Insights: Sichtbarkeit der Hauptseite fuer Google UND KI-Suchen
-- (ChatGPT, Claude, Perplexity & Co.).
--
-- Drei Datenquellen:
--   1. seo_bot_hits   — jeder Besuch eines Such-/KI-Crawlers auf der
--                       WordPress-Seite. Gemeldet vom Code-Snippet Nr. 8
--                       (steuervorteil-zypern-immobilien.com) an die Edge
--                       Function seo-insights. Nur Server sieht diese Bots.
--   2. seo_snapshots  — taeglicher Gesundheits-Schnappschuss: alle Sitemap-
--                       Seiten gecrawlt (Titel, Beschreibungen, FAQ-Markup,
--                       interne Links, Antwortzeiten) + GSC-Zahlen, sobald
--                       der Service-Account freigeschaltet ist.
--   3. web_sessions   — bestehendes Eigenbau-Analytics: organische Besuche
--                       nach Referrer (Google/Bing/ChatGPT/Perplexity).
--
-- Ingest AUSSCHLIESSLICH ueber die Edge Function (service role); Lesen fuer
-- eingeloggte CRM-Nutzer. Muster wie 20260827_web_analytics.sql.

-- ── Crawler-Besuche ──────────────────────────────────────────────────────────
create table if not exists seo_bot_hits (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  bot text not null,                 -- normalisiert: gptbot, claudebot, ...
  engine text not null,              -- google | bing | openai | anthropic | perplexity | apple | meta | other
  kind text not null default 'crawl',-- crawl (Index-Aufbau) | assist (Live-Abruf fuer eine Nutzerfrage)
  path text not null,
  status int,
  site text not null default 'steuervorteil-zypern-immobilien.com'
);
create index if not exists idx_seo_hits_ts on seo_bot_hits(ts desc);
create index if not exists idx_seo_hits_engine_ts on seo_bot_hits(engine, ts desc);
create index if not exists idx_seo_hits_path on seo_bot_hits(path, ts desc);

-- ── Taegliche Schnappschuesse ────────────────────────────────────────────────
create table if not exists seo_snapshots (
  id uuid primary key default gen_random_uuid(),
  day date not null unique,
  site text not null default 'steuervorteil-zypern-immobilien.com',
  metrics jsonb not null,            -- { pages, titles_over_60, desc_missing, faq_pages,
                                     --   faq_pairs, internal_links, alt_missing, old_tax_rate,
                                     --   ttfb_avg_ms, llms_txt, robots_ai_ok, ... }
  gsc jsonb,                         -- { status, clicks, impressions, ctr, position, top_queries[] }
  created_at timestamptz not null default now()
);
create index if not exists idx_seo_snapshots_day on seo_snapshots(day desc);

-- ── Wochenberichte ───────────────────────────────────────────────────────────
create table if not exists seo_reports (
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
create index if not exists idx_seo_reports_week on seo_reports(week_start desc);

-- ── RLS: lesen fuer eingeloggte CRM-Nutzer, schreiben nur service role ───────
alter table seo_bot_hits  enable row level security;
alter table seo_snapshots enable row level security;
alter table seo_reports   enable row level security;
drop policy if exists seo_bot_hits_read on seo_bot_hits;
create policy seo_bot_hits_read on seo_bot_hits for select to authenticated using (true);
drop policy if exists seo_snapshots_read on seo_snapshots;
create policy seo_snapshots_read on seo_snapshots for select to authenticated using (true);
drop policy if exists seo_reports_read on seo_reports;
create policy seo_reports_read on seo_reports for select to authenticated using (true);

-- ── Oeffentlicher Report-Abruf per Token (wie hp_wa_report_html) ─────────────
create or replace function public.hp_seo_report_html(p_token text)
returns text language sql stable security definer set search_path = public as $$
  select html from public.seo_reports where token = p_token;
$$;

-- ── Aufraeumen: Bot-Hits nach 12 Monaten loeschen ────────────────────────────
create or replace function public.hp_seo_purge() returns void
language sql security definer set search_path = public as $$
  delete from public.seo_bot_hits where ts < now() - interval '12 months';
$$;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'hp-seo-purge') then
      perform cron.schedule('hp-seo-purge', '40 2 1 * *', 'select public.hp_seo_purge()');
    end if;
  end if;
end $$;
-- Die Snapshot-/Report-Crons (net.http_post mit Service-Role-Bearer) werden
-- wie beim Web-Analytics separat angelegt — Secrets gehoeren nicht in die
-- Migration.
