-- ══════════════════════════════════════════════════════════════
-- 007 – Performance-Indexes + RLS-Fixes + Schema-Korrekturen
-- ══════════════════════════════════════════════════════════════

-- ── 1. Fehlende Indexes auf häufig gefilterten Spalten ────────

-- profiles.role: Wird in RLS-Policies bei JEDER DB-Abfrage geprüft
CREATE INDEX IF NOT EXISTS idx_profiles_role
  ON profiles(role);

-- properties.owner_id: RLS eigentuemer-Filter + JOIN
CREATE INDEX IF NOT EXISTS idx_properties_owner_id
  ON properties(owner_id);

-- documents.property_id: Häufigster Filter + RLS
CREATE INDEX IF NOT EXISTS idx_documents_property_id
  ON documents(property_id);

-- contracts.property_id
CREATE INDEX IF NOT EXISTS idx_contracts_property_id
  ON contracts(property_id);

-- bookings.property_id + guest_id + Datums-Range
CREATE INDEX IF NOT EXISTS idx_bookings_property_id
  ON bookings(property_id);

CREATE INDEX IF NOT EXISTS idx_bookings_guest_id
  ON bookings(guest_id);

CREATE INDEX IF NOT EXISTS idx_bookings_check_in
  ON bookings(check_in);

CREATE INDEX IF NOT EXISTS idx_bookings_check_out
  ON bookings(check_out);

-- messages.booking_id: Jeder Chat-Load filtert danach
CREATE INDEX IF NOT EXISTS idx_messages_booking_id
  ON messages(booking_id);

CREATE INDEX IF NOT EXISTS idx_messages_is_read
  ON messages(is_read)
  WHERE is_read = false;  -- Partial index: nur ungelesene

-- guest_agreements.booking_id + guest_id
CREATE INDEX IF NOT EXISTS idx_guest_agreements_booking_id
  ON guest_agreements(booking_id);

CREATE INDEX IF NOT EXISTS idx_guest_agreements_guest_id
  ON guest_agreements(guest_id);

-- income_entries.property_id
CREATE INDEX IF NOT EXISTS idx_income_entries_property_id
  ON income_entries(property_id);

-- bank_change_notifications.owner_id + status
CREATE INDEX IF NOT EXISTS idx_bank_notifications_owner_id
  ON bank_change_notifications(owner_id);

CREATE INDEX IF NOT EXISTS idx_bank_notifications_status
  ON bank_change_notifications(status)
  WHERE status = 'pending';  -- Partial index: nur ausstehende

-- ── 2. guest_agreements: check_in/check_out nullable machen ──
-- Diese Spalten sind redundant (Daten stehen in bookings).
-- Ohne nullable scheitert der INSERT-Fallback in Hausregeln.tsx.
ALTER TABLE guest_agreements
  ALTER COLUMN check_in  DROP NOT NULL,
  ALTER COLUMN check_out DROP NOT NULL;

-- ── 3. RLS: Gäste dürfen eigene guest_agreements INSERT-en ───
-- Notwendig falls kein Agreement beim Buchungs-Anlegen erstellt
-- wurde (z.B. wenn Verwalter keine Hausregeln hinterlegt hat).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'guest_agreements' AND policyname = 'guest_agreements_guest_insert'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "guest_agreements_guest_insert" ON guest_agreements
        FOR INSERT WITH CHECK (guest_id = auth.uid());
    $p$;
  END IF;
END;
$$;

-- ── 4. Bookings: Gäste dürfen eigene Buchungen lesen (idempotent) ─
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'bookings' AND policyname = 'bookings_guest_read'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "bookings_guest_read" ON bookings
        FOR SELECT USING (guest_id = auth.uid());
    $p$;
  END IF;
END;
$$;
