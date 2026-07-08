-- Bestands-Bug: process-scheduled-messages setzt bei nicht erfüllter Termin-Bedingung
-- (has_zoom/no_zoom/…) status='skipped' — der Check-Constraint kannte 'skipped' aber
-- nicht, das Update schlug still fehl und die Zeile hing für immer auf 'processing'
-- (kein Doppelversand, aber Karteileichen + verlorene Skip-Semantik).
alter table scheduled_messages drop constraint if exists scheduled_messages_status_check;
alter table scheduled_messages add constraint scheduled_messages_status_check
  check (status in ('pending','processing','sent','cancelled','failed','skipped'));

-- Hängende Altlasten bereinigen: processing älter als 10 Minuten ist tot
-- (ein Lauf ist nach Sekunden fertig) → als skipped markieren.
update scheduled_messages
set status = 'skipped',
    error_message = coalesce(error_message, 'Bereinigt: hing auf processing (skipped-Constraint-Bug)')
where status = 'processing' and scheduled_at < now() - interval '10 minutes';
