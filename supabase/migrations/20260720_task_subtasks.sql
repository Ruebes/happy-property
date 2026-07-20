-- Teilaufgaben (Zuarbeit) + Fertigmeldung an den Aufgabengeber (20.07.2026)
--
-- Sven: „Wer eine Aufgabe übernommen hat, soll jemandem aus dem Team eine
-- Teilaufgabe zur Zuarbeit stellen können; der nimmt sie an und markiert sie nach
-- Fertigstellung als erledigt. Dann bekommt der Aufgabengeber eine WhatsApp."
--
-- Datenmodell: eine Teilaufgabe IST eine Aufgabe mit Elternteil. Damit erbt sie den
-- kompletten, bereits gehärteten Apparat — Annehmen/Erledigen, Chat, Token-Link
-- /t/<token>, Mail- und WhatsApp-Antworten, Erinnerungen, Popups. Eine eigene
-- Tabelle müsste all das ein zweites Mal bauen und wäre eine driftende Kopie
-- desselben Konzepts (wie seinerzeit properties vs. crm_project_units).

alter table crm_tasks add column if not exists parent_task_id uuid references crm_tasks(id) on delete cascade;
alter table crm_tasks drop constraint if exists crm_tasks_no_self_parent;
alter table crm_tasks add constraint crm_tasks_no_self_parent check (parent_task_id is null or parent_task_id <> id);
create index if not exists idx_crm_tasks_parent on crm_tasks(parent_task_id) where parent_task_id is not null;

-- Riegel gegen Doppelmeldungen. Es gibt DREI Wege auf status='erledigt'
-- (In-App-Button, Drag & Drop, Token-Link) plus den 5-Minuten-Sweep; alle rufen
-- dieselbe Stelle, aber nur wer den Übergang null → jetzt gewinnt, verschickt.
alter table crm_tasks add column if not exists done_notified_at timestamptz;

-- WICHTIG: Bestand vorbelegen. Ohne das würde der erste Sweep-Lauf für JEDE jemals
-- erledigte Aufgabe eine Meldung verschicken.
update crm_tasks set done_notified_at = now() where status = 'erledigt' and done_notified_at is null;

-- Teilnehmer der Hauptaufgabe dürfen deren Teilaufgaben sehen — sonst sieht der
-- Aufgabengeber die Zuarbeit nicht, die in seiner eigenen Aufgabe entstanden ist.
-- Bewusst über die ELTERN-Zeile: ein Selbstbezug auf crm_tasks in der eigenen
-- SELECT-Policy bricht INSERT … RETURNING (siehe 20260716_task_rls_returning_fix.sql).
create or replace function hp_parent_task_participant(p uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from crm_tasks t where t.id = p and (t.created_by = auth.uid() or t.assigned_to = auth.uid()))
      or exists (select 1 from crm_task_assignees a where a.task_id = p and a.profile_id = auth.uid())
$$;

drop policy if exists crm_tasks_select on crm_tasks;
create policy crm_tasks_select on crm_tasks for select to authenticated using (
  created_by = auth.uid() or assigned_to = auth.uid() or my_task_assignee(id)
  or (parent_task_id is not null and hp_parent_task_participant(parent_task_id))
);

-- Nachgezogen nach der Gegenpruefung: eine Teilaufgabe darf nur an eine Aufgabe
-- gehaengt werden, an der ich selbst beteiligt bin — sonst koennte jemand fremde
-- Aufgaben mit Eintraegen bestuecken.
drop policy if exists crm_tasks_insert on crm_tasks;
create policy crm_tasks_insert on crm_tasks for insert to authenticated with check (
  created_by = auth.uid()
  and (parent_task_id is null or hp_parent_task_participant(parent_task_id))
);
