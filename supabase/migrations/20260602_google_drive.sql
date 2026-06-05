-- Migration: Google Drive Integration
-- Fügt google_drive_folder_id zu deals hinzu und erstellt crm_settings Tabelle

-- 1) folder_id zu deals
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS google_drive_folder_id text;

-- 2) crm_settings – Key/Value Store für system-weite Einstellungen
CREATE TABLE IF NOT EXISTS crm_settings (
  key   text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- RLS: nur authenticated users lesen, nur service_role schreibt
ALTER TABLE crm_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "crm_settings_read" ON crm_settings
  FOR SELECT TO authenticated USING (true);

CREATE POLICY IF NOT EXISTS "crm_settings_service_write" ON crm_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
