-- 14.08.2026 — Nächtlicher Drive-Sync + Grundriss-Garantie (Dokumentation).
-- Die Objekte wurden live über die Management-API angelegt; diese Datei
-- dokumentiert den Stand für neue Umgebungen.

-- 1) Cron: prepare-project-assets action=nightly, täglich 01:00 UTC (= 04:00 Zypern
--    im Sommer). Durchsucht alle crm_projects mit drive_folder_id: neueste Preisliste
--    über alle Quellen (Projektordner, Doc-Unterordner, Developer-Elternordner,
--    drive_external_sources); bei Änderung docs-Spiegel + parse-pricelist-Sync
--    (Preise + Verfügbarkeit, max. 6 Syncs/Nacht, Rest in der Folgenacht).
--    Beobachtet zusätzlich den "Floor plans"-Ordner (Grundriss-Garantie).
--    Ergebnis in crm_settings.drive_sync_last_report + Mail an Sven bei Änderungen.
-- select cron.schedule('hp-drive-sync', '0 1 * * *', $$
--   select net.http_post(
--     url:='https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/prepare-project-assets',
--     headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer <service-role-jwt>'),
--     body:='{"action":"nightly"}'::jsonb, timeout_milliseconds:=30000)
-- $$);

-- 2) Zustand je Projekt: crm_projects.deck_assets.drive_sync
--    { pricelist_id, pricelist_mtime, floorplans_newest, last_run }
--    Preislisten-Stand wird NUR nach erfolgreichem Sync fortgeschrieben.

-- 3) Skala-Grundrisse (HP-Stil, aus Luma "SKALA Floor plan.pdf" nachgezeichnet):
--    deck-assets/floorplans/skala/{101,102,103,302,303,401,402,403}.svg
--    crm_projects.deck_assets.unit_floorplans (Skala) = je Wohnungsnummer + '1br'/'2br'.

-- 4) Grundriss-Garantie:
--    generate-deck meldet missing_floorplans in der Antwort;
--    nightly-health Prüfung 'grundriss_fehlt' (junge Decks ohne Zeichnung +
--    Projekte mit Drive-Grundrissen ohne unit_floorplans-Mapping).
