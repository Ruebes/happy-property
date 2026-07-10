-- Herkunft einer Terminbuchung (z.B. 'newsletter' = über den Newsletter-Direktlink,
-- 'direktlink' = personalisierter Direkteinstieg außerhalb einer Kampagne).
-- Kalender färbt Newsletter-Termine eigenständig ein.
alter table public.crm_appointments add column if not exists source text;
