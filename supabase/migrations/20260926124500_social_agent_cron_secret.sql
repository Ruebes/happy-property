-- social-agent: pg_cron authenticates with x-cron-secret instead of the publishable key.
-- The publishable key ships in the frontend bundle, so it must not unlock the function.
-- The secret lives in connector_secrets (CRON_SECRET_SOCIAL) and is looked up when the
-- job runs, so it never appears in cron.job.command and can be rotated in one place.

insert into public.connector_secrets (key, value, updated_at)
values ('CRON_SECRET_SOCIAL', encode(extensions.gen_random_bytes(16), 'hex'), now())
on conflict (key) do nothing;

do $$
declare
  j record;
  jid bigint;
begin
  for j in
    select * from (values
      ('linkedin-token-watch',   'linkedin_watchdog'),
      ('social-auto-publish',    'auto_publish'),
      ('youtube-social-post',    'youtube_post'),
      ('hp-social-interactions', 'interactions_sync'),
      ('social-autopilot',       'autopilot')
    ) as t(jobname, action)
  loop
    select jobid into jid from cron.job where jobname = j.jobname;
    if jid is null then
      raise notice 'cron job % not found, skipped', j.jobname;
      continue;
    end if;
    perform cron.alter_job(
      job_id  := jid,
      command := format(
        $cmd$select net.http_post(url:=%L, headers:=jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from public.connector_secrets where key = 'CRON_SECRET_SOCIAL')), body:=%L::jsonb)$cmd$,
        'https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/social-agent',
        jsonb_build_object('action', j.action)::text
      )
    );
  end loop;
end $$;
