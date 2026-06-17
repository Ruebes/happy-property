-- Postausgang: erzeugte Begleit-Mails (mit Deck-Links) liegen hier zur Freigabe.
-- Eine Zeile = eine Mail an einen Kunden, die mehrere Decks bündeln kann.
create table if not exists deck_outbox (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid references leads(id) on delete cascade,
  recipient_email text,
  subject       text,
  body          text,                 -- HTML-Mailtext inkl. Deck-Links
  deck_tokens   text[],               -- Tokens der enthaltenen Decks
  status        text not null default 'draft' check (status in ('draft','sent','cancelled')),
  error_message text,
  created_by    uuid,
  created_at    timestamptz default now(),
  sent_at       timestamptz
);
create index if not exists deck_outbox_status_idx on deck_outbox (status, created_at desc);

alter table deck_outbox enable row level security;
drop policy if exists deck_outbox_staff on deck_outbox;
create policy deck_outbox_staff on deck_outbox for all to authenticated using (true) with check (true);
