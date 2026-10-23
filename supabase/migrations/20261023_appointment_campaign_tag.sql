-- Kampagnen-Kennzeichnung im Kalender (Sven 23.10.2026): Termine aus einer bestimmten
-- Werbekampagne bekommen ein eigenes Label (z. B. Projekt) und eine eigene Kachelfarbe.
-- Zuordnung utm_campaign -> {label, color, google_color_id} steht in
-- crm_settings key 'kalender_kampagnen' (JSON); funnel-api book setzt die Felder.
alter table public.crm_appointments add column if not exists campaign_tag text;
alter table public.crm_appointments add column if not exists campaign_color text;
