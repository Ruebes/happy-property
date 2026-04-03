-- ──────────────────────────────────────────────────────────────
-- Buchungen: Brutto/Netto-Preis-Spalten + Eigentümer-Aufenthalt
-- Ausführen in: Supabase Dashboard → SQL Editor
-- ──────────────────────────────────────────────────────────────

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS price_per_night_gross  numeric,
  ADD COLUMN IF NOT EXISTS price_per_night_net    numeric,
  ADD COLUMN IF NOT EXISTS cleaning_fee_gross     numeric,
  ADD COLUMN IF NOT EXISTS cleaning_fee_net       numeric,
  ADD COLUMN IF NOT EXISTS total_price_gross      numeric,
  ADD COLUMN IF NOT EXISTS total_price_net        numeric,
  ADD COLUMN IF NOT EXISTS vat_rate               numeric DEFAULT 19,
  ADD COLUMN IF NOT EXISTS is_owner_stay          boolean NOT NULL DEFAULT false;

-- Bestehende Buchungen: Brutto-Spalten aus alten Feldern befüllen
UPDATE bookings SET
  price_per_night_gross = price_per_night,
  cleaning_fee_gross    = cleaning_fee,
  total_price_gross     = total_price,
  vat_rate              = 19
WHERE price_per_night_gross IS NULL;
