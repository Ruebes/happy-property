-- Öffentlicher „Termin verwalten"-Link (verschieben/absagen ohne Login).
-- Token ist appointment-gebunden; der Link steht in Bestätigung + Erinnerungen
-- ({{termin_link}}-Platzhalter in schedule-message).
alter table crm_appointments
  add column if not exists manage_token uuid not null default gen_random_uuid();

create unique index if not exists crm_appointments_manage_token_idx
  on crm_appointments (manage_token);
