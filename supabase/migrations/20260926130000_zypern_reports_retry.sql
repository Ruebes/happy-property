-- Zypern-Report: Wiederholung statt Einmal-Lauf.
-- Der Cron ruft am 1., 2. und 3. des Monats um 04:00 UTC auf. Die Function
-- zypern-report ist idempotent: eine schon live Ausgabe wird übersprungen, ein
-- gescheiterter oder hängender Bau (building länger als 15 Min.) neu gestartet.
-- Scheitert der letzte Versuch (3.) oder ein manueller Bau, legt die Function
-- EINE Aufgabe „📄 Zypern-Report konnte nicht erstellt werden" für den Admin an.
--
-- cron.schedule mit demselben Namen ersetzt den bestehenden Job. Das Secret wird
-- wie bisher bei jedem Lauf aus connector_secrets gelesen.
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
