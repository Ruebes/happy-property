-- pg_net aktivieren — wird von pg_cron gebraucht, um die Edge Function
-- process-scheduled-messages per HTTP aufzurufen (net.http_post).
-- Ohne diese Extension scheitert der Cron mit "schema net does not exist".
create extension if not exists pg_net;

-- Hinweis: Der eigentliche Cron-Job wird separat per cron.schedule angelegt
-- (enthält den Bearer-Key, daher NICHT in dieser Datei):
--   cron.schedule('process-scheduled-messages','*/5 * * * *',
--     $$ select net.http_post(url:=<func-url>, headers:=<auth>, body:='{}') $$);
