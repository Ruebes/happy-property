-- Mail-Öffnungen von Newsletter-Abonnenten (Sequenz-Mails) tragen nur eine
-- subscriber_id, keinen lead_id. Die Spalte wurde ohne Fremdschlüssel angelegt.
-- Im CRM-Dashboard stand deshalb „Jemand hat deine E-Mail geöffnet" statt des
-- Namens. Fremdschlüssel + Index nachziehen (Voraussetzung für eingebettete
-- Abfragen) und den Lead-Bezug für Bestandsdaten nachtragen.
alter table public.engagement_events
  drop constraint if exists engagement_events_subscriber_id_fkey;

alter table public.engagement_events
  add constraint engagement_events_subscriber_id_fkey
  foreign key (subscriber_id) references public.newsletter_subscribers(id) on delete cascade;

create index if not exists idx_eng_subscriber
  on public.engagement_events(subscriber_id)
  where subscriber_id is not null;

-- Abonnenten, die auch als Lead im CRM stehen (gleiche E-Mail), bekommen den
-- Lead-Bezug nachgetragen. Danach erscheint die Öffnung auch in der Lead-Akte.
update public.engagement_events e
set lead_id = l.id
from public.newsletter_subscribers s
join public.leads l on lower(l.email) = lower(s.email)
where e.subscriber_id = s.id
  and e.lead_id is null
  and s.email is not null;
