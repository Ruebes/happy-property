-- Sicherheitsnetz Postausgang: Der DeckWizard legt den Mail-Entwurf erst im Browser an,
-- nachdem alle Decks fertig sind. Wird der Tab vorher neu geladen oder geschlossen
-- (Hintergrund-Modus!), bleibt das Deck ohne Postausgang-Eintrag (Thomas Hellige, 23.9.).
-- process-scheduled-messages legt für solche Waisen einen Entwurf an und stempelt outbox_at.
-- Bestand vor dem 23.9. 14:00 UTC fasst der Sweep per Stichtag nicht an.
alter table deck_generation_jobs add column if not exists outbox_at timestamptz;
