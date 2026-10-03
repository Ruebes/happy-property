-- ─────────────────────────────────────────────────────────────────────────────
-- Werbemanager: neue Aktionsarten in ad_actions (SPEC.md §2, PLAN-B §0).
-- Stand 3.10.2026.
--
-- !!! ALS LETZTE MIGRATION EINSPIELEN: erst wenn das neue Frontend (Reiter
-- Autopilot rendert unbekannte Aktionen neutral) UND werbe-ausfuehren /
-- meta-ads-sync mit _shared/werbeAusfuehren.ts live sind, und nach Svens
-- „jetzt live“. Danach offene PWA-Tabs schließen und neu öffnen. !!!
-- Grund: der alte Executor (meta-ads-sync v18) und die alte Oberfläche kennen
-- nur pause/activate (Lehre „Live-Bundle-Enum-Crash“ 26.9.).
--
-- Erweitert ad_actions_action_check um budget_set, ersatz_hochladen,
-- ersatz_aktivieren. Status-Werte bleiben unverändert (Vorschläge = status NULL).
-- Rückbau: rollback/20261003119000_ad_actions_aktionen.down.sql
-- ─────────────────────────────────────────────────────────────────────────────

begin;

set local lock_timeout = '5s';

alter table public.ad_actions drop constraint if exists ad_actions_action_check;
alter table public.ad_actions add constraint ad_actions_action_check
  check (action in ('pause', 'activate', 'budget_set', 'ersatz_hochladen', 'ersatz_aktivieren'));

notify pgrst, 'reload schema';

commit;
