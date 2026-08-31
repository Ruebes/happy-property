-- ── Mit-Eigentümer: mehrere Personen an einer Wohnung ───────────────────────
-- Vorgabe Sven (31.08.2026): "Wenn jemand in sein Portal jemanden einlädt, dann
-- soll der als Eigentümer gelten, also gleiches sehen und machen dürfen."
-- Beispiel: Rainer Wallmeyer kauft für seine Kinder und lädt sie in seine
-- Wohnung ein. Eingeladene haben dieselben Rechte wie der Eigentümer.
--
-- Bisher hängt der gesamte Eigentümer-Zugriff an EINER Spalte: properties.owner_id.
-- Diese Migration legt das Fundament: die Zuordnungstabelle und EINE Funktion,
-- über die künftig alle Eigentümer-Regeln laufen. Die Regeln selbst werden im
-- zweiten Schritt darauf umgestellt.

CREATE TABLE IF NOT EXISTS property_co_owners (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  profile_id  uuid NOT NULL REFERENCES profiles(id)   ON DELETE CASCADE,
  -- Wer hat eingeladen? Der Eigentümer selbst oder Sven.
  invited_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_property_co_owners_profile ON property_co_owners(profile_id);
CREATE INDEX IF NOT EXISTS idx_property_co_owners_property ON property_co_owners(property_id);

COMMENT ON TABLE property_co_owners IS
  'Weitere Personen mit vollen Eigentümerrechten an einer Wohnung (z.B. Kinder des Käufers).';

-- ── Die eine Quelle: welche Wohnungen gehören dem angemeldeten Nutzer? ──────
-- SECURITY DEFINER, damit die Abfrage im Inneren nicht erneut durch die Regeln
-- läuft (sonst dreht sich RLS im Kreis).
CREATE OR REPLACE FUNCTION hp_my_property_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id FROM properties WHERE owner_id = auth.uid()
  UNION
  SELECT property_id FROM property_co_owners WHERE profile_id = auth.uid()
$$;

COMMENT ON FUNCTION hp_my_property_ids() IS
  'Wohnungen des angemeldeten Nutzers: eigene und solche, in die er als Mit-Eigentümer eingeladen wurde.';

GRANT EXECUTE ON FUNCTION hp_my_property_ids() TO authenticated;

-- Einheiten-Funktion von heute auf dieselbe Quelle stellen, damit Mit-Eigentümer
-- auch die Teil-Wohnungen eines Doppelapartments sehen.
CREATE OR REPLACE FUNCTION hp_owner_unit_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id
    FROM crm_project_units u
   WHERE u.property_id IN (SELECT hp_my_property_ids())
  UNION
  SELECT c.id
    FROM crm_project_units c
    JOIN crm_project_units u ON u.id = c.parent_unit_id
   WHERE u.property_id IN (SELECT hp_my_property_ids())
$$;

-- ── Zugriff auf die Zuordnungstabelle selbst ────────────────────────────────
ALTER TABLE property_co_owners ENABLE ROW LEVEL SECURITY;

-- Sehen: alle, die zu dieser Wohnung gehören (Eigentümer und Mit-Eigentümer).
DROP POLICY IF EXISTS property_co_owners_select ON property_co_owners;
CREATE POLICY property_co_owners_select ON property_co_owners
  FOR SELECT TO authenticated
  USING (property_id IN (SELECT hp_my_property_ids()));

-- Einladen und entfernen: NUR der eingetragene Eigentümer der Wohnung.
-- Ein Mit-Eigentümer darf nicht seinerseits weitere Personen hereinholen —
-- sonst wächst der Kreis unkontrolliert. Sven kommt über die Admin-Regel rein.
DROP POLICY IF EXISTS property_co_owners_owner_insert ON property_co_owners;
CREATE POLICY property_co_owners_owner_insert ON property_co_owners
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM properties p
                       WHERE p.id = property_co_owners.property_id
                         AND p.owner_id = auth.uid()));

DROP POLICY IF EXISTS property_co_owners_owner_delete ON property_co_owners;
CREATE POLICY property_co_owners_owner_delete ON property_co_owners
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM properties p
                  WHERE p.id = property_co_owners.property_id
                    AND p.owner_id = auth.uid()));

DROP POLICY IF EXISTS property_co_owners_staff_all ON property_co_owners;
CREATE POLICY property_co_owners_staff_all ON property_co_owners
  FOR ALL TO authenticated
  USING (current_user_role() = ANY (ARRAY['admin', 'verwalter']))
  WITH CHECK (current_user_role() = ANY (ARRAY['admin', 'verwalter']));

-- Der Eigentümer darf sich nicht selbst als Mit-Eigentümer eintragen (Dublette).
CREATE OR REPLACE FUNCTION hp_check_co_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM properties p
              WHERE p.id = NEW.property_id AND p.owner_id = NEW.profile_id) THEN
    RAISE EXCEPTION 'Diese Person ist bereits Eigentümer der Wohnung.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_check_co_owner ON property_co_owners;
CREATE TRIGGER trg_hp_check_co_owner
BEFORE INSERT OR UPDATE ON property_co_owners
FOR EACH ROW EXECUTE FUNCTION hp_check_co_owner();
