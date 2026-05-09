-- Direkte Verknüpfung Deal → CRM-Einheit (unabhängig von property_id)
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES crm_project_units(id) ON DELETE SET NULL;
