-- Rückweg zu 20261002100100_perf_indexes.sql (Audit P4-5), von Hand ausführen. Liegt bewusst
-- in rollback/, damit die Supabase-CLI die Datei nicht als Migration einspielt.
-- Entfernt genau die sieben neuen Indizes, sonst hat die Migration nichts angelegt oder
-- geändert. Keine Daten betroffen, Abfrageergebnisse bleiben gleich.

set local lock_timeout = '3s';

drop index if exists public.idx_deals_lead_id;
drop index if exists public.idx_deals_unit_id;
drop index if exists public.idx_sales_decks_lead_id;
drop index if exists public.idx_crm_project_units_property_id;
drop index if exists public.idx_property_calculations_lead_id;
drop index if exists public.idx_deck_outbox_lead_id;
drop index if exists public.idx_deal_projects_deal_id;
