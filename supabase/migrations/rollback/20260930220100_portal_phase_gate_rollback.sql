-- Rücknahme von 20260930220100_portal_phase_gate.sql (NICHT automatisch angewendet)
-- Stellt die Live-Definitionen vom 30.9.2026 wortgleich wieder her
-- (pg_get_functiondef / pg_get_triggerdef, gelesen am 30.9.2026 vor der Migration).
-- Datenzeilen werden nicht angefasst.

-- Trigger wie live: ohne Spalte phase
drop trigger if exists trg_deal_sync_property on public.deals;
CREATE TRIGGER trg_deal_sync_property AFTER INSERT OR UPDATE OF unit_id, lead_id, property_id ON public.deals FOR EACH ROW WHEN (((new.unit_id IS NOT NULL) AND (new.property_id IS NULL))) EXECUTE FUNCTION fn_trg_deal_property();

CREATE OR REPLACE FUNCTION public.fn_ensure_deal_property(p_deal_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_trg_lead_property()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d uuid;
begin
  for d in select id from deals where lead_id = new.id and unit_id is not null and property_id is null loop
    perform public.fn_ensure_deal_property(d);
  end loop;
  return new;
end;
$function$;

-- Unverändert live, hier nur zur Vollständigkeit wortgleich:
CREATE OR REPLACE FUNCTION public.fn_trg_deal_property()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.fn_ensure_deal_property(new.id);
  return new;
end;
$function$;

-- Neue Hilfsfunktion der Migration entfernen (erst NACH den Funktionen oben,
-- die sie dann nicht mehr aufrufen).
drop function if exists public.hp_deal_in_portal(text, text);
