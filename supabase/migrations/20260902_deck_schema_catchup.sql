-- ── Nachzieh-Migration: Ist-Zustand der Live-DB kodifizieren ──────────────────
-- Mehrere Spalten wurden direkt über die Management-API angelegt und fehlen in
-- supabase/migrations. Folge: aus dem Repo lässt sich keine frische Umgebung
-- aufbauen, und 20260831_double_apartments.sql schreibt plot_sqm/sort_order,
-- ohne dass sie je angelegt wurden. Diese Migration ist rein additiv und auf der
-- Live-DB ein No-Op (alles IF NOT EXISTS).

-- Sales-Decks: Feinschliff-Status, Revisionszähler, manuelle Freigabe.
alter table sales_decks add column if not exists revision       integer     not null default 0;
alter table sales_decks add column if not exists refining       boolean     not null default false;
alter table sales_decks add column if not exists refine_error   text;
alter table sales_decks add column if not exists refine_summary text;
alter table sales_decks add column if not exists approved_at    timestamptz;

comment on column sales_decks.revision       is 'Zählt bei jedem fertigen Feinschliff hoch (Button-Farbe im CRM).';
comment on column sales_decks.refining       is 'true, solange refine-deck im Hintergrund arbeitet.';
comment on column sales_decks.refine_summary is 'Natürlichsprachige Antwort des letzten Feinschliffs für den Deck-Chat.';
comment on column sales_decks.approved_at    is 'Sven hat das Deck manuell als fertig bestätigt.';

-- Wohnungen: Zweitpreisspalte, Grundstück, Sortierung, Bilder.
alter table crm_project_units add column if not exists price_net_furnished numeric;
alter table crm_project_units add column if not exists plot_sqm            numeric;
alter table crm_project_units add column if not exists sort_order          integer;
alter table crm_project_units add column if not exists hero_image_url      text;
alter table crm_project_units add column if not exists floorplan_url       text;

comment on column crm_project_units.price_net_furnished is 'Zweite Preisspalte des Bauträgers (Nettopreis INKLUSIVE Einrichtungspaket).';

-- Projekte: Möbelpolitik + Rechner-Vorgaben.
alter table crm_projects add column if not exists furniture_cost     numeric;
alter table crm_projects add column if not exists furniture_included boolean;
alter table crm_projects add column if not exists calc_defaults      jsonb;

comment on column crm_projects.furniture_cost     is 'Nettopreis des Einrichtungspakets (projektweiter Standard).';
comment on column crm_projects.furniture_included is 'true = Einrichtung ist laut Stammdaten Teil des Kaufpreises.';
comment on column crm_projects.calc_defaults      is 'Rechner-Vorgaben, u.a. furniture_by_bedrooms { "<zimmer>": <netto> }.';

-- ── EIN kanonischer Wohnungs-Schlüssel ────────────────────────────────────────
-- Heute normalisiert jedes Modul anders: parse-pricelist entfernt alle Nicht-
-- Alphanumerischen, generate-deck macht nur trim+lower, hp-floorplan wieder
-- etwas anderes. Derselbe Schlüssel 'C-202' wird mal zu 'c202', mal zu 'c-202'.
-- Ab jetzt gilt die generierte Spalte als Wahrheit — Fact-Ledger und Quality-Gate
-- binden ausschließlich darauf.
alter table crm_project_units
  add column if not exists unit_key text
  generated always as (lower(regexp_replace(coalesce(unit_number, ''), '[^A-Za-z0-9]', '', 'g'))) stored;

comment on column crm_project_units.unit_key is
  'Kanonischer Wohnungs-Schlüssel (lowercase, nur a-z0-9). EINZIGE gültige Normalisierung — Fact-Ledger, Grundriss-Zuordnung und Quality-Gate binden darauf.';

-- BEWUSST kein UNIQUE: In einem Projekt existieren heute Dubletten (dreimal
-- Wohnung "1"). Ein Unique-Index würde Importe hart brechen. Stattdessen meldet
-- das Quality-Gate mehrdeutige Schlüssel als Konflikt.
create index if not exists crm_project_units_unit_key_idx on crm_project_units (project_id, unit_key);
