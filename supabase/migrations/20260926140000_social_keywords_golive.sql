-- GO-LIVE der Stichwort-Automatik: erst nach Svens ausdrücklicher Freigabe einspielen.
-- Ab dann bekommt jeder, der ein Stichwort kommentiert, automatisch eine Antwort.

-- 1) Antwort je Stichwort (die Reels versprechen unterschiedliche Dinge).
--    report:false = kein Report-Link anhängen (Text bringt eigene Links).
update crm_settings set value = jsonb_set(value::jsonb, '{rules}', $rules$[
  {"keywords": ["paphos"], "report": true,
   "dm_template": "Hallo {{name}}, danke für deinen Kommentar! 🙌\n\nHier ist dein kostenloser Zypern-Report mit den aktuellen Entwicklungen auf dem Immobilienmarkt (PDF):\n{{link}}\n\nDie passenden Angebote rund um Paphos stellt dir Sven gern persönlich vor. Hier kannst du dir ein kostenloses Gespräch buchen:\nhttps://portal.happy-property.com/termin?src=stichwort-paphos\n\nViele Grüße aus Paphos\nDein Happy-Property-Team\n\n(Automatische Nachricht)"},
  {"keywords": ["rendite"], "report": true,
   "dm_template": "Hallo {{name}}, danke für deinen Kommentar! 🙌\n\nDie Wohnung mit der schlechtesten Sicht und der besten Rendite zeigt dir Sven gern persönlich, mit allen Zahlen. Hier kannst du dir ein kostenloses Gespräch buchen:\nhttps://portal.happy-property.com/termin?src=stichwort-rendite\n\nVorab zum Lesen unser aktueller Zypern-Report (PDF):\n{{link}}\n\nViele Grüße aus Paphos\nDein Happy-Property-Team\n\n(Automatische Nachricht)",
   "fallback_replies": ["Gern! Die Zahlen zeigt dir Sven persönlich, hier kannst du dir einen Termin sichern: https://portal.happy-property.com/termin?src=stichwort-rendite"]},
  {"keywords": ["rechner"], "report": false,
   "dm_template": "Hallo {{name}}, danke für deinen Kommentar! 🙌\n\nHier sind unsere zwei kostenlosen Rechner:\n\nWas bringt mir Zypern? (Cashflow deiner Wohnung)\nhttps://steuervorteil-zypern-immobilien.com/cashflow-rechner/\n\nDeutschland oder Zypern? (Rendite im Vergleich)\nhttps://steuervorteil-zypern-immobilien.com/der-renditerechner-von-happy-property/\n\nWenn du deine Zahlen mit Sven durchgehen willst:\nhttps://portal.happy-property.com/termin?src=stichwort-rechner\n\nViele Grüße aus Paphos\nDein Happy-Property-Team\n\n(Automatische Nachricht)",
   "fallback_replies": ["Gern! Unsere kostenlosen Rechner findest du hier: https://steuervorteil-zypern-immobilien.com/cashflow-rechner/"]},
  {"keywords": ["newsletter"], "report": true,
   "dm_template": "Hallo {{name}}, danke für deinen Kommentar! 🙌\n\nHier kannst du dich für unseren Newsletter „Zypern-Insights“ eintragen. Dann bekommst du die besten Immobilienangebote rund um Paphos als Erstes:\nhttps://steuervorteil-zypern-immobilien.com/newsletter-zypern-insights/\n\nAls kleines Willkommen unser aktueller Zypern-Report (PDF):\n{{link}}\n\nViele Grüße aus Paphos\nDein Happy-Property-Team\n\n(Automatische Nachricht)",
   "fallback_replies": ["Gern! Hier kannst du dich für den Newsletter eintragen: https://steuervorteil-zypern-immobilien.com/newsletter-zypern-insights/"]},
  {"keywords": ["strategie"], "report": true,
   "dm_template": "Hallo {{name}}, danke für deinen Kommentar! 🙌\n\nDeine Strategie hängt von deinen Zahlen ab: Einkommen, Eigenkapital und Ziel. Genau die rechnet Sven mit dir in einem kostenlosen Strategiegespräch durch:\nhttps://portal.happy-property.com/termin?src=stichwort-strategie\n\nZur Vorbereitung unser aktueller Zypern-Report mit Markt, Kaufablauf und Steuern (PDF):\n{{link}}\n\nViele Grüße aus Paphos\nDein Happy-Property-Team\n\n(Automatische Nachricht)",
   "fallback_replies": ["Gern! Hier kannst du dir dein kostenloses Strategiegespräch mit Sven sichern: https://portal.happy-property.com/termin?src=stichwort-strategie"]},
  {"keywords": ["finanzamt"], "report": true,
   "dm_template": "Hallo {{name}}, danke für deinen Kommentar! 🙌\n\nWie viel dir das Finanzamt zurückgibt, hängt von deinem Einkommen und deiner Finanzierung ab. Das rechnet Sven mit dir in einem kostenlosen Strategiegespräch durch:\nhttps://portal.happy-property.com/termin?src=stichwort-finanzamt\n\nVorab: In unserem aktuellen Zypern-Report steht das Wichtigste zu den Steuern (PDF):\n{{link}}\n\nViele Grüße aus Paphos\nDein Happy-Property-Team\n\n(Automatische Nachricht)",
   "fallback_replies": ["Gern! Hier kannst du dir dein kostenloses Strategiegespräch mit Sven sichern: https://portal.happy-property.com/termin?src=stichwort-finanzamt"]}
]$rules$::jsonb)::text, updated_at = now()
where key = 'social_keywords';

-- 2) Start: nur Kommentare ab jetzt beantworten.
update crm_settings set value = jsonb_set(jsonb_set(value::jsonb, '{active_since}', to_jsonb(now()::text)), '{enabled}', 'true'::jsonb)::text, updated_at = now()
where key = 'social_keywords';

-- 3) Scan-Cron:
-- Cron: alle 3 Minuten scannen. Das Secret wird zur Laufzeit gelesen und steht so
-- nicht im Klartext in cron.job.
select cron.schedule('social-keywords-scan', '*/3 * * * *', $cron$
  select net.http_post(
    url := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/social-keywords',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from connector_secrets where key = 'CRON_SECRET_SOCIAL')
    ),
    body := '{"action":"scan"}'::jsonb
  )
$cron$);
