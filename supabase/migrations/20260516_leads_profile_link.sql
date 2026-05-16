-- Migration: Leads ↔ Profiles verknüpfen
-- Einen Kunden = ein Datensatz, egal ob Lead oder Eigentümer.
-- profile_id verweist auf den Auth-User des Kunden (Eigentümer-Profil).
-- Ein Lead ohne Portal-Zugang hat NULL, ein Eigentümer hat die UUID seines Profils.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_profile_id ON leads(profile_id);

-- Bestehende Verknüpfungen per Email-Match nachziehen
-- (Fälle wo Eigentümer-Account bereits existiert aber profile_id noch nicht gesetzt ist)
UPDATE leads l
SET profile_id = p.id
FROM profiles p
WHERE lower(l.email) = lower(p.email)
  AND p.role = 'eigentuemer'
  AND l.profile_id IS NULL;
