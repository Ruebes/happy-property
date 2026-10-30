-- MwSt je Kontobewegung, damit die Auswertung netto rechnen kann (Sven 30.10.2026).
-- Bereits am 30.10.2026 per Management-API angewendet; idempotent.
-- Befüllt: Eingänge aus crm_invoices (vat_source 'rechnung'), Ausgaben aus den
-- Belegen (vat_source 'beleg', nur abziehbare zypriotische MwSt; deutsche MwSt,
-- Reverse Charge und Auslandsrechnungen = 0).
alter table fin_transactions
  add column if not exists vat_amount numeric,
  add column if not exists vat_source text;

comment on column fin_transactions.vat_amount is
  'MwSt-Anteil am Betrag in EUR, immer positiv (Umsatzsteuer bei Eingang, Vorsteuer bei Ausgang). NULL = nicht ermittelt, 0 = keine MwSt (z.B. Reverse Charge, Ausland).';
comment on column fin_transactions.vat_source is
  'rechnung (eigene crm_invoices) | beleg (aus Beleg gelesen) | manuell';
