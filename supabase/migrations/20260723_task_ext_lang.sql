-- Externe Aufgaben-Empfänger (Geschäftspartner ohne System-Zugang) bekommen ihre
-- Aufgabe per WhatsApp/Mail von Lotte — jetzt in IHRER Sprache. Interne Zuständige
-- nutzen profiles.language; für Externe fehlte ein Sprachfeld.
ALTER TABLE crm_task_assignees ADD COLUMN IF NOT EXISTS ext_lang text NOT NULL DEFAULT 'de';
COMMENT ON COLUMN crm_task_assignees.ext_lang IS 'Sprache für externe Empfänger (Mail/WhatsApp): de|en. Interne nutzen profiles.language.';
