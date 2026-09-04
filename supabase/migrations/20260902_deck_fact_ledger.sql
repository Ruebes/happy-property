-- ── Fact-Ledger: maschinenprüfbare Wahrheit neben der redaktionellen Wissensbasis ──
-- crm_projects.deck_assets.facts bleibt unangetastet: das ist weiterhin der
-- Fließtext, aus dem Claude schreibt. Daneben steht ab jetzt eine strukturierte
-- Ebene, gegen die das Quality-Gate rechnen kann.
--
--   facts       = redaktionelles Wissen  (Prosa, für die KI)
--   deck_facts  = maschinenprüfbare Wahrheit (Wert + Quelle + Status)
--
-- Ein Fakt existiert je (Projekt, Wohnung, Schlüssel, QUELLE). Widersprechen sich
-- zwei Quellen, bleiben BEIDE Zeilen stehen und werden als conflict markiert —
-- es wird nichts heimlich überschrieben.

create table if not exists deck_facts (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references crm_projects(id) on delete cascade,
  -- NULL = projektweiter Fakt (Lage, Bauträger, Fertigstellung, Amenities)
  unit_key      text,
  unit_id       uuid references crm_project_units(id) on delete set null,

  scope         text not null check (scope in ('project','property','price','equipment','payment')),
  fact_key      text not null,     -- z.B. internal_area, net_price, completion, kitchen

  value_num     numeric,
  value_text    text,
  value_json    jsonb,
  value_unit    text,              -- m2 | EUR | % | Monat/Jahr

  -- Quellenhierarchie (kleiner = stärker). Siehe hp_deck_source_rank().
  source        text not null check (source in
                  ('manual','crm','pricelist','spec','brochure','payment_plan','ai','editorial')),
  source_rank   integer not null,
  source_file   text,
  source_page   integer,
  source_quote  text,              -- wörtlicher Beleg aus dem Dokument
  confidence    numeric,           -- 0..1

  status        text not null default 'inferred'
                  check (status in ('verified','inferred','conflict','unknown')),
  conflict_with jsonb,             -- konkurrierende Werte: [{source, value, source_file}]

  -- Sven-Override: schlägt jede andere Quelle und überlebt einen Re-Import
  is_override   boolean not null default false,
  verified_by   uuid,
  verified_at   timestamptz,
  -- Womit war der Konflikt entschieden? Ändert sich diese Signatur (neue
  -- Preisliste), lebt der Konflikt wieder auf — sonst bleibt er entschieden.
  resolved_signature text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table deck_facts is
  'Strukturierte, quellenbelegte Fakten je Projekt/Wohnung. Grundlage des Quality-Gates. Ersetzt NICHT deck_assets.facts (Prosa für die KI).';
comment on column deck_facts.source_rank is
  '1 manuell verifiziert · 2 Preisliste/CRM · 3 Spezifikation · 4 sonstiges Developer-Dokument · 5 KI-Extraktion · 6 redaktionell';
comment on column deck_facts.resolved_signature is
  'Signatur der Quellenlage zum Zeitpunkt der Sven-Entscheidung. Unverändert = Konflikt bleibt gelöst.';

-- Ein Fakt je Quelle. coalesce für projektweite Fakten (unit_key NULL).
create unique index if not exists deck_facts_uidx
  on deck_facts (project_id, coalesce(unit_key, ''), fact_key, source);
create index if not exists deck_facts_lookup_idx on deck_facts (project_id, unit_key, fact_key);
create index if not exists deck_facts_status_idx on deck_facts (project_id, status)
  where status = 'conflict';

alter table deck_facts enable row level security;
drop policy if exists deck_facts_staff on deck_facts;
create policy deck_facts_staff on deck_facts for all to authenticated
  using      ((select role from profiles where id = auth.uid()) in ('admin','verwalter'))
  with check ((select role from profiles where id = auth.uid()) in ('admin','verwalter'));
drop policy if exists deck_facts_staff_perm on deck_facts;
create policy deck_facts_staff_perm on deck_facts for all to authenticated
  using (current_user_has_perm('decks')) with check (current_user_has_perm('decks'));

drop trigger if exists deck_facts_touch on deck_facts;
create trigger deck_facts_touch before update on deck_facts
  for each row execute function hp_touch_updated_at();

-- ── Quellenhierarchie an EINER Stelle ────────────────────────────────────────
create or replace function hp_deck_source_rank(p_source text)
returns integer language sql immutable as $$
  select case p_source
    when 'manual'       then 1   -- von Sven im CRM entschieden
    when 'crm'          then 2   -- gepflegte Stammdaten (Preisliste-Import oder Handeingabe)
    when 'pricelist'    then 2   -- Developer-Preisliste
    when 'spec'         then 3   -- strukturierte Developer-Spezifikation
    when 'payment_plan' then 4
    when 'brochure'     then 4   -- sonstiges Developer-Dokument
    when 'ai'           then 5   -- KI-Extraktion ohne belegtes Zitat
    else 6                       -- freie redaktionelle Aussage
  end
$$;

-- source_rank immer konsistent zur Quelle halten (kein Aufrufer muss ihn kennen).
create or replace function hp_deck_facts_rank() returns trigger language plpgsql as $$
begin
  new.source_rank := case when new.is_override then 1 else hp_deck_source_rank(new.source) end;
  return new;
end $$;
drop trigger if exists deck_facts_rank on deck_facts;
create trigger deck_facts_rank before insert or update on deck_facts
  for each row execute function hp_deck_facts_rank();

-- ── Aufgelöste Sicht: je (Projekt, Wohnung, Schlüssel) gewinnt die stärkste Quelle ──
-- has_conflict bleibt sichtbar, auch wenn ein Gewinner feststeht — das Deck darf
-- laufen, muss aber als prüfbedürftig markiert werden.
create or replace view deck_facts_resolved as
select distinct on (f.project_id, coalesce(f.unit_key, ''), f.fact_key)
  f.project_id, f.unit_key, f.unit_id, f.scope, f.fact_key,
  f.value_num, f.value_text, f.value_json, f.value_unit,
  f.source, f.source_rank, f.source_file, f.source_page, f.source_quote,
  f.confidence, f.status, f.is_override, f.verified_at,
  (exists (
     select 1 from deck_facts c
      where c.project_id = f.project_id
        and coalesce(c.unit_key, '') = coalesce(f.unit_key, '')
        and c.fact_key = f.fact_key
        and c.status = 'conflict')) as has_conflict
from deck_facts f
order by f.project_id, coalesce(f.unit_key, ''), f.fact_key,
         f.source_rank asc, f.confidence desc nulls last, f.updated_at desc;

comment on view deck_facts_resolved is
  'Je Fakt der Gewinner nach Quellenhierarchie. has_conflict=true, solange irgendeine Zeile desselben Fakts als conflict markiert ist.';
