-- D) Termin-gebucht-Verzweigung: Bedingung um has_zoom / no_zoom erweitern.
-- has_zoom = zukünftiger Termin MIT zoom_link (Zoom-Variante)
-- no_zoom  = zukünftiger Termin OHNE zoom_link (Telefon-Variante)
alter table automation_rules drop constraint if exists automation_rules_appt_cond_check;
alter table automation_rules add constraint automation_rules_appt_cond_check
  check (appointment_condition in ('none','no_appointment','has_appointment','has_zoom','no_zoom'));
