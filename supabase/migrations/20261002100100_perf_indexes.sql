-- -----------------------------------------------------------------------------
-- Indizes auf Fremdschlüssel, nach denen das CRM wirklich filtert (Audit P4-5)
--
-- Live geprüft am 2.10.2026 (nur lesend, pg_indexes + information_schema.columns):
-- alle sieben Spalten existieren (uuid), keine Tabelle hat schon einen Index, der mit
-- dieser Spalte beginnt, und keiner der neuen Namen ist irgendwo vergeben.
--   deals.lead_id                  LeadDetail, Users, DevMails u. a. (.eq('lead_id'))
--   deals.unit_id                  DeckWizard, StrategySimulator (belegte Wohnungen)
--   sales_decks.lead_id            partner-akte (alle 10 Min.), newsletter-campaign
--   crm_project_units.property_id  DeckWizard u. a.
--   property_calculations.lead_id  partner-akte (alle 10 Min.), LeadAngebote
--   deck_outbox.lead_id            src/lib/calcOutbox.ts
--   deal_projects.deal_id          ProjectSelectionModal
--
-- Rein additiv: keine Daten, keine Spalte, keine Policy, kein bestehender Index wird
-- geändert oder gelöscht (auch keine laut Advisor "unbenutzten" Indizes: die Statistik
-- wurde beim Neustart am 30.9. zurückgesetzt). Ergebnisse von Abfragen ändern sich nicht,
-- nur der Weg dorthin. Heute sind die Tabellen klein (je höchstens 0,2 MB), der Nutzen
-- wächst mit den Daten.
--
-- Bewusst einfaches CREATE INDEX (nicht CONCURRENTLY), damit es in einer Transaktion läuft.
-- Es sperrt Schreibzugriffe auf die jeweilige Tabelle nur für Millisekunden. Trotzdem zu einer
-- ruhigen Zeit einspielen, nicht während andere Sitzungen die Datenbank belasten.
-- Idempotent (if not exists).
--
-- Rückweg: supabase/migrations/rollback/20261002100100_perf_indexes.down.sql
-- -----------------------------------------------------------------------------

set local lock_timeout = '3s';

create index if not exists idx_deals_lead_id                 on public.deals (lead_id);
create index if not exists idx_deals_unit_id                 on public.deals (unit_id);
create index if not exists idx_sales_decks_lead_id           on public.sales_decks (lead_id);
create index if not exists idx_crm_project_units_property_id on public.crm_project_units (property_id);
create index if not exists idx_property_calculations_lead_id on public.property_calculations (lead_id);
create index if not exists idx_deck_outbox_lead_id           on public.deck_outbox (lead_id);
create index if not exists idx_deal_projects_deal_id         on public.deal_projects (deal_id);
