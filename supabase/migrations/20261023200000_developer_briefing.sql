-- Bauträger-Briefing (Sven 23.10.2026)
--
-- 1) Deck-Kopien in anderer Sprache: Für den Mitarbeiter eines Bauträgers gibt es
--    eine übersetzte Kopie eines Kunden-Decks. Die Kopie hängt an keinem Lead
--    (sonst zählt ihr Aufruf als Kundenbesuch und löst Nachfass-Nachrichten aus),
--    trägt aber die Anzeigesprache und den Original-Lead im deck_context:
--      deck_context.view_lang       = 'en'  (Sprache der Kopie)
--      deck_context.source_lead_id  = <uuid> (Lead des Originals)
--      deck_context.source_token    = <token des Originals>
--    Bestehende Decks haben beide Schlüssel nicht, für sie ändert sich nichts.
--
-- 2) Buchungslinks mit fester Dauer, festen Terminarten und festem Betreff,
--    z. B. "Briefing Mito": 15 Minuten, nur Zoom oder WhatsApp.

create or replace function public.get_deck_lang(p_token text)
 returns text
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(nullif(d.deck_context->>'view_lang', ''), l.language, 'de')
    from sales_decks d left join leads l on l.id = d.lead_id
   where d.token = p_token limit 1;
$function$;

create or replace function public.get_deck_let_types(p_token text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  with d as (
    select coalesce(
             s.lead_id,
             case when s.deck_context->>'source_lead_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (s.deck_context->>'source_lead_id')::uuid end
           ) as lead_id,
           p.name as project
    from sales_decks s
    left join crm_projects p on p.id = s.project_id
    where s.token = p_token
  ), items as (
    select it, c.created_at
    from d
    join property_calculations c on c.lead_id = d.lead_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(c.content->'items') = 'array' then c.content->'items' else '[]'::jsonb end
    ) it
    where d.lead_id is not null
      and coalesce(it->>'unit', '') <> ''
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
$function$;

alter table public.booking_invites
  add column if not exists duration_min integer
    check (duration_min is null or duration_min between 15 and 360),
  add column if not exists meeting_types text[]
    check (meeting_types is null or (cardinality(meeting_types) > 0 and meeting_types <@ array['whatsapp', 'zoom', 'onsite']::text[])),
  add column if not exists subject_locked boolean not null default false;

comment on column public.booking_invites.duration_min is 'Feste Termindauer in Minuten (NULL = Gast wählt).';
comment on column public.booking_invites.meeting_types is 'Erlaubte Terminarten (NULL = alle).';
comment on column public.booking_invites.subject_locked is 'Betreff fest aus subject, Gast kann ihn nicht ändern.';
