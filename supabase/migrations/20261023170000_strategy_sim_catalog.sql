-- Kunden-Simulator: Wohnungen selbst auswählen (Sven 23.10.2026)
-- „Ich will den Fahrplan auch ohne Wohnung an den Kunden geben." Der Kunde
-- wählt dann im eigenen Simulator Bauträger, Projekt und Wohnung. Geliefert
-- werden dieselben anbietbaren Wohnungen wie in der Projektauswahl des
-- CRM-Simulators (nicht verkauft/reserviert, kein Portal-Objekt, keine
-- Teil-Wohnung, mit Preis, ohne laufenden Deal) und nur für einen
-- freigeschalteten Simulator.

create or replace function public.get_strategy_sim_catalog(p_token text)
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  select case when not exists (
      select 1 from crm_strategy_scenarios s where s.token = p_token and s.sim_enabled_at is not null
    ) then null
  else jsonb_build_object(
    'units', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id, 'project_id', u.project_id, 'unit_number', u.unit_number, 'bedrooms', u.bedrooms,
        'size_sqm', u.size_sqm, 'price_net', u.price_net, 'price_net_furnished', u.price_net_furnished
      ) order by u.unit_number)
      from crm_project_units u
      where u.status not in ('sold', 'reserved') and u.property_id is null and u.parent_unit_id is null
        and u.price_net > 0
        and not exists (select 1 from deals d where d.unit_id = u.id and d.archived_from_phase is null and d.phase <> 'deal_verloren')
    ), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'furniture_cost', p.furniture_cost, 'furniture_included', p.furniture_included,
        'completion_date', p.completion_date, 'calc_defaults', p.calc_defaults, 'developer', p.developer,
        'payment_schedule', p.payment_schedule
      ) order by p.name)
      from crm_projects p
      where exists (
        select 1 from crm_project_units u
        where u.project_id = p.id and u.status not in ('sold', 'reserved') and u.property_id is null
          and u.parent_unit_id is null and u.price_net > 0
      )
    ), '[]'::jsonb)
  ) end;
$$;

revoke all on function public.get_strategy_sim_catalog(text) from public;
grant execute on function public.get_strategy_sim_catalog(text) to anon, authenticated;
