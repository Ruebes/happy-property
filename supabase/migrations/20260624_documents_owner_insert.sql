-- 20260624_documents_owner_insert.sql
-- Eigentümer dürfen Dokumente/Rechnungen für IHRE EIGENE Immobilie anlegen.
-- Bug: Das "Neue Rechnung"-Modal in PropertyDetail wird auch Eigentümern gezeigt
-- (canEdit || isEigentuemer), aber documents hatte nur eine INSERT-Policy für
-- admin/verwalter → Eigentümer-Insert scheiterte mit
-- "new row violates row-level security policy for table 'documents'".
-- (Lesen war für Eigentümer schon erlaubt via documents_eigentuemer_select.)
-- Eng begrenzt: nur eigene Immobilie + uploaded_by = man selbst. Edit/Delete
-- bleibt admin/verwalter vorbehalten (UI zeigt Eigentümern auch nur "Hinzufügen").

drop policy if exists documents_eigentuemer_write on public.documents;
create policy documents_eigentuemer_write
on public.documents
for insert
with check (
  current_user_role() = 'eigentuemer'
  and uploaded_by = auth.uid()
  and exists (
    select 1 from public.properties p
    where p.id = documents.property_id
      and p.owner_id = auth.uid()
  )
);
