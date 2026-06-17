-- Postausgang: getrennte Versand-Zeitstempel für Mail und WhatsApp,
-- damit ein Deck-Angebot unabhängig per E-Mail UND/ODER WhatsApp rausgehen kann.
alter table deck_outbox add column if not exists email_sent_at    timestamptz;
alter table deck_outbox add column if not exists whatsapp_sent_at timestamptz;

-- Generisches WhatsApp-Template für den Deck-Versand (Text wird per override_text
-- aus dem Postausgang gesetzt; send-whatsapp braucht aber ein aktives Template).
insert into whatsapp_templates (name, event_type, message_template, active, recipients)
select 'Deck-Angebot', 'deck_angebot', 'Hallo {{name}}, hier sind deine Angebote: {{links}}', true, '[]'::jsonb
where not exists (select 1 from whatsapp_templates where event_type = 'deck_angebot');
