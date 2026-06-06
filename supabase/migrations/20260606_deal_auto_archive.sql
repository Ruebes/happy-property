-- ── Auto-Archiv: abgeschlossene Deals nach 10 Tagen archivieren ───────────────
-- Sven-Entscheidung: ARCHIVIEREN (nicht löschen). Deals in 'provision_erhalten'
-- (gewonnen) oder 'deal_verloren' (verloren) sind abgeschlossen. 10 Tage nach
-- Erreichen der Phase werden sie automatisch auf 'archiviert' gesetzt:
--   • verschwinden aus der aktiven Pipeline (Pipeline filtert phase != 'archiviert')
--   • bleiben vollständig erhalten und im Archiv-Tab wiederherstellbar
--   • Provisionssumme, Notizen, Termine & Verlauf bleiben unangetastet
-- Der "verloren"-Mail/WhatsApp-Workflow läuft am Lead (lead_id), nicht am Deal,
-- und ist von der Archivierung damit unberührt.

-- 1. Zeitstempel: wann wurde die aktuelle Phase erreicht? + Ursprungsphase fürs
--    korrekte Wiederherstellen (verloren darf nicht als gewonnen zurückkommen).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS phase_changed_at   timestamptz;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS archived_from_phase text;

-- 2. Backfill phase_changed_at für bestehende Deals (beste Schätzung)
UPDATE deals
   SET phase_changed_at = COALESCE(commission_paid_at, updated_at, created_at)
 WHERE phase_changed_at IS NULL;

-- 3. Trigger: Phasenwechsel (und Insert) stempeln — egal über welchen Pfad
CREATE OR REPLACE FUNCTION hp_stamp_phase_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.phase_changed_at := COALESCE(NEW.phase_changed_at, now());
  ELSIF NEW.phase IS DISTINCT FROM OLD.phase THEN
    NEW.phase_changed_at := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_hp_stamp_phase_changed ON deals;
CREATE TRIGGER trg_hp_stamp_phase_changed
BEFORE INSERT OR UPDATE OF phase ON deals
FOR EACH ROW
EXECUTE FUNCTION hp_stamp_phase_changed();

-- 4. Archiv-Funktion: abgeschlossene Deals älter als 10 Tage → 'archiviert'.
--    archived_from_phase merkt sich die Ursprungsphase (gewonnen/verloren).
--    Rückgabe: Anzahl archivierter Deals (für Logging/Monitoring).
CREATE OR REPLACE FUNCTION hp_archive_completed_deals()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH archived AS (
    UPDATE deals
       SET archived_from_phase = phase,
           phase               = 'archiviert'
     WHERE phase IN ('provision_erhalten', 'deal_verloren')
       AND phase_changed_at IS NOT NULL
       AND phase_changed_at < now() - interval '10 days'
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM archived;
  RETURN v_count;
END $$;

-- Hinweis: Die tägliche Ausführung wird per pg_cron geplant — separate
-- Migration 20260606_deal_auto_archive_cron.sql (benötigt Extension pg_cron).
