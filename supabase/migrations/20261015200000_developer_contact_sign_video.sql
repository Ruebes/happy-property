-- Eigenes WhatsApp-Video je Bauträger-Kontakt für Unterschrifts-Anfragen
-- (Reservierungsvertrag + Spezifikationen). Öffentliche MP4-URL; leer = Standardbild.
alter table public.crm_developer_contacts
  add column if not exists sign_wa_video text;
