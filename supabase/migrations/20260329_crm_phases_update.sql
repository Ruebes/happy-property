-- ── CRM Deal Phases Update ────────────────────────────────────────────────────
-- Entfernt: 'beratung', 'finanzierung'
-- Neu: 'finanzierung_de', 'finanzierung_cy', 'deal_verloren'
--
-- Im Supabase SQL Editor ausführen.

-- Schritt 1: Bestehende Deals mit alten Phasen migrieren
UPDATE deals SET phase = 'finanzierung_de' WHERE phase = 'finanzierung';
UPDATE deals SET phase = 'erstkontakt'     WHERE phase = 'beratung';

-- Schritt 2: Alten check constraint entfernen
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_phase_check;

-- Schritt 3: Neuen check constraint setzen
ALTER TABLE deals ADD CONSTRAINT deals_phase_check CHECK (phase IN (
  'erstkontakt',
  'termin_gebucht',
  'no_show',
  'finanzierung_de',
  'finanzierung_cy',
  'registrierung',
  'immobilienauswahl',
  'kaufvertrag',
  'anzahlung',
  'provision_erhalten',
  'deal_verloren',
  'archiviert'
));
