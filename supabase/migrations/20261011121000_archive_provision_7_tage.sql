-- Deals in „Provision erhalten" werden nach 7 statt 10 Tagen archiviert (Sven 11.10.2026).
-- Dorthin rückt ein Deal jetzt automatisch, sobald revolut-sync die Provisionsrechnung als
-- bezahlt erkennt. phase_changed_at setzt der Trigger hp_stamp_phase_changed.
CREATE OR REPLACE FUNCTION public.hp_archive_completed_deals()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_count integer;
begin
  with archived as (
    update deals set archived_from_phase = phase, phase = 'archiviert'
    where phase = 'provision_erhalten'
      and phase_changed_at is not null
      and phase_changed_at < now() - interval '7 days'
    returning id
  ) select count(*) into v_count from archived;
  return v_count;
end $function$;
