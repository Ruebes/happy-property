-- Fragebogen: je Frage 5 Knochen zur Auswahl, Text nur optional dazu.
alter table review_requests add column if not exists question_ratings jsonb not null default '{}'::jsonb;
