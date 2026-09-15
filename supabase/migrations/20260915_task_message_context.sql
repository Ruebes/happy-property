-- ── Rückfragen immer mit Aufgabenbezug ──────────────────────────────────────
-- Vorfall 15.9.: Leonard hat eine Rückfrage als Teilaufgabe an Sven gestellt.
-- Bei Sven kam nur der Titel der Teilaufgabe an - ohne Hauptaufgabe, ohne den
-- Verlauf, auf den sich die Frage bezog. Und Gionas "@Sven ..."-Nachricht vom
-- 11.9. hat Sven nie erreicht, weil sie an Leonard adressiert war.
--
-- Drei Bausteine:
--  1) ext_notified_at: Riegel (Compare-and-Swap) für die externe Meldung
--     (WhatsApp/Mail) jeder Aufgaben-Nachricht - egal, über welchen Weg sie
--     entstanden ist (App, Token-Link, Mail-Antwort, WhatsApp-Antwort).
--  2) task_parent_context(): liefert dem Zuarbeitenden Titel, Beschreibung und
--     die letzten Nachrichten der Hauptaufgabe. Per RLS darf er die Hauptaufgabe
--     sonst nicht sehen - er ist dort kein Teilnehmer.
--  3) Index für den 5-Minuten-Sweep.

alter table crm_task_messages add column if not exists ext_notified_at timestamptz;
create index if not exists idx_task_msg_ext_pending on crm_task_messages(created_at)
  where ext_notified_at is null;

create or replace function task_parent_context(t uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when p.id is null then null else jsonb_build_object(
    'parent_id',   p.id,
    'title',       p.title,
    'description', p.description,
    'status',      p.status,
    'created_by',  p.created_by,
    'creator',     coalesce(pr.full_name, ''),
    'messages',    coalesce((
      select jsonb_agg(jsonb_build_object(
        'who',        coalesce(sp.full_name, m.sender_label, 'Extern'),
        'body',       m.body,
        'created_at', m.created_at
      ) order by m.created_at)
      from (
        select * from crm_task_messages x
        where x.task_id = p.id
        order by x.created_at desc limit 6
      ) m
      left join profiles sp on sp.id = m.sender_id
    ), '[]'::jsonb)
  ) end
  from crm_tasks c
  left join crm_tasks p on p.id = c.parent_task_id
  left join profiles pr on pr.id = p.created_by
  where c.id = t
    -- Teilnehmer der Teilaufgabe - oder Service-Role (task-action für den Token-Link).
    and (auth.role() = 'service_role' or is_task_participant(c.id))
$$;
revoke execute on function task_parent_context(uuid) from public, anon;
grant execute on function task_parent_context(uuid) to authenticated, service_role;

-- Bestand: alles Bisherige gilt als gemeldet - sonst würde der erste Sweep
-- die Nachrichten der letzten 24 h nachträglich per WhatsApp verschicken.
update crm_task_messages set ext_notified_at = coalesce(ext_notified_at, created_at) where ext_notified_at is null;
