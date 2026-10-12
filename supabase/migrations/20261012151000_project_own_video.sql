-- Svens eigenes YouTube-Video zum Projekt (Sven 12.10.26: „Im Mamba Deck kann
-- immer auch mein YouTube-Video davon verlinkt sein"). Eigenes Feld statt
-- video_url: video_url füllt der Drive-Import automatisch mit dem Bauträger-Film,
-- und deck_assets wird von mehreren Functions per Lesen-Ändern-Schreiben
-- überschrieben (dort gehen Einträge verloren). generate-deck setzt das Video als
-- eigene Sektion direkt hinter den Projektfilm.
-- Rücknahme: rollback/20261012151000_project_own_video.down.sql
alter table public.crm_projects add column if not exists own_video_url text;
comment on column public.crm_projects.own_video_url is 'Svens eigenes YouTube-Video zum Projekt, kommt in jedes Deck des Projekts';
