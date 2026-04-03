-- ──────────────────────────────────────────────────────────────
-- Bereinigung verwaister Profile (Ghost Users)
-- Ausführen in: Supabase Dashboard → SQL Editor
-- ──────────────────────────────────────────────────────────────

-- 1. Vorschau: Welche Profile haben keinen Auth-User?
SELECT p.id, p.email, p.full_name, p.role, p.created_at
FROM profiles p
WHERE p.id NOT IN (SELECT id FROM auth.users);

-- 2. Löschen (auskommentiert – erst nach Vorschau ausführen!):
-- DELETE FROM profiles
-- WHERE id NOT IN (SELECT id FROM auth.users);
