-- Migration: UTM-/Herkunfts-Tracking für Leads
-- Speichert die Werbe-Herkunft aus Typeform Hidden Fields (utm_source etc.).
-- Wird von typeform-webhook beim Lead-Insert befüllt und im CRM für die
-- Quellen-Zuordnung (meta/google/empfehlung/sonstiges) genutzt.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS utm_source   text,
  ADD COLUMN IF NOT EXISTS utm_medium   text,
  ADD COLUMN IF NOT EXISTS utm_campaign text,
  ADD COLUMN IF NOT EXISTS utm_content  text;
