-- KI-Lernspeicher (deck_ai_rules) auch für Mails nutzbar machen.
-- kind = 'deck' (Sales-Decks: generate-deck/refine-deck) | 'mail' (Begleit-Mails: compose-deck-mail).
-- project_id (bereits vorhanden) = projektspezifische Regel; NULL = global.
alter table deck_ai_rules add column if not exists kind text not null default 'deck';
create index if not exists idx_deck_ai_rules_lookup on deck_ai_rules (kind, active, project_id);
