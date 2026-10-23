-- WhatsApp-Calls aus der Mac-App „HP Gesprächsnotiz" (Sven 23.10.26).
alter table public.call_summaries drop constraint if exists call_summaries_source_check;
alter table public.call_summaries add constraint call_summaries_source_check check (source in ('zoom', 'upload', 'whatsapp'));

-- Schlüssel der Mac-App (nur Aktion upload in zoom-calls). Wert wird einmalig
-- zufällig erzeugt und lokal in der App-Konfiguration abgelegt.
insert into public.connector_secrets (key, value)
values ('CALL_UPLOAD_SECRET', encode(gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;
