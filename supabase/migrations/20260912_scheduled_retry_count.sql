-- Wiederholungszähler für scheduled_messages.
--
-- Hintergrund (11.9.2026, Heike Stachowiak): TimelinesAI lehnt nach einem
-- Sende-Burst (Baustellen-Update, 16 WhatsApps in 30 s) für rund eine Stunde
-- JEDEN Versand mit 403 quota_exceeded ab. Die Terminbestätigung, die in dieses
-- Fenster fiel, stand danach endgültig auf 'failed' - kein Retry, keine
-- Bestätigung beim Kunden. process-scheduled-messages legt solche Nachrichten
-- jetzt mit Verzögerung neu auf 'pending' und zählt hier die Versuche.
alter table public.scheduled_messages
  add column if not exists retry_count int not null default 0;
