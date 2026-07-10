-- Editierbarer Termin-Funnel: Fragen/Texte/Bilder liegen in funnel_config (eine
-- Zeile id='default'), gepflegt im CRM-Editor (/admin/crm/funnel-editor) durch
-- Rollen admin + funnel. Der öffentliche Funnel liest anonym (Marketing-Inhalte).
create table if not exists funnel_config (
  id          text primary key default 'default',
  config      jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

alter table funnel_config enable row level security;

drop policy if exists funnel_config_read on funnel_config;
create policy funnel_config_read on funnel_config for select using (true);

drop policy if exists funnel_config_write on funnel_config;
create policy funnel_config_write on funnel_config for all to authenticated
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role in ('admin','funnel')))
  with check (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role in ('admin','funnel')));

-- Statistik: Antwort-Verteilungen nicht mehr über feste Fragen-Whitelist, sondern
-- alles außer den technischen Schritt-Events — so tauchen im Editor NEU angelegte
-- Fragen automatisch in der Auswertung auf.
create or replace function public.funnel_stats(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
as $$
with sess as (
  select fs.id, fs.utm, fs.completed_at,
         exists (
           select 1 from public.funnel_events e
           where e.session_id = fs.id and e.question_key = 'direct_entry'
         ) as is_direct,
         nullif(fs.utm->>'funnel_variant', '') as variant
  from public.funnel_sessions fs
  where fs.started_at >= p_from and fs.started_at < p_to
),
-- Trichter/Antworten NUR aus klassischen Standard-Sessions: Direkteinstiege
-- (Newsletter) und Fragebogen-Varianten (?f=...) ueberspringen bzw. veraendern
-- die Schritte und wuerden den Standard-Trichter verzerren.
ev as (
  select e.session_id, e.question_key, e.answer
  from public.funnel_events e
  join sess s on s.id = e.session_id and not s.is_direct and s.variant is null
),
step_counts as (
  select question_key, count(distinct session_id) as n
  from ev
  group by question_key
),
answer_counts as (
  select question_key, answer, count(distinct session_id) as n
  from ev
  where answer is not null and answer <> ''
    and question_key not in ('view','start','contact_view','contact_submitted','slots_view','slot_picked')
  group by question_key, answer
),
src as (
  select
    coalesce(nullif(s.utm->>'utm_source',''), 'direkt') as source,
    count(*) as sessions,
    count(*) filter (where exists (
      select 1 from public.funnel_events e where e.session_id = s.id and e.question_key = 'contact_submitted'
    )) as leads,
    count(s.completed_at) as bookings
  from sess s
  group by 1
  order by 2 desc
),
var_split as (
  select s.variant,
    count(*) as sessions,
    count(*) filter (where exists (
      select 1 from public.funnel_events e where e.session_id = s.id and e.question_key = 'contact_submitted'
    )) as leads,
    count(s.completed_at) as bookings
  from sess s
  where s.variant is not null and not s.is_direct
  group by 1
  order by 2 desc
)
select jsonb_build_object(
  'sessions', (select count(*) from sess where not is_direct and variant is null),
  'bookings', (select count(*) from sess where completed_at is not null and not is_direct and variant is null),
  'direct_sessions', (select count(*) from sess where is_direct),
  'direct_bookings', (select count(*) from sess where completed_at is not null and is_direct),
  'steps',   coalesce((select jsonb_object_agg(question_key, n) from step_counts), '{}'::jsonb),
  'answers', coalesce((select jsonb_object_agg(question_key, arr) from (
                select question_key,
                       jsonb_agg(jsonb_build_object('answer', answer, 'n', n) order by n desc) as arr
                from answer_counts
                group by question_key
              ) a), '{}'::jsonb),
  'sources', coalesce((select jsonb_agg(to_jsonb(src.*)) from src), '[]'::jsonb),
  'variants', coalesce((select jsonb_agg(to_jsonb(var_split.*)) from var_split), '[]'::jsonb)
);
$$;
