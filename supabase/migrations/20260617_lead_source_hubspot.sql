-- HubSpot als Lead-Quelle erlauben (für hubspot-import).
alter table leads drop constraint if exists leads_source_check;
alter table leads add constraint leads_source_check
  check (source = any (array['meta','google','empfehlung','sonstiges','calendly','typeform','hubspot']));
