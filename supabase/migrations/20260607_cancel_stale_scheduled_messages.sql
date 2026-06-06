-- ── Auto-Abbruch veralteter geplanter Nachrichten bei Phasenwechsel ──────────
-- Szenario: Kunde im Erstkontakt bekommt eine getaktete Reminder-Serie
-- (z.B. +20min / +1d / +3d / +5d / +14d) als pending scheduled_messages.
-- Bucht er einen Termin (Phase → termin_gebucht), sollen die NOCH offenen
-- Erinnerungen der alten Phase NICHT mehr rausgehen.
--
-- Regel: Wechselt deals.phase, werden alle noch 'pending' Nachrichten dieses
-- Deals storniert, deren event_type NICHT der neuen Phase entspricht. Die für
-- die neue Phase frisch eingeplanten Nachrichten (event_type = neue Phase) legt
-- die schedule-message-Function ERST NACH dem UPDATE an → werden nicht getroffen.
--
-- Inert bis die Engine scharf ist: ohne pending-Nachrichten passiert nichts.

CREATE OR REPLACE FUNCTION hp_cancel_stale_scheduled_messages()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.phase IS DISTINCT FROM OLD.phase THEN
    UPDATE scheduled_messages
       SET status = 'cancelled'
     WHERE deal_id   = NEW.id
       AND status    = 'pending'
       AND event_type IS DISTINCT FROM NEW.phase;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_cancel_stale_msgs ON deals;
CREATE TRIGGER trg_hp_cancel_stale_msgs
  AFTER UPDATE OF phase ON deals
  FOR EACH ROW
  EXECUTE FUNCTION hp_cancel_stale_scheduled_messages();
