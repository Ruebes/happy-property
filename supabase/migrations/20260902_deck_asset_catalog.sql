-- ── Asset-Katalog: stabile Identität für jedes Deck-Bild ──────────────────────
-- Heute ist die Storage-URL die Identität eines Bildes. Das ist fragil: ein
-- angehängter Transform-Parameter (?width=512) macht dasselbe Bild zu einem
-- „unbekannten" Bild und lässt z.B. die URL-Allowlist in refine-deck hart
-- abbrechen. Ausserdem lebt die Kategorie nur im jsonb-Blob crm_projects
-- .deck_assets.gallery, den fünf Codestellen im Read-modify-write überschreiben.
--
-- Ab jetzt: eine Zeile je Bild, stabile uuid, URL ist nur noch ein Attribut.
-- Der Blob bleibt bestehen (kein Bruch bestehender Leser) und wird parallel
-- weitergeschrieben, bis alle Leser auf den Katalog umgestellt sind.

create table if not exists deck_assets_catalog (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references crm_projects(id) on delete cascade,

  -- Herkunft: woher stammt die Datei ursprünglich?
  source              text not null default 'drive'
                        check (source in ('drive','dropbox','upload','brochure','higgsfield','generated')),
  source_file_id      text,          -- Drive-File-ID / Dropbox-Pfad / Ursprungs-Asset
  source_file_name    text,
  source_modified_at  timestamptz,

  -- Ablage im Supabase-Storage
  storage_bucket      text not null default 'deck-assets',
  storage_path        text not null,
  storage_url         text not null,

  -- Was ist das für ein Bild?
  source_type         text not null default 'other'
                        check (source_type in ('developer_render','ai_generated','floorplan','map','other')),
  primary_category    text,          -- wohnzimmer | pool | fassade | …
  secondary_categories text[] not null default '{}',
  description         text,          -- ein Satz, was zu sehen ist
  confidence          numeric,       -- 0..1 aus der Vision-Analyse

  -- Verwendungssteuerung (Bildzuordnung fragt NUR das ab)
  allowed_uses        text[] not null default '{}',
  excluded_uses       text[] not null default '{}',

  -- Bindung an eine konkrete Wohnung (nur Grundrisse) — kanonischer Schlüssel
  unit_key            text,
  unit_id             uuid references crm_project_units(id) on delete set null,

  -- Betriebsdaten
  bytes               bigint,
  width               integer,
  height              integer,
  active              boolean not null default true,
  meta                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table deck_assets_catalog is
  'Stabile Identität je Deck-Bild. Die id überlebt jeden URL-Wechsel; Deck-Blöcke referenzieren perspektivisch asset_id statt einer URL.';
comment on column deck_assets_catalog.allowed_uses is
  'Blockthemen, für die dieses Bild verwendet werden DARF (z.B. wohnzimmer, wohnen, living).';
comment on column deck_assets_catalog.excluded_uses is
  'Blockthemen, für die dieses Bild NIEMALS verwendet werden darf (z.B. grundriss, marina).';

-- Ein Storage-Objekt genau einmal im Katalog.
create unique index if not exists deck_assets_catalog_path_uidx
  on deck_assets_catalog (storage_bucket, storage_path);
-- Dieselbe Drive-Datei nicht doppelt importieren.
create unique index if not exists deck_assets_catalog_source_uidx
  on deck_assets_catalog (project_id, source, source_file_id)
  where source_file_id is not null;
create index if not exists deck_assets_catalog_project_idx  on deck_assets_catalog (project_id, active);
create index if not exists deck_assets_catalog_category_idx on deck_assets_catalog (project_id, primary_category);
create index if not exists deck_assets_catalog_unit_idx     on deck_assets_catalog (project_id, unit_key)
  where unit_key is not null;
-- Rückweg URL -> Asset (Migration bestehender Decks, refine-deck-Allowlist).
create index if not exists deck_assets_catalog_url_idx      on deck_assets_catalog (storage_url);

alter table deck_assets_catalog enable row level security;
drop policy if exists deck_assets_catalog_staff on deck_assets_catalog;
create policy deck_assets_catalog_staff on deck_assets_catalog for all to authenticated
  using      ((select role from profiles where id = auth.uid()) in ('admin','verwalter'))
  with check ((select role from profiles where id = auth.uid()) in ('admin','verwalter'));
drop policy if exists deck_assets_catalog_staff_perm on deck_assets_catalog;
create policy deck_assets_catalog_staff_perm on deck_assets_catalog for all to authenticated
  using (current_user_has_perm('decks')) with check (current_user_has_perm('decks'));

-- updated_at automatisch nachziehen.
create or replace function hp_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists deck_assets_catalog_touch on deck_assets_catalog;
create trigger deck_assets_catalog_touch before update on deck_assets_catalog
  for each row execute function hp_touch_updated_at();
