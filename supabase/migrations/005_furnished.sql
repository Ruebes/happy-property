-- Möbliert-Feld für Immobilien
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS is_furnished BOOLEAN NOT NULL DEFAULT false;
