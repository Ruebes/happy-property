-- Funnel-Statistik: serverseitige Aggregation für /admin/crm/funnel
-- Liefert Schritt-Trichter, Antwort-Verteilungen und Quellen-Split in einem Call.
-- HINWEIS: identisch mit der Definition in 20260708_funnel_config.sql (Antworten
-- über Blacklist statt Fragen-Whitelist, damit im Editor NEU angelegte Fragen
-- automatisch mitgezählt werden) — beide Dateien müssen dieselbe Version tragen,
-- sonst hängt das Ergebnis von der Migrations-Reihenfolge ab.
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
         ) as is_direct
  from public.funnel_sessions fs
  where fs.started_at >= p_from and fs.started_at < p_to
),
-- Trichter/Antworten NUR aus klassischen Sessions: Direkteinstiege (Newsletter,
-- ?direkt=1) ueberspringen Fragebogen + Kontakt und wuerden die Schritte verzerren.
ev as (
  select e.session_id, e.question_key, e.answer
  from public.funnel_events e
  join sess s on s.id = e.session_id and not s.is_direct
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
)
select jsonb_build_object(
  'sessions', (select count(*) from sess where not is_direct),
  'bookings', (select count(*) from sess where completed_at is not null and not is_direct),
  'direct_sessions', (select count(*) from sess where is_direct),
  'direct_bookings', (select count(*) from sess where completed_at is not null and is_direct),
  'steps',   coalesce((select jsonb_object_agg(question_key, n) from step_counts), '{}'::jsonb),
  'answers', coalesce((select jsonb_object_agg(question_key, arr) from (
                select question_key,
                       jsonb_agg(jsonb_build_object('answer', answer, 'n', n) order by n desc) as arr
                from answer_counts
                group by question_key
              ) a), '{}'::jsonb),
  'sources', coalesce((select jsonb_agg(to_jsonb(src.*)) from src), '[]'::jsonb)
);
$$;

revoke all on function public.funnel_stats(timestamptz, timestamptz) from public, anon;
grant execute on function public.funnel_stats(timestamptz, timestamptz) to authenticated, service_role;
