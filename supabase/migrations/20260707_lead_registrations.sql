-- Registrierungen: bei welchem Developer ist der Kunde registriert (Provisionsschutz).
create table if not exists lead_registrations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  developer text not null,
  registered_at date not null default current_date,
  note text,
  created_at timestamptz not null default now(),
  unique (lead_id, developer)
);
alter table lead_registrations enable row level security;
create policy lead_registrations_rw on lead_registrations
  for all to authenticated using (true) with check (true);
