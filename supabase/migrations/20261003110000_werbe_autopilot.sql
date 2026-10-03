-- ─────────────────────────────────────────────────────────────────────────────
-- Werbemanager Autopilot: Schema, Leitplanken (Guard-Trigger) und Freigabe-RPCs
-- (SPEC.md §2 „Owner SQL-B“, PLAN-B §1). Stand 3.10.2026.
--
-- Inhalt:
--   1. Hilfsfunktionen: wer ruft auf (DB-Sitzung, Service-Role, Admin), jsonb-Diff
--   2. ad_actions erweitert (Vorschläge mit status = NULL, origin, Ebene, payload,
--      before/after/readback, Regel, Freigabe, Ablauf, Idempotenz, Claim, Undo).
--      KEINE neuen CHECK-Werte für action/status: die kommen erst mit
--      20261003119000_ad_actions_aktionen.sql (nach Frontend + Executor live).
--      Der alte Executor (meta-ads-sync, .eq('status','bestätigt')) und die alte
--      Oberfläche ignorieren Zeilen mit status NULL.
--   3. Neue Tabellen: ad_entity_snapshot, ad_quality_daily, ad_ev_weights,
--      ad_autopilot_rules, ad_autopilot_log (nur anhängen), ad_autopilot_runs,
--      ad_creative_pool. RLS: Lesen mit Recht werbung oder werbung_meta; Schreiben
--      nur wo angegeben; nirgends eine DELETE-Policy.
--   4. Startwerte: Regeln (Stufe 1, max. Stufe je Regel) und Wertleiter v1 (aktiv).
--   5. Guard-Trigger: werbe_actions_guard, werbe_settings_guard (auf ad_settings,
--      Spalten aus 20261003100000_werbung_fundament.sql), werbe_rules_guard,
--      werbe_pool_guard, werbe_log_append_only.
--   6. RPCs: werbe_vorschlag_entscheiden, werbe_autopilot_stopp,
--      werbe_schatten_bewerten, werbe_aktionen_claimen (nur Service-Role),
--      werbe_pool_entscheiden.
--
-- Wer darf was (Svens Regeln, SPEC §3):
--   Hochstellen/Einschalten (Modus, Limits, Freigabestufen, Echtzeit-CAPI,
--   Builder, Budget-Autonomie, automatische Vorrats-Freigabe) nur Admin
--   (profiles.role = 'admin') oder System. Senken und Stoppen jeder mit Recht
--   werbung. Vorschläge freigeben: Admin oder Recht werbung (Sven und Giona).
--
-- Systemaufrufer: Service-Role (JWT-Rolle service_role, Edge Functions) oder eine
-- direkte DB-Sitzung ohne JWT (pg_cron, SQL-Editor, Migration). Erkannt über
-- request.jwt.claims, NICHT über current_user (in SECURITY-DEFINER-Funktionen ist
-- current_user immer der Eigentümer).
--
-- Voraussetzung: 20261003100000_werbung_fundament.sql ist eingespielt (Spalten in
-- ad_settings). Sonst bricht die Datei am Anfang ab und ändert nichts.
-- Additiv, idempotent (mehrfach ausführbar). Als Ganzes in EINER Transaktion.
-- Rückbau: rollback/20261003110000_werbe_autopilot.down.sql
-- ─────────────────────────────────────────────────────────────────────────────

begin;

set local lock_timeout = '5s';

-- ── 0. Voraussetzung prüfen ─────────────────────────────────────────────────
do $chk$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ad_settings' and column_name = 'autopilot_mode'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ad_settings' and column_name = 'budget_autonomie_freigegeben_at'
  ) then
    raise exception 'Zuerst 20261003100000_werbung_fundament.sql einspielen (ad_settings.autopilot_mode fehlt)';
  end if;
end
$chk$;

-- ── 1. Hilfsfunktionen ──────────────────────────────────────────────────────

-- Direkte DB-Sitzung ohne JWT (pg_cron, SQL-Editor, Migration über Management-API).
create or replace function public.werbe_ist_db_sitzung()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select nullif(current_setting('request.jwt.claims', true), '') is null
     and nullif(current_setting('request.jwt.claim.role', true), '') is null
$$;

-- Aufruf mit Service-Role-Key (Edge Functions).
create or replace function public.werbe_ist_service()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
           nullif(current_setting('request.jwt.claim.role', true), ''),
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
           ''
         ) = 'service_role'
$$;

-- System = Service-Role oder direkte DB-Sitzung.
create or replace function public.werbe_ist_system()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select public.werbe_ist_db_sitzung() or public.werbe_ist_service()
$$;

-- Admin = profiles.role 'admin' und nicht deaktiviert (wie adsAuth/callerAuth).
create or replace function public.werbe_ist_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and coalesce(p.is_active, true)
  )
$$;

-- Schlüssel aus p_neu, deren Wert sich gegenüber p_alt unterscheidet (für Logs).
create or replace function public.werbe_jsonb_diff(p_alt jsonb, p_neu jsonb, p_ohne text[] default '{}')
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb)
  from jsonb_each(coalesce(p_neu, '{}'::jsonb)) n
  where not (n.key = any (coalesce(p_ohne, '{}'::text[])))
    and (coalesce(p_alt, '{}'::jsonb) -> n.key) is distinct from n.value
$$;

-- ── 2. ad_actions erweitern ─────────────────────────────────────────────────
alter table public.ad_actions
  add column if not exists origin          text not null default 'manuell',
  add column if not exists entity_level    text not null default 'ad',
  add column if not exists entity_id       text,
  add column if not exists gruppe_id       uuid,
  add column if not exists payload         jsonb not null default '{}'::jsonb,
  add column if not exists before          jsonb,
  add column if not exists after           jsonb,
  add column if not exists readback        jsonb,
  add column if not exists rule_key        text,
  add column if not exists rule_version    int,
  add column if not exists evidence        jsonb,
  add column if not exists approval_level  smallint,
  add column if not exists freigabe        text,
  add column if not exists approved_by     uuid references public.profiles(id) on delete set null,
  add column if not exists approved_at     timestamptz,
  add column if not exists expires_at      timestamptz,
  add column if not exists window_date     date,
  add column if not exists idempotency_key text,
  add column if not exists pre_state_hash  text,
  add column if not exists claimed_at      timestamptz,
  add column if not exists undo_of         uuid references public.ad_actions(id) on delete set null;

alter table public.ad_actions drop constraint if exists ad_actions_origin_chk;
alter table public.ad_actions add constraint ad_actions_origin_chk
  check (origin in ('manuell', 'autopilot'));
alter table public.ad_actions drop constraint if exists ad_actions_level_chk;
alter table public.ad_actions add constraint ad_actions_level_chk
  check (entity_level in ('ad', 'adset', 'campaign'));
alter table public.ad_actions drop constraint if exists ad_actions_appr_chk;
alter table public.ad_actions add constraint ad_actions_appr_chk
  check (approval_level between 0 and 3);
alter table public.ad_actions drop constraint if exists ad_actions_freigabe_chk;
alter table public.ad_actions add constraint ad_actions_freigabe_chk
  check (freigabe in ('vorgeschlagen', 'freigegeben', 'autonom', 'verworfen', 'abgelaufen', 'veraltet'));

-- Vorschläge: status NULL (Default 'bestätigt' bleibt, manuelles Vormerken unverändert).
alter table public.ad_actions alter column status drop not null;
-- Budget-Zeilen auf Anzeigengruppen-Ebene haben keine ad_id.
alter table public.ad_actions alter column ad_id drop not null;

update public.ad_actions set entity_id = ad_id where entity_id is null and ad_id is not null;

alter table public.ad_actions drop constraint if exists ad_actions_target_chk;
alter table public.ad_actions add constraint ad_actions_target_chk
  check (coalesce(ad_id, entity_id) is not null);

create unique index if not exists ad_actions_idem_uq
  on public.ad_actions (idempotency_key) where idempotency_key is not null;
create index if not exists ad_actions_queue_idx
  on public.ad_actions (created_at) where status = 'bestätigt';
create index if not exists ad_actions_vorschlag_idx
  on public.ad_actions (expires_at) where freigabe = 'vorgeschlagen';
create index if not exists ad_actions_gruppe_idx
  on public.ad_actions (gruppe_id) where gruppe_id is not null;

-- ── 3. Neue Tabellen ────────────────────────────────────────────────────────

-- Tagesstand je Kampagne/Anzeigengruppe/Anzeige (meta-ads-sync Schritt 1c, nur lesend bei Meta).
create table if not exists public.ad_entity_snapshot (
  snap_date               date not null,
  entity_level            text not null check (entity_level in ('campaign', 'adset', 'ad')),
  entity_id               text not null,
  parent_id               text,
  campaign_id             text,
  name                    text,
  status                  text,
  effective_status        text,
  daily_budget_cents      int,
  lifetime_budget_cents   int,
  spend_cap_cents         bigint,
  optimization_goal       text,
  promoted_object         jsonb,
  special_ad_categories   text[],
  learning_stage_info     jsonb,
  issues_info             jsonb,
  ad_review_feedback      jsonb,
  creative_id             text,
  updated_time            timestamptz,
  reach_7d                int,
  impressions_7d          int,
  frequency_7d            numeric,
  video_3s_7d             int,
  link_clicks_7d          int,
  spend_7d_usd            numeric,
  quality_ranking         text,
  engagement_rate_ranking text,
  conversion_rate_ranking text,
  usd_per_eur             numeric,
  synced_at               timestamptz not null default now(),
  primary key (snap_date, entity_level, entity_id)
);
create index if not exists ad_entity_snapshot_entity_idx
  on public.ad_entity_snapshot (entity_level, entity_id, snap_date desc);

-- Qualität je Entität und Fenster (werbe_qualitaet_berechnen, täglich).
-- fenster 0 = Lebenszeit (höchstens 365 Tage). Kennung-ID = campaign_id || ':' || Basisname.
create table if not exists public.ad_quality_daily (
  stichtag              date not null,
  fenster               smallint not null check (fenster in (0, 7, 14, 30, 60)),
  entity_level          text not null check (entity_level in ('ad', 'kennung', 'adset', 'campaign', 'account')),
  entity_id             text not null,
  parent_id             text,
  campaign_id           text,
  name                  text,
  spend_eur             numeric not null default 0,
  impressions           bigint,
  link_clicks           bigint,
  lpv                   bigint,
  meta_schedules        int,
  leads                 int,
  leads_kap_ja          int,
  leads_mit_anzeige     int,
  booked                int,
  booked_kap_ja         int,
  held                  int,
  no_show               int,
  rated_gut             int,
  rated_schlecht        int,
  sales                 int,
  te_capped             numeric,
  te_full               numeric,
  prior_cpte            numeric,
  alpha                 numeric,
  beta                  numeric,
  cpte_hat              numeric,
  p_bad                 numeric,
  p_good                numeric,
  kap_ja_share_booked   numeric,
  attribution_coverage  numeric,
  ev_version            int,
  berechnet_at          timestamptz not null default now(),
  primary key (stichtag, fenster, entity_level, entity_id)
);
create index if not exists ad_quality_daily_entity_idx
  on public.ad_quality_daily (entity_level, entity_id, stichtag desc);

-- Wertleiter (Termin-Äquivalente), versioniert. Genau eine Version aktiv.
create table if not exists public.ad_ev_weights (
  version          int generated always as identity primary key,
  status           text not null default 'vorschlag' check (status in ('aktiv', 'vorschlag', 'archiv')),
  weights          jsonb not null,
  ev_ref_eur       numeric,
  te_cap_per_lead  numeric not null default 6,
  quelle           text not null check (quelle in ('start', 'kalibrierung', 'manuell')),
  kalibrierung     jsonb,
  gueltig_ab       timestamptz,
  aktiviert_von    uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);
create unique index if not exists ad_ev_weights_aktiv_uq
  on public.ad_ev_weights ((true)) where status = 'aktiv';

-- Regeln mit Freigabestufe (0 aus, 1 Vorschlag, 2 Ein-Klick, 3 autonom).
create table if not exists public.ad_autopilot_rules (
  rule_key        text primary key,
  titel           text not null,
  aktion          text not null check (aktion in ('pause', 'activate', 'budget_set', 'ersatz_hochladen', 'ersatz_aktivieren', 'meldung')),
  enabled         boolean not null default true,
  approval_level  smallint not null default 1,
  max_level       smallint not null default 1,
  freigabe_rolle  text not null default 'werbung' check (freigabe_rolle in ('admin', 'werbung')),
  params          jsonb not null default '{}'::jsonb,
  version         int not null default 1,
  updated_by      uuid,
  updated_at      timestamptz not null default now(),
  constraint ad_autopilot_rules_level_chk
    check (approval_level between 0 and 3 and max_level between 0 and 3 and approval_level <= max_level)
);

-- Audit-Log, nur anhängen (Trigger werbe_log_append_only).
create table if not exists public.ad_autopilot_log (
  id               bigint generated always as identity primary key,
  ts               timestamptz not null default now(),
  lauf_id          uuid,
  art              text not null check (art in ('schatten', 'vorschlag', 'freigabe', 'ablehnung', 'ausfuehrung', 'ruecklesen', 'stopp',
                                                'einstellung', 'regel_aenderung', 'kalibrierung', 'vorrat', 'manuell_erkannt',
                                                'bewertung', 'fehler', 'replay')),
  rule_key         text,
  rule_version     int,
  modus            text,
  approval_level   smallint,
  entity_level     text,
  entity_id        text,
  entity_name      text,
  aktion           text,
  before           jsonb,
  after            jsonb,
  evidence         jsonb,
  readback         jsonb,
  meta_response    jsonb,
  ergebnis         text,
  action_id        uuid references public.ad_actions(id),
  gruppe_id        uuid,
  bezug_log_id     bigint,
  undo_of          uuid,
  idempotency_key  text,
  akteur           uuid,
  akteur_art       text not null default 'system' check (akteur_art in ('system', 'mensch'))
);
create index if not exists ad_autopilot_log_ts_idx     on public.ad_autopilot_log (ts desc);
create index if not exists ad_autopilot_log_art_idx    on public.ad_autopilot_log (art, ts desc);
create index if not exists ad_autopilot_log_action_idx on public.ad_autopilot_log (action_id) where action_id is not null;
create index if not exists ad_autopilot_log_gruppe_idx on public.ad_autopilot_log (gruppe_id) where gruppe_id is not null;
create index if not exists ad_autopilot_log_bezug_idx  on public.ad_autopilot_log (bezug_log_id) where bezug_log_id is not null;

-- Ablauf-Ledger der Nachtkette (ein Eintrag je Tag und Schritt).
create table if not exists public.ad_autopilot_runs (
  id           uuid primary key default gen_random_uuid(),
  lauf_datum   date not null,
  schritt      text not null check (schritt in ('sync', 'qualitaet', 'regeln', 'fenster', 'kalibrieren', 'woche')),
  status       text not null check (status in ('laeuft', 'fertig', 'fehler', 'uebersprungen')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  summary      jsonb,
  fehler       text,
  unique (lauf_datum, schritt)
);

-- Werbemittel-Vorrat. kennung = ASCII-Slug = Anzeigenname ohne _lang/_kurz.
create table if not exists public.ad_creative_pool (
  id                  uuid primary key default gen_random_uuid(),
  kennung             text not null unique,
  status              text not null default 'entwurf' check (status in ('entwurf', 'geprueft', 'freigegeben', 'hochgeladen', 'aktiv',
                                                                         'ermuedet', 'gekillt', 'pausiert', 'verworfen')),
  winkel              text,
  hook_typ            text,
  format              text check (format in ('bild', 'video', 'karussell')),
  visual_typ          text,
  cta                 text default 'BOOK_NOW',
  lp_url              text,
  laender             text[] default '{DE}',
  texte               jsonb not null default '{}'::jsonb,
  asset_feed_url      text,
  asset_story_url     text,
  video_feed_id       text,
  video_story_id      text,
  ki_generiert        boolean not null default false,
  ki_label            boolean not null default false,
  eu_band             boolean not null default false,
  fakten_pruefung     boolean not null default false,
  qa                  jsonb,
  review_score        int,
  housing_ok          boolean,
  brief               jsonb,
  quelle              text,
  kosten_credits      numeric,
  entscheidung        text check (entscheidung in ('freigegeben', 'abgelehnt')),
  entscheidung_grund  text,
  entschieden_von     uuid references public.profiles(id) on delete set null,
  entschieden_at      timestamptz,
  prognose            numeric,
  merkmale            jsonb,
  released_by         uuid references public.profiles(id) on delete set null,
  released_at         timestamptz,
  ziel_adset_ids      text[],
  meta_image_hashes   jsonb,
  meta_creative_id    text,
  meta_ad_ids         jsonb,
  hochgeladen_at      timestamptz,
  aktiv_seit          timestamptz,
  beendet_at          timestamptz,
  ersetzt_kennung     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists ad_creative_pool_status_idx on public.ad_creative_pool (status);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.ad_entity_snapshot  enable row level security;
alter table public.ad_quality_daily    enable row level security;
alter table public.ad_ev_weights       enable row level security;
alter table public.ad_autopilot_rules  enable row level security;
alter table public.ad_autopilot_log    enable row level security;
alter table public.ad_autopilot_runs   enable row level security;
alter table public.ad_creative_pool    enable row level security;

drop policy if exists ad_entity_snapshot_lesen on public.ad_entity_snapshot;
create policy ad_entity_snapshot_lesen on public.ad_entity_snapshot for select to authenticated
  using (public.current_user_has_perm('werbung') or public.current_user_has_perm('werbung_meta'));

drop policy if exists ad_quality_daily_lesen on public.ad_quality_daily;
create policy ad_quality_daily_lesen on public.ad_quality_daily for select to authenticated
  using (public.current_user_has_perm('werbung') or public.current_user_has_perm('werbung_meta'));

drop policy if exists ad_ev_weights_lesen on public.ad_ev_weights;
create policy ad_ev_weights_lesen on public.ad_ev_weights for select to authenticated
  using (public.current_user_has_perm('werbung') or public.current_user_has_perm('werbung_meta'));

drop policy if exists ad_autopilot_rules_lesen on public.ad_autopilot_rules;
create policy ad_autopilot_rules_lesen on public.ad_autopilot_rules for select to authenticated
  using (public.current_user_has_perm('werbung') or public.current_user_has_perm('werbung_meta'));
drop policy if exists ad_autopilot_rules_admin_update on public.ad_autopilot_rules;
create policy ad_autopilot_rules_admin_update on public.ad_autopilot_rules for update to authenticated
  using (public.werbe_ist_admin())
  with check (public.werbe_ist_admin());

drop policy if exists ad_autopilot_log_lesen on public.ad_autopilot_log;
create policy ad_autopilot_log_lesen on public.ad_autopilot_log for select to authenticated
  using (public.current_user_has_perm('werbung') or public.current_user_has_perm('werbung_meta'));

drop policy if exists ad_autopilot_runs_lesen on public.ad_autopilot_runs;
create policy ad_autopilot_runs_lesen on public.ad_autopilot_runs for select to authenticated
  using (public.current_user_has_perm('werbung') or public.current_user_has_perm('werbung_meta'));

drop policy if exists ad_creative_pool_lesen on public.ad_creative_pool;
create policy ad_creative_pool_lesen on public.ad_creative_pool for select to authenticated
  using (public.current_user_has_perm('werbung') or public.current_user_has_perm('werbung_meta'));
drop policy if exists ad_creative_pool_anlegen on public.ad_creative_pool;
create policy ad_creative_pool_anlegen on public.ad_creative_pool for insert to authenticated
  with check (public.current_user_has_perm('werbung'));
drop policy if exists ad_creative_pool_aendern on public.ad_creative_pool;
create policy ad_creative_pool_aendern on public.ad_creative_pool for update to authenticated
  using (public.current_user_has_perm('werbung'))
  with check (public.current_user_has_perm('werbung'));

-- ── 4. Startwerte ───────────────────────────────────────────────────────────

-- Wertleiter v1 (SPEC §3, 05-automation-design §2.2). ev_ref_eur bleibt leer, bis
-- es genug Sales mit Provision gibt (werbe_ev_kalibrieren).
insert into public.ad_ev_weights (version, status, weights, ev_ref_eur, te_cap_per_lead, quelle, gueltig_ab)
overriding system value
values (
  1, 'aktiv',
  '{"lead_kap_nein":0.05,"lead_kap_ja":0.20,"lead_ohne":0.08,"alt_faktor":0.25,"gebucht":0.8,"gebucht_kap_ja":1.2,"no_show":0.3,"gehalten":1.6,"schlecht_mit_termin":0.2,"schlecht_ohne_termin":0.02,"gut":4.0,"te_cap":6}'::jsonb,
  null, 6, 'start', now()
)
on conflict (version) do nothing;
select setval(pg_get_serial_sequence('public.ad_ev_weights', 'version'),
              greatest((select max(version) from public.ad_ev_weights), 1));

-- Regeln: alle starten auf Stufe 1. max_level: Pausieren/Rotation/Budget 3 (Budget-L3
-- zusätzlich nur mit ad_settings.budget_autonomie_freigegeben_at), Upload 2,
-- Meldungen und Gruppe pausieren (D2) 1. on conflict do nothing: spätere
-- Änderungen von Sven bleiben beim erneuten Einspielen erhalten.
insert into public.ad_autopilot_rules (rule_key, titel, aktion, enabled, approval_level, max_level, freigabe_rolle, params) values
  ('SCHUTZ',      'Lernschutz, Änderungsfenster und Sperren (gilt für alle Regeln)', 'meldung', true, 1, 1, 'werbung',
   '{"learning_protect_hours":72,"min_days_between_sig_edits":3,"neue_anzeigen_ab_kampagnentag":8,"max_new_ads_per_window":2,"manuell_sperre_stunden":72,"attribution_coverage_min":0.8,"min_active_ads":4,"max_active_ads_min":4,"max_active_ads_max":10,"eur_je_aktiver_anzeige":20}'::jsonb),
  ('STOPP',       'Automatischer Stopp bei Datenfehlern oder Überschreitung', 'meldung', true, 1, 1, 'werbung',
   '{"sync_max_stunden":30,"capi_fehler_laeufe":2,"woche_faktor":1.1,"tag_faktor":1.75,"kurs_abweichung_max":0.05,"kurs_fallback_usd_je_eur":1.14,"tracking_stunden_ohne_termin":48}'::jsonb),
  ('K0',          'Abgelehnte Anzeige melden und Ersatz vormerken', 'meldung', true, 1, 1, 'werbung', '{}'::jsonb),
  ('K1',          'Schnell-Kill: 150 € ohne Termin und ohne Lead mit Kapitalbasis Ja', 'pause', true, 1, 3, 'werbung',
   '{"spend_eur":150}'::jsonb),
  ('K2',          'Kill: 300 € ohne gebuchten Termin', 'pause', true, 1, 3, 'werbung',
   '{"spend_eur":300}'::jsonb),
  ('K3',          'Bayes-Kill: Kosten pro Termin-Äquivalent sehr wahrscheinlich über 2 x Ziel', 'pause', true, 1, 3, 'werbung',
   '{"kill_factor":2.0,"p_kill":0.8,"min_spend_faktor":2,"prior_strength_te":1.5}'::jsonb),
  ('K4',          'Relativ-Kill: deutlich teurer als die eigene Anzeigengruppe (ab Tag 7)', 'pause', true, 1, 3, 'werbung',
   '{"min_alter_tage":7,"min_spend_faktor":3,"rel_faktor":2,"p_kill":0.8}'::jsonb),
  ('F1',          'Ermüdung: Frequenz 7 Tage über 3', 'ersatz_aktivieren', true, 1, 3, 'werbung',
   '{"freq_max_7d":3.0,"min_alter_tage":10,"min_impressions":3000}'::jsonb),
  ('F2',          'Ermüdung: Link-CTR unter 70 % der Startphase', 'ersatz_aktivieren', true, 1, 3, 'werbung',
   '{"ctr_decay":0.7,"min_alter_tage":10,"min_impressions":3000}'::jsonb),
  ('F3',          'Ermüdung: CPM-Verhältnis über 1,3 x der Startphase', 'ersatz_aktivieren', true, 1, 3, 'werbung',
   '{"cpm_rise":1.3,"min_alter_tage":10,"min_impressions":3000}'::jsonb),
  ('F4',          'Ermüdung: Hook-Rate unter 75 % der Startphase oder unter 20 %', 'ersatz_aktivieren', true, 1, 3, 'werbung',
   '{"hook_decay":0.75,"hook_min":0.20,"min_alter_tage":10,"min_impressions":3000}'::jsonb),
  ('F5',          'Ermüdung: Kosten pro Termin-Äquivalent 1,5 x der ersten 14 Tage', 'ersatz_aktivieren', true, 1, 3, 'werbung',
   '{"cpte_rise":1.5,"min_te":1.5,"min_alter_tage":10}'::jsonb),
  ('F6',          'Ermüdung: Meta meldet Creative Fatigue', 'ersatz_aktivieren', true, 1, 3, 'werbung', '{}'::jsonb),
  ('R1b',         'Ermüdete Anzeige pausieren, wenn der Ersatz 24 h aktiv läuft', 'pause', true, 1, 3, 'werbung',
   '{"min_ersatz_aktiv_stunden":24}'::jsonb),
  ('R2',          'Ersatz aus dem Vorrat nach Kill aktivieren', 'ersatz_aktivieren', true, 1, 3, 'werbung',
   '{"min_active_ads":4,"max_new_ads_per_window":2}'::jsonb),
  ('POOL_UPLOAD', 'Freigegebene Werbemittel pausiert zu Meta hochladen', 'ersatz_hochladen', true, 1, 2, 'werbung',
   '{"min_pool_ready":4}'::jsonb),
  ('S1',          'Budget +20 % bei klar guten Kosten pro Termin-Äquivalent', 'budget_set', true, 1, 3, 'werbung',
   '{"schritt":0.2,"min_booked_14d":3,"p_scale":0.8,"kap_floor":0.4,"freq_max_7d":2.5,"min_free_slots_7d":10,"min_tage_seit_aenderung":3,"budget_gruppen":[]}'::jsonb),
  ('D1',          'Budget -20 % bei klar zu hohen Kosten (Untergrenze 30 €/Tag)', 'budget_set', true, 1, 3, 'werbung',
   '{"schritt":-0.2,"min_spend_faktor":3,"faktor":1.4,"p":0.8,"adset_min_daily_eur":30,"min_tage_seit_aenderung":3,"budget_gruppen":[]}'::jsonb),
  ('D2',          'Anzeigengruppe pausieren (nur Vorschlag)', 'pause', true, 1, 1, 'werbung',
   '{"min_spend_faktor":6,"faktor":2.5,"p":0.9}'::jsonb),
  ('D3',          'Keine freien Termine: Budget auf Untergrenze oder pausieren (Meldung)', 'meldung', true, 1, 1, 'werbung',
   '{"min_free_slots_7d":0}'::jsonb)
on conflict (rule_key) do nothing;

-- ── 5. Guard-Trigger ────────────────────────────────────────────────────────

-- 5a. Log nur anhängen (auch für System; Rückbau löscht die ganze Tabelle).
create or replace function public.werbe_log_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception 'ad_autopilot_log ist nur zum Anhängen (% verboten)', tg_op
    using errcode = '42501';
end
$fn$;

drop trigger if exists werbe_log_append_only on public.ad_autopilot_log;
create trigger werbe_log_append_only
  before update or delete on public.ad_autopilot_log
  for each row execute function public.werbe_log_append_only();
drop trigger if exists werbe_log_append_only_truncate on public.ad_autopilot_log;
create trigger werbe_log_append_only_truncate
  before truncate on public.ad_autopilot_log
  for each statement execute function public.werbe_log_append_only();

-- 5b. ad_actions: Autopilot-Zeilen nur vom System, Status nur vorwärts, Freigabe
--     von Vorschlägen nur über werbe_vorschlag_entscheiden (werbe.freigabe = 'rpc').
--     Menschen direkt (Tabelle): wie bisher nur Stornieren bestätigt -> abgelehnt.
create or replace function public.werbe_actions_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_system boolean := public.werbe_ist_system();
  v_rpc    boolean := coalesce(current_setting('werbe.freigabe', true), '') = 'rpc';
  v_final  constant text[] := array['ausgeführt', 'fehlgeschlagen', 'abgelehnt'];
begin
  if tg_op = 'INSERT' then
    new.entity_level := coalesce(new.entity_level, 'ad');
    new.entity_id := coalesce(new.entity_id, new.ad_id);
    if new.origin = 'autopilot' then
      if not v_system then
        raise exception 'Autopilot-Aktionen legt nur das System an' using errcode = '42501';
      end if;
      if new.status = 'bestätigt' and new.freigabe is distinct from 'autonom' then
        raise exception 'Autopilot-Aktion mit Status bestätigt braucht freigabe = autonom' using errcode = '23514';
      end if;
    elsif not v_system then
      -- Manuelles Vormerken wie bisher (AdsManager queueAction).
      if new.status is distinct from 'bestätigt' then
        raise exception 'Neue Aktionen starten mit Status bestätigt' using errcode = '23514';
      end if;
      new.created_by  := coalesce(auth.uid(), new.created_by);
      new.freigabe    := null;
      new.approved_by := null;
      new.approved_at := null;
      new.claimed_at  := null;
      new.executed_at := null;
      new.readback    := null;
    end if;
    return new;
  end if;

  -- UPDATE: Status nur vorwärts (für alle Aufrufer).
  if new.status is distinct from old.status then
    if old.status = any (v_final) then
      raise exception 'Status % ist endgültig', old.status using errcode = '23514';
    end if;
    if new.status is null then
      raise exception 'Status kann nicht zurückgesetzt werden' using errcode = '23514';
    end if;
    if old.status is null then
      if new.status not in ('bestätigt', 'abgelehnt') then
        raise exception 'Ein Vorschlag wird nur bestätigt oder abgelehnt' using errcode = '23514';
      end if;
      if new.status = 'bestätigt' and not v_rpc then
        raise exception 'Vorschläge werden nur über werbe_vorschlag_entscheiden freigegeben' using errcode = '42501';
      end if;
    end if;
  end if;

  if not (v_system or v_rpc) then
    -- NULL-sicher: Vorschläge (status NULL) fallen hier immer durch.
    if not (old.status is not distinct from 'bestätigt' and new.status is not distinct from 'abgelehnt')
       or (to_jsonb(new) - array['status', 'freigabe']) is distinct from (to_jsonb(old) - array['status', 'freigabe']) then
      raise exception 'Aktionen können hier nur storniert werden' using errcode = '42501';
    end if;
    new.freigabe := case when old.origin = 'autopilot' then 'verworfen' else old.freigabe end;
  end if;

  return new;
end
$fn$;

drop trigger if exists werbe_actions_guard on public.ad_actions;
create trigger werbe_actions_guard
  before insert or update on public.ad_actions
  for each row execute function public.werbe_actions_guard();

-- 5c. ad_settings: Hochstellen/Einschalten nur Admin oder System, Senken für alle
--     mit Recht werbung (RLS ad_settings UPDATE = werbung). Jede Änderung ins Log.
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

drop trigger if exists werbe_settings_guard on public.ad_settings;
create trigger werbe_settings_guard
  before update on public.ad_settings
  for each row execute function public.werbe_settings_guard();

-- 5d. ad_autopilot_rules: Version +1, wer/wann, Log. Freigabestufe erhöhen und
--     Regeln einschalten nur Admin (RLS: UPDATE ohnehin nur Admin). max_level und
--     aktion nur per Migration (direkte DB-Sitzung). Budget-L3 nur mit
--     ad_settings.budget_autonomie_freigegeben_at.
create or replace function public.werbe_rules_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_db     boolean := public.werbe_ist_db_sitzung();
  v_system boolean := public.werbe_ist_system();
  v_admin  boolean := public.werbe_ist_admin();
  v_ohne   constant text[] := array['version', 'updated_by', 'updated_at'];
begin
  if tg_op = 'INSERT' then
    if not v_system then
      raise exception 'Regeln werden nur per Migration angelegt' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.rule_key is distinct from old.rule_key then
    raise exception 'rule_key ist nicht änderbar' using errcode = '42501';
  end if;
  if (new.max_level is distinct from old.max_level or new.aktion is distinct from old.aktion) and not v_db then
    raise exception 'max_level und aktion nur per Migration änderbar' using errcode = '42501';
  end if;
  if new.approval_level > old.approval_level and not (v_system or v_admin) then
    raise exception 'Nur ein Admin darf die Freigabestufe erhöhen' using errcode = '42501';
  end if;
  if new.enabled and not old.enabled and not (v_system or v_admin) then
    raise exception 'Nur ein Admin darf Regeln einschalten' using errcode = '42501';
  end if;
  if new.freigabe_rolle is distinct from old.freigabe_rolle and not (v_system or v_admin) then
    raise exception 'Nur ein Admin darf die Freigabe-Rolle ändern' using errcode = '42501';
  end if;
  if new.aktion = 'budget_set' and new.approval_level = 3 and old.approval_level < 3
     and not exists (select 1 from public.ad_settings s
                     where s.id = 'default' and s.budget_autonomie_freigegeben_at is not null) then
    raise exception 'Budget-Regeln auf Stufe 3 erst nach Freigabe der Budget-Autonomie (ad_settings.budget_autonomie_freigegeben_at)'
      using errcode = '42501';
  end if;

  if (to_jsonb(new) - v_ohne) = (to_jsonb(old) - v_ohne) then
    return new;
  end if;

  new.version    := old.version + 1;
  new.updated_by := auth.uid();
  new.updated_at := now();

  insert into public.ad_autopilot_log (art, rule_key, rule_version, approval_level, aktion, before, after, ergebnis, akteur, akteur_art)
  values ('regel_aenderung', new.rule_key, new.version, new.approval_level, new.aktion,
          public.werbe_jsonb_diff(to_jsonb(new), to_jsonb(old), v_ohne),
          public.werbe_jsonb_diff(to_jsonb(old), to_jsonb(new), v_ohne),
          'geaendert', auth.uid(), case when v_system then 'system' else 'mensch' end);

  return new;
end
$fn$;

drop trigger if exists werbe_rules_guard on public.ad_autopilot_rules;
create trigger werbe_rules_guard
  before insert or update on public.ad_autopilot_rules
  for each row execute function public.werbe_rules_guard();

-- 5e. ad_creative_pool: Statusübergänge, Freigabe/Ablehnung mit Stempel und
--     Merkmalen (Lernen aus Svens/Gionas Entscheidungen), Systemfelder nur vom
--     System, Inhalte nur vor der Freigabe, nie zurück auf Entwurf nach dem
--     Hochladen, automatische Freigabe nur nach pool_auto_release_level und nie
--     bei fakten_pruefung.
create or replace function public.werbe_pool_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_db       boolean := public.werbe_ist_db_sitzung();
  v_service  boolean := public.werbe_ist_service();
  v_system   boolean := v_db or v_service;
  v_admin    boolean := public.werbe_ist_admin();
  -- Übergänge, die Menschen direkt (oder über werbe_pool_entscheiden) machen dürfen.
  v_mensch   constant text[] := array[
    'entwurf>verworfen', 'geprueft>freigegeben', 'geprueft>verworfen', 'geprueft>entwurf',
    'freigegeben>verworfen', 'freigegeben>geprueft', 'verworfen>entwurf',
    'hochgeladen>verworfen', 'pausiert>verworfen'];
  v_inhalt_alt jsonb;
  v_inhalt_neu jsonb;
  v_level    smallint;
  v_schwelle numeric;
  v_anzahl   int;
begin
  if tg_op = 'INSERT' then
    if not v_system then
      if new.status is distinct from 'entwurf' then
        raise exception 'Neue Werbemittel starten als Entwurf' using errcode = '42501';
      end if;
      new.entscheidung := null;      new.entscheidung_grund := null;
      new.entschieden_von := null;   new.entschieden_at := null;
      new.released_by := null;       new.released_at := null;
      new.prognose := null;          new.merkmale := null;
      new.qa := null;                new.review_score := null;   new.housing_ok := null;
      new.meta_image_hashes := null; new.meta_creative_id := null; new.meta_ad_ids := null;
      new.hochgeladen_at := null;    new.aktiv_seit := null;      new.beendet_at := null;
    end if;
    new.created_at := coalesce(new.created_at, now());
    new.updated_at := now();
    insert into public.ad_autopilot_log (art, entity_level, entity_id, entity_name, aktion, after, ergebnis, akteur, akteur_art)
    values ('vorrat', 'vorrat', new.id::text, new.kennung, 'anlegen',
            jsonb_build_object('status', new.status, 'quelle', new.quelle, 'winkel', new.winkel, 'format', new.format),
            'angelegt', auth.uid(), case when v_system then 'system' else 'mensch' end);
    return new;
  end if;

  -- UPDATE
  if new.status = 'entwurf' and old.status <> 'entwurf'
     and (old.hochgeladen_at is not null or old.status in ('hochgeladen', 'aktiv', 'ermuedet', 'gekillt', 'pausiert')) then
    raise exception 'Nach dem Hochladen gibt es keinen Weg zurück auf Entwurf' using errcode = '23514';
  end if;
  if new.kennung is distinct from old.kennung and old.hochgeladen_at is not null then
    raise exception 'Die Kennung ist nach dem Hochladen nicht mehr änderbar' using errcode = '23514';
  end if;

  v_inhalt_alt := jsonb_build_object(
    'kennung', old.kennung, 'texte', old.texte, 'asset_feed_url', old.asset_feed_url, 'asset_story_url', old.asset_story_url,
    'video_feed_id', old.video_feed_id, 'video_story_id', old.video_story_id, 'lp_url', old.lp_url, 'cta', old.cta,
    'laender', old.laender, 'format', old.format, 'winkel', old.winkel, 'hook_typ', old.hook_typ, 'visual_typ', old.visual_typ,
    'ki_generiert', old.ki_generiert, 'ki_label', old.ki_label, 'eu_band', old.eu_band, 'brief', old.brief,
    'ziel_adset_ids', old.ziel_adset_ids);
  v_inhalt_neu := jsonb_build_object(
    'kennung', new.kennung, 'texte', new.texte, 'asset_feed_url', new.asset_feed_url, 'asset_story_url', new.asset_story_url,
    'video_feed_id', new.video_feed_id, 'video_story_id', new.video_story_id, 'lp_url', new.lp_url, 'cta', new.cta,
    'laender', new.laender, 'format', new.format, 'winkel', new.winkel, 'hook_typ', new.hook_typ, 'visual_typ', new.visual_typ,
    'ki_generiert', new.ki_generiert, 'ki_label', new.ki_label, 'eu_band', new.eu_band, 'brief', new.brief,
    'ziel_adset_ids', new.ziel_adset_ids);

  if not v_system then
    -- Systemfelder schreibt nur das System (QA, Prognose, Meta-IDs, Stempel).
    if jsonb_build_object(
         'qa', new.qa, 'review_score', new.review_score, 'housing_ok', new.housing_ok, 'prognose', new.prognose,
         'merkmale', new.merkmale, 'quelle', new.quelle, 'kosten_credits', new.kosten_credits,
         'meta_image_hashes', new.meta_image_hashes, 'meta_creative_id', new.meta_creative_id, 'meta_ad_ids', new.meta_ad_ids,
         'hochgeladen_at', new.hochgeladen_at, 'aktiv_seit', new.aktiv_seit, 'beendet_at', new.beendet_at,
         'released_by', new.released_by, 'released_at', new.released_at, 'entscheidung', new.entscheidung,
         'entschieden_von', new.entschieden_von, 'entschieden_at', new.entschieden_at, 'ersetzt_kennung', new.ersetzt_kennung,
         'created_at', new.created_at)
       is distinct from jsonb_build_object(
         'qa', old.qa, 'review_score', old.review_score, 'housing_ok', old.housing_ok, 'prognose', old.prognose,
         'merkmale', old.merkmale, 'quelle', old.quelle, 'kosten_credits', old.kosten_credits,
         'meta_image_hashes', old.meta_image_hashes, 'meta_creative_id', old.meta_creative_id, 'meta_ad_ids', old.meta_ad_ids,
         'hochgeladen_at', old.hochgeladen_at, 'aktiv_seit', old.aktiv_seit, 'beendet_at', old.beendet_at,
         'released_by', old.released_by, 'released_at', old.released_at, 'entscheidung', old.entscheidung,
         'entschieden_von', old.entschieden_von, 'entschieden_at', old.entschieden_at, 'ersetzt_kennung', old.ersetzt_kennung,
         'created_at', old.created_at) then
      raise exception 'Diese Felder setzt nur das System (QA, Prognose, Meta-IDs, Freigabe-Stempel)' using errcode = '42501';
    end if;
    if old.fakten_pruefung and not new.fakten_pruefung and not v_admin then
      raise exception 'Nur ein Admin darf die Fakten-Prüfung abschalten' using errcode = '42501';
    end if;
    if v_inhalt_neu is distinct from v_inhalt_alt then
      if old.status not in ('entwurf', 'geprueft') then
        raise exception 'Nach der Freigabe nicht mehr änderbar, erst zurück auf geprüft setzen' using errcode = '23514';
      end if;
      if new.status not in ('entwurf', 'geprueft') then
        raise exception 'Inhalt und Freigabe bitte getrennt speichern' using errcode = '23514';
      end if;
      -- Geänderter Inhalt muss erneut durch die automatische Prüfung.
      new.status := 'entwurf';
    end if;
    if new.status is distinct from old.status
       and not ((old.status || '>' || new.status) = any (v_mensch)) then
      raise exception 'Statuswechsel % -> % macht nur das System', old.status, new.status using errcode = '42501';
    end if;
  elsif v_service and new.status = 'freigegeben' and old.status is distinct from 'freigegeben' then
    -- Automatische Freigabe (Edge Function). Direkte DB-Sitzung (SQL-Editor) bleibt frei.
    if new.fakten_pruefung then
      raise exception 'Werbemittel mit Fakten, Preisen oder Fotos gibt nur ein Mensch frei' using errcode = '42501';
    end if;
    select s.pool_auto_release_level, s.pool_auto_release_threshold
      into v_level, v_schwelle
      from public.ad_settings s where s.id = 'default';
    if coalesce(v_level, 0) < 2 then
      raise exception 'Automatische Freigabe ist aus (pool_auto_release_level < 2)' using errcode = '42501';
    end if;
    if v_level = 2 then
      if new.prognose is null or new.prognose < coalesce(v_schwelle, 0.9) then
        raise exception 'Prognose unter der Schwelle für automatische Freigabe' using errcode = '42501';
      end if;
      select count(*) into v_anzahl from public.ad_creative_pool p where p.entschieden_von is not null;
      if v_anzahl < 30 then
        raise exception 'Automatische Freigabe erst nach 30 menschlichen Entscheidungen (bisher %)', v_anzahl using errcode = '42501';
      end if;
    end if;
  end if;

  -- Stempel bei Statuswechsel (alle Aufrufer).
  if new.status is distinct from old.status then
    if new.status = 'freigegeben' then
      new.released_at     := now();
      new.released_by     := auth.uid();
      new.entscheidung    := 'freigegeben';
      new.entschieden_von := auth.uid();
      new.entschieden_at  := now();
      if v_service and new.entscheidung_grund is not distinct from old.entscheidung_grund then
        new.entscheidung_grund := 'automatisch (Prognose ' || coalesce(round(new.prognose, 2)::text, '-') || ')';
      end if;
    elsif new.status = 'verworfen' and old.status in ('geprueft', 'freigegeben') then
      if not v_system and nullif(btrim(coalesce(new.entscheidung_grund, '')), '') is null then
        raise exception 'Bitte einen Grund für die Ablehnung angeben' using errcode = '22023';
      end if;
      new.entscheidung    := 'abgelehnt';
      new.entschieden_von := auth.uid();
      new.entschieden_at  := now();
    elsif old.status = 'freigegeben' and new.status = 'geprueft' then
      new.released_at := null;
      new.released_by := null;
    end if;

    -- Merkmale der Entscheidung festhalten (Grundlage der Freigabe-Prognose).
    if (new.status = 'freigegeben' or (new.status = 'verworfen' and old.status in ('geprueft', 'freigegeben')))
       and new.merkmale is not distinct from old.merkmale then
      new.merkmale := jsonb_build_object(
        'winkel', new.winkel, 'hook_typ', new.hook_typ, 'format', new.format, 'visual_typ', new.visual_typ,
        'review_score', new.review_score, 'lint', coalesce(new.qa -> 'lint', new.qa -> 'lint_warnungen', '[]'::jsonb),
        'ki_generiert', new.ki_generiert, 'fakten_pruefung', new.fakten_pruefung, 'quelle', new.quelle,
        'prognose', new.prognose);
    end if;

    if new.status = 'hochgeladen' then
      new.hochgeladen_at := coalesce(new.hochgeladen_at, now());
    elsif new.status = 'aktiv' then
      new.aktiv_seit := coalesce(new.aktiv_seit, now());
    elsif new.status in ('gekillt', 'pausiert', 'verworfen') and old.status in ('aktiv', 'ermuedet') then
      new.beendet_at := coalesce(new.beendet_at, now());
    end if;

    insert into public.ad_autopilot_log (art, entity_level, entity_id, entity_name, aktion, before, after, evidence, ergebnis, akteur, akteur_art)
    values ('vorrat', 'vorrat', new.id::text, new.kennung, old.status || '>' || new.status,
            jsonb_build_object('status', old.status, 'entscheidung', old.entscheidung),
            jsonb_build_object('status', new.status, 'entscheidung', new.entscheidung),
            jsonb_build_object('grund', new.entscheidung_grund, 'merkmale', new.merkmale, 'prognose', new.prognose),
            coalesce(new.entscheidung, new.status), auth.uid(), case when v_system then 'system' else 'mensch' end);
  end if;

  new.updated_at := now();
  return new;
end
$fn$;

drop trigger if exists werbe_pool_guard on public.ad_creative_pool;
create trigger werbe_pool_guard
  before insert or update on public.ad_creative_pool
  for each row execute function public.werbe_pool_guard();

-- ── 6. RPCs ─────────────────────────────────────────────────────────────────

-- Vorschlagsgruppe freigeben oder verwerfen (Admin oder Recht werbung; Regeln mit
-- freigabe_rolle 'admin' nur Admin). Gruppen gelten gemeinsam: ist ein Mitglied
-- abgelaufen, läuft die ganze Gruppe ab (Plan-B-Paare bleiben symmetrisch).
-- Freigeben ist gesperrt, solange der Autopilot gestoppt/pausiert ist.
create or replace function public.werbe_vorschlag_entscheiden(
  p_gruppe       uuid,
  p_entscheidung text,
  p_grund        text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_system      boolean := public.werbe_ist_system();
  v_admin       boolean := public.werbe_ist_admin();
  v_ja          boolean;
  v_offen       int;
  v_abgelaufen  int;
  v_anzahl      int;
  v_mode        text;
  v_pause       timestamptz;
  v_grund       text := nullif(btrim(coalesce(p_grund, '')), '');
begin
  if not (v_system or public.current_user_has_perm('werbung')) then
    raise exception 'Keine Berechtigung für Werbe-Freigaben' using errcode = '42501';
  end if;
  if p_gruppe is null then
    raise exception 'gruppe_id fehlt' using errcode = '22004';
  end if;
  v_ja := case lower(btrim(coalesce(p_entscheidung, '')))
            when 'freigeben' then true  when 'freigegeben' then true when 'ja' then true
            when 'verwerfen' then false when 'verworfen' then false  when 'ablehnen' then false
            when 'abgelehnt' then false when 'nein' then false
          end;
  if v_ja is null then
    raise exception 'Entscheidung muss freigeben oder verwerfen sein' using errcode = '22023';
  end if;

  perform 1 from public.ad_actions a
   where a.gruppe_id = p_gruppe and a.status is null and a.freigabe = 'vorgeschlagen'
   for update;
  get diagnostics v_offen = row_count;
  if v_offen = 0 then
    return jsonb_build_object('success', false, 'grund', 'keine_offenen_vorschlaege', 'gruppe_id', p_gruppe);
  end if;

  if v_ja and not (v_admin or v_system) and exists (
       select 1 from public.ad_actions a
       join public.ad_autopilot_rules r on r.rule_key = a.rule_key
       where a.gruppe_id = p_gruppe and a.status is null and a.freigabe = 'vorgeschlagen'
         and r.freigabe_rolle = 'admin') then
    raise exception 'Diese Regel darf nur ein Admin freigeben' using errcode = '42501';
  end if;

  perform set_config('werbe.freigabe', 'rpc', true);

  select count(*) into v_abgelaufen
    from public.ad_actions a
   where a.gruppe_id = p_gruppe and a.status is null and a.freigabe = 'vorgeschlagen'
     and a.expires_at is not null and a.expires_at < now();

  if v_abgelaufen > 0 then
    with upd as (
      update public.ad_actions a
         set status = 'abgelehnt', freigabe = 'abgelaufen', result = 'Vorschlag abgelaufen'
       where a.gruppe_id = p_gruppe and a.status is null and a.freigabe = 'vorgeschlagen'
      returning a.*
    )
    insert into public.ad_autopilot_log (art, rule_key, rule_version, approval_level, entity_level, entity_id, entity_name,
                                         aktion, before, after, evidence, ergebnis, action_id, gruppe_id, idempotency_key,
                                         akteur, akteur_art)
    select 'ablehnung', u.rule_key, u.rule_version, u.approval_level, u.entity_level, u.entity_id,
           coalesce(u.ad_name, u.payload ->> 'entity_name', u.entity_id),
           u.action, u.before, u.after, u.evidence, 'abgelaufen', u.id, u.gruppe_id, u.idempotency_key,
           auth.uid(), case when v_system then 'system' else 'mensch' end
      from upd u;
    perform set_config('werbe.freigabe', '', true);
    return jsonb_build_object('success', false, 'grund', 'abgelaufen', 'gruppe_id', p_gruppe, 'anzahl', v_offen);
  end if;

  if v_ja then
    select s.autopilot_mode, s.autopilot_paused_until into v_mode, v_pause
      from public.ad_settings s where s.id = 'default';
    if v_mode = 'aus' or (v_pause is not null and v_pause > now()) then
      raise exception 'Der Autopilot ist gestoppt, Freigaben sind gesperrt' using errcode = '55000';
    end if;

    with upd as (
      update public.ad_actions a
         set status = 'bestätigt', freigabe = 'freigegeben', approved_by = auth.uid(), approved_at = now()
       where a.gruppe_id = p_gruppe and a.status is null and a.freigabe = 'vorgeschlagen'
      returning a.*
    )
    insert into public.ad_autopilot_log (art, rule_key, rule_version, approval_level, entity_level, entity_id, entity_name,
                                         aktion, before, after, evidence, ergebnis, action_id, gruppe_id, idempotency_key,
                                         akteur, akteur_art)
    select 'freigabe', u.rule_key, u.rule_version, u.approval_level, u.entity_level, u.entity_id,
           coalesce(u.ad_name, u.payload ->> 'entity_name', u.entity_id),
           u.action, u.before, u.after,
           coalesce(u.evidence, '{}'::jsonb) || jsonb_build_object('grund', v_grund),
           'freigegeben', u.id, u.gruppe_id, u.idempotency_key,
           auth.uid(), case when v_system then 'system' else 'mensch' end
      from upd u;
  else
    with upd as (
      update public.ad_actions a
         set status = 'abgelehnt', freigabe = 'verworfen', approved_by = auth.uid(), approved_at = now(),
             result = left(coalesce(v_grund, 'Vorschlag verworfen'), 500)
       where a.gruppe_id = p_gruppe and a.status is null and a.freigabe = 'vorgeschlagen'
      returning a.*
    )
    insert into public.ad_autopilot_log (art, rule_key, rule_version, approval_level, entity_level, entity_id, entity_name,
                                         aktion, before, after, evidence, ergebnis, action_id, gruppe_id, idempotency_key,
                                         akteur, akteur_art)
    select 'ablehnung', u.rule_key, u.rule_version, u.approval_level, u.entity_level, u.entity_id,
           coalesce(u.ad_name, u.payload ->> 'entity_name', u.entity_id),
           u.action, u.before, u.after,
           coalesce(u.evidence, '{}'::jsonb) || jsonb_build_object('grund', v_grund),
           'verworfen', u.id, u.gruppe_id, u.idempotency_key,
           auth.uid(), case when v_system then 'system' else 'mensch' end
      from upd u;
  end if;
  get diagnostics v_anzahl = row_count;

  perform set_config('werbe.freigabe', '', true);

  return jsonb_build_object(
    'success', true,
    'entscheidung', case when v_ja then 'freigegeben' else 'verworfen' end,
    'anzahl', v_anzahl,
    'gruppe_id', p_gruppe);
end
$fn$;

-- Roter Knopf: Modus 'aus', Grund speichern, offene Autopilot-Aktionen stornieren
-- (Vorschläge und noch nicht beanspruchte bestätigte Zeilen). Jeder mit Recht
-- werbung oder werbung_meta. Wieder einschalten kann nur ein Admin (Settings-Guard).
create or replace function public.werbe_autopilot_stopp(p_grund text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_system    boolean := public.werbe_ist_system();
  v_grund     text := left(coalesce(nullif(btrim(coalesce(p_grund, '')), ''), 'Manuell gestoppt'), 500);
  v_alt       text;
  v_storniert int;
begin
  if not (v_system or public.current_user_has_perm('werbung') or public.current_user_has_perm('werbung_meta')) then
    raise exception 'Keine Berechtigung' using errcode = '42501';
  end if;

  select s.autopilot_mode into v_alt from public.ad_settings s where s.id = 'default' for update;

  update public.ad_settings
     set autopilot_mode = 'aus', autopilot_stop_grund = v_grund, updated_at = now()
   where id = 'default';

  perform set_config('werbe.freigabe', 'rpc', true);
  with upd as (
    update public.ad_actions a
       set status = 'abgelehnt', freigabe = 'verworfen', result = left('Autopilot gestoppt: ' || v_grund, 500)
     where a.origin = 'autopilot'
       and ((a.status is null and a.freigabe = 'vorgeschlagen')
            or (a.status = 'bestätigt' and (a.claimed_at is null or a.claimed_at < now() - interval '10 minutes')))
    returning a.id
  )
  select count(*) into v_storniert from upd;
  perform set_config('werbe.freigabe', '', true);

  insert into public.ad_autopilot_log (art, modus, before, after, evidence, ergebnis, akteur, akteur_art)
  values ('stopp', 'aus',
          jsonb_build_object('autopilot_mode', v_alt),
          jsonb_build_object('autopilot_mode', 'aus'),
          jsonb_build_object('grund', v_grund, 'storniert', v_storniert),
          'gestoppt', auth.uid(), case when v_system then 'system' else 'mensch' end);

  return jsonb_build_object('success', true, 'vorher', v_alt, 'storniert', v_storniert);
end
$fn$;

-- Daumen zu einem Schatten-/Vorschlags-/Ausführungs-Eintrag. Das Log bleibt
-- unverändert; die Bewertung ist ein neuer Eintrag mit bezug_log_id.
create or replace function public.werbe_schatten_bewerten(p_log_id bigint, p_urteil text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_system boolean := public.werbe_ist_system();
  v_urteil text;
  v_log    public.ad_autopilot_log%rowtype;
  v_id     bigint;
begin
  if not (v_system or public.current_user_has_perm('werbung')) then
    raise exception 'Keine Berechtigung' using errcode = '42501';
  end if;
  v_urteil := case lower(btrim(coalesce(p_urteil, '')))
                when 'richtig' then 'richtig' when 'gut' then 'richtig' when 'hoch' then 'richtig'
                when 'daumen_hoch' then 'richtig' when 'ja' then 'richtig'
                when 'falsch' then 'falsch' when 'schlecht' then 'falsch' when 'runter' then 'falsch'
                when 'daumen_runter' then 'falsch' when 'nein' then 'falsch'
                when 'unklar' then 'unklar'
              end;
  if v_urteil is null then
    raise exception 'Urteil muss richtig, falsch oder unklar sein' using errcode = '22023';
  end if;

  select * into v_log from public.ad_autopilot_log l where l.id = p_log_id;
  if not found then
    raise exception 'Log-Eintrag % nicht gefunden', p_log_id using errcode = 'P0002';
  end if;
  if v_log.art not in ('schatten', 'vorschlag', 'ausfuehrung', 'replay') then
    raise exception 'Nur Schatten-, Vorschlags-, Replay- und Ausführungs-Einträge sind bewertbar' using errcode = '22023';
  end if;

  insert into public.ad_autopilot_log (art, rule_key, rule_version, modus, approval_level, entity_level, entity_id, entity_name,
                                       aktion, ergebnis, action_id, gruppe_id, bezug_log_id, akteur, akteur_art)
  values ('bewertung', v_log.rule_key, v_log.rule_version, v_log.modus, v_log.approval_level, v_log.entity_level,
          v_log.entity_id, v_log.entity_name, v_log.aktion, v_urteil, v_log.action_id, v_log.gruppe_id, p_log_id,
          auth.uid(), case when v_system then 'system' else 'mensch' end)
  returning id into v_id;

  return jsonb_build_object('success', true, 'id', v_id, 'bezug_log_id', p_log_id, 'urteil', v_urteil);
end
$fn$;

-- Executor-Claim (werbeAusfuehren.ts), Muster claim_workflow_runs: bestätigte
-- Zeilen mit 10-Minuten-Lease. Nur System (EXECUTE nur service_role).
create or replace function public.werbe_aktionen_claimen(p_ids uuid[])
returns setof public.ad_actions
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.ad_actions a
     set claimed_at = now()
   where a.id in (
           select x.id from public.ad_actions x
            where x.id = any (p_ids)
              and x.status = 'bestätigt'
              and (x.claimed_at is null or x.claimed_at < now() - interval '10 minutes')
            for update skip locked)
     and public.werbe_ist_system()
  returning a.*;
$$;

-- Vorrat: freigeben (nur aus 'geprueft') oder ablehnen (mit Grund). Admin oder
-- Recht werbung. Stempel, Merkmale und Log setzt werbe_pool_guard.
create or replace function public.werbe_pool_entscheiden(
  p_pool_id      uuid,
  p_entscheidung text,
  p_grund        text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ja     boolean;
  v_status text;
  v_grund  text := nullif(btrim(coalesce(p_grund, '')), '');
  v_res    jsonb;
begin
  if not (public.werbe_ist_system() or public.current_user_has_perm('werbung')) then
    raise exception 'Keine Berechtigung' using errcode = '42501';
  end if;
  v_ja := case lower(btrim(coalesce(p_entscheidung, '')))
            when 'freigeben' then true  when 'freigegeben' then true when 'ja' then true
            when 'ablehnen' then false  when 'abgelehnt' then false  when 'verwerfen' then false
            when 'verworfen' then false when 'nein' then false
          end;
  if v_ja is null then
    raise exception 'Entscheidung muss freigeben oder ablehnen sein' using errcode = '22023';
  end if;

  select p.status into v_status from public.ad_creative_pool p where p.id = p_pool_id for update;
  if not found then
    raise exception 'Werbemittel nicht gefunden' using errcode = 'P0002';
  end if;

  if v_ja then
    if v_status <> 'geprueft' then
      raise exception 'Freigeben geht nur aus dem Status geprüft (jetzt: %)', v_status using errcode = '23514';
    end if;
    update public.ad_creative_pool
       set status = 'freigegeben', entscheidung_grund = left(v_grund, 1000)
     where id = p_pool_id;
  else
    if v_status not in ('entwurf', 'geprueft', 'freigegeben') then
      raise exception 'Ablehnen geht nur vor dem Hochladen (jetzt: %)', v_status using errcode = '23514';
    end if;
    if v_grund is null then
      raise exception 'Bitte einen Grund für die Ablehnung angeben' using errcode = '22023';
    end if;
    update public.ad_creative_pool
       set status = 'verworfen', entscheidung_grund = left(v_grund, 1000)
     where id = p_pool_id;
  end if;

  select jsonb_build_object('success', true, 'id', p.id, 'status', p.status, 'entscheidung', p.entscheidung,
                            'prognose', p.prognose)
    into v_res
    from public.ad_creative_pool p where p.id = p_pool_id;
  return v_res;
end
$fn$;

-- ── 7. Rechte ───────────────────────────────────────────────────────────────
revoke execute on function public.werbe_ist_db_sitzung()  from public;
revoke execute on function public.werbe_ist_service()     from public;
revoke execute on function public.werbe_ist_system()      from public;
revoke execute on function public.werbe_ist_admin()       from public;
revoke execute on function public.werbe_ist_db_sitzung()  from anon;
revoke execute on function public.werbe_ist_service()     from anon;
revoke execute on function public.werbe_ist_system()      from anon;
revoke execute on function public.werbe_ist_admin()       from anon;
grant  execute on function public.werbe_ist_db_sitzung()  to authenticated, service_role;
grant  execute on function public.werbe_ist_service()     to authenticated, service_role;
grant  execute on function public.werbe_ist_system()      to authenticated, service_role;
grant  execute on function public.werbe_ist_admin()       to authenticated, service_role;

revoke execute on function public.werbe_jsonb_diff(jsonb, jsonb, text[]) from public, anon;
grant  execute on function public.werbe_jsonb_diff(jsonb, jsonb, text[]) to authenticated, service_role;

revoke execute on function public.werbe_log_append_only() from public, anon, authenticated;
revoke execute on function public.werbe_actions_guard()   from public, anon, authenticated;
revoke execute on function public.werbe_settings_guard()  from public, anon, authenticated;
revoke execute on function public.werbe_rules_guard()     from public, anon, authenticated;
revoke execute on function public.werbe_pool_guard()      from public, anon, authenticated;

revoke execute on function public.werbe_vorschlag_entscheiden(uuid, text, text) from public, anon;
revoke execute on function public.werbe_autopilot_stopp(text)                   from public, anon;
revoke execute on function public.werbe_schatten_bewerten(bigint, text)         from public, anon;
revoke execute on function public.werbe_pool_entscheiden(uuid, text, text)      from public, anon;
grant  execute on function public.werbe_vorschlag_entscheiden(uuid, text, text) to authenticated, service_role;
grant  execute on function public.werbe_autopilot_stopp(text)                   to authenticated, service_role;
grant  execute on function public.werbe_schatten_bewerten(bigint, text)         to authenticated, service_role;
grant  execute on function public.werbe_pool_entscheiden(uuid, text, text)      to authenticated, service_role;

revoke execute on function public.werbe_aktionen_claimen(uuid[]) from public, anon, authenticated;
grant  execute on function public.werbe_aktionen_claimen(uuid[]) to service_role;

comment on function public.werbe_vorschlag_entscheiden(uuid, text, text) is
  'Werbe-Autopilot: Vorschlagsgruppe freigeben oder verwerfen (Admin oder Recht werbung). Setzt werbe.freigabe = rpc.';
comment on function public.werbe_autopilot_stopp(text) is
  'Werbe-Autopilot: Not-Aus. Modus aus, offene Autopilot-Aktionen storniert. Recht werbung oder werbung_meta.';
comment on function public.werbe_aktionen_claimen(uuid[]) is
  'Werbe-Autopilot: Executor-Claim bestätigter Aktionen (10-Min-Lease). Nur service_role.';

notify pgrst, 'reload schema';

commit;
