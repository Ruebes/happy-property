-- Sales Decks: personalisierte, KI-generierte Verkaufs-Decks pro Kunde/Wohnung.
-- content = strukturierte Bausteine (Cover, Brief, Wohnung, Lage, Vorteile, Zahlung, CTA …).
-- Öffentlich abrufbar NUR per Token über die SECURITY-DEFINER-Funktion (kein anon-SELECT auf die Tabelle).
CREATE TABLE IF NOT EXISTS sales_decks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token          text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(9), 'hex'),
  batch_id       uuid,                          -- gruppiert die 2–3 Decks eines Kunden (eine Begleit-Mail)
  lead_id        uuid REFERENCES leads(id) ON DELETE SET NULL,
  deal_id        uuid,
  project_id     uuid,
  unit_id        uuid,
  angle          text,                          -- 'lifestyle' | 'investment' | 'custom'
  recipient_name text,
  status         text NOT NULL DEFAULT 'draft', -- draft | ready | sent
  content        jsonb NOT NULL DEFAULT '{}'::jsonb,
  pdf_path       text,
  created_by     uuid,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

ALTER TABLE sales_decks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_decks_staff_all ON sales_decks;
CREATE POLICY sales_decks_staff_all ON sales_decks FOR ALL TO authenticated
  USING      ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin','verwalter'));

-- Öffentlicher Abruf nur per Token; gibt ausschließlich Präsentationsdaten zurück.
CREATE OR REPLACE FUNCTION get_deck_by_token(p_token text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'content',        d.content,
    'recipient_name', d.recipient_name,
    'angle',          d.angle,
    'status',         d.status
  )
  FROM sales_decks d
  WHERE d.token = p_token
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_deck_by_token(text) TO anon, authenticated;
