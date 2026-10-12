-- Deck liest die Vermietungsart aus der Rendite-Berechnung des Kunden (Sven 12.10.26):
-- „Wenn dort Kurzzeit ausgewählt ist, muss das im Deck stehen" - die MwSt. wird bei
-- Kurzzeitvermietung erstattet. Deck und Berechnung haben keine direkte Verknüpfung;
-- zugeordnet wird über Lead + Projektname + Wohnungsnummer. Je Wohnung gilt die
-- jüngste Berechnung des Leads. Öffentlich per Deck-Token wie get_deck_lang, gibt
-- nur Wohnungsnummer, Vermietungsart und Selbstnutzung heraus - keine Zahlen.
-- Rücknahme: rollback/20261012150000_deck_let_types.down.sql

create or replace function public.get_deck_let_types(p_token text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path = public, pg_temp
as $fn$
  with d as (
    select s.lead_id, p.name as project
    from sales_decks s
    left join crm_projects p on p.id = s.project_id
    where s.token = p_token and s.lead_id is not null
  ), items as (
    select it, c.created_at
    from d
    join property_calculations c on c.lead_id = d.lead_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(c.content->'items') = 'array' then c.content->'items' else '[]'::jsonb end
    ) it
    where coalesce(it->>'unit', '') <> ''
      and (d.project is null or coalesce(it->>'project', '') = '' or lower(it->>'project') = lower(d.project))
  ), latest as (
    select distinct on (lower(it->>'unit'))
      jsonb_build_object(
        'unit', it->>'unit',
        'letType', it->'params'->>'letType',
        'selfUseMonths', it->'params'->'selfUseMonths',
        'monthPlan', it->'params'->'monthPlan'
      ) as x
    from items
    order by lower(it->>'unit'), created_at desc
  )
  select coalesce(jsonb_agg(x), '[]'::jsonb) from latest
$fn$;

revoke all on function public.get_deck_let_types(text) from public;
grant execute on function public.get_deck_let_types(text) to anon, authenticated;
