-- Upload-Seite /sign/u/:token (Sven 7.11.2026): Wer etwas hochladen soll, bekommt einen Link und
-- braucht kein Google-Konto. Die Dateien landen im Drive-Kundenordner. Gilt für Kunden, Bauträger,
-- Anwälte, Partner und das Team. Der Link erlaubt nur das Hochladen, nie das Lesen.
create table if not exists public.upload_links (
  id           uuid primary key default gen_random_uuid(),
  token        text not null unique,
  lead_id      uuid not null references public.leads(id) on delete cascade,
  empfaenger   text not null check (empfaenger in ('kunde', 'bautraeger', 'anwalt', 'partner', 'team')),
  name         text not null,        -- steht in Lottes Meldung als „hochgeladen von“
  email        text,
  phone        text,                 -- bekommt keine Meldung über die eigene Datei
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists upload_links_lead_idx on public.upload_links(lead_id, empfaenger);

-- Nur die Edge Functions (Service-Role) lesen und schreiben, wie bei drive_folder_files
alter table public.upload_links enable row level security;

-- Datei kam über einen Link: Der Sweep meldet sie gesammelt und kennt den Hochladenden.
alter table public.drive_folder_files add column if not exists upload_link_id uuid references public.upload_links(id) on delete set null;
create index if not exists drive_folder_files_upload_link_idx on public.drive_folder_files(upload_link_id) where upload_link_id is not null;
