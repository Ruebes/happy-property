-- Rückbau zu 20261004100000_werbe_paritaet_r1.sql (von Hand ausführen; liegt im
-- Unterordner, damit die Supabase-CLI die Datei nicht als Migration einspielt).
--
-- Reihenfolge: VOR den Rückbauten von 20261003110000/20261003100000 ausführen.
--
-- Ablauf:
--   1. werbe_settings_guard() wieder auf die Fassung aus 20261003110000_werbe_autopilot.sql
--      setzen (ohne kundenliste_freigegeben), nur wenn die Funktion noch existiert.
--      Erst danach die Spalte entfernen, sonst bricht jedes Speichern der Einstellungen.
--   2. ad_settings.kundenliste_freigegeben entfernen (der Schalter ist danach weg;
--      meta-werkzeuge verweigert Kundenlisten dann wieder, weil die Spalte fehlt).
--   3. meta_report_cache entfernen (reiner Zwischenspeicher, keine Geschäftsdaten;
--      meta-berichte läuft ohne die Tabelle weiter, nur ohne Zwischenspeicher).

begin;

set local lock_timeout = '5s';

-- 1. Guard auf die Fassung aus 20261003110000 zurücksetzen
do $rueck$
begin
  if to_regprocedure('public.werbe_settings_guard()') is null then
    raise notice 'werbe_settings_guard() fehlt (20261003110000 schon zurückgebaut), nichts zurückzusetzen';
    return;
  end if;
  execute $ddl$
create or replace function public.werbe_settings_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_system  boolean := public.werbe_ist_system();
  v_admin   boolean := public.werbe_ist_admin();
  v_modi    constant text[] := array['aus', 'schatten', 'vorschlag', 'ein_klick', 'autonom'];
  v_hoch    text[] := '{}';
  v_vorher  jsonb;
  v_nachher jsonb;
begin
  -- Die Einstellungszeile heißt immer 'default' (alle Leser filtern darauf).
  if new.id is distinct from old.id then
    raise exception 'Die ID der Einstellungen ist nicht änderbar' using errcode = '42501';
  end if;

  if coalesce(array_position(v_modi, new.autopilot_mode), 0) > coalesce(array_position(v_modi, old.autopilot_mode), 0) then
    v_hoch := v_hoch || 'autopilot_mode'::text;
  end if;
  if (new.max_account_daily_budget is null and old.max_account_daily_budget is not null)
     or new.max_account_daily_budget > old.max_account_daily_budget then
    v_hoch := v_hoch || 'max_account_daily_budget'::text;
  end if;
  if (new.monthly_cap_eur is null and old.monthly_cap_eur is not null)
     or new.monthly_cap_eur > old.monthly_cap_eur then
    v_hoch := v_hoch || 'monthly_cap_eur'::text;
  end if;
  if (new.max_auto_actions_per_day is null and old.max_auto_actions_per_day is not null)
     or new.max_auto_actions_per_day > old.max_auto_actions_per_day then
    v_hoch := v_hoch || 'max_auto_actions_per_day'::text;
  end if;
  if coalesce(new.pool_auto_release_level, 0) > coalesce(old.pool_auto_release_level, 0) then
    v_hoch := v_hoch || 'pool_auto_release_level'::text;
  end if;
  if coalesce(new.builder_enabled, false) and not coalesce(old.builder_enabled, false) then
    v_hoch := v_hoch || 'builder_enabled'::text;
  end if;
  if coalesce(new.capi_echtzeit, false) and not coalesce(old.capi_echtzeit, false) then
    v_hoch := v_hoch || 'capi_echtzeit'::text;
  end if;
  if new.budget_autonomie_freigegeben_at is not null
     and new.budget_autonomie_freigegeben_at is distinct from old.budget_autonomie_freigegeben_at then
    v_hoch := v_hoch || 'budget_autonomie_freigegeben_at'::text;
  end if;
  if new.budget_autonomie_von is not null
     and new.budget_autonomie_von is distinct from old.budget_autonomie_von then
    v_hoch := v_hoch || 'budget_autonomie_von'::text;
  end if;
  -- Lockern zählt wie Hochstellen: höheres Kostenziel, niedrigere Freigabe-Schwelle,
  -- niedrigerer Kapitalbasis-Boden, mehr Änderungstage, laufende Pause verkürzen.
  if (new.target_cpte_eur is null and old.target_cpte_eur is not null)
     or new.target_cpte_eur > old.target_cpte_eur then
    v_hoch := v_hoch || 'target_cpte_eur'::text;
  end if;
  if (new.pool_auto_release_threshold is null and old.pool_auto_release_threshold is not null)
     or new.pool_auto_release_threshold < old.pool_auto_release_threshold then
    v_hoch := v_hoch || 'pool_auto_release_threshold'::text;
  end if;
  if (new.kap_floor is null and old.kap_floor is not null)
     or new.kap_floor < old.kap_floor then
    v_hoch := v_hoch || 'kap_floor'::text;
  end if;
  if (new.change_window_dows is null and old.change_window_dows is not null)
     or not coalesce(new.change_window_dows <@ old.change_window_dows, true) then
    v_hoch := v_hoch || 'change_window_dows'::text;
  end if;
  if old.autopilot_paused_until is not null and old.autopilot_paused_until > now()
     and (new.autopilot_paused_until is null or new.autopilot_paused_until < old.autopilot_paused_until) then
    v_hoch := v_hoch || 'autopilot_paused_until'::text;
  end if;
  -- Test-Code für CAPI setzen oder ändern nur Admin (Leeren darf jeder mit Recht werbung).
  if nullif(btrim(coalesce(new.capi_test_event_code, '')), '') is not null
     and new.capi_test_event_code is distinct from old.capi_test_event_code then
    v_hoch := v_hoch || 'capi_test_event_code'::text;
  end if;

  if coalesce(array_length(v_hoch, 1), 0) > 0 and not (v_system or v_admin) then
    raise exception 'Nur ein Admin darf das erhöhen oder einschalten: %', array_to_string(v_hoch, ', ')
      using errcode = '42501';
  end if;

  -- Wer hat die Budget-Autonomie freigegeben (Admin-Klick); Widerruf leert beides.
  if new.budget_autonomie_freigegeben_at is distinct from old.budget_autonomie_freigegeben_at then
    if new.budget_autonomie_freigegeben_at is null then
      new.budget_autonomie_von := null;
    elsif auth.uid() is not null then
      new.budget_autonomie_von := auth.uid();
    end if;
  end if;

  v_vorher  := public.werbe_jsonb_diff(to_jsonb(new), to_jsonb(old), array['updated_at']);
  v_nachher := public.werbe_jsonb_diff(to_jsonb(old), to_jsonb(new), array['updated_at']);
  if v_nachher <> '{}'::jsonb then
    insert into public.ad_autopilot_log (art, modus, entity_level, entity_id, before, after, evidence, ergebnis, akteur, akteur_art)
    values ('einstellung', new.autopilot_mode, 'einstellungen', new.id::text, v_vorher, v_nachher,
            jsonb_build_object('erhoeht', to_jsonb(v_hoch)),
            case when coalesce(array_length(v_hoch, 1), 0) > 0 then 'erhoeht' else 'geaendert' end,
            auth.uid(), case when v_system then 'system' else 'mensch' end);
  end if;

  return new;
end
$fn$
  $ddl$;
  revoke execute on function public.werbe_settings_guard() from public, anon, authenticated;
end
$rueck$;

-- 2. Spalte entfernen
alter table public.ad_settings drop column if exists kundenliste_freigegeben;

-- 3. Zwischenspeicher entfernen
drop table if exists public.meta_report_cache;

commit;
