-- 20260624_invoices.sql
-- Rechnungstool: Artikel, Abopläne, Kunden-Stammdaten, Rechnungen (CI-PDF) +
-- Anzahlungs-Automatik (Deal → Anzahlung → automatische Lead-Rechnung an Burkhard).
-- Aussteller: sveru ltd (CY10357170V / HE35170), Marke: Happy Property.

-- ── 1) Aussteller-/Bank-/Nummernkreis-Einstellungen (Singleton) ────────────────
create table if not exists public.invoice_settings (
  id                boolean primary key default true,
  legal_name        text not null default 'sveru ltd',
  brand_name        text not null default 'Happy Property',
  address_line1     text,
  address_line2     text,
  postal_code       text,
  city              text,
  country           text default 'Cyprus',
  vat_number        text,
  reg_number        text,
  email             text,
  phone             text,
  bank_name         text,
  iban              text,
  bic               text,
  intermediary_bic  text,
  logo_url          text,
  default_due_days  int  not null default 7,
  invoice_prefix    text not null default 'INV-',
  next_number       int  not null default 108,
  footer_note       text,
  auto_send_deposit boolean not null default false,  -- true = Anzahlungs-Rechnung ohne Bestätigungs-Klick raus
  updated_at        timestamptz not null default now(),
  constraint invoice_settings_singleton check (id)
);

-- ── 2) Rechnungs-Empfänger (Stammdaten) ────────────────────────────────────────
create table if not exists public.invoice_customers (
  id            uuid primary key default gen_random_uuid(),
  company_name  text not null,
  contact_name  text,
  address_line1 text,
  address_line2 text,
  postal_code   text,
  city          text,
  country       text default 'Cyprus',
  vat_number    text,
  email         text,
  -- bestimmt die Standard-MwSt-Behandlung: cyprus=19%, eu=Reverse-Charge, third=Drittland
  country_mode  text not null default 'cyprus' check (country_mode in ('cyprus','eu','third')),
  is_default    boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── 3) Artikel-Katalog ─────────────────────────────────────────────────────────
create table if not exists public.invoice_articles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  unit        text not null default 'Pauschal',
  net_price   numeric(12,2) not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── 4) Abopläne ────────────────────────────────────────────────────────────────
create table if not exists public.subscription_plans (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  interval    text not null default 'monthly' check (interval in ('monthly','quarterly','yearly')),
  net_price   numeric(12,2) not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── 5) Rechnungen ──────────────────────────────────────────────────────────────
create table if not exists public.crm_invoices (
  id                uuid primary key default gen_random_uuid(),
  invoice_number    text not null unique,
  -- öffentlicher, nicht erratbarer Token für /re/<token> + PDF-Link
  token             text not null unique default (replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')),
  customer_id       uuid references public.invoice_customers(id) on delete set null,
  deal_id           uuid references public.deals(id) on delete set null,
  lead_id           uuid references public.leads(id) on delete set null,
  -- unveränderliche Schnappschüsse zum Ausstellzeitpunkt (Rechnung darf sich nachträglich nicht ändern)
  issuer_snapshot   jsonb,
  customer_snapshot jsonb,
  issue_date        date not null default current_date,
  supply_date       date,
  due_date          date,
  vat_treatment     text not null default 'standard_19'
    check (vat_treatment in ('standard_19','reduced_9','reduced_5','reduced_3','zero','reverse_charge_eu','third_country','exempt')),
  vat_rate          numeric(5,2)  not null default 19,
  subtotal_net      numeric(12,2) not null default 0,
  vat_amount        numeric(12,2) not null default 0,
  total_gross       numeric(12,2) not null default 0,
  currency          text not null default 'EUR',
  status            text not null default 'draft' check (status in ('draft','sent','paid','canceled')),
  vat_note          text,
  notes             text,
  pdf_path          text,   -- Pfad im Bucket invoice-documents (<token>.pdf)
  sent_at           timestamptz,
  paid_at           timestamptz,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists crm_invoices_deal_idx     on public.crm_invoices(deal_id);
create index if not exists crm_invoices_customer_idx on public.crm_invoices(customer_id);
create index if not exists crm_invoices_status_idx   on public.crm_invoices(status);

create table if not exists public.crm_invoice_items (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid not null references public.crm_invoices(id) on delete cascade,
  description    text not null,
  quantity       numeric(10,2) not null default 1,
  unit_price_net numeric(12,2) not null default 0,
  line_net       numeric(12,2) not null default 0,
  sort           int not null default 0
);
create index if not exists crm_invoice_items_invoice_idx on public.crm_invoice_items(invoice_id);

-- ── updated_at-Trigger (Funktion existiert bereits) ────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['invoice_settings','invoice_customers','invoice_articles','subscription_plans','crm_invoices'] loop
    execute format('drop trigger if exists trg_%1$s_updated on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated before update on public.%1$s for each row execute function public.update_updated_at_column()', t);
  end loop;
end$$;

-- ── Nummernkreis: atomar nächste Rechnungsnummer ziehen ────────────────────────
create or replace function public.claim_invoice_number()
returns text language plpgsql security definer set search_path = public as $$
declare n int; p text;
begin
  insert into public.invoice_settings(id) values (true) on conflict (id) do nothing;
  update public.invoice_settings set next_number = next_number + 1 where id = true
    returning next_number - 1, invoice_prefix into n, p;
  return p || n::text;
end$$;
revoke all on function public.claim_invoice_number() from public, anon;
grant execute on function public.claim_invoice_number() to authenticated, service_role;

-- ── Öffentlicher Token-Abruf (anon) für /re/<token> ────────────────────────────
create or replace function public.get_invoice_by_token(p_token text)
returns jsonb language sql security definer stable set search_path = public as $$
  select to_jsonb(i) || jsonb_build_object(
           'items',
           coalesce((select jsonb_agg(to_jsonb(it) order by it.sort, it.description)
                     from public.crm_invoice_items it where it.invoice_id = i.id), '[]'::jsonb))
  from public.crm_invoices i
  where i.token = p_token
  limit 1;
$$;
grant execute on function public.get_invoice_by_token(text) to anon, authenticated;

-- ── RLS: nur Staff (admin/verwalter) — Portal-Eigentümer sehen keine Finanzdaten ─
do $$
declare t text;
begin
  foreach t in array array['invoice_settings','invoice_customers','invoice_articles','subscription_plans','crm_invoices','crm_invoice_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t||'_rw', t);
    execute format($p$create policy %1$I on public.%2$I for all to authenticated
      using ((select role from public.profiles where id = auth.uid()) = any(array['admin','verwalter']))
      with check ((select role from public.profiles where id = auth.uid()) = any(array['admin','verwalter']))$p$, t||'_rw', t);
  end loop;
end$$;

-- ── Storage-Bucket für Rechnungs-PDFs (öffentlich per unrate­barem Token-Pfad) ──
insert into storage.buckets (id, name, public)
values ('invoice-documents', 'invoice-documents', true)
on conflict (id) do nothing;

-- ── Seeds: Aussteller (sveru ltd) + Bank aus INV-107 ───────────────────────────
insert into public.invoice_settings (
  id, legal_name, brand_name, address_line1, postal_code, city, country,
  vat_number, reg_number, email, bank_name, iban, bic, intermediary_bic,
  logo_url, default_due_days, invoice_prefix, next_number
) values (
  true, 'sveru ltd', 'Happy Property',
  'Tepeleniou 13, Tepelenio Court, Floor 2', '8010', 'Paphos', 'Cyprus',
  'CY10357170V', 'HE35170', 'info@happy-property.com',
  'Revolut Bank UAB', 'LT593250012567075828', 'REVOLT21', 'CHASDEFX',
  'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605725998-7ngbgv0jmyv.jpeg',
  7, 'INV-', 108
) on conflict (id) do nothing;

-- ── Seeds: Empfänger Reeaals (Burkhard) aus INV-107 ────────────────────────────
insert into public.invoice_customers (
  company_name, contact_name, address_line1, postal_code, city, country,
  vat_number, email, country_mode, is_default
)
select 'Reeaals Unlimited LTD', 'Burkhard', 'Savva 26, Shop 1-2', '8201', 'Geroskipou', 'Cyprus',
       '10422208B', 'info@reeaals.cy', 'cyprus', true
where not exists (select 1 from public.invoice_customers where lower(company_name) = lower('Reeaals Unlimited LTD'));

-- ── Seeds: Standard-Artikel ────────────────────────────────────────────────────
insert into public.invoice_articles (name, description, unit, net_price)
select 'Leadgenerierung', 'Vermittlung eines qualifizierten Investoren-Leads', 'Pauschal', 0
where not exists (select 1 from public.invoice_articles where name = 'Leadgenerierung');
