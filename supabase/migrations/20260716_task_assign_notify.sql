-- ── Aufgaben-Benachrichtigungen ─────────────────────────────────────────────
-- assigned_notified_at: markiert, dass der zugewiesene Mitarbeiter über die NEUE
-- Aufgabe bereits ein In-App-Popup gesehen hat (poppt genau einmal).
-- notified_at auf crm_task_messages wurde initial per ALTER nachgezogen — hier
-- idempotent mitgeführt, damit eine frische Migration vollständig ist.
alter table crm_tasks         add column if not exists assigned_notified_at timestamptz;
alter table crm_task_messages add column if not exists notified_at          timestamptz;
