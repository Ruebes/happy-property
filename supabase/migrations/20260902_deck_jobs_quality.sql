-- ── Job-System + Quality-Gate ────────────────────────────────────────────────
-- Heute erkennt der Wizard „fertig" daran, dass für (lead_id, project_id) ein
-- NEUER Token auftaucht (DeckWizard.tsx:190-214). Das kann Fehlschlag und
-- Timeout nicht unterscheiden, greift bei parallelen Läufen das falsche Deck und
-- ist beim generischen Projekt-Deck grundsätzlich blind (dessen Token bleibt
-- gleich). Ab jetzt gibt es einen echten Job mit Status.
--
-- Claim-Muster übernommen von claim_workflow_runs (20260812_funnel_workflows.sql)
-- inkl. FOR UPDATE SKIP LOCKED und Lease — PostgREST .limit() begrenzt nur die
-- Rückgabe, nicht das UPDATE (dokumentiert in 20260619_claim_scheduled_messages).

create table if not exists deck_generation_jobs (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null default 'deck' check (kind in ('deck','generic_deck','refine')),

  lead_id            uuid references leads(id) on delete cascade,
  project_id         uuid references crm_projects(id) on delete set null,
  requested_unit_ids uuid[] not null default '{}',
  deck_token         text,                    -- bei refine: das bearbeitete Deck
  sales_deck_id      uuid references sales_decks(id) on delete set null,

  status             text not null default 'queued' check (status in
                       ('queued','preparing','generating','validating','ready','review_required','failed')),
  progress           text,                    -- kurze Klartext-Stufe für die Oberfläche
  quality_status     text check (quality_status in ('green','red')),
  error              text,
  attempt            integer not null default 0,
  max_attempts       integer not null default 3,
  next_due_at        timestamptz not null default now(),

  request            jsonb not null default '{}'::jsonb,   -- Aufrufparameter (idempotentes Retry)
  created_by         uuid,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  completed_at       timestamptz,
  updated_at         timestamptz not null default now()
);

comment on table deck_generation_jobs is
  'Ein Lauf der Deck-Erzeugung. Der Wizard pollt diese Zeile statt auf einen neuen Token zu raten.';
comment on column deck_generation_jobs.request is
  'Der vollständige generate-deck-Body. Erlaubt einen Wiederholungslauf ohne die Oberfläche.';

create index if not exists deck_jobs_status_idx on deck_generation_jobs (status, next_due_at);
create index if not exists deck_jobs_lead_idx   on deck_generation_jobs (lead_id, created_at desc);
create index if not exists deck_jobs_token_idx  on deck_generation_jobs (deck_token);

alter table deck_generation_jobs enable row level security;
drop policy if exists deck_jobs_staff on deck_generation_jobs;
create policy deck_jobs_staff on deck_generation_jobs for all to authenticated
  using      ((select role from profiles where id = auth.uid()) in ('admin','verwalter'))
  with check ((select role from profiles where id = auth.uid()) in ('admin','verwalter'));
drop policy if exists deck_jobs_staff_perm on deck_generation_jobs;
create policy deck_jobs_staff_perm on deck_generation_jobs for all to authenticated
  using (current_user_has_perm('decks')) with check (current_user_has_perm('decks'));

drop trigger if exists deck_jobs_touch on deck_generation_jobs;
create trigger deck_jobs_touch before update on deck_generation_jobs
  for each row execute function hp_touch_updated_at();

-- Atomarer Claim hängengebliebener Jobs mit 10-Minuten-Lease. Ein Job, der in
-- einer abgestürzten Edge-Invocation stecken blieb, wird so wieder aufgenommen,
-- ohne dass zwei Läufe dasselbe Deck schreiben.
create or replace function claim_deck_jobs(p_limit int default 5)
returns setof deck_generation_jobs language sql security definer as $$
  update deck_generation_jobs
     set next_due_at = now() + interval '10 minutes',
         attempt     = attempt + 1,
         status      = 'preparing',
         updated_at  = now()
   where id in (
     select id from deck_generation_jobs
      where status in ('queued','preparing','generating','validating')
        and next_due_at <= now()
        and attempt < max_attempts
      order by next_due_at
      limit p_limit
      for update skip locked
   )
  returning *;
$$;

-- ── Quality-Gate am Deck ─────────────────────────────────────────────────────
-- BEWUSST eigene Spalten statt sales_decks.status: status wird über
-- get_deck_by_token öffentlich ausgeliefert und von partner-akte an Partner
-- durchgereicht. Ein Wert 'review' würde dort sichtbar. Das Gate bleibt intern.
alter table sales_decks add column if not exists quality_status     text
  check (quality_status in ('green','red','skipped'));
alter table sales_decks add column if not exists quality_report     jsonb;
alter table sales_decks add column if not exists quality_checked_at timestamptz;

comment on column sales_decks.quality_status is
  'green = automatisch validiert · red = Konflikt/Unsicherheit, im CRM prüfen · skipped = Deck stammt aus einem Pfad ohne Gate (z.B. Newsletter-Klon).';
comment on column sales_decks.quality_report is
  'Vollständiger Gate-Bericht: { findings[], facts_snapshot[], images[], scrub_events[], checked_blocks }.';

create index if not exists sales_decks_quality_idx on sales_decks (quality_status)
  where quality_status = 'red';

-- Newsletter-Klone erben den Bericht des Masters nicht sinnvoll: sie ersetzen
-- {{vorname}} und haben weder unit_id noch created_by. Bestandsdecks bleiben
-- NULL (= nie geprüft) und werden im CRM neutral, nicht rot dargestellt.

-- Der vollständige Faktenkontext am Deck (Wohnungen, Preise, MwSt, Zahlungsplan,
-- Grundrisse). Bis hierher lebten diese Werte NUR im jeweiligen Block — ein
-- Feinschliff, der einen Block ersetzte, löschte sie unbemerkt. Mit dem Kontext
-- kann refine-deck sie nach jeder Bearbeitung deterministisch neu setzen.
alter table sales_decks add column if not exists deck_context jsonb;
comment on column sales_decks.deck_context is
  'Deterministischer Faktenkontext des Decks (_shared/deckContext.ts). Grundlage für Re-Normalisierung nach jedem Feinschliff und für das Quality-Gate.';
