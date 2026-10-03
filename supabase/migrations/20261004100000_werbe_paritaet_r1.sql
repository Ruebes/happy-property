-- Werbemanager Meta-Parität, Runde 1 (04.10.2026): Berichte-Zwischenspeicher und
-- Freigabe-Schalter für Kundenlisten-Zielgruppen.
--
-- Was diese Datei anlegt bzw. ändert (additiv, nichts wird gelöscht):
--   meta_report_cache            Zwischenspeicher der Edge Function meta-berichte
--                                (Insights mit Aufschlüsselungen, Aktivitäten, Status,
--                                Empfehlungen). key = sha256 der Anfrage, payload jsonb,
--                                fetched_at, ttl_s (1 h vergangene Zeiträume, 15 min wenn
--                                heute enthalten, 5 min Status). Reiner Zwischenspeicher:
--                                meta-berichte räumt Einträge älter als 2 Tage selbst weg.
--                                Lesen: Recht werbung oder werbung_meta. Schreiben nur
--                                Service-Role. Keine DELETE-Policy.
--   ad_settings + Spalte         kundenliste_freigegeben boolean default false: erst
--                                wenn true, legt meta-werkzeuge Kundenlisten-Zielgruppen
--                                an (gehashte CRM-Daten, DSGVO). Einschalten nur Admin.
--   werbe_settings_guard()       aktuelle Fassung aus 20261003110000_werbe_autopilot.sql,
--                                unverändert bis auf EINE neue Prüfung:
--                                kundenliste_freigegeben false -> true zählt als
--                                „Hochstellen“ (nur Admin oder System). Ausschalten darf
--                                jeder mit Recht werbung. Jede Änderung ins Autopilot-Log.
--
-- Voraussetzung: 20261003100000_werbung_fundament.sql und 20261003110000_werbe_autopilot.sql
-- sind eingespielt (ad_settings-Spalten, ad_autopilot_log, werbe_ist_*). Sonst bricht die
-- Datei am Anfang ab und ändert nichts.
-- Idempotent (mehrfach ausführbar). Als Ganzes in EINER Transaktion.
-- Rückbau: rollback/20261004100000_werbe_paritaet_r1.down.sql

begin;

set local lock_timeout = '5s';

-- ── 0. Voraussetzung prüfen ─────────────────────────────────────────────────
do $chk$
begin
  if to_regclass('public.ad_autopilot_log') is null
     or to_regprocedure('public.werbe_ist_admin()') is null
     or to_regprocedure('public.werbe_ist_system()') is null
     or to_regprocedure('public.werbe_jsonb_diff(jsonb, jsonb, text[])') is null
     or to_regprocedure('public.werbe_settings_guard()') is null then
    raise exception 'Zuerst 20261003100000_werbung_fundament.sql und 20261003110000_werbe_autopilot.sql einspielen';
  end if;
end
$chk$;

-- ── 1. Zwischenspeicher für meta-berichte ───────────────────────────────────

create table if not exists public.meta_report_cache (
  key        text primary key,
  payload    jsonb not null,
  fetched_at timestamptz not null default now(),
  ttl_s      integer not null default 3600 check (ttl_s between 0 and 604800)
);

create index if not exists meta_report_cache_fetched_idx
  on public.meta_report_cache (fetched_at);

comment on table public.meta_report_cache is
  'Zwischenspeicher der Edge Function meta-berichte (Meta-Insights mit Aufschlüsselungen, Aktivitäten, Status, Empfehlungen). key = Version + sha256 der normalisierten Anfrage; Schlüssel auslastung:act_<konto> = Drossel-Marke bei Meta-Auslastung über 75 %. Schreibt nur die Service-Role. Reiner Cache, darf jederzeit geleert werden.';
comment on column public.meta_report_cache.ttl_s is
  'Gültigkeit in Sekunden ab fetched_at: 3600 vergangene Zeiträume, 900 wenn heute enthalten, 300 Status/unvollständig. Ältere Einträge werden nur noch bei Meta-Drosselung (als veraltet markiert) ausgeliefert.';

alter table public.meta_report_cache enable row level security;

drop policy if exists meta_report_cache_lesen on public.meta_report_cache;
create policy meta_report_cache_lesen on public.meta_report_cache
  for select to authenticated
  using ((select public.current_user_has_perm('werbung'))
         or (select public.current_user_has_perm('werbung_meta')));

revoke all on table public.meta_report_cache from anon, authenticated;
grant select on table public.meta_report_cache to authenticated;
grant all on table public.meta_report_cache to service_role;

-- ── 2. ad_settings: Freigabe Kundenlisten ───────────────────────────────────

alter table public.ad_settings
  add column if not exists kundenliste_freigegeben boolean not null default false;

comment on column public.ad_settings.kundenliste_freigegeben is
  'Freigabe für Kundenlisten-Zielgruppen aus dem CRM (E-Mail/Telefon gehasht an Meta, DSGVO). Solange false, verweigert meta-werkzeuge audience_create_customer_list. Einschalten nur Admin (werbe_settings_guard), Ausschalten jeder mit Recht werbung.';

-- ── 3. werbe_settings_guard: + kundenliste_freigegeben ─────────────────────
-- Kopie der Fassung aus 20261003110000_werbe_autopilot.sql (5c); einzige Änderung:
-- der Block „Kundenlisten-Freigabe einschalten nur Admin“ nach capi_echtzeit.

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
  -- Kundenlisten-Freigabe (gehashte CRM-Daten an Meta) einschalten nur Admin.
  if coalesce(new.kundenliste_freigegeben, false) and not coalesce(old.kundenliste_freigegeben, false) then
    v_hoch := v_hoch || 'kundenliste_freigegeben'::text;
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
$fn$;

-- Trigger besteht aus 20261003110000 (before update on ad_settings); zur Sicherheit neu binden.
drop trigger if exists werbe_settings_guard on public.ad_settings;
create trigger werbe_settings_guard
  before update on public.ad_settings
  for each row execute function public.werbe_settings_guard();

revoke execute on function public.werbe_settings_guard() from public, anon, authenticated;

commit;
