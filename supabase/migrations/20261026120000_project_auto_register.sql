-- Automatische Registrierung beim Deck-Versand (Sven 26.10.2026, Flora Panorama):
-- Geht aus dem Postausgang ein Deck zu einem Projekt mit auto_register=true raus und
-- ist der Kunde beim Bauträger noch nicht registriert, trägt der Postausgang die
-- Registrierung ein (lead_registrations), schiebt den Deal auf „registrierung" und
-- löst die Stufen-Automatik aus (Lotte-WhatsApp an Burkhard + Ioulia).
-- Rücknahme: alter table public.crm_projects drop column auto_register;
alter table public.crm_projects add column if not exists auto_register boolean not null default false;

update public.crm_projects set auto_register = true where id = '514d3d8a-449f-419f-9dba-d26a1cb1d1a7';  -- Flora Panorama
