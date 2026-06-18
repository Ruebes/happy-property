-- Deck-Feinschliff: Lern-Speicher + Undo
-- deck_ai_rules: gelernte Vorgaben (z.B. "Karte immer als eigene Kachel"), fließen
-- in jedes künftige Deck (generate-deck + refine-deck) ein. scope='global' gilt überall.
create table if not exists deck_ai_rules (
  id         uuid primary key default gen_random_uuid(),
  scope      text not null default 'global',
  project_id uuid references crm_projects(id) on delete cascade,
  rule       text not null,
  active      boolean not null default true,
  created_at timestamptz not null default now()
);
alter table deck_ai_rules enable row level security;
drop policy if exists deck_ai_rules_all on deck_ai_rules;
create policy deck_ai_rules_all on deck_ai_rules for all to authenticated using (true) with check (true);

-- 1-Schritt-Undo fürs Feinschliff
alter table sales_decks add column if not exists prev_content jsonb;
