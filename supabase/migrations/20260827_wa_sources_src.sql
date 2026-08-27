-- Quellen-Auswertung: auch den hauseigenen ?src=<kanal>-Parameter zaehlen
-- (Kaltakquise-Links auf /termin nutzen src, nicht utm_source) und die
-- Funnel-Variante ?f= als Notnagel. Vorher fielen diese Besuche auf
-- referrer/direkt zurueck und die Kaltakquise war in der Quellen-Tabelle
-- unsichtbar.
create or replace function public.hp_wa_sources(p_from timestamptz, p_to timestamptz, p_site text default null)
returns table(source text, sessions bigint, visitors bigint)
language sql stable as $$
  select coalesce(
           nullif(utm->>'utm_source', ''),
           nullif(utm->>'src', ''),
           nullif(regexp_replace(coalesce(referrer, ''), '^https?://(www\.)?([^/]+).*$', '\2'), ''),
           'direkt') as source,
         count(*) as sessions, count(distinct visitor_id) as visitors
  from public.web_sessions
  where started_at >= p_from and started_at < p_to
    and (p_site is null or site = p_site)
  group by 1 order by 2 desc;
$$;
