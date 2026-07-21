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
