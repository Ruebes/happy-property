-- Sales Deck im Stil der Projektseite (Sven 20.10.2026: "ab sofort alle Sales Decks in diesem Stil").
-- Die Inhalte der Website-Projektseite liegen strukturiert in crm_projects.deck_assets.page
-- (erzeugt von ~/Claude/website-projekte/seite.py). Das öffentliche Deck holt sie über den
-- Deck-Token. Es geht nur der Seiteninhalt raus, der ohnehin öffentlich auf der Website steht.
create or replace function public.get_deck_page(p_token text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select p.deck_assets -> 'page'
  from sales_decks d
  join crm_projects p on p.id = d.project_id
  where d.token = p_token
  limit 1;
$$;

comment on function public.get_deck_page(text) is
  'Projektseite (deck_assets.page) zum Deck-Token, für die Website-Darstellung im Sales Deck (src/pages/deckWeb.tsx).';

revoke all on function public.get_deck_page(text) from public;
grant execute on function public.get_deck_page(text) to anon, authenticated;
