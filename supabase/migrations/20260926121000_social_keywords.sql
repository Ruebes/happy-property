-- Stichwort-Automatik „PAPHOS": Wer unter einem Facebook- oder Instagram-Post (auch
-- unter Anzeigen) PAPHOS kommentiert, bekommt per privater Antwort den aktuellen
-- Zypern-Report als PDF-Link. Edge Function social-keywords (Cron alle 3 Minuten).
--
-- comment_id unique = Idempotenz: eine Zeile wird VOR dem Senden angelegt, damit
-- parallele Läufe denselben Kommentar nie doppelt beantworten.
-- ref = kurzer Code im Report-Link (portal.happy-property.com/zypern-report?c=<ref>),
-- die Function zypern-report zählt darüber die Klicks (clicked_at, click_count).

create table if not exists social_keyword_replies (
  id               uuid primary key default gen_random_uuid(),
  comment_id       text unique not null,
  platform         text check (platform in ('facebook', 'instagram')),
  post_id          text,
  author_id        text,
  author_name      text,
  comment_text     text,
  keyword          text,
  comment_at       timestamptz,
  status           text not null default 'pending' check (status in ('sent', 'failed', 'skipped', 'pending')),
  error            text,
  attempts         int not null default 0,
  private_reply_at timestamptz,
  public_reply_at  timestamptz,
  ref              text unique,
  clicked_at       timestamptz,
  click_count      int not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists social_keyword_replies_created_idx on social_keyword_replies (created_at desc);
create index if not exists social_keyword_replies_pending_idx on social_keyword_replies (comment_at) where status = 'pending';

-- Schreiben nur über die Edge Functions (Service-Role). Lesen: Team im Studio.
alter table social_keyword_replies enable row level security;
drop policy if exists social_keyword_replies_staff_read on social_keyword_replies;
create policy social_keyword_replies_staff_read on social_keyword_replies
  for select to authenticated
  using (current_user_role() = any (array['admin', 'verwalter', 'mitarbeiter', 'funnel']));

-- Einstellungen (nur anlegen, wenn noch nicht da). active_since: Kommentare von
-- VOR dem Start werden nie angeschrieben, sondern als 'skipped' vermerkt.
insert into crm_settings (key, value, updated_at)
select 'social_keywords', jsonb_pretty(jsonb_build_object(
  'enabled', true,
  'keywords', jsonb_build_array('paphos'),
  'public_reply', true,
  'public_replies', jsonb_build_array(
    'Ist unterwegs, schau in deine Nachrichten 📩',
    'Hab dir den Report geschickt, schau mal in dein Postfach 📩',
    'Gerade rausgeschickt, viel Spaß beim Lesen 📩'
  ),
  -- Ohne Meta-Freigabe für private Nachrichten: EINE öffentliche Antwort mit Link
  -- (siehe 20260926131000_social_keywords_lease.sql für bestehende Einstellungen)
  'public_fallback_replies', jsonb_build_array(
    'Hier ist dein Zypern-Report als PDF: {{link}} 📩',
    'Gern! Den aktuellen Zypern-Report findest du hier: {{link}}'
  ),
  'dm_template', E'Hallo {{name}}, danke für deinen Kommentar! 🙌\n\nHier ist dein kostenloser Zypern-Report mit den aktuellen Entwicklungen auf dem Immobilienmarkt als PDF:\n{{link}}\n\nWenn du danach durchrechnen willst, was für dich drin ist: Hier kannst du dir ein kostenloses Gespräch mit Sven buchen:\nhttps://portal.happy-property.com/termin?src=zypern-report\n\nViele Grüße aus Paphos\nDein Happy-Property-Team\n\n(Automatische Nachricht)',
  'active_since', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
)), now()
on conflict (key) do nothing;

-- Geheimnis für den Cron-Aufruf (die Report-Function nutzt dasselbe; wer zuerst
-- kommt, legt es an).
insert into connector_secrets (key, value, updated_at)
values ('CRON_SECRET_SOCIAL', md5(gen_random_uuid()::text || clock_timestamp()::text), now())
on conflict (key) do nothing;

-- Der Scan-Cron (Go-live) steht bewusst in einer eigenen Datei:
-- 20260926140000_social_keywords_golive.sql (erst nach Svens Freigabe einspielen).
