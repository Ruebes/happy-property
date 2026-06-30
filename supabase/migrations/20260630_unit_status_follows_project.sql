-- Invariante (Vorgabe Sven): Der Status JEDER Wohnung ist IMMER der (Bau-)Status
-- ihres Projekts. Bisher kaskadierte der Projektstatus nur beim ÄNDERN des Projekts
-- auf die Units (hp_cascade_project_status). Beim Anlegen/Zuweisen abweichend gesetzte
-- Unit-Status ('proposal' aus Import, 'active'/'sold'/'reserved' aus Zuweisung) drifteten
-- davon ab -> z.B. Adonidos Gardens 'im Bau', Wohnung 'aktiv'.
--
-- Dieser BEFORE-Trigger erzwingt die Invariante bei JEDEM Insert/Update einer Unit.
-- Der bestehende AFTER-Sync (hp_sync_property_from_unit) zieht die Verwaltungs-Property
-- automatisch nach. Verkauft/Reserviert wird NICHT mehr über das Status-Feld, sondern
-- über Deals abgebildet (verfügbar zum Anbieten = nicht an aktivem Deal).

create or replace function public.fn_force_unit_status_from_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_proj_status text;
begin
  if new.project_id is null then return new; end if;
  select status into v_proj_status from crm_projects where id = new.project_id;
  if v_proj_status is null then return new; end if;
  new.status := public.hp_build_status(v_proj_status);  -- under_construction | active
  return new;
end;
$$;

drop trigger if exists trg_force_unit_status_from_project on crm_project_units;
create trigger trg_force_unit_status_from_project
  before insert or update on crm_project_units
  for each row
  execute function public.fn_force_unit_status_from_project();
