-- Baustellenfotos privat (Audit 2026-07-13): Bucket war public=true → jedes Foto
-- per object/public-URL ohne Login abrufbar, und die SELECT-Policy galt für Rolle
-- 'public' nur mit bucket_id-Check. Jetzt: Bucket privat + Auslieferung über
-- signierte URLs; sehen darf nur Staff oder ein Eigentümer MIT Wohnung im Projekt.
-- Pfadschema: <project_id>/<timestamp>-<rand>.<ext> → erstes Segment = project_id.

update storage.buckets set public = false where id = 'construction-photos';

drop policy if exists "construction_photos_bucket_eigentuemer_select" on storage.objects;
create policy "construction_photos_bucket_eigentuemer_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'construction-photos' and (
      public.current_user_role() in ('admin','verwalter')
      or exists (
        select 1
        from   public.crm_project_units u
        join   public.properties p on p.id = u.property_id
        where  u.project_id::text = split_part(name, '/', 1)
          and  p.owner_id = auth.uid()
      )
    )
  );
