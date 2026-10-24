-- Terminseite je Projekt (Sven 24.10.2026): Wer auf einer Projektseite der Website
-- auf "Termin" klickt, landet auf /termin mit Projektbild im Hintergrund, eigenem
-- Projektbild vorn und eigener Überschrift. Bucht er, steht das Projekt am Deal.
--
-- slug     = Seiten-Slug der Website (/top-projekte/<slug>/). Der Funnel findet ihn
--            über ?p=<slug> oder über utm_campaign=projekt-<slug> (so verlinken alle
--            Projektseiten schon).
-- variants = Fragebogen-Varianten (?f=<slug>), die ebenfalls zu diesem Projekt
--            gehören, z. B. die Anzeigen-Zielseite 'sonderkontingent'.
-- Texte und Bilder sind öffentlich (anonym, ohne Projekt- oder Bauträgernamen),
-- project_id bleibt für anonyme Besucher unsichtbar (Spaltenrechte unten).
create table if not exists public.funnel_projects (
  slug        text primary key check (slug ~ '^[a-z0-9-]{2,80}$'),
  project_id  uuid not null references public.crm_projects(id) on delete cascade,
  title       text,
  subtitle    text,
  hero_url    text,
  bg_url      text,
  hero_label  text,
  variants    text[] not null default '{}',
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);

alter table public.funnel_projects enable row level security;

drop policy if exists funnel_projects_read on public.funnel_projects;
create policy funnel_projects_read on public.funnel_projects for select using (active);

drop policy if exists funnel_projects_write on public.funnel_projects;
create policy funnel_projects_write on public.funnel_projects for all to authenticated
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role in ('admin','funnel')))
  with check (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role in ('admin','funnel')));

revoke all on public.funnel_projects from anon;
grant select (slug, title, subtitle, hero_url, bg_url, hero_label, active) on public.funnel_projects to anon;

-- Herkunftsprojekt am Deal: über welche Projektseite (oder Projekt-Anzeige) der
-- Kontakt gekommen ist. Getrennt von deal_projects (= Immobilienauswahl im Gespräch).
alter table public.deals add column if not exists source_project_id uuid
  references public.crm_projects(id) on delete set null;
create index if not exists deals_source_project_id_idx on public.deals(source_project_id);
