-- ── Neue Pipeline-Phase 'reservierung' ───────────────────────────────────────
-- Zwischen 'immobilienauswahl' und 'kaufvertrag'. Kunde hat sich für eine
-- konkrete Wohnung entschieden → wird beim Developer reserviert (Apartment +
-- Preis), Reservierungsbestätigung an Kunde, Google-Drive-Ordner + Developer-
-- Ansprechpartner eingebunden. CHECK-Constraint dynamisch ersetzen (Name kann
-- je nach Anlage variieren).
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'deals'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%phase%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE deals DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE deals ADD CONSTRAINT deals_phase_check CHECK (phase IN (
  'erstkontakt', 'termin_gebucht', 'no_show',
  'finanzierung_de', 'finanzierung_cy', 'registrierung',
  'immobilienauswahl', 'reservierung',
  'kaufvertrag', 'anzahlung', 'provision_erhalten',
  'deal_verloren', 'archiviert'
));
