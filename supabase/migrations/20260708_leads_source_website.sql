-- Funnel-Bug: leads_source_check kannte 'website' nicht → funnel-api contact
-- konnte NEUE Leads nicht anlegen (Bestands-Matches funktionierten, darum
-- fiel es in den E2E-Tests erst spät auf). 'website' = eigener Termin-Funnel /termin.
alter table leads drop constraint if exists leads_source_check;
alter table leads add constraint leads_source_check
  check (source in ('meta','google','empfehlung','sonstiges','calendly','typeform','hubspot','website'));
