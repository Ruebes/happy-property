-- Tippgeber-Adresse automatisch beschaffen (Sven 23.10.2026).
-- 1) Bei der Zuweisung sucht affiliate-api die Adresse des Empfehlungsgebers im
--    Profil, bei den Rechnungskunden und in seinen Drive-Unterlagen (Kaufvertrag,
--    Reservierung, Ausweis ...), nur wenn sein Name dort mit Adresse steht.
-- 2) Sonst fragt Lotte per WhatsApp, sobald der geworbene Kunde auf Reservierung steht.
-- 3) Die Antwort trägt waInbound -> affiliate-api (address_reply) automatisch ein.
-- Rücknahme: rollback/20261023100000_affiliate_address.down.sql
alter table public.affiliates
  add column if not exists address_source       text,         -- profil | rechnungskunde | dokument | whatsapp | manuell
  add column if not exists address_note         text,         -- Herkunft bzw. Suchergebnis in Klartext
  add column if not exists address_checked_at   timestamptz,  -- letzte automatische Suche in den Unterlagen
  add column if not exists address_requested_at timestamptz,  -- Lotte hat per WhatsApp nach der Adresse gefragt
  add column if not exists address_reply_text   text;         -- Antwort(en) bisher, solange die Adresse unvollständig ist
