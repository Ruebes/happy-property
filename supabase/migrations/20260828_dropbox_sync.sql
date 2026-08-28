-- Dropbox als zweite Ordner-Quelle fuer den naechtlichen Sync (Kuutio Homes liefert
-- per Dropbox statt Google Drive). prepare-project-assets action 'nightly' scannt
-- Projekte mit gesetztem dropbox_path (Preisliste + Grundriss-Ordner-Ueberwachung).
alter table crm_projects add column if not exists dropbox_path text;

comment on column crm_projects.dropbox_path is
  'Dropbox-Ordnerpfad des Projekts (z.B. /ALL AGENTS/BAIA (UNDER CONSTRUCTION)); Root-Pfad = Developer-Masterliste. Auth via connector_secrets DROPBOX_APP_KEY/APP_SECRET/REFRESH_TOKEN.';
