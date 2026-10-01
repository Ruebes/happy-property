-- Werbemanager: gleiche CRM-Zahlen für alle, die ihn öffnen dürfen
-- (Audit F10-10, Teil 2).
--
-- Problem: AdsManager.tsx liest leads, crm_appointments und deals mit dem
-- normalen Client. Deren RLS lässt nur Admin/Verwalter oder das Recht
-- 'pipeline' durch. Werbe-Mitarbeiter (Recht 'werbung' bzw. 'werbung_<kanal>')
-- ohne Pipeline-Recht bekamen leere Listen ohne Fehler und sahen dadurch die
-- Meta-Lead-Zahl, null Termine, keine Qualität, keine Sales und kein ROAS.
--
-- Entscheidung Sven (1.10.2026): alle, die den Werbemanager öffnen dürfen,
-- sehen dieselben Zahlen wie der Admin, inklusive Provision (Umsatz, ROAS).
--
-- Lösung: eine rein lesende SECURITY-DEFINER-Funktion. Sie liefert genau die
-- Zeilen und Spalten, die fetchAll() heute direkt liest, mit demselben Filter:
--   leads             created_at >= p_since UND (utm_source ist eine
--                     Meta-Quelle ODER utm_campaign ist in p_campaign_ids)
--   crm_appointments  alle Termine dieser Leads
--   deals             alle Deals dieser Leads
-- Nur Zuordnungsfelder: keine Namen, keine E-Mail, keine Telefonnummer, keine
-- Notizen. Die Meta-Quellen müssen zu META_SOURCES in AdsManager.tsx passen.
-- p_campaign_ids zählt nur, wenn die ID wirklich in ad_catalog steht (das
-- Frontend übergibt ohnehin nur Katalog-IDs, das Ergebnis ist also gleich).
--
-- Zugriff: Admin/Verwalter oder Mitarbeiter mit 'werbung' oder einem
-- 'werbung_<kanal>'-Recht, sonst Fehler 42501. EXECUTE nur für authenticated.
--
-- Das Frontend ruft die Funktion NUR ohne Pipeline-Recht auf. Admin, Verwalter
-- und Pipeline-Mitarbeiter lesen weiter direkt, ihre Zahlen ändern sich nicht.
--
-- Rein additiv: keine Tabelle, keine Policy, keine bestehende Funktion wird
-- geändert. Idempotent (mehrfach ausführbar).
-- Rückbau: rollback/20261001100000_ads_crm_attribution.down.sql

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
  v_allowed boolean;
  v_result  jsonb;
begin
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (
        p.role in ('admin', 'verwalter')
        or (
          p.role = 'mitarbeiter'
          and exists (
            select 1
            from jsonb_each(
              case when jsonb_typeof(p.permissions) = 'object'
                   then p.permissions else '{}'::jsonb end
            ) e
            where (e.key = 'werbung' or starts_with(e.key, 'werbung_'))
              and e.value in ('true'::jsonb, '"true"'::jsonb)
          )
        )
      )
  ) into v_allowed;

  if not coalesce(v_allowed, false) then
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

notify pgrst, 'reload schema';
