-- Dokumenttypen für CRM-Einheiten erweitern (mietvertrag + rechnung)

ALTER TABLE crm_unit_documents
  DROP CONSTRAINT IF EXISTS crm_unit_documents_doc_type_check;

ALTER TABLE crm_unit_documents
  ADD CONSTRAINT crm_unit_documents_doc_type_check
  CHECK (doc_type = ANY (ARRAY[
    'kaufvertrag'::text,
    'mietvertrag'::text,
    'rechnung'::text,
    'zahlungsbeleg'::text,
    'grundriss'::text,
    'sonstiges'::text
  ]));
