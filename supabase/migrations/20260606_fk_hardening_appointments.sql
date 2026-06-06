-- ── FK-Hardening: crm_appointments.deal_id ───────────────────────────────────
-- Problem: crm_appointments.deal_id → deals war ON DELETE NO ACTION.
-- Dadurch konnte ein Deal (und damit der ganze Lead/Kontakt) im Randfall nicht
-- gelöscht werden, wenn noch ein Termin am Deal hing.
-- Fix: ON DELETE SET NULL → Termin bleibt erhalten (am Lead), Deal-Verknüpfung
-- wird beim Löschen einfach gelöst. Lead-Löschung kann nie mehr blockiert werden.

ALTER TABLE crm_appointments DROP CONSTRAINT IF EXISTS crm_appointments_deal_id_fkey;

ALTER TABLE crm_appointments
  ADD CONSTRAINT crm_appointments_deal_id_fkey
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;
