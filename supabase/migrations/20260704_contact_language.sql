-- Kontaktsprache pro Geschäftspartner: Developer- und Business-Kontakte bekommen
-- ein Sprachfeld (de|en). Beim automatischen Versand (process-scheduled-messages)
-- wird die Nachricht in diese Sprache übersetzt, wenn sie ≠ de ist.
ALTER TABLE crm_developer_contacts ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'de';
ALTER TABLE crm_business_contacts  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'de';
