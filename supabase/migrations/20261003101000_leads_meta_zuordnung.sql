-- Werbemanager, Paket 1: feste Zuordnung Lead -> Meta-Anzeige (03.10.2026).
--
-- Problem (Datenlage 02.10.2026): die Zuordnung lief über utm_*-Felder mit
-- drei verschiedenen URL-Tag-Schemata. Sofortformular-Leads tragen die
-- ad_id in utm_term, Website-Leads (Standard-Schema) die adset_id in utm_term
-- und die ad_id in utm_content, ältere Anzeigen nur Namen (nicht eindeutig,
-- "Raus aus Deutschland" steht 4x im Katalog). Die Meta-Lead-ID stand nur im
-- Notiztext.
--
-- Lösung:
--   1. Neue Spalten an leads: meta_ad_id, meta_adset_id, meta_campaign_id,
--      meta_leadgen_id, meta_form_id, meta_attr_quelle, meta_attr_at.
--      Schreiber (später, eigene Deploys): meta-leads-sync (Graph liefert ad,
--      adset, campaign, form, leadgen), funnel-api (numerische UTMs bei
--      Meta-Quelle), meta-builder leadgen_lookup und der Nachtrag
--      20261003102000_leads_meta_backfill.sql. Kein Trigger auf leads.
--      Bekannte Werte meta_attr_quelle: utm_term, utm_content_id,
--      notes_leadgen (Nachtrag); weitere setzen die Schreiber selbst.
--   2. werbe_lead_aufloesen(...): interner Auflöser für EINEN Lead. Reihenfolge:
--      a) feste Spalten meta_*,
--      b) numerisches utm_term als ad_id im Katalog (Sofortformular),
--      c) numerisches utm_content als ad_id im Katalog (Standard-Schema),
--      d) numerisches utm_term als adset_id (Katalog, sonst meta_adsets),
--      e) Kampagne aus numerischem utm_campaign (Katalog, sonst
--         meta_campaigns), sonst ad_settings.utm_campaign_map, sonst
--         eindeutiger Kampagnenname im Katalog,
--      f) Anzeigenname aus utm_content, nur wenn eindeutig (eingeengt auf die
--         Kampagne aus e, bei Mehrdeutigkeit zusätzlich auf den
--         Anzeigengruppen-Namen aus utm_term).
--      Liefert o_ad_id, o_adset_id, o_campaign_id, o_methode
--      (spalten | utm_term | utm_content | utm_campaign | name | keine).
--      Nur für Service-Role und die Definer-Funktionen unten ausführbar.
--   3. ads_lead_attribution(p_since): je Meta-Lead seit p_since die aufgelöste
--      Anzeige/Anzeigengruppe/Kampagne und die Methode. Rückgabe-Spalten:
--      lead_id, meta_ad_id, meta_adset_id, meta_campaign_id, methode,
--      meta_leadgen_id. Ohne Recht 'werbung'/'werbung_meta' (und nicht
--      Service-Role) kommt eine leere Liste zurück.
--   4. ads_crm_attribution v2: gleiche Signatur und gleicher Lead-Filter wie
--      20261001100000 (Zahlen bleiben gleich), je Lead zusätzlich utm_term,
--      meta_ad_id, meta_adset_id, meta_campaign_id, meta_attr_methode
--      (aufgelöst wie oben). Setzt voraus, dass 20261001100000 vorher
--      eingespielt wurde oder legt die Funktion sonst neu an (gleiche Rechte).
--
-- Rein additiv, keine Datenänderung. Idempotent. Als Ganzes in einer
-- Transaktion ausführen, nach 20261003100000_werbung_fundament.sql (braucht
-- ad_settings.utm_campaign_map und meta_adsets/meta_campaigns).
-- Rückbau: rollback/20261003101000_leads_meta_zuordnung.down.sql

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Spalten an leads
-- ---------------------------------------------------------------------------

alter table public.leads
  add column if not exists meta_ad_id       text,
  add column if not exists meta_adset_id    text,
  add column if not exists meta_campaign_id text,
  add column if not exists meta_leadgen_id  text,
  add column if not exists meta_form_id     text,
  add column if not exists meta_attr_quelle text,
  add column if not exists meta_attr_at     timestamptz;

create index if not exists leads_meta_ad_id_idx
  on public.leads (meta_ad_id) where meta_ad_id is not null;
create index if not exists leads_meta_adset_id_idx
  on public.leads (meta_adset_id) where meta_adset_id is not null;
create index if not exists leads_meta_campaign_id_idx
  on public.leads (meta_campaign_id) where meta_campaign_id is not null;
create index if not exists leads_meta_leadgen_id_idx
  on public.leads (meta_leadgen_id) where meta_leadgen_id is not null;

comment on column public.leads.meta_ad_id is
  'Meta-Anzeige, aus der der Lead stammt (Fakt aus Graph oder numerischer UTM). Vorrang vor utm_term/utm_content.';
comment on column public.leads.meta_adset_id is
  'Meta-Anzeigengruppe des Leads.';
comment on column public.leads.meta_campaign_id is
  'Meta-Kampagne des Leads.';
comment on column public.leads.meta_leadgen_id is
  'Meta-Lead-ID (leadgen_id) bei Sofortformular-Leads. Geht als user_data.lead_id an die Conversions-API.';
comment on column public.leads.meta_form_id is
  'Meta-Sofortformular (form_id) bei Formular-Leads.';
comment on column public.leads.meta_attr_quelle is
  'Woher die meta_*-Zuordnung stammt, z. B. utm_term, utm_content_id, notes_leadgen (Nachtrag) oder der Kennwert des schreibenden Syncs.';
comment on column public.leads.meta_attr_at is
  'Zeitpunkt, zu dem die meta_*-Zuordnung gesetzt wurde.';

-- ---------------------------------------------------------------------------
-- 2. Namen vergleichbar machen (URL-kodierte UTM-Werte wie Raus+aus+Deutschland)
-- ---------------------------------------------------------------------------

create or replace function public.werbe_name_norm(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(
           lower(btrim(regexp_replace(
             replace(replace(coalesce(p, ''), '+', ' '), '%20', ' '),
             '\s+', ' ', 'g'))),
           '')
$$;

comment on function public.werbe_name_norm(text) is
  'Werbemanager: Kampagnen-/Anzeigennamen vergleichbar machen (+ und %20 als Leerzeichen, Mehrfach-Leerzeichen, Groß-/Kleinschreibung).';

-- ---------------------------------------------------------------------------
-- 3. Interner Auflöser für einen Lead
-- ---------------------------------------------------------------------------

create or replace function public.werbe_lead_aufloesen(
  p_meta_ad_id       text,
  p_meta_adset_id    text,
  p_meta_campaign_id text,
  p_utm_term         text,
  p_utm_content      text,
  p_utm_campaign     text,
  out o_ad_id        text,
  out o_adset_id     text,
  out o_campaign_id  text,
  out o_methode      text
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_col_ad     text := nullif(btrim(p_meta_ad_id), '');
  v_col_adset  text := nullif(btrim(p_meta_adset_id), '');
  v_col_kamp   text := nullif(btrim(p_meta_campaign_id), '');
  v_term       text := nullif(btrim(p_utm_term), '');
  v_content    text := nullif(btrim(p_utm_content), '');
  v_kamp_roh   text := nullif(btrim(p_utm_campaign), '');
  v_ad         text;
  v_adset      text;
  v_kamp       text;
  v_methode    text;
  v_map        jsonb;
  v_name       text;
  v_term_name  text;
  v_anzahl     integer;
  v_treffer    text;
begin
  -- a) Feste Spalten: meta_ad_id ist ein Fakt, Rest aus dem Katalog ergänzen.
  if v_col_ad is not null then
    select c.adset_id, c.campaign_id
      into v_adset, v_kamp
      from public.ad_catalog c
     where c.platform = 'meta' and c.ad_id = v_col_ad
     limit 1;
    o_ad_id       := v_col_ad;
    o_adset_id    := coalesce(v_col_adset, v_adset);
    o_campaign_id := coalesce(v_col_kamp, v_kamp);
    o_methode     := 'spalten';
    return;
  end if;

  -- b) utm_term = ad_id (Sofortformular-Leads aus meta-leads-sync)
  if v_term ~ '^[0-9]{10,20}$' then
    select c.ad_id, c.adset_id, c.campaign_id
      into v_ad, v_adset, v_kamp
      from public.ad_catalog c
     where c.platform = 'meta' and c.ad_id = v_term
     limit 1;
    if v_ad is not null then
      v_methode := 'utm_term';
    end if;
  end if;

  -- c) utm_content = ad_id (Standard-Schema utm_content={{ad.id}})
  if v_ad is null and v_content ~ '^[0-9]{10,20}$' then
    select c.ad_id, c.adset_id, c.campaign_id
      into v_ad, v_adset, v_kamp
      from public.ad_catalog c
     where c.platform = 'meta' and c.ad_id = v_content
     limit 1;
    if v_ad is not null then
      v_methode := 'utm_content';
    end if;
  end if;

  if v_ad is not null then
    o_ad_id       := v_ad;
    o_adset_id    := coalesce(v_col_adset, v_adset);
    o_campaign_id := coalesce(v_col_kamp, v_kamp);
    o_methode     := v_methode;
    return;
  end if;

  -- d) utm_term = adset_id (Standard-Schema utm_term={{adset.id}})
  v_adset := null;
  v_kamp  := null;
  if v_term ~ '^[0-9]{10,20}$' then
    select c.adset_id, c.campaign_id
      into v_adset, v_kamp
      from public.ad_catalog c
     where c.platform = 'meta' and c.adset_id = v_term
     limit 1;
    if v_adset is null then
      select s.adset_id, s.campaign_id
        into v_adset, v_kamp
        from public.meta_adsets s
       where s.adset_id = v_term
       limit 1;
    end if;
    if v_adset is not null then
      v_methode := 'utm_term';
    end if;
  end if;

  -- e) Kampagne: Spalte, numerische utm_campaign, Zuordnungstabelle, Name
  v_kamp := coalesce(v_col_kamp, v_kamp);
  if v_kamp is null and v_kamp_roh ~ '^[0-9]{10,20}$' then
    select c.campaign_id into v_kamp
      from public.ad_catalog c
     where c.platform = 'meta' and c.campaign_id = v_kamp_roh
     limit 1;
    if v_kamp is null then
      select m.campaign_id into v_kamp
        from public.meta_campaigns m
       where m.campaign_id = v_kamp_roh
       limit 1;
    end if;
    if v_kamp is not null then
      v_methode := coalesce(v_methode, 'utm_campaign');
    end if;
  end if;

  if v_kamp is null and v_kamp_roh is not null then
    select s.utm_campaign_map into v_map
      from public.ad_settings s
     where s.id = 'default';
    if v_map is not null and jsonb_typeof(v_map) = 'object' then
      v_kamp := nullif(btrim(coalesce(
                  v_map ->> v_kamp_roh,
                  v_map ->> replace(v_kamp_roh, '+', ' '))), '');
    end if;
    if v_kamp is null then
      select count(distinct c.campaign_id), min(c.campaign_id)
        into v_anzahl, v_treffer
        from public.ad_catalog c
       where c.platform = 'meta'
         and public.werbe_name_norm(c.campaign_name) = public.werbe_name_norm(v_kamp_roh);
      if v_anzahl = 1 then
        v_kamp := v_treffer;
      end if;
    end if;
    if v_kamp is not null then
      v_methode := coalesce(v_methode, 'utm_campaign');
    end if;
  end if;

  -- f) Anzeigenname aus utm_content, nur eindeutig
  v_name := public.werbe_name_norm(v_content);
  if v_name is not null and v_content !~ '^[0-9]{10,20}$' then
    select count(*), min(c.ad_id)
      into v_anzahl, v_treffer
      from public.ad_catalog c
     where c.platform = 'meta'
       and public.werbe_name_norm(c.ad_name) = v_name
       and (v_kamp is null or c.campaign_id = v_kamp)
       and (coalesce(v_col_adset, v_adset) is null
            or c.adset_id = coalesce(v_col_adset, v_adset));

    v_term_name := public.werbe_name_norm(v_term);
    if v_anzahl > 1 and v_term_name is not null and v_term !~ '^[0-9]{10,20}$' then
      select count(*), min(c.ad_id)
        into v_anzahl, v_treffer
        from public.ad_catalog c
       where c.platform = 'meta'
         and public.werbe_name_norm(c.ad_name) = v_name
         and (v_kamp is null or c.campaign_id = v_kamp)
         and public.werbe_name_norm(c.adset_name) = v_term_name;
    end if;

    if v_anzahl = 1 then
      select c.ad_id, c.adset_id, c.campaign_id
        into o_ad_id, o_adset_id, o_campaign_id
        from public.ad_catalog c
       where c.platform = 'meta' and c.ad_id = v_treffer
       limit 1;
      o_adset_id    := coalesce(v_col_adset, o_adset_id);
      o_campaign_id := coalesce(v_col_kamp, o_campaign_id);
      o_methode     := 'name';
      return;
    end if;
  end if;

  -- Ohne Anzeige: was an Anzeigengruppe/Kampagne gefunden wurde.
  o_ad_id       := null;
  o_adset_id    := coalesce(v_col_adset, v_adset);
  o_campaign_id := v_kamp;
  o_methode     := case
                     when v_col_adset is not null or v_col_kamp is not null then 'spalten'
                     when o_adset_id is not null or o_campaign_id is not null then coalesce(v_methode, 'utm_campaign')
                     else 'keine'
                   end;
  return;
end;
$$;

comment on function public.werbe_lead_aufloesen(text, text, text, text, text, text) is
  'Werbemanager intern: löst einen Lead auf Meta-Anzeige/-Anzeigengruppe/-Kampagne auf (Spalten, numerische UTMs, Zuordnungstabelle, eindeutiger Name). Nur Service-Role und Definer-Funktionen.';

revoke all on function public.werbe_lead_aufloesen(text, text, text, text, text, text) from public;
revoke all on function public.werbe_lead_aufloesen(text, text, text, text, text, text) from anon, authenticated;
grant execute on function public.werbe_lead_aufloesen(text, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. ads_lead_attribution: Zuordnung je Meta-Lead für die Oberfläche
-- ---------------------------------------------------------------------------

create or replace function public.ads_lead_attribution(p_since timestamptz)
returns table (
  lead_id          uuid,
  meta_ad_id       text,
  meta_adset_id    text,
  meta_campaign_id text,
  methode          text,
  meta_leadgen_id  text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_darf boolean;
begin
  -- Gleicher Kreis wie die RLS für Meta-Daten, dazu Service-Role bzw.
  -- SQL-Editor (auth.uid() leer und keine Browser-Rolle). Sonst leere Liste.
  v_darf := coalesce((select public.current_user_has_perm('werbung')), false)
            or coalesce((select public.current_user_has_perm('werbung_meta')), false)
            or ((select auth.uid()) is null
                and coalesce((select auth.role()), '') not in ('anon', 'authenticated'));
  if not v_darf then
    return;
  end if;

  if p_since is null then
    raise exception 'p_since fehlt'
      using errcode = '22004';
  end if;

  return query
  select l.id,
         r.o_ad_id,
         r.o_adset_id,
         r.o_campaign_id,
         r.o_methode,
         l.meta_leadgen_id
    from public.leads l
    cross join lateral public.werbe_lead_aufloesen(
      l.meta_ad_id, l.meta_adset_id, l.meta_campaign_id,
      l.utm_term, l.utm_content, l.utm_campaign) r
   where l.created_at >= p_since
     and (
       lower(coalesce(l.utm_source, '')) in ('meta', 'facebook', 'fb', 'instagram', 'ig')
       or lower(coalesce(l.source, '')) in ('meta', 'meta_lead_form')
       or l.meta_leadgen_id is not null
       or l.fbc is not null
       or r.o_methode <> 'keine'
     )
   order by l.created_at desc
   limit 5000;
end;
$$;

comment on function public.ads_lead_attribution(timestamptz) is
  'Werbemanager: je Meta-Lead seit p_since die aufgelöste Anzeige, Anzeigengruppe, Kampagne und Methode (spalten, utm_term, utm_content, utm_campaign, name, keine). Ohne Werbe-Recht leere Liste. Höchstens 5000 Zeilen.';

revoke all on function public.ads_lead_attribution(timestamptz) from public;
revoke all on function public.ads_lead_attribution(timestamptz) from anon;
grant execute on function public.ads_lead_attribution(timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. ads_crm_attribution v2 (gleiche Signatur wie 20261001100000)
-- ---------------------------------------------------------------------------

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

  -- Lead-Filter unverändert gegenüber v1 (gleiche Zahlen wie der direkte
  -- Lesepfad im Frontend). Neu je Lead: utm_term und die aufgelösten Meta-IDs.
  with ld as (
    select l.id, l.utm_source, l.utm_campaign, l.utm_content, l.utm_term,
           l.quality_rating, l.created_at,
           r.o_ad_id, r.o_adset_id, r.o_campaign_id, r.o_methode
    from public.leads l
    cross join lateral public.werbe_lead_aufloesen(
      l.meta_ad_id, l.meta_adset_id, l.meta_campaign_id,
      l.utm_term, l.utm_content, l.utm_campaign) r
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
        'id',                ld.id,
        'utm_source',        ld.utm_source,
        'utm_campaign',      ld.utm_campaign,
        'utm_content',       ld.utm_content,
        'utm_term',          ld.utm_term,
        'quality_rating',    ld.quality_rating,
        'created_at',        ld.created_at,
        'meta_ad_id',        ld.o_ad_id,
        'meta_adset_id',     ld.o_adset_id,
        'meta_campaign_id',  ld.o_campaign_id,
        'meta_attr_methode', ld.o_methode))
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
  'Werbemanager: CRM-Zuordnung (Leads, Termine, Deals) ohne Personendaten für Werbe-Mitarbeiter ohne Pipeline-Recht. Audit F10-10. v2 (03.10.2026): je Lead zusätzlich utm_term und aufgelöste meta_ad_id, meta_adset_id, meta_campaign_id, meta_attr_methode.';

revoke execute on function public.ads_crm_attribution(timestamptz, text[]) from public;
revoke execute on function public.ads_crm_attribution(timestamptz, text[]) from anon;
grant  execute on function public.ads_crm_attribution(timestamptz, text[]) to authenticated;

notify pgrst, 'reload schema';

commit;
