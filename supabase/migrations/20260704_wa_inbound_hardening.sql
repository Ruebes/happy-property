-- ── Eingehende-WhatsApp-Härtung (Termin-Bot) ────────────────────────────────────
-- Diagnose beim Live-Test ergab: TimelinesAI schickt jede Nachricht MEHRFACH
-- (verschiedene event_types + Retries) und spiegelt auch AUSGEHENDE (unsere Bot-)
-- Nachrichten zurück (message.direction 'sent'). Ohne Schutz antwortet der Bot auf
-- sich selbst (Endlosschleife). Fix in timelines-webhook: direction-basiertes
-- fromMe + Dedupe je message_uid + robuste Nummern-Zuordnung (Suffix).

-- Dedupe: jede Timelines-message_uid nur EINMAL verarbeiten (UNIQUE = race-sicher).
CREATE TABLE IF NOT EXISTS wa_processed (
  message_uid  text PRIMARY KEY,
  processed_at timestamptz DEFAULT now()
);
ALTER TABLE wa_processed ENABLE ROW LEVEL SECURITY;

-- Diagnose-Puffer für rohe Webhook-Payloads (nur Service-Role; aktuell ungenutzt,
-- bleibt für künftige Provider-Format-Analysen).
CREATE TABLE IF NOT EXISTS webhook_debug (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source     text,
  payload    jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE webhook_debug ENABLE ROW LEVEL SECURITY;
