-- ─────────────────────────────────────────────────────────────────────────────
-- Werbemanager: Cron-Umstellung (SPEC.md §2 „werbe_crons“, PLAN-C Paket 5).
-- Stand 3.10.2026.
--
-- !!! NUR NACH SVENS „jetzt live“ EINSPIELEN (Paket 5) !!!
-- !!! Nicht mit den übrigen Migrationen dieses Pakets automatisch ausrollen. !!!
--
-- VORHER (Pflicht, nur lesend, im SQL-Editor):
--   select jobid, jobname, schedule, command from cron.job
--    where jobname in ('meta-ads-sync-daily', 'meta-leads-sync-15min', 'nightly-health',
--                      'werbe-nachholen', 'werbe-woche');
--   Die drei alten Befehle in die Platzhalter von
--   rollback/20261003113000_werbe_crons.down.sql kopieren, ABER NUR in der Kopie im
--   SQL-Editor, nie committen: meta-ads-sync-daily enthält den sb_secret-Key inline.
--   Danach: werbe-autopilot muss deployt sein (Aktionen nachholen und woche),
--   nightly-health im Repo-Stand mit Guard (authorizeCaller) direkt NACH dieser
--   Migration deployen (sonst Morgenmail 401), meta-leads-sync abgeglichen
--   (PLAN-C §1) deployen.
--
-- Was die Datei tut (Jobs per jobname gesucht, cron.alter_job, nichts gelöscht):
--   1. meta-ads-sync-daily: Zeitplan '0 4 * * *' -> '23 4 * * *' (weg von der vollen
--      Stunde, Startup-Timeouts am 1.10.), Body -> {"days":7,"kette":true}
--      (7 Tage nachziehen, danach werbe-autopilot {aktion:'nacht'} verketten).
--      Header (Authorization mit sb_secret) bleiben unverändert: meta-ads-sync prüft
--      weiter mit requireAdsAccess.
--   2. meta-leads-sync-15min und nightly-health: zusätzlicher Header x-cron-secret
--      (CRON_SECRET aus connector_secrets, zur Laufzeit gelesen, nie im Klartext in
--      cron.job). Die bestehenden Header (publishable Authorization fürs Gateway)
--      bleiben, der neue wird davor gesetzt: headers := jsonb_build_object(...) || <alt>.
--   3. Neue Jobs werbe-nachholen '50 4 * * *' ({aktion:'nachholen'}, holt nicht
--      gelaufene Schritte der Nachtkette nach) und werbe-woche '20 5 * * 1'
--      ({aktion:'woche'}, Montag: Kalibrierung, EMQ, Vorrat, Briefings).
--      werbe-autopilot läuft mit verify_jwt = false und gateCaller (cron).
--
-- Findet ein Schritt das erwartete Muster im alten Befehl nicht, ändert er nichts
-- und meldet NOTICE (dann Befehl von Hand anpassen). Idempotent.
-- Rückbau: rollback/20261003113000_werbe_crons.down.sql
-- ─────────────────────────────────────────────────────────────────────────────

begin;

do $cron$
declare
  v_id     bigint;
  v_cmd    text;
  v_neu    text;
  v_job    text;
  v_hdr    constant text := $h$headers := jsonb_build_object('x-cron-secret', (select value from public.connector_secrets where key = 'CRON_SECRET')) || $h$;
  v_body   constant text := $b$body := '{"days":7,"kette":true}'::jsonb$b$;
begin
  -- 1. meta-ads-sync-daily: Zeit + Body
  select j.jobid, j.command into v_id, v_cmd from cron.job j where j.jobname = 'meta-ads-sync-daily';
  if v_id is null then
    raise notice 'meta-ads-sync-daily nicht gefunden, übersprungen';
  else
    if v_cmd ~ '"kette"' then
      v_neu := null;   -- schon umgestellt
    elsif v_cmd ~ $re$body\s*:=\s*'[^']*'(\s*::\s*jsonb)?$re$ then
      v_neu := regexp_replace(v_cmd, $re$body\s*:=\s*'[^']*'(\s*::\s*jsonb)?$re$, v_body);
    elsif v_cmd !~ 'body\s*:=' and v_cmd ~ $re$url\s*:=\s*'[^']*'\s*,$re$ then
      v_neu := regexp_replace(v_cmd, $re$(url\s*:=\s*'[^']*'\s*,)$re$, '\1 ' || v_body || ',');
    else
      v_neu := null;
      raise notice 'meta-ads-sync-daily: Body nicht erkannt, nur Zeitplan geändert. Body von Hand auf {"days":7,"kette":true} setzen';
    end if;
    perform cron.alter_job(job_id := v_id, schedule := '23 4 * * *', command := v_neu);
    raise notice 'meta-ads-sync-daily: Zeitplan 23 4 * * *, Body %', case when v_neu is null then 'unverändert' else 'neu' end;
  end if;

  -- 2. x-cron-secret für meta-leads-sync-15min und nightly-health
  foreach v_job in array array['meta-leads-sync-15min', 'nightly-health'] loop
    v_id := null;
    v_cmd := null;
    select j.jobid, j.command into v_id, v_cmd from cron.job j where j.jobname = v_job;
    if v_id is null then
      raise notice '% nicht gefunden, übersprungen', v_job;
      continue;
    end if;
    if v_cmd ~ 'x-cron-secret' then
      raise notice '%: x-cron-secret schon gesetzt', v_job;
      continue;
    end if;
    if (select count(*) from regexp_matches(v_cmd, 'headers\s*:=', 'g')) <> 1 then
      raise notice '%: headers := nicht eindeutig gefunden, bitte von Hand anpassen', v_job;
      continue;
    end if;
    v_neu := regexp_replace(v_cmd, 'headers\s*:=\s*', v_hdr);
    perform cron.alter_job(job_id := v_id, command := v_neu);
    raise notice '%: x-cron-secret ergänzt', v_job;
  end loop;
end
$cron$;

-- 3. Neue Jobs (cron.schedule mit demselben Namen ersetzt einen vorhandenen Job).
select cron.schedule('werbe-nachholen', '50 4 * * *', $cmd$
  select net.http_post(
    url := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/werbe-autopilot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from public.connector_secrets where key = 'CRON_SECRET')
    ),
    body := '{"aktion":"nachholen"}'::jsonb,
    timeout_milliseconds := 60000
  );
$cmd$);

select cron.schedule('werbe-woche', '20 5 * * 1', $cmd$
  select net.http_post(
    url := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/werbe-autopilot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from public.connector_secrets where key = 'CRON_SECRET')
    ),
    body := '{"aktion":"woche"}'::jsonb,
    timeout_milliseconds := 60000
  );
$cmd$);

commit;

-- NACHHER prüfen:
--   select jobname, schedule, active, command from cron.job
--    where jobname in ('meta-ads-sync-daily', 'meta-leads-sync-15min', 'nightly-health',
--                      'werbe-nachholen', 'werbe-woche');
--   select jobid, status, return_message, start_time from cron.job_run_details
--    where jobid in (select jobid from cron.job where jobname like 'werbe-%' or jobname = 'meta-ads-sync-daily')
--    order by start_time desc limit 20;
