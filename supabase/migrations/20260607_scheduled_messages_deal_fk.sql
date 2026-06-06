-- ── scheduled_messages.deal_id → ON DELETE CASCADE ───────────────────────────
-- Die Automations-Engine-Tabellen (Migration 20260411) referenzieren deals(id)
-- OHNE ON DELETE-Regel → das Löschen eines Deals würde durch offene/gesendete
-- scheduled_messages blockiert (dieselbe Bug-Klasse, die in Phase 1 für
-- crm_appointments behoben wurde). Geplante Nachrichten sind ohne ihren Deal
-- bedeutungslos → CASCADE: Deal weg = seine Queue-Einträge weg.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'scheduled_messages'::regclass
     AND contype  = 'f'
     AND confrelid = 'deals'::regclass;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE scheduled_messages DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE scheduled_messages
  ADD CONSTRAINT scheduled_messages_deal_id_fkey
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
