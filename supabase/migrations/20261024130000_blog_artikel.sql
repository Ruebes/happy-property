-- Blog-Autopilot: Prüfwarteschlange für KI-Blogartikel (steuervorteil-zypern-immobilien.com)
--
-- Der Blog-Autopilot (GitHub Ruebes/hp-blog-autopilot) liefert jeden geprüften Artikel über die
-- Edge Function blog-autopilot hier ab (Status 'ungeprueft', WordPress-Entwurf liegt schon an).
-- Sven gibt im Hub frei oder lehnt ab. Freigegebene Artikel bekommen den nächsten freien
-- Montagstermin 07:00 Zypern; der tägliche Lauf plant sie in WordPress ein und legt die
-- Social-Posts an (status 'geplant'), nach dem Termin wird 'veroeffentlicht' gesetzt.
-- Schalter crm_settings.blog_autopilot.enabled = Autobetrieb (ohne Prüfung freigeben), Standard aus.

create table if not exists public.blog_artikel (
  id               uuid primary key default gen_random_uuid(),
  status           text not null default 'ungeprueft'
                   check (status in ('ungeprueft', 'freigegeben', 'geplant', 'veroeffentlicht', 'abgelehnt', 'fehler')),
  titel            text not null,
  slug             text not null,
  thema_id         text,
  lauf             text,
  anriss           text,
  vorschau_html    text,
  beitragsbild_url text,
  wp_post_id       integer,
  wp_link          text,
  punkte           jsonb not null default '{}'::jsonb,
  bericht_md       text,
  social           jsonb not null default '{}'::jsonb,
  social_post_ids  uuid[] not null default '{}',
  geplant_fuer     timestamptz,
  freigegeben_am   timestamptz,
  freigegeben_von  uuid,
  abgelehnt_grund  text,
  fehler           text,
  kosten_usd       numeric(8, 2),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists blog_artikel_status_idx on public.blog_artikel (status, geplant_fuer);
create unique index if not exists blog_artikel_termin_idx on public.blog_artikel (geplant_fuer)
  where status in ('freigegeben', 'geplant', 'veroeffentlicht');

alter table public.blog_artikel enable row level security;
drop policy if exists blog_artikel_lesen on public.blog_artikel;
create policy blog_artikel_lesen on public.blog_artikel for select
  using ((select public.current_user_role()) in ('admin', 'verwalter'));
-- Schreiben nur über die Funktionen unten (security definer) und die Edge Function (service role).

-- Nächster freier Veröffentlichungstermin: Montag 07:00 Zypern, frühestens 36 Stunden ab jetzt.
create or replace function public.blog_naechster_termin()
returns timestamptz
language plpgsql stable security definer set search_path = public
as $$
declare
  tag date := (now() at time zone 'Asia/Nicosia')::date;
  t   timestamptz;
begin
  for i in 1..400 loop
    tag := tag + 1;
    if extract(isodow from tag) = 1 then
      t := (tag::timestamp + time '07:00') at time zone 'Asia/Nicosia';
      if t > now() + interval '36 hours' and not exists (
        select 1 from blog_artikel
        where status in ('freigegeben', 'geplant', 'veroeffentlicht') and geplant_fuer = t
      ) then
        return t;
      end if;
    end if;
  end loop;
  return null;
end $$;

create or replace function public.blog_freigeben(p_id uuid)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare t timestamptz;
begin
  if (select public.current_user_role()) not in ('admin', 'verwalter') then
    raise exception 'keine Berechtigung';
  end if;
  t := public.blog_naechster_termin();
  update blog_artikel
     set status = 'freigegeben', geplant_fuer = t, freigegeben_am = now(),
         freigegeben_von = auth.uid(), abgelehnt_grund = null, updated_at = now()
   where id = p_id and status in ('ungeprueft', 'abgelehnt');
  if not found then raise exception 'Artikel nicht freigebbar'; end if;
  return t;
end $$;

create or replace function public.blog_ablehnen(p_id uuid, p_grund text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if (select public.current_user_role()) not in ('admin', 'verwalter') then
    raise exception 'keine Berechtigung';
  end if;
  update blog_artikel
     set status = 'abgelehnt', abgelehnt_grund = nullif(trim(p_grund), ''), geplant_fuer = null,
         updated_at = now()
   where id = p_id and status in ('ungeprueft', 'freigegeben');
  if not found then raise exception 'Artikel kann nicht mehr abgelehnt werden'; end if;
end $$;

-- Freigabe zurücknehmen, solange der Artikel noch nicht in WordPress eingeplant ist
create or replace function public.blog_zuruecknehmen(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if (select public.current_user_role()) not in ('admin', 'verwalter') then
    raise exception 'keine Berechtigung';
  end if;
  update blog_artikel
     set status = 'ungeprueft', geplant_fuer = null, freigegeben_am = null, freigegeben_von = null,
         updated_at = now()
   where id = p_id and status = 'freigegeben';
  if not found then raise exception 'Artikel ist schon eingeplant'; end if;
end $$;

revoke all on function public.blog_naechster_termin() from public, anon;
revoke all on function public.blog_freigeben(uuid) from public, anon;
revoke all on function public.blog_ablehnen(uuid, text) from public, anon;
revoke all on function public.blog_zuruecknehmen(uuid) from public, anon;
grant execute on function public.blog_freigeben(uuid) to authenticated;
grant execute on function public.blog_ablehnen(uuid, text) to authenticated;
grant execute on function public.blog_zuruecknehmen(uuid) to authenticated;
grant execute on function public.blog_naechster_termin() to authenticated, service_role;

insert into public.crm_settings (key, value)
values ('blog_autopilot', '{"enabled": false, "vorrat": 4}')
on conflict (key) do nothing;

-- Kategorie für die Social-Posts zu Blogartikeln (Social Studio zeigt sie mit Symbol an)
insert into public.social_topics (key, label, icon, sort)
values ('blog', 'Blogartikel', '📝', 42)
on conflict (key) do nothing;
