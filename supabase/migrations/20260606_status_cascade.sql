-- ── Status-Kaskade: EIN Status vom Projekt für alles ─────────────────────────
-- Problem: Der Bau-Status lebt in DREI Tabellen (crm_projects.status,
-- crm_project_units.status, properties.property_status) und wurde bisher nur
-- im Frontend an verstreuten Stellen (Projects.tsx, ProjectDetail.tsx,
-- PropertyDetail.tsx, LeadDetail.tsx) kopiert. Sobald ein Pfad vergessen wird,
-- driften die drei auseinander → Kunde sieht "Aktiv", obwohl Projekt "Im Bau".
--
-- Fix: Der Bau-Status wird in der DATENBANK kaskadiert — egal über welchen Pfad
-- geändert wird. Quelle der Wahrheit ist das Projekt; einzelne Wohnungen und ihre
-- Portal-Objekte folgen immer. "Verkauft" ist eine separate Dimension
-- (Kundenzuordnung über owner_id / deal.unit_id) und wird hier NICHT angefasst.
--
-- Mapping (identisch zur bestehenden Frontend-Logik):
--   under_construction              → under_construction
--   available / sold_out / completed → active
-- properties.property_status kennt nur under_construction / active.

-- ── Helper: Bau-Status → 2-Werte-Status ──────────────────────────────────────
CREATE OR REPLACE FUNCTION hp_build_status(src text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$ SELECT CASE WHEN src = 'under_construction' THEN 'under_construction' ELSE 'active' END $$;

-- ── A) Projekt-Status ändert sich → alle Units + Portal-Objekte nachziehen ────
CREATE OR REPLACE FUNCTION hp_cascade_project_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- 1. Alle Wohnungen des Projekts auf den Projekt-Bau-Status setzen
  UPDATE crm_project_units
     SET status = hp_build_status(NEW.status)
   WHERE project_id = NEW.id
     AND status IS DISTINCT FROM hp_build_status(NEW.status);

  -- 2. Alle verknüpften Portal-Objekte direkt mitziehen (auch die, deren Unit
  --    sich gerade nicht geändert hat, aber dennoch driftet)
  UPDATE properties pr
     SET property_status = hp_build_status(NEW.status)
    FROM crm_project_units u
   WHERE u.project_id = NEW.id
     AND u.property_id = pr.id
     AND pr.property_status IS DISTINCT FROM hp_build_status(NEW.status);

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_cascade_project_status ON crm_projects;
CREATE TRIGGER trg_hp_cascade_project_status
AFTER UPDATE OF status ON crm_projects
FOR EACH ROW
WHEN (NEW.status IS DISTINCT FROM OLD.status)
EXECUTE FUNCTION hp_cascade_project_status();

-- ── B) Unit-Status ändert sich → verknüpftes Portal-Objekt nachziehen ─────────
CREATE OR REPLACE FUNCTION hp_sync_property_from_unit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.property_id IS NOT NULL THEN
    UPDATE properties
       SET property_status = hp_build_status(NEW.status)
     WHERE id = NEW.property_id
       AND property_status IS DISTINCT FROM hp_build_status(NEW.status);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_sync_property_from_unit ON crm_project_units;
CREATE TRIGGER trg_hp_sync_property_from_unit
AFTER INSERT OR UPDATE OF status, property_id ON crm_project_units
FOR EACH ROW
EXECUTE FUNCTION hp_sync_property_from_unit();

-- ── C) Portal-Objekt-Status ändert sich → verknüpfte Unit nachziehen ──────────
--    (z.B. Aktivieren/Deaktivieren in PropertyDetail). Guards verhindern Loop
--    mit Trigger B: jede Seite updatet nur, wenn der Wert wirklich abweicht.
CREATE OR REPLACE FUNCTION hp_sync_unit_from_property()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE crm_project_units
     SET status = hp_build_status(NEW.property_status)
   WHERE property_id = NEW.id
     AND status IS DISTINCT FROM hp_build_status(NEW.property_status);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_sync_unit_from_property ON properties;
CREATE TRIGGER trg_hp_sync_unit_from_property
AFTER UPDATE OF property_status ON properties
FOR EACH ROW
WHEN (NEW.property_status IS DISTINCT FROM OLD.property_status)
EXECUTE FUNCTION hp_sync_unit_from_property();

-- ── Einmaliger Backfill: bestehende Drift bereinigen ─────────────────────────
-- Quelle der Wahrheit = Projekt. Wohnungen folgen dem Projekt …
UPDATE crm_project_units u
   SET status = hp_build_status(p.status)
  FROM crm_projects p
 WHERE u.project_id = p.id
   AND u.status IS DISTINCT FROM hp_build_status(p.status);

-- … und Portal-Objekte folgen ihrer Wohnung.
UPDATE properties pr
   SET property_status = hp_build_status(u.status)
  FROM crm_project_units u
 WHERE u.property_id = pr.id
   AND pr.property_status IS DISTINCT FROM hp_build_status(u.status);
