-- Rückbau zu 20261003110000_werbe_autopilot.sql (von Hand ausführen; liegt im
-- Unterordner, damit die Supabase-CLI die Datei nicht als Migration einspielt).
--
-- Reihenfolge Rückbau: 119000 -> 113000 -> 112000 -> 111000 -> 110000 (diese Datei),
-- danach erst die Rückbauten von SQL-A (20261003101000, 20261003100000).
--
-- Entfernt RPCs, Guard-Trigger (inkl. werbe_settings_guard auf ad_settings), die
-- Autopilot-Tabellen samt Inhalt (Log, Regeln, Wertleiter, Qualität, Snapshots,
-- Ablauf, Vorrat) und die neuen ad_actions-Spalten. Vorher bei Bedarf sichern:
--   copy (select * from public.ad_autopilot_log) to ... bzw. CSV-Export im Dashboard.
-- Offene Vorschläge (status NULL) werden auf 'abgelehnt' gesetzt, damit
-- status wieder NOT NULL sein kann. Zeilen ohne ad_id (Anzeigengruppen-Ebene)
-- blockieren den Rückbau (nicht stillschweigend löschen).

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
end
$chk$;

-- RPCs
drop function if exists public.werbe_pool_entscheiden(uuid, text, text);
drop function if exists public.werbe_aktionen_claimen(uuid[]);
drop function if exists public.werbe_schatten_bewerten(bigint, text);
drop function if exists public.werbe_autopilot_stopp(text);
drop function if exists public.werbe_vorschlag_entscheiden(uuid, text, text);

-- Guard-Trigger
drop trigger if exists werbe_settings_guard on public.ad_settings;
drop trigger if exists werbe_actions_guard  on public.ad_actions;
drop table   if exists public.ad_creative_pool;      -- nimmt werbe_pool_guard mit
drop table   if exists public.ad_autopilot_runs;
drop table   if exists public.ad_autopilot_log;      -- nimmt die Append-only-Trigger mit
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
update public.ad_actions set status = 'abgelehnt' where status is null;

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
