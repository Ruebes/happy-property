-- Server-seitige Integrations-Tokens (z.B. Revolut refresh_token).
-- RLS aktiv OHNE Policies = nur service_role (Edge Functions) kommt ran.
create table if not exists integration_secrets (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table integration_secrets enable row level security;
