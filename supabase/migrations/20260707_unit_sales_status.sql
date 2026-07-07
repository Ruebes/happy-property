-- Verkaufsstatus (sold/reserved/proposal) darf nicht mehr vom Bau-Status-Sync
-- überschrieben werden. Vorher zwangen die Trigger JEDEN Unit-Status auf den
-- Projekt-Bau-Status (under_construction|active) → sold/reserved war nie speicherbar.
create or replace function public.fn_force_unit_status_from_project()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_proj_status text;
begin
  if new.project_id is null then return new; end if;
  -- Verkaufs-/Angebotsstatus hat Vorrang und bleibt unangetastet
  if new.status in ('sold','reserved','proposal') then return new; end if;
  select status into v_proj_status from crm_projects where id = new.project_id;
  if v_proj_status is null then return new; end if;
  new.status := public.hp_build_status(v_proj_status);
  return new;
end $$;

create or replace function public.hp_cascade_project_status()
returns trigger language plpgsql security definer set search_path to 'public','pg_temp' as $$
begin
  -- Bau-Status-Kaskade NUR für Units im Bau-Status — sold/reserved/proposal bleiben
  update crm_project_units
     set status = hp_build_status(new.status)
   where project_id = new.id
     and status in ('under_construction','active')
     and status is distinct from hp_build_status(new.status);
  update properties pr
     set property_status = hp_build_status(new.status)
    from crm_project_units u
   where u.project_id = new.id
     and u.property_id = pr.id
     and u.status in ('under_construction','active')
     and pr.property_status is distinct from hp_build_status(new.status);
  return new;
end $$;
