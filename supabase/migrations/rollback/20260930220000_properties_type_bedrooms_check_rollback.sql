-- Rücknahme von 20260930220000_properties_type_bedrooms_check.sql (NICHT automatisch angewendet)
-- Stellt die Live-Definitionen vom 30.9.2026 wieder her:
--   properties_type_check     CHECK ((type = ANY (ARRAY['villa'::text, 'apartment'::text, 'studio'::text])))
--   properties_bedrooms_check CHECK (((bedrooms >= 0) AND (bedrooms <= 5)))
-- NOT VALID: gibt es inzwischen Townhouse-Objekte oder mehr als 5 Schlafzimmer,
-- bleiben diese Zeilen erhalten (nur neue Zeilen werden wieder geprüft).
-- Vorher prüfen: select id, type, bedrooms from public.properties
--                 where type = 'townhouse' or bedrooms > 5;

alter table public.properties drop constraint if exists properties_type_check;
alter table public.properties add constraint properties_type_check
  CHECK ((type = ANY (ARRAY['villa'::text, 'apartment'::text, 'studio'::text]))) not valid;

alter table public.properties drop constraint if exists properties_bedrooms_check;
alter table public.properties add constraint properties_bedrooms_check
  CHECK (((bedrooms >= 0) AND (bedrooms <= 5))) not valid;
