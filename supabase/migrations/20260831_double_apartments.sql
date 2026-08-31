-- ── Doppelapartments: eine Bauträger-Einheit, zwei Portal-Wohnungen ──────────
-- MITO verkauft Mamba A2 als EINEN Kaufvorgang (Preisliste, Reservierung, Vertrag
-- = "A2"). Für den Eigentümer sind es zwei eigenständige, separat vermietbare
-- Apartments (A2a im EG, A2b im OG). Beide Sichten müssen nebeneinander bestehen:
--
--   crm_project_units A2        ← Bauträger-Einheit, hängt am Deal, geht an MITO
--     ├── A2a  (parent_unit_id) ← Portal-Wohnung des Eigentümers
--     └── A2b  (parent_unit_id) ← Portal-Wohnung des Eigentümers
--
-- Regeln:
--   • Unter-Einheiten werden NIE einzeln angeboten (Wohnungs-Popup + Deck-Wizard
--     blenden sie aus) — verkauft wird immer die Eltern-Einheit.
--   • Bei der Portal-Übergabe (create-eigentuemer-access) wird statt der Eltern-
--     Einheit für JEDE Unter-Einheit eine eigene property angelegt.
--   • Der nächtliche Preislisten-Sync fasst Einheiten mit Unter-Einheiten nicht an.

ALTER TABLE crm_project_units
  ADD COLUMN IF NOT EXISTS parent_unit_id uuid
  REFERENCES crm_project_units(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_crm_project_units_parent
  ON crm_project_units(parent_unit_id) WHERE parent_unit_id IS NOT NULL;

COMMENT ON COLUMN crm_project_units.parent_unit_id IS
  'Doppelapartment: Verweis auf die Bauträger-Einheit. Gesetzt = Unter-Einheit, nie einzeln anbietbar.';

-- Genau eine Ebene: eine Unter-Einheit darf selbst keine Unter-Einheiten haben.
CREATE OR REPLACE FUNCTION hp_check_unit_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_unit_id IS NOT NULL THEN
    IF NEW.parent_unit_id = NEW.id THEN
      RAISE EXCEPTION 'Einheit kann nicht ihre eigene Unter-Einheit sein';
    END IF;
    IF EXISTS (SELECT 1 FROM crm_project_units
                WHERE id = NEW.parent_unit_id AND parent_unit_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Unter-Einheiten dürfen keine weiteren Unter-Einheiten haben';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_check_unit_parent ON crm_project_units;
CREATE TRIGGER trg_hp_check_unit_parent
BEFORE INSERT OR UPDATE OF parent_unit_id ON crm_project_units
FOR EACH ROW EXECUTE FUNCTION hp_check_unit_parent();

-- ── MITO Mamba A2 ────────────────────────────────────────────────────────────
-- Zahlen aus der Happy-Property-Spezifikation "Doppelapartment A2", Stand
-- 07.08.2026 (Flächen gemäß MITO-Preisliste 01.08.2026):
--   A2a (EG): 60,90 m² Wohnfläche + 7,40 überdacht + 21,80 unüberdacht = 90,10 m²
--   A2b (OG): 58,70 m² Wohnfläche + 11,20 überdacht                    = 69,90 m²
--   Plot 143 m² (gemeinsam, am EG geführt), 1 Stellplatz, je 1 SZ / 1 Bad
--   600.000 € netto + 19 % MwSt = 714.000 € brutto, je Einheit 300.000 / 357.000
--
-- Die Eltern-Einheit trug bisher Flächen aus falsch zugeordneten Preislisten-
-- Spalten (size_sqm 172,4 = Total Usable Area von D3, floor 179 = Plot Area).

UPDATE crm_project_units SET
  size_sqm    = 119.60,   -- Wohnfläche A2a + A2b
  terrace_sqm = 40.40,    -- 18,60 überdacht + 21,80 unüberdacht
  plot_sqm    = 143,
  floor       = NULL,     -- Maisonette über zwei Ebenen
  bedrooms    = 2,
  bathrooms   = 2,
  price_gross = 714000,
  vat_rate    = 19,
  notes       = 'Doppelapartment: zwei eigenständige 1-Schlafzimmer-Apartments (A2a EG, A2b OG), ein Kaufvorgang. Verkauf und Verträge mit MITO laufen als A2; im Eigentümerportal als A2a und A2b geführt. (Sven 18.08.2026)'
WHERE id = 'c407ccf5-674a-4342-ac16-5152b5daf05d';

INSERT INTO crm_project_units (
  project_id, parent_unit_id, unit_number, type, bedrooms, bathrooms,
  size_sqm, terrace_sqm, plot_sqm, floor, is_furnished,
  price_net, price_gross, vat_rate, source, sort_order, notes
)
SELECT * FROM (VALUES
  ('2ca7800e-c6b4-4dda-8349-51131f6a3e18'::uuid, 'c407ccf5-674a-4342-ac16-5152b5daf05d'::uuid,
   'A2a', 'apartment', 1, 1, 60.90::numeric, 29.20::numeric, 143::numeric, 0, true,
   300000::numeric, 357000::numeric, 19::numeric, 'manual', 1,
   'Erdgeschoss des Doppelapartments A2 mit Garten und Veranda (7,40 m² überdacht + 21,80 m² unüberdacht), Nutzfläche 90,10 m². Eigener Eingang, separat vermietbar. Gegenüber MITO Teil der Einheit A2.'),
  ('2ca7800e-c6b4-4dda-8349-51131f6a3e18'::uuid, 'c407ccf5-674a-4342-ac16-5152b5daf05d'::uuid,
   'A2b', 'apartment', 1, 1, 58.70::numeric, 11.20::numeric, NULL::numeric, 1, true,
   300000::numeric, 357000::numeric, 19::numeric, 'manual', 2,
   'Obergeschoss des Doppelapartments A2 mit überdachter Veranda (11,20 m²), Nutzfläche 69,90 m². Eigener Außenaufgang, separat vermietbar. Gegenüber MITO Teil der Einheit A2.')
) AS v(project_id, parent_unit_id, unit_number, type, bedrooms, bathrooms,
       size_sqm, terrace_sqm, plot_sqm, floor, is_furnished,
       price_net, price_gross, vat_rate, source, sort_order, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM crm_project_units u
   WHERE u.project_id = '2ca7800e-c6b4-4dda-8349-51131f6a3e18'
     AND u.unit_number = v.unit_number
);
