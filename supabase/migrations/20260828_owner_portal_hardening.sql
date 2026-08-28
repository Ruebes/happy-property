-- Eigentümerportal-Härtung (Audit 28.08.2026)
-- 1) Eigentümer dürfen Rechnungen in den documents-Bucket hochladen (nur für ihre eigene Wohnung)
-- 2) task-attachments: offene Insert/Delete-Rechte einschränken (kein Fremdzugriff mehr)
-- 3) crm_task_attachments-Tabelle: Vollzugriff-Policy auf Staff + eigenen Bug-Report begrenzen
-- 4) profiles: Selbst-Rechteausweitung (role/permissions/is_active/verwaltung_id) unterbinden

-- ── 1) documents-Storage: Eigentümer-Upload für eigene Wohnung ────────────────
-- Pfad-Konvention: "<property_id>/<datei>". Lesen ist bereits owner-scoped (docs_storage_read).
drop policy if exists docs_storage_owner_insert on storage.objects;
create policy docs_storage_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and current_user_role() = 'eigentuemer'
    and exists (
      select 1 from properties p
      where p.id::text = split_part(name, '/', 1)
        and p.owner_id = auth.uid()
    )
  );

-- upsert:true beim Ersetzen einer Datei braucht auch UPDATE
drop policy if exists docs_storage_owner_update on storage.objects;
create policy docs_storage_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and current_user_role() = 'eigentuemer'
    and exists (
      select 1 from properties p
      where p.id::text = split_part(name, '/', 1)
        and p.owner_id = auth.uid()
    )
  );

-- ── 2) task-attachments-Storage: nur Staff, plus eigener Bug-Screenshot-Pfad ──
-- Bug-Screenshots aus dem Portal liegen unter "bug/<profile_id>/…" (Eigentümer legt sie an).
-- Aufgaben-Anhänge im CRM liegen unter "<task_id>/…" (nur Staff).
drop policy if exists ta_bucket_upload on storage.objects;
create policy ta_bucket_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'task-attachments'
    and (
      current_user_role() = any (array['admin','verwalter','mitarbeiter'])
      or (name like 'bug/' || auth.uid()::text || '/%')
    )
  );

drop policy if exists ta_bucket_delete on storage.objects;
create policy ta_bucket_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'task-attachments'
    and current_user_role() = any (array['admin','verwalter','mitarbeiter'])
  );

-- ── 3) crm_task_attachments-Tabelle: cta_all (true/true) ersetzen ─────────────
-- Portal-Bug-Anhänge werden serverseitig (Service-Role, owner-content) eingefügt und
-- umgehen RLS. Frontend-Zugriff auf diese Tabelle ist Staff-only (Tasks.tsx), plus der
-- Melder darf die Anhänge seines eigenen Bug-Reports sehen.
drop policy if exists cta_all on crm_task_attachments;

drop policy if exists cta_staff_all on crm_task_attachments;
create policy cta_staff_all on crm_task_attachments
  for all to authenticated
  using (current_user_role() = any (array['admin','verwalter','mitarbeiter']))
  with check (current_user_role() = any (array['admin','verwalter','mitarbeiter']));

drop policy if exists cta_reporter_read on crm_task_attachments;
create policy cta_reporter_read on crm_task_attachments
  for select to authenticated
  using (
    exists (
      select 1 from crm_tasks tk
      where tk.id = crm_task_attachments.task_id
        and tk.reporter_profile_id = auth.uid()
    )
  );

-- ── 4) profiles: Selbst-Rechteausweitung unterbinden ─────────────────────────
-- Bisher schützte fn_protect_profile_role nur die Rolle. permissions/is_active/
-- verwaltung_id waren per Spalten-Grant + profiles_own_update selbst setzbar
-- (Mitarbeiter hätte sich alle Rechte geben können). Nun: nur Admin (oder
-- Service-Role ohne JWT) darf diese sicherheitsrelevanten Felder ändern.
create or replace function fn_protect_profile_role()
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
