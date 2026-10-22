-- Gesprächszusammenfassungen (Sven 22.10.26): Nach einem Kunden-Call zieht
-- zoom-calls aus der Zoom-Abschrift nur die verkaufsrelevanten Kundenfakten
-- (Beruf, Alter, Vermögen, Ziel, Zypern-Aufenthalt, Termine ...). Private
-- Themen fallen raus. Die Abschrift selbst wird nicht gespeichert, die
-- Zoom-Aufnahme danach in den Zoom-Papierkorb gelegt.
-- briefing = Kurzprofil, das der Deck-Wizard als Freitext vorbelegt.

create table if not exists public.call_summaries (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  source        text not null check (source in ('zoom', 'upload')),
  external_id   text not null,
  lead_id       uuid references public.leads(id) on delete set null,
  deal_id       uuid,
  appointment_id uuid,
  started_at    timestamptz,
  duration_min  int,
  briefing      text,
  notiz         text,
  fakten        jsonb,
  activity_id   uuid,
  status        text not null default 'neu' check (status in ('neu', 'fertig', 'uebersprungen', 'fehler')),
  grund         text,
  aufnahme_geloescht boolean not null default false,
  unique (source, external_id)
);
create index if not exists call_summaries_lead on public.call_summaries (lead_id, started_at desc);

-- Nur Edge Functions schreiben (Service-Role umgeht RLS). Das Team darf lesen.
alter table public.call_summaries enable row level security;
drop policy if exists call_summaries_team_lesen on public.call_summaries;
create policy call_summaries_team_lesen on public.call_summaries for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'verwalter', 'mitarbeiter')));
