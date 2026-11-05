-- Reservierung Flora Panorama, automatischer Ablauf (Sven 5.11.2026): Der Kunde trägt seine Adresse
-- selbst ein (Seite /sign/a/:token), sie kommt in den Vertrag und zum Kunden ins CRM. Eine Prüfung
-- entscheidet, ob der Vertrag ohne Sven zum Bauträger geht.
--
-- Rücknahme:
--   update public.reservation_templates set auto_send = false, extra = extra - 'manual_units' where layout = 'flora';
--   drop index if exists public.reservation_agreements_address_token;
--   alter table public.reservation_agreements
--     drop column if exists address_token, drop column if exists customer_data, drop column if exists auto_check;
--   alter table public.leads
--     drop column if exists street, drop column if exists postal_code, drop column if exists city;

alter table public.leads
  add column if not exists street text,
  add column if not exists postal_code text,
  add column if not exists city text;

alter table public.reservation_agreements
  add column if not exists address_token text,
  add column if not exists customer_data jsonb,
  add column if not exists auto_check jsonb;

create unique index if not exists reservation_agreements_address_token
  on public.reservation_agreements (address_token) where address_token is not null;

-- Erst nach dem Ausrollen von reservation-agreement und schedule-message ausführen:
-- Automatik für Flora an. B106 hat kundenbezogene Preise, geht also nur mit von Hand eingetragenem Preis.
update public.reservation_templates
  set auto_send = true, extra = extra || '{"manual_units":["B106"]}'::jsonb
  where id = '2a258e36-e10c-4d89-8eed-cd2c4e5796fa' and layout = 'flora';
