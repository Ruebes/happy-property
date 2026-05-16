-- Migration: Baustellenbilder

-- ── Tabelle ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS construction_photos (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id  uuid        NOT NULL REFERENCES crm_projects(id) ON DELETE CASCADE,
  file_path   text        NOT NULL,
  file_name   text        NOT NULL,
  file_size   bigint,
  photo_date  date,
  description text,
  uploaded_by uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_construction_photos_project_id ON construction_photos(project_id);
CREATE INDEX IF NOT EXISTS idx_construction_photos_photo_date ON construction_photos(photo_date DESC);

ALTER TABLE construction_photos ENABLE ROW LEVEL SECURITY;

-- Admin: Vollzugriff
CREATE POLICY "construction_photos_admin" ON construction_photos
  FOR ALL TO public
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');

-- Eigentümer: nur lesen, nur für Projekte wo sie eine Wohnung haben
CREATE POLICY "construction_photos_eigentuemer_select" ON construction_photos
  FOR SELECT TO public
  USING (
    current_user_role() = 'eigentuemer' AND
    EXISTS (
      SELECT 1
      FROM   crm_project_units u
      JOIN   properties p ON p.id = u.property_id
      WHERE  u.project_id = construction_photos.project_id
        AND  p.owner_id   = auth.uid()
    )
  );

-- ── Storage Bucket ─────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'construction-photos',
  'construction-photos',
  true,
  52428800,   -- 50 MB
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Bucket-Policy: Admin kann alles, Eigentümer nur lesen
CREATE POLICY "construction_photos_bucket_admin" ON storage.objects
  FOR ALL TO public
  USING (bucket_id = 'construction-photos' AND current_user_role() = 'admin')
  WITH CHECK (bucket_id = 'construction-photos' AND current_user_role() = 'admin');

CREATE POLICY "construction_photos_bucket_eigentuemer_select" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'construction-photos');
