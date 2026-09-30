-- ensure_affiliate konnte seit 4.9.2026 keinen neuen Tippgeber anlegen.
--
-- Die Funktion (20260904_affiliates_unique_links.sql) ist SECURITY DEFINER mit
-- search_path = public und ruft gen_random_bytes() unqualifiziert auf. pgcrypto
-- liegt aber im Schema "extensions". Ergebnis: "function gen_random_bytes(integer)
-- does not exist" für jeden, der noch keinen Tippgeber-Eintrag hat (29.9.: 180x im
-- Newsletter-Lauf). Newsletter ohne persönlichen Empfehlungslink, Bewertungen mit
-- "würde empfehlen" ohne Link und ohne Lotte-WhatsApp.
--
-- Fix: nur den search_path der Funktion um "extensions" ergänzen. Body, Grants
-- und Revokes bleiben unverändert. Idempotent (mehrfach ausführbar).
-- Rückbau: rollback/20260930224500_ensure_affiliate_search_path.down.sql
--
-- Achtung beim Einspielen: danach läuft das Empfehlungsprogramm wie am 4.9.
-- vorgesehen wieder an. Der nächste Newsletter legt je Empfänger einen
-- affiliates-Eintrag an, und "würde empfehlen" im Bewertungsbogen löst wieder
-- eine Lotte-WhatsApp an den Kunden aus. Test nur mit Svens eigener Nummer/Mail.

do $$
begin
  if to_regprocedure('public.ensure_affiliate(uuid, uuid, text, text, text, text)') is not null then
    alter function public.ensure_affiliate(uuid, uuid, text, text, text, text)
      set search_path = public, extensions;
  end if;
end
$$;
