-- Kunden-Sperre: zwei kleine Hilfsfunktionen, keine Datenänderung.

-- Beendet alle Sitzungen eines Nutzers. auth.sessions ist über PostgREST nicht erreichbar;
-- Refresh-Tokens und MFA-Einträge hängen per Cascade an der Sitzung. Nur für admin-user-ops
-- (Service-Rolle), deshalb ausdrücklich auch anon und authenticated entziehen.
create or replace function public.revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  anzahl integer;
begin
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics anzahl = row_count;
  return anzahl;
end;
$$;

revoke all on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;

-- Ist der Kunde hinter einem Lead gesperrt? Mitarbeiter dürfen fremde Profile nicht lesen
-- (RLS), die Upload-Mail im Projekt muss es aber wissen. Liefert nur ja/nein und nur für
-- interne Rollen. Gleiche Regel wie leadGesperrt in _shared/kontoSperre.ts.
create or replace function public.lead_konto_gesperrt(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.leads l
    join public.profiles p on p.is_active = false
    where l.id = p_lead_id
      and public.current_user_role() in ('admin', 'verwalter', 'mitarbeiter')
      and (
        p.id = l.profile_id
        or regexp_replace(lower(trim(p.email)), '@googlemail\.com$', '@gmail.com') in (
          select regexp_replace(lower(trim(a)), '@googlemail\.com$', '@gmail.com')
          from unnest(array_append(coalesce(l.alt_emails, '{}'::text[]), l.email)) as a
        )
      )
  );
$$;

revoke all on function public.lead_konto_gesperrt(uuid) from public, anon;
grant execute on function public.lead_konto_gesperrt(uuid) to authenticated;

notify pgrst, 'reload schema';
