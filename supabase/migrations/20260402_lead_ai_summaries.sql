-- ── Lead AI Summaries + Activity Columns ─────────────────────────────────────

ALTER TABLE activities
ADD COLUMN IF NOT EXISTS whatsapp_message_id       text,
ADD COLUMN IF NOT EXISTS ai_summary_generated_at   timestamptz;

CREATE TABLE IF NOT EXISTS lead_ai_summaries (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id      uuid        REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
  summary      text        NOT NULL,
  generated_at timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

ALTER TABLE lead_ai_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_only"
  ON lead_ai_summaries FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id   = auth.uid()
      AND   role = 'admin'
    )
  );
