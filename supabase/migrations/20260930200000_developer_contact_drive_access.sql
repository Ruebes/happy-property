-- Bauträger-Kontakte: wer bekommt nach der Reservierung automatisch Zugang zum
-- Drive-Kundenordner (Regel "Reservierung → Developer", drive_share unit_developer).
-- Ist bei einem Bauträger niemand angehakt, bleibt es beim Hauptkontakt.
alter table public.crm_developer_contacts
  add column if not exists drive_access boolean not null default false;

-- EMMETRE LTD: Aaron Israel + Oxana Mosetti (Svens Freigabe 30.09.2026)
update public.crm_developer_contacts set drive_access = true
 where id in ('82e528fd-ce5e-4cfa-a31d-3cd3631a501d', 'e94c900c-522c-4942-ba78-75631c484802');
