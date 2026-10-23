-- Sondervereinbarungen zur Reservierung (Sven 23.10.2026): Sven tippt sie auf Deutsch bei der
-- Wohnungsauswahl (deals.reservation_notes), die Edge Function reservation-agreement übersetzt
-- sie ins Englische und setzt sie in den Reservierungsvertrag. special_terms = {de, en}
-- (Übersetzung je Ausgangstext gemerkt, damit Vorschau und Versand denselben Wortlaut haben).
-- Rücknahme: alter table public.deals drop column if exists reservation_notes;
--            alter table public.reservation_agreements drop column if exists special_terms;
alter table public.deals add column if not exists reservation_notes text;
alter table public.reservation_agreements add column if not exists special_terms jsonb;
