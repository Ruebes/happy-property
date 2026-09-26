-- Zypern-Report: monatlicher PDF-Lead-Magnet (Edge Function zypern-report).
-- Jede Ausgabe = eine Zeile je Monat. Das PDF liegt öffentlich im Bucket
-- web-reports unter zypern-report/YYYY-MM.pdf und zypern-report/aktuell.pdf.

create table if not exists public.zypern_reports (
  id           uuid primary key default gen_random_uuid(),
  month        text not null unique check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status       text not null default 'building' check (status in ('building', 'live', 'failed')),
  content      jsonb,
  pdf_url      text,
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  published_at timestamptz
);

alter table public.zypern_reports enable row level security;

-- Studio-Karte liest die letzte Ausgabe; schreiben darf nur die Edge Function (Service Role).
drop policy if exists zypern_reports_select_authenticated on public.zypern_reports;
create policy zypern_reports_select_authenticated on public.zypern_reports
  for select to authenticated using (true);

-- Klickzähler für den Report-Link aus den Keyword-DMs
-- (https://portal.happy-property.com/zypern-report?c=<ref>). Die Tabelle
-- social_keyword_replies gehört zum Keyword-Autoresponder; fehlt sie oder die
-- Zeile, passiert einfach nichts.
create or replace function public.zypern_report_click(p_ref text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_ref is null or p_ref !~ '^[A-Za-z0-9_-]{1,64}$' then
    return;
  end if;
  update public.social_keyword_replies
     set clicked_at  = coalesce(clicked_at, now()),
         click_count = coalesce(click_count, 0) + 1
   where ref = p_ref;
exception
  when undefined_table or undefined_column then
    null;
end;
$$;

revoke all on function public.zypern_report_click(text) from public, anon, authenticated;
grant execute on function public.zypern_report_click(text) to service_role;

-- Secret für Cron-Aufrufe (Header x-cron-secret). Wird nur angelegt, wenn es fehlt.
insert into public.connector_secrets (key, value, updated_at)
values ('CRON_SECRET_SOCIAL', replace(gen_random_uuid()::text, '-', ''), now())
on conflict (key) do nothing;

-- Monatlicher Bau am 1. um 04:00 UTC (07:00 bzw. 06:00 Zypern-Zeit), mit
-- Wiederholung am 2. und 3. (die Function überspringt eine schon live Ausgabe;
-- siehe 20260926130000_zypern_reports_retry.sql).
-- Das Secret wird bei jedem Lauf aus connector_secrets gelesen, steht also
-- nicht im Klartext im Cron-Job.
select cron.schedule(
  'zypern-report-monthly',
  '0 4 1-3 * *',
  $cmd$select net.http_post(
    url := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/zypern-report',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from public.connector_secrets where key = 'CRON_SECRET_SOCIAL')
    ),
    body := '{"action":"build"}'::jsonb,
    timeout_milliseconds := 5000
  )$cmd$
);
