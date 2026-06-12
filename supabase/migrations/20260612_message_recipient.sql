-- Empfängerauswahl für Nachrichten: 'client' (Standard = der Lead) ODER ein fixer
-- Kontakt als Token 'bc:<uuid>' (Geschäftskontakt) bzw. 'dc:<uuid>' (Developer-Kontakt).
-- Additiv & rückwärtskompatibel: bestehende Zeilen bekommen 'client'.
ALTER TABLE automation_rules    ADD COLUMN IF NOT EXISTS recipient text NOT NULL DEFAULT 'client';
ALTER TABLE crm_adhoc_messages  ADD COLUMN IF NOT EXISTS recipient text NOT NULL DEFAULT 'client';
ALTER TABLE scheduled_messages  ADD COLUMN IF NOT EXISTS recipient text NOT NULL DEFAULT 'client';
