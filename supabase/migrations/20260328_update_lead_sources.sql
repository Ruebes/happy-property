-- ── Migration: Update lead sources ────────────────────────────
-- Alte Werte (referral, calendly, manual) → neue Werte (empfehlung, sonstiges)
-- Führe dies im Supabase SQL-Editor aus.

-- Schritt 1: Alten CHECK-Constraint entfernen (falls vorhanden)
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_source_check;

-- Schritt 2: Bestehende Daten migrieren
UPDATE leads SET source = 'empfehlung' WHERE source IN ('referral', 'calendly');
UPDATE leads SET source = 'sonstiges'  WHERE source IN ('manual');
-- Fallback: Alle unbekannten Werte → sonstiges
UPDATE leads SET source = 'sonstiges'  WHERE source NOT IN ('meta','google','empfehlung','sonstiges');

-- Schritt 3: Neuen CHECK-Constraint setzen
ALTER TABLE leads
  ADD CONSTRAINT leads_source_check
  CHECK (source IN ('meta','google','empfehlung','sonstiges'));

-- Schritt 4: Schema-Cache neu laden
-- → Supabase Dashboard → Project Settings → API → Reload schema cache
