#!/usr/bin/env node
// Regressionstests für das Quality-Gate (supabase/functions/_shared/deckGate.ts)
// und die deterministische Normalisierung (deckNormalize.ts) — die bekannten
// Fehlerfälle vom 18./19.9.2026, ohne Claude und ohne Datenbank.
//
// Ausführen:
//   npm run verify:gate
//
// Jeder Fall beschreibt: CRM-Wahrheit (DeckContext) + Deck-Blöcke → erwartete
// Befunde. Ein fehlender oder falscher Befund bricht den Lauf.

import { execSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'hpgate-'))
const outGate = join(dir, 'gate.mjs')
const outNorm = join(dir, 'norm.mjs')
execSync(`npx --yes esbuild supabase/functions/_shared/deckGate.ts --bundle --format=esm --outfile=${outGate}`, { stdio: 'pipe' })
execSync(`npx --yes esbuild supabase/functions/_shared/deckNormalize.ts --bundle --format=esm --outfile=${outNorm}`, { stdio: 'pipe' })
const { runDeckGate, checkImageTypes } = await import(outGate)
const { buildPaymentBlock, applyDeterministic } = await import(outNorm)

let fails = 0
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`✅ ${name}`)
  else { fails++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const keys = (r) => r.findings.map(f => `${f.key}[${f.severity}]`)
const has = (r, key, sev) => r.findings.some(f => f.key === key && (!sev || f.severity === sev))

// ── CRM-Wahrheit: Emerald Park C-105 (Live-Daten 18.9.26) ────────────────────
const price = {
  netProperty: 320000, netFurniture: 19000, netTotal: 339000,
  split: { netReduced: 0, netStandard: 320000, vatReduced: 0, vatStandard: 60800, vat: 60800, gross: 380800 },
  vatFurniture: 3610, vatTotal: 64410, gross: 403410, mixed: false,
}
const priceLines = [
  { label: 'Nettopreis (inkl. Einrichtung)', value: '339.000 €' },
  { label: 'zzgl. MwSt (19 %)', value: '64.410 €' },
  { label: 'Bruttopreis', value: '403.410 €', strong: true },
  { label: 'davon Einrichtungspaket', value: '19.000 € netto · 22.610 € brutto' },
]
const schedule = {
  reservation: 10000, reservationVat: true, currency: 'EUR',
  stages: [
    { label: 'Bei Vertrag', sub: 'abzüglich 10.000 € Reservierung', pct: 35 },
    { label: 'Baufortschritt', sub: 'Rohbau', pct: 30 },
    { label: 'Baufortschritt', sub: 'Mauerwerk & Verputz', pct: 20 },
    { label: 'Baufortschritt', sub: 'Fliesen & Fenster', pct: 10 },
    { label: 'Übergabe', sub: 'Schlüsselübergabe', pct: 5 },
  ],
}
const unit = {
  unitId: 'u1', unitNumber: 'C-105', unitKey: 'c105', bedrooms: 2, bathrooms: 1, sizeSqm: 84.5, terraceSqm: 16, plotSqm: null,
  floor: 1, unitType: 'apartment', netProperty: 320000, netFurniture: 19000, price, priceLines,
  priceSummary: { net: '339.000 €', vatRate: '19 %', vat: '64.410 €', gross: '403.410 €' },
  floorplanUrl: 'https://x.supabase.co/storage/v1/object/public/deck-assets/floorplans/emerald/C-105.svg',
  floorplanNote: null, floorplanSource: 'unit_map', floorplanFallback: false,
}
const ctx = (over = {}) => ({
  projectId: 'p1', projectName: 'Emerald Park', developer: 'Luma', location: 'Paphos', lat: 34.767, lng: 32.447,
  completion: '09/2028', angle: 'investment', vatMode: 'standard19', furnitureMode: 'optional',
  furnitureIncluded: false, furnitureUnknown: false, furnitureDefault: 19000, furnitureByBedrooms: { 1: 17000, 2: 19000 },
  lang: 'de', generic: false, units: [unit], paymentSchedule: schedule, paymentSource: 'project',
  videoUrl: null, marinaImage: 'https://x/brand/paphos-marina-model.jpg', missingFloorplans: [], ambiguousUnitKeys: [],
  ...over,
})
const IMG = (n) => `https://x.supabase.co/storage/v1/object/public/deck-assets/projects/p1/renders/${n}.jpg`

const baseBlocks = (specs) => {
  const c = ctx()
  const pay = buildPaymentBlock(schedule, { net: 339000, gross: 403410 }, 'de')
  pay.priceSummary = unit.priceSummary
  return [
    { type: 'cover', title: 'Emerald Park', image: IMG('cover') },
    { type: 'letter', paragraphs: ['Hallo Kunde, hier dein Deck.'] },
    { type: 'unit', number: 'C-105', specs, priceLines, image: IMG('unit') },
    { type: 'facts', headline: 'Lage', items: [{ min: 'ca. 7 km', label: 'Flughafen' }], mapLat: 34.767, mapLng: 32.447 },
    { type: 'floorplan', kicker: 'Grundriss', image: unit.floorplanUrl },
    pay,
    { type: 'cta', headline: 'Wie es weitergeht', steps: [{ n: '01', title: 'Reservierung', text: 'Mit 11.900 € brutto (10.000 € netto) ist C-105 reserviert. Übergabe im September 2028.' }] },
  ].map(b => ({ ...b }))
}

// ── Test 0: korrektes Deck ist GRÜN ─────────────────────────────────────────
{
  const r = runDeckGate(baseBlocks(['84,5 m² Innenfläche', '16 m² Terrasse', '2 Schlafzimmer', '1. Obergeschoss', '181,74 m² Gemeinschaftspool']), ctx())
  ok('T0 korrektes Deck: grün', r.status === 'green', keys(r).join(', '))
}

// ── Test D: falsche Wohnfläche (CRM 84,5 → Deck 92) ─────────────────────────
{
  const r = runDeckGate(baseBlocks(['92 m² Innenfläche', '2 Schlafzimmer']), ctx())
  ok('TD falsche Fläche im unit-Block → flaeche_abweichung hoch + rot', has(r, 'flaeche_abweichung', 'hoch') && r.status === 'red', keys(r).join(', '))
  const blocks = baseBlocks(['84,5 m² Innenfläche'])
  blocks[1].paragraphs = ['Deine Wohnung mit 92 m² wartet.']
  const r2 = runDeckGate(blocks, ctx())
  ok('TD falsche Fläche im Anschreiben (Freitext) → hoch', has(r2, 'flaeche_abweichung', 'hoch'), keys(r2).join(', '))
  const b3 = baseBlocks(['84,5 m² Innenfläche'])
  b3.push({ type: 'feature', headline: 'Das Club House', text: 'Der Kursraum hat 140 m².' })
  b3[1].paragraphs = ['Dahinter eine Anlage mit 105 m² Fitnessstudio und 140 m² Yoga-Studio.']
  const r3 = runDeckGate(b3, ctx())
  ok('TD Projektzahl ohne Wohnungsbezug im feature-Block → kein Befund', !has(r3, 'flaeche_abweichung') && r3.status === 'green', keys(r3).join(', '))
  const b4 = baseBlocks(['84,5 m² Innenfläche'])
  b4.push({ type: 'feature', headline: 'Dein Rückzugsort', text: 'Die Wohnung bietet 92 m² Wohnfläche.' })
  const r4 = runDeckGate(b4, ctx())
  ok('TD falsche Wohnfläche im feature-Block → mittel', has(r4, 'flaeche_abweichung', 'mittel'), keys(r4).join(', '))
  const b5 = baseBlocks(['84,5 m² Innenfläche'])
  b5[0].forLine = 'Für Test Kunde - September 2026'
  b5.push({ type: 'feature', headline: 'Marina', image: 'https://x/brand/paphos-marina-model.jpg', text: 'Baubeginn April 2027, 165.000 m² Areal.' })
  const r5 = runDeckGate(b5, ctx())
  ok('Deckdatum im Cover + Marina-Systemblock → keine Termin-/Flächenbefunde', !has(r5, 'fertigstellung_abweichung') && !has(r5, 'flaeche_abweichung'), keys(r5).join(', '))
}

// ── Zimmer / Etage / Bad / Fertigstellung ────────────────────────────────────
{
  const r = runDeckGate(baseBlocks(['3 Schlafzimmer', '84,5 m²']), ctx())
  ok('Zimmer 3 statt 2 → zimmer_abweichung hoch', has(r, 'zimmer_abweichung', 'hoch'), keys(r).join(', '))
  const r2 = runDeckGate(baseBlocks(['3. Etage', '84,5 m²']), ctx())
  ok('Etage 3 statt 1 → etage_abweichung hoch', has(r2, 'etage_abweichung', 'hoch'), keys(r2).join(', '))
  const r3 = runDeckGate(baseBlocks(['Erdgeschoss', '84,5 m²']), ctx())
  ok('Erdgeschoss statt 1. OG → etage_abweichung hoch', has(r3, 'etage_abweichung', 'hoch'), keys(r3).join(', '))
  const b4 = baseBlocks(['84,5 m²'])
  b4[6].steps[0].text = 'Übergabe im Oktober 2028.'
  const r4 = runDeckGate(b4, ctx())
  ok('Fertigstellung „Oktober 2028" statt 09/2028 → hoch', has(r4, 'fertigstellung_abweichung', 'hoch'), keys(r4).join(', '))
  const r5 = runDeckGate(baseBlocks(['2 Badezimmer', '84,5 m²']), ctx())
  ok('2 Bäder statt 1 → bad_abweichung mittel', has(r5, 'bad_abweichung', 'mittel'), keys(r5).join(', '))
}

// ── Beträge ──────────────────────────────────────────────────────────────────
{
  const r = runDeckGate(baseBlocks(['84,5 m²']), ctx())
  ok('Reservierung 11.900 € brutto / 10.000 € netto im cta → erlaubt', !has(r, 'betrag_fremd'), keys(r).join(', '))
  const b = baseBlocks(['84,5 m²'])
  b[1].paragraphs = ['Das Apartment kostet 585.000 € netto.']
  const r2 = runDeckGate(b, ctx())
  ok('fremder Preis 585.000 € im Anschreiben → betrag_fremd hoch', has(r2, 'betrag_fremd', 'hoch'), keys(r2).join(', '))
  const b3 = baseBlocks(['84,5 m²'])
  b3[1].paragraphs = ['Die erste Rate: 141.194 € brutto (118.650 € netto).']
  const r3 = runDeckGate(b3, ctx())
  ok('Ratenbetrag aus dem Zahlungsplan im Text → erlaubt', !has(r3, 'betrag_fremd'), keys(r3).join(', '))
}

// ── Zahlungsplan-Block: Reservierung brutto ──────────────────────────────────
{
  const pay = buildPaymentBlock(schedule, { net: 339000, gross: 403410 }, 'de')
  const res = pay.phase1.rows[0]
  ok('Reservierung im Block = 11.900 € (10.000 € netto + 19 %)', res.value === '11.900 €' && /10\.000 € netto zzgl\. 19 % MwSt/.test(res.sub), JSON.stringify(res))
  const mito = buildPaymentBlock({ reservation: 20000, reservationVat: false, stages: [{ label: 'Bei Vertrag', pct: 100 }] }, null, 'de')
  ok('MITO-Reservierung 20.000 € glatt (ohne MwSt)', mito.phase1.rows[0].value === '20.000 €' && !/MwSt/.test(mito.phase1.rows[0].sub), JSON.stringify(mito.phase1.rows[0]))
  const en = buildPaymentBlock(schedule, { net: 339000, gross: 403410 }, 'en')
  ok('EN-Zahlungsplan englisch beschriftet', en.kicker === 'Payment plan' && en.phase1.rows[0].label === 'Reservation', JSON.stringify({ k: en.kicker, l: en.phase1.rows[0].label }))
  const summe = [...pay.phase1.rows.slice(1), ...pay.phase2.rows].reduce((s, r) => s + Number(r.value.replace(/\./g, '').replace(' €', '')), 0)
  ok('Ratensumme (ohne Reservierung) = Bruttopreis 403.410 €', summe === 403410, String(summe))
}

// ── Test E: Villa-Bild im Apartment-Deck ─────────────────────────────────────
{
  const gal = [
    { url: IMG('villa1'), category: 'pool', label: 'Villa mit Privatpool', unitType: 'villa' },
    { url: IMG('apt1'), category: 'fassade', label: 'Apartment-Fassade', unitType: 'apartment' },
    { url: IMG('pool'), category: 'pool', label: 'Gemeinschaftspool', unitType: 'anlage' },
    { url: IMG('old'), category: 'wohnzimmer', label: 'Wohnzimmer' },
  ]
  const blocks = baseBlocks(['84,5 m²'])
  blocks[2].image = IMG('villa1')
  blocks.push({ type: 'gallery', headline: 'Pool', items: [{ image: IMG('pool') }, { image: IMG('villa1') }] })
  const f = checkImageTypes(blocks, ctx(), gal)
  ok('TE Villa-Bild im unit-Block → bild_fremdtyp hoch', f.some(x => x.key === 'bild_fremdtyp' && x.severity === 'hoch' && x.block === 2), JSON.stringify(f.map(x => x.key)))
  ok('TE Villa-Bild in der Galerie → ebenfalls gemeldet', f.filter(x => x.key === 'bild_fremdtyp').length === 2, String(f.filter(x => x.key === 'bild_fremdtyp').length))
  ok('TE Anlage-Pool erlaubt, ungetaggtes Bild nur niedrig', !f.some(x => x.key === 'bild_fremdtyp' && /pool\.jpg/.test(x.evidence)) , '')
  const f2 = checkImageTypes([{ type: 'cover', image: IMG('apt1') }, { type: 'unit', image: IMG('old') }], ctx(), gal)
  ok('TE Apartment-Bild + ungetaggt → kein Fremdtyp, Hinweis niedrig', !f2.some(x => x.key === 'bild_fremdtyp') && f2.some(x => x.key === 'bild_typ_ungeprueft'), JSON.stringify(f2.map(x => x.key)))
}

// ── Grundriss: kein Zwilling, kein Zimmerzahl-Fallback ───────────────────────
{
  const u = { ...unit, floorplanUrl: null, floorplanSource: null }
  const blocks = baseBlocks(['84,5 m²']).filter(b => b.type !== 'floorplan')
  const r = runDeckGate(blocks, ctx({ units: [u], missingFloorplans: ['C-105'] }))
  ok('ohne Plan → grundriss_fehlt hoch (kein Ersatzplan)', has(r, 'grundriss_fehlt', 'hoch') && !has(r, 'grundriss_baugleich'), keys(r).join(', '))
  const norm = applyDeterministic(baseBlocks(['84,5 m²']), ctx({ units: [u], missingFloorplans: ['C-105'] }))
  ok('Normalisierung entfernt Grundriss-Block ohne Plan statt fremden Plan einzusetzen', !norm.blocks.some(b => b.type === 'floorplan'), norm.notes.join(' | '))
}

console.log(fails ? `\n❌ ${fails} Test(s) fehlgeschlagen` : '\n✅ Gate-Regressionstests bestanden')
process.exit(fails ? 1 : 0)
