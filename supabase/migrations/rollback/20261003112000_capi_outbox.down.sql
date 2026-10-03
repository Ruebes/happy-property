-- Rückbau zu 20261003112000_capi_outbox.sql (von Hand ausführen; liegt im
-- Unterordner, damit die Supabase-CLI die Datei nicht als Migration einspielt).
-- Entfernt die drei Trigger, die Funktionen und den Ausgang. Noch nicht gesendete
-- Ereignisse gehen verloren; meta-ads-sync (Tageslauf, 7 Tage) holt sie nach.
-- Vorher werbe-signal stoppen bzw. ad_settings.capi_echtzeit = false setzen.
-- Reihenfolge Rückbau: 119000 -> 113000 -> 112000 -> 111000 -> 110000.

begin;

set local lock_timeout = '5s';

drop trigger if exists werbe_capi_termin on public.crm_appointments;
drop trigger if exists werbe_capi_lead   on public.leads;
drop trigger if exists werbe_capi_deal   on public.deals;

drop function if exists public.werbe_capi_claimen(int);
drop function if exists public.werbe_capi_termin_trg();
drop function if exists public.werbe_capi_lead_trg();
drop function if exists public.werbe_capi_deal_trg();
drop function if exists public.werbe_capi_einreihen(text, text, uuid, text, uuid, timestamptz, jsonb);

drop table if exists public.capi_outbox;

notify pgrst, 'reload schema';

commit;
