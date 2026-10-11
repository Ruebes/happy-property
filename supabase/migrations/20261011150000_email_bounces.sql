-- Unzustellbare Mailadressen (Sven 11.10.26): Newsletter nicht mehr an Adressen
-- schicken, die nachweislich nicht ankommen (IONOS-Limit ~50/h). Diese Empfaenger
-- bekommen den Newsletter per WhatsApp, ohne Nummer fallen sie raus.
--
-- Bewusst eigene Tabelle statt Spalte an leads/newsletter_subscribers: Schluessel
-- ist die ADRESSE (kleingeschrieben, googlemail -> gmail). Korrigiert Sven die
-- Adresse am Kontakt, gilt die neue sofort wieder als zustellbar.
--
-- Quellen: smtp = IONOS lehnt beim Versand dauerhaft ab (process-scheduled-messages),
-- ndr = Rueckläufer im info@-Postfach (imap-poll), manual = von Hand.
create table if not exists public.email_bounces (
  email        text primary key,
  reason       text,
  source       text not null default 'smtp' check (source in ('smtp', 'ndr', 'manual')),
  -- hard: Adresse gibt es nicht, sofort gesperrt. Weich (Postfach voll, nach Tagen
  -- aufgegeben) zaehlt erst ab bounce_count >= 2 (loadBouncedKeys).
  hard         boolean not null default true,
  bounce_count integer not null default 1,
  first_at     timestamptz not null default now(),
  last_at      timestamptz not null default now()
);

-- Nur Edge Functions (Service-Role) lesen und schreiben. Kein Policy = deny-all
-- fuer anon/authenticated.
alter table public.email_bounces enable row level security;
