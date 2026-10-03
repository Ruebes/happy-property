-- ─────────────────────────────────────────────────────────────────────────────
-- Werbemanager Autopilot: Qualitäts-Score in SQL (SPEC.md §2/§3, PLAN-B §2,
-- 05-automation-design §2). Stand 3.10.2026.
--
-- Funktionen:
--   werbe_lgamma(x)                    ln Gamma (Lanczos g=7, n=9)
--   werbe_gamma_p(a, x)                regularisierte untere unvollständige Gamma
--                                      P(a, x) (Reihe bzw. Kettenbruch).
--                                      P(CPTE > T) = werbe_gamma_p(alpha, beta / T)
--                                      p_good      = 1 - werbe_gamma_p(alpha, beta / Ziel)
--   werbe_kennung_basis(name, ad)      Basisname: Anzeigenname getrimmt ohne
--                                      _lang/_kurz (Groß/klein egal), leer -> ad_id
--   werbe_kennung(kampagne, name, ad)  Kennungs-ID = campaign_id || ':' || Basisname
--                                      (EINZIGE SQL-Quelle; TS-Spiegel
--                                      werbeMathe.kennungBasis/kennungId)
--   werbe_ist_meta_lead(...)           Meta-Herkunft (wie META_SOURCES im
--                                      AdsManager plus source meta/meta_lead_form,
--                                      fbc, fbp, Meta-Lead-ID). Für CAPI.
--   werbe_ist_intern_kontakt(...)      interne Person (wie _shared/internalContact.ts:
--                                      Profile admin/verwalter/mitarbeiter per
--                                      E-Mail, googlemail = gmail, zusätzlich deren
--                                      Telefon; intern markierte Einladungen per
--                                      E-Mail/Telefon)
--   werbe_te(...)                      Termin-Äquivalente eines Leads nach seinem
--                                      weitesten Zustand (Wertleiter)
--   werbe_qualitaet_berechnen(tag)     EINE serielle Funktion: schreibt
--                                      ad_quality_daily (Fenster 60/7/14/30/0,
--                                      Ebenen Anzeige/Kennung/Anzeigengruppe/
--                                      Kampagne/Konto), Schrumpfung von oben nach
--                                      unten, löscht Zeilen älter als 180 Tage.
--                                      EXECUTE nur service_role.
--   werbe_ev_kalibrieren()             Wertleiter aus echten Übergängen (180 Tage,
--                                      Leads mindestens 14 Tage alt), Beta-Binomial
--                                      mit n0 = 20 zum Start geschrumpft,
--                                      Mittel gebucht = 1. Änderung > 30 % nur als
--                                      Vorschlag. EXECUTE nur service_role.
--   werbe_ev_aktivieren(version)       Vorschlag übernehmen (nur Admin).
--
-- Micro-DB: alles seriell in einer Transaktion, Zeitfilter (Leads 400 Tage,
-- Spend 365 Tage), temporäre Tabellen (on commit drop), Advisory-Lock gegen
-- Doppelläufe. Keine parallelen Abfragen.
--
-- Voraussetzung: 20261003100000 (ad_insights_daily.campaign_id/adset_id,
-- platform_schedules, ad_settings.target_cpte_eur/utm_campaign_map),
-- 20261003101000 (leads.meta_*), 20261003110000 (Tabellen, Hilfsfunktionen).
-- Additiv, idempotent. Rückbau: rollback/20261003111000_werbe_qualitaet_funktionen.down.sql
-- ─────────────────────────────────────────────────────────────────────────────

begin;

set local lock_timeout = '5s';

do $chk$
declare
  v_fehlt text[] := '{}';
  r record;
begin
  for r in
    select * from (values
      ('leads', 'meta_ad_id'), ('leads', 'meta_adset_id'), ('leads', 'meta_campaign_id'), ('leads', 'meta_leadgen_id'),
      ('ad_insights_daily', 'campaign_id'), ('ad_insights_daily', 'adset_id'), ('ad_insights_daily', 'platform_schedules'),
      ('ad_settings', 'target_cpte_eur'), ('ad_settings', 'utm_campaign_map'),
      ('ad_quality_daily', 'leads_mit_anzeige'), ('ad_ev_weights', 'te_cap_per_lead')
    ) as t(tab, col)
  loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = r.tab and column_name = r.col) then
      v_fehlt := v_fehlt || (r.tab || '.' || r.col);
    end if;
  end loop;
  if coalesce(array_length(v_fehlt, 1), 0) > 0 then
    raise exception 'Vorher 20261003100000, 20261003101000 und 20261003110000 einspielen. Es fehlt: %',
      array_to_string(v_fehlt, ', ');
  end if;
end
$chk$;

-- ── Indizes für die serielle Berechnung ─────────────────────────────────────
create index if not exists ad_catalog_ad_name_idx
  on public.ad_catalog (ad_name);
create index if not exists funnel_sessions_lead_id_idx
  on public.funnel_sessions (lead_id) where lead_id is not null;
create index if not exists funnel_events_session_question_idx
  on public.funnel_events (session_id, question_key);

-- ── Mathematik ──────────────────────────────────────────────────────────────
create or replace function public.werbe_lgamma(x float8)
returns float8
language plpgsql
immutable
strict
parallel safe
set search_path = public, pg_temp
as $fn$
declare
  g constant float8[] := array[0.99999999999980993, 676.5203681218851, -1259.1392167224028,
                               771.32342877765313, -176.61502916214059, 12.507343278686905,
                               -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]::float8[];
  a float8;
  t float8;
  z float8;
  i int;
begin
  if x < 0.5 then
    return ln(pi() / abs(sin(pi() * x))) - public.werbe_lgamma(1 - x);
  end if;
  z := x - 1;
  a := g[1];
  t := z + 7.5;
  for i in 1..8 loop
    a := a + g[i + 1] / (z + i);
  end loop;
  return 0.5 * ln(2 * pi()) + (z + 0.5) * ln(t) - t + ln(a);
end
$fn$;

-- Regularisierte untere unvollständige Gammafunktion P(a, x) (Numerical Recipes
-- gser/gcf). exp() wird unter -700 nicht aufgerufen: PostgreSQL wirft bei
-- Unterlauf einen Fehler statt 0 zu liefern.
create or replace function public.werbe_gamma_p(a float8, x float8)
returns float8
language plpgsql
immutable
strict
parallel safe
set search_path = public, pg_temp
as $fn$
declare
  s     float8;
  t     float8;
  n     int := 1;
  b     float8;
  c     float8;
  d     float8;
  h     float8;
  an    float8;
  de    float8;
  i     int;
  v_exp float8;
begin
  if a <= 0 then
    return null;
  end if;
  if x <= 0 then
    return 0;
  end if;
  v_exp := -x + a * ln(x) - public.werbe_lgamma(a);

  if x < a + 1 then
    s := 1 / a;
    t := s;
    while abs(t) > 1e-14 * abs(s) and n < 1000 loop
      t := t * x / (a + n);
      s := s + t;
      n := n + 1;
    end loop;
    if v_exp < -700 then
      return 0;
    end if;
    return least(1::float8, s * exp(v_exp));
  end if;

  b := x + 1 - a;
  c := 1e300;
  d := 1 / b;
  h := d;
  for i in 1..500 loop
    an := -i * (i - a);
    b := b + 2;
    d := an * d + b;
    if abs(d) < 1e-300 then d := 1e-300; end if;
    c := b + an / c;
    if abs(c) < 1e-300 then c := 1e-300; end if;
    d := 1 / d;
    de := d * c;
    h := h * de;
    exit when abs(de - 1) < 1e-14;
  end loop;
  if v_exp < -700 then
    return 1;
  end if;
  return greatest(0::float8, 1 - exp(v_exp) * h);
end
$fn$;

-- ── Lead-Merkmale ───────────────────────────────────────────────────────────
-- Kennung (Werbemittel-Ebene). Basisname = Anzeigenname getrimmt, Suffix
-- _lang/_kurz (Groß/klein egal) entfernt; leer -> ad_id (werbeMathe.kennungBasis).
-- Kennungs-ID = campaign_id || ':' || Basisname (werbeMathe.kennungId); Kampagne
-- NULL ergibt NULL (Aufrufer setzen dann 'unbekannt' ein). Jede Kennung in SQL
-- kommt aus diesen beiden Funktionen.
create or replace function public.werbe_kennung_basis(p_ad_name text, p_ad_id text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(nullif(regexp_replace(btrim(coalesce(p_ad_name, '')), '_(lang|kurz)$', '', 'i'), ''), p_ad_id)
$$;

create or replace function public.werbe_kennung(p_campaign_id text, p_ad_name text, p_ad_id text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select p_campaign_id || ':' || public.werbe_kennung_basis(p_ad_name, p_ad_id)
$$;

-- Meta-Herkunft. Quellenliste wie META_SOURCES (AdsManager.tsx) und
-- ads_crm_attribution, plus source meta/meta_lead_form (Sofortformular ohne UTM),
-- fbc/fbp und Meta-Lead-ID (SPEC §3 CAPI-Filter).
create or replace function public.werbe_ist_meta_lead(
  p_utm_source      text,
  p_source          text,
  p_fbc             text,
  p_fbp             text,
  p_meta_leadgen_id text
)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select lower(btrim(coalesce(p_utm_source, ''))) in ('meta', 'facebook', 'fb', 'instagram', 'ig')
      or lower(btrim(coalesce(p_source, ''))) in ('meta', 'meta_lead_form')
      or nullif(btrim(coalesce(p_fbc, '')), '') is not null
      or nullif(btrim(coalesce(p_fbp, '')), '') is not null
      or nullif(btrim(coalesce(p_meta_leadgen_id, '')), '') is not null
$$;

-- Interne Person (Sven, Verwaltung, Mitarbeitende, intern markierte Einladungen).
-- Nachbau von isInternalContact (_shared/internalContact.ts) plus Telefon der
-- internen Profile (Svens Tests laufen über seine eigene Nummer).
create or replace function public.werbe_ist_intern_kontakt(p_email text, p_phone text, p_whatsapp text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with k as (
    select nullif(regexp_replace(lower(btrim(coalesce(p_email, ''))), '@googlemail\.com$', '@gmail.com'), '') as mail,
           nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '')    as tel1,
           nullif(regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g'), '') as tel2
  )
  select exists (
           select 1 from public.profiles p, k
            where p.role in ('admin', 'verwalter', 'mitarbeiter')
              and (
                (k.mail is not null
                 and regexp_replace(lower(btrim(coalesce(p.email, ''))), '@googlemail\.com$', '@gmail.com') = k.mail)
                or (length(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g')) >= 6
                    and regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') in (k.tel1, k.tel2))
              ))
      or exists (
           select 1 from public.booking_invites b, k
            where b.internal
              and (
                (k.mail is not null
                 and regexp_replace(lower(btrim(coalesce(b.guest_email, ''))), '@googlemail\.com$', '@gmail.com') = k.mail)
                or (length(regexp_replace(coalesce(b.guest_phone, ''), '\D', '', 'g')) >= 6
                    and regexp_replace(coalesce(b.guest_phone, ''), '\D', '', 'g') in (k.tel1, k.tel2))
              ))
$$;

-- Termin-Äquivalente eines Leads (Wertleiter, Schlüssel wie ad_ev_weights.weights):
--   spam 0; Sale: Provision / ev_ref (gedeckelt, sonst Deckel wenn unbekannt);
--   gut; schlecht (mit Termin / ohne Termin); gehalten; no_show;
--   gebucht (Kapitalbasis Ja / sonst); Lead (Ja / Nein / ohne Antwort) und nach
--   alt_tage (Standard 7) ohne Buchung mal alt_faktor.
-- p_sale_eur NULL = kein Sale; 0 = Sale ohne bekannte Provision.
-- p_kap: 'ja' | 'nein' | NULL (keine Funnel-Antwort).
create or replace function public.werbe_te(
  p_w          jsonb,
  p_kap        text,
  p_alter_tage numeric,
  p_gebucht    boolean,
  p_no_show    boolean,
  p_gehalten   boolean,
  p_rating     text,
  p_sale_eur   numeric,
  p_ev_ref     numeric,
  p_spam       boolean,
  p_capped     boolean
)
returns numeric
language plpgsql
immutable
parallel safe
set search_path = public, pg_temp
as $fn$
declare
  w     jsonb := coalesce(p_w, '{}'::jsonb);
  v_cap numeric := coalesce((w ->> 'te_cap')::numeric, 6);
  v_kap text := lower(btrim(coalesce(p_kap, '')));
  v_te  numeric;
begin
  if coalesce(p_spam, false) then
    return 0;
  end if;

  if p_sale_eur is not null then
    if p_ev_ref is not null and p_ev_ref > 0 and p_sale_eur > 0 then
      v_te := p_sale_eur / p_ev_ref;
    else
      v_te := v_cap;
    end if;
  elsif p_rating = 'gut' then
    v_te := coalesce((w ->> 'gut')::numeric, 4.0);
  elsif p_rating = 'schlecht' then
    if coalesce(p_gebucht, false) or coalesce(p_gehalten, false) or coalesce(p_no_show, false) then
      v_te := coalesce((w ->> 'schlecht_mit_termin')::numeric, 0.2);
    else
      v_te := coalesce((w ->> 'schlecht_ohne_termin')::numeric, 0.02);
    end if;
  elsif coalesce(p_gehalten, false) then
    v_te := coalesce((w ->> 'gehalten')::numeric, 1.6);
  elsif coalesce(p_no_show, false) then
    v_te := coalesce((w ->> 'no_show')::numeric, 0.3);
  elsif coalesce(p_gebucht, false) then
    if v_kap = 'ja' then
      v_te := coalesce((w ->> 'gebucht_kap_ja')::numeric, 1.2);
    else
      v_te := coalesce((w ->> 'gebucht')::numeric, 0.8);
    end if;
  else
    if v_kap = 'ja' then
      v_te := coalesce((w ->> 'lead_kap_ja')::numeric, 0.20);
    elsif v_kap = 'nein' then
      v_te := coalesce((w ->> 'lead_kap_nein')::numeric, 0.05);
    else
      v_te := coalesce((w ->> 'lead_ohne')::numeric, 0.08);
    end if;
    if coalesce(p_alter_tage, 0) > coalesce((w ->> 'alt_tage')::numeric, 7) then
      v_te := v_te * coalesce((w ->> 'alt_faktor')::numeric, 0.25);
    end if;
  end if;

  if coalesce(p_capped, true) then
    v_te := least(v_te, v_cap);
  end if;
  return v_te;
end
$fn$;

-- ── Tägliche Berechnung ─────────────────────────────────────────────────────
-- p_stichtag: letzter Tag der Fenster (Konto-Zeitzone Europe/Berlin). Standard
-- gestern (Berlin), weil der laufende Tag noch keinen vollständigen Spend hat.
-- Leads zählen nach Erstellungsdatum (Berlin) im Fenster, Spend nach Insights-Tag.
-- Zuordnung Lead -> Anzeige (wie ads_lead_attribution, hier inline):
--   1. leads.meta_ad_id/meta_adset_id/meta_campaign_id
--   2. numerische utm_term/utm_content = ad_id (Formular: utm_term = Anzeige;
--      Studio-Schema: utm_content = Anzeige)
--   3. numerische utm_term/utm_content = adset_id, utm_campaign = campaign_id
--   4. Kampagne über ad_settings.utm_campaign_map {utm_campaign: campaign_id} oder
--      eindeutigen Kampagnennamen; Anzeigenname (utm_content) eindeutig in dieser
--      Kampagne, ohne Kampagne eindeutig im ganzen Katalog
--   Leads ohne Anzeige zählen nur für Anzeigengruppe/Kampagne/Konto.
-- Meta-Herkunft hier OHNE fbp: das Pixel-Cookie setzt der Funnel bei jedem
-- Besucher (auch Google/organisch); als Herkunftsnachweis zählt es nicht.
-- Zuordnungsquote: Konto/Kampagne = Anteil Meta-Leads mit Anzeige; Anzeige/
-- Kennung/Anzeigengruppe übernehmen die Quote ihrer Kampagne (sonst Konto).
-- Schrumpfung: alpha = a0 + TE, beta = a0 * Prior + Spend; Prior = cpte_hat
-- (60 Tage) der Elternebene: Konto (Ziel) -> Kampagne -> Anzeigengruppe und
-- Kennung -> Anzeige (Elternteil Kennung).
create or replace function public.werbe_qualitaet_berechnen(p_stichtag date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set client_min_messages = warning
as $fn$
declare
  t0           timestamptz := clock_timestamp();
  v_tag        date := coalesce(p_stichtag, (now() at time zone 'Europe/Berlin')::date - 1);
  v_bis        timestamptz;
  v_lead_von   timestamptz;
  v_spend_von  date;
  v_target     numeric;
  v_map        jsonb;
  v_k3         jsonb;
  v_kf         numeric;
  v_a0         numeric;
  v_w          jsonb;
  v_ev_version int;
  v_ev_ref     numeric;
  v_cap        numeric;
  v_konto      text;
  v_f          int;
  v_von        date;
  v_acc60      numeric;
  v_zeilen     int := 0;
  v_veraltet   int := 0;
  v_purge      int := 0;
  v_cov14      numeric;
  v_leads      int;
begin
  if not pg_try_advisory_xact_lock(hashtext('werbe_qualitaet_berechnen')) then
    return jsonb_build_object('success', false, 'uebersprungen', true, 'grund', 'laeuft_bereits');
  end if;

  v_bis       := ((v_tag + 1)::timestamp at time zone 'Europe/Berlin');
  v_lead_von  := v_bis - interval '400 days';
  v_spend_von := v_tag - 364;

  -- Einstellungen, Parameter, Wertleiter
  select s.target_cpte_eur, s.utm_campaign_map into v_target, v_map
    from public.ad_settings s where s.id = 'default';
  v_target := coalesce(nullif(v_target, 0), 145);
  v_map := case when jsonb_typeof(v_map) = 'object' then v_map else '{}'::jsonb end;

  select r.params into v_k3 from public.ad_autopilot_rules r where r.rule_key = 'K3';
  v_kf := coalesce((v_k3 ->> 'kill_factor')::numeric, 2.0);
  v_a0 := coalesce((v_k3 ->> 'prior_strength_te')::numeric, 1.5);
  if v_kf <= 0 then v_kf := 2.0; end if;
  if v_a0 <= 0 then v_a0 := 1.5; end if;

  select e.version, e.weights, e.ev_ref_eur, e.te_cap_per_lead
    into v_ev_version, v_w, v_ev_ref, v_cap
    from public.ad_ev_weights e where e.status = 'aktiv'
   order by e.version desc limit 1;
  if v_w is null then
    v_w := '{"lead_kap_nein":0.05,"lead_kap_ja":0.20,"lead_ohne":0.08,"alt_faktor":0.25,"gebucht":0.8,"gebucht_kap_ja":1.2,"no_show":0.3,"gehalten":1.6,"schlecht_mit_termin":0.2,"schlecht_ohne_termin":0.02,"gut":4.0,"te_cap":6}'::jsonb;
    v_ev_version := null;
  end if;
  v_w := v_w || jsonb_build_object('te_cap', coalesce(v_cap, (v_w ->> 'te_cap')::numeric, 6));

  select c.account_id into v_konto
    from public.ad_catalog c where c.platform = 'meta'
   group by c.account_id order by count(*) desc limit 1;
  v_konto := coalesce(v_konto, 'konto');

  -- ── Katalog ───────────────────────────────────────────────────────────────
  drop table if exists _wq_kat;
  create temp table _wq_kat (
    ad_id         text primary key,
    adset_id      text,
    campaign_id   text,
    ad_name       text,
    adset_name    text,
    campaign_name text,
    kennung_name  text,
    kennung       text
  ) on commit drop;
  insert into _wq_kat (ad_id, adset_id, campaign_id, ad_name, adset_name, campaign_name, kennung_name, kennung)
  select k.ad_id, k.adset_id, k.campaign_id, k.ad_name, k.adset_name, k.campaign_name,
         public.werbe_kennung_basis(k.ad_name, k.ad_id),
         public.werbe_kennung(k.campaign_id, k.ad_name, k.ad_id)
    from (
      select distinct on (c.ad_id)
             c.ad_id, c.adset_id, c.campaign_id, c.ad_name, c.adset_name, c.campaign_name
        from public.ad_catalog c
       where c.platform = 'meta'
       order by c.ad_id, c.updated_at desc nulls last
    ) k;

  -- ── Meta-Leads (400 Tage, ohne interne Kontakte) ──────────────────────────
  drop table if exists _wq_leads;
  create temp table _wq_leads (
    lead_id       uuid primary key,
    created_at    timestamptz not null,
    tag           date not null,
    utm_term      text,
    utm_content   text,
    utm_campaign  text,
    m_ad          text,
    m_adset       text,
    m_campaign    text,
    rating        text,
    ad_id         text,
    adset_id      text,
    campaign_id   text,
    kennung       text,
    methode       text,
    kand_campaign text,
    kap           text,
    gebucht       boolean not null default false,
    gehalten      boolean not null default false,
    no_show       boolean not null default false,
    sale_eur      numeric,
    te_capped     numeric not null default 0,
    te_full       numeric not null default 0
  ) on commit drop;
  insert into _wq_leads (lead_id, created_at, tag, utm_term, utm_content, utm_campaign, m_ad, m_adset, m_campaign, rating)
  select l.id,
         l.created_at,
         (l.created_at at time zone 'Europe/Berlin')::date,
         nullif(btrim(l.utm_term), ''),
         nullif(btrim(l.utm_content), ''),
         nullif(btrim(l.utm_campaign), ''),
         nullif(btrim(l.meta_ad_id::text), ''),
         nullif(btrim(l.meta_adset_id::text), ''),
         nullif(btrim(l.meta_campaign_id::text), ''),
         case when l.quality_rated_at is null or l.quality_rated_at < v_bis then l.quality_rating end
    from public.leads l
   where l.created_at >= v_lead_von
     and l.created_at <  v_bis
     and (public.werbe_ist_meta_lead(l.utm_source, l.source::text, l.fbc, null, l.meta_leadgen_id::text)
          or l.meta_ad_id is not null or l.meta_adset_id is not null or l.meta_campaign_id is not null)
     and not public.werbe_ist_intern_kontakt(l.email, l.phone, l.whatsapp);

  -- ── Zuordnung ─────────────────────────────────────────────────────────────
  -- 1. Spalten (meta-leads-sync, Backfill). Nur mit Anzeige gilt der Lead als
  --    fertig zugeordnet; nur Gruppe/Kampagne: weiter mit UTM nach der Anzeige suchen.
  update _wq_leads
     set ad_id = m_ad, adset_id = m_adset, campaign_id = m_campaign, methode = 'spalten'
   where m_ad is not null;
  update _wq_leads
     set adset_id = m_adset, campaign_id = m_campaign
   where m_ad is null and (m_adset is not null or m_campaign is not null);

  -- 2. numerische UTM = Anzeigen-ID
  update _wq_leads w set ad_id = k.ad_id, methode = 'utm_term'
    from _wq_kat k
   where w.methode is null and w.utm_term ~ '^[0-9]{6,}$' and k.ad_id = w.utm_term;
  update _wq_leads w set ad_id = k.ad_id, methode = 'utm_content'
    from _wq_kat k
   where w.methode is null and w.utm_content ~ '^[0-9]{6,}$' and k.ad_id = w.utm_content;

  -- 3. numerische UTM = Anzeigengruppen- bzw. Kampagnen-ID
  update _wq_leads w set adset_id = k.adset_id, campaign_id = k.campaign_id, methode = 'utm_adset'
    from (select adset_id, min(campaign_id) as campaign_id from _wq_kat where adset_id is not null group by adset_id) k
   where w.methode is null and w.adset_id is null
     and ((w.utm_term ~ '^[0-9]{6,}$' and k.adset_id = w.utm_term)
          or (w.utm_content ~ '^[0-9]{6,}$' and k.adset_id = w.utm_content));
  update _wq_leads w set campaign_id = k.campaign_id, methode = 'utm_campaign'
    from (select distinct campaign_id from _wq_kat) k
   where w.methode is null and w.campaign_id is null
     and w.utm_campaign ~ '^[0-9]{6,}$' and k.campaign_id = w.utm_campaign;

  -- 4. Namen: Kampagne aus Spalten, Map oder eindeutigem Namen, dann eindeutiger Anzeigenname
  update _wq_leads set kand_campaign = campaign_id
   where methode is null and campaign_id is not null;
  update _wq_leads w
     set kand_campaign = coalesce(v_map ->> w.utm_campaign,
                                  v_map ->> btrim(replace(replace(w.utm_campaign, '+', ' '), '%20', ' ')))
   where w.methode is null and w.kand_campaign is null and w.utm_campaign is not null;
  update _wq_leads w set kand_campaign = k.campaign_id
    from (select lower(btrim(campaign_name)) as n, min(campaign_id) as campaign_id
            from _wq_kat where campaign_name is not null
           group by lower(btrim(campaign_name))
          having count(distinct campaign_id) = 1) k
   where w.methode is null and w.kand_campaign is null and w.utm_campaign is not null
     and k.n = lower(btrim(replace(replace(w.utm_campaign, '+', ' '), '%20', ' ')));
  update _wq_leads w set ad_id = k.ad_id, methode = 'name_kampagne'
    from (select campaign_id, lower(btrim(ad_name)) as n, min(ad_id) as ad_id
            from _wq_kat where ad_name is not null
           group by campaign_id, lower(btrim(ad_name))
          having count(*) = 1) k
   where w.methode is null and w.kand_campaign is not null and w.utm_content is not null
     and k.campaign_id = w.kand_campaign
     and k.n = lower(btrim(replace(replace(w.utm_content, '+', ' '), '%20', ' ')));
  update _wq_leads w set ad_id = k.ad_id, methode = 'name'
    from (select lower(btrim(ad_name)) as n, min(ad_id) as ad_id
            from _wq_kat where ad_name is not null
           group by lower(btrim(ad_name))
          having count(*) = 1) k
   where w.methode is null and w.kand_campaign is null and w.utm_content is not null
     and k.n = lower(btrim(replace(replace(w.utm_content, '+', ' '), '%20', ' ')));
  update _wq_leads
     set campaign_id = coalesce(campaign_id, kand_campaign),
         methode     = case when campaign_id is not null or adset_id is not null then 'spalten_gruppe'
                            else 'kampagne_name' end
   where methode is null and (kand_campaign is not null or campaign_id is not null or adset_id is not null);

  -- Eltern einer Anzeige kommen aus dem Katalog (Wahrheit), Kennung setzen
  update _wq_leads w
     set adset_id    = coalesce(k.adset_id, w.adset_id),
         campaign_id = coalesce(k.campaign_id, w.campaign_id),
         kennung     = k.kennung
    from _wq_kat k
   where w.ad_id is not null and k.ad_id = w.ad_id;
  update _wq_leads w set campaign_id = k.campaign_id
    from (select adset_id, min(campaign_id) as campaign_id from _wq_kat where adset_id is not null group by adset_id) k
   where w.campaign_id is null and w.adset_id is not null and k.adset_id = w.adset_id;
  update _wq_leads
     set kennung = public.werbe_kennung(coalesce(campaign_id, 'unbekannt'), null, ad_id)
   where ad_id is not null and kennung is null;

  -- ── Kapitalbasis (letzte Antwort je Lead) ─────────────────────────────────
  update _wq_leads w
     set kap = case when f.ans in ('ja', 'yes') then 'ja' else 'nein' end
    from (
      select distinct on (s.lead_id) s.lead_id, lower(btrim(e.answer)) as ans
        from public.funnel_sessions s
        join public.funnel_events e on e.session_id = s.id
       where s.lead_id in (select lead_id from _wq_leads)
         and e.question_key = 'kapitalbasis'
         and coalesce(btrim(e.answer), '') <> ''
         and e.created_at >= v_lead_von - interval '30 days'
         and e.created_at <  v_bis
       order by s.lead_id, e.created_at desc
    ) f
   where f.lead_id = w.lead_id;

  -- ── Termine (Kundentermine, keine internen, keine Sperren) ────────────────
  update _wq_leads w
     set gebucht  = true,
         gehalten = coalesce(a.gehalten, false),
         no_show  = (not coalesce(a.gehalten, false)) and coalesce(a.letzter = 'no_show', false)
    from (
      select a.lead_id,
             bool_or(a.outcome = 'completed') as gehalten,
             (array_agg(a.outcome order by a.start_time desc))[1] as letzter
        from public.crm_appointments a
       where a.lead_id in (select lead_id from _wq_leads)
         and a.internal = false
         and a.kind = 'appointment'
         and a.created_at >= v_lead_von
         and a.created_at <  v_bis
       group by a.lead_id
    ) a
   where a.lead_id = w.lead_id;

  -- ── Sales (Anzahlung/Provision; Stand heute) ──────────────────────────────
  update _wq_leads w set sale_eur = d.provision
    from (
      select d.lead_id, coalesce(sum(d.commission_amount) filter (where d.commission_amount > 0), 0) as provision
        from public.deals d
       where d.lead_id in (select lead_id from _wq_leads)
         and (d.phase in ('anzahlung', 'provision_erhalten')
              or d.archived_from_phase in ('anzahlung', 'provision_erhalten')
              or d.deposit_paid_at is not null
              or d.commission_paid_at is not null)
       group by d.lead_id
    ) d
   where d.lead_id = w.lead_id;

  -- ── TE je Lead ────────────────────────────────────────────────────────────
  update _wq_leads w
     set te_capped = public.werbe_te(v_w, w.kap, (extract(epoch from (v_bis - w.created_at)) / 86400.0)::numeric,
                                     w.gebucht, w.no_show, w.gehalten, w.rating, w.sale_eur, v_ev_ref, false, true),
         te_full   = public.werbe_te(v_w, w.kap, (extract(epoch from (v_bis - w.created_at)) / 86400.0)::numeric,
                                     w.gebucht, w.no_show, w.gehalten, w.rating, w.sale_eur, v_ev_ref, false, false);

  -- ── Spend (365 Tage) ──────────────────────────────────────────────────────
  drop table if exists _wq_spend;
  create temp table _wq_spend (
    day            date not null,
    ad_id          text not null,
    adset_id       text,
    campaign_id    text,
    kennung        text not null,
    spend_eur      numeric not null,
    impressions    bigint not null,
    link_clicks    bigint not null,
    lpv            bigint not null,
    meta_schedules int not null
  ) on commit drop;
  insert into _wq_spend (day, ad_id, adset_id, campaign_id, kennung, spend_eur, impressions, link_clicks, lpv, meta_schedules)
  select d.day,
         d.ad_id,
         coalesce(nullif(d.adset_id::text, ''), k.adset_id),
         coalesce(nullif(d.campaign_id::text, ''), k.campaign_id),
         coalesce(k.kennung, public.werbe_kennung(coalesce(nullif(d.campaign_id::text, ''), 'unbekannt'), null, d.ad_id)),
         coalesce(d.spend_eur, 0),
         coalesce(d.impressions, 0),
         coalesce(d.link_clicks, 0),
         coalesce(d.landing_page_views, 0),
         coalesce(d.platform_schedules, 0)
    from public.ad_insights_daily d
    left join _wq_kat k on k.ad_id = d.ad_id
   where d.platform = 'meta'
     and d.day between v_spend_von and v_tag;

  -- ── Aggregation je Fenster und Ebene ──────────────────────────────────────
  drop table if exists _wq_q;
  create temp table _wq_q (
    fenster              smallint not null,
    entity_level         text not null,
    entity_id            text not null,
    parent_id            text,
    campaign_id          text,
    name                 text,
    spend_eur            numeric not null default 0,
    impressions          bigint not null default 0,
    link_clicks          bigint not null default 0,
    lpv                  bigint not null default 0,
    meta_schedules       int not null default 0,
    leads                int not null default 0,
    leads_kap_ja         int not null default 0,
    leads_mit_anzeige    int not null default 0,
    booked               int not null default 0,
    booked_kap_ja        int not null default 0,
    held                 int not null default 0,
    no_show              int not null default 0,
    rated_gut            int not null default 0,
    rated_schlecht       int not null default 0,
    sales                int not null default 0,
    te_capped            numeric not null default 0,
    te_full              numeric not null default 0,
    prior_cpte           numeric,
    alpha                numeric,
    beta                 numeric,
    cpte_hat             numeric,
    p_bad                numeric,
    p_good               numeric,
    kap_ja_share_booked  numeric,
    attribution_coverage numeric,
    primary key (fenster, entity_level, entity_id)
  ) on commit drop;

  foreach v_f in array array[60, 7, 14, 30, 0] loop
    v_von := case when v_f = 0 then v_tag - 364 else v_tag - (v_f - 1) end;

    insert into _wq_q (fenster, entity_level, entity_id, parent_id, campaign_id,
                       spend_eur, impressions, link_clicks, lpv, meta_schedules,
                       leads, leads_kap_ja, leads_mit_anzeige, booked, booked_kap_ja, held, no_show,
                       rated_gut, rated_schlecht, sales, te_capped, te_full)
    with s as (
      select * from _wq_spend where day between v_von and v_tag
    ), l as (
      select * from _wq_leads where tag between v_von and v_tag
    ), sa as (
      select 'ad'::text as lvl, s.ad_id as eid, max(s.kennung) as parent, max(s.campaign_id) as camp,
             sum(s.spend_eur) as spend, sum(s.impressions) as impr, sum(s.link_clicks) as clicks,
             sum(s.lpv) as lpv, sum(s.meta_schedules) as sched
        from s group by s.ad_id
      union all
      select 'kennung', s.kennung, max(s.campaign_id), max(s.campaign_id),
             sum(s.spend_eur), sum(s.impressions), sum(s.link_clicks), sum(s.lpv), sum(s.meta_schedules)
        from s group by s.kennung
      union all
      select 'adset', s.adset_id, max(s.campaign_id), max(s.campaign_id),
             sum(s.spend_eur), sum(s.impressions), sum(s.link_clicks), sum(s.lpv), sum(s.meta_schedules)
        from s where s.adset_id is not null group by s.adset_id
      union all
      select 'campaign', s.campaign_id, v_konto, s.campaign_id,
             sum(s.spend_eur), sum(s.impressions), sum(s.link_clicks), sum(s.lpv), sum(s.meta_schedules)
        from s where s.campaign_id is not null group by s.campaign_id
      union all
      select 'account', v_konto, null::text, null::text,
             sum(s.spend_eur), sum(s.impressions), sum(s.link_clicks), sum(s.lpv), sum(s.meta_schedules)
        from s having count(*) > 0
    ), la as (
      select 'ad'::text as lvl, l.ad_id as eid, max(l.kennung) as parent, max(l.campaign_id) as camp,
             count(*) as leads,
             count(*) filter (where l.kap = 'ja') as kap_ja,
             count(*) filter (where l.ad_id is not null) as mit_anzeige,
             count(*) filter (where l.gebucht) as booked,
             count(*) filter (where l.gebucht and l.kap = 'ja') as booked_ja,
             count(*) filter (where l.gehalten) as held,
             count(*) filter (where l.no_show) as no_show,
             count(*) filter (where l.rating = 'gut') as gut,
             count(*) filter (where l.rating = 'schlecht') as schlecht,
             count(*) filter (where l.sale_eur is not null) as sales,
             sum(l.te_capped) as te_c, sum(l.te_full) as te_f
        from l where l.ad_id is not null group by l.ad_id
      union all
      select 'kennung', l.kennung, max(l.campaign_id), max(l.campaign_id),
             count(*), count(*) filter (where l.kap = 'ja'), count(*) filter (where l.ad_id is not null),
             count(*) filter (where l.gebucht), count(*) filter (where l.gebucht and l.kap = 'ja'),
             count(*) filter (where l.gehalten), count(*) filter (where l.no_show),
             count(*) filter (where l.rating = 'gut'), count(*) filter (where l.rating = 'schlecht'),
             count(*) filter (where l.sale_eur is not null), sum(l.te_capped), sum(l.te_full)
        from l where l.kennung is not null group by l.kennung
      union all
      select 'adset', l.adset_id, max(l.campaign_id), max(l.campaign_id),
             count(*), count(*) filter (where l.kap = 'ja'), count(*) filter (where l.ad_id is not null),
             count(*) filter (where l.gebucht), count(*) filter (where l.gebucht and l.kap = 'ja'),
             count(*) filter (where l.gehalten), count(*) filter (where l.no_show),
             count(*) filter (where l.rating = 'gut'), count(*) filter (where l.rating = 'schlecht'),
             count(*) filter (where l.sale_eur is not null), sum(l.te_capped), sum(l.te_full)
        from l where l.adset_id is not null group by l.adset_id
      union all
      select 'campaign', l.campaign_id, v_konto, l.campaign_id,
             count(*), count(*) filter (where l.kap = 'ja'), count(*) filter (where l.ad_id is not null),
             count(*) filter (where l.gebucht), count(*) filter (where l.gebucht and l.kap = 'ja'),
             count(*) filter (where l.gehalten), count(*) filter (where l.no_show),
             count(*) filter (where l.rating = 'gut'), count(*) filter (where l.rating = 'schlecht'),
             count(*) filter (where l.sale_eur is not null), sum(l.te_capped), sum(l.te_full)
        from l where l.campaign_id is not null group by l.campaign_id
      union all
      select 'account', v_konto, null::text, null::text,
             count(*), count(*) filter (where l.kap = 'ja'), count(*) filter (where l.ad_id is not null),
             count(*) filter (where l.gebucht), count(*) filter (where l.gebucht and l.kap = 'ja'),
             count(*) filter (where l.gehalten), count(*) filter (where l.no_show),
             count(*) filter (where l.rating = 'gut'), count(*) filter (where l.rating = 'schlecht'),
             count(*) filter (where l.sale_eur is not null), sum(l.te_capped), sum(l.te_full)
        from l having count(*) > 0
    )
    select v_f,
           coalesce(sa.lvl, la.lvl),
           coalesce(sa.eid, la.eid),
           coalesce(sa.parent, la.parent),
           coalesce(sa.camp, la.camp),
           coalesce(sa.spend, 0), coalesce(sa.impr, 0), coalesce(sa.clicks, 0), coalesce(sa.lpv, 0), coalesce(sa.sched, 0),
           coalesce(la.leads, 0), coalesce(la.kap_ja, 0), coalesce(la.mit_anzeige, 0),
           coalesce(la.booked, 0), coalesce(la.booked_ja, 0), coalesce(la.held, 0), coalesce(la.no_show, 0),
           coalesce(la.gut, 0), coalesce(la.schlecht, 0), coalesce(la.sales, 0),
           round(coalesce(la.te_c, 0), 4), round(coalesce(la.te_f, 0), 4)
      from sa
      full join la on la.lvl = sa.lvl and la.eid = sa.eid
     where coalesce(sa.spend, 0) > 0 or coalesce(la.leads, 0) > 0;
  end loop;

  -- Namen
  update _wq_q q set name = k.ad_name
    from (select ad_id, max(ad_name) as ad_name from _wq_kat group by ad_id) k
   where q.entity_level = 'ad' and k.ad_id = q.entity_id;
  update _wq_q q set name = k.kennung_name
    from (select kennung, max(kennung_name) as kennung_name from _wq_kat group by kennung) k
   where q.entity_level = 'kennung' and k.kennung = q.entity_id;
  update _wq_q set name = substr(entity_id, strpos(entity_id, ':') + 1)
   where entity_level = 'kennung' and name is null;
  update _wq_q q set name = k.adset_name
    from (select adset_id, max(adset_name) as adset_name from _wq_kat where adset_id is not null group by adset_id) k
   where q.entity_level = 'adset' and k.adset_id = q.entity_id;
  update _wq_q q set name = k.campaign_name
    from (select campaign_id, max(campaign_name) as campaign_name from _wq_kat group by campaign_id) k
   where q.entity_level = 'campaign' and k.campaign_id = q.entity_id;
  update _wq_q set name = 'Werbekonto' where entity_level = 'account';

  -- Zuordnungsquote und Kapitalbasis-Anteil
  update _wq_q
     set attribution_coverage = case when leads > 0 then round(leads_mit_anzeige::numeric / leads, 4) end
   where entity_level in ('account', 'campaign');
  update _wq_q q
     set attribution_coverage = coalesce(
           (select c.attribution_coverage from _wq_q c
             where c.fenster = q.fenster and c.entity_level = 'campaign' and c.entity_id = q.campaign_id),
           (select a.attribution_coverage from _wq_q a
             where a.fenster = q.fenster and a.entity_level = 'account'))
   where q.entity_level in ('adset', 'kennung', 'ad');
  update _wq_q
     set kap_ja_share_booked = case when booked > 0 then round(booked_kap_ja::numeric / booked, 4) end;

  -- ── Schrumpfung von oben nach unten (Prior = cpte_hat 60 Tage der Eltern) ─
  update _wq_q set prior_cpte = v_target where entity_level = 'account';
  update _wq_q set alpha = v_a0 + te_capped, beta = v_a0 * prior_cpte + spend_eur where entity_level = 'account';
  select beta / alpha into v_acc60 from _wq_q where entity_level = 'account' and fenster = 60;
  v_acc60 := coalesce(v_acc60, v_target);

  update _wq_q set prior_cpte = v_acc60 where entity_level = 'campaign';
  update _wq_q set alpha = v_a0 + te_capped, beta = v_a0 * prior_cpte + spend_eur where entity_level = 'campaign';

  update _wq_q q
     set prior_cpte = coalesce(
           (select c.beta / c.alpha from _wq_q c
             where c.fenster = 60 and c.entity_level = 'campaign' and c.entity_id = q.campaign_id),
           v_acc60)
   where q.entity_level in ('adset', 'kennung');
  update _wq_q set alpha = v_a0 + te_capped, beta = v_a0 * prior_cpte + spend_eur
   where entity_level in ('adset', 'kennung');

  update _wq_q q
     set prior_cpte = coalesce(
           (select k.beta / k.alpha from _wq_q k
             where k.fenster = 60 and k.entity_level = 'kennung' and k.entity_id = q.parent_id),
           (select c.beta / c.alpha from _wq_q c
             where c.fenster = 60 and c.entity_level = 'campaign' and c.entity_id = q.campaign_id),
           v_acc60)
   where q.entity_level = 'ad';
  update _wq_q set alpha = v_a0 + te_capped, beta = v_a0 * prior_cpte + spend_eur where entity_level = 'ad';

  update _wq_q
     set prior_cpte = round(prior_cpte, 4),
         alpha      = round(alpha, 6),
         beta       = round(beta, 6),
         cpte_hat   = round(beta / alpha, 4),
         p_bad      = round(public.werbe_gamma_p(alpha::float8, (beta / (v_kf * v_target))::float8)::numeric, 6),
         p_good     = round((1 - public.werbe_gamma_p(alpha::float8, (beta / v_target)::float8))::numeric, 6);

  -- ── Schreiben (Upsert), Veraltetes des Stichtags entfernen, Purge ─────────
  insert into public.ad_quality_daily as t (
    stichtag, fenster, entity_level, entity_id, parent_id, campaign_id, name,
    spend_eur, impressions, link_clicks, lpv, meta_schedules,
    leads, leads_kap_ja, leads_mit_anzeige, booked, booked_kap_ja, held, no_show, rated_gut, rated_schlecht, sales,
    te_capped, te_full, prior_cpte, alpha, beta, cpte_hat, p_bad, p_good,
    kap_ja_share_booked, attribution_coverage, ev_version, berechnet_at)
  select v_tag, q.fenster, q.entity_level, q.entity_id, q.parent_id, q.campaign_id, q.name,
         round(q.spend_eur, 2), q.impressions, q.link_clicks, q.lpv, q.meta_schedules,
         q.leads, q.leads_kap_ja, q.leads_mit_anzeige, q.booked, q.booked_kap_ja, q.held, q.no_show,
         q.rated_gut, q.rated_schlecht, q.sales,
         q.te_capped, q.te_full, q.prior_cpte, q.alpha, q.beta, q.cpte_hat, q.p_bad, q.p_good,
         q.kap_ja_share_booked, q.attribution_coverage, v_ev_version, now()
    from _wq_q q
  on conflict (stichtag, fenster, entity_level, entity_id) do update set
    parent_id            = excluded.parent_id,
    campaign_id          = excluded.campaign_id,
    name                 = excluded.name,
    spend_eur            = excluded.spend_eur,
    impressions          = excluded.impressions,
    link_clicks          = excluded.link_clicks,
    lpv                  = excluded.lpv,
    meta_schedules       = excluded.meta_schedules,
    leads                = excluded.leads,
    leads_kap_ja         = excluded.leads_kap_ja,
    leads_mit_anzeige    = excluded.leads_mit_anzeige,
    booked               = excluded.booked,
    booked_kap_ja        = excluded.booked_kap_ja,
    held                 = excluded.held,
    no_show              = excluded.no_show,
    rated_gut            = excluded.rated_gut,
    rated_schlecht       = excluded.rated_schlecht,
    sales                = excluded.sales,
    te_capped            = excluded.te_capped,
    te_full              = excluded.te_full,
    prior_cpte           = excluded.prior_cpte,
    alpha                = excluded.alpha,
    beta                 = excluded.beta,
    cpte_hat             = excluded.cpte_hat,
    p_bad                = excluded.p_bad,
    p_good               = excluded.p_good,
    kap_ja_share_booked  = excluded.kap_ja_share_booked,
    attribution_coverage = excluded.attribution_coverage,
    ev_version           = excluded.ev_version,
    berechnet_at         = excluded.berechnet_at;
  get diagnostics v_zeilen = row_count;

  delete from public.ad_quality_daily t
   where t.stichtag = v_tag
     and not exists (select 1 from _wq_q q
                      where q.fenster = t.fenster and q.entity_level = t.entity_level and q.entity_id = t.entity_id);
  get diagnostics v_veraltet = row_count;

  delete from public.ad_quality_daily where stichtag < current_date - 180;
  get diagnostics v_purge = row_count;

  select q.attribution_coverage into v_cov14 from _wq_q q where q.entity_level = 'account' and q.fenster = 14;
  select count(*) into v_leads from _wq_leads;

  return jsonb_build_object(
    'success',           true,
    'stichtag',          v_tag,
    'zeilen',            v_zeilen,
    'veraltet_entfernt', v_veraltet,
    'purge',             v_purge,
    'ev_version',        v_ev_version,
    'coverage_14',       v_cov14,
    'meta_leads',        v_leads,
    'ziel_cpte_eur',     v_target,
    'dauer_ms',          round(extract(epoch from (clock_timestamp() - t0)) * 1000));
end
$fn$;

-- ── Wöchentliche Kalibrierung der Wertleiter ────────────────────────────────
-- Modell: aus den Startankern (gut, schlecht, no_show) und geschätzten
-- Übergangswahrscheinlichkeiten wird die Leiter neu gebaut:
--   gehalten  = p(gut | gehalten, bewertet) * gut + (1 - p) * schlecht_mit_termin
--   gebucht   = p(gehalten | gebucht, Kap) * gehalten + (1 - p) * no_show
--   Lead      = p(gebucht | Lead, Kap) * gebucht(Kap)
-- Jede Wahrscheinlichkeit: (x + n0 * p_start) / (n + n0), n0 = 20, p_start aus
-- der Start-Leiter (Version mit quelle 'start'). Danach Skalierung, sodass das
-- Mittel über gebuchte Termine (Anteil Kap Ja geschrumpft zu 50 %) = 1 TE ist.
-- alt_faktor und te_cap bleiben. ev_ref_eur (Provision je gebuchtem Termin) nur
-- bei mindestens 3 Sales mit Provision in 365 Tagen, sonst unverändert.
-- Änderung eines Gewichts > 30 % (oder erstes ev_ref) => status 'vorschlag'.
create or replace function public.werbe_ev_kalibrieren()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  n0           constant numeric := 20;
  v_default    constant jsonb := '{"lead_kap_nein":0.05,"lead_kap_ja":0.20,"lead_ohne":0.08,"alt_faktor":0.25,"gebucht":0.8,"gebucht_kap_ja":1.2,"no_show":0.3,"gehalten":1.6,"schlecht_mit_termin":0.2,"schlecht_ohne_termin":0.02,"gut":4.0,"te_cap":6}'::jsonb;
  v_start      jsonb;
  v_akt        jsonb;
  v_akt_ver    int;
  v_akt_ref    numeric;
  v_akt_cap    numeric;
  g            numeric;
  s_mit        numeric;
  s_ohne       numeric;
  ns           numeric;
  h0           numeric;
  bj0          numeric;
  bn0          numeric;
  pbj0         numeric;
  pbn0         numeric;
  pbo0         numeric;
  phj0         numeric;
  phn0         numeric;
  pg0          numeric;
  v_alt        numeric;
  v_cap        numeric;
  c            record;
  pbj          numeric;
  pbn          numeric;
  pbo          numeric;
  phj          numeric;
  phn          numeric;
  pg           numeric;
  anteil_ja    numeric;
  h            numeric;
  bj           numeric;
  bn           numeric;
  mittel       numeric;
  skala        numeric;
  v_neu        jsonb;
  v_max        numeric := 0;
  k            text;
  v_sales      int;
  v_median     numeric;
  v_booked365  int;
  v_ref        numeric;
  v_status     text;
  v_version    int;
begin
  if not pg_try_advisory_xact_lock(hashtext('werbe_ev_kalibrieren')) then
    return jsonb_build_object('success', false, 'uebersprungen', true, 'grund', 'laeuft_bereits');
  end if;

  select e.weights into v_start from public.ad_ev_weights e where e.quelle = 'start' order by e.version limit 1;
  v_start := coalesce(v_start, v_default);
  select e.version, e.weights, e.ev_ref_eur, e.te_cap_per_lead
    into v_akt_ver, v_akt, v_akt_ref, v_akt_cap
    from public.ad_ev_weights e where e.status = 'aktiv' order by e.version desc limit 1;
  v_akt := coalesce(v_akt, v_start);

  g     := coalesce((v_start ->> 'gut')::numeric, 4.0);
  s_mit := coalesce((v_start ->> 'schlecht_mit_termin')::numeric, 0.2);
  s_ohne:= coalesce((v_start ->> 'schlecht_ohne_termin')::numeric, 0.02);
  ns    := coalesce((v_start ->> 'no_show')::numeric, 0.3);
  h0    := coalesce((v_start ->> 'gehalten')::numeric, 1.6);
  bj0   := coalesce((v_start ->> 'gebucht_kap_ja')::numeric, 1.2);
  bn0   := coalesce((v_start ->> 'gebucht')::numeric, 0.8);
  v_alt := coalesce((v_akt ->> 'alt_faktor')::numeric, (v_start ->> 'alt_faktor')::numeric, 0.25);
  v_cap := coalesce(v_akt_cap, (v_akt ->> 'te_cap')::numeric, 6);

  -- Start-Wahrscheinlichkeiten aus der Start-Leiter (auf 0..1 begrenzt)
  pbj0 := greatest(0, least(1, coalesce((v_start ->> 'lead_kap_ja')::numeric, 0.20)   / nullif(bj0, 0)));
  pbn0 := greatest(0, least(1, coalesce((v_start ->> 'lead_kap_nein')::numeric, 0.05) / nullif(bn0, 0)));
  pbo0 := greatest(0, least(1, coalesce((v_start ->> 'lead_ohne')::numeric, 0.08)     / nullif(bn0, 0)));
  phj0 := greatest(0, least(1, (bj0 - ns) / nullif(h0 - ns, 0)));
  phn0 := greatest(0, least(1, (bn0 - ns) / nullif(h0 - ns, 0)));
  pg0  := greatest(0, least(1, (h0 - s_mit) / nullif(g - s_mit, 0)));
  if pbj0 is null or pbn0 is null or pbo0 is null or phj0 is null or phn0 is null or pg0 is null then
    raise exception 'Start-Leiter ist unvollständig oder widersprüchlich' using errcode = '22023';
  end if;

  -- Übergänge: Meta-Leads 14 bis 180 Tage alt, ohne interne Kontakte
  with l as (
    select l.id, l.quality_rating
      from public.leads l
     where l.created_at >= now() - interval '180 days'
       and l.created_at <  now() - interval '14 days'
       and (public.werbe_ist_meta_lead(l.utm_source, l.source::text, l.fbc, null, l.meta_leadgen_id::text)
            or l.meta_ad_id is not null)
       and not public.werbe_ist_intern_kontakt(l.email, l.phone, l.whatsapp)
  ), kap as (
    select distinct on (s.lead_id) s.lead_id, lower(btrim(e.answer)) as ans
      from public.funnel_sessions s
      join public.funnel_events e on e.session_id = s.id
     where s.lead_id in (select id from l)
       and e.question_key = 'kapitalbasis'
       and coalesce(btrim(e.answer), '') <> ''
     order by s.lead_id, e.created_at desc
  ), t as (
    select a.lead_id, bool_or(a.outcome = 'completed') as gehalten
      from public.crm_appointments a
     where a.lead_id in (select id from l)
       and a.internal = false
       and a.kind = 'appointment'
     group by a.lead_id
  ), z as (
    select l.id,
           case when k.ans in ('ja', 'yes') then 'ja' when k.ans is not null then 'nein' end as kap,
           (t.lead_id is not null) as gebucht,
           coalesce(t.gehalten, false) as gehalten,
           l.quality_rating
      from l
      left join kap k on k.lead_id = l.id
      left join t on t.lead_id = l.id
  )
  select count(*)                                                                   as n_gesamt,
         count(*) filter (where kap = 'ja')                                         as n_ja,
         count(*) filter (where kap = 'ja' and gebucht)                             as x_ja,
         count(*) filter (where kap = 'nein')                                       as n_nein,
         count(*) filter (where kap = 'nein' and gebucht)                           as x_nein,
         count(*) filter (where kap is null)                                        as n_ohne,
         count(*) filter (where kap is null and gebucht)                            as x_ohne,
         count(*) filter (where gebucht and kap = 'ja')                             as b_ja,
         count(*) filter (where gebucht and kap = 'ja' and gehalten)                as h_ja,
         count(*) filter (where gebucht and kap is distinct from 'ja')              as b_andere,
         count(*) filter (where gebucht and kap is distinct from 'ja' and gehalten) as h_andere,
         count(*) filter (where gehalten and quality_rating in ('gut', 'schlecht')) as bewertet,
         count(*) filter (where gehalten and quality_rating = 'gut')                as gut
    into c
    from z;

  pbj := (c.x_ja     + n0 * pbj0) / (c.n_ja     + n0);
  pbn := (c.x_nein   + n0 * pbn0) / (c.n_nein   + n0);
  pbo := (c.x_ohne   + n0 * pbo0) / (c.n_ohne   + n0);
  phj := (c.h_ja     + n0 * phj0) / (c.b_ja     + n0);
  phn := (c.h_andere + n0 * phn0) / (c.b_andere + n0);
  pg  := (c.gut      + n0 * pg0)  / (c.bewertet + n0);
  anteil_ja := (c.b_ja + n0 * 0.5) / (c.b_ja + c.b_andere + n0);

  h  := pg  * g + (1 - pg)  * s_mit;
  bj := phj * h + (1 - phj) * ns;
  bn := phn * h + (1 - phn) * ns;
  mittel := anteil_ja * bj + (1 - anteil_ja) * bn;
  skala := case when mittel > 0 then 1 / mittel else 1 end;

  v_neu := jsonb_build_object(
    'lead_kap_nein',        round(pbn * bn * skala, 4),
    'lead_kap_ja',          round(pbj * bj * skala, 4),
    'lead_ohne',            round(pbo * bn * skala, 4),
    'alt_faktor',           v_alt,
    'gebucht',              round(bn * skala, 4),
    'gebucht_kap_ja',       round(bj * skala, 4),
    'no_show',              round(ns * skala, 4),
    'gehalten',             round(h * skala, 4),
    'schlecht_mit_termin',  round(s_mit * skala, 4),
    'schlecht_ohne_termin', round(s_ohne * skala, 4),
    'gut',                  round(g * skala, 4),
    'te_cap',               v_cap);

  -- Provision je gebuchtem Termin (nur mit echten Sales)
  select count(*), percentile_cont(0.5) within group (order by d.commission_amount)
    into v_sales, v_median
    from public.deals d
    join public.leads l on l.id = d.lead_id
   where d.commission_amount > 0
     and (d.phase in ('anzahlung', 'provision_erhalten')
          or d.archived_from_phase in ('anzahlung', 'provision_erhalten')
          or d.deposit_paid_at is not null
          or d.commission_paid_at is not null)
     and d.created_at >= now() - interval '365 days'
     and (public.werbe_ist_meta_lead(l.utm_source, l.source::text, l.fbc, null, l.meta_leadgen_id::text)
          or l.meta_ad_id is not null)
     and not public.werbe_ist_intern_kontakt(l.email, l.phone, l.whatsapp);
  select count(distinct a.lead_id) into v_booked365
    from public.crm_appointments a
    join public.leads l on l.id = a.lead_id
   where a.internal = false
     and a.kind = 'appointment'
     and a.created_at >= now() - interval '365 days'
     and (public.werbe_ist_meta_lead(l.utm_source, l.source::text, l.fbc, null, l.meta_leadgen_id::text)
          or l.meta_ad_id is not null)
     and not public.werbe_ist_intern_kontakt(l.email, l.phone, l.whatsapp);
  if coalesce(v_sales, 0) >= 3 and coalesce(v_booked365, 0) > 0 then
    v_ref := round(v_median * v_sales / v_booked365, 2);
  else
    v_ref := v_akt_ref;
  end if;

  -- Größte relative Änderung gegenüber der aktiven Leiter
  for k in select jsonb_object_keys(v_neu) loop
    if coalesce((v_akt ->> k)::numeric, 0) > 0 then
      v_max := greatest(v_max, abs((v_neu ->> k)::numeric / (v_akt ->> k)::numeric - 1));
    elsif coalesce((v_neu ->> k)::numeric, 0) <> 0 then
      v_max := greatest(v_max, 1);
    end if;
  end loop;
  if v_ref is distinct from v_akt_ref then
    if coalesce(v_akt_ref, 0) > 0 and v_ref is not null then
      v_max := greatest(v_max, abs(v_ref / v_akt_ref - 1));
    else
      v_max := greatest(v_max, 1);
    end if;
  end if;

  if v_max < 0.0005 then
    return jsonb_build_object('success', true, 'unveraendert', true, 'version', v_akt_ver,
                              'zaehlungen', to_jsonb(c));
  end if;

  v_status := case when v_max > 0.3 then 'vorschlag' else 'aktiv' end;

  -- Ältere, nicht übernommene Kalibrier-Vorschläge archivieren
  update public.ad_ev_weights set status = 'archiv' where status = 'vorschlag' and quelle = 'kalibrierung';
  if v_status = 'aktiv' then
    update public.ad_ev_weights set status = 'archiv' where status = 'aktiv';
  end if;

  insert into public.ad_ev_weights (status, weights, ev_ref_eur, te_cap_per_lead, quelle, kalibrierung, gueltig_ab)
  values (v_status, v_neu, v_ref, v_cap, 'kalibrierung',
          jsonb_build_object(
            'basis_version', v_akt_ver,
            'n0', n0,
            'zeitraum_tage', 180,
            'mindestalter_tage', 14,
            'zaehlungen', to_jsonb(c),
            'p', jsonb_build_object('gebucht_ja', round(pbj, 4), 'gebucht_nein', round(pbn, 4), 'gebucht_ohne', round(pbo, 4),
                                    'gehalten_ja', round(phj, 4), 'gehalten_andere', round(phn, 4), 'gut', round(pg, 4),
                                    'anteil_ja_gebucht', round(anteil_ja, 4)),
            'sales_365', v_sales,
            'gebucht_365', v_booked365,
            'max_aenderung', round(v_max, 4)),
          case when v_status = 'aktiv' then now() end)
  returning version into v_version;

  insert into public.ad_autopilot_log (art, before, after, evidence, ergebnis, akteur, akteur_art)
  values ('kalibrierung', v_akt, v_neu,
          jsonb_build_object('version', v_version, 'basis_version', v_akt_ver, 'max_aenderung', round(v_max, 4),
                             'ev_ref_alt', v_akt_ref, 'ev_ref_neu', v_ref, 'zaehlungen', to_jsonb(c)),
          v_status, auth.uid(), case when public.werbe_ist_system() then 'system' else 'mensch' end);

  return jsonb_build_object(
    'success',       true,
    'version',       v_version,
    'status',        v_status,
    'max_aenderung', round(v_max, 4),
    'weights',       v_neu,
    'ev_ref_eur',    v_ref,
    'zaehlungen',    to_jsonb(c));
end
$fn$;

-- Kalibrier-Vorschlag (oder ältere Version) aktiv setzen. Nur Admin oder System.
create or replace function public.werbe_ev_aktivieren(p_version int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_status text;
  v_alt    int;
begin
  if not (public.werbe_ist_admin() or public.werbe_ist_system()) then
    raise exception 'Nur ein Admin darf die Wertleiter umstellen' using errcode = '42501';
  end if;
  select e.status into v_status from public.ad_ev_weights e where e.version = p_version for update;
  if not found then
    raise exception 'Version % nicht gefunden', p_version using errcode = 'P0002';
  end if;
  if v_status = 'aktiv' then
    return jsonb_build_object('success', true, 'unveraendert', true, 'version', p_version);
  end if;

  select e.version into v_alt from public.ad_ev_weights e where e.status = 'aktiv' for update;
  update public.ad_ev_weights set status = 'archiv' where status = 'aktiv';
  update public.ad_ev_weights
     set status = 'aktiv', gueltig_ab = now(), aktiviert_von = auth.uid()
   where version = p_version;

  insert into public.ad_autopilot_log (art, evidence, ergebnis, akteur, akteur_art)
  values ('kalibrierung', jsonb_build_object('version', p_version, 'vorher_version', v_alt), 'aktiviert',
          auth.uid(), case when public.werbe_ist_system() then 'system' else 'mensch' end);

  return jsonb_build_object('success', true, 'version', p_version, 'vorher_version', v_alt);
end
$fn$;

-- ── Rechte ──────────────────────────────────────────────────────────────────
-- Reine Mathematik/Merkmale: lesbar für Eingeloggte (TS-Spiegel-Abgleich).
revoke execute on function public.werbe_kennung_basis(text, text)             from public, anon;
revoke execute on function public.werbe_kennung(text, text, text)             from public, anon;
grant  execute on function public.werbe_kennung_basis(text, text)             to authenticated, service_role;
grant  execute on function public.werbe_kennung(text, text, text)             to authenticated, service_role;
revoke execute on function public.werbe_lgamma(float8)                         from public, anon;
revoke execute on function public.werbe_gamma_p(float8, float8)                from public, anon;
revoke execute on function public.werbe_ist_meta_lead(text, text, text, text, text) from public, anon;
revoke execute on function public.werbe_te(jsonb, text, numeric, boolean, boolean, boolean, text, numeric, numeric, boolean, boolean) from public, anon;
grant  execute on function public.werbe_lgamma(float8)                         to authenticated, service_role;
grant  execute on function public.werbe_gamma_p(float8, float8)                to authenticated, service_role;
grant  execute on function public.werbe_ist_meta_lead(text, text, text, text, text) to authenticated, service_role;
grant  execute on function public.werbe_te(jsonb, text, numeric, boolean, boolean, boolean, text, numeric, numeric, boolean, boolean) to authenticated, service_role;

-- Liest Profile/Einladungen: nur Service-Role.
revoke execute on function public.werbe_ist_intern_kontakt(text, text, text) from public, anon, authenticated;
grant  execute on function public.werbe_ist_intern_kontakt(text, text, text) to service_role;

-- Schreibende Berechnung: nur Service-Role (werbe-autopilot).
revoke execute on function public.werbe_qualitaet_berechnen(date) from public, anon, authenticated;
grant  execute on function public.werbe_qualitaet_berechnen(date) to service_role;
revoke execute on function public.werbe_ev_kalibrieren()          from public, anon, authenticated;
grant  execute on function public.werbe_ev_kalibrieren()          to service_role;

revoke execute on function public.werbe_ev_aktivieren(int) from public, anon;
grant  execute on function public.werbe_ev_aktivieren(int) to authenticated, service_role;

comment on function public.werbe_qualitaet_berechnen(date) is
  'Werbe-Autopilot: Qualitäts-Score (TE, Kosten pro TE, Gamma-Poisson-Schrumpfung) seriell in ad_quality_daily. Nur service_role.';
comment on function public.werbe_ev_kalibrieren() is
  'Werbe-Autopilot: Wertleiter wöchentlich kalibrieren (Beta-Binomial n0=20, > 30 % nur Vorschlag). Nur service_role.';

notify pgrst, 'reload schema';

commit;
