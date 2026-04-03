-- ══════════════════════════════════════════════════════════════
-- 008 – Activity Log
-- Protokolliert alle wichtigen Systemaktionen automatisch via Trigger
-- ══════════════════════════════════════════════════════════════

-- ── 1. Tabelle ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  action_type  TEXT        NOT NULL,
  description  TEXT        NOT NULL,
  user_id      UUID        REFERENCES profiles(id)    ON DELETE SET NULL,
  property_id  UUID        REFERENCES properties(id)  ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activity_log_admin_read" ON activity_log
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'verwalter'))
  );

CREATE INDEX IF NOT EXISTS idx_activity_log_created_at
  ON activity_log(created_at DESC);

-- ── 2. Trigger: Neuer Nutzer ──────────────────────────────────
CREATE OR REPLACE FUNCTION log_user_created()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO activity_log (action_type, description, user_id)
  VALUES ('user_created', 'Neuer Nutzer angelegt: ' || NEW.full_name, NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_log_user_created ON profiles;
CREATE TRIGGER trigger_log_user_created
  AFTER INSERT ON profiles
  FOR EACH ROW EXECUTE FUNCTION log_user_created();

-- ── 3. Trigger: Dokument hochgeladen ─────────────────────────
CREATE OR REPLACE FUNCTION log_document_created()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO activity_log (action_type, description, property_id, user_id)
  VALUES (
    'document_uploaded',
    'Dokument hochgeladen: ' || COALESCE(NEW.title, 'unbekannt'),
    NEW.property_id,
    NEW.uploaded_by
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_log_document_created ON documents;
CREATE TRIGGER trigger_log_document_created
  AFTER INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION log_document_created();

-- ── 4. Trigger: Neue Buchung ──────────────────────────────────
CREATE OR REPLACE FUNCTION log_booking_created()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO activity_log (action_type, description, property_id, user_id)
  VALUES (
    'booking_created',
    'Neue Buchung: ' || TO_CHAR(NEW.check_in, 'DD.MM.YYYY') ||
      ' – ' || TO_CHAR(NEW.check_out, 'DD.MM.YYYY'),
    NEW.property_id,
    NEW.guest_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_log_booking_created ON bookings;
CREATE TRIGGER trigger_log_booking_created
  AFTER INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION log_booking_created();

-- ── 5. Trigger: Vertrag unterschrieben ───────────────────────
CREATE OR REPLACE FUNCTION log_contract_signed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (OLD.status IS DISTINCT FROM 'signed') AND NEW.status = 'signed' THEN
    INSERT INTO activity_log (action_type, description, property_id)
    VALUES (
      'contract_signed',
      'Vertrag unterschrieben: ' || COALESCE(NEW.tenant_name, 'unbekannt'),
      NEW.property_id
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_log_contract_signed ON contracts;
CREATE TRIGGER trigger_log_contract_signed
  AFTER UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION log_contract_signed();

-- ── 6. Trigger: Bankdaten geändert ───────────────────────────
CREATE OR REPLACE FUNCTION log_bank_changed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO activity_log (action_type, description, user_id)
  VALUES ('bank_changed', 'Bankdaten geändert', NEW.owner_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_log_bank_changed ON bank_change_notifications;
CREATE TRIGGER trigger_log_bank_changed
  AFTER INSERT ON bank_change_notifications
  FOR EACH ROW EXECUTE FUNCTION log_bank_changed();
