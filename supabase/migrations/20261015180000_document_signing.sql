-- Sven 15.10.26 (2): Stempel des Bauträgers + digitale Unterschrift für Spezifikationen.
--
-- 1) Firmenstempel je Bauträger: der Bauträger lädt auf der Unterschriftsseite ein Foto seines
--    Stempels hoch (oder Sven im CRM); gespeichert im privaten Bucket developer-seals und für
--    alle Dokumente dieses Bauträgers verwendet. Beim Unterschreiben wählbar: mit/ohne Stempel.
alter table public.crm_developers
  add column if not exists seal_path        text,
  add column if not exists seal_updated_at  timestamptz,
  add column if not exists seal_uploaded_by text;
insert into storage.buckets (id, name, public) values ('developer-seals', 'developer-seals', false)
on conflict (id) do nothing;

-- 2) Sprache des Unterzeichners (crm_developer_contacts.language) für Seite + Nachrichten
alter table public.reservation_agreements add column if not exists signer_lang text;

-- 3) Weitere Dokumente zur Unterschrift (zuerst: Spezifikationen). Sven lädt das PDF im CRM
--    hoch, der Bauträger unterschreibt am Handy (/sign/d/<token>): Unterschrift, Name in
--    Druckbuchstaben und Datum auf JEDER Seite + im Unterschriftsfeld, optional Stempel.
--    Danach: Drive-Kundenordner, Objekt im Eigentümerportal (crm_unit_documents), Mail an den
--    Anwalt (crm_settings.sign_docs_lawyer, Standard Timotheos), WhatsApp an Sven.
create table if not exists public.sign_documents (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  kind             text not null default 'specification' check (kind in ('specification', 'other')),
  title            text not null,
  deal_id          uuid references public.deals(id) on delete set null,
  lead_id          uuid not null references public.leads(id) on delete cascade,
  unit_id          uuid references public.crm_project_units(id) on delete set null,
  developer_id     uuid not null references public.crm_developers(id) on delete cascade,
  source_path      text not null,
  source_name      text,
  token            text not null,
  test             boolean not null default false,
  status           text not null default 'offen' check (status in ('offen', 'unterschrieben', 'abgebrochen', 'fehler')),
  signer_lang      text not null default 'en',
  sent_at          timestamptz,
  sent_to          text[],
  signed_at        timestamptz,
  signer_name      text,
  sign_meta        jsonb,
  signed_pdf_path  text,
  unit_document_id uuid,
  drive_file_id    text,
  error            text
);
create unique index if not exists sign_documents_token on public.sign_documents (token);
create index if not exists sign_documents_lead on public.sign_documents (lead_id, created_at desc);
alter table public.sign_documents enable row level security;
drop policy if exists sign_documents_team_lesen on public.sign_documents;
create policy sign_documents_team_lesen on public.sign_documents for select to authenticated
  using ((select public.current_user_role()) = any (array['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]));

insert into public.crm_settings (key, value) values ('sign_docs_lawyer', 'bc:82d3bb70-7974-4e01-9531-5642057d7872')
on conflict (key) do nothing;

-- 4) Review 15.10.: Drive-Dateien, die das System selbst hochgeladen hat (z. B. die digital
--    unterschriebene Fassung), dürfen nie als „neue Unterschrift des Bauträgers" gelten -
--    auch nicht nach einem erneuten Senden.
alter table public.reservation_agreements add column if not exists own_file_ids text[] not null default '{}';

-- 5) Review 15.10.: Unterschriftslinks (Token) sind Vollmachten. Nur die Edge Function liest
--    die Tabellen (Service-Role); das CRM holt alles über reservation-agreement (Admin-Guard).
drop policy if exists reservation_agreements_team_lesen on public.reservation_agreements;
drop policy if exists sign_documents_team_lesen on public.sign_documents;
