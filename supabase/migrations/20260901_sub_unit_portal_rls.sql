-- ── Teil-Wohnungen im Eigentümerportal sichtbar machen ──────────────────────
-- Ein Doppelapartment ist EINE Wohnung mit EINEM Title Deed: die property und
-- damit der Eigentümer hängen an der Gesamteinheit (Mamba A2). Die Teil-
-- Wohnungen A2a/A2b haben per Definition KEINE eigene property — genau deshalb
-- greift die bisherige Eigentümer-Regel
--     property_id IN (SELECT id FROM properties WHERE owner_id = auth.uid())
-- für sie nicht: der Kunde sieht seine eigenen Teil-Wohnungen nicht, obwohl sie
-- zu seiner Wohnung gehören. Admin und Verwalter merken davon nichts, weil ihre
-- eigenen Regeln greifen.
--
-- Lösung: EIN Helfer liefert alle Einheiten-IDs, die dem angemeldeten Nutzer
-- gehören — seine Wohnungen UND deren Teil-Wohnungen. Alle Eigentümer-Regeln
-- gehen darüber. SECURITY DEFINER, damit die Abfrage im Helfer nicht erneut
-- durch die Regeln läuft (sonst Rekursion).

CREATE OR REPLACE FUNCTION hp_owner_unit_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- eigene Wohnungen
  SELECT u.id
    FROM crm_project_units u
    JOIN properties p ON p.id = u.property_id
   WHERE p.owner_id = auth.uid()
  UNION
  -- deren Teil-Wohnungen (Doppelapartment)
  SELECT c.id
    FROM crm_project_units c
    JOIN crm_project_units u ON u.id = c.parent_unit_id
    JOIN properties p ON p.id = u.property_id
   WHERE p.owner_id = auth.uid()
$$;

COMMENT ON FUNCTION hp_owner_unit_ids() IS
  'Einheiten des angemeldeten Eigentümers inklusive der Teil-Wohnungen seiner Doppelapartments.';

GRANT EXECUTE ON FUNCTION hp_owner_unit_ids() TO authenticated;

-- ── Einheiten ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS crm_project_units_eigentuemer_select ON crm_project_units;
CREATE POLICY crm_project_units_eigentuemer_select ON crm_project_units
  FOR SELECT TO authenticated
  USING (id IN (SELECT hp_owner_unit_ids()));

-- ── Unterlagen der Einheit (Kaufvertrag, Grundriss, …) ──────────────────────
DROP POLICY IF EXISTS crm_unit_docs_eigentuemer_select ON crm_unit_documents;
CREATE POLICY crm_unit_docs_eigentuemer_select ON crm_unit_documents
  FOR SELECT TO authenticated
  USING (unit_id IN (SELECT hp_owner_unit_ids()));

DROP POLICY IF EXISTS unit_docs_owner_read ON crm_unit_documents;
CREATE POLICY unit_docs_owner_read ON crm_unit_documents
  FOR SELECT TO authenticated
  USING (unit_id IN (SELECT hp_owner_unit_ids()));

DROP POLICY IF EXISTS crm_unit_docs_eigentuemer_delete ON crm_unit_documents;
CREATE POLICY crm_unit_docs_eigentuemer_delete ON crm_unit_documents
  FOR DELETE TO authenticated
  USING (unit_id IN (SELECT hp_owner_unit_ids()));

-- ── Storage: Dateien liegen unter unit-documents/<unit_id>/… ────────────────
DROP POLICY IF EXISTS unit_docs_eigentuemer_select ON storage.objects;
CREATE POLICY unit_docs_eigentuemer_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'unit-documents'
         AND split_part(name, '/', 2) IN (SELECT hp_owner_unit_ids()::text));

DROP POLICY IF EXISTS unit_docs_eigentuemer_delete ON storage.objects;
CREATE POLICY unit_docs_eigentuemer_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'unit-documents'
         AND split_part(name, '/', 2) IN (SELECT hp_owner_unit_ids()::text));

-- ── Zahlungen bleiben bewusst an der Gesamteinheit ──────────────────────────
-- crm_unit_payments wird NICHT erweitert: bezahlt wird der eine Kaufvorgang,
-- der Zahlungsplan hängt an A2. Teil-Wohnungen haben keine eigenen Raten.
