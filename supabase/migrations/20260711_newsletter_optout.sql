-- Newsletter-Abmeldung: blockt NUR künftige Newsletter-Kampagnen,
-- nicht die Transaktions-/Termin-Kommunikation (dafür gibt es communication_optouts).
alter table public.leads add column if not exists newsletter_optout_at timestamptz;
