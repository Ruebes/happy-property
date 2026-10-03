-- Rückbau zu 20261003101000_leads_meta_zuordnung.sql (von Hand ausführen; liegt
-- bewusst im Unterordner rollback/, damit die Supabase-CLI die Datei nicht als
-- Migration einspielt). Als Ganzes in einer Transaktion ausführen.
--
-- REIHENFOLGE: vorher rollback/20261003102000_leads_meta_backfill.down.sql
-- (falls der Nachtrag eingespielt war) und die Rückbauten von Paket B, falls
-- deren Funktionen leads.meta_* lesen. Vorher die Edge Functions zurückstellen,
-- die leads.meta_* schreiben (meta-leads-sync, funnel-api), sonst schlagen
-- deren Schreibzugriffe fehl. Frontend, das ads_lead_attribution aufruft,
-- vorher zurückstellen (sonst PostgREST-Fehler 404 für die RPC).
--
-- Was zurückgebaut wird:
--   1. ads_crm_attribution wieder exakt auf den Stand von 20261001100000 (v1).
--      Gleiche Signatur, Rechte bleiben (CREATE OR REPLACE), wird aber
--      sicherheitshalber neu gesetzt.
--   2. ads_lead_attribution, werbe_lead_aufloesen, werbe_name_norm entfernen.
--   3. Indizes und Spalten meta_* an leads entfernen.
--
-- ACHTUNG Datenverlust: die Werte in leads.meta_ad_id, meta_adset_id,
-- meta_campaign_id, meta_leadgen_id, meta_form_id, meta_attr_quelle und
-- meta_attr_at (auch von meta-leads-sync/funnel-api geschriebene) sind danach
-- weg. Bei Bedarf vorher sichern, z. B.
--   create table public.leads_meta_sicherung as
--     select id, meta_ad_id, meta_adset_id, meta_campaign_id, meta_leadgen_id,
--            meta_form_id, meta_attr_quelle, meta_attr_at
--       from public.leads
--      where meta_ad_id is not null or meta_adset_id is not null
--         or meta_campaign_id is not null or meta_leadgen_id is not null
--         or meta_form_id is not null;

begin;

set local lock_timeout = '5s';

-- 1. ads_crm_attribution v1 (Text unverändert aus 20261001100000)
create or replace function public.ads_crm_attribution(
  p_since        timestamptz,
  p_campaign_ids text[] default '{}'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result  jsonb;
begin
  -- Gleicher Kreis und gleiche Auswertung wie die RLS für Meta-Daten
  -- (ad_settings_read, ad_catalog/ad_insights_daily bei platform = 'meta'):
  -- current_user_has_perm deckt Admin/Verwalter ab und wertet die Rechte
  -- genauso aus wie die übrigen Policies.
  if not (public.current_user_has_perm('werbung')
          or public.current_user_has_perm('werbung_meta')) then
    raise exception 'Kein Zugriff auf die Werbe-Auswertung'
      using errcode = '42501';
  end if;

  if p_since is null then
    raise exception 'p_since fehlt'
      using errcode = '22004';
  end if;

  with ld as (
    select l.id, l.utm_source, l.utm_campaign, l.utm_content,
           l.quality_rating, l.created_at
    from public.leads l
    where l.created_at >= p_since
      and (
        l.utm_source in ('meta', 'facebook', 'fb', 'instagram', 'ig')
        or (
          l.utm_campaign = any (coalesce(p_campaign_ids, '{}'::text[]))
          and exists (
            select 1 from public.ad_catalog c
            where c.campaign_id = l.utm_campaign
          )
        )
      )
  )
  select jsonb_build_object(
    'leads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',             ld.id,
        'utm_source',     ld.utm_source,
        'utm_campaign',   ld.utm_campaign,
        'utm_content',    ld.utm_content,
        'quality_rating', ld.quality_rating,
        'created_at',     ld.created_at))
      from ld
    ), '[]'::jsonb),
    'appts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',         a.id,
        'lead_id',    a.lead_id,
        'start_time', a.start_time,
        'outcome',    a.outcome))
      from public.crm_appointments a
      where a.lead_id in (select ld.id from ld)
    ), '[]'::jsonb),
    'deals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',                d.id,
        'lead_id',           d.lead_id,
        'phase',             d.phase,
        'commission_amount', d.commission_amount))
      from public.deals d
      where d.lead_id in (select ld.id from ld)
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.ads_crm_attribution(timestamptz, text[]) is
  'Werbemanager: CRM-Zuordnung (Leads, Termine, Deals) ohne Personendaten für Werbe-Mitarbeiter ohne Pipeline-Recht. Audit F10-10.';

revoke execute on function public.ads_crm_attribution(timestamptz, text[]) from public;
revoke execute on function public.ads_crm_attribution(timestamptz, text[]) from anon;
grant  execute on function public.ads_crm_attribution(timestamptz, text[]) to authenticated;

-- 2. Neue Funktionen
drop function if exists public.ads_lead_attribution(timestamptz);
drop function if exists public.werbe_lead_aufloesen(text, text, text, text, text, text);
drop function if exists public.werbe_name_norm(text);

-- 3. Indizes und Spalten an leads
drop index if exists public.leads_meta_ad_id_idx;
drop index if exists public.leads_meta_adset_id_idx;
drop index if exists public.leads_meta_campaign_id_idx;
drop index if exists public.leads_meta_leadgen_id_idx;

alter table public.leads
  drop column if exists meta_ad_id,
  drop column if exists meta_adset_id,
  drop column if exists meta_campaign_id,
  drop column if exists meta_leadgen_id,
  drop column if exists meta_form_id,
  drop column if exists meta_attr_quelle,
  drop column if exists meta_attr_at;

notify pgrst, 'reload schema';

commit;
