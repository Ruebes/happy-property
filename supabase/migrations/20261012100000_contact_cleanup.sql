-- Kontakt-Bereinigung (Sven 12.10.26): Mail falsch -> WhatsApp, WhatsApp auch
-- falsch -> Kontakt löschen. Siehe supabase/functions/contact-cleanup.

-- Nummern ohne WhatsApp (process-scheduled-messages: „Diese Nummer hat kein WhatsApp").
-- Schlüssel = nur Ziffern mit Ländervorwahl (_shared/phonePlausible.ts phoneKey).
create table if not exists public.wa_unreachable (
  phone    text primary key,
  reason   text,
  first_at timestamptz not null default now(),
  last_at  timestamptz not null default now()
);
alter table public.wa_unreachable enable row level security;

-- Vormerkungen und Protokoll. Nach dem Löschen bleiben nur „gelöscht", Grund und
-- Datum (keine Personendaten).
create table if not exists public.contact_cleanup (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid,
  subscriber_id uuid,
  name          text,
  email         text,
  phone         text,
  reason        text,
  marked_at     timestamptz not null default now(),
  delete_after  timestamptz not null,
  deleted_at    timestamptz,
  kept_at       timestamptz
);
create unique index if not exists contact_cleanup_offen_lead on public.contact_cleanup (lead_id) where deleted_at is null and kept_at is null and lead_id is not null;
create unique index if not exists contact_cleanup_offen_sub on public.contact_cleanup (subscriber_id) where deleted_at is null and kept_at is null and subscriber_id is not null;
alter table public.contact_cleanup enable row level security;

-- Sperr-Regel verschärft (Fall Schäck): sofort gesperrt nur „Adresse gibt es
-- nicht" (5.1.x) oder von Hand, alles andere ab der zweiten Meldung.
update public.email_bounces set hard = false where source in ('ndr', 'smtp') and reason !~ '^5\.1\.';

-- Bisherige „kein WhatsApp"-Fehlschläge übernehmen.
insert into public.wa_unreachable (phone, reason)
select distinct on (k) k, 'kein WhatsApp (fehlgeschlagene Nachrichten bis 12.10.)'
from (
  select regexp_replace(regexp_replace(regexp_replace(coalesce(l.whatsapp, l.phone, s.phone), '\D', '', 'g'), '^00', ''), '^0', '49') k
  from public.scheduled_messages m
  left join public.leads l on l.id = m.lead_id
  left join public.newsletter_subscribers s on s.id = m.subscriber_id
  where m.status = 'failed' and m.error_message ilike '%kein WhatsApp%'
) x where length(k) >= 8
on conflict (phone) do nothing;

-- Die Lösch-Funktion contact-cleanup und ihr Cron kommen erst nach Svens Freigabe.
