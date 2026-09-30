-- ============================================================================
-- Portal-Kette CRM -> Eigentümer-Portal: Phasen-Filter, Besitzer-Prüfung, Sperre
-- Befund I1-2 (dazu I1-11 Punkt c, F1a-3), Audit 2026-09
--
-- Entscheidung Sven 29.9.2026: Eine Wohnung erscheint im Eigentümer-Portal erst ab
-- Deal-Phase Reservierung: reservierung, kaufvertrag, anzahlung, provision_erhalten;
-- archiviert nur, wenn archived_from_phase = 'provision_erhalten'.
-- Bestehende Portal-Objekte bleiben unangetastet: diese Migration ändert und löscht
-- keine Datenzeile, sie ersetzt nur Funktionen und den Trigger.
--
-- Bisher (Live-Stand 30.9.2026, wortgleich in der Rücknahme-Datei):
--   fn_ensure_deal_property legte das Objekt in JEDER Phase an (auch Immobilien-
--   auswahl, auch verlorene Deals), hängte ein Objekt eines anderen Eigentümers an
--   den Deal und hatte keinen Schutz gegen zwei gleichzeitige Läufe.
--
-- Neu:
--   1. hp_deal_in_portal(phase, archived_from_phase): die eine Regel (gleiche Regel
--      im Frontend: src/lib/detachProperty.ts dealInPortal).
--   2. fn_ensure_deal_property v2
--      a) Phasen-Filter: vor Reservierung wird weder angelegt noch verknüpft.
--      b) pg_advisory_xact_lock je Wohnung, danach Wohnung frisch lesen: zwei
--         gleichzeitige Läufe (Deal- und Lead-Trigger, zwei Deals derselben
--         Wohnung) legen kein zweites Objekt mehr an.
--      c) Besitzer-Prüfung: gehört das vorhandene Objekt einem anderen Profil (und
--         ist dieses Profil kein Mit-Eigentümer), wird der Deal NICHT verknüpft.
--      Alles andere (Felder, Werte, Reihenfolge) ist wortgleich zur Live-Version.
--   3. fn_trg_lead_property: Schleife nur über Deals ab Reservierung, feste
--      Reihenfolge (unit_id) gegen gegenseitiges Warten zweier Sperren.
--   4. trg_deal_sync_property feuert zusätzlich bei Phasenwechsel (UPDATE OF phase):
--      das Objekt entsteht, sobald der Deal auf Reservierung geht. Die Pipeline
--      speichert die Wohnung vor dem Phasenwechsel; ohne diese Spalte käme das
--      Objekt sonst nie.
--   fn_trg_deal_property bleibt unverändert.
--
-- Nicht Teil dieser Migration (anderes Paket): create-eigentuemer-access legt das
-- Objekt beim Zugang ebenfalls selbst an und braucht denselben Phasen-Filter.
--
-- Rücknahme: supabase/migrations/rollback/20260930220100_portal_phase_gate_rollback.sql
--
-- Prüf-Rezept (nur lesen, vor und nach dem Einspielen; die ersten drei MÜSSEN 0
-- bleiben, Stand 30.9.2026 vor der Migration: 0 / 0 / 0, Waisen 1, Objekt an Deal
-- vor Reservierung 1 = Altbestand, bleibt):
--   -- 1. doppelte Objekte (gleicher Eigentümer, Projekt, Nummer)
--   select count(*) from (select owner_id, project_name, unit_number from public.properties
--                          group by 1, 2, 3 having count(*) > 1) x;
--   -- 1b. mehrere Wohnungen am selben Objekt
--   select count(*) from (select property_id from public.crm_project_units
--                          where property_id is not null group by 1 having count(*) > 1) x;
--   -- 2. Widerspruch Deal <-> Wohnung <-> Objekt
--   select count(*) from public.deals d join public.crm_project_units u on u.id = d.unit_id
--    where d.property_id is not null and u.property_id is distinct from d.property_id;
--   -- 3. falscher Eigentümer (Objekt am Deal gehört weder dem Kunden noch einem Mit-Eigentümer)
--   select count(*) from public.deals d
--     join public.properties p on p.id = d.property_id
--     join public.leads l on l.id = d.lead_id
--    where l.profile_id is not null and p.owner_id <> l.profile_id
--      and not exists (select 1 from public.property_co_owners c
--                       where c.property_id = p.id and c.profile_id = l.profile_id);
--   -- Info: Deals ab Reservierung mit Wohnung, aber ohne Objekt (Kunde ohne Profil ist normal)
--   select count(*) from public.deals d
--    where d.unit_id is not null and d.property_id is null
--      and public.hp_deal_in_portal(d.phase, d.archived_from_phase);
--   -- Info: Objekt an Deal vor Reservierung (Altbestand, wird nicht angefasst)
--   select count(*) from public.deals d
--    where d.property_id is not null
--      and not public.hp_deal_in_portal(d.phase, d.archived_from_phase);
--   -- Info: Objekte ohne Wohnung und ohne Deal (Waisen)
--   select count(*) from public.properties p
--    where not exists (select 1 from public.crm_project_units u where u.property_id = p.id)
--      and not exists (select 1 from public.deals d where d.property_id = p.id);
-- ============================================================================

-- 1. Die eine Regel -----------------------------------------------------------
create or replace function public.hp_deal_in_portal(p_phase text, p_archived_from_phase text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(
    p_phase in ('reservierung', 'kaufvertrag', 'anzahlung', 'provision_erhalten')
    or (p_phase = 'archiviert' and p_archived_from_phase = 'provision_erhalten'),
    false)
$$;

comment on function public.hp_deal_in_portal(text, text) is
  'Entscheidung Sven 29.9.2026: Wohnung im Eigentümer-Portal erst ab Reservierung (archiviert nur aus provision_erhalten).';

-- 2. fn_ensure_deal_property v2 --------------------------------------------------
create or replace function public.fn_ensure_deal_property(p_deal_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead uuid; v_unit_id uuid; v_prop uuid; v_profile uuid;
  v_phase text; v_archived_from text; v_owner uuid;
  v_unit record; v_pid uuid;
begin
  select lead_id, unit_id, property_id, phase, archived_from_phase
    into v_lead, v_unit_id, v_prop, v_phase, v_archived_from
    from deals where id = p_deal_id;
  if v_unit_id is null or v_prop is not null then return; end if;

  -- Phasen-Filter (Entscheidung Sven 29.9.2026): Portal-Objekt erst ab Reservierung.
  if not public.hp_deal_in_portal(v_phase, v_archived_from) then return; end if;

  -- Lead muss bereits Eigentümer sein (Profil vorhanden); sonst entsteht die Property
  -- regulär beim Freischalten des Zugangs (create-eigentuemer-access).
  select profile_id into v_profile from leads where id = v_lead;
  if v_profile is null then return; end if;

  -- Sperre je Wohnung gegen Doppelanlage; danach die Wohnung frisch lesen.
  perform pg_advisory_xact_lock(hashtextextended('fn_ensure_deal_property:' || v_unit_id::text, 0));

  select cpu.id, cpu.unit_number, cpu.type, cpu.bedrooms, cpu.bathrooms, cpu.size_sqm,
         cpu.terrace_sqm, cpu.floor, cpu.block, cpu.is_furnished, cpu.rental_type,
         cpu.price_net, cpu.price_gross, cpu.property_id,
         pr.name as proj_name, pr.location as proj_loc, pr.status as proj_status
    into v_unit
    from crm_project_units cpu
    left join crm_projects pr on pr.id = cpu.project_id
   where cpu.id = v_unit_id;
  if v_unit.id is null then return; end if;

  -- Property existiert schon (z.B. über andere Stelle erzeugt) -> nur Eigentümer + Link setzen
  if v_unit.property_id is not null then
    -- Besitzer-Prüfung: das Objekt eines anderen Kunden nie an diesen Deal hängen
    -- (Mit-Eigentümer zählen als Besitzer).
    select owner_id into v_owner from properties where id = v_unit.property_id;
    if v_owner is not null and v_owner <> v_profile
       and not exists (select 1 from property_co_owners c
                        where c.property_id = v_unit.property_id and c.profile_id = v_profile) then
      return;
    end if;
    update properties set owner_id = v_profile where id = v_unit.property_id and owner_id is null;
    update deals set property_id = v_unit.property_id where id = p_deal_id;
    return;
  end if;

  insert into properties (
    project_name, unit_number, type, bedrooms, bathrooms, size_sqm, terrace_sqm,
    floor, block, is_furnished, rental_type, city,
    purchase_price_net, purchase_price_gross, property_status, owner_id, created_by, images
  ) values (
    coalesce(v_unit.proj_name, ''), v_unit.unit_number, coalesce(v_unit.type, 'apartment'),
    coalesce(v_unit.bedrooms, 0), v_unit.bathrooms, v_unit.size_sqm, v_unit.terrace_sqm,
    v_unit.floor, v_unit.block, coalesce(v_unit.is_furnished, false),
    case when v_unit.rental_type = 'short' then 'shortterm' else 'longterm' end,
    case when v_unit.proj_loc is not null and v_unit.proj_loc not like 'http%' then v_unit.proj_loc else null end,
    v_unit.price_net, v_unit.price_gross,
    case when v_unit.proj_status = 'under_construction' then 'under_construction' else 'active' end,
    v_profile, v_profile, '{}'
  ) returning id into v_pid;

  update crm_project_units set property_id = v_pid where id = v_unit.id;
  update deals set property_id = v_pid where id = p_deal_id;
end;
$$;

-- 3. Lead-Trigger: nur Deals ab Reservierung -------------------------------------
create or replace function public.fn_trg_lead_property() returns trigger
language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  for d in select id from deals
            where lead_id = new.id and unit_id is not null and property_id is null
              and public.hp_deal_in_portal(phase, archived_from_phase)
            order by unit_id loop
    perform public.fn_ensure_deal_property(d);
  end loop;
  return new;
end;
$$;

-- 4. Deal-Trigger: zusätzlich bei Phasenwechsel ----------------------------------
drop trigger if exists trg_deal_sync_property on public.deals;
create trigger trg_deal_sync_property
  after insert or update of unit_id, lead_id, property_id, phase on public.deals
  for each row
  when (new.unit_id is not null and new.property_id is null)
  execute function public.fn_trg_deal_property();
