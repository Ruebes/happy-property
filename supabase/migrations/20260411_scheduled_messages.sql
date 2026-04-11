-- ── Automated Email + WhatsApp Scheduler ─────────────────────────────────────
-- Tabelle 1: Geplante Nachrichten (Queue)
-- Tabelle 2: Opt-Out Liste (Reaktivierung)
-- Tabelle 3: Automationsregeln (Admin-konfigurierbar)

-- ── 1. scheduled_messages ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id         uuid REFERENCES leads(id)  ON DELETE CASCADE,
  deal_id         uuid REFERENCES deals(id),
  type            text NOT NULL CHECK (type IN ('email', 'whatsapp', 'both')),
  event_type      text NOT NULL,
  -- z.B. 'lead_created', 'no_show', 'termin_gebucht', 'deal_verloren' …
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'failed')),
  scheduled_at    timestamptz NOT NULL,
  sent_at         timestamptz,
  email_subject   text,
  email_body      text,
  whatsapp_text   text,
  error_message   text,
  rule_id         uuid,   -- welche Automationsregel hat das ausgelöst
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_messages_status_idx
  ON scheduled_messages (status, scheduled_at);
CREATE INDEX IF NOT EXISTS scheduled_messages_lead_idx
  ON scheduled_messages (lead_id);

ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_verwalter_scheduled_messages"
  ON scheduled_messages FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'verwalter')
    )
  );

-- ── 2. communication_optouts ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS communication_optouts (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id      uuid REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
  opted_out_at timestamptz DEFAULT now(),
  reason       text
);

ALTER TABLE communication_optouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_verwalter_optouts"
  ON communication_optouts FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'verwalter')
    )
  );

-- ── 3. automation_rules ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS automation_rules (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name                text NOT NULL,
  description         text,
  -- Auslöser-Ereignis (entspricht deal-Phase oder 'lead_created')
  event_type          text NOT NULL,
  -- Verzögerung in Minuten nach dem Ereignis (0 = sofort)
  delay_minutes       integer NOT NULL DEFAULT 0,
  -- Art der Nachricht
  message_type        text NOT NULL CHECK (message_type IN ('email', 'whatsapp', 'both')),
  -- E-Mail-Template (aus email_templates.id)
  email_template_id   uuid REFERENCES email_templates(id) ON DELETE SET NULL,
  -- WhatsApp-Template (aus whatsapp_templates.event_type)
  whatsapp_event_type text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_automation_rules"
  ON automation_rules FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND role = 'admin'
    )
  );

-- ── Standard-Regeln (ohne E-Mail-Template – muss Admin konfigurieren) ─────────

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, whatsapp_event_type, is_active)
VALUES
  (
    'Neuer Lead – Follow-Up WhatsApp',
    'WhatsApp an Lead 60 Minuten nach Erstkontakt senden',
    'lead_created', 60, 'whatsapp', 'booking', true
  ),
  (
    'No-Show – Wiedervorlage',
    'E-Mail + WhatsApp 48 Stunden nach No Show',
    'no_show', 2880, 'both', 'no_show', false
  ),
  (
    'Deal verloren – Abschluss',
    'Abschluss-E-Mail 24 Stunden nach Deal verloren',
    'deal_verloren', 1440, 'email', null, false
  ),
  (
    'Termin gebucht – Bestätigung WA',
    'WhatsApp-Bestätigung sofort bei Terminbuchung',
    'termin_gebucht', 0, 'whatsapp', 'booking', true
  )
ON CONFLICT DO NOTHING;

-- ── pg_cron: alle 5 Minuten process-scheduled-messages aufrufen ───────────────
-- WICHTIG: Ersetze <PROJECT_REF> und <SERVICE_ROLE_KEY> mit echten Werten.
-- Ausführen in Supabase SQL-Editor NACH dem Deployment der Edge Function.
--
-- SELECT cron.schedule(
--   'process-scheduled-messages',
--   '*/5 * * * *',
--   $$
--     SELECT net.http_post(
--       url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/process-scheduled-messages',
--       headers := jsonb_build_object(
--         'Content-Type',  'application/json',
--         'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
--       ),
--       body    := '{}'::jsonb
--     );
--   $$
-- );
