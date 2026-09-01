-- ── Eigentümerwechsel räumt die Mit-Eigentümer ab ───────────────────────────
-- Wechselt eine Wohnung den Eigentümer, sollen die eingeladenen Personen nicht
-- stehen bleiben: sonst erbt der neue Eigentümer die Familie des alten und sieht
-- eine Zugriffsliste, die er nie vergeben hat (Sven, 01.09.2026: "ja, auf jeden
-- Fall").
--
-- Greift nur, wenn owner_id sich WIRKLICH ändert: ein Update an einem anderen Feld
-- der Wohnung lässt die Zugriffsliste unangetastet (im Trockentest bestätigt).
-- properties.owner_id ist NOT NULL, eine Wohnung ohne Eigentümer gibt es nicht.

CREATE OR REPLACE FUNCTION hp_reset_co_owners_on_owner_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_weg integer;
BEGIN
  IF OLD.owner_id IS NOT NULL AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    WITH entfernt AS (
      DELETE FROM property_co_owners WHERE property_id = NEW.id RETURNING 1
    )
    SELECT count(*) INTO v_weg FROM entfernt;
    IF v_weg > 0 THEN
      -- Steht im Postgres-Log; die Zugriffsliste im Portal zeigt danach nur noch
      -- den neuen Eigentümer.
      RAISE NOTICE 'Wohnung %: % Mit-Eigentümer nach Eigentümerwechsel entfernt', NEW.id, v_weg;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_reset_co_owners ON properties;
CREATE TRIGGER trg_hp_reset_co_owners
AFTER UPDATE OF owner_id ON properties
FOR EACH ROW EXECUTE FUNCTION hp_reset_co_owners_on_owner_change();
