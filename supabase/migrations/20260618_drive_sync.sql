-- Nächtliche Drive-Änderungs-Prüfung: Zeitpunkt des letzten erfolgreichen Sync je Projekt.
-- scan-drive-projects vergleicht die letzte Datei-Änderung im Ordner (Projekt + Developer-Docs)
-- mit drive_synced_at und re-ingestet nur bei Änderung.
alter table crm_projects add column if not exists drive_synced_at timestamptz;
