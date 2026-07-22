-- Universeller Doppel-Schutz für ausgehende WhatsApps. Sven: „Der Bot tickt aus …
-- prüfe den kompletten Workflow, dass nichts doppelt verschickt wird." Mehrere
-- Wege (Re-Trigger beim Phasen-Ziehen, überlappende Automatiken, Cron-Races)
-- konnten dieselbe Nachricht mehrfach an dieselbe Nummer schicken.
--
-- send-whatsapp prüft vor jedem Versand: ging GENAU DIESER Text an DIESE Nummer
-- schon in den letzten Stunden raus? Dann nicht nochmal. Key = Nummer + Text-Hash,
-- also NICHT betroffen: gleiche Nachricht an verschiedene Empfänger (Registrierung
-- an zwei Partner) und verschiedene Nachrichten an denselben (gestaffelte Nudges).
create table if not exists wa_sent (
  id        bigserial primary key,
  phone     text not null,
  body_hash text not null,
  sent_at   timestamptz not null default now()
);
create index if not exists idx_wa_sent_lookup on wa_sent (phone, body_hash, sent_at desc);
