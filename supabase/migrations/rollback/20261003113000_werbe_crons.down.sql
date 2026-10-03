-- Rückbau zu 20261003113000_werbe_crons.sql (von Hand im SQL-Editor ausführen).
--
-- TODO VOR DEM EINSPIELEN VON 20261003113000 (Pflicht):
--   select jobname, schedule, command from cron.job
--    where jobname in ('meta-ads-sync-daily', 'meta-leads-sync-15min', 'nightly-health');
--   Die exakten alten Befehle unten statt null als $alt$<befehl>$alt$ einsetzen.
--   NUR in der Kopie im SQL-Editor bzw. in einer Datei außerhalb des Repos
--   aufbewahren, NIE mit Inhalt committen: meta-ads-sync-daily enthält den
--   sb_secret-Key inline.
--
-- Was der Rückbau tut:
--   1. meta-ads-sync-daily: Zeitplan zurück auf '0 4 * * *'. Befehl nur, wenn der
--      Platzhalter gefüllt ist (sonst bleibt Body {"days":7,"kette":true}, NOTICE).
--   2. meta-leads-sync-15min, nightly-health: Platzhalter gefüllt -> alter Befehl;
--      sonst wird genau der von 113000 eingefügte x-cron-secret-Teil wieder entfernt
--      (headers := <alter Ausdruck>). Achtung: nightly-health im Repo-Stand mit Guard
--      braucht den Header; vorher die alte Function-Version (v29) zurückdeployen.
--   3. werbe-nachholen und werbe-woche werden entfernt (cron.unschedule).
-- Reihenfolge Rückbau: 119000 -> 113000 -> 112000 -> 111000 -> 110000.

begin;

do $cron$
declare
  -- TODO: alte Befehle einsetzen (siehe oben), z. B. v_alt_meta_ads_sync text := $alt$select net.http_post(...)$alt$;
  v_alt_meta_ads_sync text := null;
  v_alt_leads_sync    text := null;
  v_alt_nightly       text := null;

  v_hdr   constant text := $h$headers := jsonb_build_object('x-cron-secret', (select value from public.connector_secrets where key = 'CRON_SECRET')) || $h$;
  v_jobs  text[];
  v_alts  text[];
  v_id    bigint;
  v_cmd   text;
  i       int;
begin
  -- 1. meta-ads-sync-daily
  select j.jobid into v_id from cron.job j where j.jobname = 'meta-ads-sync-daily';
  if v_id is null then
    raise notice 'meta-ads-sync-daily nicht gefunden';
  else
    perform cron.alter_job(job_id := v_id, schedule := '0 4 * * *', command := v_alt_meta_ads_sync);
    if v_alt_meta_ads_sync is null then
      raise notice 'meta-ads-sync-daily: nur Zeitplan zurück auf 0 4 * * *, Befehl unverändert (Platzhalter leer)';
    end if;
  end if;

  -- 2. Header-Jobs
  v_jobs := array['meta-leads-sync-15min', 'nightly-health'];
  v_alts := array[v_alt_leads_sync, v_alt_nightly];
  for i in 1..2 loop
    v_id := null;
    v_cmd := null;
    select j.jobid, j.command into v_id, v_cmd from cron.job j where j.jobname = v_jobs[i];
    if v_id is null then
      raise notice '% nicht gefunden', v_jobs[i];
    elsif v_alts[i] is not null then
      perform cron.alter_job(job_id := v_id, command := v_alts[i]);
      raise notice '%: alter Befehl wiederhergestellt', v_jobs[i];
    elsif position(v_hdr in v_cmd) > 0 then
      perform cron.alter_job(job_id := v_id, command := replace(v_cmd, v_hdr, 'headers := '));
      raise notice '%: x-cron-secret-Teil entfernt', v_jobs[i];
    else
      raise notice '%: eingefügter Header nicht gefunden, nichts geändert', v_jobs[i];
    end if;
  end loop;

  -- 3. Neue Jobs entfernen
  if exists (select 1 from cron.job where jobname = 'werbe-nachholen') then
    perform cron.unschedule('werbe-nachholen');
  end if;
  if exists (select 1 from cron.job where jobname = 'werbe-woche') then
    perform cron.unschedule('werbe-woche');
  end if;
end
$cron$;

commit;
