-- Termin-Zeitzone: Sven wählt beim Anlegen, ob die eingegebene Uhrzeit deutsche Zeit
-- (Europe/Berlin) oder Zypern-Zeit (Asia/Nicosia) ist. start_time/end_time bleiben UTC;
-- die Spalte steuert nur, in welcher Zone Eingabe interpretiert und dem Kunden angezeigt
-- wird. NULL = alte Regel (vor Ort = Zypern, sonst Deutschland) — gilt weiter für
-- Buchungen aus Funnel/Bot/persönlichem Link, die keine Zone setzen.
ALTER TABLE crm_appointments
  ADD COLUMN IF NOT EXISTS timezone text
  CHECK (timezone IS NULL OR timezone IN ('Europe/Berlin', 'Asia/Nicosia'));

COMMENT ON COLUMN crm_appointments.timezone IS
  'Anzeige-/Eingabezone des Termins (Europe/Berlin | Asia/Nicosia). NULL = Typ-Regel: inperson=Nicosia, sonst Berlin.';
