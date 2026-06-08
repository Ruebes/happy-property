-- ── Smarter Auto-Stopp für getaktete Nachrichten ────────────────────────────────
-- Ergänzt den bestehenden Phasenwechsel-Stopp (20260607_cancel_stale_…) um zwei
-- weitere „der Kunde hat reagiert"-Signale, sodass keine überflüssige Folge-
-- Nachricht mehr rausgeht:
--
--   (a) NEUER TERMIN  → alle noch offenen „Buch-/Re-Buch-Erinnerungen" stoppen.
--   (b) OPT-OUT       → ALLE noch offenen Nachrichten dieses Leads stoppen.
--
-- Beide Trigger sind rein schützend: sie setzen ausschließlich status='cancelled'.
-- Sie können niemals einen Versand auslösen, nur verhindern. Inert, solange keine
-- pending-Nachrichten existieren (aktuell 0). Spiegelt das Muster von
-- hp_cancel_stale_scheduled_messages (Trigger trg_hp_cancel_stale_msgs auf deals).

-- ── (a) Neuer Termin → Buchungs-/No-Show-Erinnerungen dieses Leads stoppen ───────
-- „Bitte buche einen Termin"-Sequenzen (lead_created/erstkontakt) und
-- „Du hast den Termin verpasst, buche neu"-Sequenzen (no_show) sind obsolet,
-- sobald ein neuer Termin im System steht. Termin-Erinnerungen der neuen Phase
-- (termin_gebucht) und Prozess-Nachrichten (Finanzierung, Reservierung, …)
-- bleiben unberührt.
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
       AND event_type IN ('lead_created', 'erstkontakt', 'no_show');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_cancel_nudges_on_appt ON crm_appointments;
CREATE TRIGGER trg_hp_cancel_nudges_on_appt
  AFTER INSERT ON crm_appointments
  FOR EACH ROW
  EXECUTE FUNCTION hp_cancel_nudges_on_appointment();

-- ── (b) Opt-Out → alle offenen Nachrichten dieses Leads stoppen ──────────────────
-- Single Source of Truth: egal WIE der Opt-Out entsteht (Inbound-WhatsApp-
-- Erkennung im timelines-webhook, manueller Eintrag im CRM, …) – sobald eine
-- Zeile in communication_optouts landet, gehen für diesen Lead keine geplanten
-- Nachrichten mehr raus.
CREATE OR REPLACE FUNCTION hp_cancel_pending_on_optout()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    UPDATE scheduled_messages
       SET status = 'cancelled'
     WHERE lead_id = NEW.lead_id
       AND status  = 'pending';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_cancel_on_optout ON communication_optouts;
CREATE TRIGGER trg_hp_cancel_on_optout
  AFTER INSERT ON communication_optouts
  FOR EACH ROW
  EXECUTE FUNCTION hp_cancel_pending_on_optout();
