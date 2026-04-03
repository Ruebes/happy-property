-- ── whatsapp_templates ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  name             text        NOT NULL,
  event_type       text        NOT NULL,
  recipients       jsonb       DEFAULT '[]',
  -- [{"name": "Sven", "phone": "+49151..."}]
  message_template text        NOT NULL,
  -- Platzhalter: {{lead_name}}, {{lead_phone}}, {{developers}} …
  included_fields  jsonb       DEFAULT '[]',
  -- ["lead_name", "lead_phone", "developers", …]
  active           boolean     DEFAULT true,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_only" ON whatsapp_templates
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- ── Standard-Templates ────────────────────────────────────────────────────────

INSERT INTO whatsapp_templates (name, event_type, recipients, message_template, included_fields)
VALUES
(
  'Registrierung Developer',
  'registration',
  '[]'::jsonb,
  'Neuer Interessent zur Registrierung:

Name: {{lead_name}}
Telefon: {{lead_phone}}
Email: {{lead_email}}
Developer: {{developers}}
Bemerkungen: {{notes}}',
  '["lead_name","lead_phone","lead_email","developers","notes"]'::jsonb
),
(
  'No Show Followup',
  'no_show',
  '[]'::jsonb,
  'Hallo {{lead_name}} 👋

Du hattest heute einen Termin mit uns, den wir leider verpasst haben.

Kein Problem – lass uns gerne einen neuen Termin vereinbaren:
👉 [Calendly Link]

Bei Fragen stehen wir jederzeit zur Verfügung.

Viele Grüße
Sven Rüprich
Happy Property',
  '["lead_name","lead_phone","appointment_date"]'::jsonb
),
(
  'Provision anfordern',
  'commission',
  '[]'::jsonb,
  '🎉 Deal abgeschlossen!

Kunde: {{lead_name}}
Projekt: {{project_name}}
Provision: {{commission_amount}}

Bitte Provision veranlassen.

Happy Property',
  '["lead_name","project_name","commission_amount"]'::jsonb
),
(
  'Buchungsbestätigung Gast',
  'booking',
  '[]'::jsonb,
  'Hallo {{lead_name}} 👋

Deine Buchung ist bestätigt! ✅

🏠 {{project_name}}
📅 Check-in: {{checkin}}
📅 Check-out: {{checkout}}

Alle Details findest du in deinem Portal.

Wir freuen uns auf deinen Aufenthalt!
Happy Property',
  '["lead_name","lead_phone","project_name","checkin","checkout"]'::jsonb
)
ON CONFLICT DO NOTHING;
