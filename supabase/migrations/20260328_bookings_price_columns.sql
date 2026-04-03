-- ── bookings: alle fehlenden Spalten auf einmal ───────────────
-- Ausführen im Supabase SQL Editor.
-- Danach: Dashboard → Project Settings → API → Reload schema cache

ALTER TABLE bookings
  -- Eigentümer-Aufenthalt Flag
  ADD COLUMN IF NOT EXISTS is_owner_stay         boolean DEFAULT false,

  -- Brutto/Netto Preisfelder
  ADD COLUMN IF NOT EXISTS price_per_night_gross numeric,
  ADD COLUMN IF NOT EXISTS price_per_night_net   numeric,
  ADD COLUMN IF NOT EXISTS cleaning_fee_gross     numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cleaning_fee_net       numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_price_gross      numeric,
  ADD COLUMN IF NOT EXISTS total_price_net        numeric,
  ADD COLUMN IF NOT EXISTS vat_rate               numeric DEFAULT 19;

-- Bestehende Buchungen: Werte aus Legacy-Spalten rückwärts befüllen
UPDATE bookings
SET
  is_owner_stay         = false,
  price_per_night_gross = price_per_night,
  price_per_night_net   = CASE WHEN price_per_night IS NOT NULL
                            THEN ROUND(price_per_night / 1.19, 2) END,
  cleaning_fee_gross    = COALESCE(cleaning_fee, 0),
  cleaning_fee_net      = ROUND(COALESCE(cleaning_fee, 0) / 1.19, 2),
  total_price_gross     = total_price,
  total_price_net       = CASE WHEN total_price IS NOT NULL
                            THEN ROUND(total_price / 1.19, 2) END,
  vat_rate              = 19
WHERE price_per_night_gross IS NULL;

-- Ergebnis-Check: alle Spalten anzeigen
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'bookings'
  AND column_name IN (
    'is_owner_stay',
    'price_per_night_gross', 'price_per_night_net',
    'cleaning_fee_gross',    'cleaning_fee_net',
    'total_price_gross',     'total_price_net',
    'vat_rate'
  )
ORDER BY column_name;
