-- Sicherheits-Härtung: profiles.role darf nur von Admins (oder der Service-Role)
-- geändert werden. Vorher konnte sich JEDER eingeloggte Nutzer über die eigene
-- Update-Policy (profiles_own_update, nur USING id = auth.uid(), kein WITH CHECK)
-- per PATCH selbst role='admin' geben — und damit alle admin-gegateten Edge
-- Functions (google-calendar, admin-user-ops, …) passieren.
--
-- Trigger statt REVOKE UPDATE(role): das Admin-UI (Users.tsx) ändert Rollen
-- legitim über PostgREST — ein Spalten-Revoke würde diesen Flow brechen.
CREATE OR REPLACE FUNCTION public.fn_protect_profile_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    -- Service-Role / interne Jobs (kein JWT-Kontext) dürfen immer
    IF auth.uid() IS NULL THEN
      RETURN NEW;
    END IF;
    -- Sonst nur, wenn der AUFRUFER selbst Admin ist
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    ) THEN
      RAISE EXCEPTION 'Rollenänderung nicht erlaubt';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_role ON public.profiles;
CREATE TRIGGER trg_protect_profile_role
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_profile_role();
