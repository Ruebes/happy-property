-- ── Sonstige / Ad-hoc Nachrichten ────────────────────────────────────────────
-- Einmalige WhatsApp/E-Mail-Nachrichten, NICHT an eine Pipeline-Phase gebunden.
-- Reine Definition (Zweck + Inhalt + gewünschter Sendezeitpunkt). Bleibt inert,
-- bis der Versand separat scharfgeschaltet wird – nichts hieraus sendet von selbst.
CREATE TABLE IF NOT EXISTS crm_adhoc_messages (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  label         text NOT NULL,                    -- Zweck / Bezeichnung
  channel       text NOT NULL DEFAULT 'whatsapp', -- 'email' | 'whatsapp'
  email_subject text,
  email_body    text,
  email_html    text,
  whatsapp_text text,
  scheduled_at  timestamptz,                      -- gewünschter Sendezeitpunkt (NULL = offen)
  status        text NOT NULL DEFAULT 'draft',    -- 'draft' | 'scheduled' | 'sent' | 'cancelled'
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

ALTER TABLE crm_adhoc_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_adhoc_messages_rw" ON crm_adhoc_messages;
CREATE POLICY "crm_adhoc_messages_rw" ON crm_adhoc_messages FOR ALL TO authenticated
  USING      ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

-- updated_at-Trigger (Funktion existiert seit 20260329_crm_projects.sql)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'crm_adhoc_messages_updated_at') THEN
    CREATE TRIGGER crm_adhoc_messages_updated_at
      BEFORE UPDATE ON crm_adhoc_messages
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
