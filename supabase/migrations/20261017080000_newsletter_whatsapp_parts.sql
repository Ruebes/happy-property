-- Newsletter-WhatsApp als drei Nachrichten (Sven 17.10.2026): Inhalt, Immobilie
-- der Woche, Empfehlung. whatsapp_body trennt die Teile mit einer Zeile "---".
-- whatsapp_images = Bild-URL je Teil (jsonb-Array, Index = Teil, null = Standard:
-- Titelbild des verlinkten Exposés bzw. Svens Porträt, nie das Lotte-Foto).
-- wa_part = Nummer des Teils je scheduled_messages-Zeile (0, 1, 2 ...), damit
-- rebuild_pending Teile ohne Doppelversand neu befüllen kann. NULL = alte Zeile.
alter table public.newsletter_campaigns
  add column if not exists whatsapp_images jsonb;

alter table public.scheduled_messages
  add column if not exists wa_part smallint;
