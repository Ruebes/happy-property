-- ══════════════════════════════════════════════════════════════
-- 006 – Feriengast-Rolle, Buchungs-Erweiterung, Gäste-Vereinbarungen, Nachrichten
-- ══════════════════════════════════════════════════════════════

-- 1. Rolle "feriengast" im check constraint hinzufügen
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('admin','verwalter','eigentuemer','feriengast'));

-- 2. Gast-Felder auf profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS nationality     TEXT,
  ADD COLUMN IF NOT EXISTS birth_date      DATE;

-- 3. Buchungs-Erweiterung (Gast-ID + Check-in-Infos)
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS guest_id          UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS price_per_night   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS cleaning_fee      NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_price       NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS booking_number    TEXT,
  ADD COLUMN IF NOT EXISTS checkin_time      TIME DEFAULT '15:00',
  ADD COLUMN IF NOT EXISTS checkout_time     TIME DEFAULT '11:00',
  ADD COLUMN IF NOT EXISTS key_handover      TEXT,
  ADD COLUMN IF NOT EXISTS wifi_name         TEXT,
  ADD COLUMN IF NOT EXISTS wifi_password     TEXT,
  ADD COLUMN IF NOT EXISTS parking_info      TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact TEXT,
  ADD COLUMN IF NOT EXISTS house_rules       TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_policy TEXT;

-- 4. Buchungsnummer automatisch generieren
CREATE OR REPLACE FUNCTION generate_booking_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.booking_number IS NULL THEN
    NEW.booking_number := 'HP-' || TO_CHAR(now(), 'YYYY') || '-' ||
                          LPAD(FLOOR(RANDOM() * 90000 + 10000)::TEXT, 5, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS booking_number_trigger ON bookings;
CREATE TRIGGER booking_number_trigger
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION generate_booking_number();

-- 5. Gäste-Vereinbarungen
CREATE TABLE IF NOT EXISTS guest_agreements (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id         UUID REFERENCES bookings(id) ON DELETE CASCADE,
  guest_id           UUID REFERENCES profiles(id) ON DELETE SET NULL,
  property_id        UUID REFERENCES properties(id) ON DELETE CASCADE,
  check_in           DATE NOT NULL,
  check_out          DATE NOT NULL,
  total_price        NUMERIC(10,2),
  deposit_amount     NUMERIC(10,2) DEFAULT 0,
  house_rules        TEXT,
  agreed_at          TIMESTAMPTZ,
  agreement_pdf_url  TEXT,
  ip_address         TEXT,
  created_at         TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE guest_agreements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "guest_agreements_guest_read" ON guest_agreements
  FOR SELECT USING (guest_id = auth.uid());

CREATE POLICY "guest_agreements_guest_agree" ON guest_agreements
  FOR UPDATE USING (guest_id = auth.uid())
  WITH CHECK (guest_id = auth.uid());

CREATE POLICY "guest_agreements_admin_all" ON guest_agreements
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','verwalter'))
  );

-- 6. Nachrichten
CREATE TABLE IF NOT EXISTS messages (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id  UUID REFERENCES bookings(id) ON DELETE CASCADE,
  sender_id   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  content     TEXT NOT NULL,
  is_read     BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Gast sieht Nachrichten seiner eigenen Buchungen
CREATE POLICY "messages_booking_participant" ON messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.id = messages.booking_id
      AND (b.guest_id = auth.uid() OR
           EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','verwalter')))
    )
  );

-- 7. RLS für bookings: Gast sieht seine Buchungen
CREATE POLICY IF NOT EXISTS "bookings_guest_read" ON bookings
  FOR SELECT USING (guest_id = auth.uid());
