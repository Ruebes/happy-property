-- ── Portal-Zugang & Kaufunterlagen-Dateien ────────────────────────────────────
-- Migration: 20260428_portal_access.sql

-- ── 1. crm_unit_payments: Rechnungs- und Zahlungsbeleg-Dateifelder ────────────

ALTER TABLE crm_unit_payments
  ADD COLUMN IF NOT EXISTS invoice_path      text,
  ADD COLUMN IF NOT EXISTS invoice_filename   text,
  ADD COLUMN IF NOT EXISTS invoice_filesize   bigint,
  ADD COLUMN IF NOT EXISTS receipt_path      text,
  ADD COLUMN IF NOT EXISTS receipt_filename   text,
  ADD COLUMN IF NOT EXISTS receipt_filesize   bigint;

-- ── 2. Eigentuemer-Lesezugriff auf crm_unit_payments ─────────────────────────
-- Eigentümer darf Zahlungen zu seiner Wohnung lesen
-- (via crm_project_units.property_id → properties.owner_id = auth.uid())

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'crm_unit_payments'
      AND policyname = 'unit_payments_owner_read'
  ) THEN
    CREATE POLICY "unit_payments_owner_read" ON crm_unit_payments
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM   crm_project_units u
          JOIN   properties        p ON p.id = u.property_id
          WHERE  u.id             = crm_unit_payments.unit_id
            AND  p.owner_id      = auth.uid()
        )
      );
  END IF;
END $$;

-- ── 3. Eigentuemer-Lesezugriff auf crm_unit_documents ────────────────────────
-- Eigentümer darf Dokumente zu seiner Wohnung lesen

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'crm_unit_documents'
      AND policyname = 'unit_docs_owner_read'
  ) THEN
    CREATE POLICY "unit_docs_owner_read" ON crm_unit_documents
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM   crm_project_units u
          JOIN   properties        p ON p.id = u.property_id
          WHERE  u.id             = crm_unit_documents.unit_id
            AND  p.owner_id      = auth.uid()
        )
      );
  END IF;
END $$;

-- ── 4. Storage Bucket: unit-documents – Eigentuemer darf lesen ───────────────
-- (Manuell im Supabase Dashboard ergänzen: Storage → unit-documents → Policies)
-- SELECT-Policy für Eigentuemer:
--   USING (
--     EXISTS (
--       SELECT 1 FROM crm_project_units u
--       JOIN properties p ON p.id = u.property_id
--       WHERE u.id::text = split_part(name, '/', 2)
--         AND p.owner_id = auth.uid()
--     )
--   )
