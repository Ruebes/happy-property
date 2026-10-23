-- Provisionsabrechnung nur mit kompletten Stammdaten (Sven 23.10.2026).
-- Ist die Provision fällig und fehlt die Adresse, fragt Lotte ein zweites (letztes) Mal,
-- jetzt mit „<Kunde> hat gekauft“. Merker, damit das genau einmal passiert.
-- Rücknahme: rollback/20261023110000_affiliate_due_request.down.sql
alter table public.affiliates
  add column if not exists address_due_requested_at timestamptz;
