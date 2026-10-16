-- Rückbau 20261016100000_google_ads_sync
select cron.unschedule('google-ads-sync-daily') where exists (select 1 from cron.job where jobname = 'google-ads-sync-daily');
alter table public.ad_insights_daily drop column if exists yt_subscribers;
