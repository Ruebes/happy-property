-- Termin-Bot: Serialisierung, Fortschrittszaehler, Wiederholungsschutz
--
-- Anlass: Patrick Dahlmann bekam am 21.7. dieselbe Nachricht WORTGLEICH zweimal
-- (13:56:12 und 13:56:38) und hat daraufhin blockiert. Nimet Guerses bekam in
-- derselben Sekunde zwei einander widersprechende Nachrichten (13:37:17.14 und
-- .38) und wurde als verlorener Deal geschlossen.
--
-- Beide Faelle haben dieselbe Wurzel: der Bot verarbeitet jede eingehende
-- Nachricht isoliert und parallel, ohne zu wissen, was er selbst gerade
-- geschickt hat.

-- Serialisierung: wer eine Nachricht verarbeitet, beansprucht das Gespraech.
-- Zwei Nachrichten binnen Sekunden starteten bisher zwei Bot-Laeufe auf
-- demselben Zustand — beide lasen denselben state, beide antworteten.
alter table booking_conversations
  add column if not exists processing_until timestamptz;

-- Zaehlt Runden OHNE Fortschritt und wird — anders als attempts — NIE
-- zurueckgesetzt. attempts wird an sechs Stellen genullt (u.a. bei jeder
-- beantworteten Zwischenfrage), deshalb konnte Nimet zweimal dieselbe Frage
-- stellen, ohne dass irgendein Zaehler stieg.
alter table booking_conversations
  add column if not exists rounds_no_progress smallint not null default 0;

-- Was der Bot zuletzt gesendet hat, normalisiert (klein, ohne Signatur/Emoji).
-- last_message existiert zwar schon, wurde aber an 12 Stellen geschrieben und
-- an keiner gelesen. Die normalisierte Fassung macht den Vergleich robust
-- gegen Umformulierungen der Signatur.
alter table booking_conversations
  add column if not exists last_sent_norm text;

-- Gespraeche, die auf eine Kontaktsperre laufen, sollen nicht wieder aufwachen.
comment on column booking_conversations.processing_until is
  'Beansprucht das Gespraech waehrend der Verarbeitung (Serialisierung gegen parallele Antworten)';
comment on column booking_conversations.rounds_no_progress is
  'Runden ohne Fortschritt, wird nie zurueckgesetzt — ab 3 uebernimmt Sven';
