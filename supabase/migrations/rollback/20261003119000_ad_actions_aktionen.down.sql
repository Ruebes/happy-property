-- Rückbau zu 20261003119000_ad_actions_aktionen.sql (von Hand ausführen; liegt im
-- Unterordner, damit die Supabase-CLI die Datei nicht als Migration einspielt).
-- Stellt ad_actions_action_check auf pause/activate zurück.
--
-- Bricht ab, wenn schon Zeilen mit neuen Aktionsarten existieren: das sind
-- Audit-Zeilen des Autopiloten und werden NICHT gelöscht. Dann zuerst klären
-- (z. B. Constraint mit NOT VALID neu anlegen, sodass nur neue Zeilen geprüft werden).
-- Reihenfolge Rückbau: 119000 -> 113000 -> 112000 -> 111000 -> 110000.

begin;

set local lock_timeout = '5s';

do $chk$
declare
  v_n int;
begin
  select count(*) into v_n from public.ad_actions where action not in ('pause', 'activate');
  if v_n > 0 then
    raise exception 'Es gibt % Aktionen mit neuen Aktionsarten (budget_set/ersatz_*). Nicht löschen, erst klären.', v_n;
  end if;
end
$chk$;

alter table public.ad_actions drop constraint if exists ad_actions_action_check;
alter table public.ad_actions add constraint ad_actions_action_check
  check (action in ('pause', 'activate'));

notify pgrst, 'reload schema';

commit;
