-- ── CRM Projects + Units + Deal-Projects ──────────────────────────────────────
-- Im Supabase SQL Editor ausführen.

-- 1. Developers (für Dropdown)
CREATE TABLE IF NOT EXISTS crm_developers (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  website    text,
  notes      text,
  created_at timestamptz DEFAULT now()
);

-- 2. Projekte (Neubauprojekte im Verkauf)
CREATE TABLE IF NOT EXISTS crm_projects (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name               text NOT NULL,
  developer_id       uuid REFERENCES crm_developers(id) ON DELETE SET NULL,
  description_de     text,
  description_en     text,
  location           text,
  latitude           numeric(10,7),
  longitude          numeric(10,7),
  status             text DEFAULT 'available' CHECK (status IN ('available','under_construction','sold_out','completed')),
  completion_date    date,
  images             text[] DEFAULT '{}',
  video_url          text,
  equipment_list     text,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

-- 3. Units (einzelne Wohnungen)
CREATE TABLE IF NOT EXISTS crm_project_units (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id  uuid NOT NULL REFERENCES crm_projects(id) ON DELETE CASCADE,
  unit_number text NOT NULL,
  type        text DEFAULT 'apartment' CHECK (type IN ('villa','apartment','studio')),
  bedrooms    smallint DEFAULT 0,
  size_sqm    numeric(8,2),
  price_net   numeric(12,2),
  status      text DEFAULT 'available' CHECK (status IN ('available','reserved','sold','under_construction')),
  floor       smallint,
  notes       text,
  property_id uuid REFERENCES properties(id) ON DELETE SET NULL,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- 4. Deal–Projekt-Verknüpfung
CREATE TABLE IF NOT EXISTS deal_projects (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id      uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES crm_projects(id) ON DELETE CASCADE,
  unit_numbers text,
  price_net    numeric(12,2),
  notes        text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

-- 5. properties: neuer Status-Kolumne
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS prop_status text DEFAULT 'active'
    CHECK (prop_status IN ('active','under_construction','inactive')),
  ADD COLUMN IF NOT EXISTS expected_completion date;

-- 6. updated_at Trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'crm_projects_updated_at') THEN
    CREATE TRIGGER crm_projects_updated_at
      BEFORE UPDATE ON crm_projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'crm_project_units_updated_at') THEN
    CREATE TRIGGER crm_project_units_updated_at
      BEFORE UPDATE ON crm_project_units FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'deal_projects_updated_at') THEN
    CREATE TRIGGER deal_projects_updated_at
      BEFORE UPDATE ON deal_projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- 7. RLS
ALTER TABLE crm_developers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_projects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_project_units  ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_projects       ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_developers_rw" ON crm_developers FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

CREATE POLICY "crm_projects_rw" ON crm_projects FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

CREATE POLICY "crm_project_units_rw" ON crm_project_units FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

CREATE POLICY "deal_projects_rw" ON deal_projects FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));
