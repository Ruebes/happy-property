-- Termintyp 'whatsapp' zulassen (Sven: Termine auch per WhatsApp-Call).
-- Bestehende Typen bleiben unverändert: zoom | inperson | phone | whatsapp.
ALTER TABLE crm_appointments DROP CONSTRAINT IF EXISTS crm_appointments_type_check;
ALTER TABLE crm_appointments ADD CONSTRAINT crm_appointments_type_check
  CHECK (type IN ('zoom', 'inperson', 'phone', 'whatsapp'));

-- google_calendar_id soll beim Sync mitgeschrieben werden können (Spalte existiert
-- bereits seit 20260331) — hier nur zur Dokumentation, kein weiterer Eingriff.
