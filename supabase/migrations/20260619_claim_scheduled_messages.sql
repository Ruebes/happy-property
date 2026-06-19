-- Atomarer Claim fälliger geplanter Nachrichten.
-- Behebt einen Race/Stuck-Bug in process-scheduled-messages: PostgREST
-- .update().eq('status','pending').limit(n) begrenzt nur die ZURÜCKGEGEBENEN Zeilen,
-- NICHT das UPDATE — es kippten ALLE fälligen Zeilen auf 'processing', die über n
-- hinaus blieben für immer hängen; bei Überlappung zweier Cron-Läufe drohte
-- Doppelversand. Diese Funktion claimt höchstens p_limit Zeilen wirklich atomar
-- (FOR UPDATE SKIP LOCKED) und gibt sie zurück.
create or replace function public.claim_scheduled_messages(p_limit int)
returns setof scheduled_messages
language sql
as $$
  update scheduled_messages
  set status = 'processing'
  where id in (
    select id from scheduled_messages
    where status = 'pending' and scheduled_at <= now()
    order by scheduled_at
    limit p_limit
    for update skip locked
  )
  returning *;
$$;
