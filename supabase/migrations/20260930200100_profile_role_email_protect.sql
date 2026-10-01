-- Sicherheits-Review S1 (30.9.2026): Rolle und Login-Adresse im Profil schützen.
--
-- 1) handle_new_user: Die Rolle kam bisher aus raw_user_meta_data->>'role'. Diese
--    Metadaten setzt bei der Selbstregistrierung (POST /auth/v1/signup mit
--    options.data) der Nutzer selbst. Wer sich mit {role:'admin'} registrierte
--    und die eigene Mail bestätigte, war Admin (Befund S1-2). Jetzt immer
--    'eigentuemer'. Alle Anlage-Wege im Repo (admin-user-ops create/invite_feriengast,
--    create-eigentuemer-access) schicken keine Rolle in den Metadaten mit und
--    setzen die Rolle danach per Service-Role-Upsert auf profiles, daran ändert
--    sich nichts. Stand 30.9.: kein Profil hat eine Rolle aus den Metadaten außer
--    dem ersten Admin-Konto vom 27.3. (bleibt unverändert, der Trigger läuft nur
--    beim Anlegen).
--
-- 2) fn_protect_profile_role: profiles.email war per profiles_own_update vom
--    Nutzer selbst änderbar. admin-user-ops und invite-co-owner suchten Konten
--    über profiles.email, ein Eigentümer konnte so fremde Einladungen auf sein
--    Konto lenken (Befund E2-5/E2-6). Jetzt gehört email zu den geschützten
--    Feldern: ändern dürfen nur Admin oder Service-Role (kein JWT). Kein Formular
--    im Portal ändert profiles.email (Profile.tsx, PropertyDetail.tsx, Users.tsx
--    schicken das Feld nicht mit), und es gibt keinen Sync-Trigger von auth.users.
--    Rumpf sonst identisch mit 20260828_owner_portal_hardening.sql (= live).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, phone, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'phone',
    'eigentuemer'   -- nie aus den vom Nutzer setzbaren Metadaten
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.fn_protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (NEW.role            is distinct from OLD.role)
     or (NEW.permissions  is distinct from OLD.permissions)
     or (NEW.is_active    is distinct from OLD.is_active)
     or (NEW.verwaltung_id is distinct from OLD.verwaltung_id)
     or (NEW.email        is distinct from OLD.email)
  then
    -- Service-Role / interne Jobs (kein JWT-Kontext) dürfen immer
    if auth.uid() is null then
      return NEW;
    end if;
    -- Sonst nur, wenn der AUFRUFER selbst Admin ist
    if not exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'admin'
    ) then
      raise exception 'Änderung sicherheitsrelevanter Profilfelder nicht erlaubt';
    end if;
  end if;
  return NEW;
end;
$$;
