-- Kontaktkarte (vCard) per WhatsApp mitschicken: Stage-Regel merkt sich WELCHEN
-- Kontakt (Token wie bei recipient: 'bc:<id>' | 'dc:<id>' | 'unit_developer'),
-- schedule-message löst ihn beim Einplanen auf und legt die fertige Karte an der
-- Nachricht ab, send-whatsapp verschickt sie nach dem Text (Evolution sendContact).
ALTER TABLE automation_rules   ADD COLUMN IF NOT EXISTS share_contact text;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS contact_card jsonb;
COMMENT ON COLUMN automation_rules.share_contact   IS 'Kontakt-Token, dessen Karte per WhatsApp mitgeschickt wird (bc:/dc:/unit_developer)';
COMMENT ON COLUMN scheduled_messages.contact_card IS 'Aufgelöste Kontaktkarte {name, phone, email, organization}';
