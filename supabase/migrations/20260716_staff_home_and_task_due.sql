-- ── Mitarbeiter-Startseite + Aufgaben-Frist ─────────────────────────────────
-- dashboard_prefs: pro Nutzer anpassbare Startseite (welche Widgets, Reihenfolge).
--   Form: { "widgets": ["my_tasks","created_tasks","appointments_today","quick_links"] }
-- crm_tasks.due_date: optionale Frist bis zur Erledigung (nur Datum).
alter table profiles  add column if not exists dashboard_prefs jsonb not null default '{}'::jsonb;
alter table crm_tasks add column if not exists due_date date;
