-- Interne Termine sauber von Kundenterminen trennen (20.07.2026)
--
-- Anlass: Giona hat über ihren persönlichen Buchungslink einen Termin bei Sven
-- gebucht. personal-booking hängt einen Termin per E-Mail-Treffer an einen
-- bestehenden Lead — und Giona stand aus dem HubSpot-Import noch als Lead in der
-- Datenbank. Ergebnis: zwei automatische "termin_gebucht"-Kunden-WhatsApps an
-- eine Mitarbeiterin, geplant für den nächsten Morgen.
--
-- Kein Deal ist dabei entstanden (personal-booking legt keine Deals an) — der
-- Schaden lag allein an der Lead-Verknüpfung und den Automatiken, die daran hängen.

-- Einladung kann einer Mitarbeiterin gehören (Dashboard-Kachel) und/oder als
-- intern markiert sein (keine Kundenautomatik).
alter table booking_invites add column if not exists profile_id uuid references profiles(id) on delete set null;
alter table booking_invites add column if not exists internal boolean not null default false;

-- Mitarbeitende dürfen ihre eigene Einladung lesen (für die Kachel auf /admin/crm/home).
drop policy if exists bi_own_read on booking_invites;
create policy bi_own_read on booking_invites for select to authenticated using (profile_id = auth.uid());

-- Der Termin selbst trägt die Markierung, damit alle Leser sie auswerten können.
alter table crm_appointments add column if not exists internal boolean not null default false;
create index if not exists idx_crm_appt_internal on crm_appointments(internal) where internal;

-- Interne Termine dürfen keine laufende Kunden-Nachfassreihe abwürgen und kein
-- Bot-Gespräch schließen.
create or replace function public.hp_cancel_nudges_on_appointment()
 returns trigger language plpgsql as $function$
begin
  if new.lead_id is not null and not coalesce(new.internal, false) then
    update scheduled_messages
       set status = 'cancelled'
     where lead_id    = new.lead_id
       and status     = 'pending'
       and event_type in ('lead_created', 'erstkontakt', 'no_show', 'deck_viewed_followup');
  end if;
  return new;
end $function$;

create or replace function public.hp_close_bot_conv_on_appointment()
 returns trigger language plpgsql as $function$
begin
  if new.lead_id is not null and not coalesce(new.internal, false) then
    update booking_conversations
       set state = 'booked'
     where lead_id = new.lead_id
       and state not in ('booked','handoff','expired');
  end if;
  return new;
end $function$;
