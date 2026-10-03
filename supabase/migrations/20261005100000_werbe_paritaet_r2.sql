-- Werbemanager Meta-Parität, Runde 2 (05.10.2026, SPEC3 G2): Conversion-Leads.
--
-- Meta optimiert „Anzahl qualifizierter Leads maximieren“ (früher Conversion-Leads) seit
-- April 2026 nur noch mit der Conversions API für CRM. Dafür meldet das CRM für jeden
-- Sofortformular-Lead (leads.meta_leadgen_id gesetzt) die Funnel-Stufen an Meta:
--   Lead aus Sofortformular  leads INSERT bzw. meta_leadgen_id neu gesetzt (Zeit: leads.created_at,
--                         bei Wiederkehrern die Formular-Zeit meta_attr_at)
--   Termin gebucht        crm_appointments Kundentermin angelegt / wird Kundentermin
--   Termin stattgefunden  crm_appointments.outcome -> 'completed'
--   Qualifiziert          leads.quality_rating -> 'gut'                 (Zeit: quality_rated_at)
--   Kunde                 deals.phase -> 'anzahlung' | 'provision_erhalten'
-- event_id crm-<leadgen_id>-<stufe> (eine je Lead und Stufe, Dedupe über capi_outbox.event_id
-- und capi_log); daten = {crm_stufe, leadgen_id}. werbe-signal baut daraus das Ereignis
-- (action_source system_generated, user_data.lead_id, custom_data event_source 'crm',
-- lead_event_source 'Happy Property CRM') und sendet es in einem eigenen POST.
--
-- Was diese Datei anlegt bzw. ändert (additiv, nichts wird gelöscht):
--   capi_outbox event_name-Check  um die fünf Stufennamen erweitert. Die Einstiegsstufe heißt
--                                 bewusst NICHT „Lead“: das ist ein Standard-Ereignis im selben
--                                 Pixel (Website-Lead), Meta würde Sofortformular-Leads sonst
--                                 zusätzlich als Pixel-Lead zählen.
--   werbe_capi_crm_stufe()        reiht eine Stufe ein. Nur wenn ad_settings.capi_echtzeit an
--                                 ist (Svens Schalter, Einschalten nur Admin), der Lead eine
--                                 gültige Meta-Lead-ID hat und die Stufe höchstens 7 Tage alt
--                                 ist (Meta nimmt nichts Älteres an; schützt auch vor Altlasten
--                                 aus dem Nachtrag der Lead-IDs). Ausnahme bei Echtzeit aus:
--                                 Leads interner Kontakte (werbe_ist_intern_kontakt: Sven,
--                                 Verwaltung, Mitarbeitende) werden trotzdem eingereiht, damit
--                                 es vor dem Einschalten ein Testereignis gibt (werbe-signal
--                                 aktion 'test'). Gesendet wird ohne Echtzeit nichts (kein
--                                 Anstoß, werbe-signal überspringt mit grund 'echtzeit_aus').
--                                 Stufenzeit nie vor der Lead-Zeit (bei Wiederkehrern nie vor der
--                                 Formular-Zeit meta_attr_at). Reiht die Einstiegsstufe mit ein,
--                                 solange sie noch sendbar ist (Meta verlangt alle Stufen ab dem
--                                 Rohlead). Einreihen und pg_net-Anstoß über das bestehende
--                                 werbe_capi_einreihen (unverändert).
--   3 neue Trigger (eigene Funktionen, die bestehenden werbe_capi_*_trg bleiben unverändert):
--     werbe_capi_crm_lead    leads            after insert or update of meta_leadgen_id, quality_rating
--     werbe_capi_crm_termin  crm_appointments after insert or update of outcome, lead_id, internal, kind
--     werbe_capi_crm_deal    deals            after insert or update of phase
--   Jeder Trigger hat eine WHEN-Bedingung (ohne Meta-Lead-ID bzw. Lead wird die Funktion gar
--   nicht erst aufgerufen) und fängt JEDEN Fehler ab (raise warning): der eigentliche
--   Schreibvorgang scheitert nie.
--   pg_cron-Job werbe-signal-nachholen (stündlich, Minute 17): stößt werbe-signal
--     {aktion:'outbox', anlass:'cron'} an, aber NUR wenn capi_echtzeit an ist und Zeilen offen
--     sind. Nachhol-Netz für Fehlversuche (Zeile bleibt 'offen'), sonst gingen CRM-Stufen an
--     ruhigen Tagen nach 7 Tagen verloren (meta-ads-sync baut keine CRM-Stufen nach).
--     x-cron-secret zur Laufzeit aus connector_secrets, nie im Klartext in cron.job.
--     Ohne pg_cron (lokal) nur NOTICE.
--
-- Die Standard-Ereignisse (Schedule, AppointmentHeld, QualifiedLead, Purchase, Lead) laufen
-- unverändert wie bisher.
--
-- Voraussetzung: 20261003101000_leads_meta_zuordnung.sql (leads.meta_leadgen_id, meta_attr_quelle,
-- meta_attr_at) und 20261003112000_capi_outbox.sql (capi_outbox, werbe_capi_einreihen). Sonst
-- bricht die Datei am Anfang ab und ändert nichts. werbe_ist_intern_kontakt
-- (20261003111000) ist optional: fehlt sie, wird bei Echtzeit aus gar nichts eingereiht.
-- Idempotent (mehrfach ausführbar). Als Ganzes in EINER Transaktion.
-- Rückbau: rollback/20261005100000_werbe_paritaet_r2.down.sql

begin;

set local lock_timeout = '5s';

-- ── 0. Voraussetzung prüfen ─────────────────────────────────────────────────
do $chk$
begin
  if to_regclass('public.capi_outbox') is null
     or to_regprocedure('public.werbe_capi_einreihen(text, text, uuid, text, uuid, timestamptz, jsonb)') is null then
    raise exception 'Zuerst 20261003112000_capi_outbox.sql einspielen (capi_outbox / werbe_capi_einreihen fehlt)';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'leads'
         and column_name in ('meta_leadgen_id', 'meta_attr_quelle', 'meta_attr_at')) < 3 then
    raise exception 'Zuerst 20261003101000_leads_meta_zuordnung.sql einspielen (leads.meta_leadgen_id/meta_attr_* fehlt)';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'ad_settings' and column_name = 'capi_echtzeit') then
    raise exception 'Zuerst 20261003100000_werbung_fundament.sql einspielen (ad_settings.capi_echtzeit fehlt)';
  end if;
end
$chk$;

-- ── 1. event_name-Liste des Ausgangs erweitern ──────────────────────────────
-- Den alten Check (Name aus 20261003112000: capi_outbox_event_name_check) robust über die
-- Definition finden, damit auch ein anders benannter Check ersetzt wird.
do $con$
declare
  r record;
begin
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.capi_outbox'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%event_name%'
  loop
    execute format('alter table public.capi_outbox drop constraint %I', r.conname);
  end loop;
end
$con$;

alter table public.capi_outbox add constraint capi_outbox_event_name_check
  check (event_name in ('Lead', 'Schedule', 'AppointmentHeld', 'QualifiedLead', 'Purchase',
                        'Lead aus Sofortformular', 'Termin gebucht', 'Termin stattgefunden', 'Qualifiziert', 'Kunde'));

-- ── 2. Eine Stufe einreihen ─────────────────────────────────────────────────
-- Stufen-Schlüssel und Namen GLEICH zu CRM_STUFEN in supabase/functions/_shared/werbeCapi.ts
-- und src/lib/werbeWerkzeuge.ts.
create or replace function public.werbe_capi_crm_stufe(
  p_lead_id    uuid,
  p_stufe      text,
  p_quelle     text,
  p_quelle_id  uuid,
  p_event_time timestamptz default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_name     text;
  v_echtzeit boolean;
  v_leadgen  text;
  v_lead_at  timestamptz;
  v_quelle   text;
  v_attr_at  timestamptz;
  v_email    text;
  v_phone    text;
  v_whatsapp text;
  v_zeit     timestamptz;
  v_grenze   timestamptz := now() - interval '7 days';
begin
  v_name := case p_stufe
              when 'lead'                 then 'Lead aus Sofortformular'
              when 'termin_gebucht'       then 'Termin gebucht'
              when 'termin_stattgefunden' then 'Termin stattgefunden'
              when 'qualifiziert'         then 'Qualifiziert'
              when 'kunde'                then 'Kunde'
            end;
  if v_name is null or p_lead_id is null then
    return;
  end if;

  select regexp_replace(coalesce(l.meta_leadgen_id, ''), '[^0-9]', '', 'g'), l.created_at,
         l.meta_attr_quelle, l.meta_attr_at, l.email, l.phone, l.whatsapp
    into v_leadgen, v_lead_at, v_quelle, v_attr_at, v_email, v_phone, v_whatsapp
    from public.leads l
   where l.id = p_lead_id;
  -- Meta lehnt Ereignisse mit ungültiger Lead-ID ab: nur 15-17 Ziffern (leadgen_id)
  if v_leadgen is null or v_leadgen !~ '^[0-9]{15,17}$' then
    return;
  end if;

  -- Nur im Echtzeit-Betrieb (Svens Schalter). Aus = es wird nichts gesammelt, außer für
  -- interne Kontakte: deren Stufen sind der Testweg vor dem Einschalten (werbe-signal
  -- aktion 'test'); ohne Echtzeit stößt niemand den Versand an.
  select s.capi_echtzeit into v_echtzeit from public.ad_settings s where s.id = 'default';
  if not coalesce(v_echtzeit, false) then
    if to_regprocedure('public.werbe_ist_intern_kontakt(text, text, text)') is null then
      return;
    end if;
    if not coalesce(public.werbe_ist_intern_kontakt(v_email, v_phone, v_whatsapp), false) then
      return;
    end if;
  end if;

  -- Wiederkehrer: meta-leads-sync setzt die Lead-ID nachträglich auf einem älteren Lead
  -- (meta_attr_quelle 'leadgen', meta_attr_at = Zeit der Zuordnung). Lead-Zeit ist dann die
  -- Formular-Zeit, sonst ginge die Einstiegsstufe vor dem Formular-Lead an Meta.
  v_lead_at := greatest(v_lead_at, case when v_quelle = 'leadgen' then v_attr_at end);

  -- Einstiegsstufe mit einreihen (Meta: alle Stufen ab dem Rohlead), solange sie sendbar ist
  if p_stufe <> 'lead' and v_lead_at is not null and v_lead_at >= v_grenze then
    perform public.werbe_capi_einreihen('crm-' || v_leadgen || '-lead', 'Lead aus Sofortformular', p_lead_id, 'leads', p_lead_id,
                                        least(v_lead_at, now()),
                                        jsonb_build_object('crm_stufe', 'lead', 'leadgen_id', v_leadgen));
  end if;

  -- Stufenzeit nie vor der Lead-Zeit (sonst verwirft Meta das Ereignis), nie in der Zukunft
  v_zeit := least(greatest(coalesce(p_event_time, now()), coalesce(v_lead_at, '-infinity'::timestamptz)), now());
  if v_zeit < v_grenze then
    return;   -- Meta nimmt höchstens 7 Tage rückwirkend an
  end if;

  perform public.werbe_capi_einreihen('crm-' || v_leadgen || '-' || p_stufe, v_name, p_lead_id, p_quelle, p_quelle_id,
                                      v_zeit, jsonb_build_object('crm_stufe', p_stufe, 'leadgen_id', v_leadgen));
end
$fn$;

-- ── 3. Trigger-Funktionen (fangen jeden Fehler ab) ──────────────────────────
create or replace function public.werbe_capi_crm_lead_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  begin
    if new.meta_leadgen_id is null then
      return new;
    end if;
    if tg_op = 'INSERT' then
      perform public.werbe_capi_crm_stufe(new.id, 'lead', 'leads', new.id, coalesce(new.created_at, now()));
      if new.quality_rating = 'gut' then
        perform public.werbe_capi_crm_stufe(new.id, 'qualifiziert', 'leads', new.id, coalesce(new.quality_rated_at, now()));
      end if;
    else
      if old.meta_leadgen_id is distinct from new.meta_leadgen_id then
        perform public.werbe_capi_crm_stufe(new.id, 'lead', 'leads', new.id, coalesce(new.created_at, now()));
      end if;
      if new.quality_rating = 'gut' and old.quality_rating is distinct from 'gut' then
        perform public.werbe_capi_crm_stufe(new.id, 'qualifiziert', 'leads', new.id, coalesce(new.quality_rated_at, now()));
      end if;
    end if;
  exception when others then
    raise warning 'werbe_capi_crm_lead_trg (%): % [%]', tg_op, sqlerrm, sqlstate;
  end;
  return new;
end
$fn$;

create or replace function public.werbe_capi_crm_termin_trg()
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
      perform public.werbe_capi_crm_stufe(new.lead_id, 'termin_gebucht', 'crm_appointments', new.id,
                                          coalesce(new.created_at, now()));
      if new.outcome = 'completed' then
        perform public.werbe_capi_crm_stufe(new.lead_id, 'termin_stattgefunden', 'crm_appointments', new.id, now());
      end if;
    else
      -- Stufen gelten je Lead: wechselt der Lead des Termins, zählt er für den neuen Lead neu
      v_war_kunde := old.lead_id is not distinct from new.lead_id and not coalesce(old.internal, false)
                     and coalesce(old.kind, 'appointment') = 'appointment';
      if not v_war_kunde then
        perform public.werbe_capi_crm_stufe(new.lead_id, 'termin_gebucht', 'crm_appointments', new.id, now());
      end if;
      if new.outcome = 'completed' and (old.outcome is distinct from 'completed' or not v_war_kunde) then
        perform public.werbe_capi_crm_stufe(new.lead_id, 'termin_stattgefunden', 'crm_appointments', new.id, now());
      end if;
    end if;
  exception when others then
    raise warning 'werbe_capi_crm_termin_trg (%): % [%]', tg_op, sqlerrm, sqlstate;
  end;
  return new;
end
$fn$;

create or replace function public.werbe_capi_crm_deal_trg()
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
      -- eine Stufe „Kunde“ je Lead (Anzahlung und später Provision = dieselbe event_id)
      perform public.werbe_capi_crm_stufe(new.lead_id, 'kunde', 'deals', new.id, now());
    end if;
  exception when others then
    raise warning 'werbe_capi_crm_deal_trg (%): % [%]', tg_op, sqlerrm, sqlstate;
  end;
  return new;
end
$fn$;

drop trigger if exists werbe_capi_crm_lead on public.leads;
create trigger werbe_capi_crm_lead
  after insert or update of meta_leadgen_id, quality_rating on public.leads
  for each row
  when (new.meta_leadgen_id is not null)
  execute function public.werbe_capi_crm_lead_trg();

drop trigger if exists werbe_capi_crm_termin on public.crm_appointments;
create trigger werbe_capi_crm_termin
  after insert or update of outcome, lead_id, internal, kind on public.crm_appointments
  for each row
  when (new.lead_id is not null)
  execute function public.werbe_capi_crm_termin_trg();

drop trigger if exists werbe_capi_crm_deal on public.deals;
create trigger werbe_capi_crm_deal
  after insert or update of phase on public.deals
  for each row
  when (new.lead_id is not null and new.phase in ('anzahlung', 'provision_erhalten'))
  execute function public.werbe_capi_crm_deal_trg();

-- ── 4. Nachhol-Lauf (pg_cron) ───────────────────────────────────────────────
-- Stündlich, nur bei capi_echtzeit an UND offenen Zeilen (Teilindex capi_outbox_offen_idx).
-- cron.schedule mit Jobnamen legt an oder ersetzt (idempotent).
do $cron$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron fehlt: Job werbe-signal-nachholen nicht angelegt';
    return;
  end if;
  perform cron.schedule('werbe-signal-nachholen', '17 * * * *', $job$
    select net.http_post(
      url := 'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/werbe-signal',
      headers := jsonb_build_object('Content-Type', 'application/json',
                   'x-cron-secret', (select c.value from public.connector_secrets c where c.key = 'CRON_SECRET')),
      body := '{"aktion":"outbox","anlass":"cron"}'::jsonb,
      timeout_milliseconds := 5000
    )
    where coalesce((select s.capi_echtzeit from public.ad_settings s where s.id = 'default'), false)
      and exists (select 1 from public.capi_outbox o where o.status = 'offen')
      and exists (select 1 from public.connector_secrets c where c.key = 'CRON_SECRET');
  $job$);
end
$cron$;

-- ── 5. Rechte ───────────────────────────────────────────────────────────────
revoke execute on function public.werbe_capi_crm_stufe(uuid, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.werbe_capi_crm_lead_trg()   from public, anon, authenticated;
revoke execute on function public.werbe_capi_crm_termin_trg() from public, anon, authenticated;
revoke execute on function public.werbe_capi_crm_deal_trg()   from public, anon, authenticated;

comment on function public.werbe_capi_crm_stufe(uuid, text, text, uuid, timestamptz) is
  'Conversion-Leads: reiht eine CRM-Stufe (crm-<leadgen_id>-<stufe>) in capi_outbox ein. Nur bei capi_echtzeit (aus: nur interne Kontakte als Testweg), gültiger Meta-Lead-ID, höchstens 7 Tage alt.';

notify pgrst, 'reload schema';

commit;
