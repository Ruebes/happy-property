-- Konsistente Eigentümer-Zuweisung CRM <-> Verwaltung.
-- Problem: Eine Wohnung wird im CRM über einen Deal (deals.unit_id + leads.profile_id)
-- einem Eigentümer zugewiesen, aber die Verwaltungs-Property (properties.owner_id) wird
-- NUR EINMALIG bei create-eigentuemer-access erzeugt. Units, die einem bereits
-- freigeschalteten Eigentümer SPÄTER zugewiesen werden, landeten nie in der Verwaltung.
-- Fix: zentrale Funktion + Trigger, die bei jeder Zuweisung die Property erzeugt/verknüpft.

-- Zentrale, idempotente Sync-Funktion: stellt sicher, dass die Wohnung eines Deals als
-- Verwaltungs-Property dem Eigentümer (leads.profile_id) gehört, und verlinkt
-- crm_project_units.property_id + deals.property_id. Spiegelt die Felder aus
-- create-eigentuemer-access exakt wider.
create or replace function public.fn_ensure_deal_property(p_deal_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead uuid; v_unit_id uuid; v_prop uuid; v_profile uuid;
  v_unit record; v_pid uuid;
begin
  select lead_id, unit_id, property_id into v_lead, v_unit_id, v_prop
    from deals where id = p_deal_id;
  if v_unit_id is null or v_prop is not null then return; end if;

  -- Lead muss bereits Eigentümer sein (Profil vorhanden); sonst entsteht die Property
  -- regulär beim Freischalten des Zugangs (create-eigentuemer-access).
  select profile_id into v_profile from leads where id = v_lead;
  if v_profile is null then return; end if;

  select cpu.id, cpu.unit_number, cpu.type, cpu.bedrooms, cpu.bathrooms, cpu.size_sqm,
         cpu.terrace_sqm, cpu.floor, cpu.block, cpu.is_furnished, cpu.rental_type,
         cpu.price_net, cpu.price_gross, cpu.property_id,
         pr.name as proj_name, pr.location as proj_loc, pr.status as proj_status
    into v_unit
    from crm_project_units cpu
    left join crm_projects pr on pr.id = cpu.project_id
   where cpu.id = v_unit_id;
  if v_unit.id is null then return; end if;

  -- Property existiert schon (z.B. über andere Stelle erzeugt) -> nur Eigentümer + Link setzen
  if v_unit.property_id is not null then
    update properties set owner_id = v_profile where id = v_unit.property_id and owner_id is null;
    update deals set property_id = v_unit.property_id where id = p_deal_id;
    return;
  end if;

  insert into properties (
    project_name, unit_number, type, bedrooms, bathrooms, size_sqm, terrace_sqm,
    floor, block, is_furnished, rental_type, city,
    purchase_price_net, purchase_price_gross, property_status, owner_id, created_by, images
  ) values (
    coalesce(v_unit.proj_name, ''), v_unit.unit_number, coalesce(v_unit.type, 'apartment'),
    coalesce(v_unit.bedrooms, 0), v_unit.bathrooms, v_unit.size_sqm, v_unit.terrace_sqm,
    v_unit.floor, v_unit.block, coalesce(v_unit.is_furnished, false),
    case when v_unit.rental_type = 'short' then 'shortterm' else 'longterm' end,
    case when v_unit.proj_loc is not null and v_unit.proj_loc not like 'http%' then v_unit.proj_loc else null end,
    v_unit.price_net, v_unit.price_gross,
    case when v_unit.proj_status = 'under_construction' then 'under_construction' else 'active' end,
    v_profile, v_profile, '{}'
  ) returning id into v_pid;

  update crm_project_units set property_id = v_pid where id = v_unit.id;
  update deals set property_id = v_pid where id = p_deal_id;
end;
$$;

-- Trigger auf deals: greift, sobald ein Deal eine Wohnung trägt und noch keine Property
-- verlinkt ist. Die WHEN-Bedingung (property_id is null) verhindert Rekursion.
create or replace function public.fn_trg_deal_property() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.fn_ensure_deal_property(new.id);
  return new;
end;
$$;

drop trigger if exists trg_deal_sync_property on deals;
create trigger trg_deal_sync_property
  after insert or update of unit_id, lead_id, property_id on deals
  for each row
  when (new.unit_id is not null and new.property_id is null)
  execute function public.fn_trg_deal_property();

-- Trigger auf leads: wird ein Lead zum Eigentümer (profile_id gesetzt), werden alle
-- bereits zugewiesenen Wohnungen seiner Deals in die Verwaltung nachgezogen.
create or replace function public.fn_trg_lead_property() returns trigger
language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  for d in select id from deals where lead_id = new.id and unit_id is not null and property_id is null loop
    perform public.fn_ensure_deal_property(d);
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_lead_sync_property on leads;
create trigger trg_lead_sync_property
  after update of profile_id on leads
  for each row
  when (new.profile_id is not null and new.profile_id is distinct from old.profile_id)
  execute function public.fn_trg_lead_property();
