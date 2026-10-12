-- Cron fuer contact-cleanup (erst nach Svens Freigabe anwenden).
-- Täglich 06:00 UTC (09:00 Zypern).
select cron.schedule('contact-cleanup-daily', '0 6 * * *', $cron$
  select net.http_post(
    url := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/contact-cleanup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from public.connector_secrets where key = 'CRON_SECRET')),
    body := '{"dry": false}'::jsonb
  )
$cron$);
