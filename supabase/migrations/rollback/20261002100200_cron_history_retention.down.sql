-- Rückweg zu 20261002100200_cron_history_retention.sql (Audit E6-6, P4-3), von Hand
-- ausführen. Liegt bewusst in rollback/, damit die Supabase-CLI die Datei nicht als
-- Migration einspielt.
-- Entfernt genau die beiden neuen Jobs hp-cron-history-purge und hp-cron-history-vacuum,
-- alle anderen Jobs bleiben. Danach wächst cron.job_run_details wieder wie vorher.
-- Schon gelöschte Verlaufszeilen kommen dadurch nicht zurück.

do $$
declare
  v_job text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return;
  end if;
  for v_job in
    select jobname from cron.job
     where jobname in ('hp-cron-history-purge', 'hp-cron-history-vacuum')
  loop
    perform cron.unschedule(v_job);
  end loop;
end $$;
