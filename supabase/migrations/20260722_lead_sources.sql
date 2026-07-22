-- Eigene Deal-/Lead-Quellen: Sven soll im Anlege-Menü weitere Quellen hinzufügen
-- können, über die fest eingebauten (META/Google/YouTube/Empfehlung/Sonstiges)
-- hinaus. Die eingebauten Quellen bleiben im Code (mit ihren Marken-Badges);
-- hier landen nur die frei angelegten. Ihr Badge kommt generisch aus
-- channelBadgeFor().
create table if not exists crm_lead_sources (
  id         uuid primary key default gen_random_uuid(),
  key        text unique not null,   -- slug, wird in deals.source/leads.source geschrieben
  label      text not null,
  created_at timestamptz default now()
);
alter table crm_lead_sources enable row level security;
-- Internes Tool hinter Admin-Login: Angemeldete dürfen lesen und anlegen.
drop policy if exists crm_lead_sources_read on crm_lead_sources;
create policy crm_lead_sources_read on crm_lead_sources for select to authenticated using (true);
drop policy if exists crm_lead_sources_insert on crm_lead_sources;
create policy crm_lead_sources_insert on crm_lead_sources for insert to authenticated with check (true);

-- leads.source war per CHECK auf 8 feste Werte begrenzt; deals.source ist frei.
-- Für eigene Quellen (YouTube + selbst angelegte) muss leads.source ebenso frei
-- sein. Das Badge fällt für unbekannte Werte sauber auf ein generisches zurück.
alter table leads drop constraint if exists leads_source_check;
