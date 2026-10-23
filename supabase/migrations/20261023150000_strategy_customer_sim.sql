-- Strategie-Simulator für Kunden (Sven 23.10.2026)
-- „Simulator freischalten" im CRM gibt dem Kunden unter /simulator/:token
-- einen eigenen Simulator. Seine Eingaben werden gespeichert (customer_config),
-- damit Sven im Kundenprofil sieht, was sich der Kunde selbst gebaut hat.
-- Sven's eigener Fahrplan (config) bleibt dabei unverändert.

alter table public.crm_strategy_scenarios
  add column if not exists sim_enabled_at timestamptz,
  add column if not exists customer_config jsonb,
  add column if not exists customer_updated_at timestamptz;

-- Kunde: Plan + eigene Variante, nur wenn freigeschaltet
create or replace function public.get_strategy_sim(p_token text)
returns table(token text, title text, recipient_name text, config jsonb, customer_config jsonb, customer_updated_at timestamptz)
language sql stable security definer set search_path to 'public'
as $$
  select s.token, s.title, s.recipient_name, s.config, s.customer_config, s.customer_updated_at
  from crm_strategy_scenarios s
  where s.token = p_token and s.sim_enabled_at is not null
  limit 1;
$$;

-- Kunde: eigene Variante speichern. Nur freigeschaltete Pläne, nur ein
-- Objekt mit Wohnungsliste, Größe begrenzt.
create or replace function public.save_strategy_sim(p_token text, p_config jsonb)
returns timestamptz
language plpgsql security definer set search_path to 'public'
as $$
declare v timestamptz;
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object'
     or jsonb_typeof(p_config->'unitsV2') is distinct from 'array'
     or jsonb_array_length(p_config->'unitsV2') > 40
     or pg_column_size(p_config) > 300000 then
    raise exception 'invalid config';
  end if;
  update crm_strategy_scenarios
     set customer_config = p_config, customer_updated_at = now()
   where token = p_token and sim_enabled_at is not null
  returning customer_updated_at into v;
  if v is null then raise exception 'not found'; end if;
  return v;
end;
$$;

-- Team: Variante des Kunden ansehen (Druckansicht /strategie/:token?kunde=1)
create or replace function public.get_strategy_customer_version(p_token text)
returns table(token text, title text, recipient_name text, customer_config jsonb, customer_updated_at timestamptz)
language sql stable security definer set search_path to 'public'
as $$
  select s.token, s.title, s.recipient_name, s.customer_config, s.customer_updated_at
  from crm_strategy_scenarios s
  where s.token = p_token
    and (current_user_role() = any (array['admin'::text, 'verwalter'::text]) or current_user_has_perm('decks'::text))
  limit 1;
$$;

revoke all on function public.get_strategy_sim(text) from public;
revoke all on function public.save_strategy_sim(text, jsonb) from public;
revoke all on function public.get_strategy_customer_version(text) from public;
grant execute on function public.get_strategy_sim(text) to anon, authenticated;
grant execute on function public.save_strategy_sim(text, jsonb) to anon, authenticated;
grant execute on function public.get_strategy_customer_version(text) to authenticated;
