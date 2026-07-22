-- Posteingang-Fundament: automatische von handgeschriebenen Nachrichten trennen
-- + eingehende Kundenmails einem Lead zuordnen.
--
-- Sven: „Ich möchte eine echte Inbox haben, für Mails und WhatsApp … Was wir in
-- diesem Reiter nicht benötigen, sind die automatischen Mails."
--
-- Bisher gibt es KEIN verlässliches Feld, das Automatik von Hand-getippt trennt
-- (created_by ist bei fast allen WhatsApps NULL). Deshalb ein explizites Flag.

-- auto=true → von einer Automatik erzeugt (Drip, Bot, System, Erinnerung).
-- Der Posteingang blendet diese aus; die Lead-Chronik zeigt weiter alles.
-- Default false ist die SICHERE Richtung: eine vergessene Automatik-Markierung
-- zeigt eine Nachricht zu viel — schlimmer wäre, eine echte Kundennachricht zu
-- verstecken.
alter table activities add column if not exists auto boolean not null default false;

-- Backfill der bestehenden Zeilen anhand belegter Muster (siehe Betreff-Analyse):
--  • Ausgehende WhatsApp mit Betreff „WhatsApp: <event_type>" = Edge-Function-Log
--    = Automatik. Handgeschriebene tragen „Kontakt …" / „WhatsApp → …".
update activities set auto = true
  where direction = 'outbound' and type = 'whatsapp' and subject like 'WhatsApp: %';
--  • Ausgehende Mails ohne created_by = serverseitig = Automatik. Die 8 mit
--    created_by sind der handgeschriebene Composer.
update activities set auto = true
  where direction = 'outbound' and type = 'email' and created_by is null;

-- Index für die Posteingang-Abfrage (nur Nachrichten, nur nicht-automatische bzw.
-- eingehende, neueste zuerst).
create index if not exists idx_activities_inbox
  on activities (completed_at desc)
  where type in ('email', 'whatsapp') and (auto = false or direction = 'inbound');

-- Eingehende Kundenmail einem Lead zuordnen: normalisiert (klein, googlemail→gmail)
-- gegen leads.email. Analog zu find_leads_by_phone_suffix für WhatsApp.
create or replace function find_lead_by_email(p_email text)
returns table (id uuid)
language sql stable
as $$
  with norm as (
    select lower(trim(regexp_replace(p_email, '.*<([^>]+)>.*', '\1'))) as e
  )
  select l.id from leads l, norm
  where l.email is not null
    and replace(lower(trim(l.email)), 'googlemail.com', 'gmail.com')
      = replace(norm.e, 'googlemail.com', 'gmail.com')
  order by l.created_at desc
  limit 1
$$;
