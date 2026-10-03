-- ─────────────────────────────────────────────────────────────────────────────
-- Werbemanager: CAPI-Ausgang in Echtzeit (SPEC.md §2 „capi_outbox“, PLAN-B §3/§5).
-- Stand 3.10.2026.
--
-- capi_outbox sammelt die Conversions-API-Ereignisse in dem Moment, in dem sie im
-- CRM entstehen. Die Edge Function werbe-signal leert den Ausgang (Meta-Lead-Filter,
-- Ereignisse älter als 7 Tage werden übersprungen, capi_log als Dedupe). Der
-- Tageslauf meta-ads-sync bleibt das Nachhol-Netz mit denselben event_ids.
--
-- Ereignisse (event_id identisch mit meta-ads-sync, sonst doppelt bei Meta):
--   crm_appointments INSERT, internal = false, kind = 'appointment', lead_id gesetzt
--                                         -> Schedule        appt-<id>
--   crm_appointments outcome -> 'completed'               -> AppointmentHeld held-<id>
--   leads.quality_rating -> 'gut'                         -> QualifiedLead   goodlead-<lead id>
--   deals.phase -> 'anzahlung' | 'provision_erhalten'     -> Purchase        sale-<deal id>
--
-- Anstoß: nur wenn ad_settings.capi_echtzeit = true (Standard false; Einschalten
-- nur Admin, Settings-Guard) per pg_net an werbe-signal, höchstens einmal je
-- Transaktion, x-cron-secret zur Laufzeit aus connector_secrets (CRON_SECRET),
-- Muster 20260928200000_social_weekly_brief_cron.sql. Ohne Echtzeit sammelt der
-- Ausgang nur.
--
-- Die Trigger dürfen den eigentlichen Schreibvorgang NIE scheitern lassen: jeder
-- Fehler wird als WARNING geloggt, die Zeile wird trotzdem gespeichert. Ein
-- fehlgeschlagener pg_net-Anstoß nimmt den Ausgangs-Eintrag NICHT mit zurück
-- (eigene Subtransaktion nur um den Anstoß in werbe_capi_einreihen).
--
-- Additiv, idempotent. Rückbau: rollback/20261003112000_capi_outbox.down.sql
-- ─────────────────────────────────────────────────────────────────────────────

begin;

set local lock_timeout = '5s';

do $chk$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'ad_settings' and column_name = 'capi_echtzeit') then
    raise exception 'Zuerst 20261003100000_werbung_fundament.sql einspielen (ad_settings.capi_echtzeit fehlt)';
  end if;
  if to_regprocedure('public.werbe_ist_system()') is null then
    raise exception 'Zuerst 20261003110000_werbe_autopilot.sql einspielen (werbe_ist_system fehlt)';
  end if;
end
$chk$;

-- ── Tabelle ─────────────────────────────────────────────────────────────────
create table if not exists public.capi_outbox (
  id           bigint generated always as identity primary key,
  event_id     text not null unique,
  event_name   text not null check (event_name in ('Lead', 'Schedule', 'AppointmentHeld', 'QualifiedLead', 'Purchase')),
  lead_id      uuid references public.leads(id) on delete cascade,
  quelle       text not null check (quelle in ('crm_appointments', 'leads', 'deals', 'funnel', 'manuell')),
  quelle_id    uuid,
  event_time   timestamptz not null default now(),
  daten        jsonb not null default '{}'::jsonb,
  status       text not null default 'offen' check (status in ('offen', 'gesendet', 'uebersprungen', 'fehler')),
  grund        text,
  versuche     int not null default 0,
  claimed_at   timestamptz,
  gesendet_at  timestamptz,
  fehler       text,
  antwort      jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists capi_outbox_offen_idx   on public.capi_outbox (id) where status = 'offen';
create index if not exists capi_outbox_lead_idx    on public.capi_outbox (lead_id) where lead_id is not null;
create index if not exists capi_outbox_created_idx on public.capi_outbox (created_at);

alter table public.capi_outbox enable row level security;
drop policy if exists capi_outbox_lesen on public.capi_outbox;
create policy capi_outbox_lesen on public.capi_outbox for select to authenticated
  using (public.current_user_has_perm('werbung') or public.current_user_has_perm('werbung_meta'));
-- Keine Schreib-Policy: nur Trigger (SECURITY DEFINER) und Service-Role schreiben.

-- ── Einreihen + Anstoß ──────────────────────────────────────────────────────
create or replace function public.werbe_capi_einreihen(
  p_event_id   text,
  p_event_name text,
  p_lead_id    uuid,
  p_quelle     text,
  p_quelle_id  uuid,
  p_event_time timestamptz,
  p_daten      jsonb default '{}'::jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id       bigint;
  v_echtzeit boolean;
  v_secret   text;
begin
  insert into public.capi_outbox (event_id, event_name, lead_id, quelle, quelle_id, event_time, daten)
  values (p_event_id, p_event_name, p_lead_id, p_quelle, p_quelle_id, coalesce(p_event_time, now()),
          coalesce(p_daten, '{}'::jsonb))
  on conflict (event_id) do nothing
  returning id into v_id;

  if v_id is null then
    return;   -- schon im Ausgang
  end if;

  select s.capi_echtzeit into v_echtzeit from public.ad_settings s where s.id = 'default';
  if not coalesce(v_echtzeit, false) then
    return;
  end if;
  -- Ein Anstoß je Transaktion genügt: werbe-signal leert den ganzen Ausgang.
  if coalesce(current_setting('werbe.capi_anstoss', true), '') = '1' then
    return;
  end if;

  -- Nur der Anstoß ist abgesichert: scheitert er (pg_net fehlt/Fehler, Secret nicht
  -- lesbar), bleibt die Zeile im Ausgang (Subtransaktion nur um den Anstoß), und der
  -- nächste Anstoß bzw. der Tageslauf sendet sie.
  begin
    select c.value into v_secret from public.connector_secrets c where c.key = 'CRON_SECRET';
    if v_secret is null then
      raise warning 'werbe_capi_einreihen: CRON_SECRET fehlt in connector_secrets, kein Anstoß';
      return;
    end if;

    perform net.http_post(
      url := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/werbe-signal',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
      body := jsonb_build_object('aktion', 'outbox', 'anlass', p_event_id),
      timeout_milliseconds := 5000
    );
    perform set_config('werbe.capi_anstoss', '1', true);
  exception when others then
    raise warning 'werbe_capi_einreihen: Anstoß fehlgeschlagen, Ereignis % bleibt im Ausgang: % [%]',
      p_event_id, sqlerrm, sqlstate;
  end;
end
$fn$;

-- ── Trigger-Funktionen (fangen jeden Fehler ab) ─────────────────────────────
create or replace function public.werbe_capi_termin_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_war_kunde boolean;
begin
  begin
    if new.lead_id is null or coalesce(new.internal, false) or coalesce(new.kind, 'appointment') <> 'appointment' then
      return new;
    end if;

    if tg_op = 'INSERT' then
      perform public.werbe_capi_einreihen('appt-' || new.id::text, 'Schedule', new.lead_id, 'crm_appointments', new.id,
                                          coalesce(new.created_at, now()),
                                          jsonb_build_object('start_time', new.start_time, 'type', new.type));
      if new.outcome = 'completed' then
        perform public.werbe_capi_einreihen('held-' || new.id::text, 'AppointmentHeld', new.lead_id, 'crm_appointments',
                                            new.id, now(), jsonb_build_object('start_time', new.start_time));
      end if;
    else
      -- Termin wird erst jetzt ein Kundentermin (Lead zugeordnet, intern aufgehoben, Sperre -> Termin)
      v_war_kunde := old.lead_id is not null and not coalesce(old.internal, false)
                     and coalesce(old.kind, 'appointment') = 'appointment';
      if not v_war_kunde then
        perform public.werbe_capi_einreihen('appt-' || new.id::text, 'Schedule', new.lead_id, 'crm_appointments', new.id,
                                            coalesce(new.created_at, now()),
                                            jsonb_build_object('start_time', new.start_time, 'type', new.type));
      end if;
      if new.outcome = 'completed' and (old.outcome is distinct from 'completed' or not v_war_kunde) then
        perform public.werbe_capi_einreihen('held-' || new.id::text, 'AppointmentHeld', new.lead_id, 'crm_appointments',
                                            new.id, now(), jsonb_build_object('start_time', new.start_time));
      end if;
    end if;
  exception when others then
    raise warning 'werbe_capi_termin_trg (%): % [%]', tg_op, sqlerrm, sqlstate;
  end;
  return new;
end
$fn$;

create or replace function public.werbe_capi_lead_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  begin
    if new.quality_rating = 'gut' and old.quality_rating is distinct from 'gut' then
      perform public.werbe_capi_einreihen('goodlead-' || new.id::text, 'QualifiedLead', new.id, 'leads', new.id,
                                          coalesce(new.quality_rated_at, now()), '{}'::jsonb);
    end if;
  exception when others then
    raise warning 'werbe_capi_lead_trg: % [%]', sqlerrm, sqlstate;
  end;
  return new;
end
$fn$;

create or replace function public.werbe_capi_deal_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_neu boolean;
begin
  begin
    if new.lead_id is null or new.phase is null or new.phase not in ('anzahlung', 'provision_erhalten') then
      return new;
    end if;
    if tg_op = 'INSERT' then
      v_neu := true;
    else
      v_neu := old.phase is distinct from new.phase;
    end if;
    if v_neu then
      -- event_id je Deal: Anzahlung und später Provision ergeben EIN Purchase (on conflict do nothing).
      perform public.werbe_capi_einreihen('sale-' || new.id::text, 'Purchase', new.lead_id, 'deals', new.id, now(),
                                          jsonb_build_object('phase', new.phase, 'commission_amount', new.commission_amount));
    end if;
  exception when others then
    raise warning 'werbe_capi_deal_trg (%): % [%]', tg_op, sqlerrm, sqlstate;
  end;
  return new;
end
$fn$;

drop trigger if exists werbe_capi_termin on public.crm_appointments;
create trigger werbe_capi_termin
  after insert or update of outcome, lead_id, internal, kind on public.crm_appointments
  for each row execute function public.werbe_capi_termin_trg();

drop trigger if exists werbe_capi_lead on public.leads;
create trigger werbe_capi_lead
  after update of quality_rating on public.leads
  for each row execute function public.werbe_capi_lead_trg();

drop trigger if exists werbe_capi_deal on public.deals;
create trigger werbe_capi_deal
  after insert or update of phase on public.deals
  for each row execute function public.werbe_capi_deal_trg();

-- ── Claim für werbe-signal (Muster claim_workflow_runs) ─────────────────────
-- Offene Ereignisse mit 5-Minuten-Lease, älteste zuerst. Nur System.
create or replace function public.werbe_capi_claimen(p_limit int default 500)
returns setof public.capi_outbox
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.capi_outbox o
     set claimed_at = now(), versuche = o.versuche + 1, updated_at = now()
   where o.id in (
           select x.id from public.capi_outbox x
            where x.status = 'offen'
              and (x.claimed_at is null or x.claimed_at < now() - interval '5 minutes')
            order by x.id
            limit least(greatest(coalesce(p_limit, 500), 1), 1000)
            for update skip locked)
     and public.werbe_ist_system()
  returning o.*;
$$;

-- ── Rechte ──────────────────────────────────────────────────────────────────
revoke execute on function public.werbe_capi_einreihen(text, text, uuid, text, uuid, timestamptz, jsonb) from public, anon, authenticated;
revoke execute on function public.werbe_capi_termin_trg() from public, anon, authenticated;
revoke execute on function public.werbe_capi_lead_trg()   from public, anon, authenticated;
revoke execute on function public.werbe_capi_deal_trg()   from public, anon, authenticated;
revoke execute on function public.werbe_capi_claimen(int) from public, anon, authenticated;
grant  execute on function public.werbe_capi_claimen(int) to service_role;

comment on table public.capi_outbox is
  'CAPI-Ausgang: Ereignisse aus Terminen, Daumen und Deals; werbe-signal sendet (nur Meta-Leads), meta-ads-sync holt nach.';

notify pgrst, 'reload schema';

commit;
