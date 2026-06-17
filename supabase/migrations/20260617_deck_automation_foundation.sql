-- Stage A — Fundament für die Sales-Deck-Automatisierung.
-- 1) Unit-Status 'proposal' = automatisch aus der Preisliste importierte Wohnungen.
--    Die echte Auswahl (UnitPicker/ProjectSelection) zeigt nur active/under_construction,
--    d.h. 'proposal' erscheint NUR im Deck-Wizard. Graduierung bei Kundenzuordnung:
--    proposal -> under_construction.
-- 2) source = Herkunft (drive_import), damit graduierte Units nachvollziehbar bleiben.
-- 3) crm_projects.deck_token = generisches Projekt-Deck (im Zoom teilbar).

alter table crm_project_units drop constraint if exists crm_project_units_status_check;
alter table crm_project_units add  constraint crm_project_units_status_check
  check (status = any (array['available','reserved','sold','under_construction','active','proposal']));

alter table crm_project_units add column if not exists source text;  -- z.B. 'drive_import'

alter table crm_projects add column if not exists deck_token        text;
alter table crm_projects add column if not exists deck_generated_at timestamptz;

comment on column crm_project_units.source is 'Herkunft der Unit, z.B. drive_import (Preislisten-Parser). NULL = manuell angelegt.';
comment on column crm_projects.deck_token is 'Token des generischen Projekt-Decks (/deck/<token>) zum Teilen im Zoom.';
