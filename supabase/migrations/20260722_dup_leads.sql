-- Dublettenprüfung beim Anlegen eines Leads. Sven: „Wenn Telefonnummer oder
-- Name oder Mailadresse identisch sind, muss eine Abfrage kommen, ob ich das
-- so will." Findet mögliche Dubletten VOR dem Anlegen — Treffer bei gleicher
-- E-Mail ODER (Vor+Nachname) ODER Telefon/WhatsApp (letzte 8 Ziffern, wie beim
-- Inbound-Matching).
create or replace function find_duplicate_leads(p_email text, p_first text, p_last text, p_phone text)
returns table (id uuid, first_name text, last_name text, email text, phone text, reason text)
language sql stable
as $$
  with n as (
    select nullif(lower(trim(p_email)),'') e,
           nullif(lower(trim(p_first)),'') f,
           nullif(lower(trim(p_last)),'')  l,
           nullif(regexp_replace(coalesce(p_phone,''),'\D','','g'),'') ph
  )
  select l.id, l.first_name, l.last_name, l.email, l.phone,
         case
           when n.e is not null and lower(trim(l.email)) = n.e then 'email'
           when n.f is not null and n.l is not null and lower(trim(l.first_name)) = n.f and lower(trim(l.last_name)) = n.l then 'name'
           else 'phone'
         end as reason
  from leads l, n
  where
    (n.e is not null and lower(trim(l.email)) = n.e)
    or (n.f is not null and n.l is not null and lower(trim(l.first_name)) = n.f and lower(trim(l.last_name)) = n.l)
    or (n.ph is not null and length(n.ph) >= 8 and (
          right(regexp_replace(coalesce(l.phone,''),'\D','','g'), 8)    = right(n.ph, 8) and length(regexp_replace(coalesce(l.phone,''),'\D','','g'))    >= 8
       or right(regexp_replace(coalesce(l.whatsapp,''),'\D','','g'), 8) = right(n.ph, 8) and length(regexp_replace(coalesce(l.whatsapp,''),'\D','','g')) >= 8))
  limit 5
$$;
