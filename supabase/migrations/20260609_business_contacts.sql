-- ── Geschäftskontakte (Business Contacts) ────────────────────────────────────
-- Freistehende Kontakte rund um den Deal-Prozess: Anwälte, Finanzierungs-
-- partner, der eigene Geschäftspartner, sonstige Ansprechpartner.
-- NICHT an einen Developer gebunden (anders als crm_developer_contacts).
-- Genutzt als frei wählbare Empfänger für Mail/WhatsApp aus dem CRM.
CREATE TABLE IF NOT EXISTS crm_business_contacts (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  first_name  text NOT NULL,        -- Vorname
  last_name   text,                 -- Nachname
  company     text,                 -- Firma
  role        text,                 -- Funktion, z.B. "Anwalt", "Finanzierung", "Partner"
  email       text,
  phone       text,
  whatsapp    text,
  notes       text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE crm_business_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_business_contacts_rw" ON crm_business_contacts;
CREATE POLICY "crm_business_contacts_rw" ON crm_business_contacts FOR ALL TO authenticated
  USING      ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

-- updated_at-Trigger (Funktion existiert seit 20260329_crm_projects.sql)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'crm_business_contacts_updated_at') THEN
    CREATE TRIGGER crm_business_contacts_updated_at
      BEFORE UPDATE ON crm_business_contacts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
