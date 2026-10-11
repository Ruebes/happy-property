-- Freigabe-Seiten mit Rückmeldung (Sven 11.10.26: Kuutio soll Fragen abhaken,
-- Sven will sehen, was abgehakt ist). Antworten liegen in shared_pages.responses,
-- lesen/schreiben nur per Token und nur bis expires_at, max. 30 KB.
alter table public.shared_pages
  add column if not exists responses jsonb,
  add column if not exists responded_at timestamptz;

create or replace function public.hp_shared_page_responses(p_token text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select sp.responses from public.shared_pages sp where sp.token = p_token and sp.expires_at > now();
$$;

create or replace function public.hp_shared_page_respond(p_token text, p_data jsonb)
returns boolean language plpgsql security definer set search_path to 'public' as $$
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 30000 then return false; end if;
  update public.shared_pages set responses = p_data, responded_at = now()
   where token = p_token and expires_at > now();
  return found;
end;
$$;

revoke all on function public.hp_shared_page_responses(text) from public;
revoke all on function public.hp_shared_page_respond(text, jsonb) from public;
grant execute on function public.hp_shared_page_responses(text) to anon, authenticated;
grant execute on function public.hp_shared_page_respond(text, jsonb) to anon, authenticated;
