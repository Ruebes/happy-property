-- ── Deck-Follow-up: automatische WhatsApp nach dem ersten Deck-Aufruf ───────────
-- Ziel (Sven): vom 1. Call in den 2. kommen. Sobald ein Kunde sein Deck zum ersten
-- Mal öffnet, geht ~45 Min später EINE freundliche WhatsApp raus (Favorit? + Termin-
-- Link). Geplant wird in track-engagement, gesendet vom bestehenden 5-Min-Cron.
--
-- SICHERHEIT: Die Regel ist standardmäßig AUS (is_active=false). Es wird NICHTS
-- geplant/gesendet, solange Sven sie nicht bewusst einschaltet (Settings → KI-Agent).

-- (1) Regel anlegen — inaktiv. event_type 'deck_viewed_followup', 45 Min, nur WhatsApp
--     an den Kunden. appointment_condition 'no_appointment' = beim Fälligwerden NICHT
--     senden, falls der Kunde inzwischen einen Termin gebucht hat (zweite Absicherung).
INSERT INTO automation_rules
  (name, description, event_type, delay_minutes, message_type, is_active,
   recipient, appointment_condition, timing_type)
SELECT
  'Deck angesehen → WhatsApp-Follow-up (45 Min)',
  'Automatische WhatsApp 45 Min nach dem ERSTEN Deck-Aufruf eines Leads — fragt nach dem Favoriten und bietet einen Termin-Link. Nur zu Bürozeiten (8–21 Uhr), einmal pro Lead, storniert sich bei Terminbuchung/Opt-Out. STANDARD AUS.',
  'deck_viewed_followup', 45, 'whatsapp', false,
  'client', 'no_appointment', 'after_event'
WHERE NOT EXISTS (
  SELECT 1 FROM automation_rules WHERE event_type = 'deck_viewed_followup'
);

-- (2) Terminbuchung storniert den offenen Deck-Follow-up mit — den neuen event_type
--     in die bestehende Auto-Stopp-Logik aufnehmen (Opt-Out storniert ohnehin ALLES).
CREATE OR REPLACE FUNCTION hp_cancel_nudges_on_appointment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    UPDATE scheduled_messages
       SET status = 'cancelled'
     WHERE lead_id    = NEW.lead_id
       AND status     = 'pending'
       AND event_type IN ('lead_created', 'erstkontakt', 'no_show', 'deck_viewed_followup');
  END IF;
  RETURN NEW;
END $$;
