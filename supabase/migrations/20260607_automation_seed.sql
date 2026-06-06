-- ── Automations-Entwürfe je Pipeline-Phase (ALLE Regeln DEAKTIVIERT) ─────────
-- Liefert ein fertiges, klickbares Gerüst: Mail- + WhatsApp-Entwürfe und die
-- passenden Regeln (Kadenz). is_active = false → es feuert NICHTS. Sven passt
-- die Texte im CRM an und schaltet erst danach bewusst scharf.
--
-- Platzhalter, die die schedule-message-Function automatisch füllt:
--   {{vorname}} {{nachname}} {{lead_name}} {{email}} {{phone}} {{developers}}
-- In eckigen Klammern stehende Platzhalter ([TERMIN-LINK], [VIMEO-LINK], …)
-- sind manuell von Sven einzusetzen. Projekt/Unit/Preis für Reservierung &
-- Kaufvertrag folgen, sobald die Function um diese Platzhalter erweitert ist.
--
-- Idempotent: alles via NOT EXISTS, mehrfaches Ausführen erzeugt keine Dubletten.

-- ── 1. E-Mail-Vorlagen ───────────────────────────────────────────────────────

INSERT INTO email_templates (name, subject, body, category, language)
SELECT 'Erstkontakt – Termin vereinbaren',
       'Ihr persönliches Investment-Gespräch – Happy Property',
       E'Hallo {{vorname}},\n\nvielen Dank für Ihr Interesse an einem Immobilien-Investment auf Zypern.\n\nDamit wir Ihnen die passenden Objekte und mögliche Renditen zeigen können, lassen Sie uns kurz sprechen. Suchen Sie sich einfach einen Termin aus, der Ihnen passt:\n\n[TERMIN-LINK HIER EINFÜGEN]\n\nBei Fragen antworten Sie gern direkt auf diese E-Mail.\n\nHerzliche Grüße\nIhr Happy Property Team\n\n— ENTWURF, bitte Text anpassen —',
       'followup', 'de'
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE name='Erstkontakt – Termin vereinbaren' AND language='de');

INSERT INTO email_templates (name, subject, body, category, language)
SELECT 'Erstkontakt – Letzter Hinweis',
       'Letzte Erinnerung: Ihr Investment-Gespräch',
       E'Hallo {{vorname}},\n\nwir würden Ihnen gern Ihre Möglichkeiten für ein Immobilien-Investment auf Zypern zeigen – ganz unverbindlich.\n\nFalls es zeitlich gerade nicht passt, melden Sie sich einfach, wann es Ihnen besser passt. Hier geht es direkt zur Terminbuchung:\n\n[TERMIN-LINK HIER EINFÜGEN]\n\nHerzliche Grüße\nIhr Happy Property Team\n\n— ENTWURF, bitte Text anpassen —',
       'followup', 'de'
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE name='Erstkontakt – Letzter Hinweis' AND language='de');

INSERT INTO email_templates (name, subject, body, category, language)
SELECT 'No-Show – Reminder',
       'Wir haben Sie vermisst – neuer Termin?',
       E'Hallo {{vorname}},\n\nschade, dass unser Termin nicht geklappt hat – das ist überhaupt kein Problem.\n\nSuchen Sie sich gern einen neuen Termin aus, der besser passt:\n\n[TERMIN-LINK HIER EINFÜGEN]\n\nWir freuen uns auf das Gespräch.\n\nHerzliche Grüße\nIhr Happy Property Team\n\n— ENTWURF, bitte Text anpassen —',
       'noshow', 'de'
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE name='No-Show – Reminder' AND language='de');

INSERT INTO email_templates (name, subject, body, category, language)
SELECT 'No-Show – Letzter Hinweis',
       'Letzte Erinnerung: Lassen Sie uns sprechen',
       E'Hallo {{vorname}},\n\nwir würden Sie ungern aus den Augen verlieren. Wenn Sie weiterhin Interesse an einem Investment auf Zypern haben, finden wir gern einen passenden Termin:\n\n[TERMIN-LINK HIER EINFÜGEN]\n\nHerzliche Grüße\nIhr Happy Property Team\n\n— ENTWURF, bitte Text anpassen —',
       'noshow', 'de'
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE name='No-Show – Letzter Hinweis' AND language='de');

INSERT INTO email_templates (name, subject, body, category, language)
SELECT 'Immobilienauswahl – Erinnerung',
       'Ihre Immobilien-Auswahl bei Happy Property',
       E'Hallo {{vorname}},\n\nhaben Sie schon einen Favoriten aus den vorgeschlagenen Objekten gefunden?\n\nGern beantworten wir offene Fragen zu Lage, Rendite oder Zahlungsplan – melden Sie sich einfach. Wir reservieren Ihre Wunschimmobilie auf Wunsch unverbindlich für Sie.\n\nHerzliche Grüße\nIhr Happy Property Team\n\n— ENTWURF, bitte Text anpassen —',
       'followup', 'de'
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE name='Immobilienauswahl – Erinnerung' AND language='de');

INSERT INTO email_templates (name, subject, body, category, language)
SELECT 'Reservierung – Bestätigung',
       'Reservierungsbestätigung – Ihre Wunschimmobilie',
       E'Hallo {{vorname}},\n\nwir haben Ihre Wunschimmobilie für Sie reserviert. Anbei die Eckdaten Ihrer Reservierung:\n\nProjekt / Unit / Preis: [WIRD AUTOMATISCH ERGÄNZT, SOBALD FREIGESCHALTET]\n\nDen Zugang zu Ihrem persönlichen Dokumenten-Ordner (Google Drive) erhalten Sie separat.\n\nHerzliche Grüße\nIhr Happy Property Team\n\n— ENTWURF, bitte Text anpassen —',
       'general', 'de'
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE name='Reservierung – Bestätigung' AND language='de');

INSERT INTO email_templates (name, subject, body, category, language)
SELECT 'Finanzierung DE – Kunde',
       'Ihre Finanzierung – die nächsten Schritte',
       E'Hallo {{vorname}},\n\nfür Ihre Finanzierung legen wir jetzt los. Wir richten Ihnen einen persönlichen Dokumenten-Ordner ein und stellen den Kontakt zu unserem Finanzierungspartner in Deutschland her.\n\nWelche Unterlagen wir benötigen, senden wir Ihnen in Kürze.\n\nHerzliche Grüße\nIhr Happy Property Team\n\n— ENTWURF, bitte Text anpassen —',
       'financing', 'de'
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE name='Finanzierung DE – Kunde' AND language='de');

INSERT INTO email_templates (name, subject, body, category, language)
SELECT 'Finanzierung CY – Kunde',
       'Ihre Finanzierung auf Zypern – die nächsten Schritte',
       E'Hallo {{vorname}},\n\nfür Ihre Finanzierung auf Zypern legen wir jetzt los. Wir richten Ihnen einen persönlichen Dokumenten-Ordner ein und stellen den Kontakt zu unserem Finanzierungspartner vor Ort her.\n\nWelche Unterlagen wir benötigen, senden wir Ihnen in Kürze.\n\nHerzliche Grüße\nIhr Happy Property Team\n\n— ENTWURF, bitte Text anpassen —',
       'financing', 'de'
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE name='Finanzierung CY – Kunde' AND language='de');

INSERT INTO email_templates (name, subject, body, category, language)
SELECT 'Kaufvertrag – Kunde',
       'Ihr Kaufvertrag – Happy Property',
       E'Hallo {{vorname}},\n\nherzlichen Glückwunsch – Ihr Kaufvertrag ist auf dem Weg. Im Anhang finden Sie alle relevanten Unterlagen.\n\nProjekt / Unit / Preis / Developer: [WIRD AUTOMATISCH ERGÄNZT, SOBALD FREIGESCHALTET]\n\nUnser Anwalt begleitet die Abwicklung und meldet sich bei Ihnen.\n\nHerzliche Grüße\nIhr Happy Property Team\n\n— ENTWURF, bitte Text anpassen —',
       'general', 'de'
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE name='Kaufvertrag – Kunde' AND language='de');

-- ── 2. WhatsApp-Vorlagen ─────────────────────────────────────────────────────

INSERT INTO whatsapp_templates (event_type, name, message_template, active)
SELECT 'erstkontakt_reminder', 'Erstkontakt Reminder (ENTWURF)',
       E'Hallo {{lead_name}}, hier ist Happy Property 👋 Sollen wir kurz zu Ihrem Immobilien-Investment auf Zypern sprechen? Suchen Sie sich gern einen Termin aus: [TERMIN-LINK]. — ENTWURF',
       true
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_templates WHERE event_type='erstkontakt_reminder');

INSERT INTO whatsapp_templates (event_type, name, message_template, active)
SELECT 'noshow_reminder', 'No-Show Reminder (ENTWURF)',
       E'Hallo {{lead_name}}, schade, dass unser Termin nicht geklappt hat. Lassen Sie uns einen neuen finden: [TERMIN-LINK]. — ENTWURF',
       true
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_templates WHERE event_type='noshow_reminder');

INSERT INTO whatsapp_templates (event_type, name, message_template, active)
SELECT 'termin_bestaetigung', 'Termin-Bestätigung (ENTWURF)',
       E'Hallo {{lead_name}}, Ihr Termin ist bestätigt ✅ Zur Einstimmung ein kurzes Video: [VIMEO-LINK HIER EINFÜGEN]. Bis bald! — ENTWURF',
       true
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_templates WHERE event_type='termin_bestaetigung');

INSERT INTO whatsapp_templates (event_type, name, message_template, active)
SELECT 'immobilienauswahl_reminder', 'Immobilienauswahl Reminder (ENTWURF)',
       E'Hallo {{lead_name}}, haben Sie schon einen Favoriten aus den Objekten gefunden? Melden Sie sich gern bei Fragen – wir reservieren auf Wunsch unverbindlich. — ENTWURF',
       true
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_templates WHERE event_type='immobilienauswahl_reminder');

INSERT INTO whatsapp_templates (event_type, name, message_template, active)
SELECT 'reservierung_kunde', 'Reservierung Kunde (ENTWURF)',
       E'Hallo {{lead_name}}, Ihre Wunschimmobilie ist reserviert 🔖 Die Reservierungsbestätigung und den Zugang zu Ihrem Dokumenten-Ordner erhalten Sie per Mail. — ENTWURF',
       true
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_templates WHERE event_type='reservierung_kunde');

INSERT INTO whatsapp_templates (event_type, name, message_template, active)
SELECT 'finanzierung_kunde', 'Finanzierung Kunde (ENTWURF)',
       E'Hallo {{lead_name}}, für Ihre Finanzierung benötigen wir ein paar Unterlagen – die Details kommen gleich per Mail. — ENTWURF',
       true
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_templates WHERE event_type='finanzierung_kunde');

INSERT INTO whatsapp_templates (event_type, name, message_template, active)
SELECT 'kaufvertrag_kunde', 'Kaufvertrag Kunde (ENTWURF)',
       E'Hallo {{lead_name}}, Ihr Kaufvertrag ist unterwegs 📝 Details und die PDFs erhalten Sie per Mail. — ENTWURF',
       true
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_templates WHERE event_type='kaufvertrag_kunde');

-- ── 3. Automationsregeln (ALLE is_active = false) ────────────────────────────
-- event_type = Deal-Phase (Auslöser). Mehrere Regeln je Phase = getaktete Serie.

-- Erstkontakt (kein Termin): +20min, +1d, +3d, +5d, +14d
INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Erstkontakt +20 Min', 'ENTWURF – Reminder Termin vereinbaren (Mail+WA)', 'erstkontakt', 20, 'both',
       (SELECT id FROM email_templates WHERE name='Erstkontakt – Termin vereinbaren' AND language='de' ORDER BY created_at LIMIT 1),
       'erstkontakt_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Erstkontakt +20 Min');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Erstkontakt +1 Tag', 'ENTWURF – Reminder (Mail+WA)', 'erstkontakt', 1440, 'both',
       (SELECT id FROM email_templates WHERE name='Erstkontakt – Termin vereinbaren' AND language='de' ORDER BY created_at LIMIT 1),
       'erstkontakt_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Erstkontakt +1 Tag');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Erstkontakt +3 Tage', 'ENTWURF – Reminder (nur WA)', 'erstkontakt', 4320, 'whatsapp',
       NULL, 'erstkontakt_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Erstkontakt +3 Tage');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Erstkontakt +5 Tage', 'ENTWURF – Reminder (Mail+WA)', 'erstkontakt', 7200, 'both',
       (SELECT id FROM email_templates WHERE name='Erstkontakt – Termin vereinbaren' AND language='de' ORDER BY created_at LIMIT 1),
       'erstkontakt_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Erstkontakt +5 Tage');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Erstkontakt +14 Tage (letzter)', 'ENTWURF – letzte Erinnerung (nur Mail)', 'erstkontakt', 20160, 'email',
       (SELECT id FROM email_templates WHERE name='Erstkontakt – Letzter Hinweis' AND language='de' ORDER BY created_at LIMIT 1),
       NULL, false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Erstkontakt +14 Tage (letzter)');

-- No-Show: gleiche Taktung, eigener Text
INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'No-Show +20 Min', 'ENTWURF – Reminder neuer Termin (Mail+WA)', 'no_show', 20, 'both',
       (SELECT id FROM email_templates WHERE name='No-Show – Reminder' AND language='de' ORDER BY created_at LIMIT 1),
       'noshow_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='No-Show +20 Min');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'No-Show +1 Tag', 'ENTWURF – Reminder (Mail+WA)', 'no_show', 1440, 'both',
       (SELECT id FROM email_templates WHERE name='No-Show – Reminder' AND language='de' ORDER BY created_at LIMIT 1),
       'noshow_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='No-Show +1 Tag');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'No-Show +3 Tage', 'ENTWURF – Reminder (nur WA)', 'no_show', 4320, 'whatsapp',
       NULL, 'noshow_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='No-Show +3 Tage');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'No-Show +5 Tage', 'ENTWURF – Reminder (Mail+WA)', 'no_show', 7200, 'both',
       (SELECT id FROM email_templates WHERE name='No-Show – Reminder' AND language='de' ORDER BY created_at LIMIT 1),
       'noshow_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='No-Show +5 Tage');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'No-Show +14 Tage (letzter)', 'ENTWURF – letzte Erinnerung (nur Mail)', 'no_show', 20160, 'email',
       (SELECT id FROM email_templates WHERE name='No-Show – Letzter Hinweis' AND language='de' ORDER BY created_at LIMIT 1),
       NULL, false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='No-Show +14 Tage (letzter)');

-- Termin gebucht: sofort WhatsApp-Bestätigung + Vimeo
INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Termin gebucht – WA-Bestätigung + Vimeo', 'ENTWURF – Calendly sendet die Mail, hier WA-Bestätigung mit Vimeo-Link', 'termin_gebucht', 0, 'whatsapp',
       NULL, 'termin_bestaetigung', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Termin gebucht – WA-Bestätigung + Vimeo');

-- Immobilienauswahl: +7, +10, +14, +30 Tage (Mail+WA)
INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Immobilienauswahl +7 Tage', 'ENTWURF (Mail+WA)', 'immobilienauswahl', 10080, 'both',
       (SELECT id FROM email_templates WHERE name='Immobilienauswahl – Erinnerung' AND language='de' ORDER BY created_at LIMIT 1),
       'immobilienauswahl_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Immobilienauswahl +7 Tage');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Immobilienauswahl +10 Tage', 'ENTWURF (Mail+WA)', 'immobilienauswahl', 14400, 'both',
       (SELECT id FROM email_templates WHERE name='Immobilienauswahl – Erinnerung' AND language='de' ORDER BY created_at LIMIT 1),
       'immobilienauswahl_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Immobilienauswahl +10 Tage');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Immobilienauswahl +14 Tage', 'ENTWURF (Mail+WA)', 'immobilienauswahl', 20160, 'both',
       (SELECT id FROM email_templates WHERE name='Immobilienauswahl – Erinnerung' AND language='de' ORDER BY created_at LIMIT 1),
       'immobilienauswahl_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Immobilienauswahl +14 Tage');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Immobilienauswahl +30 Tage', 'ENTWURF (Mail+WA)', 'immobilienauswahl', 43200, 'both',
       (SELECT id FROM email_templates WHERE name='Immobilienauswahl – Erinnerung' AND language='de' ORDER BY created_at LIMIT 1),
       'immobilienauswahl_reminder', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Immobilienauswahl +30 Tage');

-- Reservierung: sofort Mail+WA an Kunden (Developer-Benachrichtigung + Drive folgen separat)
INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Reservierung – Kunde', 'ENTWURF – Bestätigung an Kunden (Mail+WA). Developer-Mail/WA + Google Drive werden separat verdrahtet.', 'reservierung', 0, 'both',
       (SELECT id FROM email_templates WHERE name='Reservierung – Bestätigung' AND language='de' ORDER BY created_at LIMIT 1),
       'reservierung_kunde', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Reservierung – Kunde');

-- Finanzierung DE / CY: sofort Mail+WA an Kunden (Finanzierer-Mail + Drive folgen separat)
INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Finanzierung DE – Kunde', 'ENTWURF – Mail+WA an Kunden. Finanzierer-Mail + Google Drive separat.', 'finanzierung_de', 0, 'both',
       (SELECT id FROM email_templates WHERE name='Finanzierung DE – Kunde' AND language='de' ORDER BY created_at LIMIT 1),
       'finanzierung_kunde', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Finanzierung DE – Kunde');

INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Finanzierung CY – Kunde', 'ENTWURF – Mail+WA an Kunden. Finanzierer-Mail + Google Drive separat.', 'finanzierung_cy', 0, 'both',
       (SELECT id FROM email_templates WHERE name='Finanzierung CY – Kunde' AND language='de' ORDER BY created_at LIMIT 1),
       'finanzierung_kunde', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Finanzierung CY – Kunde');

-- Kaufvertrag: sofort Mail+WA an Kunden (Anwalts-Benachrichtigung folgt separat)
INSERT INTO automation_rules (name, description, event_type, delay_minutes, message_type, email_template_id, whatsapp_event_type, is_active)
SELECT 'Kaufvertrag – Kunde', 'ENTWURF – Mail+WA an Kunden inkl. PDFs. Anwalts-Mail (Kundendaten + Immo-Infos) separat.', 'kaufvertrag', 0, 'both',
       (SELECT id FROM email_templates WHERE name='Kaufvertrag – Kunde' AND language='de' ORDER BY created_at LIMIT 1),
       'kaufvertrag_kunde', false
WHERE NOT EXISTS (SELECT 1 FROM automation_rules WHERE name='Kaufvertrag – Kunde');
