-- Empfängerlisten aus Klaviyo (21.07.2026)
--
-- Sven hat Adressen aus Webinar-Anmeldungen, Leadmagneten und Newsletter jahrelang
-- in Klaviyo gesammelt. Die sollen im CRM nutzbar sein — aber BEWUSST getrennt von
-- den Leads: eine Webinar-Anmeldung ist kein Vertriebskontakt und darf Kundenliste,
-- Pipeline und Auswertungen nicht verschmutzen (genau der Fehler, der bei Giona auffiel).

create table if not exists newsletter_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source text not null default 'manual' check (source in ('manual','klaviyo')),
  klaviyo_list_id text unique,
  active boolean not null default true,
  synced_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  first_name text,
  last_name text,
  optout_at timestamptz,
  source text,
  created_at timestamptz not null default now()
);
create index if not exists idx_nl_sub_email on newsletter_subscribers(lower(email));

create table if not exists newsletter_list_members (
  list_id uuid not null references newsletter_lists(id) on delete cascade,
  subscriber_id uuid not null references newsletter_subscribers(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_id, subscriber_id)
);
create index if not exists idx_nl_member_sub on newsletter_list_members(subscriber_id);

-- Listenauswahl je Kampagne. Standard 'all' — normalerweise bekommen alle den Newsletter.
alter table newsletter_campaigns add column if not exists list_mode text not null default 'all'
  check (list_mode in ('all','include','exclude'));
alter table newsletter_campaigns add column if not exists list_ids uuid[] not null default '{}';

-- Newsletter-Empfänger ohne CRM-Lead: der Versandweg braucht einen zweiten Bezug.
alter table scheduled_messages add column if not exists subscriber_id uuid references newsletter_subscribers(id) on delete cascade;
create index if not exists idx_sched_subscriber on scheduled_messages(subscriber_id) where subscriber_id is not null;

alter table newsletter_lists enable row level security;
alter table newsletter_subscribers enable row level security;
alter table newsletter_list_members enable row level security;
do $$ begin
  perform 1;
end $$;
create policy nl_lists_admin on newsletter_lists for all to authenticated
  using (exists (select 1 from profiles p where p.id=auth.uid() and p.role in ('admin','verwalter','mitarbeiter')))
  with check (exists (select 1 from profiles p where p.id=auth.uid() and p.role in ('admin','verwalter','mitarbeiter')));
create policy nl_subs_admin on newsletter_subscribers for all to authenticated
  using (exists (select 1 from profiles p where p.id=auth.uid() and p.role in ('admin','verwalter','mitarbeiter')))
  with check (exists (select 1 from profiles p where p.id=auth.uid() and p.role in ('admin','verwalter','mitarbeiter')));
create policy nl_members_admin on newsletter_list_members for all to authenticated
  using (exists (select 1 from profiles p where p.id=auth.uid() and p.role in ('admin','verwalter','mitarbeiter')))
  with check (exists (select 1 from profiles p where p.id=auth.uid() and p.role in ('admin','verwalter','mitarbeiter')));

-- 1:1-Uebernahme aus Klaviyo: dort liefert jede Person unterschiedlich viel
-- (mal nur Name + Mail, mal ein vollstaendiger Datensatz). Bekannte Felder
-- bekommen eigene Spalten, alles Uebrige wandert roh nach properties, damit
-- beim Import nichts verloren geht.
alter table newsletter_subscribers add column if not exists phone text;
alter table newsletter_subscribers add column if not exists organization text;
alter table newsletter_subscribers add column if not exists title text;
alter table newsletter_subscribers add column if not exists city text;
alter table newsletter_subscribers add column if not exists region text;
alter table newsletter_subscribers add column if not exists country text;
alter table newsletter_subscribers add column if not exists klaviyo_id text;
alter table newsletter_subscribers add column if not exists properties jsonb;
alter table newsletter_subscribers add column if not exists klaviyo_created_at timestamptz;
create unique index if not exists idx_nl_sub_klaviyo on newsletter_subscribers(klaviyo_id) where klaviyo_id is not null;

-- Sammel-Uebernahme einer ganzen Klaviyo-Seite (100 Profile) in EINEM Statement.
-- Vorher waren es drei Roundtrips je Adresse — damit lief der Import bei 10 Listen
-- (5.400 Adressen) in die Zeitgrenze der Edge Function.
-- Alles in CTEs, KEINE temporaere Tabelle: ein DELETE ohne WHERE wird blockiert.
create or replace function hp_klaviyo_upsert(p_list_id uuid, p_rows jsonb)
returns TABLE(neu int, gesamt int)
language sql security definer set search_path = public as $fn$
  with eingang as (
    select lower(trim(x->>'email')) as email,
           nullif(x->>'first_name','')   as first_name,
           nullif(x->>'last_name','')    as last_name,
           nullif(x->>'phone','')        as phone,
           nullif(x->>'organization','') as organization,
           nullif(x->>'title','')        as title,
           nullif(x->>'city','')         as city,
           nullif(x->>'region','')       as region,
           nullif(x->>'country','')      as country,
           nullif(x->>'klaviyo_id','')   as klaviyo_id,
           case when x->'properties' = 'null'::jsonb then null else x->'properties' end as properties,
           (nullif(x->>'klaviyo_created_at',''))::timestamptz as klaviyo_created_at
    from jsonb_array_elements(p_rows) x
    where coalesce(trim(x->>'email'),'') <> ''
  ), entdoppelt as (
    -- Dieselbe Adresse kann in einer Seite mehrfach stehen; ON CONFLICT vertraegt
    -- keine Dubletten im selben Statement.
    select distinct on (email) * from eingang order by email
  ), eingefuegt as (
    insert into newsletter_subscribers as s
      (email, first_name, last_name, phone, organization, title, city, region, country,
       klaviyo_id, properties, klaviyo_created_at, source)
    select email, first_name, last_name, phone, organization, title, city, region, country,
           klaviyo_id, properties, klaviyo_created_at, 'klaviyo'
    from entdoppelt
    on conflict (email) do update set
      -- ERGAENZEN, nicht ueberschreiben: eine Liste mit duennen Datensaetzen darf die
      -- Angaben aus einer reichhaltigeren Liste nicht ausloeschen.
      first_name   = coalesce(excluded.first_name,   s.first_name),
      last_name    = coalesce(excluded.last_name,    s.last_name),
      phone        = coalesce(excluded.phone,        s.phone),
      organization = coalesce(excluded.organization, s.organization),
      title        = coalesce(excluded.title,        s.title),
      city         = coalesce(excluded.city,         s.city),
      region       = coalesce(excluded.region,       s.region),
      country      = coalesce(excluded.country,      s.country),
      klaviyo_id   = coalesce(excluded.klaviyo_id,   s.klaviyo_id),
      properties   = coalesce(excluded.properties,   s.properties),
      klaviyo_created_at = coalesce(excluded.klaviyo_created_at, s.klaviyo_created_at)
    returning id, (xmax = 0) as war_neu
  ), verknuepft as (
    -- Laeuft auch ohne Bezug im finalen SELECT: datenveraendernde CTEs werden immer ausgefuehrt.
    insert into newsletter_list_members (list_id, subscriber_id)
    select p_list_id, id from eingefuegt
    on conflict do nothing
    returning 1
  )
  select count(*) filter (where war_neu)::int as neu, count(*)::int as gesamt from eingefuegt;
$fn$;
