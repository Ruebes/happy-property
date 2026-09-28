-- Wochenbrief: Sonntagabend legt der Autopilot Sven einen Kalendertermin fuer
-- Montag 08:00 Zypern-Zeit an, mit dem Plan der Woche und zwei bis drei aktuell
-- diskutierten Aufhaengern samt Quelle.
--
-- Sonntag 17:10 UTC = 20:10 Zypern. Damit steht der Termin am Sonntagabend und
-- die Recherche ist frisch, wenn Sven ihn Montagfrueh liest. Das Secret wird zur
-- Laufzeit gelesen und steht so nicht im Klartext in cron.job.
select cron.schedule('social-weekly-brief', '10 17 * * 0', $cron$
  select net.http_post(
    url := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/social-agent',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from public.connector_secrets where key = 'CRON_SECRET_SOCIAL')
    ),
    body := '{"action":"weekly_brief"}'::jsonb,
    timeout_milliseconds := 5000
  );
$cron$);
