-- Tippgeber-Programm: jeder Kunde/Abonnent bekommt genau EINEN eindeutigen
-- Empfehlungs-Link. Bisher entstanden Tippgeber nur aus dem Bewertungs-
-- Fragebogen; ab jetzt legt auch der Newsletter fuer jeden Empfaenger einen an.
--
-- Kernpunkte:
--   1. affiliates.subscriber_id  → Newsletter-Abonnenten (keine CRM-Leads)
--   2. Eindeutigkeit je Person per partiellem Unique-Index (verhindert doppelte
--      Codes fuer dieselbe Person, auch bei parallelen Laeufen)
--   3. ensure_affiliate(...) legt atomar an bzw. gibt den vorhandenen zurueck;
--      der Code einer Person aendert sich NIE (Links bleiben gueltig)

alter table affiliates add column if not exists subscriber_id uuid references newsletter_subscribers(id) on delete set null;

-- Vor dem Unique-Index: eventuelle Alt-Dubletten je Lead zusammenfuehren
-- (aeltester Eintrag gewinnt, damit bereits verschickte Links weiterleben).
do $$
declare dup record; keeper uuid;
begin
  for dup in
    select lead_id from affiliates where lead_id is not null group by lead_id having count(*) > 1
  loop
    select id into keeper from affiliates where lead_id = dup.lead_id order by created_at limit 1;
    -- Auszahlungen, die beim Umhaengen mit einer vorhandenen kollidieren wuerden
    -- (gleicher geworbener Kunde), sind echte Dubletten und fallen weg.
    delete from affiliate_payouts p using affiliates a
     where p.affiliate_id = a.id and a.lead_id = dup.lead_id and a.id <> keeper
       and exists (select 1 from affiliate_payouts k
                    where k.affiliate_id = keeper
                      and k.referred_lead_id is not distinct from p.referred_lead_id);
    update affiliate_payouts p set affiliate_id = keeper from affiliates a
     where p.affiliate_id = a.id and a.lead_id = dup.lead_id and a.id <> keeper;
    update leads set referred_by_affiliate = keeper
      where referred_by_affiliate in (select id from affiliates where lead_id = dup.lead_id and id <> keeper);
    update review_requests set affiliate_id = keeper
      where affiliate_id in (select id from affiliates where lead_id = dup.lead_id and id <> keeper);
    delete from affiliates where lead_id = dup.lead_id and id <> keeper;
  end loop;
end $$;

create unique index if not exists affiliates_lead_uniq       on affiliates (lead_id)       where lead_id is not null;
create unique index if not exists affiliates_subscriber_uniq on affiliates (subscriber_id) where subscriber_id is not null;

-- Anlegen/Nachschlagen in einem Rutsch. Gibt IMMER den gueltigen Tippgeber
-- zurueck: vorhandener Eintrag (Code unveraendert) oder frisch angelegter.
create or replace function ensure_affiliate(
  p_lead_id       uuid,
  p_subscriber_id uuid,
  p_name          text,
  p_email         text default null,
  p_whatsapp      text default null,
  p_source        text default 'newsletter'
) returns affiliates
language plpgsql
security definer
set search_path = public
as $$
declare
  a        affiliates;
  tries    int := 0;
  new_code text;
begin
  if p_lead_id is null and p_subscriber_id is null then
    raise exception 'ensure_affiliate: lead_id oder subscriber_id erforderlich';
  end if;

  select * into a from affiliates
   where (p_lead_id is not null and lead_id = p_lead_id)
      or (p_subscriber_id is not null and subscriber_id = p_subscriber_id)
   order by created_at
   limit 1;

  if found then
    -- Kontaktdaten nachtragen, aber Code und bestehende Werte nie ueberschreiben.
    update affiliates set
      name          = coalesce(nullif(btrim(p_name), ''), name),
      email         = coalesce(email, nullif(btrim(p_email), '')),
      whatsapp      = coalesce(whatsapp, nullif(btrim(p_whatsapp), '')),
      lead_id       = coalesce(lead_id, p_lead_id),
      subscriber_id = coalesce(subscriber_id, p_subscriber_id)
    where id = a.id
    returning * into a;
    return a;
  end if;

  loop
    tries := tries + 1;
    new_code := lower(encode(gen_random_bytes(5), 'hex'));
    begin
      insert into affiliates (lead_id, subscriber_id, name, email, whatsapp, code, source)
      values (
        p_lead_id, p_subscriber_id,
        coalesce(nullif(btrim(p_name), ''), 'Tippgeber'),
        nullif(btrim(p_email), ''), nullif(btrim(p_whatsapp), ''),
        new_code, coalesce(nullif(btrim(p_source), ''), 'newsletter')
      )
      returning * into a;
      return a;
    exception when unique_violation then
      -- Entweder Code-Kollision oder ein paralleler Lauf war schneller.
      select * into a from affiliates
       where (p_lead_id is not null and lead_id = p_lead_id)
          or (p_subscriber_id is not null and subscriber_id = p_subscriber_id)
       order by created_at
       limit 1;
      if found then return a; end if;
      if tries >= 5 then raise; end if;
    end;
  end loop;
end $$;

-- Nur Service-Role (Edge Functions) darf anlegen; RLS bleibt sonst dicht.
revoke all on function ensure_affiliate(uuid, uuid, text, text, text, text) from public, anon, authenticated;
