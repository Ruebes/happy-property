-- Tippgeber-Programm (Affiliate): Bestandskunden empfehlen Happy Property weiter.
-- Empfehlungs-Link /termin?ref=<code> → neuer Lead wird dem Tippgeber zugeordnet.
-- Bei Provisionseingang (Deal-Phase provision_erhalten) bekommt der Tippgeber
-- automatisch eine Abrechnung ueber 1.000 € per Mail (ohne USt — Privatperson).
-- Zugriff NUR ueber Edge Functions (service role), RLS bleibt dicht.

create table if not exists affiliates (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid references leads(id) on delete set null,  -- der Tippgeber selbst
  name       text not null,
  email      text,
  whatsapp   text,
  code       text unique not null default lower(encode(gen_random_bytes(4), 'hex')),
  source     text not null default 'review',                -- woher kam der Tippgeber
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table affiliates enable row level security;

alter table leads add column if not exists referred_by_affiliate uuid references affiliates(id);
create index if not exists leads_referred_by_idx on leads (referred_by_affiliate) where referred_by_affiliate is not null;

create table if not exists affiliate_payouts (
  id               uuid primary key default gen_random_uuid(),
  affiliate_id     uuid not null references affiliates(id) on delete cascade,
  referred_lead_id uuid references leads(id) on delete set null,
  amount           numeric not null default 1000,
  status           text not null default 'offen',   -- offen|abgerechnet|bezahlt
  doc_no           text unique,
  doc_path         text,                            -- Abrechnungs-PDF (Bucket invoice-documents)
  payout_link      text,                            -- Revolut-Payout-Link (optional)
  emailed_at       timestamptz,
  paid_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (affiliate_id, referred_lead_id)           -- pro geworbenem Kunden genau 1 Auszahlung
);
alter table affiliate_payouts enable row level security;

-- Fragebogen: Empfehlungs-Frage + Verknuepfung zum angelegten Tippgeber
alter table review_requests add column if not exists recommend boolean;
alter table review_requests add column if not exists affiliate_id uuid references affiliates(id);

-- Provisions-Scan alle 30 Minuten: Deals geworbener Kunden in Phase
-- provision_erhalten → affiliate-api legt Auszahlung an und mailt die Abrechnung.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'hp-affiliate-scan') then
      perform cron.schedule('hp-affiliate-scan', '*/30 * * * *', $cron$
        select net.http_post(
          url    := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/affiliate-api',
          headers:= jsonb_build_object('Content-Type', 'application/json'),
          body   := jsonb_build_object('action', 'commission_scan', 'secret', 'hp-affiliate-cron-2026')
        );
      $cron$);
    end if;
  end if;
end $$;
