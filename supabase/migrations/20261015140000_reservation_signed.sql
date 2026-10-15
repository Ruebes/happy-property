-- Sven 15.10.26: Der Bauträger schickt den unterschriebenen Reservierungsvertrag nicht an
-- den Kunden, sondern lädt ihn in den Drive-Kundenordner (Kunde + Anwalt haben Zugriff).
-- reservation-agreement erkennt ihn dort und legt ihn an der Wohnung ab (Portal: „Verträge").
alter table public.reservation_agreements add column if not exists signed_file_id text;
alter table public.reservation_agreements drop constraint if exists reservation_agreements_status_check;
alter table public.reservation_agreements add constraint reservation_agreements_status_check
  check (status in ('wartet_ausweis', 'pruefen', 'gesendet', 'unterschrieben', 'fehler', 'abgebrochen'));
drop index if exists public.reservation_agreements_offen;
create index if not exists reservation_agreements_offen on public.reservation_agreements (created_at)
  where status in ('wartet_ausweis', 'pruefen', 'gesendet');
