-- Funnel-Statistik ohne Crawler und Mail-Scanner, dazu Eingabefehler im Kontaktformular
-- (Sven 6.11.2026). Zählt nur anders, gelöscht wird nichts.
--
-- Nicht gezählt werden, solange weder Lead noch Buchung an der Sitzung hängen:
-- 1. Crawler. Metas Prüf-Crawler „meta-externalads" führt die Seite wirklich aus und klickt
--    sich teils durch den Funnel. Das Muster entspricht BOT_RE in wa-track.
-- 2. Mail-Scanner. Sie öffnen Kaltakquise-Links in echten Browsern und sind nur daran zu
--    erkennen, dass nach dem Seitenaufruf nichts passiert. Wer aus der Kaltakquise wirklich
--    etwas anklickt, bleibt drin.
--
-- Neu in der Antwort: contact_errors (Feld und Anzahl Sitzungen), contact_error_sessions
-- und contact_error_recovered (hat nach dem Fehler doch noch abgeschickt).
--
-- Löst die Fassung aus 20260708_funnel_stats.sql und 20260708_funnel_config.sql ab.
-- Rücknahme: rollback/20261106181000_funnel_stats_ohne_bots.down.sql
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
    and (
      fs.lead_id is not null or fs.completed_at is not null
      or not (
        coalesce(fs.user_agent, '') ~* 'bot|crawl|spider|slurp|headless|lighthouse|pingdom|facebookexternal|meta-external|preview|monitor|scanner|curl|wget'
        or (fs.utm->>'utm_source' = 'kaltakquise' and not exists (
          select 1 from public.funnel_events e where e.session_id = fs.id and e.question_key <> 'view'
        ))
      )
    )
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
    and question_key not in ('view','start','contact_view','contact_submitted','contact_error','slots_view','slot_picked')
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
),
-- Eingabefehler ueber alle Sitzungen: Gerade die Fragebogen-Varianten sollen sichtbar sein.
fehler as (
  select e.session_id, e.answer
  from public.funnel_events e
  join sess s on s.id = e.session_id
  where e.question_key = 'contact_error' and e.answer is not null
),
fehler_je_feld as (
  select answer, count(distinct session_id) as n from fehler group by answer
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
  'variants', coalesce((select jsonb_agg(to_jsonb(var_split.*)) from var_split), '[]'::jsonb),
  'contact_errors', coalesce((select jsonb_object_agg(answer, n) from fehler_je_feld), '{}'::jsonb),
  'contact_error_sessions', (select count(distinct session_id) from fehler),
  'contact_error_recovered', (select count(distinct f.session_id) from fehler f where exists (
    select 1 from public.funnel_events e where e.session_id = f.session_id and e.question_key = 'contact_submitted'
  ))
);
$$;

revoke all on function public.funnel_stats(timestamptz, timestamptz) from public, anon;
grant execute on function public.funnel_stats(timestamptz, timestamptz) to authenticated, service_role;
