-- Funnel-Workflows: visueller, verzweigender Automations-Flow-Builder (Giona).
-- Ein Workflow ist ein Graph (nodes+edges) in funnel_workflows.graph. Jeder Lead
-- im Flow hat eine Zeile in funnel_workflow_runs (current_node_id + next_due_at).
-- Ausgefuehrt von der Edge Function run-workflows (pg_cron */5).
-- (In der Live-DB bereits per Management-API angelegt; diese Datei dokumentiert die DDL.)

create table if not exists funnel_workflows (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft','active','paused')),
  trigger_type text not null default 'manual' check (trigger_type in ('manual','funnel_signup','pipeline_phase','list')),
  trigger_config jsonb not null default '{}'::jsonb,
  graph jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists funnel_workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references funnel_workflows(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,
  subscriber_id uuid references newsletter_subscribers(id) on delete cascade,
  status text not null default 'active' check (status in ('active','completed','stopped','failed')),
  current_node_id text,
  next_due_at timestamptz not null default now(),
  context jsonb not null default '{}'::jsonb,
  entered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_error text
);
create index if not exists idx_fwr_due on funnel_workflow_runs (status, next_due_at);
create index if not exists idx_fwr_workflow on funnel_workflow_runs (workflow_id);
create unique index if not exists uniq_fwr_lead_active on funnel_workflow_runs (workflow_id, lead_id) where status='active' and lead_id is not null;

alter table funnel_workflows enable row level security;
alter table funnel_workflow_runs enable row level security;
drop policy if exists fw_staff on funnel_workflows;
create policy fw_staff on funnel_workflows for all to authenticated using (current_user_has_perm('funnel')) with check (current_user_has_perm('funnel'));
drop policy if exists fwr_staff on funnel_workflow_runs;
create policy fwr_staff on funnel_workflow_runs for all to authenticated using (current_user_has_perm('funnel')) with check (current_user_has_perm('funnel'));

-- Atomarer Claim faelliger Laeufe mit 15-Min-Lease (gegen Doppelverarbeitung).
create or replace function claim_workflow_runs(p_limit int default 50)
returns setof funnel_workflow_runs language sql security definer as $$
  update funnel_workflow_runs set next_due_at = now() + interval '15 minutes', updated_at = now()
  where id in (
    select id from funnel_workflow_runs
    where status='active' and next_due_at <= now()
    order by next_due_at limit p_limit for update skip locked
  ) returning *;
$$;

-- pg_cron (im SQL-Editor mit Service-Role-Bearer anlegen, enthaelt Secret):
-- select cron.schedule('run-workflows','*/5 * * * *', $$ select net.http_post(
--   url:='https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/run-workflows',
--   headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SERVICE_ROLE_KEY>'),
--   body:='{}'::jsonb) $$);
