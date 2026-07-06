-- Termin-Bot: No-Show-Nudge-Sequenz (6 Stufen) + editierbare Bot-Texte
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS bot_nudge_stage int;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS bot_nudge_source text;

CREATE TABLE IF NOT EXISTS booking_bot_messages (
  key text PRIMARY KEY,
  label text NOT NULL,
  delay_label text,
  intro text NOT NULL,
  sort int DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE booking_bot_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_bot_messages_all ON booking_bot_messages;
CREATE POLICY booking_bot_messages_all ON booking_bot_messages FOR ALL TO authenticated USING (true) WITH CHECK (true);
