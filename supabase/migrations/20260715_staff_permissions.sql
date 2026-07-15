-- ── Mitarbeiter-Rollen + feingranulare Rechte ───────────────────────────────
-- Neue Rolle 'mitarbeiter': interne Angestellte mit einzeln zuschaltbaren Bereichen.
-- permissions = { pipeline, funnel, decks, invoices, contacts } (jeweils true/false).
-- Admin/Verwalter behalten Vollzugriff; Mitarbeiter sehen nur freigeschaltete Bereiche.

alter table profiles add column if not exists permissions jsonb not null default '{}'::jsonb;

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role = any (array['admin','verwalter','eigentuemer','feriengast','funnel','mitarbeiter']));

-- Helfer für RLS: hat der aktuelle Nutzer Zugriff auf einen Bereich?
-- Admin/Verwalter immer; Mitarbeiter nur bei gesetztem Recht.
create or replace function current_user_has_perm(area text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles p
    where p.id = auth.uid()
      and (
        p.role in ('admin','verwalter')
        or (p.role = 'mitarbeiter' and coalesce((p.permissions ->> area)::boolean, false))
      )
  )
$$;

grant execute on function current_user_has_perm(text) to authenticated, service_role;
