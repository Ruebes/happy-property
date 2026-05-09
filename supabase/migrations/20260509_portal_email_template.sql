-- Standard-Portal-Vorlage (Deutsch) einfügen, falls noch keine existiert
INSERT INTO email_templates (name, subject, body, category, language)
SELECT
  'Portal-Zugang (Standard)',
  'Dein Zugang zum Happy Property Portal',
  E'Hallo {{vorname}},\n\ndein Zugang zum Happy Property Eigentümer-Portal ist jetzt eingerichtet.\n\nIm Portal findest du:\n- Deine Immobiliendaten\n- Alle Kaufunterlagen\n- Deine Zahlungsübersichten\n\nBitte ändere dein Passwort direkt nach dem ersten Login.\n\nViele Grüße\nSven Rüprich\nHappy Property',
  'portal',
  'de'
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE category = 'portal' AND language = 'de'
);
