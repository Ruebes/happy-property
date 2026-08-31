-- Einlagen und Entnahmen sind keine Einnahmen/Ausgaben (Vorgabe Sven 31.08.2026).
--
-- Bisher landete JEDER Eingang ohne passende Regel automatisch in 'kundenzahlung'
-- (revolut-sync: cat = rule ? rule.category : amount > 0 ? 'kundenzahlung' : null).
-- Dadurch zaehlten Svens Privateinlagen ("From Sven R", Verwendungszweck "Loan")
-- als Umsatz. Umgekehrt lagen die Rueckzahlungen an ihn unter 'gehalt_privat' und
-- damit in den Ausgaben. Auch die Devisen-Umbuchungen (Exchanged from/to) standen
-- auf beiden Seiten und haben Einnahmen wie Ausgaben aufgeblaeht.
--
-- Drei neue Kategorien trennen das sauber. Sie werden in der Statistik weder als
-- Einnahme noch als Ausgabe gewertet, aber separat ausgewiesen.

-- ── 1) Bestand umklassifizieren ─────────────────────────────────────────────
-- Devisentausch zwischen eigenen Konten (beide Seiten)
update fin_transactions
   set category = 'umbuchung', category_source = 'regel'
 where counterparty ilike '%exchanged%'
   and category is distinct from 'umbuchung';

-- Einlagen: Geld von Sven oder aus seiner US-Gesellschaft ins Firmenkonto
update fin_transactions
   set category = 'einlage', category_source = 'regel'
 where amount > 0
   and (counterparty ilike '%sven r%' or counterparty ilike '%sven rüprich%'
        or (reference ilike '%loan%' and counterparty ilike '%sveru%'))
   and category is distinct from 'einlage';

-- Entnahmen: Geld zurueck an Sven (Rueckzahlung/Transfer)
update fin_transactions
   set category = 'entnahme', category_source = 'regel'
 where amount < 0
   and (counterparty ilike '%sven r%' or counterparty ilike '%sven rüprich%')
   and category is distinct from 'entnahme';

-- ── 2) Regeln fuer kuenftige Syncs ──────────────────────────────────────────
-- Die Regeln matchen als Substring auf "Gegenpartei + Verwendungszweck",
-- der erste Treffer gewinnt. Deshalb muessen ALLE Varianten dasselbe Ziel haben,
-- sonst entscheidet die zufaellige Zeilenreihenfolge.
update fin_rules set category = 'entnahme' where match = 'to sven rüprich';

insert into fin_rules (match, category)
select v.match, v.category
  from (values
    ('to sven ruprich',  'entnahme'),
    ('pay back loan',    'entnahme'),
    ('from sven',        'einlage'),
    ('exchanged to',     'umbuchung'),
    ('exchanged from',   'umbuchung')
  ) as v(match, category)
 where not exists (select 1 from fin_rules r where r.match = v.match);
