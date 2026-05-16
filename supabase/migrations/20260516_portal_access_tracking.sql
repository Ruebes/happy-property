-- Migration: Portal-Zugang tracken
-- 1) portal_access_sent_at an leads → wann wurde der Zugang verschickt?
-- 2) portal_logins → wann hat sich der Eigentümer eingeloggt?

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS portal_access_sent_at timestamptz;

-- Bestehende Eigentümer-Accounts nachführen (email-match):
-- Wer bereits profile_id hat → portal_access_sent_at = Profil-Erstellungszeitpunkt
UPDATE leads l
SET portal_access_sent_at = p.created_at
FROM profiles p
WHERE p.id = l.profile_id
  AND p.role = 'eigentuemer'
  AND l.portal_access_sent_at IS NULL
  AND l.profile_id IS NOT NULL;

-- Login-Log
CREATE TABLE IF NOT EXISTS portal_logins (
  id         uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_logins_profile_id ON portal_logins(profile_id);
CREATE INDEX IF NOT EXISTS idx_portal_logins_created_at ON portal_logins(created_at DESC);

ALTER TABLE portal_logins ENABLE ROW LEVEL SECURITY;

-- Eigentümer darf eigene Login-Zeile einfügen (fire-and-forget aus dem Browser)
CREATE POLICY "portal_logins_eigentuemer_insert" ON portal_logins
  FOR INSERT TO public
  WITH CHECK (profile_id = auth.uid());

-- Admin sieht alles
CREATE POLICY "portal_logins_admin_select" ON portal_logins
  FOR SELECT TO public
  USING (current_user_role() = 'admin');
