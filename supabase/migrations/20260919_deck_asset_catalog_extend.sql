-- ── Asset-Katalog aktivieren (Schritt 2 der Deck-Härtung, 19.9.2026) ─────────
-- deck_assets_catalog existierte seit 2.9., wurde aber von niemandem gelesen
-- oder geschrieben. Ab jetzt ist er die maßgebliche Bildquelle der Deck-
-- Generierung. Der jsonb-Blob crm_projects.deck_assets bleibt als
-- Kompatibilitätsschicht bestehen (Wizard, Projektseite, Alt-Decks) und wird
-- nach jedem Import per hp_sync_deck_assets_catalog() in den Katalog gespiegelt.
--
-- Additiv: keine Spalte wird entfernt oder umbenannt.

alter table deck_assets_catalog
  -- Welcher Wohnungstyp ist zu sehen? project_generic = Anlage/Umgebung, gilt für alle.
  add column if not exists property_type text not null default 'unknown'
    check (property_type in ('apartment','villa','townhouse','project_generic','unknown')),
  -- Klassifizierung ≠ Freigabe: review = Ordner und Vision widersprechen sich oder
  -- Confidence niedrig; solche Bilder kommen nie automatisch auf cover/unit.
  add column if not exists status text not null default 'unclassified'
    check (status in ('unclassified','classified','approved','review','rejected')),
  add column if not exists generated_from_asset_id uuid references deck_assets_catalog(id) on delete set null,
  -- Nur Grundrisse: trägt der Bauträgerplan Maßketten? HP-Plan übernimmt den Zustand.
  add column if not exists dimensions_present boolean,
  add column if not exists is_vector boolean,
  add column if not exists floor_labels text[] not null default '{}',
  add column if not exists source_page integer,
  add column if not exists crop_rect jsonb,
  -- Kurze Bildunterschrift (Vision) — bisher nur im jsonb.
  add column if not exists label text,
  -- Drive-Ordnername, aus dem das Bild stammt (Bauteil-Hinweis: "Block A Mamba").
  add column if not exists folder_hint text,
  -- Ausdrückliche Grundriss-Freigabe: dieser Plan gilt auch für Wohnung X
  -- (baugleich oder gespiegelt). Nur von Hand gesetzt, nie automatisch.
  add column if not exists same_layout_as text[] not null default '{}',
  add column if not exists mirror_of text,
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_at timestamptz;

comment on column deck_assets_catalog.property_type is
  'apartment | villa | townhouse | project_generic (Anlage, Pool, Umgebung — für jeden Typ erlaubt) | unknown (nie automatisch auf cover/unit)';
comment on column deck_assets_catalog.status is
  'unclassified → classified (Vision eindeutig) → approved (Sven) · review (Widerspruch/unsicher) · rejected';
comment on column deck_assets_catalog.same_layout_as is
  'Wohnungsnummern (unit_key), für die dieser Grundriss ausdrücklich freigegeben ist (baugleich). Ersetzt den abgeschalteten Zwillings-Automatismus.';

create index if not exists deck_assets_catalog_type_idx on deck_assets_catalog (project_id, property_type, status) where active;

-- ── Spiegel jsonb → Katalog ───────────────────────────────────────────────────
-- Idempotent: eine Zeile je (bucket, storage_path). Vorhandene Zeilen behalten
-- approved/rejected/review und Hand-Felder; Kategorie/Label/Typ werden aus dem
-- Blob nachgezogen, solange die Zeile nicht von Hand freigegeben wurde.
create or replace function hp_sync_deck_assets_catalog(p_project_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_da jsonb;
  v_n integer := 0;
  v_marker constant text := '/storage/v1/object/public/deck-assets/';
begin
  select deck_assets into v_da from crm_projects where id = p_project_id;
  if v_da is null then return 0; end if;

  -- 1) Galerie (kategorisierte Renders)
  with g as (
    select distinct on (x->>'url')
      x->>'url' as url,
      x->>'category' as category,
      nullif(x->>'label','') as label,
      lower(coalesce(x->>'unitType','')) as ut,
      (select k from jsonb_each_text(coalesce(v_da->'render_sources','{}'::jsonb)) e(k,v) where v = x->>'url' limit 1) as drive_id
    from jsonb_array_elements(coalesce(v_da->'gallery','[]'::jsonb)) x
    where x->>'url' like '%' || v_marker || '%'
    order by x->>'url'
  ), ins as (
    insert into deck_assets_catalog
      (project_id, source, source_file_id, storage_bucket, storage_path, storage_url, source_type,
       primary_category, label, property_type, status, confidence)
    select
      p_project_id,
      case when url like '%/brochure/%' then 'brochure' else 'drive' end,
      drive_id,
      'deck-assets',
      split_part(url, v_marker, 2),
      url,
      'developer_render',
      category,
      label,
      case ut when 'villa' then 'villa' when 'townhouse' then 'townhouse' when 'apartment' then 'apartment'
              when 'anlage' then 'project_generic' else 'unknown' end,
      case when ut in ('villa','townhouse','apartment','anlage') then 'classified' else 'unclassified' end,
      null
    from g
    on conflict (storage_bucket, storage_path) do update set
      primary_category = excluded.primary_category,
      label = coalesce(excluded.label, deck_assets_catalog.label),
      -- Typ/Status nur nachziehen, solange nicht von Hand entschieden
      property_type = case when deck_assets_catalog.status in ('approved','rejected','review') then deck_assets_catalog.property_type else excluded.property_type end,
      status = case when deck_assets_catalog.status in ('approved','rejected','review') then deck_assets_catalog.status else excluded.status end,
      source_file_id = coalesce(deck_assets_catalog.source_file_id, excluded.source_file_id),
      active = true
    returning 1
  ) select count(*) into v_n from ins;

  -- 2) Grundrisse (Drive-Import, Etagen-Liste) — als Quelle, nie direkt als Deck-Bild
  with f as (
    select distinct on (x->>'url') x->>'url' as url, nullif(x->>'label','') as label, (x->>'floor')::int as floor
    from jsonb_array_elements(case when jsonb_typeof(v_da->'floorplans') = 'array' then v_da->'floorplans' else '[]'::jsonb end) x
    where x->>'url' like '%' || v_marker || '%'
    order by x->>'url'
  )
  insert into deck_assets_catalog
    (project_id, source, storage_bucket, storage_path, storage_url, source_type, primary_category, label, property_type, status, is_vector, floor_labels)
  select p_project_id, 'drive', 'deck-assets', split_part(url, v_marker, 2), url, 'floorplan', 'grundriss', label, 'unknown', 'unclassified',
         lower(split_part(url, '.', -1)) in ('pdf','svg'),
         case when floor is not null then array[floor::text] else '{}' end
  from f
  on conflict (storage_bucket, storage_path) do update set
    label = coalesce(excluded.label, deck_assets_catalog.label), active = true;

  -- 3) Je Wohnung hinterlegte Pläne (unit_floorplans: HP-Pläne oder Handablage) → unit_key gebunden
  -- Derselbe Plan kann mehreren Wohnungen zugeordnet sein (Typplan "2br", Handablage
  -- für baugleiche Wohnungen): eine Zeile je Datei, die erste Wohnung bindet,
  -- die übrigen stehen als ausdrückliche Freigabe in same_layout_as.
  with u0 as (
    select lower(regexp_replace(e.key, '[^A-Za-z0-9]', '', 'g')) as uk, e.value as url
    from jsonb_each_text(coalesce(v_da->'unit_floorplans','{}'::jsonb)) e
    where e.value like '%' || v_marker || '%'
  ), u as (
    select url, min(uk) as uk, array_remove(array_agg(uk order by uk), min(uk)) as others
    from u0 group by url
  )
  insert into deck_assets_catalog
    (project_id, source, storage_bucket, storage_path, storage_url, source_type, primary_category, property_type, status, unit_key, unit_id, is_vector, same_layout_as)
  select p_project_id,
         case when url like '%/floorplans/hp/%' then 'higgsfield' else 'upload' end,
         'deck-assets', split_part(url, v_marker, 2), url, 'floorplan', 'grundriss',
         coalesce((select case cu.type when 'studio' then 'apartment' when 'apartment' then 'apartment' when 'villa' then 'villa' when 'townhouse' then 'townhouse' else 'unknown' end
                   from crm_project_units cu where cu.project_id = p_project_id and cu.unit_key = u.uk limit 1), 'unknown'),
         'approved',
         u.uk,
         (select cu.id from crm_project_units cu where cu.project_id = p_project_id and cu.unit_key = u.uk limit 1),
         lower(split_part(url, '.', -1)) = 'svg',
         u.others
  from u
  on conflict (storage_bucket, storage_path) do update set
    unit_key = coalesce(deck_assets_catalog.unit_key, excluded.unit_key),
    unit_id = coalesce(deck_assets_catalog.unit_id, excluded.unit_id),
    same_layout_as = coalesce((select array_agg(distinct x) from unnest(deck_assets_catalog.same_layout_as || excluded.same_layout_as) x), '{}'),
    active = true;

  -- 4) Renders, die im aktuellen Blob nicht mehr vorkommen (Galerie neu aufgebaut),
  --    deaktivieren - sonst bleiben alte, ungetaggte Zeilen als Bildquelle stehen.
  update deck_assets_catalog c set active = false
   where c.project_id = p_project_id and c.active and c.source_type = 'developer_render'
     and c.status <> 'approved'
     and not exists (select 1 from jsonb_array_elements(coalesce(v_da->'gallery','[]'::jsonb)) x where x->>'url' = c.storage_url);

  return v_n;
end $$;

comment on function hp_sync_deck_assets_catalog(uuid) is
  'Spiegelt crm_projects.deck_assets (gallery, floorplans, unit_floorplans) in deck_assets_catalog. Idempotent; Hand-Entscheidungen (approved/rejected/review) bleiben.';

-- Einmaliger Backfill über alle Projekte mit Assets.
do $$
declare r record;
begin
  for r in select id from crm_projects where deck_assets is not null loop
    perform hp_sync_deck_assets_catalog(r.id);
  end loop;
end $$;
