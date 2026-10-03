-- Werbemanager: Nachtrag der Meta-Zuordnung für Bestands-Leads (03.10.2026).
--
-- ERST EINSPIELEN NACH SVENS "jetzt live" (Paket 5), nach
-- 20261003101000_leads_meta_zuordnung.sql. Vorher Sven die Liste der
-- betroffenen Leads zeigen (Abfrage unten unter "Vorschau").
--
-- Was passiert (nur Leads, deren Felder noch leer sind):
--   1. meta_ad_id, meta_adset_id, meta_campaign_id aus numerischen UTMs, die im
--      Katalog (ad_catalog, Plattform meta) als ID vorkommen:
--        utm_term    = ad_id    (Sofortformular-Leads)       -> Quelle utm_term
--        utm_content = ad_id    (Standard-Schema der Anzeigen) -> Quelle utm_content_id
--        utm_term    = adset_id (Standard-Schema, ohne Anzeige) -> Quelle utm_term
--      Nur wenn alle drei meta_*-ID-Felder leer sind. Namen werden hier
--      bewusst NICHT nachgetragen (nicht eindeutig); das macht weiter
--      ads_lead_attribution beim Lesen.
--   2. meta_leadgen_id aus dem Notiztext "Meta-Lead-ID: <15-17 Ziffern>", nur
--      wenn meta_leadgen_id leer ist. Quelle notes_leadgen nur, wenn noch keine
--      Quelle gesetzt ist. Anzeige/Kampagne zu diesen Leads holt später
--      meta-builder leadgen_lookup (Graph), nicht diese Datei.
--   meta_attr_at = Zeitpunkt dieses Laufs.
--
-- Rückholbar: jede Änderung wird in public.leads_meta_nachtrag protokolliert
-- (geschriebene Werte und vorherige Quelle). Der Rückbau setzt genau diese
-- Werte zurück, solange sie seitdem niemand überschrieben hat.
--
-- Nebenwirkungen: UPDATE auf leads löst nur leads_updated_at aus (updated_at
-- springt auf jetzt). Workflow-Einschreibung (trg_hp_enroll_wf_lead) hängt nur
-- an INSERT; quality_rating, status und profile_id werden nicht angefasst.
--
-- Idempotent: ein zweiter Lauf findet nur noch Leads, die inzwischen neu
-- zuordenbar sind (z. B. nach einem Katalog-Sync), und lässt alles andere.
-- Als Ganzes in einer Transaktion ausführen.
-- Rückbau: rollback/20261003102000_leads_meta_backfill.down.sql
--
-- Vorschau (nur lesend, vor dem Einspielen für Sven):
--   select l.id, l.created_at, l.utm_source, l.utm_term, l.utm_content,
--          substring(l.notes from 'Meta-Lead-ID:\s*([0-9]{15,17})([^0-9]|$)') as leadgen
--     from public.leads l
--    where (l.meta_ad_id is null and l.meta_adset_id is null and l.meta_campaign_id is null
--           and (btrim(l.utm_term) ~ '^[0-9]{10,20}$' or btrim(l.utm_content) ~ '^[0-9]{10,20}$'))
--       or (l.meta_leadgen_id is null and l.notes ~ 'Meta-Lead-ID:\s*[0-9]{15,17}([^0-9]|$)')
--    order by l.created_at desc
--    limit 500;

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Protokoll für den Rückbau (nur Service-Role, kein Browser-Zugriff)
-- ---------------------------------------------------------------------------

create table if not exists public.leads_meta_nachtrag (
  lead_id          uuid primary key references public.leads(id) on delete cascade,
  meta_ad_id       text,
  meta_adset_id    text,
  meta_campaign_id text,
  meta_leadgen_id  text,
  meta_attr_quelle text,
  meta_attr_at     timestamptz,
  vorher_quelle    text,
  vorher_at        timestamptz,
  erstellt_at      timestamptz not null default now()
);

comment on table public.leads_meta_nachtrag is
  'Protokoll des einmaligen Nachtrags der Meta-Zuordnung (20261003102000): welche meta_*-Werte der Nachtrag je Lead geschrieben hat und welche Quelle vorher stand. Grundlage für den exakten Rückbau. Nur Service-Role.';

alter table public.leads_meta_nachtrag enable row level security;
revoke all on table public.leads_meta_nachtrag from anon, authenticated;
grant all on table public.leads_meta_nachtrag to service_role;

-- ---------------------------------------------------------------------------
-- 1. Anzeige / Anzeigengruppe / Kampagne aus numerischen UTMs
-- ---------------------------------------------------------------------------

with kandidat as (
  select l.id,
         coalesce(t_ad.ad_id, c_ad.ad_id)                                as ad_id,
         coalesce(t_ad.adset_id, c_ad.adset_id, t_set.adset_id)         as adset_id,
         coalesce(t_ad.campaign_id, c_ad.campaign_id, t_set.campaign_id) as campaign_id,
         case
           when t_ad.ad_id is not null then 'utm_term'
           when c_ad.ad_id is not null then 'utm_content_id'
           else 'utm_term'
         end                                                             as quelle,
         l.meta_attr_quelle                                              as alt_quelle,
         l.meta_attr_at                                                  as alt_at
    from public.leads l
    left join lateral (
      select c.ad_id, c.adset_id, c.campaign_id
        from public.ad_catalog c
       where btrim(l.utm_term) ~ '^[0-9]{10,20}$'
         and c.platform = 'meta'
         and c.ad_id = btrim(l.utm_term)
       limit 1
    ) t_ad on true
    left join lateral (
      select c.ad_id, c.adset_id, c.campaign_id
        from public.ad_catalog c
       where btrim(l.utm_content) ~ '^[0-9]{10,20}$'
         and c.platform = 'meta'
         and c.ad_id = btrim(l.utm_content)
       limit 1
    ) c_ad on true
    left join lateral (
      select c.adset_id, c.campaign_id
        from public.ad_catalog c
       where btrim(l.utm_term) ~ '^[0-9]{10,20}$'
         and c.platform = 'meta'
         and c.adset_id = btrim(l.utm_term)
       limit 1
    ) t_set on true
   where l.meta_ad_id is null
     and l.meta_adset_id is null
     and l.meta_campaign_id is null
     and (t_ad.ad_id is not null or c_ad.ad_id is not null or t_set.adset_id is not null)
),
geaendert as (
  update public.leads l
     set meta_ad_id       = k.ad_id,
         meta_adset_id    = k.adset_id,
         meta_campaign_id = k.campaign_id,
         meta_attr_quelle = k.quelle,
         meta_attr_at     = now()
    from kandidat k
   where l.id = k.id
     and l.meta_ad_id is null
     and l.meta_adset_id is null
     and l.meta_campaign_id is null
  returning l.id, k.ad_id, k.adset_id, k.campaign_id, k.quelle, k.alt_quelle, k.alt_at
)
insert into public.leads_meta_nachtrag as n
  (lead_id, meta_ad_id, meta_adset_id, meta_campaign_id,
   meta_attr_quelle, meta_attr_at, vorher_quelle, vorher_at)
select g.id, g.ad_id, g.adset_id, g.campaign_id,
       g.quelle, now(), g.alt_quelle, g.alt_at
  from geaendert g
on conflict (lead_id) do update
  set meta_ad_id       = excluded.meta_ad_id,
      meta_adset_id    = excluded.meta_adset_id,
      meta_campaign_id = excluded.meta_campaign_id,
      meta_attr_quelle = excluded.meta_attr_quelle,
      meta_attr_at     = excluded.meta_attr_at;

-- ---------------------------------------------------------------------------
-- 2. Meta-Lead-ID aus dem Notiztext
-- ---------------------------------------------------------------------------

with kandidat as (
  select l.id,
         substring(l.notes from 'Meta-Lead-ID:\s*([0-9]{15,17})([^0-9]|$)') as leadgen,
         l.meta_attr_quelle                                                  as alt_quelle,
         l.meta_attr_at                                                      as alt_at
    from public.leads l
   where l.meta_leadgen_id is null
     and l.notes ~ 'Meta-Lead-ID:\s*[0-9]{15,17}([^0-9]|$)'
),
geaendert as (
  update public.leads l
     set meta_leadgen_id  = k.leadgen,
         meta_attr_quelle = coalesce(l.meta_attr_quelle, 'notes_leadgen'),
         meta_attr_at     = coalesce(l.meta_attr_at, now())
    from kandidat k
   where l.id = k.id
     and l.meta_leadgen_id is null
     and k.leadgen is not null
  returning l.id, k.leadgen, k.alt_quelle, k.alt_at
)
insert into public.leads_meta_nachtrag as n
  (lead_id, meta_leadgen_id, meta_attr_quelle, meta_attr_at, vorher_quelle, vorher_at)
select g.id,
       g.leadgen,
       case when g.alt_quelle is null then 'notes_leadgen' end,
       case when g.alt_at is null then now() end,
       g.alt_quelle,
       g.alt_at
  from geaendert g
on conflict (lead_id) do update
  set meta_leadgen_id  = excluded.meta_leadgen_id,
      meta_attr_quelle = coalesce(n.meta_attr_quelle, excluded.meta_attr_quelle),
      meta_attr_at     = coalesce(n.meta_attr_at, excluded.meta_attr_at);

commit;
