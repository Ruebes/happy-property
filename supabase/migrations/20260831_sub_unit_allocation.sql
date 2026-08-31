-- ── Ausgaben optional auf die Teil-Wohnung buchen ───────────────────────────
-- Ein Doppelapartment ist EINE Wohnung: Mamba A2 wird als eine Einheit gekauft
-- und bezahlt, der Zahlungsplan hängt an A2, im Eigentümerportal ist es ein
-- Objekt. Die Teil-Wohnungen A2a/A2b sind eine Untergliederung INNERHALB dieser
-- Wohnung (crm_project_units.parent_unit_id).
--
-- Für die laufende Bewirtschaftung braucht es aber eine feinere Ebene: eine
-- Rechnung kommt an der Wohnung A2 an, betrifft aber oft nur einen Teil
-- (Küche A2a, Klimaanlage A2b). Deshalb bekommt jedes Dokument eine OPTIONALE
-- Zuordnung auf eine Teil-Wohnung. Leer = betrifft die ganze Wohnung.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS sub_unit_id uuid
  REFERENCES crm_project_units(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_documents_sub_unit
  ON documents(sub_unit_id) WHERE sub_unit_id IS NOT NULL;

COMMENT ON COLUMN documents.sub_unit_id IS
  'Optionale Zuordnung auf eine Teil-Wohnung des Doppelapartments (crm_project_units mit parent_unit_id). Leer = ganze Wohnung.';

-- Nur echte Teil-Wohnungen zulassen — sonst landen Ausgaben auf einer fremden
-- Einheit und die Summen je Teil stimmen nicht mehr.
CREATE OR REPLACE FUNCTION hp_check_document_sub_unit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sub_unit_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM crm_project_units
                    WHERE id = NEW.sub_unit_id AND parent_unit_id IS NOT NULL) THEN
      RAISE EXCEPTION 'sub_unit_id muss eine Teil-Wohnung sein (parent_unit_id gesetzt)';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_check_document_sub_unit ON documents;
CREATE TRIGGER trg_hp_check_document_sub_unit
BEFORE INSERT OR UPDATE OF sub_unit_id ON documents
FOR EACH ROW EXECUTE FUNCTION hp_check_document_sub_unit();
