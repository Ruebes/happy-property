-- Robuster Telefon-Match für eingehende WhatsApp: die gespeicherte Nummer wird auf
-- reine Ziffern normalisiert, BEVOR die Endung (letzte 8 Ziffern des Absenders)
-- verglichen wird. Vorher scheiterte der ilike-Match auf formatierten Nummern
-- (z.B. "+49 1515 8415620": das Leerzeichen zerreißt die Ziffernfolge "58415620"),
-- wodurch eingehende Kundenantworten still verworfen wurden (38 von 237 Leads betroffen).
create or replace function find_leads_by_phone_suffix(suffix text)
returns table(id uuid)
language sql
stable
as $$
  select l.id
  from leads l
  where regexp_replace(coalesce(l.phone, ''),    '\D', '', 'g') like '%' || suffix || '%'
     or regexp_replace(coalesce(l.whatsapp, ''), '\D', '', 'g') like '%' || suffix || '%'
  order by l.created_at desc
$$;

grant execute on function find_leads_by_phone_suffix(text) to service_role, authenticated, anon;
