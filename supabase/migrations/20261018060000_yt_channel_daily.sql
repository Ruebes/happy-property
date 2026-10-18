-- Tägliche YouTube-Kanalzahlen (Abonnenten, Aufrufe, Videos), geschrieben von yt-snapshot (Cron).
create table if not exists public.yt_channel_daily (
  day date primary key,
  subscribers integer not null,
  views bigint,
  videos integer,
  created_at timestamptz not null default now()
);
alter table public.yt_channel_daily enable row level security;
create policy yt_channel_daily_read on public.yt_channel_daily for select to authenticated using (true);
