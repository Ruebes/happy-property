-- Audit Wohnungen/Übergabe (30.08.2026)
--
-- 1) Portal-Kopie driftete: der Sync spiegelte nur Nummer/Flächen/Zimmer/Preise.
--    Bäder, Etage, Block, Möblierung und Typ blieben auf dem Stand der Anlage
--    (properties.bathrooms hat Default 1 → Infinity 302/202 zeigten 1 statt 2).
-- 2) Rückwärts-Sync (Portal → Unit) setzte den Unit-Status hart auf den Bau-Status
--    und löschte damit 'sold'/'reserved'/'proposal'. Jede Portal-Änderung an
--    property_status/rental_type machte eine verkaufte Wohnung wieder anbietbar.
-- 3) Mitarbeiter (Rolle 'mitarbeiter' mit Pipeline-Recht) durften Unit-Dokumente
--    und Unit-Bilder in der DB sehen, aber nicht im Storage öffnen/hochladen.

-- ── 1) Vorwärts-Sync: alle Fakten spiegeln ───────────────────────────────────
create or replace function hp_sync_property_from_unit() returns trigger
language plpgsql security definer as $$
begin
  if new.property_id is not null then
    update properties p
       set property_status      = hp_build_status(new.status),
           rental_type          = coalesce(hp_rental_to_property(new.rental_type), p.rental_type),
           unit_number          = coalesce(new.unit_number, p.unit_number),
           size_sqm             = coalesce(new.size_sqm, p.size_sqm),
           terrace_sqm          = coalesce(new.terrace_sqm, p.terrace_sqm),
           bedrooms             = coalesce(new.bedrooms, p.bedrooms),
           bathrooms            = coalesce(new.bathrooms, p.bathrooms),
           floor                = coalesce(new.floor, p.floor),
           block                = coalesce(new.block, p.block),
           is_furnished         = coalesce(new.is_furnished, p.is_furnished),
           type                 = coalesce(new.type, p.type),
           purchase_price_net   = coalesce(new.price_net, p.purchase_price_net),
           purchase_price_gross = coalesce(new.price_gross, p.purchase_price_gross),
           project_name         = coalesce((select name from crm_projects where id = new.project_id), p.project_name)
     where p.id = new.property_id
       and (p.property_status      is distinct from hp_build_status(new.status)
         or p.rental_type          is distinct from coalesce(hp_rental_to_property(new.rental_type), p.rental_type)
         or p.unit_number          is distinct from coalesce(new.unit_number, p.unit_number)
         or p.size_sqm             is distinct from coalesce(new.size_sqm, p.size_sqm)
         or p.terrace_sqm          is distinct from coalesce(new.terrace_sqm, p.terrace_sqm)
         or p.bedrooms             is distinct from coalesce(new.bedrooms, p.bedrooms)
         or p.bathrooms            is distinct from coalesce(new.bathrooms, p.bathrooms)
         or p.floor                is distinct from coalesce(new.floor, p.floor)
         or p.block                is distinct from coalesce(new.block, p.block)
         or p.is_furnished         is distinct from coalesce(new.is_furnished, p.is_furnished)
         or p.type                 is distinct from coalesce(new.type, p.type)
         or p.purchase_price_net   is distinct from coalesce(new.price_net, p.purchase_price_net)
         or p.purchase_price_gross is distinct from coalesce(new.price_gross, p.purchase_price_gross)
         or p.project_name         is distinct from coalesce((select name from crm_projects where id = new.project_id), p.project_name));
  end if;
  return new;
end $$;

drop trigger if exists trg_hp_sync_property_from_unit on crm_project_units;
create trigger trg_hp_sync_property_from_unit
  after insert or update of status, property_id, unit_number, size_sqm, terrace_sqm,
    bedrooms, bathrooms, floor, block, is_furnished, type, price_net, price_gross,
    project_id, rental_type
  on crm_project_units for each row execute function hp_sync_property_from_unit();

-- ── 2) Rückwärts-Sync: Verkaufsstatus nie überschreiben ──────────────────────
create or replace function hp_sync_unit_from_property() returns trigger
language plpgsql security definer as $$
begin
  update crm_project_units u
     set status      = case when u.status in ('sold','reserved','proposal')
                            then u.status                       -- Verkaufsstatus hat Vorrang
                            else hp_build_status(new.property_status) end,
         rental_type = coalesce(hp_rental_to_unit(new.rental_type), u.rental_type)
   where u.property_id = new.id
     and (u.status      is distinct from (case when u.status in ('sold','reserved','proposal')
                                               then u.status
                                               else hp_build_status(new.property_status) end)
       or u.rental_type is distinct from coalesce(hp_rental_to_unit(new.rental_type), u.rental_type));
  return new;
end $$;

-- ── 3) Einmal-Backfill: bestehende Portal-Kopien an die Unit angleichen ──────
update properties p
   set bathrooms    = coalesce(u.bathrooms, p.bathrooms),
       floor        = coalesce(u.floor, p.floor),
       block        = coalesce(u.block, p.block),
       is_furnished = coalesce(u.is_furnished, p.is_furnished),
       type         = coalesce(u.type, p.type),
       terrace_sqm  = coalesce(u.terrace_sqm, p.terrace_sqm)
  from crm_project_units u
 where u.property_id = p.id
   and (p.bathrooms    is distinct from coalesce(u.bathrooms, p.bathrooms)
     or p.floor        is distinct from coalesce(u.floor, p.floor)
     or p.block        is distinct from coalesce(u.block, p.block)
     or p.is_furnished is distinct from coalesce(u.is_furnished, p.is_furnished)
     or p.type         is distinct from coalesce(u.type, p.type)
     or p.terrace_sqm  is distinct from coalesce(u.terrace_sqm, p.terrace_sqm));

-- ── 4) Storage: Mitarbeiter mit Pipeline-Recht dürfen Unit-Dateien nutzen ────
drop policy if exists unit_docs_staff_all on storage.objects;
create policy unit_docs_staff_all on storage.objects for all to authenticated
  using      (bucket_id = 'unit-documents' and current_user_has_perm('pipeline'))
  with check (bucket_id = 'unit-documents' and current_user_has_perm('pipeline'));

drop policy if exists unit_images_staff_all on storage.objects;
create policy unit_images_staff_all on storage.objects for all to authenticated
  using      (bucket_id = 'unit-images' and current_user_has_perm('pipeline'))
  with check (bucket_id = 'unit-images' and current_user_has_perm('pipeline'));
