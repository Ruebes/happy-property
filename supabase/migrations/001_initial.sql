-- ============================================================
-- Happy Property – Complete Schema (v2)
-- ============================================================

-- ── Extensions ────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ── 0. Clean slate (drop in dependency order) ─────────────────
drop trigger  if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists public.current_user_role();
drop function if exists public.get_contract_for_signing(uuid);
drop function if exists public.sign_contract(uuid);

drop table if exists public.bookings       cascade;
drop table if exists public.income_entries cascade;
drop table if exists public.contracts      cascade;
drop table if exists public.documents      cascade;
drop table if exists public.properties     cascade;
drop table if exists public.profiles       cascade;

-- ============================================================
-- 1. profiles
-- ============================================================
create table public.profiles (
  id         uuid        primary key references auth.users(id) on delete cascade,
  email      text        not null,
  full_name  text        not null default '',
  phone      text,
  role       text        not null default 'eigentuemer'
                         check (role in ('admin', 'verwalter', 'eigentuemer')),
  language   text        not null default 'de'
                         check (language in ('de', 'en')),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. properties
-- ============================================================
create table public.properties (
  id           uuid         primary key default gen_random_uuid(),
  project_name text         not null,
  unit_number  text,
  type         text         not null check (type in ('villa', 'apartment', 'studio')),
  bedrooms     smallint     not null default 0
                            check (bedrooms between 0 and 5),
  size_sqm     numeric(8,2),
  street       text,
  house_number text,
  zip          text,
  city         text,
  description  text,
  images       text[]       not null default '{}',
  rental_type  text         not null check (rental_type in ('longterm', 'shortterm')),
  owner_id     uuid         not null references public.profiles(id),
  created_by   uuid         not null references public.profiles(id),
  created_at   timestamptz  not null default now()
);

-- ============================================================
-- 3. documents
-- ============================================================
create table public.documents (
  id           uuid         primary key default gen_random_uuid(),
  property_id  uuid         not null references public.properties(id) on delete cascade,
  uploaded_by  uuid         not null references public.profiles(id),
  type         text         not null check (type in ('mietvertrag', 'rechnung', 'sonstiges')),
  title        text         not null,
  file_url     text         not null,
  amount_net   numeric(10,2),
  amount_gross numeric(10,2),
  creditor     text,
  uploaded_at  timestamptz  not null default now()
);

-- ============================================================
-- 4. contracts
-- ============================================================
create table public.contracts (
  id              uuid         primary key default gen_random_uuid(),
  property_id     uuid         not null references public.properties(id) on delete cascade,
  tenant_name     text         not null,
  tenant_email    text         not null,
  start_date      date         not null,
  end_date        date,
  monthly_rent    numeric(10,2) not null,
  file_url        text,
  status          text         not null default 'draft'
                               check (status in ('draft', 'sent', 'signed')),
  signature_token uuid         not null default gen_random_uuid() unique,
  signed_at       timestamptz,
  created_at      timestamptz  not null default now()
);

-- ============================================================
-- 5. income_entries
-- ============================================================
create table public.income_entries (
  id           uuid         primary key default gen_random_uuid(),
  property_id  uuid         not null references public.properties(id) on delete cascade,
  type         text         not null check (type in ('longterm', 'shortterm')),
  amount       numeric(10,2) not null,
  period_start date         not null,
  period_end   date         not null,
  source       text         not null default 'manual'
                            check (source in ('manual', 'airbnb', 'booking')),
  notes        text,
  created_at   timestamptz  not null default now()
);

-- ============================================================
-- 6. bookings
-- ============================================================
create table public.bookings (
  id           uuid         primary key default gen_random_uuid(),
  property_id  uuid         not null references public.properties(id) on delete cascade,
  source       text         not null check (source in ('airbnb', 'booking', 'vrbo', 'manual')),
  check_in     date         not null,
  check_out    date         not null,
  ical_uid     text,
  created_at   timestamptz  not null default now(),
  -- Deduplizierung beim iCal-Sync: gleiche UID pro Objekt nur einmal
  unique (property_id, ical_uid)
);

-- ============================================================
-- Helper: Rolle des eingeloggten Users ermitteln
-- ============================================================
create or replace function public.current_user_role()
returns text
language sql
security definer
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- ============================================================
-- Row Level Security
-- ============================================================

-- ── profiles ──────────────────────────────────────────────────
alter table public.profiles enable row level security;

create policy "profiles_own_select"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles_own_update"
  on public.profiles for update
  using (id = auth.uid());

create policy "profiles_verwalter_admin_select"
  on public.profiles for select
  using (public.current_user_role() in ('admin', 'verwalter'));

create policy "profiles_admin_all"
  on public.profiles for all
  using (public.current_user_role() = 'admin');

-- ── properties ────────────────────────────────────────────────
alter table public.properties enable row level security;

-- Eigentümer: nur eigene Objekte lesen
create policy "properties_eigentuemer_select"
  on public.properties for select
  using (
    owner_id = auth.uid()
    and public.current_user_role() = 'eigentuemer'
  );

-- Verwalter: alles lesen und schreiben
create policy "properties_verwalter_select"
  on public.properties for select
  using (public.current_user_role() = 'verwalter');

create policy "properties_verwalter_write"
  on public.properties for insert
  with check (public.current_user_role() in ('admin', 'verwalter'));

create policy "properties_verwalter_update"
  on public.properties for update
  using (public.current_user_role() in ('admin', 'verwalter'));

create policy "properties_verwalter_delete"
  on public.properties for delete
  using (public.current_user_role() in ('admin', 'verwalter'));

-- Admin: alles
create policy "properties_admin_select"
  on public.properties for select
  using (public.current_user_role() = 'admin');

-- ── documents ─────────────────────────────────────────────────
alter table public.documents enable row level security;

create policy "documents_eigentuemer_select"
  on public.documents for select
  using (
    public.current_user_role() = 'eigentuemer'
    and exists (
      select 1 from public.properties p
      where p.id = property_id and p.owner_id = auth.uid()
    )
  );

create policy "documents_verwalter_admin_select"
  on public.documents for select
  using (public.current_user_role() in ('admin', 'verwalter'));

create policy "documents_verwalter_admin_write"
  on public.documents for insert
  with check (public.current_user_role() in ('admin', 'verwalter'));

create policy "documents_verwalter_admin_update"
  on public.documents for update
  using (public.current_user_role() in ('admin', 'verwalter'));

create policy "documents_verwalter_admin_delete"
  on public.documents for delete
  using (public.current_user_role() in ('admin', 'verwalter'));

-- ── contracts ─────────────────────────────────────────────────
alter table public.contracts enable row level security;

create policy "contracts_eigentuemer_select"
  on public.contracts for select
  using (
    public.current_user_role() = 'eigentuemer'
    and exists (
      select 1 from public.properties p
      where p.id = property_id and p.owner_id = auth.uid()
    )
  );

create policy "contracts_verwalter_admin_select"
  on public.contracts for select
  using (public.current_user_role() in ('admin', 'verwalter'));

create policy "contracts_verwalter_admin_write"
  on public.contracts for insert
  with check (public.current_user_role() in ('admin', 'verwalter'));

create policy "contracts_verwalter_admin_update"
  on public.contracts for update
  using (public.current_user_role() in ('admin', 'verwalter'));

-- ── income_entries ────────────────────────────────────────────
alter table public.income_entries enable row level security;

create policy "income_eigentuemer_select"
  on public.income_entries for select
  using (
    public.current_user_role() = 'eigentuemer'
    and exists (
      select 1 from public.properties p
      where p.id = property_id and p.owner_id = auth.uid()
    )
  );

create policy "income_verwalter_admin_select"
  on public.income_entries for select
  using (public.current_user_role() in ('admin', 'verwalter'));

create policy "income_verwalter_admin_write"
  on public.income_entries for insert
  with check (public.current_user_role() in ('admin', 'verwalter'));

create policy "income_verwalter_admin_update"
  on public.income_entries for update
  using (public.current_user_role() in ('admin', 'verwalter'));

-- ── bookings ──────────────────────────────────────────────────
alter table public.bookings enable row level security;

create policy "bookings_eigentuemer_select"
  on public.bookings for select
  using (
    public.current_user_role() = 'eigentuemer'
    and exists (
      select 1 from public.properties p
      where p.id = property_id and p.owner_id = auth.uid()
    )
  );

create policy "bookings_verwalter_admin_select"
  on public.bookings for select
  using (public.current_user_role() in ('admin', 'verwalter'));

create policy "bookings_verwalter_admin_write"
  on public.bookings for insert
  with check (public.current_user_role() in ('admin', 'verwalter'));

create policy "bookings_verwalter_admin_update"
  on public.bookings for update
  using (public.current_user_role() in ('admin', 'verwalter'));

-- ============================================================
-- Storage Buckets
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('documents',        'documents',        false, 52428800,
    array['application/pdf']),
  ('property-images',  'property-images',  true,  10485760,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- Storage: documents (privat – nur eingeloggte User)
create policy "docs_storage_upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'documents');

create policy "docs_storage_read"
  on storage.objects for select to authenticated
  using (bucket_id = 'documents');

create policy "docs_storage_delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'documents');

-- Storage: property-images (öffentlich lesbar)
create policy "images_storage_public_read"
  on storage.objects for select to public
  using (bucket_id = 'property-images');

create policy "images_storage_upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'property-images');

create policy "images_storage_delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'property-images');

-- ============================================================
-- Public Signing RPCs (kein Login nötig, security definer)
-- ============================================================

-- Vertrag anhand signature_token laden (für /sign/:token)
create or replace function public.get_contract_for_signing(p_token uuid)
returns table (
  id              uuid,
  property_id     uuid,
  project_name    text,
  unit_number     text,
  city            text,
  tenant_name     text,
  tenant_email    text,
  start_date      date,
  end_date        date,
  monthly_rent    numeric,
  status          text,
  file_url        text
)
language sql
security definer
stable
as $$
  select
    c.id,
    c.property_id,
    p.project_name,
    p.unit_number,
    p.city,
    c.tenant_name,
    c.tenant_email,
    c.start_date,
    c.end_date,
    c.monthly_rent,
    c.status,
    c.file_url
  from public.contracts c
  join public.properties p on p.id = c.property_id
  where c.signature_token = p_token;
$$;

-- Vertrag unterzeichnen (setzt status='signed' + signed_at)
create or replace function public.sign_contract(p_token uuid)
returns void
language plpgsql
security definer
as $$
begin
  update public.contracts
  set
    status    = 'signed',
    signed_at = now()
  where
    signature_token = p_token
    and status in ('draft', 'sent');

  if not found then
    raise exception 'Contract not found or already signed';
  end if;
end;
$$;

-- ============================================================
-- Trigger: Profil automatisch bei Registrierung anlegen
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, phone, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'phone',
    coalesce(new.raw_user_meta_data->>'role', 'eigentuemer')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
