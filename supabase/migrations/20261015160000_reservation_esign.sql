-- Digitale Unterschrift des Bauträgers (Sven 15.10.26): Valery bekommt den ausgefüllten
-- Reservierungsvertrag per WhatsApp/Mail mit Link /sign/r/<token>, unterschreibt am Handy
-- (Touch-Unterschrift + Name in Druckbuchstaben), Ort und Datum setzt das System.
-- Das unterschriebene PDF landet im Drive-Kundenordner und an der Wohnung („Verträge").
alter table public.reservation_agreements
  add column if not exists sign_token         text,
  add column if not exists test_sign_token    text,
  add column if not exists template_snapshot  jsonb,
  add column if not exists seller_signed_at   timestamptz,
  add column if not exists seller_signer_name text,
  add column if not exists seller_sign_meta   jsonb,
  add column if not exists signed_pdf_path    text;
create unique index if not exists reservation_agreements_sign_token on public.reservation_agreements (sign_token) where sign_token is not null;
create unique index if not exists reservation_agreements_test_sign_token on public.reservation_agreements (test_sign_token) where test_sign_token is not null;

-- Ort, der beim Unterschreiben automatisch eingesetzt wird
alter table public.reservation_templates add column if not exists sign_place text;
update public.reservation_templates set sign_place = 'Paphos, Cyprus' where sign_place is null and name = 'Reservierung Mito';

-- Testlauf (Unterschrift nur an Sven): eigene Daten, damit ein Test den echten Vertrag nie überschreibt
alter table public.reservation_agreements add column if not exists test_payload jsonb;
