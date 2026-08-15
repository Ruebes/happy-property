-- Strategie-Plan fuer den Kunden freigeben: Token + oeffentlicher Abruf
-- (Muster: property_calculations + get_calculation_by_token).
-- shared_at IS NULL => Link liefert nichts (Entwurf bleibt privat).
alter table crm_strategy_scenarios
  add column if not exists token text unique default encode(gen_random_bytes(9), 'hex'),
  add column if not exists title text,
  add column if not exists recipient_name text,
  add column if not exists shared_at timestamptz;

update crm_strategy_scenarios set token = encode(gen_random_bytes(9), 'hex') where token is null;

create or replace function get_strategy_by_token(p_token text)
returns table (token text, title text, recipient_name text, config jsonb, updated_at timestamptz)
language sql security definer stable set search_path = public as $$
  select s.token, s.title, s.recipient_name, s.config, s.updated_at
  from crm_strategy_scenarios s
  where s.token = p_token and s.shared_at is not null
  limit 1;
$$;
grant execute on function get_strategy_by_token(text) to anon, authenticated;
