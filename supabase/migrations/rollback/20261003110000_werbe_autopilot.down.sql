-- Rückbau zu 20261003110000_werbe_autopilot.sql (von Hand ausführen; liegt im
-- Unterordner, damit die Supabase-CLI die Datei nicht als Migration einspielt).
--
-- Reihenfolge Rückbau: 119000 -> 113000 -> 112000 -> 111000 -> 110000 (diese Datei),
-- danach erst die Rückbauten von SQL-A (20261003101000, 20261003100000).
-- Vorher das RUNBOOK oben in 20261003110000_werbe_autopilot.sql lesen.
--
-- Ablauf:
--   1. Prüfungen: Rückbauten 119000/112000/111000 gelaufen, keine Aktionen ohne
--      ad_id, kein Ausführer-Lauf aktiv (bestätigte Zeile mit claimed_at jünger
--      als 10 Minuten), sonst Abbruch ohne Änderung.
--   2. Autopilot stoppen (werbe_autopilot_stopp: Modus aus, Eintrag im Log) und
--      ALLE noch wartenden Autopilot-Zeilen (status 'bestätigt') ablehnen. Ohne
--      origin/freigabe/expires_at sähen sie sonst wie manuelle Zeilen aus und
--      würden von meta-ads-sync (v18 oder neu) sofort ausgeführt.
--   3. ad_autopilot_log (Audit) und ad_creative_pool (Svens/Gionas Entscheidungen
--      mit Gründen) werden NICHT gelöscht, sondern in
--      <name>_archiv_<JJJJMMTT_HHMMSS> umbenannt (Trigger und Schreib-Policies weg,
--      RLS bleibt an, Lesen wie vorher). Indizes und Sequenzen bekommen dasselbe
--      Suffix, damit ein erneutes Einspielen von 110000 frische Objekte anlegt.
--   4. RPCs, Guard-Trigger (inkl. werbe_settings_guard auf ad_settings), die übrigen
--      Autopilot-Tabellen (Regeln, Wertleiter, Qualität, Snapshots, Ablauf) und die
--      neuen ad_actions-Spalten entfernen. Offene Vorschläge (status NULL) werden
--      'abgelehnt', damit status wieder NOT NULL sein kann. Zeilen ohne ad_id
--      (Anzeigengruppen-Ebene) blockieren den Rückbau (nicht stillschweigend löschen).

begin;

set local lock_timeout = '5s';

do $chk$
declare
  v_n int;
begin
  if to_regclass('public.capi_outbox') is not null then
    raise exception 'Zuerst rollback/20261003112000_capi_outbox.down.sql ausführen';
  end if;
  if to_regprocedure('public.werbe_qualitaet_berechnen(date)') is not null then
    raise exception 'Zuerst rollback/20261003111000_werbe_qualitaet_funktionen.down.sql ausführen';
  end if;
  if exists (select 1 from pg_constraint
              where conrelid = 'public.ad_actions'::regclass
                and conname = 'ad_actions_action_check'
                and pg_get_constraintdef(oid) like '%budget_set%') then
    raise exception 'Zuerst rollback/20261003119000_ad_actions_aktionen.down.sql ausführen';
  end if;
  select count(*) into v_n from public.ad_actions where ad_id is null;
  if v_n > 0 then
    raise exception 'Es gibt % Aktionen ohne ad_id (Anzeigengruppen-Ebene). Erst klären, nicht löschen.', v_n;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'ad_actions' and column_name = 'claimed_at') then
    execute $q$select count(*) from public.ad_actions
                where status = 'bestätigt' and claimed_at > now() - interval '10 minutes'$q$
       into v_n;
    if v_n > 0 then
      raise exception 'Der Ausführer arbeitet gerade (% beanspruchte Aktionen). 10 Minuten warten, dann erneut ausführen.', v_n;
    end if;
  end if;
end
$chk$;

-- Autopilot stoppen und wartende Autopilot-Zeilen ablehnen (Guard-Trigger ist noch
-- aktiv; diese Sitzung zählt als System).
do $stopp$
begin
  if to_regprocedure('public.werbe_autopilot_stopp(text)') is not null then
    perform public.werbe_autopilot_stopp('Rückbau 20261003110000');
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'ad_actions' and column_name = 'origin') then
    execute $q$update public.ad_actions
                  set status = 'abgelehnt', freigabe = 'verworfen', result = 'Rückbau Autopilot'
                where origin = 'autopilot' and status = 'bestätigt'$q$;
  end if;
end
$stopp$;

-- RPCs
drop function if exists public.werbe_pool_entscheiden(uuid, text, text);
drop function if exists public.werbe_aktionen_claimen(uuid[]);
drop function if exists public.werbe_schatten_bewerten(bigint, text);
drop function if exists public.werbe_autopilot_stopp(text);
drop function if exists public.werbe_vorschlag_entscheiden(uuid, text, text);

-- Guard-Trigger
drop trigger if exists werbe_settings_guard on public.ad_settings;
drop trigger if exists werbe_actions_guard  on public.ad_actions;

-- Log und Vorrat archivieren statt löschen
do $archiv$
declare
  v_basis  text := '_archiv_' || to_char(clock_timestamp(), 'YYYYMMDD_HH24MISS');
  v_suffix text := v_basis;
  v_nr     int  := 1;
  v_tab    text;
  r        record;
begin
  while to_regclass('public.ad_autopilot_log' || v_suffix) is not null
     or to_regclass('public.ad_creative_pool' || v_suffix) is not null loop
    v_nr := v_nr + 1;
    v_suffix := v_basis || '_' || v_nr;
  end loop;
  foreach v_tab in array array['ad_autopilot_log', 'ad_creative_pool'] loop
    if to_regclass('public.' || v_tab) is null then
      continue;
    end if;
    for r in select t.tgname from pg_trigger t
              where t.tgrelid = ('public.' || v_tab)::regclass and not t.tgisinternal loop
      execute format('drop trigger %I on public.%I', r.tgname, v_tab);
    end loop;
    for r in select p.polname from pg_policy p
              where p.polrelid = ('public.' || v_tab)::regclass and p.polcmd <> 'r' loop
      execute format('drop policy %I on public.%I', r.polname, v_tab);
    end loop;
    for r in select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid
              where i.indrelid = ('public.' || v_tab)::regclass loop
      execute format('alter index public.%I rename to %I', r.relname, left(r.relname, 63 - length(v_suffix)) || v_suffix);
    end loop;
    for r in select s.relname from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S'
              where d.refobjid = ('public.' || v_tab)::regclass and d.classid = 'pg_class'::regclass
                and d.deptype in ('a', 'i') loop
      execute format('alter sequence public.%I rename to %I', r.relname, left(r.relname, 63 - length(v_suffix)) || v_suffix);
    end loop;
    execute format('alter table public.%I rename to %I', v_tab, v_tab || v_suffix);
    execute format('comment on table public.%I is %L', v_tab || v_suffix,
                   'Archiv aus Rückbau 20261003110000 (' || to_char(clock_timestamp(), 'DD.MM.YYYY HH24:MI') || '), nur lesen');
    raise notice 'Archiviert: public.% -> public.%', v_tab, v_tab || v_suffix;
  end loop;
end
$archiv$;

drop table   if exists public.ad_autopilot_runs;
drop table   if exists public.ad_autopilot_rules;    -- nimmt werbe_rules_guard mit
drop table   if exists public.ad_ev_weights;
drop table   if exists public.ad_quality_daily;
drop table   if exists public.ad_entity_snapshot;

drop function if exists public.werbe_pool_guard();
drop function if exists public.werbe_rules_guard();
drop function if exists public.werbe_settings_guard();
drop function if exists public.werbe_actions_guard();
drop function if exists public.werbe_log_append_only();

-- ad_actions zurück auf den Stand vor 110000
update public.ad_actions set status = 'abgelehnt', result = coalesce(result, 'Rückbau Autopilot') where status is null;

drop index if exists public.ad_actions_gruppe_idx;
drop index if exists public.ad_actions_vorschlag_idx;
drop index if exists public.ad_actions_queue_idx;
drop index if exists public.ad_actions_idem_uq;

alter table public.ad_actions drop constraint if exists ad_actions_target_chk;
alter table public.ad_actions drop constraint if exists ad_actions_freigabe_chk;
alter table public.ad_actions drop constraint if exists ad_actions_appr_chk;
alter table public.ad_actions drop constraint if exists ad_actions_level_chk;
alter table public.ad_actions drop constraint if exists ad_actions_origin_chk;

alter table public.ad_actions alter column ad_id  set not null;
alter table public.ad_actions alter column status set not null;

alter table public.ad_actions
  drop column if exists undo_of,
  drop column if exists claimed_at,
  drop column if exists pre_state_hash,
  drop column if exists idempotency_key,
  drop column if exists window_date,
  drop column if exists expires_at,
  drop column if exists approved_at,
  drop column if exists approved_by,
  drop column if exists freigabe,
  drop column if exists approval_level,
  drop column if exists evidence,
  drop column if exists rule_version,
  drop column if exists rule_key,
  drop column if exists readback,
  drop column if exists after,
  drop column if exists before,
  drop column if exists payload,
  drop column if exists gruppe_id,
  drop column if exists entity_id,
  drop column if exists entity_level,
  drop column if exists origin;

-- Hilfsfunktionen zuletzt (Policies der gelöschten Tabellen sind weg)
drop function if exists public.werbe_jsonb_diff(jsonb, jsonb, text[]);
drop function if exists public.werbe_ist_admin();
drop function if exists public.werbe_ist_system();
drop function if exists public.werbe_ist_service();
drop function if exists public.werbe_ist_db_sitzung();

notify pgrst, 'reload schema';

commit;
