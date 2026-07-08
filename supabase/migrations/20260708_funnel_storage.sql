-- Funnel-Editor: Bild-Uploads (Hero + Antwort-Kacheln) landen in
-- deck-assets/funnel/*. Schreibrecht nur für Rollen admin + funnel,
-- und nur in diesem Ordner (Bucket ist public-read).
drop policy if exists funnel_assets_upload on storage.objects;
create policy funnel_assets_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'deck-assets'
    and name like 'funnel/%'
    and exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role in ('admin','funnel'))
  );
