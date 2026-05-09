-- ══════════════════════════════════════════════════════════════════════════════
-- CATCH-UP MIGRATION: Alle ausstehenden Migrationen (sicher, idempotent)
-- Im Supabase SQL-Editor ausführen: https://supabase.com/dashboard/project/_/sql
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. crm_project_units: neue Felder (aus 20260427_unit_management.sql) ──────

ALTER TABLE crm_project_units
  ADD COLUMN IF NOT EXISTS block            text,
  ADD COLUMN IF NOT EXISTS price_gross      numeric(12,2),
  ADD COLUMN IF NOT EXISTS vat_rate         numeric(5,2) NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS terrace_sqm      numeric(8,2),
  ADD COLUMN IF NOT EXISTS bathrooms        smallint     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_furnished     boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS handover_date    date,
  ADD COLUMN IF NOT EXISTS rental_type      text         CHECK (rental_type IN ('short','long')),
  ADD COLUMN IF NOT EXISTS verwalter_id     uuid         REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_completed     boolean      NOT NULL DEFAULT false;

-- ── 2. crm_unit_documents (Kaufverträge, Grundrisse, etc.) ───────────────────

CREATE TABLE IF NOT EXISTS crm_unit_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     uuid NOT NULL REFERENCES crm_project_units(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES crm_projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  file_path   text NOT NULL,
  file_name   text NOT NULL,
  file_size   bigint,
  doc_type    text NOT NULL DEFAULT 'sonstiges'
              CHECK (doc_type IN ('kaufvertrag','zahlungsbeleg','grundriss','sonstiges')),
  notes       text,
  uploaded_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unit_docs_unit ON crm_unit_documents(unit_id);

-- ── 3. crm_unit_payments (Kaufpreisraten) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_unit_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id           uuid NOT NULL REFERENCES crm_project_units(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES crm_projects(id) ON DELETE CASCADE,
  description       text,
  amount            numeric(12,2) NOT NULL,
  due_date          date,
  paid_date         date,
  is_paid           boolean NOT NULL DEFAULT false,
  payment_reference text,
  -- Rechnungs-Datei
  invoice_path      text,
  invoice_filename  text,
  invoice_filesize  bigint,
  -- Zahlungsbeleg-Datei
  receipt_path      text,
  receipt_filename  text,
  receipt_filesize  bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unit_payments_unit ON crm_unit_payments(unit_id);

-- Dateifelder nachträglich hinzufügen (falls Tabelle schon existiert)
ALTER TABLE crm_unit_payments
  ADD COLUMN IF NOT EXISTS invoice_path     text,
  ADD COLUMN IF NOT EXISTS invoice_filename  text,
  ADD COLUMN IF NOT EXISTS invoice_filesize  bigint,
  ADD COLUMN IF NOT EXISTS receipt_path     text,
  ADD COLUMN IF NOT EXISTS receipt_filename  text,
  ADD COLUMN IF NOT EXISTS receipt_filesize  bigint;

-- updated_at Trigger
CREATE OR REPLACE FUNCTION _fn_unit_payments_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_unit_payments_updated_at ON crm_unit_payments;
CREATE TRIGGER trg_unit_payments_updated_at
  BEFORE UPDATE ON crm_unit_payments
  FOR EACH ROW EXECUTE FUNCTION _fn_unit_payments_updated_at();

-- ── 4. RLS für crm_unit_documents + crm_unit_payments ────────────────────────

ALTER TABLE crm_unit_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_unit_payments  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='crm_unit_documents' AND policyname='unit_docs_rw'
  ) THEN
    CREATE POLICY "unit_docs_rw" ON crm_unit_documents
      FOR ALL TO authenticated
      USING  (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','verwalter')))
      WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','verwalter')));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='crm_unit_payments' AND policyname='unit_payments_rw'
  ) THEN
    CREATE POLICY "unit_payments_rw" ON crm_unit_payments
      FOR ALL TO authenticated
      USING  (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','verwalter')))
      WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','verwalter')));
  END IF;
END $$;

-- Eigentümer-Lesezugriff auf Zahlungen
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='crm_unit_payments' AND policyname='unit_payments_owner_read'
  ) THEN
    CREATE POLICY "unit_payments_owner_read" ON crm_unit_payments
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM   crm_project_units u
          JOIN   properties        p ON p.id = u.property_id
          WHERE  u.id        = crm_unit_payments.unit_id
            AND  p.owner_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Eigentümer-Lesezugriff auf Dokumente
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='crm_unit_documents' AND policyname='unit_docs_owner_read'
  ) THEN
    CREATE POLICY "unit_docs_owner_read" ON crm_unit_documents
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM   crm_project_units u
          JOIN   properties        p ON p.id = u.property_id
          WHERE  u.id        = crm_unit_documents.unit_id
            AND  p.owner_id = auth.uid()
        )
      );
  END IF;
END $$;

-- ── 5. deals.unit_id (aus 20260509_deals_unit_id.sql) ────────────────────────

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES crm_project_units(id) ON DELETE SET NULL;

-- ── 6. Portal-E-Mail-Vorlage (aus 20260509_portal_email_template.sql) ─────────

INSERT INTO email_templates (name, subject, body, category, language)
SELECT
  'Portal-Zugang (Standard)',
  'Dein Zugang zum Happy Property Portal',
  E'Hallo {{vorname}},\n\ndein Zugang zum Happy Property Eigentümer-Portal ist jetzt eingerichtet.\n\nIm Portal findest du:\n- Deine Immobiliendaten\n- Alle Kaufunterlagen\n- Deine Zahlungsübersichten\n\nBitte ändere dein Passwort direkt nach dem ersten Login.\n\nViele Grüße\nSven Rüprich\nHappy Property',
  'portal',
  'de'
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE category = 'portal' AND language = 'de'
);
