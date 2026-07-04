-- ── Termin-Bot: WhatsApp-Dialog, der Termine vorschlägt + bucht ─────────────────
-- Ziel (Sven): dem Kunden das Terminfinden abnehmen. Ausgelöst bei No-Show,
-- Erstkontakt und Deck-Ansicht. Der Bot schlägt 2 freie Slots (DE-Zeit) vor,
-- versteht die Antwort per KI, gleicht den Kalender ab und bucht.
--
-- SICHERHEIT: standardmäßig AUS (crm_settings 'booking_bot_enabled'='false').
-- Ohne aktiven Schalter wird kein Gespräch gestartet und nichts gesendet.

-- Ein laufendes Bot-Gespräch je Lead. state führt durch den Dialog.
CREATE TABLE IF NOT EXISTS booking_conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  deal_id        uuid REFERENCES deals(id) ON DELETE SET NULL,
  source         text NOT NULL,                       -- 'deck_viewed' | 'no_show' | 'erstkontakt'
  state          text NOT NULL DEFAULT 'awaiting_choice',
  -- awaiting_choice | awaiting_type | awaiting_daypref | awaiting_confirm | booked | handoff | expired
  proposed_slots jsonb,                               -- [{startIso, endIso, label}]
  chosen_slot    jsonb,                               -- {startIso, endIso, label}
  meeting_type   text,                                -- 'zoom' | 'whatsapp'
  attempts       int  NOT NULL DEFAULT 0,             -- Zähler für unklare Antworten
  last_message   text,
  expires_at     timestamptz NOT NULL DEFAULT (now() + interval '3 days'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_conv_lead   ON booking_conversations(lead_id);
CREATE INDEX IF NOT EXISTS idx_booking_conv_active ON booking_conversations(lead_id, state) WHERE state NOT IN ('booked','handoff','expired');

-- Nur Server (Service-Role) schreibt/liest via Edge; Admin/Verwalter dürfen lesen.
ALTER TABLE booking_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_conv_admin_read ON booking_conversations;
CREATE POLICY booking_conv_admin_read ON booking_conversations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','verwalter')));

-- updated_at pflegen
CREATE OR REPLACE FUNCTION hp_touch_booking_conv() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_touch_booking_conv ON booking_conversations;
CREATE TRIGGER trg_touch_booking_conv BEFORE UPDATE ON booking_conversations
  FOR EACH ROW EXECUTE FUNCTION hp_touch_booking_conv();

-- Bot-Schalter (Standard AUS)
INSERT INTO crm_settings (key, value)
SELECT 'booking_bot_enabled', 'false'
WHERE NOT EXISTS (SELECT 1 FROM crm_settings WHERE key = 'booking_bot_enabled');

-- Terminbuchung schließt ein offenes Bot-Gespräch mit (falls der Kunde
-- anderweitig bucht). Ergänzt den bestehenden Nudge-Stopp.
CREATE OR REPLACE FUNCTION hp_close_bot_conv_on_appointment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    UPDATE booking_conversations
       SET state = 'booked'
     WHERE lead_id = NEW.lead_id
       AND state NOT IN ('booked','handoff','expired');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_close_bot_conv_on_appt ON crm_appointments;
CREATE TRIGGER trg_close_bot_conv_on_appt
  AFTER INSERT ON crm_appointments
  FOR EACH ROW EXECUTE FUNCTION hp_close_bot_conv_on_appointment();

-- Opt-Out schließt ein offenes Bot-Gespräch mit.
CREATE OR REPLACE FUNCTION hp_close_bot_conv_on_optout()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    UPDATE booking_conversations
       SET state = 'expired'
     WHERE lead_id = NEW.lead_id
       AND state NOT IN ('booked','handoff','expired');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_close_bot_conv_on_optout ON communication_optouts;
CREATE TRIGGER trg_close_bot_conv_on_optout
  AFTER INSERT ON communication_optouts
  FOR EACH ROW EXECUTE FUNCTION hp_close_bot_conv_on_optout();
