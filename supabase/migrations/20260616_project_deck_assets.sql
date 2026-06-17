-- Projekt → Google-Drive-Verknüpfung + Cache der automatisch importierten Deck-Assets.
-- Additiv: rührt die bestehenden Deck-Felder (deck_texts/payment_schedule/poi_distances/
-- project_deck_images) NICHT an. drive_folder_id = die Drive-Ordner-ID des Projekts;
-- prepare-project-assets füllt deck_assets aus diesem Ordner (+ Developer-Ordner).

alter table crm_projects add column if not exists drive_folder_id text;
alter table crm_projects add column if not exists deck_assets    jsonb;

comment on column crm_projects.drive_folder_id is
  'Google-Drive-Ordner-ID des Projekts. Quelle für den automatischen Asset-Import (prepare-project-assets).';
comment on column crm_projects.deck_assets is
  'Gecachte Deck-Assets aus Drive: { renders[], floorplans[{floor,label,url}], map, mapUrl, doc_urls{brochure,cutlery,linen,pricelist,spec}, spec_text, facts, updated_at }.';
