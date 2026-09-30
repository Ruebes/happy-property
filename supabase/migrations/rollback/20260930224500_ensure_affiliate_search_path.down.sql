-- Rückbau zu 20260930224500_ensure_affiliate_search_path.sql (von Hand
-- ausführen, liegt bewusst in einem Unterordner, damit die Supabase-CLI die
-- Datei nicht als Migration einspielt). Setzt den search_path von
-- ensure_affiliate wieder auf den Stand vom 4.9. (nur public). Damit ist auch
-- der Fehler "gen_random_bytes(integer) does not exist" wieder da.

do $$
begin
  if to_regprocedure('public.ensure_affiliate(uuid, uuid, text, text, text, text)') is not null then
    alter function public.ensure_affiliate(uuid, uuid, text, text, text, text)
      set search_path = public;
  end if;
end
$$;
