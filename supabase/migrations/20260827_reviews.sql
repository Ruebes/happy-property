-- Kundenbewertungen: Fragebogen per WhatsApp-Link (Lotte), optionales Foto mit
-- Einwilligung (jederzeit widerrufbar), Freigabe fuer die Website.
-- Zugriff NUR ueber die Edge Function review-api (service role) — keine
-- anon/authenticated-Policies noetig, RLS bleibt dicht.

create table if not exists review_requests (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid references leads(id) on delete set null,
  token              text unique not null default encode(gen_random_bytes(9), 'hex'),
  recipient_name     text not null,
  language           text not null default 'de',           -- de|en (leads.language)
  status             text not null default 'sent',          -- sent|submitted
  answers            jsonb not null default '{}'::jsonb,    -- { q1..q5: text }
  rating             int check (rating between 1 and 5),
  review_text        text,
  photo_path         text,                                  -- Pfad im Bucket review-photos
  consent_given_at   timestamptz,                           -- Haken "duerft ihr verwenden"
  consent_revoked_at timestamptz,                           -- Kunde hat Erlaubnis entzogen
  published          boolean not null default false,        -- auf der Website sichtbar
  sent_at            timestamptz,
  submitted_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table review_requests enable row level security;

create index if not exists review_requests_lead_idx on review_requests (lead_id);

-- Oeffentlicher Bucket fuer Kundenfotos (Website zeigt sie direkt an)
insert into storage.buckets (id, name, public)
values ('review-photos', 'review-photos', true)
on conflict (id) do nothing;
