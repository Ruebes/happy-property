-- Wachstums-Tracking Instagram + Facebook (Ziel: 5.000 Follower je Plattform in 12 Monaten).
-- Edge Function social-growth:
--   snapshot      täglich 03:30 UTC (vor dem Wochenbericht, damit die Mail frische Zahlen hat): Follower, Follows/Unfollows, Reichweite (organisch/bezahlt),
--                 Profilaufrufe, Link-Klicks je Tag + Kennzahlen je Post nach 24h/72h/7d/28d.
--   weekly_report montags 04:00 UTC (07:00 Zypern): kurze Mail an Sven.
--   status        für die Karte „Wachstum" im Social-Studio.
--
-- day = Meta-Tag (Pacific Time, so zählt Meta selbst). followers = Stand zum Snapshot
-- (für ältere, nachträglich geladene Tage aus den täglichen Follows/Unfollows
-- zurückgerechnet, dann raw.followers_estimated = true).

create table if not exists social_account_daily (
  day            date not null,
  platform       text not null check (platform in ('instagram', 'facebook')),
  followers      int,
  follows        int,
  unfollows      int,
  reach          int,
  reach_organic  int,
  reach_paid     int,
  profile_views  int,
  link_taps      int,
  raw            jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  primary key (day, platform)
);

-- post_ref = Instagram-Media-ID bzw. Facebook-Post-ID (PAGEID_POSTID).
-- social_post_id wird über social_posts.post_results (instagram.id / facebook.id) zugeordnet.
create table if not exists social_post_metrics (
  id                 uuid primary key default gen_random_uuid(),
  post_ref           text not null,
  platform           text not null check (platform in ('instagram', 'facebook')),
  social_post_id     uuid null references social_posts(id) on delete set null,
  published_at       timestamptz,
  media_type         text,
  snapshot           text not null check (snapshot in ('24h', '72h', '7d', '28d')),
  reach              int,
  views              int,
  avg_watch_time_ms  int,
  shares             int,
  saves              int,
  comments           int,
  likes              int,
  follows            int,
  profile_visits     int,
  raw                jsonb not null default '{}'::jsonb,
  taken_at           timestamptz not null default now(),
  unique (post_ref, snapshot)
);
create index if not exists social_post_metrics_published_idx on social_post_metrics (published_at desc);
create index if not exists social_post_metrics_post_idx on social_post_metrics (social_post_id);

-- Schreiben nur über die Edge Function (Service-Role). Lesen: Team im Studio.
alter table social_account_daily enable row level security;
drop policy if exists social_account_daily_staff_read on social_account_daily;
create policy social_account_daily_staff_read on social_account_daily
  for select to authenticated
  using (current_user_role() = any (array['admin', 'verwalter', 'mitarbeiter', 'funnel']));

alter table social_post_metrics enable row level security;
drop policy if exists social_post_metrics_staff_read on social_post_metrics;
create policy social_post_metrics_staff_read on social_post_metrics
  for select to authenticated
  using (current_user_role() = any (array['admin', 'verwalter', 'mitarbeiter', 'funnel']));

-- Crons: das Secret wird zur Laufzeit gelesen und steht so nicht im Klartext in cron.job.
select cron.schedule('social-growth-snapshot', '30 3 * * *', $cron$
  select net.http_post(
    url := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/social-growth',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from public.connector_secrets where key = 'CRON_SECRET_SOCIAL')
    ),
    body := '{"action":"snapshot"}'::jsonb
  )
$cron$);

select cron.schedule('social-growth-weekly', '0 4 * * 1', $cron$
  select net.http_post(
    url := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/social-growth',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from public.connector_secrets where key = 'CRON_SECRET_SOCIAL')
    ),
    body := '{"action":"weekly_report"}'::jsonb
  )
$cron$);
