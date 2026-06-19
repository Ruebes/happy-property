-- Rendite-Rechnung / Immobilienvergleich (öffentliche HTML-Microsite, wie sales_decks).
-- content jsonb hält { with_calc, recipient_name, briefing?, tagline?, intro?, items[] };
-- jedes item enthält die CalcParams (src/lib/rechner.ts), aus denen die Render-Seite
-- /rechnung/:token live mit der verifizierten Engine rechnet (single source of truth).
create table if not exists property_calculations (
  id uuid primary key default gen_random_uuid(),
  token text unique default encode(gen_random_bytes(9), 'hex'),
  lead_id uuid references leads(id) on delete set null,
  recipient_name text,
  title text,
  with_calc boolean default true,
  content jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz default now()
);

alter table property_calculations enable row level security;
drop policy if exists pc_auth_all on property_calculations;
create policy pc_auth_all on property_calculations for all to authenticated using (true) with check (true);

-- Anonymer Token-Abruf für die öffentliche Seite (kein Login)
create or replace function get_calculation_by_token(p_token text)
returns property_calculations language sql security definer stable as $$
  select * from property_calculations where token = p_token limit 1;
$$;
grant execute on function get_calculation_by_token(text) to anon, authenticated;
