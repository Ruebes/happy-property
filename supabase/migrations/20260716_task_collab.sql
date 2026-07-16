-- ── Aufgaben-Kollaboration ──────────────────────────────────────────────────
-- Mehrere Zuständige (intern + extern), Kunden-Verknüpfung, Annahme/Abschluss,
-- Token-Links für externe Erledigung/Antwort.

alter table crm_tasks alter column assigned_to drop not null;
alter table crm_tasks
  add column if not exists accepted_at  timestamptz,
  add column if not exists accepted_by  uuid references profiles(id),
  add column if not exists completed_by uuid references profiles(id);

-- Zuständige: intern (profile_id) ODER extern (ext_*). channel steuert den Versand.
create table if not exists crm_task_assignees (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null references crm_tasks(id) on delete cascade,
  profile_id      uuid references profiles(id) on delete cascade,
  ext_name        text,
  ext_email       text,
  ext_phone       text,
  channel         text not null default 'system' check (channel in ('system','mail','whatsapp','both')),
  token           text not null default substr(replace(gen_random_uuid()::text,'-',''),1,12),
  accepted_at     timestamptz,
  last_reminded_at timestamptz,
  notified_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists idx_task_assignee_task    on crm_task_assignees(task_id);
create index if not exists idx_task_assignee_profile on crm_task_assignees(profile_id) where profile_id is not null;
create unique index if not exists idx_task_assignee_token on crm_task_assignees(token);

-- Verknüpfte Kunden (Leads): deren Kontaktdaten erscheinen in der Aufgabe.
create table if not exists crm_task_leads (
  task_id  uuid not null references crm_tasks(id) on delete cascade,
  lead_id  uuid not null references leads(id) on delete cascade,
  primary key (task_id, lead_id)
);

-- Nachrichten: sender_id nullable (externe Absender) + Klartext-Label.
alter table crm_task_messages alter column sender_id drop not null;
alter table crm_task_messages add column if not exists sender_label text;

-- Teilnehmer einer Aufgabe (Ersteller, Alt-assigned_to, oder Zuständiger).
-- SECURITY DEFINER → umgeht RLS in den Unterabfragen, keine Rekursion.
create or replace function is_task_participant(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from crm_tasks x where x.id = t and (x.created_by = auth.uid() or x.assigned_to = auth.uid()))
      or exists (select 1 from crm_task_assignees a where a.task_id = t and a.profile_id = auth.uid())
$$;
grant execute on function is_task_participant(uuid) to authenticated;

-- crm_tasks-RLS auf Teilnehmer erweitern (Mehrfach-Zuständige)
drop policy if exists crm_tasks_select on crm_tasks;
create policy crm_tasks_select on crm_tasks for select to authenticated
  using (is_task_participant(id));
drop policy if exists crm_tasks_update on crm_tasks;
create policy crm_tasks_update on crm_tasks for update to authenticated
  using (is_task_participant(id)) with check (is_task_participant(id));
-- insert/delete-Policies (created_by) bleiben aus 20260715_tasks.sql bestehen.

alter table crm_task_assignees enable row level security;
alter table crm_task_leads     enable row level security;

-- Assignees: sichtbar für Teilnehmer; verwaltet vom Ersteller; eigene Zeile updatebar.
drop policy if exists task_assignee_select on crm_task_assignees;
create policy task_assignee_select on crm_task_assignees for select to authenticated
  using (is_task_participant(task_id));
drop policy if exists task_assignee_write on crm_task_assignees;
create policy task_assignee_write on crm_task_assignees for all to authenticated
  using (exists (select 1 from crm_tasks x where x.id = task_id and x.created_by = auth.uid()) or profile_id = auth.uid())
  with check (exists (select 1 from crm_tasks x where x.id = task_id and x.created_by = auth.uid()) or profile_id = auth.uid());

-- Verknüpfte Kunden: sichtbar für Teilnehmer, verwaltet vom Ersteller.
drop policy if exists task_lead_select on crm_task_leads;
create policy task_lead_select on crm_task_leads for select to authenticated
  using (is_task_participant(task_id));
drop policy if exists task_lead_write on crm_task_leads;
create policy task_lead_write on crm_task_leads for all to authenticated
  using (exists (select 1 from crm_tasks x where x.id = task_id and x.created_by = auth.uid()))
  with check (exists (select 1 from crm_tasks x where x.id = task_id and x.created_by = auth.uid()));

-- Nachrichten für alle Teilnehmer sichtbar (statt nur sender/recipient).
drop policy if exists task_msg_select on crm_task_messages;
create policy task_msg_select on crm_task_messages for select to authenticated
  using (is_task_participant(task_id));
