-- claim_scheduled_messages gibt die geclaimten Zeilen jetzt nach scheduled_at
-- sortiert zurueck. Vorher lieferte RETURNING sie in beliebiger Reihenfolge
-- (ORDER BY im Subselect bestimmt nur, WELCHE Zeilen geclaimt werden), und
-- process-scheduled-messages arbeitet sie der Reihe nach ab. Am 17.10.2026
-- gingen die drei Teile eines Newsletters per WhatsApp deshalb als 1, 3, 2 raus.
create or replace function public.claim_scheduled_messages(p_limit int)
returns setof scheduled_messages
language sql
as $$
  with claimed as (
    update scheduled_messages
    set status = 'processing'
    where id in (
      select id from scheduled_messages
      where status = 'pending' and scheduled_at <= now()
      order by scheduled_at
      limit p_limit
      for update skip locked
    )
    returning *
  )
  select * from claimed order by scheduled_at, id;
$$;
