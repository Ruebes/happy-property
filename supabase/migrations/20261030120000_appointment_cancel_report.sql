-- Absage-Meldung am Termin (Eva Hahn, 29.10.2026): Eva schrieb per WhatsApp
-- "Ich moechte den Termin absagen", der Termin blieb aktiv, die 1-h-Erinnerung
-- ging trotzdem raus und der Bautraeger wusste von nichts.
--
-- Sagt ein Kunde einen anstehenden Termin ab oder will verschieben, loescht Lotte
-- (booking-bot) den Termin NICHT, sondern markiert ihn hier. Erinnerungen
-- (schedule-message, process-scheduled-messages) und das Bautraeger-Briefing
-- (developer-briefing) lassen markierte Termine aus. Sven entscheidet ueber die
-- Aufgabe, ob der Termin geloescht, verschoben oder die Meldung zurueckgenommen wird.
alter table public.crm_appointments
  add column if not exists cancel_reported_at   timestamptz,
  add column if not exists cancel_reported_kind text,
  add column if not exists cancel_reported_text text;

alter table public.crm_appointments drop constraint if exists crm_appointments_cancel_reported_kind_check;
alter table public.crm_appointments add constraint crm_appointments_cancel_reported_kind_check
  check (cancel_reported_kind is null or cancel_reported_kind in ('absage', 'verschieben'));

comment on column public.crm_appointments.cancel_reported_at   is 'Kunde hat abgesagt oder will verschieben (Lotte/booking-bot). Gesetzt = keine Erinnerungen, kein Bautraeger-Briefing.';
comment on column public.crm_appointments.cancel_reported_kind is 'absage | verschieben';
comment on column public.crm_appointments.cancel_reported_text is 'Die Kundennachricht, an der die Absage erkannt wurde.';

-- Wird der Termin auf eine neue Zeit gelegt, ist die Meldung erledigt: fuer die
-- neue Zeit laufen die Erinnerungen wieder normal (der Verschiebe-Guard in
-- process-scheduled-messages plant sie neu).
create or replace function public.hp_clear_cancel_report_on_move()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.start_time is distinct from old.start_time
     and new.cancel_reported_at is not null
     and new.cancel_reported_at is not distinct from old.cancel_reported_at then
    new.cancel_reported_at   := null;
    new.cancel_reported_kind := null;
    new.cancel_reported_text := null;
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_clear_cancel_report_on_move on public.crm_appointments;
create trigger trg_clear_cancel_report_on_move
  before update of start_time on public.crm_appointments
  for each row execute function public.hp_clear_cancel_report_on_move();
