-- ── Aufgaben-System ─────────────────────────────────────────────────────────
-- Eigenständige Aufgaben (nicht an einen Lead gebunden), einem Mitarbeiter zugewiesen,
-- Pipeline gestellt → in Arbeit → erledigt. Erledigte werden zum Tagesende archiviert.
-- Sichtbarkeit: nur selbst gestellte (created_by) ODER selbst zugewiesene (assigned_to).

create table if not exists crm_tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  created_by    uuid not null references profiles(id) on delete cascade,
  assigned_to   uuid not null references profiles(id) on delete cascade,
  status        text not null default 'offen' check (status in ('offen','in_arbeit','erledigt')),
  archived      boolean not null default false,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_crm_tasks_assigned on crm_tasks(assigned_to) where not archived;
create index if not exists idx_crm_tasks_creator  on crm_tasks(created_by)  where not archived;

create table if not exists crm_task_messages (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references crm_tasks(id) on delete cascade,
  sender_id     uuid not null references profiles(id) on delete cascade,
  recipient_id  uuid not null references profiles(id) on delete cascade,
  body          text not null,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_task_msg_task on crm_task_messages(task_id);
create index if not exists idx_task_msg_unread on crm_task_messages(recipient_id) where read_at is null;

alter table crm_tasks enable row level security;
alter table crm_task_messages enable row level security;

-- Aufgaben: nur eigene (gestellt oder zugewiesen)
drop policy if exists crm_tasks_select on crm_tasks;
create policy crm_tasks_select on crm_tasks for select to authenticated
  using (created_by = auth.uid() or assigned_to = auth.uid());
drop policy if exists crm_tasks_insert on crm_tasks;
create policy crm_tasks_insert on crm_tasks for insert to authenticated
  with check (created_by = auth.uid());
drop policy if exists crm_tasks_update on crm_tasks;
create policy crm_tasks_update on crm_tasks for update to authenticated
  using (created_by = auth.uid() or assigned_to = auth.uid())
  with check (created_by = auth.uid() or assigned_to = auth.uid());
drop policy if exists crm_tasks_delete on crm_tasks;
create policy crm_tasks_delete on crm_tasks for delete to authenticated
  using (created_by = auth.uid());

-- Task-Nachrichten: Sender oder Empfänger
drop policy if exists task_msg_select on crm_task_messages;
create policy task_msg_select on crm_task_messages for select to authenticated
  using (sender_id = auth.uid() or recipient_id = auth.uid());
drop policy if exists task_msg_insert on crm_task_messages;
create policy task_msg_insert on crm_task_messages for insert to authenticated
  with check (sender_id = auth.uid());
drop policy if exists task_msg_update on crm_task_messages;
create policy task_msg_update on crm_task_messages for update to authenticated
  using (recipient_id = auth.uid());

-- completed_at automatisch bei Wechsel auf/von 'erledigt'
create or replace function crm_tasks_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'erledigt' and (old.status is distinct from 'erledigt') then new.completed_at := now();
  elsif new.status <> 'erledigt' then new.completed_at := null; new.archived := false;
  end if;
  return new;
end $$;
drop trigger if exists trg_crm_tasks_touch on crm_tasks;
create trigger trg_crm_tasks_touch before update on crm_tasks
  for each row execute function crm_tasks_touch();

-- Mitarbeiter-Liste für die Zuweisung (id, Name, Rolle) — ohne profiles-RLS zu öffnen.
create or replace function list_staff()
returns table(id uuid, full_name text, email text, role text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.email, p.role
  from profiles p
  where p.role in ('admin','verwalter','mitarbeiter','funnel') and coalesce(p.is_active, true)
  order by p.full_name
$$;
grant execute on function list_staff() to authenticated;
