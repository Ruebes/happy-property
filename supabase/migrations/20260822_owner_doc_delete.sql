-- Eigentuemer konnten Dokumente an ihrem eigenen Objekt nicht loeschen, sobald
-- WIR sie hochgeladen hatten: die Policy verlangte uploaded_by = auth.uid().
-- RLS filtert die Zeile dann still weg - PostgREST meldet 0 Zeilen OHNE Fehler,
-- die Oberflaeche zeigte "geloescht" und nichts passierte (Thorsten Brendel,
-- falscher Lofos-Kaufvertrag vom 18.07., gemeldet 22.08.2026).
-- Neu: Wer Eigentuemer des Objekts ist, darf dessen Dokumente loeschen - egal
-- wer sie hochgeladen hat.
drop policy if exists crm_unit_docs_eigentuemer_delete on crm_unit_documents;
create policy crm_unit_docs_eigentuemer_delete on crm_unit_documents for delete to authenticated
using (
  unit_id in (
    select u.id from crm_project_units u
    join properties p on p.id = u.property_id
    where p.owner_id = auth.uid()
  )
);
