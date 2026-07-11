-- Zu-/Absagen je Termin-Empfänger: { "<pKey>": { name, status: pending|yes|no, at } }
-- pKey: 'lead' oder 'a:<Name>' (Teilnehmer) — gesetzt beim Einladungsversand.
alter table public.crm_appointments add column if not exists rsvps jsonb;
