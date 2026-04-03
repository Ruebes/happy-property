-- ============================================================
-- Happy Property – Migration 004
-- Bankverbindung in profiles + Benachrichtigungs-Tabelle
-- ============================================================

alter table public.profiles
  add column if not exists iban                text,
  add column if not exists bic                 text,
  add column if not exists bank_account_holder text;

create table if not exists public.bank_change_notifications (
  id             uuid        primary key default gen_random_uuid(),
  owner_id       uuid        not null references public.profiles(id) on delete cascade,
  old_iban_masked text,
  new_iban_masked text,
  changed_at     timestamptz not null default now(),
  confirmed_by   uuid        references public.profiles(id),
  confirmed_at   timestamptz,
  status         text        not null default 'pending'
                             check (status = 'pending' or status = 'confirmed')
);

alter table public.bank_change_notifications enable row level security;

create policy "admin_verwalter_read" on public.bank_change_notifications
  for select using (current_user_role() in ('admin','verwalter'));

create policy "owner_read_own" on public.bank_change_notifications
  for select using (owner_id = auth.uid());

create policy "admin_verwalter_update" on public.bank_change_notifications
  for update using (current_user_role() in ('admin','verwalter'));

create policy "owner_insert" on public.bank_change_notifications
  for insert with check (owner_id = auth.uid());
