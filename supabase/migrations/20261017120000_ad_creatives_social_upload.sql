-- Social Studio: Video/Reel-Upload im Post-Editor schreibt als eingeloggter
-- Nutzer nach ad-creatives/social/video-<postId>-<ts>.<ext>. Bisher gab es
-- für diesen Ordner keine INSERT-Policy (nur ad_creatives_staff_upload für
-- studio/base/%), Upload scheiterte mit "new row violates row-level security".
-- Schreibrecht genau wie social_posts (sp_all): Recht 'funnel' oder Rolle
-- 'funnel', nur Ordner social/, nur INSERT (Client lädt ohne upsert hoch).
-- Bucket ist public-read; Service-Role (social-agent) ist nicht betroffen.
drop policy if exists ad_creatives_social_upload on storage.objects;
create policy ad_creatives_social_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ad-creatives'
    and name like 'social/%'
    and (current_user_has_perm('funnel') or current_user_role() in ('admin','verwalter','funnel'))
  );
