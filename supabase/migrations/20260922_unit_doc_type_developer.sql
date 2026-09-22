-- DevMails "Kunde zuordnen" schreibt doc_type 'developer'; der Check kannte den Wert nicht,
-- der Insert schlug still fehl (Fehler wurde im Frontend nicht geprüft).
alter table crm_unit_documents drop constraint if exists crm_unit_documents_doc_type_check;
alter table crm_unit_documents add constraint crm_unit_documents_doc_type_check
  check (doc_type = any (array['kaufvertrag','mietvertrag','rechnung','zahlungsbeleg','grundriss','developer','sonstiges']));
