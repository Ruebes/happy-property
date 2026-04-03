-- ══════════════════════════════════════════════════════════════
-- 009 – Invoice Fields
-- Erweitert documents um Rechnungs-spezifische Felder
-- ══════════════════════════════════════════════════════════════

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS invoice_date   DATE,
  ADD COLUMN IF NOT EXISTS due_date       DATE,
  ADD COLUMN IF NOT EXISTS paid_at        DATE,
  ADD COLUMN IF NOT EXISTS description    TEXT,
  ADD COLUMN IF NOT EXISTS creditor_iban  TEXT,
  ADD COLUMN IF NOT EXISTS notes          TEXT,
  ADD COLUMN IF NOT EXISTS vat_rate       NUMERIC(5,2);

-- Index für Status-Abfragen (offene/überfällige Rechnungen)
CREATE INDEX IF NOT EXISTS idx_documents_paid_at
  ON documents(paid_at) WHERE type = 'rechnung';

CREATE INDEX IF NOT EXISTS idx_documents_due_date
  ON documents(due_date) WHERE type = 'rechnung';
