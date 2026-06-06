-- ── pg_cron: hp_archive_completed_deals() täglich ausführen ───────────────────
-- Reine SQL-Funktion → pg_cron ruft sie direkt auf (kein Edge-Function/pg_net nötig).
-- Separate Migration, weil CREATE EXTENSION erhöhte Rechte braucht; wird beim
-- Deploy ausgeführt. Idempotent: vorhandenen Job zuerst entfernen.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Alten Job (falls vorhanden) entfernen, dann täglich um 03:15 UTC neu planen.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hp-archive-completed-deals') THEN
    PERFORM cron.unschedule('hp-archive-completed-deals');
  END IF;
END $$;

SELECT cron.schedule(
  'hp-archive-completed-deals',
  '15 3 * * *',
  $$ SELECT hp_archive_completed_deals(); $$
);
