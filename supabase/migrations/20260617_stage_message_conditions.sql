-- Stage-Nachrichten ohne n8n: Termin-Bedingung, Vor-Termin-Timing, Drive-Trigger.
-- automation_rules = Konfiguration pro Stage-Schritt; scheduled_messages = geplante
-- Nachricht (Bedingung wird zum Sendezeitpunkt erneut geprüft).

-- B) Termin-Bedingung: none | no_appointment | has_appointment
alter table automation_rules add column if not exists appointment_condition text not null default 'none';
alter table automation_rules drop constraint if exists automation_rules_appt_cond_check;
alter table automation_rules add constraint automation_rules_appt_cond_check
  check (appointment_condition in ('none','no_appointment','has_appointment'));

-- C) Timing-Typ: after_event (delay_minutes nach Auslöser) | before_appointment (delay_minutes VOR start_time)
alter table automation_rules add column if not exists timing_type text not null default 'after_event';
alter table automation_rules drop constraint if exists automation_rules_timing_check;
alter table automation_rules add constraint automation_rules_timing_check
  check (timing_type in ('after_event','before_appointment'));

-- F) Drive-Trigger: vor Versand Kundenordner sicherstellen + diesen Empfängern Schreibzugriff geben
alter table automation_rules add column if not exists drive_trigger boolean not null default false;
alter table automation_rules add column if not exists drive_share   text[];   -- Empfänger-Tokens (client/bc:<id>/dc:<id>) oder E-Mails

-- Bedingung an der geplanten Nachricht mitführen → erneute Prüfung beim Senden
alter table scheduled_messages add column if not exists appointment_condition text;

comment on column automation_rules.appointment_condition is 'Termin-Bedingung beim Senden: none / no_appointment (nur ohne Termin) / has_appointment (nur mit Termin).';
comment on column automation_rules.timing_type is 'after_event = delay_minutes nach Auslöser; before_appointment = delay_minutes VOR dem Calendly-Termin (start_time).';
comment on column automation_rules.drive_trigger is 'Vor Versand Drive-Kundenordner sicherstellen und drive_share Schreibzugriff geben.';
comment on column automation_rules.drive_share is 'Empfänger fuer Drive-Schreibzugriff (Tokens client/bc:/dc: oder E-Mails).';
