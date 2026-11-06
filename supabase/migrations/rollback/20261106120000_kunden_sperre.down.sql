drop function if exists public.lead_konto_gesperrt(uuid);
drop function if exists public.revoke_user_sessions(uuid);

notify pgrst, 'reload schema';
