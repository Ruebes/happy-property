-- Prüfteam für Sales Decks (Edge Function deck-review): Ergebnis mit Endscore.
-- review = kompletter Bericht (Teilnoten, Befunde, Top-Korrekturen), review_score
-- = Endscore 0-100 für Listen und Badges, reviewed_at = Zeitpunkt der Prüfung.
alter table public.sales_decks
  add column if not exists review jsonb,
  add column if not exists review_score smallint,
  add column if not exists reviewed_at timestamptz;

comment on column public.sales_decks.review is 'Bericht des Prüfteams (deck-review): score, verdict, scores je Kategorie, befunde, top, todo, content_hash';
comment on column public.sales_decks.review_score is 'Endscore 0-100 des Prüfteams, versandbereit ab 85';

-- Cron 'deck-review-faellige' (*/10, POST {action:'faellige'}) am 25.10.2026 per
-- Management-API angelegt, Authorization-Header aus revolut-sync-daily übernommen
-- (Schlüssel bewusst nicht im Repo).
