-- Rücknahme von 20261106180000_wa_besucher_typen.sql: alte Typen, Zählung wieder im Browser.
-- Passt nur zusammen mit dem Frontend und wa-weekly-report vor diesem Stand.
drop function if exists public.hp_wa_session_list(timestamptz, timestamptz, text, text, boolean, boolean, integer);
drop function if exists public.hp_wa_segment_counts(timestamptz, timestamptz, text);

CREATE OR REPLACE FUNCTION public.hp_wa_segments(p_from timestamp with time zone, p_to timestamp with time zone, p_site text DEFAULT NULL::text)
 RETURNS TABLE(session_id uuid, segment text)
 LANGUAGE sql
 STABLE
AS $function$
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
    and not ws.is_bot
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
$function$;

revoke all on function public.hp_wa_segments(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.hp_wa_segments(timestamptz, timestamptz, text) to authenticated, service_role;

notify pgrst, 'reload schema';
