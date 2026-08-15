-- Eine Wahrheit fuer zugewiesene Wohnungen (Sven 14.08.2026):
-- Status-Modell: im Bau (under_construction) / vermietet kurz/lang
-- (active + rental_type). "Verkauft" ist KEIN Status, sondern ergibt sich
-- aus der Zuweisung (crm_project_units.property_id -> properties.owner_id).
-- Trigger spiegeln jede Aenderung sofort in beide Richtungen:
--   Unit-Fakten (Nummer/Flaechen/Zimmer/Preise/Projektname) -> properties-Kopie
--   Portal rental_type/property_status (Verwalter)          -> zentrale Unit
-- Vokabeln: Unit short/long <-> Portal shortterm/longterm (Mapping-Funktionen).

create or replace function hp_rental_to_property(u text) returns text language sql immutable as
$$ select case u when 'short' then 'shortterm' when 'long' then 'longterm' else null end $$;
create or replace function hp_rental_to_unit(p text) returns text language sql immutable as
$$ select case p when 'shortterm' then 'short' when 'longterm' then 'long' else null end $$;

create or replace function hp_sync_property_from_unit() returns trigger
language plpgsql security definer as $$
begin
  if new.property_id is not null then
    update properties p
       set property_status      = hp_build_status(new.status),
           rental_type          = coalesce(hp_rental_to_property(new.rental_type), p.rental_type),
           unit_number          = coalesce(new.unit_number, p.unit_number),
           size_sqm             = coalesce(new.size_sqm, p.size_sqm),
           terrace_sqm          = coalesce(new.terrace_sqm, p.terrace_sqm),
           bedrooms             = coalesce(new.bedrooms, p.bedrooms),
           purchase_price_net   = coalesce(new.price_net, p.purchase_price_net),
           purchase_price_gross = coalesce(new.price_gross, p.purchase_price_gross),
           project_name         = coalesce((select name from crm_projects where id = new.project_id), p.project_name)
     where p.id = new.property_id
       and (p.property_status      is distinct from hp_build_status(new.status)
         or p.rental_type          is distinct from coalesce(hp_rental_to_property(new.rental_type), p.rental_type)
         or p.unit_number          is distinct from coalesce(new.unit_number, p.unit_number)
         or p.size_sqm             is distinct from coalesce(new.size_sqm, p.size_sqm)
         or p.terrace_sqm          is distinct from coalesce(new.terrace_sqm, p.terrace_sqm)
         or p.bedrooms             is distinct from coalesce(new.bedrooms, p.bedrooms)
         or p.purchase_price_net   is distinct from coalesce(new.price_net, p.purchase_price_net)
         or p.purchase_price_gross is distinct from coalesce(new.price_gross, p.purchase_price_gross)
         or p.project_name         is distinct from coalesce((select name from crm_projects where id = new.project_id), p.project_name));
  end if;
  return new;
end $$;

create or replace function hp_sync_unit_from_property() returns trigger
language plpgsql security definer as $$
begin
  update crm_project_units u
     set status      = hp_build_status(new.property_status),
         rental_type = coalesce(hp_rental_to_unit(new.rental_type), u.rental_type)
   where u.property_id = new.id
     and (u.status      is distinct from hp_build_status(new.property_status)
       or u.rental_type is distinct from coalesce(hp_rental_to_unit(new.rental_type), u.rental_type));
  return new;
end $$;

drop trigger if exists trg_hp_sync_property_from_unit on crm_project_units;
create trigger trg_hp_sync_property_from_unit
  after insert or update of status, property_id, unit_number, size_sqm, terrace_sqm,
    bedrooms, price_net, price_gross, project_id, rental_type
  on crm_project_units for each row execute function hp_sync_property_from_unit();

drop trigger if exists trg_hp_sync_unit_from_property on properties;
create trigger trg_hp_sync_unit_from_property
  after update of property_status, rental_type
  on properties for each row execute function hp_sync_unit_from_property();
