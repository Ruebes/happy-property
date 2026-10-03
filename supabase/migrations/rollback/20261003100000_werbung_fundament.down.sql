-- Rückbau zu 20261003100000_werbung_fundament.sql (von Hand ausführen; liegt
-- bewusst im Unterordner rollback/, damit die Supabase-CLI die Datei nicht als
-- Migration einspielt). Als Ganzes in einer Transaktion ausführen.
--
-- REIHENFOLGE: vorher die Rückbauten der späteren Dateien ausführen, sonst
-- bricht diese Datei ab (Abhängigkeiten) oder Trigger laufen ins Leere:
--   1. rollback/20261003113000..., 20261003112000..., 20261003111000...,
--      20261003110000_werbe_autopilot.down.sql (entfernt werbe_settings_guard
--      und Tabellen, die auf meta_drafts zeigen könnten)
--   2. rollback/20261003102000_leads_meta_backfill.down.sql
--   3. rollback/20261003101000_leads_meta_zuordnung.down.sql
--   4. diese Datei
-- Vorher alle Edge Functions zurückstellen, die die neuen Tabellen/Spalten
-- schreiben (meta-builder, meta-ads-sync mit Spiegeln), sonst schlagen deren
-- Schreibzugriffe fehl.
--
-- ACHTUNG Datenverlust: Entwürfe (meta_drafts), Medien-Zeilen (meta_media),
-- das Meta-Schreibprotokoll (meta_write_log), die Spiegel meta_campaigns /
-- meta_adsets sowie die neuen Spalten in ad_catalog, ad_insights_daily und
-- ad_settings sind danach weg. Bei Bedarf vorher sichern, z. B.
--   create table public.meta_write_log_sicherung as select * from public.meta_write_log;
-- Die Dateien im Storage-Bucket ad-creatives bleiben unberührt.
-- Bei Meta angelegte Objekte bleiben unberührt (hier wird nie etwas bei Meta gelöscht).

begin;

set local lock_timeout = '5s';

-- ad_settings: neue Felder samt Prüfregeln und Fremdschlüssel
alter table public.ad_settings
  drop constraint if exists ad_settings_budget_autonomie_von_fkey,
  drop constraint if exists ad_settings_autopilot_mode_check,
  drop constraint if exists ad_settings_pool_auto_release_level_check,
  drop constraint if exists ad_settings_pool_auto_release_threshold_check,
  drop constraint if exists ad_settings_kap_floor_check,
  drop constraint if exists ad_settings_target_cpte_eur_check,
  drop constraint if exists ad_settings_monthly_cap_eur_check,
  drop constraint if exists ad_settings_max_auto_actions_per_day_check,
  drop constraint if exists ad_settings_change_window_dows_check;

alter table public.ad_settings
  drop column if exists builder_enabled,
  drop column if exists dsa_beneficiary,
  drop column if exists dsa_payor,
  drop column if exists default_page_id,
  drop column if exists default_ig_user_id,
  drop column if exists default_pixel_id,
  drop column if exists default_link,
  drop column if exists autopilot_mode,
  drop column if exists autopilot_paused_until,
  drop column if exists autopilot_stop_grund,
  drop column if exists target_cpte_eur,
  drop column if exists monthly_cap_eur,
  drop column if exists max_auto_actions_per_day,
  drop column if exists kap_floor,
  drop column if exists change_window_dows,
  drop column if exists utm_campaign_map,
  drop column if exists capi_echtzeit,
  drop column if exists capi_test_event_code,
  drop column if exists pool_auto_release_level,
  drop column if exists pool_auto_release_threshold,
  drop column if exists budget_autonomie_freigegeben_at,
  drop column if exists budget_autonomie_von;

-- ad_insights_daily: Index und neue Spalten
drop index if exists public.ad_insights_daily_adset_day_idx;

alter table public.ad_insights_daily
  drop column if exists campaign_id,
  drop column if exists adset_id,
  drop column if exists video_3s_true,
  drop column if exists thruplays,
  drop column if exists platform_schedules;

-- ad_catalog: neue Spalten
alter table public.ad_catalog
  drop column if exists effective_status,
  drop column if exists configured_status,
  drop column if exists issues_info,
  drop column if exists review_feedback,
  drop column if exists url_tags,
  drop column if exists created_time,
  drop column if exists updated_time,
  drop column if exists draft_id;

-- Neue Tabellen (Trigger, Policies und Indizes gehen mit). Ohne CASCADE: zeigt
-- noch etwas auf diese Tabellen, bricht der Rückbau ab statt still mitzulöschen.
drop table if exists public.meta_write_log;
drop table if exists public.meta_media;
drop table if exists public.meta_adsets;
drop table if exists public.meta_campaigns;
drop table if exists public.meta_drafts;

-- Trigger-Funktionen
drop function if exists public.meta_write_log_nur_anhaengen();
drop function if exists public.meta_media_touch();
drop function if exists public.meta_drafts_guard();

notify pgrst, 'reload schema';

commit;
