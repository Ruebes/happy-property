-- hp_lead_related: alles, was zu einem Kunden gehört, in EINEM Aufruf
-- (Grundlage für die Karte "Gehört dazu", src/components/crm/RelatedPanel.tsx).
--
-- STATUS: NICHT ANGEWENDET. Diese Datei wird erst mit Etappe 5 eingespielt.
-- Rein additiv und wiederholbar (create or replace, revoke/grant); es wird keine
-- Tabelle, Spalte, Policy oder bestehende Funktion verändert.
-- Rückbau: supabase/migrations/rollback/20260930120000_hp_lead_related.down.sql
--
-- GEPRÜFT am 30.09.2026 gegen die echte Datenbank (nur lesend):
--   alle unten genutzten Tabellen und Spalten (information_schema.columns),
--   die SELECT-Policies der Tabellen (pg_policies), current_user_role() und
--   current_user_has_perm(text), die Fremdschlüssel von affiliates,
--   affiliate_payouts, leads.referred_by_affiliate, crm_task_leads,
--   property_co_owners, portal_logins, drive_folder_files sowie die
--   vorkommenden Werte von deals.phase und crm_tasks.status.
--   Alle 89 genutzten Spalten existieren; die Typen stimmen (deals.phase und
--   crm_tasks.status sind text, leads.alt_emails ist text[], current_user_role()
--   liefert text).
-- TEILABFRAGEN GETESTET am 30.09.2026 (nur lesend, gegen einen echten Kunden
--   mit Vorgang, Wohnung und Portal-Zugang): alle 18 Blöcke zwischen den Marken
--   "-- [block name]" und "-- [end]" laufen fehlerfrei, ausgeschnitten aus
--   genau dieser Datei ("into ..." gestrichen, Variablen durch Unterabfragen
--   ersetzt). Die Feldnamen der Ergebnisse entsprechen src/lib/relatedTypes.ts.
--   Der Test lief mit Dienstrechten (ohne RLS); das Verhalten je Rolle folgt aus
--   den Policies (siehe ABWEICHUNGEN), nicht aus dem Test.
--   Nicht prüfbar ohne Einspielen: der plpgsql-Rahmen (declare, if, into).
--   newsletter_subscribers hat Indizes auf email und lower(email), nicht auf
--   lower(btrim(email)): der Newsletter-Block liest bei JEDEM Aufruf die ganze
--   Tabelle (rund 5.400 Zeilen, aber etwa 12 MB Heap). Das ist NICHT
--   unerheblich (Micro-Instanz, Karte lädt bei jedem Kundenaufruf, 60 s Cache).
--
-- NACHZIEHEN MIT ETAPPE 5 (eigene Migrationen, nicht in dieser Datei):
--   a) außerhalb einer Transaktion (concurrently geht nicht in einer):
--        create index concurrently if not exists newsletter_subscribers_email_norm_idx
--          on public.newsletter_subscribers (lower(btrim(email)));
--      Die Gleichheit lower(btrim(...)) in der Funktion bleibt unverändert.
--   b) heute klein (7 bis 601 Zeilen), wachsen aber mit jedem Kunden:
--        create index if not exists deals_lead_id_idx on public.deals (lead_id);
--        create index if not exists crm_task_leads_lead_id_idx on public.crm_task_leads (lead_id);
--        create index if not exists crm_project_units_property_id_idx
--          on public.crm_project_units (property_id) where property_id is not null;
--        create index if not exists sales_decks_lead_id_idx
--          on public.sales_decks (lead_id) where lead_id is not null;
--        create index if not exists property_calculations_lead_id_idx
--          on public.property_calculations (lead_id) where lead_id is not null;
--        create index if not exists crm_invoices_lead_id_idx
--          on public.crm_invoices (lead_id) where lead_id is not null;
--
-- ABWEICHUNGEN vom Vertrag (UI-LINKS-SPEC Teil B 3), bedingt durch das Schema:
--   deals            hat keine Spalte "archived": archiviert = phase 'archiviert'
--                    (mit archived_from_phase). Geliefert wird zusätzlich
--                    archived (boolean).
--   lead_registrations hat keine Spalte "status": geliefert werden id, developer,
--                    registered_at, created_at.
--   crm_invoices     Summe heißt total_gross: geliefert als total, dazu currency.
--   crm_appointments title = coalesce(title, type); type wird zusätzlich geliefert.
--   sales_decks / crm_strategy_scenarios  sind per RLS nur mit dem Recht 'decks'
--                    lesbar (nicht 'pipeline'): Gruppen decks und strategy sind
--                    ohne 'decks' null; viewer.can enthält deshalb zusätzlich decks.
--   crm_tasks        RLS zeigt nur Aufgaben, an denen der Aufrufer beteiligt ist
--                    (auch bei Admin): tasks zählt nur diese. Zusätzlich archived.
--   properties / property_co_owners / documents / crm_unit_payments  sind für
--                    Mitarbeiter per RLS nicht lesbar: properties und payments
--                    sind dann null, documents zählt nur Wohnungs-Dokumente, und
--                    units enthält für Mitarbeiter nur die Wohnungen aus Vorgängen.
--   portal_logins    ist nur für Admin lesbar: last_login_at und login_count sind
--                    für alle anderen null.
--   newsletter       { count, items: [{ id, optout_at, created_at }], lead_optout_at }
--                    (leads.newsletter_optout_at existiert).
--   documents        { count, property_documents, unit_documents },
--   payments         { count, open } (nur Anzahlen).
--   Zusätzliche Anzeige-Felder: decks.project_name, calculations.title, strategy.title.

-- ── 1. Zähler aus den gesperrten Tabellen (RLS ohne Policy) ─────────────────
-- security definer, weil review_requests, affiliates, affiliate_payouts und
-- drive_folder_files für angemeldete Nutzer gar nicht lesbar sind. Gibt NUR
-- Anzahlen und groben Status zurück: nie Tokens, Antworten oder Dateinamen.
create or replace function public.hp_lead_related_restricted(p_lead_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_reviews   jsonb;
  v_affiliate jsonb;
  v_drive     jsonb;
begin
  if p_lead_id is null then
    return null;
  end if;

  -- Interne Rechteprüfung: wie die leads-RLS (Admin, Verwalter oder 'pipeline')
  if not (coalesce(public.current_user_role() in ('admin', 'verwalter'), false)
          or coalesce(public.current_user_has_perm('pipeline'), false)) then
    return null;
  end if;

  -- [block restricted_reviews]
  select jsonb_build_object(
           'count', count(*),
           'last_status', (array_agg(r.status order by r.created_at desc))[1])
    into v_reviews
    from public.review_requests r
   where r.lead_id = p_lead_id;
  -- [end]

  -- [block restricted_affiliate]
  select jsonb_build_object(
           'is_affiliate', exists (
             select 1 from public.affiliates a where a.lead_id = p_lead_id),
           'referred_count', (
             select count(*)
               from public.leads l
               join public.affiliates a on a.id = l.referred_by_affiliate
              where a.lead_id = p_lead_id),
           'payout_count', (
             select count(*)
               from public.affiliate_payouts ap
               join public.affiliates a on a.id = ap.affiliate_id
              where a.lead_id = p_lead_id))
    into v_affiliate;
  -- [end]

  -- [block restricted_drive]
  select jsonb_build_object('count', count(*))
    into v_drive
    from public.drive_folder_files f
   where f.lead_id = p_lead_id;
  -- [end]

  return jsonb_build_object(
    'reviews', v_reviews,
    'affiliate', v_affiliate,
    'drive', v_drive);
end;
$fn$;

revoke all on function public.hp_lead_related_restricted(uuid) from public, anon;
grant execute on function public.hp_lead_related_restricted(uuid) to authenticated;

-- ── 2. Alles zu einem Kunden ────────────────────────────────────────────────
-- security invoker: jede Teilabfrage läuft mit den Rechten des Aufrufers, die
-- RLS der Tabellen gilt unverändert. Ist der Kunde für den Aufrufer nicht
-- sichtbar, kommt null zurück. Jede Gruppe ist { "count": n, "items": [...] }
-- oder null, wenn der Aufrufer die Tabelle nicht lesen darf.
create or replace function public.hp_lead_related(p_lead_id uuid, p_limit int default 5)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_limit          int;
  v_role           text;
  v_is_av          boolean;   -- Admin oder Verwalter
  v_is_staff       boolean;   -- Admin, Verwalter oder Mitarbeiter
  v_pipeline       boolean;
  v_invoices       boolean;
  v_funnel         boolean;
  v_contacts       boolean;
  v_decks          boolean;
  v_profile_id     uuid;
  v_email          text;
  v_alt_emails     text[];
  v_nl_optout_at   timestamptz;
  v_access_sent_at timestamptz;
  v_unit_ids       uuid[] := '{}'::uuid[];
  v_property_ids   uuid[] := '{}'::uuid[];
  v_last_login_at  timestamptz;
  v_login_count    bigint;
  v_prop_docs      bigint;
  v_unit_docs      bigint;
  v_pay_count      bigint;
  v_pay_open       bigint;
  v_deals          jsonb;
  v_units          jsonb;
  v_properties     jsonb;
  v_tasks          jsonb;
  v_appointments   jsonb;
  v_decks_json     jsonb;
  v_calculations   jsonb;
  v_strategy       jsonb;
  v_invoices_json  jsonb;
  v_registrations  jsonb;
  v_newsletter     jsonb;
  v_documents      jsonb;
  v_payments       jsonb;
  v_restricted     jsonb;
begin
  if p_lead_id is null then
    return null;
  end if;

  v_limit    := greatest(1, least(coalesce(p_limit, 5), 50));
  v_role     := public.current_user_role();
  v_is_av    := coalesce(v_role in ('admin', 'verwalter'), false);
  v_is_staff := coalesce(v_role in ('admin', 'verwalter', 'mitarbeiter'), false);
  v_pipeline := coalesce(public.current_user_has_perm('pipeline'), false);
  v_invoices := coalesce(public.current_user_has_perm('invoices'), false);
  v_funnel   := coalesce(public.current_user_has_perm('funnel'), false);
  v_contacts := coalesce(public.current_user_has_perm('contacts'), false);
  v_decks    := coalesce(public.current_user_has_perm('decks'), false);

  -- Der Kunde selbst: unsichtbar (RLS) oder nicht vorhanden -> null
  select l.profile_id, l.email, l.alt_emails, l.newsletter_optout_at,
         coalesce(l.portal_access_sent_at, l.portal_invited_at)
    into v_profile_id, v_email, v_alt_emails, v_nl_optout_at, v_access_sent_at
    from public.leads l
   where l.id = p_lead_id;
  if not found then
    return null;
  end if;

  -- Vorgänge: alle, auch archivierte; aktive zuerst
  if v_pipeline then
    -- [block deals]
    select jsonb_build_object(
             'count', count(*),
             'items', coalesce(jsonb_agg(to_jsonb(x) - 'rn'::text order by x.rn) filter (where x.rn <= v_limit), '[]'::jsonb))
      into v_deals
      from (
        select d.id, d.phase, d.archived_from_phase, (d.phase = 'archiviert') as archived,
               d.unit_id, d.property_id, d.created_at,
               row_number() over (order by (d.phase = 'archiviert'), d.created_at desc, d.id) as rn
          from public.deals d
         where d.lead_id = p_lead_id
      ) x;
    -- [end]
  end if;

  -- Wohnungen: aus Vorgängen (ohne verlorene; archivierte nur nach Provision),
  -- als Eigentümer und als Miteigentümer; je Wohnung eine Zeile mit via-Liste
  if v_pipeline then
    -- [block units]
    with src as (
      select d.unit_id as unit_id, 'deal'::text as via
        from public.deals d
       where d.lead_id = p_lead_id
         and d.unit_id is not null
         and d.phase <> 'deal_verloren'
         and (d.phase <> 'archiviert' or d.archived_from_phase = 'provision_erhalten')
      union
      select u.id, 'owner'::text
        from public.crm_project_units u
        join public.properties p on p.id = u.property_id
       where p.owner_id = v_profile_id
      union
      select u.id, 'co_owner'::text
        from public.crm_project_units u
        join public.property_co_owners c on c.property_id = u.property_id
       where c.profile_id = v_profile_id
    ), agg as (
      select s.unit_id, array_agg(distinct s.via order by s.via) as via
        from src s
       group by s.unit_id
    ), picked as (
      select u.id, u.unit_number, u.project_id, pr.name as project_name, u.property_id,
             to_jsonb(a.via) as via,
             row_number() over (order by pr.name nulls last, u.unit_number nulls last, u.id) as rn
        from agg a
        join public.crm_project_units u on u.id = a.unit_id
        left join public.crm_projects pr on pr.id = u.project_id
    )
    select jsonb_build_object(
             'count', count(*),
             'items', coalesce(jsonb_agg(to_jsonb(x) - 'rn'::text order by x.rn) filter (where x.rn <= v_limit), '[]'::jsonb)),
           coalesce(array_agg(x.id), '{}'::uuid[])
      into v_units, v_unit_ids
      from picked x;
    -- [end]
  end if;

  -- Objekte (Verwaltung): Eigentümer oder Miteigentümer. Für Mitarbeiter per RLS
  -- nicht lesbar, deshalb nur für Admin und Verwalter.
  if v_is_av then
    -- [block properties]
    with src as (
      select p.id as property_id, 'owner'::text as owner_role
        from public.properties p
       where p.owner_id = v_profile_id
      union
      select c.property_id, 'co_owner'::text
        from public.property_co_owners c
       where c.profile_id = v_profile_id
    ), agg as (
      select s.property_id,
             case when bool_or(s.owner_role = 'owner') then 'owner' else 'co_owner' end as owner_role
        from src s
       group by s.property_id
    ), picked as (
      select p.id, p.project_name, p.unit_number, p.property_status, a.owner_role as role,
             row_number() over (order by p.project_name nulls last, p.unit_number nulls last, p.id) as rn
        from agg a
        join public.properties p on p.id = a.property_id
    )
    select jsonb_build_object(
             'count', count(*),
             'items', coalesce(jsonb_agg(to_jsonb(x) - 'rn'::text order by x.rn) filter (where x.rn <= v_limit), '[]'::jsonb)),
           coalesce(array_agg(x.id), '{}'::uuid[])
      into v_properties, v_property_ids
      from picked x;
    -- [end]
  end if;

  -- Aufgaben über crm_task_leads. Die crm_tasks-RLS zeigt nur Aufgaben, an
  -- denen der Aufrufer beteiligt ist: gezählt wird, was er sehen darf.
  if v_is_staff then
    -- [block tasks]
    select jsonb_build_object(
             'count', count(*),
             'items', coalesce(jsonb_agg(to_jsonb(x) - 'rn'::text order by x.rn) filter (where x.rn <= v_limit), '[]'::jsonb))
      into v_tasks
      from (
        select t.id, t.title, t.status, t.due_date, coalesce(t.archived, false) as archived,
               row_number() over (
                 order by coalesce(t.archived, false), (t.status = 'erledigt'),
                          t.due_date nulls last, t.created_at desc, t.id) as rn
          from public.crm_task_leads tl
          join public.crm_tasks t on t.id = tl.task_id
         where tl.lead_id = p_lead_id
      ) x;
    -- [end]
  end if;

  -- Termine: kommende zuerst (der nächste vorn), danach vergangene (jüngste vorn)
  if v_pipeline then
    -- [block appointments]
    select jsonb_build_object(
             'count', count(*),
             'items', coalesce(jsonb_agg(to_jsonb(x) - 'rn'::text order by x.rn) filter (where x.rn <= v_limit), '[]'::jsonb))
      into v_appointments
      from (
        select a.id, a.start_time, coalesce(nullif(btrim(a.title), ''), a.type) as title, a.type,
               coalesce(a.internal, false) as internal,
               row_number() over (
                 order by (a.start_time < now()),
                          case when a.start_time >= now() then a.start_time end,
                          a.start_time desc, a.id) as rn
          from public.crm_appointments a
         where a.lead_id = p_lead_id
      ) x;
    -- [end]
  end if;

  -- Sales-Decks: nie der Inhalt, nur Kopf-Daten (RLS: Recht 'decks')
  if v_decks then
    -- [block decks]
    select jsonb_build_object(
             'count', count(*),
             'items', coalesce(jsonb_agg(to_jsonb(x) - 'rn'::text order by x.rn) filter (where x.rn <= v_limit), '[]'::jsonb))
      into v_decks_json
      from (
        select s.id, s.token, s.status, s.project_id, pr.name as project_name, s.created_at,
               row_number() over (order by s.created_at desc, s.id) as rn
          from public.sales_decks s
          left join public.crm_projects pr on pr.id = s.project_id
         where s.lead_id = p_lead_id
      ) x;
    -- [end]
  end if;

  -- Rendite-Rechnungen
  if v_pipeline then
    -- [block calculations]
    select jsonb_build_object(
             'count', count(*),
             'items', coalesce(jsonb_agg(to_jsonb(x) - 'rn'::text order by x.rn) filter (where x.rn <= v_limit), '[]'::jsonb))
      into v_calculations
      from (
        select c.id, c.token, c.title, c.created_at,
               row_number() over (order by c.created_at desc, c.id) as rn
          from public.property_calculations c
         where c.lead_id = p_lead_id
      ) x;
    -- [end]
  end if;

  -- Strategie-Szenario (höchstens eines je Kunde; token kann fehlen; RLS: 'decks')
  if v_decks then
    -- [block strategy]
    select jsonb_build_object(
             'count', count(*),
             'items', coalesce(jsonb_agg(to_jsonb(x) - 'rn'::text order by x.rn) filter (where x.rn <= v_limit), '[]'::jsonb))
      into v_strategy
      from (
        select sc.id, sc.token, sc.title, sc.updated_at,
               row_number() over (order by sc.updated_at desc nulls last, sc.id) as rn
          from public.crm_strategy_scenarios sc
         where sc.lead_id = p_lead_id
      ) x;
    -- [end]
  end if;

  -- Rechnungen (RLS: Recht 'invoices')
  if v_invoices then
    -- [block invoices]
    select jsonb_build_object(
             'count', count(*),
             'items', coalesce(jsonb_agg(to_jsonb(x) - 'rn'::text order by x.rn) filter (where x.rn <= v_limit), '[]'::jsonb))
      into v_invoices_json
      from (
        select i.id, i.invoice_number, i.status, i.total_gross as total, i.currency, i.token,
               row_number() over (order by i.issue_date desc nulls last, i.created_at desc, i.id) as rn
          from public.crm_invoices i
         where i.lead_id = p_lead_id
      ) x;
    -- [end]
  end if;

  -- Registrierungen beim Bauträger
  if v_pipeline then
    -- [block registrations]
    select jsonb_build_object(
             'count', count(*),
             'items', coalesce(jsonb_agg(to_jsonb(x) - 'rn'::text order by x.rn) filter (where x.rn <= v_limit), '[]'::jsonb))
      into v_registrations
      from (
        select lr.id, lr.developer, lr.registered_at, lr.created_at,
               row_number() over (order by lr.created_at desc, lr.id) as rn
          from public.lead_registrations lr
         where lr.lead_id = p_lead_id
      ) x;
    -- [end]
  end if;

  -- Newsletter: Abonnent mit derselben Adresse (Haupt- oder Zweitadresse),
  -- verglichen über lower(btrim(email)). Nie die Adresse selbst zurückgeben.
  if v_is_staff then
    -- [block newsletter]
    select jsonb_build_object(
             'count', count(*),
             'items', coalesce(jsonb_agg(to_jsonb(x) - 'rn'::text order by x.rn) filter (where x.rn <= v_limit), '[]'::jsonb))
      into v_newsletter
      from (
        select n.id, n.optout_at, n.created_at,
               row_number() over (order by n.created_at desc, n.id) as rn
          from public.newsletter_subscribers n
         where lower(btrim(n.email)) in (
                 select lower(btrim(e.addr))
                   from unnest(array[v_email] || coalesce(v_alt_emails, '{}'::text[])) as e(addr)
                  where e.addr is not null and btrim(e.addr) <> '')
      ) x;
    -- [end]
    v_newsletter := v_newsletter || jsonb_build_object('lead_optout_at', v_nl_optout_at);
  end if;

  -- Portal-Zugang: Anmeldungen sind nur für Admin lesbar (portal_logins-RLS),
  -- für alle anderen bleiben last_login_at und login_count null.
  if v_role = 'admin' and v_profile_id is not null then
    -- [block portal_logins]
    select max(pl.created_at), count(*)
      into v_last_login_at, v_login_count
      from public.portal_logins pl
     where pl.profile_id = v_profile_id;
    -- [end]
  end if;

  -- Dokumente und Zahlungen: nur Anzahlen
  if v_is_av then
    -- [block property_documents]
    select count(*)
      into v_prop_docs
      from public.documents doc
     where doc.property_id = any (v_property_ids);
    -- [end]

    -- [block unit_payments]
    select count(*), count(*) filter (where not coalesce(up.is_paid, false))
      into v_pay_count, v_pay_open
      from public.crm_unit_payments up
     where up.unit_id = any (v_unit_ids);
    -- [end]
    v_payments := jsonb_build_object('count', v_pay_count, 'open', v_pay_open);
  end if;

  if v_pipeline then
    -- [block unit_documents]
    select count(*)
      into v_unit_docs
      from public.crm_unit_documents ud
     where ud.unit_id = any (v_unit_ids);
    -- [end]
  end if;

  if v_prop_docs is not null or v_unit_docs is not null then
    v_documents := jsonb_build_object(
      'count', coalesce(v_prop_docs, 0) + coalesce(v_unit_docs, 0),
      'property_documents', v_prop_docs,
      'unit_documents', v_unit_docs);
  end if;

  -- Bewertungen, Tippgeber, Drive: nur Zähler aus der definer-Funktion
  v_restricted := public.hp_lead_related_restricted(p_lead_id);

  return jsonb_build_object(
    'lead_id', p_lead_id,
    'viewer', jsonb_build_object(
      'role', v_role,
      'can', jsonb_build_object(
        'pipeline', v_pipeline,
        'invoices', v_invoices,
        'funnel', v_funnel,
        'contacts', v_contacts,
        'decks', v_decks)),
    'deals', v_deals,
    'units', v_units,
    'properties', v_properties,
    'tasks', v_tasks,
    'appointments', v_appointments,
    'decks', v_decks_json,
    'calculations', v_calculations,
    'strategy', v_strategy,
    'invoices', v_invoices_json,
    'registrations', v_registrations,
    'newsletter', v_newsletter,
    'portal', jsonb_build_object(
      'has_access', v_profile_id is not null,
      'profile_id', v_profile_id,
      'access_sent_at', v_access_sent_at,
      'last_login_at', v_last_login_at,
      'login_count', v_login_count),
    'documents', v_documents,
    'payments', v_payments,
    'reviews', v_restricted -> 'reviews',
    'affiliate', v_restricted -> 'affiliate',
    'drive', v_restricted -> 'drive');
end;
$fn$;

revoke all on function public.hp_lead_related(uuid, int) from public, anon;
grant execute on function public.hp_lead_related(uuid, int) to authenticated;

comment on function public.hp_lead_related(uuid, int) is
  'Alles zu einem Kunden in einem Aufruf (Karte "Gehört dazu"). security invoker: RLS gilt. null, wenn der Kunde nicht sichtbar ist.';
comment on function public.hp_lead_related_restricted(uuid) is
  'Nur Zähler und grober Status aus review_requests, affiliates, affiliate_payouts, drive_folder_files. security definer mit interner Rechteprüfung.';

-- PostgREST soll die neuen Funktionen sofort kennen
notify pgrst, 'reload schema';
