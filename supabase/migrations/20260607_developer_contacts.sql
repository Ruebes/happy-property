-- ── Developer-Ansprechpartner ────────────────────────────────────────────────
-- Pro Developer (crm_developers) beliebig viele Ansprechpartner mit Kontaktdaten.
-- Genutzt für: Mail/WhatsApp aus dem CRM an den Developer, Reservierungs- &
-- Kaufvertrags-Benachrichtigungen, Google-Drive-Freigabe an den Kontakt.
CREATE TABLE IF NOT EXISTS crm_developer_contacts (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  developer_id uuid NOT NULL REFERENCES crm_developers(id) ON DELETE CASCADE,
  name         text NOT NULL,
  email        text,
  phone        text,
  whatsapp     text,
  role         text,            -- z.B. "Sales", "Reservierungen", "Buchhaltung"
  is_primary   boolean NOT NULL DEFAULT false,
  notes        text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_developer_contacts_dev_idx
  ON crm_developer_contacts (developer_id);

ALTER TABLE crm_developer_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_developer_contacts_rw" ON crm_developer_contacts;
CREATE POLICY "crm_developer_contacts_rw" ON crm_developer_contacts FOR ALL TO authenticated
  USING      ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

-- updated_at-Trigger (Funktion existiert seit 20260329_crm_projects.sql)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'crm_developer_contacts_updated_at') THEN
    CREATE TRIGGER crm_developer_contacts_updated_at
      BEFORE UPDATE ON crm_developer_contacts
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
