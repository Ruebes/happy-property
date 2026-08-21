-- Thumbnail-Erzeugung laeuft als Hintergrund-Job (Safari bricht Anfragen nach
-- 60 s ab). Zeile entsteht sofort mit image_url NULL, der Job traegt Bild oder
-- Fehler nach; thumbnail_status pollt.
alter table thumbnail_creations add column if not exists error text;
alter table thumbnail_creations alter column image_url drop not null;
