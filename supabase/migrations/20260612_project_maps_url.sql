-- Google-Maps-Pin pro Projekt: Original-Link (Kurzlink möglich), den der Nutzer
-- einfügt. Koordinaten (latitude/longitude) existieren bereits und werden aus
-- dem Link aufgelöst (Edge Function resolve-maps-link) → Karten-Embed.
ALTER TABLE crm_projects ADD COLUMN IF NOT EXISTS maps_url text;
