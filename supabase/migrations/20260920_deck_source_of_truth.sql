-- ── Source of Truth, Provenance, Job-Reaper (Deck-Härtung, 20.9.2026) ─────────

-- 1) Preis / Status: manuelle CRM-Pflege gewinnt gegen den Import.
--    developer_* = zuletzt aus der Bauträger-Preisliste gelesen (immer aktuell),
--    price_net / status = wirksamer Wert im CRM und im Deck (effective),
--    *_override = Sven hat bewusst abweichend gepflegt → Import fasst den
--    wirksamen Wert nicht mehr an, bis der Override zurückgesetzt wird.
alter table crm_project_units
  add column if not exists developer_price_net numeric,
  add column if not exists developer_price_net_furnished numeric,
  add column if not exists developer_price_at timestamptz,
  add column if not exists price_override boolean not null default false,
  add column if not exists price_source text not null default 'developer'
    check (price_source in ('developer','manual','ai')),
  add column if not exists price_manual_at timestamptz,
  add column if not exists developer_status text,
  add column if not exists status_override boolean not null default false,
  add column if not exists status_manual_at timestamptz;

comment on column crm_project_units.price_override is
  'true = Preis im CRM bewusst von Hand gesetzt; der Preislisten-Import aktualisiert dann nur developer_price_net, nicht price_net.';
comment on column crm_project_units.developer_price_net is
  'Nettopreis laut zuletzt gelesener Bauträger-Preisliste (Import). Wirksam im Deck ist price_net.';

-- Manuelle Änderung erkennen: ändert sich price_net, ohne dass gleichzeitig der
-- Bauträgerpreis mitgeschrieben wird (so schreibt nur der Import), war es Hand.
create or replace function hp_units_mark_manual() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.price_net is distinct from old.price_net
       and new.developer_price_net is not distinct from old.developer_price_net
       and new.developer_price_at is not distinct from old.developer_price_at then
      -- Zurück auf den Bauträgerpreis gesetzt → Override aufheben.
      if new.developer_price_net is not null and new.price_net = new.developer_price_net then
        new.price_override := false; new.price_source := 'developer'; new.price_manual_at := null;
      else
        new.price_override := true; new.price_source := 'manual'; new.price_manual_at := now();
      end if;
    end if;
    if new.status is distinct from old.status
       and new.developer_status is not distinct from old.developer_status then
      new.status_override := true; new.status_manual_at := now();
    end if;
  end if;
  return new;
end $$;
drop trigger if exists crm_project_units_mark_manual on crm_project_units;
create trigger crm_project_units_mark_manual before update on crm_project_units
  for each row execute function hp_units_mark_manual();

-- Bestand: bisherige Preise gelten als Bauträgerpreis (Import-Herkunft), manuelle
-- Units als manuell.
update crm_project_units set developer_price_net = price_net, developer_price_net_furnished = price_net_furnished, developer_price_at = created_at
 where developer_price_net is null and source = 'drive_import';
update crm_project_units set price_source = 'manual', price_override = true, price_manual_at = created_at
 where source = 'manual' and price_net is not null and price_override = false;

-- 2) Provenance generierter Assets (Higgsfield kommt später, Modell ist bereit).
alter table deck_assets_catalog
  add column if not exists generation_provider text,
  add column if not exists generation_prompt text,
  add column if not exists review_reason text;
comment on column deck_assets_catalog.review_reason is 'Warum das Asset zur Prüfung steht (Vision unsicher, Ordner ≠ Vision, Dublette, keine Textposition …).';

-- 3) Job-Reaper: haengende Läufe (Worker abgestürzt) nach 30 Minuten als failed
--    markieren. Kein automatischer Retry: ein zweiter Lauf könnte ein zweites
--    Deck erzeugen; der Wizard zeigt den Fehler, Sven startet bewusst neu.
create or replace function hp_reap_deck_jobs(p_minutes int default 30)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  with stale as (
    update deck_generation_jobs
       set status = 'failed',
           error = coalesce(error, '') || 'Abgebrochen: Lauf hing länger als ' || p_minutes || ' Minuten in ' || status || ' (Worker abgestürzt oder Zeitlimit).',
           progress = 'Abgebrochen (Zeitlimit)',
           completed_at = now(), updated_at = now()
     where status in ('queued','preparing','generating','validating')
       and coalesce(started_at, created_at) < now() - make_interval(mins => p_minutes)
     returning id)
  select count(*) into v_n from stale;
  -- Deck-Feinschliff, der nie zurückkam: Spinner lösen.
  update sales_decks set refining = false, refine_error = coalesce(refine_error, 'Abgebrochen: Feinschliff hing länger als ' || p_minutes || ' Minuten.')
   where refining = true and updated_at < now() - make_interval(mins => p_minutes);
  return v_n;
end $$;

select cron.unschedule('hp-deck-job-reaper') where exists (select 1 from cron.job where jobname = 'hp-deck-job-reaper');
select cron.schedule('hp-deck-job-reaper', '*/10 * * * *', $$select hp_reap_deck_jobs(30)$$);
