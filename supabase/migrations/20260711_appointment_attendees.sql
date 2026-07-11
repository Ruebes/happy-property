-- Weitere Teilnehmer eines Termins (Partner/Geschäftskontakte):
-- [{name, email, phone, language}] — bekommen Einladung per Mail (+WhatsApp bei Nummer).
alter table public.crm_appointments add column if not exists attendees jsonb;
