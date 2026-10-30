-- Automatischer Versand fertiger Anfrage-Pakete (Sven 30.10.2026: „Ja, automatisch“).
-- Für Projekte aus crm_settings.anfrage_paket_ohne_aufgabe (Flora Panorama) geht das
-- fertige Paket per Mail raus wie beim Senden im Postausgang, ohne Klick. Schalter
-- crm_settings.anfrage_paket_auto_senden: off (Standard) | test (nur an Svens eigene
-- Adresse) | on. Gesendet wird nur außerhalb der Ruhezeit (21 bis 8 Uhr Empfängerzeit)
-- und nur, wenn die Deck-Prüfung nicht rot ist. Der Cron hp-anfrage-paket (alle 2 Min)
-- versucht fällige Pakete erneut.
alter table public.anfrage_pakete
  add column if not exists versand text,
  add column if not exists versand_ab timestamptz,
  add column if not exists versendet_at timestamptz,
  add column if not exists versand_info text,
  add column if not exists pruefung_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'anfrage_pakete_versand_check') then
    alter table public.anfrage_pakete add constraint anfrage_pakete_versand_check
      check (versand is null or versand in ('geplant', 'sendet', 'gesendet', 'blockiert', 'fehler', 'manuell', 'abgebrochen'));
  end if;
end $$;

comment on column public.anfrage_pakete.versand is 'Automatischer Versand. null = nicht automatisch (Sven sendet im Postausgang). geplant = wartet auf Zeit/Prüfung, sendet = läuft gerade, gesendet, blockiert (Aufgabe an Sven), fehler (Aufgabe an Sven), manuell (Sven war schneller), abgebrochen (Entwurf storniert).';
comment on column public.anfrage_pakete.versand_ab is 'Frühester automatischer Versand (nach der Ruhezeit des Empfängers).';
comment on column public.anfrage_pakete.versendet_at is 'Zeitpunkt des automatischen Versands.';
comment on column public.anfrage_pakete.versand_info is 'Grund, warum nicht automatisch gesendet wurde, oder Hinweis zum Versand.';
comment on column public.anfrage_pakete.pruefung_at is 'Zuletzt von anfrage-paket angestoßene Deck-Prüfung (deck-review).';

-- Schalter: off | test | on. Fehlende Zeile = off.
insert into public.crm_settings (key, value) values ('anfrage_paket_auto_senden', 'off')
on conflict (key) do nothing;
