-- Fehlende Wohnungsparameter in properties-Tabelle ergänzen
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS bathrooms    integer     DEFAULT 1,
  ADD COLUMN IF NOT EXISTS terrace_sqm  numeric(10,2),
  ADD COLUMN IF NOT EXISTS floor        integer,
  ADD COLUMN IF NOT EXISTS block        text;
