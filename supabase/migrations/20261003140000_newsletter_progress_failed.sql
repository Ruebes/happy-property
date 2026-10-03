-- Newsletter-Fortschritt zeigt auch fehlgeschlagene Mails. Vorher stand im Archiv
-- "205/205 gesendet", obwohl 354 Mails am IONOS-Sendelimit gescheitert waren.
CREATE OR REPLACE FUNCTION public.newsletter_progress()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
select coalesce(jsonb_object_agg(campaign_id, jsonb_build_object(
  'sent', sent, 'pending', pending, 'failed', failed, 'next_at', next_at
)), '{}'::jsonb)
from (
  select campaign_id,
         count(*) filter (where status = 'sent') as sent,
         count(*) filter (where status = 'pending') as pending,
         count(*) filter (where status = 'failed') as failed,
         min(scheduled_at) filter (where status = 'pending') as next_at
  from public.scheduled_messages
  where campaign_id is not null and event_type = 'newsletter'
  group by campaign_id
) t;
$function$;
