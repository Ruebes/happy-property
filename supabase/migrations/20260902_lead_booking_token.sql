-- Persönlicher Terminlink pro Lead (ersetzt die alten Calendly-Links in den
-- WhatsApp-/Mail-Automationen). Der Token hängt am Lead, nicht am Deck: der
-- Direkteinstieg /termin?direkt=1&b=<token> überspringt Fragebogen UND
-- Kontaktformular, weil funnel-api den Lead über den Token auflöst.
-- Bisher ging das nur über einen Deck-Token (?d=), den längst nicht jeder Lead hat.
alter table leads
  add column if not exists booking_token uuid not null default gen_random_uuid();

create unique index if not exists leads_booking_token_idx
  on leads (booking_token);
