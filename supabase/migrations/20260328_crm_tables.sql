-- ── CRM Tables ────────────────────────────────────────────────

-- 1. leads (Interessenten/Kontakte)
CREATE TABLE IF NOT EXISTS leads (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  first_name         text NOT NULL,
  last_name          text NOT NULL,
  email              text NOT NULL,
  phone              text,
  whatsapp           text,
  country            text,
  language           text DEFAULT 'de' CHECK (language IN ('de', 'en')),
  source             text DEFAULT 'manual' CHECK (source IN ('meta','google','referral','calendly','manual')),
  status             text DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','registered','property_selection','financing','sold','archived')),
  assigned_to        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  notes              text,
  calendly_event_id  text,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

-- 2. deals (Verkaufsvorgänge)
CREATE TABLE IF NOT EXISTS deals (
  id                              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id                         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id                     uuid REFERENCES properties(id) ON DELETE SET NULL,
  phase                           text DEFAULT 'erstkontakt' CHECK (phase IN (
    'erstkontakt','termin_gebucht','no_show','beratung','registrierung',
    'immobilienauswahl','finanzierung','kaufvertrag','anzahlung',
    'provision_erhalten','archiviert'
  )),
  developer                       text,
  registration_sent_at            timestamptz,
  financing_required              boolean DEFAULT false,
  financing_partner_notified_at   timestamptz,
  google_drive_url                text,
  lawyer_notified_at              timestamptz,
  deposit_paid_at                 timestamptz,
  commission_paid_at              timestamptz,
  commission_amount               numeric(12,2),
  created_at                      timestamptz DEFAULT now(),
  updated_at                      timestamptz DEFAULT now()
);

-- 3. activities (Aktivitäten/Historie)
CREATE TABLE IF NOT EXISTS activities (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  deal_id      uuid REFERENCES deals(id) ON DELETE SET NULL,
  type         text CHECK (type IN ('call','email','whatsapp','note','meeting','task')),
  direction    text DEFAULT 'outbound' CHECK (direction IN ('inbound','outbound')),
  subject      text,
  content      text,
  scheduled_at timestamptz,
  completed_at timestamptz,
  created_by   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at   timestamptz DEFAULT now()
);

-- 4. email_templates (E-Mail Vorlagen)
CREATE TABLE IF NOT EXISTS email_templates (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name       text NOT NULL,
  subject    text NOT NULL,
  body       text NOT NULL,
  category   text DEFAULT 'general' CHECK (category IN ('general','project','followup','noshow','lawyer','financing')),
  language   text DEFAULT 'de' CHECK (language IN ('de','en')),
  created_at timestamptz DEFAULT now()
);

-- 5. crm_webhooks (Webhook Log)
CREATE TABLE IF NOT EXISTS crm_webhooks (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source       text,
  payload      jsonb,
  lead_id      uuid REFERENCES leads(id) ON DELETE SET NULL,
  processed_at timestamptz,
  created_at   timestamptz DEFAULT now()
);

-- ── RLS ────────────────────────────────────────────────────────
ALTER TABLE leads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities      ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_webhooks    ENABLE ROW LEVEL SECURITY;

-- Admin + Verwalter: Vollzugriff auf leads/deals/activities/templates
CREATE POLICY "crm_leads_rw" ON leads FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

CREATE POLICY "crm_deals_rw" ON deals FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

CREATE POLICY "crm_activities_rw" ON activities FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

CREATE POLICY "crm_templates_rw" ON email_templates FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

-- Nur Admin: Webhook-Log
CREATE POLICY "crm_webhooks_admin" ON crm_webhooks FOR ALL TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin')
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');

-- ── updated_at Trigger ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER deals_updated_at
  BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Standard E-Mail-Vorlagen ───────────────────────────────────
INSERT INTO email_templates (name, subject, body, category, language) VALUES
(
  'Willkommen nach Erstgespräch',
  'Vielen Dank für dein Interesse – Nächste Schritte',
  E'Hallo {{vorname}},\n\nvielen Dank für unser heutiges Gespräch! Es war toll, mehr über deine Ziele zu erfahren.\n\nAls nächsten Schritt werden wir dir passende Immobilienangebote zusammenstellen und dir diese in Kürze zusenden.\n\nBei Fragen stehe ich dir jederzeit zur Verfügung.\n\nViele Grüße,\n{{berater_name}}',
  'general', 'de'
),
(
  'Projektvorstellung',
  'Immobilienprojekt: {{projektname}} – Exklusive Investitionsmöglichkeit',
  E'Hallo {{vorname}},\n\nwie besprochen stelle ich dir heute das Projekt "{{projektname}}" vor.\n\nLage: {{lage}}\nStartpreis: ab {{preis}} €\n\nDas Projekt bietet erstklassige Renditechancen in einer der gefragtesten Lagen.\n\nGerne vereinbaren wir einen Termin für eine detaillierte Präsentation.\n\nViele Grüße,\n{{berater_name}}',
  'project', 'de'
),
(
  'No Show – Neuen Termin vereinbaren',
  'Dein Termin – wir haben dich vermisst!',
  E'Hallo {{vorname}},\n\nschade, dass du deinen Termin am {{termin_datum}} nicht wahrnehmen konntest.\n\nGerne vereinbaren wir einen neuen Termin, der besser in deinen Zeitplan passt.\n\nMeld dich einfach bei mir oder buche direkt einen neuen Termin über unseren Link.\n\nViele Grüße,\n{{berater_name}}',
  'noshow', 'de'
),
(
  'Unterlagen für Finanzierung',
  'Unterlagen für die Finanzierungsanfrage',
  E'Hallo {{vorname}},\n\nfür die Bearbeitung deiner Finanzierungsanfrage benötigen wir folgende Unterlagen:\n\n• Aktuelle Gehaltsabrechnungen (3 Monate)\n• Kontoauszüge (3 Monate)\n• Personalausweis/Reisepass\n• Steuerbescheid (letztes Jahr)\n\nBitte sende die Dokumente an unseren Finanzierungspartner.\n\nBei Fragen stehe ich gerne zur Verfügung.\n\nViele Grüße,\n{{berater_name}}',
  'financing', 'de'
),
(
  'Nächste Schritte nach Registrierung',
  'Registrierung bestätigt – Nächste Schritte',
  E'Hallo {{vorname}},\n\ndeine Registrierung bei {{projektname}} ist erfolgreich eingegangen.\n\nHier sind die nächsten Schritte:\n\n1. Prüfung deiner Unterlagen durch den Entwickler\n2. Reservierungsvertrag wird vorbereitet\n3. Notartermin zur Beurkundung\n\nWir halten dich über jeden Schritt auf dem Laufenden.\n\nViele Grüße,\n{{berater_name}}',
  'general', 'de'
)
ON CONFLICT DO NOTHING;
