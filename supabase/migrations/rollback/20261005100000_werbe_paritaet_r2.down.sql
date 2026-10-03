-- Rückbau zu 20261005100000_werbe_paritaet_r2.sql (von Hand ausführen; liegt im
-- Unterordner, damit die Supabase-CLI die Datei nicht als Migration einspielt).
--
-- Entfernt die drei Conversion-Leads-Trigger und ihre Funktionen sowie den pg_cron-Job
-- werbe-signal-nachholen. Die Standard-Ereignisse (Trigger aus 20261003112000) bleiben unberührt.
-- Noch offene CRM-Stufen im Ausgang werden auf 'uebersprungen' (grund 'rueckbau') gesetzt,
-- damit werbe-signal sie nicht mehr anfasst; die Zeilen selbst bleiben als Verlauf erhalten.
-- Der event_name-Check kommt auf den Stand von 20261003112000 zurück, als NOT VALID: die
-- vorhandenen Stufen-Zeilen bleiben lesbar, neue Zeilen werden wieder streng geprüft.
-- Vorher am besten werbe-signal mit der alten Fassung deployen (die neue überspringt
-- CRM-Stufen ohnehin, wenn capi_echtzeit aus ist).

begin;

set local lock_timeout = '5s';

drop trigger if exists werbe_capi_crm_lead   on public.leads;
drop trigger if exists werbe_capi_crm_termin on public.crm_appointments;
drop trigger if exists werbe_capi_crm_deal   on public.deals;

drop function if exists public.werbe_capi_crm_lead_trg();
drop function if exists public.werbe_capi_crm_termin_trg();
drop function if exists public.werbe_capi_crm_deal_trg();
drop function if exists public.werbe_capi_crm_stufe(uuid, text, text, uuid, timestamptz);

do $cron$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'werbe-signal-nachholen';
  end if;
end
$cron$;

update public.capi_outbox
   set status = 'uebersprungen', grund = 'rueckbau', claimed_at = null, updated_at = now()
 where status = 'offen'
   and event_name in ('Lead aus Sofortformular', 'Termin gebucht', 'Termin stattgefunden', 'Qualifiziert', 'Kunde', 'Lead')
   and event_id like 'crm-%';

do $con$
declare
  r record;
begin
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.capi_outbox'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%event_name%'
  loop
    execute format('alter table public.capi_outbox drop constraint %I', r.conname);
  end loop;
end
$con$;

alter table public.capi_outbox add constraint capi_outbox_event_name_check
  check (event_name in ('Lead', 'Schedule', 'AppointmentHeld', 'QualifiedLead', 'Purchase')) not valid;

notify pgrst, 'reload schema';

commit;
