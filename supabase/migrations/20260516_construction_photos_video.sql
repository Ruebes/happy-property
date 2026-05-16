-- Baustellenbilder Bucket: Video-Support + größeres Limit

UPDATE storage.buckets
SET
  file_size_limit    = 209715200,   -- 200 MB
  allowed_mime_types = ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/mpeg', 'video/x-m4v'
  ]
WHERE id = 'construction-photos';
