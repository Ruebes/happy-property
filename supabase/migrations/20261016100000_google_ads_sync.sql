-- Google Ads (YouTube- und Google-Werbung) im Werbemanager, 16.10.2026.
-- google-ads-sync schreibt in ad_catalog / ad_insights_daily mit platform
-- 'youtube' bzw. 'google' (RLS über werbung bzw. werbung_<platform> besteht schon).

alter table public.ad_insights_daily
  add column if not exists yt_subscribers integer not null default 0;

comment on column public.ad_insights_daily.yt_subscribers is
  'Neue YouTube-Kanal-Abos am Tag, die Google Ads der Anzeige zuordnet (Conversion-Aktion „YouTube-Kanal-Abos"). Nur platform youtube.';

-- Täglicher Abgleich 04:41 UTC, nach meta-ads-sync (04:23). Den Aufruf samt
-- Service-Key vom Meta-Job übernehmen, damit kein Schlüssel im Repo steht.
do $$
declare
  v_cmd text;
begin
  select command into v_cmd from cron.job where jobname = 'meta-ads-sync-daily';
  if v_cmd is null then
    raise notice 'meta-ads-sync-daily fehlt, google-ads-sync-daily nicht angelegt';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'google-ads-sync-daily') then
    perform cron.unschedule('google-ads-sync-daily');
  end if;
  perform cron.schedule('google-ads-sync-daily', '41 4 * * *',
    replace(replace(v_cmd, 'functions/v1/meta-ads-sync', 'functions/v1/google-ads-sync'),
            ',"kette":true', ''));
end $$;
