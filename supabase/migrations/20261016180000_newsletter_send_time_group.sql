-- Persoenliche Versandzeit fuer Newsletter (A/B-Test), 16.10.2026.
-- newsletter-campaign setzt beim Launch fuer Empfaenger mit Oeffnungsmuster
-- 'personal' (Slot zur gewohnten Oeffnungszeit) oder 'holdout' (Vergleichsgruppe,
-- normaler Takt). NULL = kein Muster bzw. Funktion aus.
alter table public.scheduled_messages
  add column if not exists send_time_group text
  check (send_time_group in ('personal', 'holdout'));
