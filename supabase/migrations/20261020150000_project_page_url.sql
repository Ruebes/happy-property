-- Link zur oeffentlichen Projektseite auf der Webseite (steuervorteil-zypern-immobilien.com/top-projekte/...).
-- Sven 20.10.2026: Jede Projektseite wird Grundlage fuer die Sales Decks, der Link gehoert ins CRM-Projekt.
alter table public.crm_projects add column if not exists project_page_url text;
comment on column public.crm_projects.project_page_url is 'Oeffentliche Projektseite (anonym) auf der Webseite, Grundlage fuer Sales Decks';
