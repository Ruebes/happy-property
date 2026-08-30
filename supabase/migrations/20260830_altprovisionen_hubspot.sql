-- Alt-Provisionen aus der HubSpot-Zeit nachtragen (Belege: Revolut INV-103 bis INV-107).
-- Ziel: die Verkaufs-Statistik zeigt diese Verkaeufe mit Provision, obwohl die Deals
-- damals nicht im CRM entstanden sind. Betraege = NETTO laut Rechnung (Brutto = +19%).
--
-- Die Wohnungen sind bereits korrekt zugeordnet (crm_project_units.property_id ->
-- properties.owner_id). Es fehlten nur die Deals bzw. die Provisionsbetraege.
-- Automatiken feuern dabei nicht: automation_rules laufen ueber die Edge Functions,
-- aktive funnel_workflows gibt es derzeit keine.

-- ── INV-103 · 21.01.2026 · Michel Blank · Luma Genesis B101 · 7.425 € netto ──
update deals
   set commission_amount  = 7425,
       commission_paid_at = '2026-01-21 14:28:00+00'
 where id = 'b012f7e5-481f-469d-a592-2012f0da22fe'
   and commission_amount is null;

-- ── Katrin Maurer: drei Kaeufe, im CRM bisher ohne Deal ──────────────────────
-- INV-104 · 06.02.2026 · Medousa Adonidos Gardens T201 · 14.310 € netto
-- INV-105 · 11.02.2026 · Medousa Adonidos Gardens T102 · 12.150 € netto
-- INV-107 · 30.03.2026 · Mito Infinity 202             · 20.995 € netto
insert into deals (lead_id, unit_id, property_id, phase, archived_from_phase,
                   commission_amount, commission_paid_at, phase_changed_at,
                   created_at, updated_at, provision_notes)
select v.lead_id, v.unit_id, v.property_id, 'archiviert', 'provision_erhalten',
       v.betrag, v.bezahlt_am, v.bezahlt_am, v.bezahlt_am, now(), v.beleg
  from (values
    ('ac8b5170-d141-4299-84be-847f141f9c96'::uuid, 'abdb626d-124f-4e5d-b17c-0da6cb7e59f0'::uuid,
     '657ded37-75bc-4842-993a-54efd4d7357d'::uuid, 14310::numeric, '2026-02-06 12:49:00+00'::timestamptz,
     'Alt-Provision aus HubSpot-Zeit, Rechnung INV-104 (14.310 EUR netto / 17.028,90 EUR brutto)'),
    ('ac8b5170-d141-4299-84be-847f141f9c96'::uuid, 'cf08d902-7c49-4d87-94de-64ddff71ad96'::uuid,
     '0146eaf3-c0b7-4fdb-a29e-3a8568fc3594'::uuid, 12150::numeric, '2026-02-11 09:27:00+00'::timestamptz,
     'Alt-Provision aus HubSpot-Zeit, Rechnung INV-105 (12.150 EUR netto / 14.458,50 EUR brutto)'),
    ('ac8b5170-d141-4299-84be-847f141f9c96'::uuid, '74fa8b7b-b2b5-49a7-b8bf-4ab46b745983'::uuid,
     'b607c127-d9c2-4fa4-9d34-1281c6c1a2e3'::uuid, 20995::numeric, '2026-03-30 22:13:00+00'::timestamptz,
     'Alt-Provision aus HubSpot-Zeit, Rechnung INV-107 (20.995 EUR netto / 24.984,05 EUR brutto)')
  ) as v(lead_id, unit_id, property_id, betrag, bezahlt_am, beleg)
 where not exists (select 1 from deals d where d.unit_id = v.unit_id);

-- ── INV-106 / INV-108 · Thorsten Brendel: Betrag hing am falschen Deal ──────
-- INV-108 (08.07.2026) weist 39.900 EUR netto fuer LOFOS 102 aus. Genau dieser
-- Betrag stand im CRM auf dem Infinity-302-Deal, waehrend der Lofos-Deal leer war
-- (nur das Zahldatum 08.07. stimmte dort schon). INV-106 (13.03.2026) weist fuer
-- Infinity 302 20.940 EUR netto aus. Beide Deals werden daher geradegezogen.
update deals
   set commission_amount  = 20940,
       commission_paid_at = '2026-03-13 13:06:00+00',
       provision_notes    = coalesce(provision_notes || E'\n', '') ||
                            'Rechnung INV-106 (20.940 EUR netto / 24.918,60 EUR brutto). Die zuvor hier gebuchten 39.900 EUR gehoeren laut INV-108 zu Lofos B7/102.'
 where id = '182c12a5-6e53-4a39-a7ac-26a41a07626f';

update deals
   set commission_amount  = 39900,
       commission_paid_at = '2026-07-08 09:17:51.259+00',
       provision_notes    = coalesce(provision_notes || E'\n', '') ||
                            'Rechnung INV-108 (39.900 EUR netto / 47.481,00 EUR brutto).'
 where id = '19294c41-fb8a-424c-9a7f-6311728e21d1';

-- ── INV-109 · 05.08.2026 · Michael Decker · Infinity 201 · 28.313,40 EUR netto
-- Stimmt im CRM bereits (Betrag und Zahldatum). Nur der Beleg wird vermerkt.
update deals
   set provision_notes = coalesce(provision_notes || E'\n', '') ||
                         'Rechnung INV-109 (28.313,40 EUR netto / 33.692,95 EUR brutto).'
 where id = '67ca369f-5dea-43d0-9b15-157e1cd5228a'
   and coalesce(provision_notes, '') not like '%INV-109%';
