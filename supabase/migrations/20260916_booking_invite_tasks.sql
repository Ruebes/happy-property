-- ── Persönliche Buchungslinks: Termin buchen UND/ODER Aufgabe stellen ────────
-- Sven (16.9.2026): „Im Kontakt einfach einen Haken setzen — nur Aufgabe stellen,
-- nur Kalender oder beides." Zwei Haken statt eines Modus-Felds, damit die
-- Maske 1:1 abbildet, was der Link kann. Mindestens einer muss gesetzt sein.
alter table booking_invites add column if not exists allow_calendar boolean not null default true;
alter table booking_invites add column if not exists allow_task     boolean not null default false;
alter table booking_invites drop constraint if exists booking_invites_allow_one;
alter table booking_invites add constraint booking_invites_allow_one check (allow_calendar or allow_task);

-- Aufgaben, die über einen Buchungslink von AUSSEN gestellt werden: created_by
-- bleibt der Link-Inhaber (Pflichtfeld, profiles-FK), der echte Absender steht in
-- ext_creator {name,email,phone,lang}. Die App zeigt ihn als Aufgabengeber, und
-- task-notify meldet ihm die Erledigung (wie bei Teilaufgaben, gleicher Riegel
-- done_notified_at).
alter table crm_tasks add column if not exists ext_creator jsonb;
