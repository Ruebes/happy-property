-- Rückbau zu 20261003111000_werbe_qualitaet_funktionen.sql (von Hand ausführen;
-- liegt im Unterordner, damit die Supabase-CLI die Datei nicht einspielt).
-- Entfernt die Qualitäts- und Kalibrier-Funktionen. Daten (ad_quality_daily,
-- ad_ev_weights) bleiben; sie gehören zu 20261003110000.
-- Die drei Indizes bleiben bewusst stehen (harmlos, eventuell auch von anderen
-- Migrationen angelegt). Bei Bedarf von Hand:
--   drop index if exists public.funnel_events_session_question_idx;
--   drop index if exists public.funnel_sessions_lead_id_idx;
--   drop index if exists public.ad_catalog_ad_name_idx;
-- Reihenfolge Rückbau: 119000 -> 113000 -> 112000 -> 111000 -> 110000.

begin;

set local lock_timeout = '5s';

drop function if exists public.werbe_ev_aktivieren(int);
drop function if exists public.werbe_ev_kalibrieren();
drop function if exists public.werbe_qualitaet_berechnen(date);
drop function if exists public.werbe_te(jsonb, text, numeric, boolean, boolean, boolean, text, numeric, numeric, boolean, boolean);
drop function if exists public.werbe_ist_intern_kontakt(text, text, text);
drop function if exists public.werbe_ist_meta_lead(text, text, text, text, text);
drop function if exists public.werbe_gamma_p(float8, float8);
drop function if exists public.werbe_lgamma(float8);
drop function if exists public.werbe_kennung(text, text, text);
drop function if exists public.werbe_kennung_basis(text, text);

notify pgrst, 'reload schema';

commit;
