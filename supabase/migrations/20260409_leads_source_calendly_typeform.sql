-- ── Migration: Lead sources um calendly + typeform erweitern ──────────────────
-- Webhooks für Calendly und Typeform schreiben source='calendly'/'typeform'
-- Der alte Constraint erlaubte nur: meta, google, empfehlung, sonstiges

-- 1. Alten Constraint entfernen
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_source_check;

-- 2. Bestehende ungültige Werte auf sonstiges setzen (Fallback)
UPDATE leads
SET source = 'sonstiges'
WHERE source NOT IN ('meta','google','empfehlung','sonstiges','calendly','typeform');

-- 3. Neuen Constraint mit allen Werten
ALTER TABLE leads
  ADD CONSTRAINT leads_source_check
  CHECK (source IN ('meta','google','empfehlung','sonstiges','calendly','typeform'));

-- 4. Ergebnis prüfen
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'leads'::regclass AND contype = 'c';
