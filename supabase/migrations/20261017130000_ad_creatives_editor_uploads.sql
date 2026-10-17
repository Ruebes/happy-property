-- Weitere Browser-Uploads nach ad-creatives, die bisher an RLS scheiterten
-- (gleiches Problem wie social/, siehe 20261017120000). Je Ordner eine
-- INSERT-Policy, Recht jeweils wie die Seite bzw. die zugehörige Tabelle.
-- Nur INSERT, alle Clients laden ohne upsert hoch. Service-Role unberührt.

-- Thumbnail-Studio: Referenzbilder (Route-Recht 'thumbnails')
drop policy if exists ad_creatives_thumb_refs_upload on storage.objects;
create policy ad_creatives_thumb_refs_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ad-creatives'
    and name like 'thumb-refs/%'
    and current_user_has_perm('thumbnails')
  );

-- YouTube-Center: eigenes Thumbnail hochladen (wie yt_videos_staff)
drop policy if exists ad_creatives_youtube_thumbs_upload on storage.objects;
create policy ad_creatives_youtube_thumbs_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ad-creatives'
    and name like 'youtube-thumbs/%'
    and current_user_has_perm('youtube')
  );

-- Kampagnen-Assistent: Medien + Untertitel unter builder/ (wie meta_drafts_anlegen)
drop policy if exists ad_creatives_builder_upload on storage.objects;
create policy ad_creatives_builder_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ad-creatives'
    and name like 'builder/%'
    and (current_user_has_perm('werbung') or current_user_has_perm('werbung_meta'))
  );

-- Werbe-Vorrat: Bilder (wie ad_creative_pool_anlegen)
drop policy if exists ad_creatives_vorrat_upload on storage.objects;
create policy ad_creatives_vorrat_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ad-creatives'
    and name like 'vorrat/%'
    and current_user_has_perm('werbung')
  );
