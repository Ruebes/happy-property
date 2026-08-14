-- PropertyDetail "Neue Rate hinzufuegen" schreibt uploaded_by (wie die
-- Nachbar-Tabellen crm_unit_documents/construction_photos) - Spalte fehlte,
-- PostgREST warf "Could not find the 'uploaded_by' column" (Sven 14.8.).
alter table crm_unit_payments add column if not exists uploaded_by uuid references profiles(id) on delete set null;
