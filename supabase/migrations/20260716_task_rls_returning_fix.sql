-- Fix: crm_tasks-SELECT/UPDATE-Policy darf crm_tasks NICHT selbst re-queryen.
-- is_task_participant(id) fragt intern crm_tasks ab; bei INSERT … RETURNING ist die
-- eben eingefügte Zeile diesem SPI-Subquery per MVCC noch nicht sichtbar → Policy
-- liefert false → „new row violates row-level security policy". Das Frontend nutzt
-- .insert().select() (= RETURNING) → Anlegen scheiterte.
-- Lösung: created_by/assigned_to DIREKT auf der Zeile prüfen (kein Re-Query) +
-- Assignee-Check über Helper, der NUR crm_task_assignees liest.
create or replace function my_task_assignee(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from crm_task_assignees a where a.task_id = t and a.profile_id = auth.uid())
$$;
grant execute on function my_task_assignee(uuid) to authenticated;

drop policy if exists crm_tasks_select on crm_tasks;
create policy crm_tasks_select on crm_tasks for select to authenticated
  using (created_by = auth.uid() or assigned_to = auth.uid() or my_task_assignee(id));

drop policy if exists crm_tasks_update on crm_tasks;
create policy crm_tasks_update on crm_tasks for update to authenticated
  using (created_by = auth.uid() or assigned_to = auth.uid() or my_task_assignee(id))
  with check (created_by = auth.uid() or assigned_to = auth.uid() or my_task_assignee(id));
