-- Rückbau zu 20261001100000_ads_crm_attribution.sql (von Hand ausführen, liegt
-- bewusst in einem Unterordner, damit die Supabase-CLI die Datei nicht als
-- Migration einspielt). Entfernt die Funktion samt Kommentar und Rechten; sonst
-- hat die Migration nichts angelegt oder geändert.
--
-- Das Frontend fällt danach von selbst auf den Stand vor Teil 2 zurück:
-- Werbe-Mitarbeiter ohne Pipeline-Recht sehen wieder nur die Meta-Lead-Zahl
-- und den Hinweis zum Pipeline-Recht. Admin und Verwalter merken nichts.

drop function if exists public.ads_crm_attribution(timestamptz, text[]);

notify pgrst, 'reload schema';
