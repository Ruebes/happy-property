-- Öffnungs-Auswertung je Newsletter-Kampagne: Mail-Öffnungen (Pixel), Deck-Ansichten
-- und Berechnungs-Aufrufe. Join über sales_decks.batch_id (= Kampagnen-ID) und
-- engagement_events. Serverseitig (hunderte Tokens → Client-Join scheitert am URL-Limit).
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
mail_opens as (
  select d.lead_id, min(e.occurred_at) as first_open
  from decks d
  join public.engagement_events e on e.token = d.token and e.type = 'email_open'
  group by d.lead_id
),
views as (
  select d.lead_id, d.project_id,
         min(e.occurred_at) as first_view, max(e.occurred_at) as last_view,
         count(*) as views
  from decks d
  join public.engagement_events e on e.token = d.token and e.type = 'deck_view'
  group by d.lead_id, d.project_id
),
per_lead_decks as (
  select v.lead_id,
         jsonb_agg(jsonb_build_object(
           'project', coalesce(p.name, '—'), 'views', v.views, 'last_view', v.last_view
         ) order by v.last_view desc) as decks,
         max(v.last_view) as last_view
  from views v
  left join public.crm_projects p on p.id = v.project_id
  group by v.lead_id
),
engaged as (
  select lead_id from mail_opens
  union
  select lead_id from per_lead_decks
),
calcs as (
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
  'recipients',   (select count(distinct lead_id) from decks),
  'mail_openers', (select count(*) from mail_opens),
  'openers',      (select count(*) from per_lead_decks),
  'calc_views',   coalesce((select jsonb_agg(to_jsonb(calc_counts.*)) from calc_counts), '[]'::jsonb),
  'rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'lead_id',     g.lead_id,
      'name',        nullif(trim(coalesce(l.first_name, '') || ' ' || coalesce(l.last_name, '')), ''),
      'email',       l.email,
      'mail_opened', mo.first_open,
      'decks',       coalesce(pld.decks, '[]'::jsonb),
      'last_view',   pld.last_view
    ) order by coalesce(pld.last_view, mo.first_open) desc)
    from engaged g
    join public.leads l on l.id = g.lead_id
    left join mail_opens mo on mo.lead_id = g.lead_id
    left join per_lead_decks pld on pld.lead_id = g.lead_id
  ), '[]'::jsonb)
);
$$;

revoke all on function public.newsletter_engagement(uuid) from public, anon;
grant execute on function public.newsletter_engagement(uuid) to authenticated, service_role;
