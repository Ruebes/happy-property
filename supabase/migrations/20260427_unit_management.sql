-- ── Wohnungsverwaltung: Erweiterte Unit-Felder, Dokumente, Ratenzahlungen ─────
-- Migration: 20260427_unit_management.sql

-- ── 1. crm_project_units: neue Felder ────────────────────────────────────────

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

-- ── 2. Wohnungs-Dokumente ─────────────────────────────────────────────────────
-- Kaufverträge, Zahlungsbelege, Grundrisse, sonstige Unterlagen pro Wohnung.

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

-- ── 3. Ratenzahlungen ─────────────────────────────────────────────────────────
-- Kaufpreisraten pro Wohnung – zeigt Klient offenen Betrag.

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
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unit_payments_unit ON crm_unit_payments(unit_id);

-- updated_at Trigger
CREATE OR REPLACE FUNCTION _fn_unit_payments_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_unit_payments_updated_at ON crm_unit_payments;
CREATE TRIGGER trg_unit_payments_updated_at
  BEFORE UPDATE ON crm_unit_payments
  FOR EACH ROW EXECUTE FUNCTION _fn_unit_payments_updated_at();

-- ── 4. Row Level Security ─────────────────────────────────────────────────────

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

-- ── 5. Storage Bucket (manuell im Supabase Dashboard erstellen) ───────────────
-- Dashboard → Storage → New bucket
--   Name:              unit-documents
--   Public:            NEIN  (private)
--   Max file size:     20971520  (20 MB)
--   Allowed MIME types: application/pdf
--                       application/msword
--                       application/vnd.openxmlformats-officedocument.wordprocessingml.document
--                       image/jpeg, image/png
--
-- Policies (Storage → unit-documents → Policies):
--   SELECT  FOR authenticated
--     USING (EXISTS(SELECT 1 FROM profiles WHERE id=auth.uid() AND role IN ('admin','verwalter')))
--   INSERT  same
--   DELETE  same
