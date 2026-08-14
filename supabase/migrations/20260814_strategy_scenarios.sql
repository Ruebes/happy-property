-- Strategie-Simulator: EIN gespeichertes Szenario je Lead (Deck-Wizard-Haken).
-- config = { units: SimUnit[], params: {ek,growth,ltv,interest,rentGrowth,bundle} }
create table if not exists crm_strategy_scenarios (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  config jsonb not null,
  updated_at timestamptz not null default now(),
  unique (lead_id)
);
alter table crm_strategy_scenarios enable row level security;
create policy strategy_staff on crm_strategy_scenarios for all to authenticated
  using (current_user_role() = any (array['admin'::text,'verwalter'::text]))
  with check (current_user_role() = any (array['admin'::text,'verwalter'::text]));
create policy strategy_staff_perm on crm_strategy_scenarios for all to authenticated
  using (current_user_has_perm('decks'::text)) with check (current_user_has_perm('decks'::text));
