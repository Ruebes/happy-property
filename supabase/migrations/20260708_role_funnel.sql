-- Mitarbeiter-Rolle 'funnel' (z.B. Giona): sieht im CRM nur den Termin-Funnel
-- (Statistik /admin/crm/funnel + Editor /admin/crm/funnel-editor).
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('admin','verwalter','eigentuemer','feriengast','funnel'));
