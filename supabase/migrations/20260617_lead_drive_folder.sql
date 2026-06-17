-- Pro Kunde (Lead) ein Google-Drive-Ordner: ID + Web-Link am Lead speichern,
-- damit der Ordner über mehrere Pipeline-Stages wiederverwendet wird.
alter table leads add column if not exists drive_folder_id  text;
alter table leads add column if not exists drive_folder_url text;

comment on column leads.drive_folder_id  is 'Google-Drive-Ordner-ID des Kunden (create-client-drive-folder).';
comment on column leads.drive_folder_url is 'Web-Link (webViewLink) des Kundenordners.';
