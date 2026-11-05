-- Reservierung Flora Panorama (Angebotsapartments, Vordruck von Aaron, Sven 5.11.2026):
-- Happy Property füllt aus, erst unterschreibt der Bauträger, dann der Kunde (beide am Handy).
-- Das System führt die Unterschriften in einem PDF zusammen, legt es an der Wohnung und im
-- Drive-Ordner ab und schickt es an beide Seiten.
--
-- Rücknahme:
--   delete from public.reservation_templates where layout = 'flora';
--   drop table if exists public.reservation_sign_parts;
--   alter table public.reservation_agreements
--     drop column if exists buyer_sign_token, drop column if exists test_buyer_sign_token,
--     drop column if exists sign_round, drop column if exists contract,
--     drop column if exists buyer_signed_at,
--     drop column if exists buyer_lang, drop column if exists completed_at,
--     drop column if exists finalizing_at, drop column if exists link_delivery,
--     drop column if exists final_delivery, drop column if exists final_sent_at;
alter table public.reservation_agreements
  add column if not exists buyer_sign_token      text,
  add column if not exists test_buyer_sign_token text,
  add column if not exists sign_round            integer not null default 0,
  add column if not exists contract              jsonb,        -- {net_price, title_deed_amount}: je Vertrag von Sven
  add column if not exists buyer_signed_at       timestamptz,  -- alle Käufer haben unterschrieben
  add column if not exists buyer_lang            text,
  add column if not exists completed_at          timestamptz,  -- beide Seiten fertig, PDF zusammengeführt
  add column if not exists finalizing_at         timestamptz,  -- Sperre beim Zusammenführen
  add column if not exists link_delivery         jsonb,        -- Zustellstand der Unterschriftslinks
  add column if not exists final_delivery        jsonb,        -- Zustellstand des fertigen PDFs
  add column if not exists final_sent_at         timestamptz;  -- Zustellung abgeschlossen
create unique index if not exists reservation_agreements_buyer_sign_token
  on public.reservation_agreements (buyer_sign_token) where buyer_sign_token is not null;
create unique index if not exists reservation_agreements_test_buyer_sign_token
  on public.reservation_agreements (test_buyer_sign_token) where test_buyer_sign_token is not null;

-- Jede Unterschrift eine Zeile: zwei Personen können gleichzeitig unterschreiben, ohne sich zu
-- überschreiben. Ein neuer Versand ist eine neue Runde, alte Runden bleiben als Nachweis liegen
-- und gelten nie für den neuen Stand. Testläufe haben negative Runden.
create table if not exists public.reservation_sign_parts (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  agreement_id uuid not null references public.reservation_agreements(id) on delete cascade,
  round        integer not null,
  side         text not null check (side in ('buyer', 'vendor')),
  signer_key   text not null,
  name         text not null,
  png_path     text not null,
  meta         jsonb not null default '{}'::jsonb,
  unique (agreement_id, round, side, signer_key)
);
-- Nur die Edge Function (Service-Role) liest und schreibt
alter table public.reservation_sign_parts enable row level security;

-- Vorlage: gilt nur für die Angebotsapartments, geht nie ungeprüft raus
insert into public.reservation_templates
  (developer_id, name, is_active, auto_send, logo_text, company_name, title, accent_color, company_address, company_tel,
   property_prefix, project_addresses, bank, notes, sign_place, layout, extra)
select '53bea19c-eb89-4a55-8506-65e255e319e0', 'Reservierung Flora Panorama (Angebot)', true, false, null, 'COMPOSITIVA LTD', 'Reservation Agreement',
  '#406E7E', '13A Mousalla Street, 8047 Paphos, Cyprus', '+357 96 174 777', null, '{}'::jsonb, '{}'::jsonb, null, 'Paphos, Cyprus', 'flora',
  jsonb_build_object(
    'only_project_id', '514d3d8a-449f-419f-9dba-d26a1cb1d1a7',
    'only_units', jsonb_build_array('A105','A203','B106','B107','B206','C101','C102','D103','D104','D204','D205'),
    'vendor_signers', jsonb_build_array(jsonb_build_object('key','marco','name','MARCO MOSETTI'), jsonb_build_object('key','aaron','name','AARON ISRAEL')),
    'vendor_min_signers', 2)
where not exists (select 1 from public.reservation_templates where layout = 'flora');
