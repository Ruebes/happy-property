-- Öffnungs-Auswertung je Newsletter-Kampagne: Wer hat welches (geklonte) Deck
-- wie oft geöffnet? Join über sales_decks.batch_id (= Kampagnen-ID) und
-- engagement_events (deck_view je Token). Serverseitig, da eine Kampagne
-- hunderte Deck-Tokens haben kann (URL-Limit bei Client-Joins).
create or replace function public.newsletter_engagement(p_campaign uuid)
returns jsonb
language sql
stable
as $$
with decks as (
  select d.token, d.lead_id, d.project_id
  from public.sales_decks d
  where d.batch_id = p_campaign and d.lead_id is not null
),
views as (
  select d.lead_id, d.project_id,
         min(e.occurred_at) as first_view, max(e.occurred_at) as last_view,
         count(*) as views
  from decks d
  join public.engagement_events e on e.token = d.token and e.type = 'deck_view'
  group by d.lead_id, d.project_id
),
calcs as (
  -- Beispielrechnungen sind KAMPAGNENWEIT (ein Token je Projekt, lead_id null):
  -- Aufrufe lassen sich keinem Empfaenger zuordnen, nur zaehlen.
  select pr->>'project_name' as project, pr->>'calc_token' as token
  from public.newsletter_campaigns c, jsonb_array_elements(c.properties) pr
  where c.id = p_campaign and coalesce(pr->>'calc_token', '') <> ''
),
calc_counts as (
  select ca.project, count(e.id) as views, max(e.occurred_at) as last_view
  from calcs ca
  left join public.engagement_events e on e.token = ca.token and e.type = 'calc_view'
  group by ca.project
)
select jsonb_build_object(
  'recipients', (select count(distinct lead_id) from decks),
  'openers',    (select count(distinct lead_id) from views),
  'calc_views', coalesce((select jsonb_agg(to_jsonb(calc_counts.*)) from calc_counts), '[]'::jsonb),
  'rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'lead_id',   v.lead_id,
      'name',      nullif(trim(coalesce(l.first_name, '') || ' ' || coalesce(l.last_name, '')), ''),
      'email',     l.email,
      'project',   coalesce(p.name, '—'),
      'views',     v.views,
      'last_view', v.last_view
    ) order by v.last_view desc)
    from views v
    join public.leads l on l.id = v.lead_id
    left join public.crm_projects p on p.id = v.project_id
  ), '[]'::jsonb)
);
$$;

revoke all on function public.newsletter_engagement(uuid) from public, anon;
grant execute on function public.newsletter_engagement(uuid) to authenticated, service_role;
