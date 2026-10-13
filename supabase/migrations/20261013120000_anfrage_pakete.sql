-- Anfrage-Paket (Sven 13.10.26): Fragt ein Kunde Infos zu einer bestimmten Wohnung
-- an (Formular „Mehr Infos", WhatsApp oder Mail), bereitet anfrage-paket Deck,
-- Rechnungen, PDFs und Mail-/WhatsApp-Text als Entwurf im Postausgang vor.
-- Verschickt wird nichts automatisch.

create table if not exists public.anfrage_pakete (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  quelle           text not null check (quelle in ('formular', 'whatsapp', 'mail', 'manuell')),
  lead_id          uuid references public.leads(id) on delete set null,
  subscriber_id    uuid,
  empfaenger_email text,
  empfaenger_name  text,
  project_id       uuid,
  unit_id          uuid,
  quell_token      text,
  nachricht        text,
  status           text not null default 'deck' check (status in ('deck', 'fertig', 'uebersprungen', 'fehler')),
  grund            text,
  erkennung        jsonb,
  job_id           uuid,
  deck_token       text,
  calc_tokens      text[],
  outbox_id        uuid,
  task_id          uuid,
  versuche         int not null default 0,
  abschluss_at     timestamptz,
  fertig_at        timestamptz
);
create index if not exists anfrage_pakete_lead_unit on public.anfrage_pakete (lead_id, unit_id, created_at desc);
create index if not exists anfrage_pakete_offen on public.anfrage_pakete (created_at) where status = 'deck';

-- Nur Edge Functions schreiben (Service-Role umgeht RLS). Das Team darf lesen.
alter table public.anfrage_pakete enable row level security;
drop policy if exists anfrage_pakete_team_lesen on public.anfrage_pakete;
create policy anfrage_pakete_team_lesen on public.anfrage_pakete for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'verwalter', 'mitarbeiter')));

-- Eigener WhatsApp-Text je Postausgang-Eintrag (sonst baut der Postausgang den
-- Standardtext „schön, dass wir gesprochen haben" - falsch bei einer Erstanfrage).
alter table public.deck_outbox add column if not exists wa_text text;
comment on column public.deck_outbox.wa_text is 'Fertiger WhatsApp-Text (inkl. Links). Gesetzt = Postausgang sendet genau diesen Text.';

-- Schalter: on | off. Fehlende Zeile = off.
insert into public.crm_settings (key, value) values ('anfrage_paket_mode', 'on')
on conflict (key) do nothing;

-- Cron: fertige Decks einsammeln (alle 2 Min). Header wie hp-owner-drive-sweep,
-- damit kein Schlüssel im Repo steht.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hp-anfrage-paket') then
    perform cron.unschedule('hp-anfrage-paket');
  end if;
  perform cron.schedule('hp-anfrage-paket', '*/2 * * * *',
    replace(replace((select command from cron.job where jobname = 'hp-owner-drive-sweep'),
      'functions/v1/owner-drive', 'functions/v1/anfrage-paket'),
      '{"action":"sweep"}', '{"action":"abschluss"}'));
end $$;
