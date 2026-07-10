-- Newsletter-Kampagnen: individuell personalisierte Einzel-Mails (KEINE Massenmail).
-- Jeder Empfänger bekommt eigene Deck-Klone; Versand gestaffelt über scheduled_messages
-- (event_type 'newsletter'). Zielgruppe: Leads ohne aktiven Pipeline-Deal, ohne Opt-out.
create table if not exists newsletter_campaigns (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  subject         text not null default '',
  intro_text      text not null default '',
  -- [{project_id, project_name, unit_ids[], unit_numbers[], bullets, ai_text, master_deck_token, calc_token}]
  properties      jsonb not null default '[]',
  status          text not null default 'draft' check (status in ('draft','launching','sending','done','cancelled')),
  recipients_total int not null default 0,
  recipients_done  int not null default 0,
  launch_error    text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table newsletter_campaigns enable row level security;
drop policy if exists newsletter_campaigns_admin on newsletter_campaigns;
create policy newsletter_campaigns_admin on newsletter_campaigns for all to authenticated
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'admin'))
  with check (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- Kampagnen-Zuordnung am Versand (für Fortschritt/Storno je Kampagne)
alter table scheduled_messages add column if not exists campaign_id uuid;
create index if not exists scheduled_messages_campaign_idx on scheduled_messages (campaign_id) where campaign_id is not null;
