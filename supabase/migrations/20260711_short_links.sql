-- Kurzlinks für WhatsApp (lange Kalender-/Zusage-URLs → portal.../s/<code>).
-- Erstellen dürfen nur eingeloggte CRM-Nutzer (kein offener Redirect-Dienst);
-- auflösen darf jeder (die Links stehen in Kunden-Nachrichten).
create table if not exists public.short_links (
  code       text primary key,
  target     text not null,
  created_at timestamptz not null default now()
);
alter table public.short_links enable row level security;
drop policy if exists short_links_select on public.short_links;
create policy short_links_select on public.short_links for select to anon, authenticated using (true);
drop policy if exists short_links_insert on public.short_links;
create policy short_links_insert on public.short_links for insert to authenticated with check (true);
