-- Rechnungsdatum ist ab jetzt das Verkaufsdatum der Statistik (Vorgabe Sven 31.08.2026).
-- Dafuer muessen ALLE Provisionsrechnungen im CRM stehen, nicht nur die zwei, die mit
-- dem Rechnungstool erzeugt wurden. INV-103 bis INV-107 entstanden in Revolut; sie
-- werden hier als bezahlte Rechnungen nachgetragen (ohne PDF, Beleg liegt in Revolut).
-- Nummernkreis: invoice_settings.next_number steht auf 110, die Nummern sind frei.

-- ── 1) INV-108 hing am falschen Deal ────────────────────────────────────────
-- Die Rechnung lautet auf LOFOS 102, war aber mit dem Infinity-302-Deal verknuepft.
-- Genau daher landete die Provision auf dem falschen Deal: generate-invoice schreibt
-- subtotal_net als commission_amount auf body.deal_id.
update crm_invoices
   set deal_id = '19294c41-fb8a-424c-9a7f-6311728e21d1'
 where invoice_number = 'INV-108';

-- ── 2) Revolut-Rechnungen nachtragen ────────────────────────────────────────
with vorlage as (
  select customer_id, issuer_snapshot, customer_snapshot
    from crm_invoices where invoice_number = 'INV-108'
),
neu as (
  select * from (values
    ('INV-103', date '2026-01-21', 7425.00::numeric,  'b012f7e5-481f-469d-a592-2012f0da22fe'::uuid,
     'ce28cb76-2c01-4f08-b9ef-99174021966a'::uuid, 'Leadgenerierung Michel Blank, Genesis B101',
     timestamptz '2026-01-21 14:28:00+00'),
    ('INV-104', date '2026-02-06', 14310.00,          null::uuid,
     'ac8b5170-d141-4299-84be-847f141f9c96'::uuid, 'Leadgenerierung Katrin Maurer, Medousa T201',
     timestamptz '2026-02-06 12:49:00+00'),
    ('INV-105', date '2026-02-11', 12150.00,          null::uuid,
     'ac8b5170-d141-4299-84be-847f141f9c96'::uuid, 'Leadgenerierung Katrin Maurer, Medousa T102',
     timestamptz '2026-02-11 09:27:00+00'),
    ('INV-106', date '2026-03-13', 20940.00,          '182c12a5-6e53-4a39-a7ac-26a41a07626f'::uuid,
     'bfe89128-ce6c-4e1d-a255-e22e8e33a808'::uuid, 'Leadgenerierung Thorsten Brendel, Mito Infinity 302',
     timestamptz '2026-03-13 13:06:00+00'),
    ('INV-107', date '2026-03-30', 20995.00,          null::uuid,
     'ac8b5170-d141-4299-84be-847f141f9c96'::uuid, 'Leadgenerierung Katrin Maurer, MITO Infinity 202',
     timestamptz '2026-03-30 22:13:00+00')
  ) as v(nummer, datum, netto, deal_id, lead_id, posten, bezahlt_am)
)
insert into crm_invoices (
  invoice_number, token, customer_id, deal_id, lead_id,
  issuer_snapshot, customer_snapshot,
  issue_date, supply_date, due_date,
  vat_treatment, vat_rate, subtotal_net, vat_amount, total_gross,
  currency, status, paid_at, notes
)
select n.nummer, encode(gen_random_bytes(32), 'hex'), v.customer_id, n.deal_id, n.lead_id,
       v.issuer_snapshot, v.customer_snapshot,
       n.datum, n.datum, n.datum + 7,
       'standard_19', 19.00, n.netto, round(n.netto * 0.19, 2), round(n.netto * 1.19, 2),
       'EUR', 'paid', n.bezahlt_am,
       'In Revolut erstellt und dort bezahlt. Im CRM nur als Beleg fuer die Verkaufsstatistik erfasst, deshalb ohne PDF.'
  from neu n cross join vorlage v
 where not exists (select 1 from crm_invoices i where i.invoice_number = n.nummer);

-- Positionen dazu (eine je Rechnung, Menge 1)
insert into crm_invoice_items (invoice_id, description, quantity, unit_price_net, line_net, sort)
select i.id, x.posten, 1, i.subtotal_net, i.subtotal_net, 0
  from crm_invoices i
  join (values
    ('INV-103', 'Leadgenerierung Michel Blank, Genesis B101'),
    ('INV-104', 'Leadgenerierung Katrin Maurer, Medousa T201'),
    ('INV-105', 'Leadgenerierung Katrin Maurer, Medousa T102'),
    ('INV-106', 'Leadgenerierung Thorsten Brendel, Mito Infinity 302'),
    ('INV-107', 'Leadgenerierung Katrin Maurer, MITO Infinity 202')
  ) as x(nummer, posten) on x.nummer = i.invoice_number
 where not exists (select 1 from crm_invoice_items it where it.invoice_id = i.id);

-- ── 3) Katrins drei Deals mit ihrer Rechnung verknuepfen ────────────────────
-- Die Deals wurden gestern nachgetragen; die Zuordnung laeuft ueber Lead + Betrag.
update crm_invoices i
   set deal_id = d.id
  from deals d
 where i.invoice_number in ('INV-104', 'INV-105', 'INV-107')
   and i.deal_id is null
   and d.lead_id = i.lead_id
   and d.commission_amount = i.subtotal_net;
