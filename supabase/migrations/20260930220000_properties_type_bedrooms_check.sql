-- ============================================================================
-- Portal-Objekte für Townhouses und Wohnungen mit mehr als 5 Schlafzimmern
-- Befunde F5-3, I1-8, SCH-6, F2b-6 (Audit 2026-09)
--
-- Problem: crm_project_units erlaubt type 'townhouse' und beliebig viele
-- Schlafzimmer, properties aber nur villa/apartment/studio und 0 bis 5
-- Schlafzimmer. Alle Wege, die eine Wohnung ins Eigentümer-Portal kopieren
-- (fn_ensure_deal_property, hp_sync_property_from_unit, create-eigentuemer-access,
-- CRM-Seiten), scheitern deshalb beim ersten verkauften Townhouse (6 Einheiten)
-- bzw. bei der Villa mit 6 Schlafzimmern: Zuweisung bricht ab oder das Portal
-- bleibt still leer.
--
-- Fix: beide Prüfregeln rein additiv erweitern. Keine Zeile wird geändert, alle
-- bestehenden Objekte erfüllen die weiteren Regeln. Keine Funktion wird geändert.
-- Muss VOR 20260930220100_portal_phase_gate.sql laufen (Dateiname sorgt dafür).
--
-- Rücknahme: supabase/migrations/rollback/20260930220000_properties_type_bedrooms_check_rollback.sql
--
-- Prüf-Rezept (nur lesen):
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.properties'::regclass
--      and conname in ('properties_type_check', 'properties_bedrooms_check');
--   -- erwartet: type in (villa, apartment, studio, townhouse), bedrooms 0 bis 20
--   select max(bedrooms) from public.crm_project_units;   -- Stand 30.9.2026: 6
-- ============================================================================

alter table public.properties drop constraint if exists properties_type_check;
alter table public.properties add constraint properties_type_check
  check (type in ('villa', 'apartment', 'studio', 'townhouse'));

alter table public.properties drop constraint if exists properties_bedrooms_check;
alter table public.properties add constraint properties_bedrooms_check
  check (bedrooms >= 0 and bedrooms <= 20);
