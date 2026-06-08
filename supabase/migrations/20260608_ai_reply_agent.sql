-- ── KI-Antwort-Agent: Fundament (inert) ─────────────────────────────────────────
-- Eingehende Nachricht → KI-Entwurf. Sven prüft/korrigiert/gibt frei. Aus den
-- freigegebenen (ggf. korrigierten) Antworten lernt das System (Few-Shot).
--
-- Dieses Fundament legt NUR Tabelle + Schalter an. Es sendet nichts und ruft
-- keine KI auf. Der Draft-Generator (Edge Function ai-draft-reply) und die
-- Review-UI in LeadDetail kommen separat; Auto-Versand bleibt hart aus, bis
-- der Schalter ai_autopilot_enabled bewusst auf 'true' gesetzt wird.

-- ── Beispiel-/Review-Speicher ───────────────────────────────────────────────────
-- Eine Zeile pro eingehender Nachricht, die einen KI-Entwurf bekommt:
--   inbound_text  – was der Kunde geschrieben hat
--   ai_draft      – was die KI vorgeschlagen hat
--   final_text    – was tatsächlich rausging (nach evtl. Korrektur) – NULL bis Freigabe
--   status        – 'pending' (zu prüfen) | 'approved' (1:1 übernommen)
--                 | 'edited' (korrigiert) | 'discarded' | 'auto_sent' (Autopilot)
--   is_learning   – ob dieses Paar als Few-Shot-Beispiel genutzt werden darf
-- Freigegebene Paare (approved/edited/auto_sent mit final_text) = „gelernte" Beispiele.
CREATE TABLE IF NOT EXISTS ai_reply_examples (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id       uuid REFERENCES leads(id) ON DELETE CASCADE,
  channel       text NOT NULL DEFAULT 'whatsapp',   -- 'whatsapp' | 'email'
  inbound_text  text,
  ai_draft      text,
  final_text    text,
  status        text NOT NULL DEFAULT 'pending',
  is_learning   boolean NOT NULL DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_reply_examples_lead_idx   ON ai_reply_examples(lead_id);
CREATE INDEX IF NOT EXISTS ai_reply_examples_status_idx ON ai_reply_examples(status);

ALTER TABLE ai_reply_examples ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_reply_examples_rw" ON ai_reply_examples;
CREATE POLICY "ai_reply_examples_rw" ON ai_reply_examples FOR ALL TO authenticated
  USING      ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ai_reply_examples_updated_at') THEN
    CREATE TRIGGER ai_reply_examples_updated_at
      BEFORE UPDATE ON ai_reply_examples
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ── Autopilot-Schalter (Default: AUS) ───────────────────────────────────────────
-- 'false' = KI erstellt nur Entwürfe, Versand erst nach manueller Freigabe.
-- 'true'  = „alles voll automatisch" (erst auf Svens ausdrückliches Go setzen).
INSERT INTO crm_settings (key, value)
VALUES ('ai_autopilot_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
