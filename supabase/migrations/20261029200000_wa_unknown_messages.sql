-- WhatsApps von Nummern, die (noch) keinem Kontakt gehoeren. Bisher hat der
-- Empfang solche Nachrichten verworfen, Sven sah sie nur am Handy (Sabine und
-- Oliver, 29.10.2026). Der Posteingang zeigt sie jetzt als eigene Gespraeche.
-- Nur Admins: das sind auch private Chats, die Mitarbeiter nichts angehen.
create table if not exists public.wa_unknown_messages (
  id                  uuid primary key default gen_random_uuid(),
  phone               text not null,              -- +49..., nur Ziffern mit +
  push_name           text,                       -- Anzeigename aus WhatsApp
  direction           text not null check (direction in ('inbound', 'outbound')),
  content             text not null,
  whatsapp_message_id text unique,
  read_at             timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists wa_unknown_messages_phone_idx on public.wa_unknown_messages (phone, created_at desc);
create index if not exists wa_unknown_messages_created_idx on public.wa_unknown_messages (created_at desc);

alter table public.wa_unknown_messages enable row level security;
drop policy if exists wa_unknown_admin on public.wa_unknown_messages;
create policy wa_unknown_admin on public.wa_unknown_messages for all to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'admin')
  with check ((select role from public.profiles where id = auth.uid()) = 'admin');
