-- Web-Analytics, Besucher-Typen neu (Sven 6.11.2026, Befund im Dashboard: „so viele
-- echte Interessenten buchen nicht").
--
-- Warum neu: „Funnel abgebrochen" zählte jeden Aufruf von /termin, auch wer nach
-- 3 Sekunden wieder weg war und auch /termin/verwalten. „Exposé-Jäger" zählte die
-- Masterclass-Seite mit, weil der Pfad „immobilien" enthält. „Echte Interessenten"
-- konnte per Definition nicht buchen, denn wer /termin berührt, landet woanders.
--
-- Die Zuordnung steht nur hier. Dashboard und Wochenreport fragen sie über
-- hp_wa_segment_counts und hp_wa_session_list ab, weil die Datenbank-Schnittstelle
-- höchstens 1.000 Zeilen je Aufruf liefert und das Zählen im Browser deshalb falsch war.
--
-- Rücknahme: rollback/20261106180000_wa_besucher_typen.down.sql

create or replace function public.hp_wa_segments(p_from timestamptz, p_to timestamptz, p_site text default null)
returns table(session_id uuid, segment text)
language sql stable
as $$
with s as (
  select ws.id, ws.lead_id, ws.duration_s, ws.pageviews, ws.max_scroll_pct,
    exists(select 1 from public.web_events e where e.session_id = ws.id and e.type = 'c:booking_done') as gebucht,
    exists(select 1 from public.web_events e where e.session_id = ws.id and (
      e.type = 'c:unterlagen_done'
      -- Das Ereignis gibt es erst seit dem 6.11.2026 abends. Bis dahin zählt der Klick auf den letzten
      -- Knopf als Näherung, also auch Versuche, die an einer Eingabeprüfung gescheitert sind.
      or (ws.started_at < timestamptz '2026-11-07 00:00:00+02'
          and e.type = 'click' and e.path in ('/termin', '/termin/') and e.txt = 'Unterlagen anfordern')
    )) as unterlagen,
    -- Jeder Knopf im Funnel zählt als Start: Der erste Knopf ist immer der Start-Knopf,
    -- seine Beschriftung ist je Fragebogen frei wählbar.
    exists(select 1 from public.web_events e where e.session_id = ws.id and e.type = 'click'
           and e.path in ('/termin', '/termin/') and e.selector ~* '(^|>)button([.#][^>]*)?$') as funnel_gestartet,
    exists(select 1 from public.web_events e where e.session_id = ws.id and e.type = 'pageview'
           and e.path in ('/termin', '/termin/')) as funnel_gesehen,
    exists(select 1 from public.web_events e where e.session_id = ws.id and e.type = 'pageview'
           and e.path ~* 'masterclass') as masterclass,
    -- Nur echte Objektseiten: Projekte, Rechner, Exposés und Kundenseiten mit Token.
    -- Artikel und Landingpages mit „immobilie" im Pfad zählen nicht mehr.
    exists(select 1 from public.web_events e where e.session_id = ws.id and e.type = 'pageview'
           and (e.path ~ '^/(deck|rechnung|strategie)/'
                or e.path ~* '^/(top-projekte|expose|objekte)(/|$)|rechner')) as objekt
  from public.web_sessions ws
  where ws.started_at >= p_from and ws.started_at < p_to
    and not ws.is_bot
    and (p_site is null or ws.site = p_site)
)
select s.id, case
  when s.gebucht then 'gebucht'
  when s.unterlagen then 'unterlagen'
  when s.funnel_gestartet then 'funnel_gestartet'
  when s.funnel_gesehen then 'funnel_gesehen'
  when s.masterclass then 'masterclass'
  -- Bekannte Kontakte öffnen meist einen Link, den wir ihnen geschickt haben. Sie sind
  -- keine Exposé-Jäger und laufen unten nach ihrer Aktivität weiter.
  when s.objekt and s.duration_s < 120 and s.lead_id is null then 'expose_jaeger'
  when (s.objekt and s.duration_s >= 120)
    or (s.duration_s >= 60 and (s.pageviews >= 2 or s.max_scroll_pct >= 50))
    then case when s.lead_id is null then 'interessent_neu' else 'interessent_bekannt' end
  when s.duration_s >= 20 or s.max_scroll_pct >= 25 then 'kurzbesucher'
  else 'absprung'
end
from s;
$$;

revoke all on function public.hp_wa_segments(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.hp_wa_segments(timestamptz, timestamptz, text) to authenticated, service_role;

-- Anzahl je Typ. Die Summe ist die Zahl aller Sitzungen im Zeitraum, ohne 1.000er-Grenze.
create or replace function public.hp_wa_segment_counts(p_from timestamptz, p_to timestamptz, p_site text default null)
returns table(segment text, n bigint)
language sql stable
as $$
  select s.segment, count(*)
  from public.hp_wa_segments(p_from, p_to, p_site) s
  group by 1;
$$;

revoke all on function public.hp_wa_segment_counts(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.hp_wa_segment_counts(timestamptz, timestamptz, text) to authenticated, service_role;

-- Besucherliste: die neuesten Sitzungen mit ihrem Typ. Mit p_segment werden alle Sitzungen
-- des Zeitraums eingeordnet und gefiltert, ohne p_segment nur das Zeitfenster der Treffer.
-- Läuft mit den Rechten des Aufrufers, Zeilenschutz von web_sessions und leads gilt also weiter.
create or replace function public.hp_wa_session_list(
  p_from timestamptz, p_to timestamptz, p_site text default null,
  p_segment text default null, p_only_leads boolean default false, p_only_replay boolean default false,
  p_limit integer default 200
)
returns table(
  id uuid, visitor_id text, site text, entry_path text, referrer text, utm jsonb,
  device text, browser text, os text, lead_id uuid, started_at timestamptz,
  duration_s integer, pageviews integer, clicks integer, max_scroll_pct integer, has_replay boolean,
  lead_first_name text, lead_last_name text, segment text
)
language sql stable
as $$
with fenster as (
  select case when p_segment is null then (
    select min(t.started_at) from (
      select w.started_at from public.web_sessions w
      where w.started_at >= p_from and w.started_at < p_to and not w.is_bot
        and (p_site is null or w.site = p_site)
        and (not p_only_leads or w.lead_id is not null)
        and (not p_only_replay or w.has_replay)
      order by w.started_at desc
      limit p_limit
    ) t
  ) end as ab
),
typ as (
  select s.session_id, s.segment
  from fenster f, public.hp_wa_segments(coalesce(f.ab, p_from), p_to, p_site) s
  where p_segment is null or s.segment = p_segment
)
select ws.id, ws.visitor_id, ws.site, ws.entry_path, ws.referrer, ws.utm,
  ws.device, ws.browser, ws.os, ws.lead_id, ws.started_at,
  ws.duration_s, ws.pageviews, ws.clicks, ws.max_scroll_pct, ws.has_replay,
  l.first_name::text, l.last_name::text, typ.segment
from typ
join public.web_sessions ws on ws.id = typ.session_id
left join public.leads l on l.id = ws.lead_id
where (not p_only_leads or ws.lead_id is not null)
  and (not p_only_replay or ws.has_replay)
order by ws.started_at desc
limit p_limit;
$$;

revoke all on function public.hp_wa_session_list(timestamptz, timestamptz, text, text, boolean, boolean, integer) from public, anon;
grant execute on function public.hp_wa_session_list(timestamptz, timestamptz, text, text, boolean, boolean, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
