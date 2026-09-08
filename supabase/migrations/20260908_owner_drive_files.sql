-- Eigentümerportal → Google Drive: Kunden laden Dateien in ihren Kundenordner
-- hoch, und alle Personen mit Zugriff auf den Ordner bekommen von Lotte eine
-- WhatsApp (wer hat was hochgeladen). Diese Tabelle merkt sich jede gesehene
-- Datei, damit der 5-Minuten-Sweep (owner-drive action=sweep) nur NEUE Dateien
-- meldet und nichts doppelt schickt.
--
-- Nur Edge-Functions (Service-Role) schreiben/lesen hier → RLS an, keine Policy
-- (deny-all, siehe Security-Advisor-Regel vom 27.7.2026).

create table if not exists public.drive_folder_files (
  file_id        text primary key,                 -- Google-Drive-Datei-ID
  lead_id        uuid references public.leads(id) on delete cascade,
  folder_id      text not null,                    -- Kundenordner (leads.drive_folder_id)
  name           text not null,
  mime_type      text,
  size_bytes     bigint,
  web_view_link  text,
  path           text,                             -- Unterordner-Pfad im Kundenordner ('' = Wurzel)
  uploader_name  text,
  uploader_email text,
  source         text not null default 'drive',    -- 'portal' | 'drive' | 'baseline'
  created_time   timestamptz,                      -- createdTime laut Drive
  seen_at        timestamptz not null default now(),
  notified_at    timestamptz,
  notify_result  jsonb
);
create index if not exists drive_folder_files_lead_idx on public.drive_folder_files(lead_id, seen_at desc);

alter table public.drive_folder_files enable row level security;

-- Zusatz-Zuordnung E-Mail → WhatsApp für Google-Konten, die in keiner
-- Kontakt-Tabelle stehen (Svens private Google-Konten). Format:
-- {"mail@x.de": {"phone": "+357…", "name": "Sven"}}
insert into public.crm_settings (key, value)
values ('drive_notify_contacts', '{"r.u.e.b.e@gmx.de":{"phone":"+35795096409","name":"Sven"},"happypropertycyprus@gmail.com":{"phone":"+35795096409","name":"Sven"},"sven@happy-property.com":{"phone":"+35795096409","name":"Sven"}}')
on conflict (key) do nothing;
