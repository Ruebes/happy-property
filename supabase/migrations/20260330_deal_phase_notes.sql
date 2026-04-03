-- ── Phase-specific notes columns on deals ────────────────────────────────────
-- Each CRM phase gets its own dedicated notes column so notes are tracked
-- per phase and not overwritten when a deal moves to a new phase.

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS registration_notes     text,
  ADD COLUMN IF NOT EXISTS finanzierung_de_notes  text,
  ADD COLUMN IF NOT EXISTS finanzierung_cy_notes  text,
  ADD COLUMN IF NOT EXISTS immobilien_notes       text,
  ADD COLUMN IF NOT EXISTS kaufvertrag_notes      text,
  ADD COLUMN IF NOT EXISTS provision_notes        text;
