-- Strategie-Vorschau fuer das Team, ohne den Plan fuer den Kunden freizuschalten.
--
-- Bisher lieferte get_strategy_by_token nur Zeilen mit shared_at is not null.
-- Damit gab es keinen Weg, den fertigen Fahrplan anzusehen, bevor er oeffentlich
-- war: entweder freigegeben oder unsichtbar. Deck und Berechnung kennen dieses
-- Tor nicht, ihre Vorschau ist einfach die Kundenseite mit ?preview=1.
--
-- Sven 5.9.26: der Fahrplan soll NICHT direkt fuer den Kunden freigegeben
-- werden, sondern im Hintergrund entstehen und als Entwurf im Postausgang
-- liegen. Das Tor bleibt deshalb, wo es ist, und bekommt einen zweiten
-- Eingang: angemeldete Mitarbeiter mit Deck-Recht sehen den Entwurf, der Kunde
-- erst, wenn der Postausgang-Eintrag tatsaechlich hinausgegangen ist und
-- shared_at dabei gesetzt wurde.
--
-- Muster der Rechtepruefung wie in den Policies aus 20260814_strategy_scenarios.sql.
create or replace function get_strategy_preview(p_token text)
returns table (token text, title text, recipient_name text, config jsonb, updated_at timestamptz, shared_at timestamptz)
language sql
security definer
stable
set search_path = public
as $$
  select s.token, s.title, s.recipient_name, s.config, s.updated_at, s.shared_at
  from crm_strategy_scenarios s
  where s.token = p_token
    and (
      current_user_role() = any (array['admin'::text, 'verwalter'::text])
      or current_user_has_perm('decks'::text)
    )
  limit 1;
$$;

-- Ausdruecklich NICHT an anon. Wer nicht angemeldet ist, bekommt nichts.
-- Supabase vergibt ueber Default-Privilegien beim Anlegen automatisch execute an
-- anon und authenticated; ein revoke von PUBLIC allein nimmt das nicht zurueck,
-- weil es eigenstaendige Grants sind. Deshalb anon ausdruecklich entziehen.
revoke all on function get_strategy_preview(text) from public;
revoke all on function get_strategy_preview(text) from anon;
grant execute on function get_strategy_preview(text) to authenticated;

comment on function get_strategy_preview(text) is
  'Vorschau des Investitions-Fahrplans fuer angemeldete Mitarbeiter, unabhaengig von shared_at. Die Kundenseite laeuft weiter ueber get_strategy_by_token.';

-- Wann der Plan tatsaechlich hinausgegangen ist, steht ab jetzt in shared_at und
-- wird beim Versand aus dem Postausgang gesetzt, nicht mehr beim Erstellen.
comment on column crm_strategy_scenarios.shared_at is
  'Zeitpunkt, zu dem der Fahrplan an den Kunden hinausgegangen ist. Wird beim Versand aus dem Postausgang gesetzt. Solange null, liefert get_strategy_by_token nichts und nur die Vorschau zeigt den Plan.';
