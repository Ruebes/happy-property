-- ── CRM Appointments ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_appointments (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id           uuid        REFERENCES leads(id) ON DELETE CASCADE,
  deal_id           uuid        REFERENCES deals(id),
  title             text        NOT NULL,
  description       text,
  type              text        DEFAULT 'zoom'
                                CHECK (type IN ('zoom', 'inperson', 'phone')),
  start_time        timestamptz NOT NULL,
  end_time          timestamptz NOT NULL,
  zoom_link         text,
  zoom_meeting_id   text,
  location          text,
  location_url      text,
  phone_number      text,
  google_event_id   text,
  google_calendar_id text,
  created_by        uuid        REFERENCES profiles(id),
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

ALTER TABLE crm_appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_verwalter_all"
  ON crm_appointments FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND   role IN ('admin', 'verwalter')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND   role IN ('admin', 'verwalter')
    )
  );

-- updated_at auto-update trigger
CREATE OR REPLACE FUNCTION set_crm_appointments_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_appointments_updated_at
  BEFORE UPDATE ON crm_appointments
  FOR EACH ROW EXECUTE FUNCTION set_crm_appointments_updated_at();
