-- ARCA: price_gross war gar kein Bruttopreis ─────────────────────────────────
-- Bei 22 ARCA-Wohnungen steht in price_gross exakt derselbe Wert wie in
-- price_net_furnished (Beispiel 101: netto 400.800, möbliert 417.800, "brutto"
-- 417.800). Der Preislisten-Parser hat die zweite Preisspalte doppelt abgelegt.
-- Folge: der gepflegte "Bruttopreis" gewinnt gegen die MwSt-Rechnung, und
-- Kunden sahen 417.800 € statt 476.952 € (400.800 + 19 %).
--
-- Fix: den doppelten Wert entfernen. price_net_furnished bleibt erhalten, den
-- Bruttopreis rechnet unitGross() ab jetzt aus Netto + MwSt-Satz.

UPDATE crm_project_units u
   SET price_gross = NULL
  FROM crm_projects p
 WHERE u.project_id = p.id
   AND p.name ILIKE '%arca%'
   AND u.price_gross IS NOT NULL
   AND u.price_net_furnished IS NOT NULL
   AND u.price_gross = u.price_net_furnished;
