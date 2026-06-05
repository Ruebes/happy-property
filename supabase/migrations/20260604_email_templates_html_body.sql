-- Migration: Grafische E-Mail-Templates
-- Fügt html_body zu email_templates hinzu (optionales HTML-Template mit {{platzhalter}}).
-- Wird in Templates.tsx (HTML-Tab) und send-email (bevorzugt html_body vor body) genutzt.

ALTER TABLE public.email_templates
  ADD COLUMN IF NOT EXISTS html_body text;
