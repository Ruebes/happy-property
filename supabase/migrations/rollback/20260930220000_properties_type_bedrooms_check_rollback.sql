-- Rücknahme von 20260930220000_properties_type_bedrooms_check.sql (NICHT automatisch angewendet)
-- Stellt die Live-Definitionen vom 30.9.2026 wieder her:
--   properties_type_check     CHECK ((type = ANY (ARRAY['villa'::text, 'apartment'::text, 'studio'::text])))
--   properties_bedrooms_check CHECK (((bedrooms >= 0) AND (bedrooms <= 5)))
-- NOT VALID: gibt es inzwischen Townhouse-Objekte oder mehr als 5 Schlafzimmer,
-- bleiben diese Zeilen erhalten (nur neue Zeilen werden wieder geprüft).
-- Gibt es keine solchen Zeilen, wird die Regel danach validiert: dann ist der
-- Katalog wieder exakt wie live am 30.9.2026 (convalidated = true).
-- Vorher prüfen: select id, type, bedrooms from public.properties
--                 where type = 'townhouse' or bedrooms > 5;

alter table public.properties drop constraint if exists properties_type_check;
alter table public.properties add constraint properties_type_check
  CHECK ((type = ANY (ARRAY['villa'::text, 'apartment'::text, 'studio'::text]))) not valid;

alter table public.properties drop constraint if exists properties_bedrooms_check;
alter table public.properties add constraint properties_bedrooms_check
  CHECK (((bedrooms >= 0) AND (bedrooms <= 5))) not valid;

do $$
begin
  if not exists (select 1 from public.properties where type not in ('villa', 'apartment', 'studio')) then
    alter table public.properties validate constraint properties_type_check;
  end if;
  if not exists (select 1 from public.properties where bedrooms > 5) then
    alter table public.properties validate constraint properties_bedrooms_check;
  end if;
end $$;
