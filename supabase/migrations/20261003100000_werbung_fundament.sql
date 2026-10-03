-- Werbemanager, Paket 1 "Fundament" (03.10.2026): Spiegel des Meta-Zustands,
-- Kampagnen-Assistent (Entwürfe, Medien, Schreib-Protokoll) und die neuen
-- Einstellungsfelder für Assistent und Autopilot.
--
-- Was diese Datei anlegt bzw. ergänzt (alles additiv, nichts wird gelöscht):
--   meta_campaigns, meta_adsets  Spiegel der Kampagnen/Anzeigengruppen aus Meta
--                                (Budget, Ziel, Sonderkategorie, DSA, Lernstatus).
--                                Schreibt nur die Service-Role (meta-ads-sync,
--                                meta-builder). Bisher gab es diese Daten in der
--                                DB gar nicht.
--   meta_drafts                  Entwürfe des Kampagnen-Assistenten (3 Ebenen als
--                                jsonb). Werbe-Mitarbeiter dürfen nur die
--                                Inhaltsspalten schreiben; Status, Meta-IDs,
--                                Prüfergebnis und Lease setzt nur meta-builder.
--   meta_media                   hochgeladene Bilder/Videos mit Meta-Hash bzw.
--                                Video-ID und den Pflicht-Bestätigungen (EU-Band,
--                                KI-Kennzeichnung). Nur lesbar für die Oberfläche.
--   meta_write_log               jeder Schreibzugriff auf Meta (auch validate_only),
--                                nur anhängen, nie ändern oder löschen.
--   ad_catalog        + Spalten  effective_status, configured_status, issues_info,
--                                review_feedback, url_tags, created_time,
--                                updated_time, draft_id.
--   ad_insights_daily + Spalten  campaign_id, adset_id, video_3s_true, thruplays,
--                                platform_schedules + Index (adset_id, day) +
--                                einmaliges Nachtragen von campaign_id/adset_id
--                                aus ad_catalog.
--   ad_settings       + Spalten  Assistent (builder_enabled, DSA, Standard-Seite,
--                                -Pixel, -Link) und Autopilot (Modus, Not-Aus,
--                                Ziel-Kosten pro Termin-Äquivalent, Monatsdeckel,
--                                Änderungsfenster, CAPI-Echtzeit, Vorrat-Freigabe).
--
-- Sicherheit:
--   RLS auf jeder neuen Tabelle. Lesen: current_user_has_perm('werbung') oder
--   current_user_has_perm('werbung_meta') (gleicher Kreis wie ad_catalog,
--   ad_insights_daily, ad_settings). Schreiben aus dem Browser nur in
--   meta_drafts (Inhaltsspalten). Keine DELETE-Policy, nirgends.
--   Der Schutz-Trigger für ad_settings (werbe_settings_guard: Hochstellen und
--   Einschalten nur Admin, jede Änderung ins Autopilot-Log) liegt bewusst in
--   20261003110000_werbe_autopilot.sql, weil er ad_autopilot_log braucht. Beide
--   Dateien zusammen und in dieser Reihenfolge einspielen.
--
-- Alle Schalter starten aus: builder_enabled=false, capi_echtzeit=false,
-- pool_auto_release_level=0, autopilot_mode='schatten' (schreibt nie an Meta).
--
-- Idempotent (mehrfach ausführbar). Als Ganzes in einer Transaktion ausführen.
-- Rückbau: rollback/20261003100000_werbung_fundament.down.sql

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Entwürfe des Kampagnen-Assistenten
-- ---------------------------------------------------------------------------

create table if not exists public.meta_drafts (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(name) between 1 and 200),
  kind               text not null default 'new_campaign'
                     check (kind in ('new_campaign','add_adsets','add_ads','edit')),
  template_key       text,
  spec               jsonb not null default '{}'::jsonb,
  status             text not null default 'draft'
                     check (status in ('draft','validated','creating','partial','created','failed','discarded')),
  validation         jsonb,
  lint               jsonb,
  meta_ids           jsonb not null default '{}'::jsonb,
  target_campaign_id text,
  target_adset_id    text,
  last_error         jsonb,
  run_lease          uuid,
  run_lease_at       timestamptz,
  created_by         uuid references public.profiles(id) on delete set null,
  updated_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists meta_drafts_recent_idx
  on public.meta_drafts (updated_at desc)
  where status <> 'discarded';

comment on table public.meta_drafts is
  'Kampagnen-Assistent: ein Entwurf (Kampagne > Anzeigengruppen > Anzeigen) als DraftSpec-jsonb (src/lib/metaSpec.ts, spec.v = 1). Anlegen bei Meta läuft immer aus dieser Zeile (wiederaufnehmbar, alles PAUSED). Status, Meta-IDs, Prüfergebnis und Lease schreibt nur meta-builder.';
comment on column public.meta_drafts.meta_ids is
  'Bei Meta angelegte Objekte: {campaign, adsets:{key:id}, creatives:{key:id}, ads:{key:id}, media:{...}}. Wird nach jedem einzelnen POST fortgeschrieben.';
comment on column public.meta_drafts.validation is
  'Ergebnis von meta-builder validate (lokal, Lint, Meta validate_only je Ebene, Leitplanke) mit Zeitstempel.';
comment on column public.meta_drafts.last_error is
  'Letzter Fehler beim Anlegen: {step, key, code, subcode, user_msg}.';
comment on column public.meta_drafts.run_lease is
  'Sperre gegen doppelte Anlege-Läufe (meta-builder create/resume), mit run_lease_at.';

-- Schutz-Trigger: setzt Autor und Zeitstempel und verhindert, dass ein
-- Mitarbeiter den Inhalt ändert, während der Entwurf bei Meta angelegt wird
-- oder schon angelegt ist (sonst passen spec und meta_ids nicht mehr
-- zusammen). Die Service-Role (meta-builder) ist ausgenommen.
create or replace function public.meta_drafts_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    if v_uid is not null then
      new.created_by := v_uid;
      new.updated_by := v_uid;
    end if;
    new.updated_at := now();
    return new;
  end if;

  if v_uid is not null then
    if new.spec is distinct from old.spec
       and old.status in ('creating','created') then
      raise exception 'Dieser Entwurf wird gerade bei Meta angelegt oder ist schon angelegt. Änderungen bitte als neuen Entwurf.'
        using errcode = '55000';
    end if;
    new.updated_by := v_uid;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists meta_drafts_guard on public.meta_drafts;
create trigger meta_drafts_guard
  before insert or update on public.meta_drafts
  for each row execute function public.meta_drafts_guard();

alter table public.meta_drafts enable row level security;

drop policy if exists meta_drafts_lesen on public.meta_drafts;
create policy meta_drafts_lesen on public.meta_drafts
  for select to authenticated
  using ((select public.current_user_has_perm('werbung'))
         or (select public.current_user_has_perm('werbung_meta')));

drop policy if exists meta_drafts_anlegen on public.meta_drafts;
create policy meta_drafts_anlegen on public.meta_drafts
  for insert to authenticated
  with check ((select public.current_user_has_perm('werbung'))
              or (select public.current_user_has_perm('werbung_meta')));

drop policy if exists meta_drafts_aendern on public.meta_drafts;
create policy meta_drafts_aendern on public.meta_drafts
  for update to authenticated
  using ((select public.current_user_has_perm('werbung'))
         or (select public.current_user_has_perm('werbung_meta')))
  with check ((select public.current_user_has_perm('werbung'))
              or (select public.current_user_has_perm('werbung_meta')));

-- Spaltenrechte: der Browser schreibt nur Inhalt. Kein Löschen (Verwerfen =
-- meta-builder discard setzt status 'discarded').
revoke all on table public.meta_drafts from anon, authenticated;
grant select on table public.meta_drafts to authenticated;
grant insert (id, name, kind, template_key, spec, target_campaign_id, target_adset_id)
  on table public.meta_drafts to authenticated;
grant update (name, kind, template_key, spec, target_campaign_id, target_adset_id, updated_by, updated_at)
  on table public.meta_drafts to authenticated;
grant all on table public.meta_drafts to service_role;

-- ---------------------------------------------------------------------------
-- 2. Spiegel: Kampagnen und Anzeigengruppen aus Meta
-- ---------------------------------------------------------------------------

create table if not exists public.meta_campaigns (
  campaign_id                     text primary key,
  account_id                      text,
  name                            text,
  objective                       text,
  status                          text,
  effective_status                text,
  buying_type                     text,
  special_ad_categories           text[] default '{}'::text[],
  special_ad_category_country     text[] default '{}'::text[],
  daily_budget_cents              bigint,
  lifetime_budget_cents           bigint,
  spend_cap_cents                 bigint,
  bid_strategy                    text,
  is_adset_budget_sharing_enabled boolean,
  start_time                      timestamptz,
  stop_time                       timestamptz,
  advantage_state                 text,
  advantage_state_info            jsonb,
  issues                          jsonb,
  created_time                    timestamptz,
  updated_time                    timestamptz,
  draft_id                        uuid,
  raw                             jsonb,
  synced_at                       timestamptz not null default now()
);

comment on table public.meta_campaigns is
  'Spiegel der Meta-Kampagnen (Ziel, Sonderkategorie, Budget in USD-Cent, Gebotsstrategie, effective_status). Schreibt nur die Service-Role (meta-ads-sync, meta-builder Rücklesen). draft_id = Entwurf, aus dem die Kampagne angelegt wurde (ohne Fremdschlüssel, damit der Sync nie daran scheitert).';
comment on column public.meta_campaigns.daily_budget_cents is
  'Tagesbudget in Cent der Kontowährung (USD), wie Meta es liefert. EUR nur umgerechnet anzeigen.';

create table if not exists public.meta_adsets (
  adset_id              text primary key,
  campaign_id           text,
  account_id            text,
  name                  text,
  status                text,
  effective_status      text,
  daily_budget_cents    bigint,
  lifetime_budget_cents bigint,
  bid_strategy          text,
  bid_amount_cents      bigint,
  optimization_goal     text,
  billing_event         text,
  destination_type      text,
  promoted_object       jsonb,
  attribution_spec      jsonb,
  targeting             jsonb,
  dsa_beneficiary       text,
  dsa_payor             text,
  learning_status       text,
  learning_conversions  integer,
  last_sig_edit_ts      timestamptz,
  learning_stage_info   jsonb,
  start_time            timestamptz,
  end_time              timestamptz,
  issues                jsonb,
  created_time          timestamptz,
  updated_time          timestamptz,
  draft_id              uuid,
  raw                   jsonb,
  synced_at             timestamptz not null default now()
);

create index if not exists meta_adsets_campaign_idx
  on public.meta_adsets (campaign_id);

comment on table public.meta_adsets is
  'Spiegel der Meta-Anzeigengruppen (Optimierungsziel, promoted_object mit Pixel, Attribution, Targeting, DSA, Lernstatus). Schreibt nur die Service-Role. Grundlage für Lernschutz, Pixel-Abgleich und Budget-Leitplanke.';
comment on column public.meta_adsets.last_sig_edit_ts is
  'Letzte wesentliche Änderung laut Meta (learning_stage_info). Lernschutz: 72 h danach keine Automatik.';

-- ---------------------------------------------------------------------------
-- 3. Medien für den Assistenten
-- ---------------------------------------------------------------------------

create table if not exists public.meta_media (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('image','video')),
  storage_path       text not null,
  public_url         text,
  aspect             text check (aspect in ('4:5','9:16','1:1','1.91:1','other')),
  width              integer,
  height             integer,
  bytes              bigint,
  sha256             text unique,
  meta_image_hash    text,
  meta_video_id      text,
  thumbnail_hash     text,
  meta_status        text not null default 'pending'
                     check (meta_status in ('pending','uploading','processing','ready','error')),
  meta_error         jsonb,
  ai_generated       boolean not null default false,
  eu_band_confirmed  boolean not null default false,
  ki_label_confirmed boolean not null default false,
  source             text,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists meta_media_recent_idx
  on public.meta_media (created_at desc);

comment on table public.meta_media is
  'Medien des Kampagnen-Assistenten: Datei im Bucket ad-creatives, Meta-Bild-Hash bzw. Video-ID und Upload-Status. sha256 verhindert doppelte Uploads. eu_band_confirmed und ki_label_confirmed sind die Pflicht-Bestätigungen je Medium. Schreibt nur meta-builder (Service-Role).';

create or replace function public.meta_media_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists meta_media_touch on public.meta_media;
create trigger meta_media_touch
  before update on public.meta_media
  for each row execute function public.meta_media_touch();

-- ---------------------------------------------------------------------------
-- 4. Protokoll jedes Schreibzugriffs auf Meta
-- ---------------------------------------------------------------------------

create table if not exists public.meta_write_log (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  actor         uuid,
  actor_kind    text not null default 'system'
                check (actor_kind in ('user','system','autopilot')),
  fn            text not null,
  mode          text,
  entity_level  text,
  entity_id     text,
  draft_id      uuid,
  method        text not null default 'POST',
  path          text not null,
  validate_only boolean not null default false,
  request       jsonb,
  before        jsonb,
  after         jsonb,
  ok            boolean,
  http_status   integer,
  meta_error    jsonb,
  fbtrace_id    text,
  usage         jsonb
);

create index if not exists meta_write_log_ts_idx
  on public.meta_write_log (ts desc);
create index if not exists meta_write_log_entity_idx
  on public.meta_write_log (entity_id, ts desc)
  where entity_id is not null;
create index if not exists meta_write_log_draft_idx
  on public.meta_write_log (draft_id, ts desc)
  where draft_id is not null;

comment on table public.meta_write_log is
  'Jeder Schreibzugriff auf die Meta-API (auch validate_only) aus meta-builder, meta-ads-tools, studio, meta-ads-sync und werbe-ausfuehren. path enthält nie den Token, request ist geschwärzt. Nur anhängen: Ändern und Löschen blockiert ein Trigger, auch für die Service-Role.';
comment on column public.meta_write_log.actor is
  'Profil-ID der auslösenden Person (ohne Fremdschlüssel, damit das Protokoll unverändert bleibt).';

create or replace function public.meta_write_log_nur_anhaengen()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'meta_write_log ist ein Protokoll: Einträge können nicht geändert oder gelöscht werden.'
    using errcode = '42501';
  return null;
end;
$$;

drop trigger if exists meta_write_log_nur_anhaengen on public.meta_write_log;
create trigger meta_write_log_nur_anhaengen
  before update or delete on public.meta_write_log
  for each row execute function public.meta_write_log_nur_anhaengen();

-- ---------------------------------------------------------------------------
-- 5. RLS und Rechte für die nur lesbaren neuen Tabellen
-- ---------------------------------------------------------------------------

alter table public.meta_campaigns enable row level security;
drop policy if exists meta_campaigns_lesen on public.meta_campaigns;
create policy meta_campaigns_lesen on public.meta_campaigns
  for select to authenticated
  using ((select public.current_user_has_perm('werbung'))
         or (select public.current_user_has_perm('werbung_meta')));

alter table public.meta_adsets enable row level security;
drop policy if exists meta_adsets_lesen on public.meta_adsets;
create policy meta_adsets_lesen on public.meta_adsets
  for select to authenticated
  using ((select public.current_user_has_perm('werbung'))
         or (select public.current_user_has_perm('werbung_meta')));

alter table public.meta_media enable row level security;
drop policy if exists meta_media_lesen on public.meta_media;
create policy meta_media_lesen on public.meta_media
  for select to authenticated
  using ((select public.current_user_has_perm('werbung'))
         or (select public.current_user_has_perm('werbung_meta')));

alter table public.meta_write_log enable row level security;
drop policy if exists meta_write_log_lesen on public.meta_write_log;
create policy meta_write_log_lesen on public.meta_write_log
  for select to authenticated
  using ((select public.current_user_has_perm('werbung'))
         or (select public.current_user_has_perm('werbung_meta')));

revoke all on table public.meta_campaigns from anon, authenticated;
revoke all on table public.meta_adsets    from anon, authenticated;
revoke all on table public.meta_media     from anon, authenticated;
revoke all on table public.meta_write_log from anon, authenticated;
grant select on table public.meta_campaigns to authenticated;
grant select on table public.meta_adsets    to authenticated;
grant select on table public.meta_media     to authenticated;
grant select on table public.meta_write_log to authenticated;
grant all on table public.meta_campaigns to service_role;
grant all on table public.meta_adsets    to service_role;
grant all on table public.meta_media     to service_role;
grant all on table public.meta_write_log to service_role;

-- ---------------------------------------------------------------------------
-- 6. ad_catalog: echter Auslieferungsstatus, Prüfhinweise, URL-Parameter
-- ---------------------------------------------------------------------------

alter table public.ad_catalog
  add column if not exists effective_status  text,
  add column if not exists configured_status text,
  add column if not exists issues_info       jsonb,
  add column if not exists review_feedback   jsonb,
  add column if not exists url_tags          text,
  add column if not exists created_time      timestamptz,
  add column if not exists updated_time      timestamptz,
  add column if not exists draft_id          uuid;

comment on column public.ad_catalog.effective_status is
  'Auslieferungsstatus laut Meta (z. B. CAMPAIGN_PAUSED, DISAPPROVED). status bleibt der eigene Status der Anzeige. Anzeige: effective_status ?? status.';
comment on column public.ad_catalog.review_feedback is
  'ad_review_feedback von Meta (Ablehnungsgründe).';
comment on column public.ad_catalog.url_tags is
  'URL-Parameter des Creatives. Standard: utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}.';
comment on column public.ad_catalog.draft_id is
  'Entwurf des Kampagnen-Assistenten (meta_drafts.id), aus dem die Anzeige angelegt wurde. Ohne Fremdschlüssel, damit der Sync nie daran scheitert.';

-- ---------------------------------------------------------------------------
-- 7. ad_insights_daily: Ebenen-Zuordnung und zusätzliche Kennzahlen
-- ---------------------------------------------------------------------------

alter table public.ad_insights_daily
  add column if not exists campaign_id        text,
  add column if not exists adset_id           text,
  add column if not exists video_3s_true      integer not null default 0,
  add column if not exists thruplays          integer not null default 0,
  add column if not exists platform_schedules integer not null default 0;

create index if not exists ad_insights_daily_adset_day_idx
  on public.ad_insights_daily (adset_id, day);

comment on column public.ad_insights_daily.campaign_id is
  'Kampagne der Anzeige am Tag des Syncs (bisher nur über ad_catalog joinbar).';
comment on column public.ad_insights_daily.adset_id is
  'Anzeigengruppe der Anzeige am Tag des Syncs.';
comment on column public.ad_insights_daily.video_3s_true is
  'Echte 3-Sekunden-Videoaufrufe (video_play_actions bzw. 3-Sekunden-Metrik), Grundlage der Hook-Rate.';
comment on column public.ad_insights_daily.thruplays is
  'ThruPlays (15 s oder ganz angesehen).';
comment on column public.ad_insights_daily.platform_schedules is
  'Schedule-Conversions laut Meta (Pixel/CAPI), zum Abgleich mit CRM-Terminen.';

-- Einmaliges Nachtragen aus dem Katalog. Idempotent: nur leere Zeilen.
update public.ad_insights_daily i
   set campaign_id = coalesce(i.campaign_id, c.campaign_id),
       adset_id    = coalesce(i.adset_id, c.adset_id)
  from public.ad_catalog c
 where c.ad_id = i.ad_id
   and c.platform = i.platform
   and (i.campaign_id is null or (i.adset_id is null and c.adset_id is not null));

-- ---------------------------------------------------------------------------
-- 8. ad_settings: Felder für Assistent und Autopilot
-- ---------------------------------------------------------------------------

alter table public.ad_settings
  add column if not exists builder_enabled                 boolean not null default false,
  add column if not exists dsa_beneficiary                 text,
  add column if not exists dsa_payor                       text,
  add column if not exists default_page_id                 text default '556440087559971',
  add column if not exists default_ig_user_id              text,
  add column if not exists default_pixel_id                text default '1083578343946189',
  add column if not exists default_link                    text default 'https://portal.happy-property.com/termin',
  add column if not exists autopilot_mode                  text not null default 'schatten',
  add column if not exists autopilot_paused_until          timestamptz,
  add column if not exists autopilot_stop_grund            text,
  add column if not exists target_cpte_eur                 numeric not null default 145,
  add column if not exists monthly_cap_eur                 numeric not null default 7500,
  add column if not exists max_auto_actions_per_day        integer not null default 5,
  add column if not exists kap_floor                       numeric not null default 0.4,
  add column if not exists change_window_dows              smallint[] not null default '{1,4}'::smallint[],
  add column if not exists utm_campaign_map                jsonb not null default '{}'::jsonb,
  add column if not exists capi_echtzeit                   boolean not null default false,
  add column if not exists capi_test_event_code            text,
  add column if not exists pool_auto_release_level         smallint not null default 0,
  add column if not exists pool_auto_release_threshold     numeric not null default 0.9,
  add column if not exists budget_autonomie_freigegeben_at timestamptz,
  add column if not exists budget_autonomie_von            uuid;

-- Fremdschlüssel und Prüfregeln getrennt und nur, wenn sie fehlen (idempotent;
-- ADD COLUMN IF NOT EXISTS mit Inline-Constraint ist dafür nicht verlässlich).
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ad_settings'::regclass
                    and conname = 'ad_settings_budget_autonomie_von_fkey') then
    alter table public.ad_settings add constraint ad_settings_budget_autonomie_von_fkey
      foreign key (budget_autonomie_von) references public.profiles(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ad_settings'::regclass
                    and conname = 'ad_settings_autopilot_mode_check') then
    alter table public.ad_settings add constraint ad_settings_autopilot_mode_check
      check (autopilot_mode in ('aus','schatten','vorschlag','ein_klick','autonom'));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ad_settings'::regclass
                    and conname = 'ad_settings_pool_auto_release_level_check') then
    alter table public.ad_settings add constraint ad_settings_pool_auto_release_level_check
      check (pool_auto_release_level between 0 and 3);
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ad_settings'::regclass
                    and conname = 'ad_settings_pool_auto_release_threshold_check') then
    alter table public.ad_settings add constraint ad_settings_pool_auto_release_threshold_check
      check (pool_auto_release_threshold between 0 and 1);
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ad_settings'::regclass
                    and conname = 'ad_settings_kap_floor_check') then
    alter table public.ad_settings add constraint ad_settings_kap_floor_check
      check (kap_floor between 0 and 1);
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ad_settings'::regclass
                    and conname = 'ad_settings_target_cpte_eur_check') then
    alter table public.ad_settings add constraint ad_settings_target_cpte_eur_check
      check (target_cpte_eur > 0);
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ad_settings'::regclass
                    and conname = 'ad_settings_monthly_cap_eur_check') then
    alter table public.ad_settings add constraint ad_settings_monthly_cap_eur_check
      check (monthly_cap_eur >= 0);
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ad_settings'::regclass
                    and conname = 'ad_settings_max_auto_actions_per_day_check') then
    alter table public.ad_settings add constraint ad_settings_max_auto_actions_per_day_check
      check (max_auto_actions_per_day between 0 and 50);
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ad_settings'::regclass
                    and conname = 'ad_settings_change_window_dows_check') then
    alter table public.ad_settings add constraint ad_settings_change_window_dows_check
      check (change_window_dows <@ '{0,1,2,3,4,5,6,7}'::smallint[]);
  end if;
end;
$$;

comment on column public.ad_settings.builder_enabled is
  'Not-Aus des Kampagnen-Assistenten: solange false, verweigert meta-builder jeden schreibenden Modus. Einschalten nur Admin (werbe_settings_guard).';
comment on column public.ad_settings.dsa_beneficiary is
  'DSA Begünstigte Person. Leer = Standard aus dem Werbekonto (default_dsa_beneficiary). Im Assistenten je Anzeigengruppe änderbar.';
comment on column public.ad_settings.dsa_payor is
  'DSA Zahlende Person. Leer = Standard aus dem Werbekonto (default_dsa_payor).';
comment on column public.ad_settings.autopilot_mode is
  'Betriebsart des Autopiloten, aufsteigend: aus < schatten < vorschlag < ein_klick < autonom. Start schatten (rechnet und protokolliert, schreibt nie an Meta). Hochstellen nur Admin.';
comment on column public.ad_settings.autopilot_paused_until is
  'Not-Aus bis zu diesem Zeitpunkt (Stopp-Knopf oder Stopp-Bedingung). Stoppen darf jeder mit Werbe-Recht.';
comment on column public.ad_settings.target_cpte_eur is
  'Ziel-Kosten pro Termin-Äquivalent (TE) in EUR, Grundlage der Kill- und Budgetregeln.';
comment on column public.ad_settings.monthly_cap_eur is
  'Monatsdeckel in EUR für die Prognose (Summe aktiver Tagesbudgets x Tage).';
comment on column public.ad_settings.max_auto_actions_per_day is
  'Höchstzahl automatischer Aktionen je Tag; darüber stoppt der Autopilot.';
comment on column public.ad_settings.kap_floor is
  'Mindestanteil Leads mit Kapitalbasis Ja für Budget-Erhöhungen (S1).';
comment on column public.ad_settings.change_window_dows is
  'Änderungsfenster für wesentliche Änderungen als ISO-Wochentage in Europe/Berlin (1 = Montag, 4 = Donnerstag).';
comment on column public.ad_settings.utm_campaign_map is
  'Zuordnung alter utm_campaign-Namen zu Kampagnen-IDs, z. B. {"20.03.26 - TOF - Leads": "120240945699430314"}. Nutzt ads_lead_attribution nur als Rückfall.';
comment on column public.ad_settings.capi_echtzeit is
  'CAPI in Echtzeit über capi_outbox und werbe-signal. Start aus; der Tageslauf bleibt Nachhol-Netz.';
comment on column public.ad_settings.capi_test_event_code is
  'Meta test_event_code für CAPI-Tests (nur mit Svens eigenen Testdaten).';
comment on column public.ad_settings.pool_auto_release_level is
  'Werbemittel-Vorrat: 0 immer manuell (Start), 1 Prognose anzeigen, 2 automatisch ab Schwelle nach >= 30 Entscheidungen mit >= 90 % Treffer, 3 voll automatisch. Hochstellen nur Admin.';
comment on column public.ad_settings.pool_auto_release_threshold is
  'Mindest-Freigabe-Prognose (0-1) für automatische Freigabe ab Stufe 2.';
comment on column public.ad_settings.budget_autonomie_freigegeben_at is
  'Zeitpunkt, ab dem Budgetregeln autonom (Stufe 3) laufen dürfen. Nur Admin, mit budget_autonomie_von.';

notify pgrst, 'reload schema';

commit;
