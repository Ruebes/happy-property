-- Echter Versand-Fortschritt je Newsletter-Kampagne (gesendet/wartend/nächster Termin)
create or replace function public.newsletter_progress()
returns jsonb
language sql
stable
as $$
select coalesce(jsonb_object_agg(campaign_id, jsonb_build_object(
  'sent', sent, 'pending', pending, 'next_at', next_at
)), '{}'::jsonb)
from (
  select campaign_id,
         count(*) filter (where status = 'sent') as sent,
         count(*) filter (where status = 'pending') as pending,
         min(scheduled_at) filter (where status = 'pending') as next_at
  from public.scheduled_messages
  where campaign_id is not null and event_type = 'newsletter'
  group by campaign_id
) t;
$$;
revoke all on function public.newsletter_progress() from public, anon;
grant execute on function public.newsletter_progress() to authenticated, service_role;
