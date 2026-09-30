-- Rückbau zu 20260930120000_hp_lead_related.sql (von Hand ausführen, liegt
-- bewusst in einem Unterordner, damit die Supabase-CLI die Datei nicht als
-- Migration einspielt). Entfernt nur die zwei Funktionen; es gibt keine
-- Tabellen, Spalten oder Policies, die zurückzubauen wären.
-- Die Oberfläche kommt damit zurecht: useRelated meldet dann "unavailable" und
-- die Karte "Gehört dazu" bleibt unsichtbar.

drop function if exists public.hp_lead_related(uuid, int);
drop function if exists public.hp_lead_related_restricted(uuid);

notify pgrst, 'reload schema';
