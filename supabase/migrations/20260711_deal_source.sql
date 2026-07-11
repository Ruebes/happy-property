-- Herkunft eines Deals/Termins (z.B. 'newsletter' = Buchung über den
-- Newsletter-Direktlink) — Pipeline färbt die Kachel und zeigt die Quelle.
alter table public.deals add column if not exists source text;
