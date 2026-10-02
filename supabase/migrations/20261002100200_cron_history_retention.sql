-- -----------------------------------------------------------------------------
-- pg_cron-Verlauf begrenzen: cron.job_run_details behält 7 Tage (Audit E6-6, P4-3)
--
-- Problem: pg_cron schreibt jeden Lauf (rund 2.300 pro Tag) nach cron.job_run_details,
-- nichts räumt dort auf. Stand 30.9.2026: rund 95.000 Zeilen seit 7.6., 53 MB (etwa 11 %
-- der Datenbank), nie gevacuumt. Kein Code und keine Funktion liest ältere Läufe: der
-- nächtliche Systemcheck schaut nur auf die letzten 24 Stunden.
--
-- Diese Migration plant zwei Jobs (Zeiten in UTC, cron.timezone = GMT; geprüft am 2.10.2026
-- gegen alle 40 bestehenden Jobs, kein Name und keine Minute doppelt):
--   hp-cron-history-purge   täglich 03:17   löscht Läufe, die älter als 7 Tage sind,
--                                           höchstens 10.000 Zeilen pro Lauf
--   hp-cron-history-vacuum  sonntags 03:37  einfaches VACUUM (nicht FULL) der Tabelle, weil
--                                           die Statistik die Schreibzugriffe von pg_cron
--                                           selbst nicht zählt und Autovacuum dort bisher
--                                           nie gelaufen ist (sonst würde der frei gewordene
--                                           Platz nicht wiederverwendet)
-- Die Obergrenze sorgt dafür, dass der Job nie selbst die große Erstlöschung macht: ohne
-- Handarbeit ist der Altbestand nach etwa 11 Tagen abgebaut.
--
-- Betroffen ist nur der Lauf-Verlauf von pg_cron, keine Kundendaten. Die Jobs selbst
-- (cron.job) und ihre Zeitpläne bleiben unverändert, cron.log_run bleibt an.
-- Ältere Einträge sind danach weg und lassen sich nicht zurückholen.
-- Idempotent: cron.schedule mit demselben Namen aktualisiert den vorhandenen Job.
--
-- Einmalige Altlast VON HAND abbauen (nicht geplant, zu einer ruhigen Stunde, jede Zeile
-- einzeln ausführen):
--   delete from cron.job_run_details
--    where runid in (select runid from cron.job_run_details
--                     where coalesce(end_time, start_time) < now() - interval '7 days'
--                     order by runid limit 10000);
--   wiederholen, bis 0 Zeilen gelöscht werden (heute etwa 8 bis 9 Durchläufe), danach einmal:
--   vacuum cron.job_run_details;
-- Kein VACUUM FULL: das sperrt die Tabelle, in die pg_cron bei jedem Lauf schreibt.
--
-- Rückweg: supabase/migrations/rollback/20261002100200_cron_history_retention.down.sql
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron nicht installiert, kein Job geplant';
    return;
  end if;

  perform cron.schedule(
    'hp-cron-history-purge',
    '17 3 * * *',
    $cmd$delete from cron.job_run_details where runid in (select runid from cron.job_run_details where coalesce(end_time, start_time) < now() - interval '7 days' order by runid limit 10000)$cmd$
  );

  perform cron.schedule(
    'hp-cron-history-vacuum',
    '37 3 * * 0',
    'vacuum cron.job_run_details'
  );
end $$;
