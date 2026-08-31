-- ── Teil-Wohnungen dürfen nie an einem Deal hängen ──────────────────────────
-- Ein Doppelapartment wird als EIN Objekt verkauft, mit EINEM Title Deed: der
-- Deal hängt immer an der Gesamteinheit (z.B. Mamba A2), nie an A2a oder A2b.
-- Die Oberfläche blendet Teil-Wohnungen in allen Auswahl-Listen aus, aber ein
-- veralteter Browser-Cache (PWA) kann noch die alte Liste zeigen. Diese Regel
-- sitzt in der Datenbank und gilt damit unabhängig davon, welcher Stand im
-- Browser läuft.

CREATE OR REPLACE FUNCTION hp_check_deal_unit_not_sub()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_parent text;
BEGIN
  IF NEW.unit_id IS NOT NULL THEN
    SELECT p.unit_number INTO v_parent
      FROM crm_project_units u
      JOIN crm_project_units p ON p.id = u.parent_unit_id
     WHERE u.id = NEW.unit_id;
    IF v_parent IS NOT NULL THEN
      RAISE EXCEPTION 'Teil-Wohnung kann nicht an einen Deal gehängt werden. Verkauft wird die Gesamteinheit % (ein Kaufvorgang, ein Title Deed).', v_parent;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_check_deal_unit_not_sub ON deals;
CREATE TRIGGER trg_hp_check_deal_unit_not_sub
BEFORE INSERT OR UPDATE OF unit_id ON deals
FOR EACH ROW EXECUTE FUNCTION hp_check_deal_unit_not_sub();
