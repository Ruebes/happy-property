-- ── Workflow Dokumente mit Supabase Storage ──────────────────────────────────
-- HINWEIS: Storage Bucket + Policies müssen im Supabase Dashboard / SQL-Editor
-- ausgeführt werden, da storage.* Tabellen nur per Service-Role erreichbar sind.
--
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('workflow-documents', 'workflow-documents', false)
-- ON CONFLICT DO NOTHING;
--
-- CREATE POLICY "admin_upload" ON storage.objects FOR INSERT TO authenticated
-- WITH CHECK (bucket_id = 'workflow-documents' AND EXISTS (
--   SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
--
-- CREATE POLICY "admin_read" ON storage.objects FOR SELECT TO authenticated
-- USING (bucket_id = 'workflow-documents' AND EXISTS (
--   SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
--
-- CREATE POLICY "service_role_all" ON storage.objects FOR ALL TO service_role
-- USING (bucket_id = 'workflow-documents');

-- ── workflow_documents Tabelle ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_documents (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name        text NOT NULL,
  description text,
  category    text NOT NULL CHECK (category IN (
    'finanzierung_de',
    'finanzierung_cy',
    'willkommen',
    'kaufvertrag',
    'sonstiges'
  )),
  file_path   text NOT NULL,
  file_name   text NOT NULL,
  file_size   integer,
  mime_type   text,
  active      boolean DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_documents_category_idx
  ON workflow_documents (category, active, created_at DESC);

ALTER TABLE workflow_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_only"
  ON workflow_documents FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND role = 'admin'
    )
  );
