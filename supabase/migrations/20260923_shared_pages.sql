-- Freigabe-Seiten: einzelne, fertig gestaltete HTML-Seiten (z. B. ein
-- persoenliches Angebot) per Token-Link an Kunden, etwa per WhatsApp.
-- Oeffentliche Seite: /seite/:token im CRM (die Supabase-Domains liefern
-- text/html nur als text/plain aus, daher rendert das CRM wie beim Report).
-- Jede Seite hat ein Ablaufdatum: danach liefert die RPC nichts mehr aus,
-- und ein taeglicher Cron loescht die Zeile endgueltig.
create table if not exists public.shared_pages (
  id uuid primary key default gen_random_uuid(),
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  title text not null,
  html text not null,
  note text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Keine Policies: anon/authenticated lesen nur ueber die RPC,
-- geschrieben wird mit der Service-Role.
alter table public.shared_pages enable row level security;

create or replace function public.hp_shared_page(p_token text)
returns table (title text, html text)
language sql stable security definer set search_path = public as $$
  select sp.title, sp.html from public.shared_pages sp
  where sp.token = p_token and sp.expires_at > now();
$$;
revoke all on function public.hp_shared_page(text) from public;
grant execute on function public.hp_shared_page(text) to anon, authenticated, service_role;

create or replace function public.hp_shared_pages_purge()
returns void language sql security definer set search_path = public as $$
  delete from public.shared_pages where expires_at <= now();
$$;
revoke all on function public.hp_shared_pages_purge() from public, anon, authenticated;

-- pg_cron: taeglich 03:15 UTC abgelaufene Seiten loeschen (Job-Anlage idempotent).
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'hp-shared-pages-purge') then
      perform cron.schedule('hp-shared-pages-purge', '15 3 * * *', 'select public.hp_shared_pages_purge()');
    end if;
  end if;
end $$;
