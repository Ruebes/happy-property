-- Scan-Cron für yt-keywords: alle 10 Minuten (YouTube-Kontingent: ca. 3 Einheiten
-- je Lauf plus 1 je Video mit neuen Kommentaren, 50 je Antwort).
-- Das Secret wird zur Laufzeit gelesen und steht nicht im Klartext in cron.job.
select cron.schedule('yt-keywords-scan', '*/10 * * * *', $cron$
  select net.http_post(
    url := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/yt-keywords',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from connector_secrets where key = 'CRON_SECRET_SOCIAL')
    ),
    body := '{"action":"scan"}'::jsonb
  )
$cron$);
