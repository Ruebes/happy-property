-- Besucher-Typisierung (Sven, 27.8.): Sessions nach Verhalten klassifizieren,
-- um "Neugierige/Exposé-Jäger" von echten Interessenten zu trennen und die
-- Frage "warum kein Termin?" datenbasiert zu beantworten.
--
-- Regeln (bewusst einfache, nachvollziehbare Heuristik — kein ML):
--   gebucht         Termin über den Funnel abgeschlossen (Event booking_done)
--   funnel_abbruch  /termin betreten, aber nicht gebucht
--   expose_jaeger   Objekt-/Exposé-/Rechner-Seiten angesehen, < 2 Min Lesezeit
--   interessent     >= 60 s aktiv UND (>= 2 Seiten ODER >= 50 % gescrollt)
--   kurzbesucher    >= 20 s oder etwas gescrollt, sonst nichts
--   absprung        sofort wieder weg
create or replace function public.hp_wa_segments(p_from timestamptz, p_to timestamptz, p_site text default null)
returns table(session_id uuid, segment text)
language sql stable as $$
with s as (
  select ws.id, ws.lead_id, ws.duration_s, ws.pageviews, ws.max_scroll_pct,
    exists(select 1 from public.web_events e where e.session_id = ws.id
           and e.type = 'c:booking_done') as booked,
    exists(select 1 from public.web_events e where e.session_id = ws.id
           and e.type = 'pageview' and e.path like '/termin%') as funnel_seen,
    exists(select 1 from public.web_events e where e.session_id = ws.id
           and e.type = 'pageview'
           and (e.path ~ '^/(deck|rechnung|strategie)/'
                or e.path ~* 'rechner|projekt|immobilie|expose|objekt')) as objekt_seen
  from public.web_sessions ws
  where ws.started_at >= p_from and ws.started_at < p_to
    and (p_site is null or ws.site = p_site)
)
select id, case
  when booked then 'gebucht'
  when funnel_seen then 'funnel_abbruch'
  when objekt_seen and duration_s < 120 then 'expose_jaeger'
  when duration_s >= 60 and (pageviews >= 2 or max_scroll_pct >= 50) then 'interessent'
  when objekt_seen then 'interessent'
  when duration_s >= 20 or max_scroll_pct >= 25 then 'kurzbesucher'
  else 'absprung'
end
from s;
$$;

revoke all on function public.hp_wa_segments(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.hp_wa_segments(timestamptz, timestamptz, text) to authenticated, service_role;
