#!/usr/bin/env node
// Regressionstests für die Deck-Autobereinigung (supabase/functions/_shared/deckAutofix.ts)
// - ohne Claude und ohne Datenbank. Fixture: Emerald Park C-105 wie in
// verify-deck-gate.mjs, mit einem vollständigen Deck (Cover bis cta, dazu die
// Systemblöcke payment, marina, video, amenity, gallery).
//
// Ausführen:
//   npm run verify:autofix
//
// Jeder Fall beschreibt: CRM-Wahrheit + Deck + Befunde -> erwartete Bereinigung.

import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'hpautofix-'))
const entry = join(dir, 'entry.ts')
const out = join(dir, 'autofix.mjs')
const abs = (p) => resolve(p).replace(/\\/g, '/')
writeFileSync(entry, [
  `export * from '${abs('supabase/functions/_shared/deckAutofix.ts')}'`,
  `export { runDeckGate, claimIssuesToFindings } from '${abs('supabase/functions/_shared/deckGate.ts')}'`,
  `export { buildPaymentBlock } from '${abs('supabase/functions/_shared/deckNormalize.ts')}'`,
  `export { MARINA_MODEL } from '${abs('supabase/functions/_shared/deckContext.ts')}'`,
  `export { baueChatAnweisung, chatBehebbar } from '${abs('src/lib/deckFixAnweisung.ts')}'`,
  `export { starteFeinschliff } from '${abs('src/lib/deckChatSend.ts')}'`,
].join('\n'))
execSync(`npx --yes esbuild ${entry} --bundle --format=esm --outfile=${out}`, { stdio: 'pipe' })
const { autofixDeck, splitSaetze, stableEqual, ersatzWert, gesamtPruefung, runDeckGate, claimIssuesToFindings,
  buildPaymentBlock, MARINA_MODEL, LOCKED_TYPES, undoNachAutofix, sichereGrenze, zitateAusgeglichen, beginntMitVerweis,
  klammernAusgeglichen, mehrdeutigesKuerzel, baueChatAnweisung, chatBehebbar, innererSatzpunkt, starteFeinschliff } = await import(out)

let fails = 0
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`✅ ${name}`)
  else { fails++; console.log(`❌ ${name}${detail ? ` - ${detail}` : ''}`) }
}
const clone = (x) => structuredClone(x)
const keys = (fs) => fs.map(f => `${f.key}[${f.severity}]@${f.block ?? '-'}`).join(', ')

// ── CRM-Wahrheit: Emerald Park C-105 (aus verify-deck-gate.mjs) ─────────────
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
  videoUrl: null, marinaImage: MARINA_MODEL, missingFloorplans: [], ambiguousUnitKeys: [],
  ...over,
})
const IMG = (n) => `https://x.supabase.co/storage/v1/object/public/deck-assets/projects/p1/renders/${n}.jpg`

// Indizes im Fixture-Deck
const I = { cover: 0, letter: 1, unit: 2, benefits: 3, facts: 4, columns: 5, feature: 6, marina: 7, video: 8, amenity: 9, gallery: 10, floorplan: 11, payment: 12, cta: 13 }

const deck = () => {
  const pay = buildPaymentBlock(schedule, { net: 339000, gross: 403410 }, 'de')
  pay.priceSummary = unit.priceSummary
  return clone([
    { type: 'cover', kicker: 'Persönliches Angebot', title: 'Emerald Park', tagline: 'Ruhig wohnen im Norden von Paphos, mit Blick ins Grüne.', forLine: 'Für Max Mustermann - Oktober 2026', image: IMG('cover'), imageIntent: 'fassade', assetId: 'a-cover' },
    { type: 'letter', headline: 'Hallo Max', paragraphs: [
      'Hallo Max, schön, dass wir gesprochen haben. Du suchst eine Wohnung, die du ganzjährig vermieten kannst und die du selbst ein paar Wochen im Jahr nutzt.',
      'Emerald Park liegt in einem ruhigen Wohngebiet von Paphos. Die Anlage hat einen Gemeinschaftspool und ein kleines Gym. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.',
      'Die Wohnung C-105 hat 2 Schlafzimmer, eine Terrasse und eine offene Küche. Ich rechne dir die Zahlen gern persönlich durch, damit du eine klare Grundlage hast.',
    ], signoff: 'Bis bald, Sven', signName: 'Sven · Happy Property Cyprus' },
    { type: 'unit', kicker: 'Deine Wohnung', number: 'C-105', nickname: 'Sonnenseite', specs: ['84,5 m² Innenfläche', '16 m² Terrasse', '2 Schlafzimmer', '1 Badezimmer', '1. Obergeschoss'],
      priceLines, note: 'Die Einrichtung ist als Paket optional erhältlich. Die Übergabe erfolgt schlüsselfertig.', image: IMG('unit'), imageIntent: 'wohnzimmer' },
    { type: 'benefits', headline: 'Die Key Facts', cards: [
      { icon: '🔥', title: 'Fußbodenheizung', text: 'Angenehme Wärme im Winter in allen Räumen. Kein Heizkörper stört die Einrichtung.' },
      { icon: '❄️', title: 'VRV-Klima', text: 'Zentrale Klimatisierung für heiße Sommer. Leise und sparsam im Betrieb.' },
      { icon: '🪟', title: 'Dreifachverglasung', text: 'Ruhig und gut gedämmt. Spart Energie im Sommer wie im Winter.' },
      { icon: '🏊', title: 'Gemeinschaftspool', text: 'Der Pool der Anlage steht allen Bewohnern offen. Ideal für Mieter mit Kindern.' },
      { icon: '🏋️', title: 'Gym', text: 'Ein kleines Fitnessstudio direkt in der Anlage. Kein Vertrag im Studio nötig.' },
      { icon: '🚗', title: 'Stellplatz', text: 'Ein eigener überdachter Stellplatz gehört zur Wohnung. Das ist in Paphos viel wert.' },
    ] },
    { type: 'facts', headline: 'Lage', items: [{ min: 'ca. 7 km', label: 'Flughafen' }, { min: 'ca. 4 km', label: 'Kings Avenue Mall' }], mapLat: 34.767, mapLng: 32.447 },
    { type: 'columns', headline: 'Warum genau hier', cols: [
      { title: 'Nachbarschaft', text: 'Ruhige Wohnstraßen mit vielen Familien. Kleine Cafés und Bäckereien liegen um die Ecke.' },
      { title: 'Infrastruktur', text: 'Die Küstenstraße ist schnell erreicht. Der Flughafen liegt rund 20 Minuten entfernt.' },
      { title: 'Entwicklung', text: 'Im Norden von Paphos entstehen neue Schulen und Geschäfte. Die Gegend wächst seit Jahren stetig.' },
    ] },
    { type: 'feature', headline: 'Ganzjahres-Vermietung', text: 'Paphos hat auch im Winter Gäste. Langzeitmieter suchen moderne Wohnungen mit Pool. Die Nachfrage ist das ganze Jahr über da.', image: IMG('feature'), imageIntent: 'pool' },
    { type: 'marina', kicker: 'Paphos Marina', headline: 'Die neue Marina', distance: '3,8 km', drive: '6 Min', valueText: 'Mit der Marina steigt die Nachfrage nach Wohnungen in der Nähe.', note: 'Quelle: Kathimerini' },
    { type: 'video', headline: 'Projektfilm', embedUrl: 'https://www.youtube.com/embed/abc', aspect: '16/9' },
    { type: 'amenity', headline: 'Gemeinschaftsanlagen', intro: 'Die Anlage bietet Pool, Gym und Café.', items: [{ title: 'Pool', text: 'Gemeinschaftspool mit 181,74 m².', image: IMG('pool') }] },
    { type: 'gallery', headline: 'Innenansichten', items: [{ image: IMG('g1'), title: 'Wohnzimmer' }, { image: IMG('g2'), title: 'Küche' }] },
    { type: 'floorplan', kicker: 'Grundriss', headline: 'So ist C-105 geschnitten', image: unit.floorplanUrl, planNote: '84,5 m² Innenfläche · 16 m² Terrasse' },
    pay,
    { type: 'cta', headline: 'Wie es weitergeht', text: 'Lass uns die nächsten Schritte gemeinsam planen.', steps: [{ n: '01', title: 'Reservierung', text: 'Mit 11.900 € brutto (10.000 € netto) ist C-105 reserviert. Übergabe im September 2028.' }] },
  ])
}
const claim = (block, text, severity = 'high', status = 'unsupported') =>
  claimIssuesToFindings([{ block_index: block, claim: text, severity, status, reason: 'Die Fakten sagen dazu nichts.' }])[0]
const run = (blocks, { claims = [], other = [], c = ctx(), mode = 'on' } = {}) =>
  autofixDeck(blocks, { gate: runDeckGate(blocks, c).findings, claims, other }, c, mode)
const LOCKED_IDX = [I.marina, I.video, I.amenity, I.gallery, I.payment]
const DET = ['priceLines', 'priceSummary', 'priceMain', 'priceSub', 'mapLat', 'mapLng', 'mapQuery', 'mapEmbed', 'mapMarker', 'mapUrl', 'mapLabel',
  'planNote', 'rooms', 'plan', 'embedUrl', 'videoUrl', 'poster', 'aspect', 'image', 'number', 'imageIntent', 'assetId']
const detGleich = (a, b) => a.every((x, i) => DET.every(k => stableEqual(x[k], b[i][k])))
const lockedByteGleich = (a, b) => LOCKED_IDX.every(i => JSON.stringify(a[i]) === JSON.stringify(b[i]))
// Fließtext-Chirurgie ist aus (PROSA_CHIRURGIE = false, 12.10.26): Ein Satz in mehrsätzigem
// Text wird nie herausgeschnitten. Erwartet: Block byte-gleich, Befund bleibt, skipped nennt
// 'fliesstext' (oder einen früheren konservativen Grund aus gruende).
const bleibt = (r, d, bi, key, gruende = ['fliesstext']) => JSON.stringify(r.blocks[bi]) === JSON.stringify(d[bi])
  && r.report.skipped.some(x => x.block === bi && (!key || x.key === key) && gruende.includes(x.reason))
  && r.findings.some(f => (!key || f.key === key) && (f.block === bi || f.block == null))
const wieso = (r) => `${r.report.status} ${JSON.stringify(r.report.skipped)}`

// ── T1: korrektes Deck - nichts zu tun ──────────────────────────────────────
{
  const d = deck()
  const g = runDeckGate(d, ctx())
  ok('T1 Fixture ist grün', g.status === 'green', keys(g.findings))
  const r = run(d)
  ok('T1 korrektes Deck → nothing_to_fix, Blöcke unverändert', r.report.status === 'nothing_to_fix' && r.applied === 0 && stableEqual(r.blocks, deck()), r.report.status)
}

// ── T2: „direkt am Meer" in letter.paragraphs[1] ────────────────────────────
{
  const d = deck()
  d[I.letter].paragraphs[1] = 'Emerald Park liegt in einem ruhigen Wohngebiet von Paphos. Die Anlage liegt direkt am Meer. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.'
  const c1 = claim(I.letter, 'direkt am Meer')
  const r = run(d, { claims: [c1] })
  const p = r.blocks[I.letter].paragraphs
  ok('T2 letter: Satz im Fließtext bleibt (fliesstext), Absatz byte-gleich', bleibt(r, d, I.letter, 'behauptung_unsupported') && p[1] === d[I.letter].paragraphs[1], `${p[1]} ${wieso(r)}`)
  ok('T2 Nachbarabsätze byte-gleich', p[0] === d[I.letter].paragraphs[0] && p[2] === d[I.letter].paragraphs[2])
  ok('T2 nothing_to_fix, Ampel bleibt rot, Befund bleibt', r.report.status === 'nothing_to_fix' && r.report.before.status === 'red' && r.report.after.status === 'red'
    && r.findings.includes(c1) && !r.report.changes.length && !r.report.fixed_findings.length, JSON.stringify(r.report.fixed_findings))
  ok('T2 Eingabe nicht mutiert', /direkt am Meer/.test(d[I.letter].paragraphs[1]))
  ok('T2 gesperrte Blöcke byte-gleich, deterministische Felder unverändert', lockedByteGleich(d, r.blocks) && detGleich(d, r.blocks))
  // Ganzer Satz als Behauptung (wie die KI ihn meist liefert), mit Schlusspunkt
  const r2 = run(clone(d), { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer.')] })
  ok('T2 Behauptung als ganzer Satz mit Punkt → ebenfalls fliesstext', bleibt(r2, d, I.letter, 'behauptung_unsupported'), wieso(r2))
}

// ── „direkt am Meer" in cover.tagline und columns.cols[1].text ──────────────
{
  const d = deck()
  d[I.cover].tagline = 'Wohnen direkt am Meer in Paphos'
  const r = run(d, { claims: [claim(I.cover, 'direkt am Meer')] })
  ok('Tagline: Feld wird geleert, Titel bleibt', r.report.status === 'applied' && r.blocks[I.cover].tagline === undefined && r.blocks[I.cover].title === 'Emerald Park'
    && r.report.changes[0]?.action === 'feld_geleert' && r.report.changes[0]?.field === 'tagline', JSON.stringify(r.report.changes))
  ok('Tagline: Cover-Felder außer tagline unverändert', ['kicker', 'title', 'forLine', 'image', 'imageIntent', 'assetId'].every(k => r.blocks[I.cover][k] === d[I.cover][k]))

  const d2 = deck()
  d2[I.columns].cols[1].text = 'Die Küstenstraße ist schnell erreicht. Direkt am Meer gelegen, mit eigenem Strandzugang. Der Flughafen liegt rund 20 Minuten entfernt.'
  const r2 = run(d2, { claims: [claim(I.columns, 'Direkt am Meer gelegen, mit eigenem Strandzugang')] })
  ok('columns.cols[1].text: Fließtext bleibt (fliesstext)', r2.report.status === 'nothing_to_fix' && bleibt(r2, d2, I.columns, 'behauptung_unsupported'), wieso(r2))

  // Ohne block_index, genau ein Treffer → angenommen
  const d3 = deck()
  d3[I.feature].text = 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Die Nachfrage ist das ganze Jahr über da.'
  const c3 = claimIssuesToFindings([{ claim: 'Die Anlage liegt direkt am Meer', severity: 'high', status: 'unsupported', reason: 'x' }])[0]
  const r3 = run(d3, { claims: [c3] })
  ok('ohne block_index, ein Treffer → gefunden (Block 6), aber Fließtext → fliesstext', c3.block === undefined && r3.report.status === 'nothing_to_fix'
    && bleibt(r3, d3, I.feature, 'behauptung_unsupported') && r3.findings.includes(c3), wieso(r3))
}

// ── T3: Behauptung in benefits.cards → ganze Karte ──────────────────────────
{
  const d = deck()
  d[I.benefits].cards[2] = { icon: '☀️', title: 'Photovoltaik', text: 'Eine Solaranlage auf dem Dach senkt die Nebenkosten spürbar.' }
  const r = run(d, { claims: [claim(I.benefits, 'Eine Solaranlage auf dem Dach senkt die Nebenkosten spürbar')] })
  const ch = r.report.changes[0]
  ok('T3 Karte entfernt, 5 Karten übrig', r.report.status === 'applied' && r.blocks[I.benefits].cards.length === 5 && !JSON.stringify(r.blocks[I.benefits]).includes('Photovoltaik'))
  ok('T3 Änderung zeigt Photovoltaik im before samt Hinweis', ch?.action === 'karte_entfernt' && /Photovoltaik/.test(ch.before) && ch.hint === 'fakt_hinterlegen', JSON.stringify(ch))
  ok('T3 übrige Karten unverändert', stableEqual(r.blocks[I.benefits].cards[2], d[I.benefits].cards[3]))
  const d2 = deck()
  d2[I.benefits].cards = d2[I.benefits].cards.slice(0, 3)
  d2[I.benefits].cards[2] = { icon: '☀️', title: 'Photovoltaik', text: 'Eine Solaranlage auf dem Dach senkt die Nebenkosten spürbar.' }
  const r2 = run(d2, { claims: [claim(I.benefits, 'Eine Solaranlage auf dem Dach senkt die Nebenkosten spürbar')] })
  ok('T3 nur 3 Karten → zu_wenige_karten, nichts geändert', r2.report.status === 'nothing_to_fix' && r2.report.skipped[0]?.reason === 'zu_wenige_karten' && stableEqual(r2.blocks, d2), JSON.stringify(r2.report.skipped))
}

// ── T4: Behauptung im Titel → gesperrt ──────────────────────────────────────
{
  const d = deck()
  d[I.cover].title = 'Emerald Park direkt am Meer'
  const r = run(d, { claims: [claim(I.cover, 'Emerald Park direkt am Meer')] })
  ok('T4 Titel → gesperrtes_feld, bleibt rot', r.report.skipped[0]?.reason === 'gesperrtes_feld' && r.report.after.status === 'red' && stableEqual(r.blocks, d), JSON.stringify(r.report.skipped))
}

// ── T5: nicht wörtlich / mehrdeutig ─────────────────────────────────────────
{
  const d = deck()
  d[I.feature].text = 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Die Nachfrage ist das ganze Jahr über da.'
  const r = run(d, { claims: [claim(I.feature, 'Strandlage in erster Reihe')] })
  ok('T5 umformuliert → nicht_lokalisierbar', r.report.skipped[0]?.reason === 'nicht_lokalisierbar' && stableEqual(r.blocks, d))
  d[I.columns].cols[0].text = 'Ruhige Wohnstraßen mit vielen Familien. Die Anlage liegt direkt am Meer.'
  const c2 = claimIssuesToFindings([{ claim: 'Die Anlage liegt direkt am Meer', severity: 'high', status: 'unsupported', reason: 'x' }])[0]
  const r2 = run(d, { claims: [c2] })
  ok('T5 ohne block_index, zwei Treffer → mehrdeutig', r2.report.skipped[0]?.reason === 'mehrdeutig' && stableEqual(r2.blocks, d), JSON.stringify(r2.report.skipped))
  const r3 = run(deck(), { claims: [claim(I.letter, 'Meer')] })
  ok('T5 Ein-Wort-Behauptung zählt nur als ganzes Feld', r3.report.skipped[0]?.reason === 'nicht_lokalisierbar')
}

// ── T6: Behauptung mittel → nicht angefasst ─────────────────────────────────
{
  const d = deck()
  d[I.feature].text = 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Die Nachfrage ist das ganze Jahr über da.'
  const r = run(d, { claims: [claim(I.feature, 'Die Anlage liegt direkt am Meer', 'medium')] })
  ok('T6 mittel → kein Kandidat, nichts geändert', r.report.status === 'nothing_to_fix' && !r.report.skipped.length && stableEqual(r.blocks, d))
}

// ── T7: Preis im Fließtext (unit.note) auf grünem Deck ──────────────────────
{
  const d = deck()
  d[I.unit].note = 'Die Einrichtung ist als Paket optional erhältlich. Der Gesamtpreis liegt bei 403.410 € brutto. Die Übergabe erfolgt schlüsselfertig.'
  const g = runDeckGate(d, ctx())
  ok('T7 Gate: preis_im_fliesstext mittel mit loc, Deck grün', g.status === 'green' && g.findings.some(f => f.key === 'preis_im_fliesstext' && f.loc?.match === '403.410 €'), keys(g.findings))
  const r = run(d)
  ok('T7 Notiz mit drei Sätzen → fliesstext, Notiz byte-gleich', r.report.status === 'nothing_to_fix' && bleibt(r, d, I.unit, 'preis_im_fliesstext')
    && r.blocks[I.unit].note === d[I.unit].note, `${r.blocks[I.unit].note} ${wieso(r)}`)
  ok('T7 priceLines/priceSummary unverändert, Befund bleibt (mittel), Ampel grün', stableEqual(r.blocks[I.unit].priceLines, priceLines) && stableEqual(r.blocks[I.payment].priceSummary, d[I.payment].priceSummary)
    && r.findings.some(f => f.key === 'preis_im_fliesstext') && r.report.after.status === 'green')
  // Nur der Preissatz in der Notiz → Notiz faellt ganz weg (optionales Feld)
  const d2 = deck()
  d2[I.unit].note = 'Der Gesamtpreis liegt bei 403.410 € brutto.'
  const r2 = run(d2)
  ok('T7 Notiz nur aus Preissatz → Feld entfernt', r2.report.status === 'applied' && r2.blocks[I.unit].note === undefined
    && r2.report.changes[0]?.field === 'note' && !r2.findings.some(f => f.key === 'preis_im_fliesstext'), JSON.stringify(r2.report))
}

// ── T8: Bäder - „1 Badezimmer" gegen CRM 2 Bäder ────────────────────────────
{
  const c2b = ctx({ units: [{ ...unit, bathrooms: 2 }] })
  const d0 = deck(); d0[I.unit].specs[3] = '1 Bad'
  ok('T8 Gate unverändert: „1 Bad" (Einzahl) ist kein Befund', !runDeckGate(d0, c2b).findings.some(f => f.key === 'bad_abweichung'), keys(runDeckGate(d0, c2b).findings))
  const d = deck()
  d[I.unit].specs[3] = '1 Badezimmer'
  const g = runDeckGate(d, c2b)
  ok('T8 Gate: bad_abweichung mit loc.match „1 Badezimmer"', g.findings.some(f => f.key === 'bad_abweichung' && f.loc?.match === '1 Badezimmer'), keys(g.findings))
  const r = run(d, { c: c2b })
  ok('T8 specs-Listenpunkt: Wert gesetzt „2 Badezimmer"', r.report.status === 'applied' && r.blocks[I.unit].specs[3] === '2 Badezimmer'
    && r.report.changes[0]?.action === 'wert_gesetzt' && r.blocks[I.unit].specs.length === 5, JSON.stringify(r.blocks[I.unit].specs))
  ok('T8 übrige specs byte-gleich', [0, 1, 2, 4].every(i => r.blocks[I.unit].specs[i] === d[I.unit].specs[i]))
  // Im Satz: streichen, nie ersetzen
  const d2 = deck()
  d2[I.letter].paragraphs[2] = 'Die Wohnung C-105 hat 2 Schlafzimmer und 1 Badezimmer. Ich rechne dir die Zahlen gern persönlich durch, damit du eine klare Grundlage hast.'
  const r2 = run(d2, { c: c2b })
  ok('T8 im Fließtext: nie ersetzt, nicht gestrichen (fliesstext)', bleibt(r2, d2, I.letter, 'bad_abweichung') && !r2.report.changes.some(c => c.block === I.letter), wieso(r2))
  // CRM 1 Bad, Deck „2 Bäder" / EN „2 bathrooms"
  const d3 = deck(); d3[I.unit].specs[3] = '2 Bäder'
  const r3 = run(d3)
  ok('T8 „2 Bäder" bei CRM 1 → „1 Bad"', r3.blocks[I.unit].specs[3] === '1 Bad', r3.blocks[I.unit].specs[3])
  const d4 = deck(); d4[I.unit].specs[3] = '2 bathrooms'
  const r4 = run(d4)
  ok('T8 EN „2 bathrooms" → „1 bathroom"', r4.blocks[I.unit].specs[3] === '1 bathroom', r4.blocks[I.unit].specs[3])
  // Teilmenge im Listenpunkt: nie umschreiben (sonst „2 Badezimmer en suite"), sondern streichen
  const d5 = deck(); d5[I.unit].specs = ['2 Schlafzimmer', '2 Bäder', '1 Badezimmer en suite im Master']
  const r5 = run(d5, { c: c2b })
  ok('T8 „1 Badezimmer en suite im Master" → Punkt gestrichen, nicht umgeschrieben', r5.report.status === 'applied'
    && JSON.stringify(r5.blocks[I.unit].specs) === JSON.stringify(['2 Schlafzimmer', '2 Bäder']) && r5.report.changes[0]?.action === 'punkt_entfernt'
    && !r5.report.changes.some(c => c.action === 'wert_gesetzt'), JSON.stringify(r5.blocks[I.unit].specs))
  const d6 = deck(); d6[I.unit].specs = ['84,5 m² Innenfläche', '1 Schlafzimmer mit Meerblick', '1 Badezimmer']
  const r6 = run(d6)
  ok('T8 „1 Schlafzimmer mit Meerblick" (CRM 2) → Punkt gestrichen', r6.report.status === 'applied'
    && JSON.stringify(r6.blocks[I.unit].specs) === JSON.stringify(['84,5 m² Innenfläche', '1 Badezimmer']) && r6.report.changes[0]?.action === 'punkt_entfernt', JSON.stringify(r6.blocks[I.unit].specs))
}

// ── T9: zwei Wohnungen, Zimmerzahl ──────────────────────────────────────────
{
  const unitB = { ...unit, unitId: 'u2', unitNumber: 'B-2', unitKey: 'b2', bedrooms: 3, bathrooms: 2, sizeSqm: 110, terraceSqm: 20, floor: 2,
    price: null, priceLines: [], priceSummary: null, floorplanUrl: null, floorplanSource: null }
  const c = ctx({ units: [unit, unitB] })
  const d = deck()
  d.splice(I.unit + 1, 0, { type: 'unit', kicker: 'Alternative', number: 'B-2', specs: ['110 m² Innenfläche', '4 Schlafzimmer', '2 Badezimmer', '2. Etage'], note: 'Die größere Variante mit viel Platz für Familien.', image: IMG('unit2') })
  d[I.letter].paragraphs[2] = 'Beide Wohnungen haben 4 Schlafzimmer. Ich rechne dir die Zahlen gern persönlich durch, damit du eine klare Grundlage hast.'
  const r = run(d, { c })
  ok('T9 Anschreiben (zwei Wohnungen): Fließtext bleibt (fliesstext)', bleibt(r, d, I.letter, 'zimmer_abweichung'), wieso(r))
  ok('T9 unit-Block B-2: Wert von B-2 gesetzt („3 Schlafzimmer")', r.blocks[I.unit + 1].specs[1] === '3 Schlafzimmer' && r.blocks[I.unit].specs[2] === '2 Schlafzimmer', JSON.stringify(r.blocks[I.unit + 1].specs))
  ok('T9 Ampel nicht schlechter', r.report.after.red <= r.report.before.red, `${r.report.before.red} -> ${r.report.after.red}`)
}

// ── Etage ───────────────────────────────────────────────────────────────────
{
  const d = deck(); d[I.unit].specs[4] = '3. Etage'
  const r = run(d)
  ok('Etage „3. Etage" bei CRM 1 → „1. Etage"', r.report.status === 'applied' && r.blocks[I.unit].specs[4] === '1. Etage', r.blocks[I.unit].specs[4])
  const d2 = deck(); d2[I.unit].specs[4] = 'Erdgeschoss mit Gartenanteil'
  const r2 = run(d2)
  ok('Etage „Erdgeschoss mit Gartenanteil" bei CRM 1 → Punkt gestrichen (kein „1. Etage mit Gartenanteil")', r2.report.status === 'applied'
    && r2.blocks[I.unit].specs.length === 4 && !r2.blocks[I.unit].specs.some(x => /Gartenanteil/.test(x)) && r2.report.changes[0]?.action === 'punkt_entfernt', JSON.stringify(r2.blocks[I.unit].specs))
  // Grenzwerte: Studio (0 Schlafzimmer) und Untergeschoss werden gestrichen, nie „0 Schlafzimmer" / „-1. Etage"
  const studio = ctx({ units: [{ ...unit, bedrooms: 0 }] })
  const d3 = deck(); d3[I.unit].specs[2] = '1 Schlafzimmer'
  const g3 = runDeckGate(d3, studio).findings
  const r3 = run(d3, { c: studio })
  ok('Studio (CRM 0 Schlafzimmer): „1 Schlafzimmer" wird gestrichen, nicht „0 Schlafzimmer"', g3.some(f => f.key === 'zimmer_abweichung')
    && (r3.report.status === 'applied' && !r3.blocks[I.unit].specs.some(x => /Schlafzimmer/.test(x)) && !JSON.stringify(r3.blocks).includes('0 Schlafzimmer')), `${keys(g3)} ${JSON.stringify(r3.blocks[I.unit].specs)}`)
  // EN „1st floor" bei CRM 0 am Anfang des Punkts → „Ground floor" (gross)
  const ground = ctx({ units: [{ ...unit, floor: 0 }] })
  const d4 = deck(); d4[I.unit].specs[4] = '1st floor'
  const r4 = run(d4, { c: ground })
  ok('EN „1st floor" bei CRM 0 → „Ground floor"', r4.blocks[I.unit].specs[4] === 'Ground floor', r4.blocks[I.unit].specs[4])
}

// ── T10: Renditeaussage ─────────────────────────────────────────────────────
{
  const d = deck()
  d[I.feature].text = 'Paphos hat auch im Winter Gäste. Erwartet wird eine Mietrendite von 6 % im Jahr. Die Nachfrage ist das ganze Jahr über da.'
  d[I.amenity].intro = 'Die Anlage bietet Pool, Gym und Café. Erwartet wird eine Mietrendite von 6 % im Jahr.'
  d.splice(I.cta, 0, { type: 'feature', headline: 'Die Marina kommt', image: MARINA_MODEL, text: 'Die neue Marina wertet die Gegend auf. Erwartet wird eine Mietrendite von 6 % im Jahr.' })
  const r = run(d)
  ok('T10 renditeaussage im feature.text (Fließtext) → fliesstext, Text bleibt', bleibt(r, d, I.feature, 'renditeaussage') && r.report.after.status === 'red', wieso(r))
  ok('T10 gleiche Aussage im amenity-Block → systemblock', r.report.skipped.some(s => s.block === I.amenity && s.reason === 'systemblock') && r.blocks[I.amenity].intro === d[I.amenity].intro)
  ok('T10 Marina-feature mit Modellbild → systemblock', r.report.skipped.some(s => s.block === I.cta && s.reason === 'systemblock') && r.blocks[I.cta].text === d[I.cta].text, JSON.stringify(r.report.skipped))
  ok('T10 gesperrte Blöcke byte-gleich', lockedByteGleich(d, r.blocks) && JSON.stringify(d[I.cta]) === JSON.stringify(r.blocks[I.cta]))
}

// ── T11: Beträge ────────────────────────────────────────────────────────────
{
  const d = deck()
  d[I.letter].paragraphs[1] = 'Emerald Park liegt in einem ruhigen Wohngebiet von Paphos. Vergleichbare Wohnungen kosten 585.000 € netto. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.'
  const r = run(d)
  ok('T11 betrag_fremd hoch im Fließtext des Anschreibens → fliesstext, bleibt rot', bleibt(r, d, I.letter, 'betrag_fremd') && r.report.after.status === 'red', wieso(r))
  // Absatz nur aus dem Betragssatz: ganze Absätze entfernt die Automatik nie (Runde 5)
  const d1 = deck()
  d1[I.letter].paragraphs.splice(1, 0, 'Vergleichbare Wohnungen kosten 585.000 € netto.')
  const r1 = run(d1)
  ok('T11 Absatz nur aus dem Betragssatz → fliesstext, Brief byte-gleich, bleibt rot', r1.report.status === 'nothing_to_fix'
    && bleibt(r1, d1, I.letter, 'betrag_fremd') && r1.report.after.status === 'red', wieso(r1))
  const fake = { key: 'betrag_fremd', severity: 'hoch', block: I.payment, what: 'Betrag im Zahlungsplan', loc: { field: 'note', match: 'Reservierung' } }
  const r2 = autofixDeck(deck(), { gate: [fake], claims: [], other: [] }, ctx(), 'on')
  ok('T11 betrag_fremd im payment-Block → systemblock', r2.report.skipped[0]?.reason === 'systemblock' && stableEqual(r2.blocks, deck()))
  const d3 = deck()
  d3[I.letter].paragraphs[1] = 'Emerald Park liegt in einem ruhigen Wohngebiet. Die Gebühr liegt bei 1.234 € im Jahr. Supermarkt und Schulen sind nah.'
  const g3 = runDeckGate(d3, ctx())
  const r3 = run(d3)
  ok('T11 betrag_fremd mittel → nicht angefasst', g3.findings.some(f => f.key === 'betrag_fremd' && f.severity === 'mittel') && r3.report.status === 'nothing_to_fix' && stableEqual(r3.blocks, d3), keys(g3.findings))
}

// ── T12: Satztrennung ───────────────────────────────────────────────────────
{
  const s = (t) => splitSaetze(t).map(x => x.text.trim())
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  ok('T12 „2. Etage" trennt nicht', eq(s('Die Wohnung liegt in der 2. Etage. Direkt am Meer.'), ['Die Wohnung liegt in der 2. Etage.', 'Direkt am Meer.']), JSON.stringify(s('Die Wohnung liegt in der 2. Etage. Direkt am Meer.')))
  ok('T12 „z. B." trennt nicht', eq(s('Viele Extras, z. B. Pool und Gym. Danach kommt mehr.'), ['Viele Extras, z. B. Pool und Gym.', 'Danach kommt mehr.']))
  ok('T12 „z. B. Paphos" (Großbuchstabe danach) trennt nicht', eq(s('Orte wie z. B. Paphos sind gefragt. Ende.'), ['Orte wie z. B. Paphos sind gefragt.', 'Ende.']))
  ok('T12 „ca. 5 km" trennt nicht', eq(s('Der Strand ist ca. 5 km entfernt. Gut so.'), ['Der Strand ist ca. 5 km entfernt.', 'Gut so.']))
  ok('T12 „1. Oktober" trennt nicht', eq(s('Übergabe am 1. Oktober 2028. Danach Vermietung.'), ['Übergabe am 1. Oktober 2028.', 'Danach Vermietung.']))
  ok('T12 „Nr. 3" trennt nicht', eq(s('Es ist Haus Nr. 3 in der Reihe. Schön.'), ['Es ist Haus Nr. 3 in der Reihe.', 'Schön.']))
  ok('T12 „u. a." trennt nicht', eq(s('Es gibt u. a. Pool und Gym. Mehr folgt.'), ['Es gibt u. a. Pool und Gym.', 'Mehr folgt.']))
  ok('T12 Ausrufe- und Fragezeichen trennen', eq(s('Was für ein Blick! Willst du ihn sehen? Dann komm.'), ['Was für ein Blick!', 'Willst du ihn sehen?', 'Dann komm.']))
  ok('T12 Jahreszahl am Satzende trennt', eq(s('Fertig im Jahr 2028. Danach geht es los.'), ['Fertig im Jahr 2028.', 'Danach geht es los.']))
  ok('T12 „Jan. 2027" trennt nicht', eq(s('Übergabe im Jan. 2027 geplant. Danach Schlüssel.'), ['Übergabe im Jan. 2027 geplant.', 'Danach Schlüssel.']), JSON.stringify(s('Übergabe im Jan. 2027 geplant. Danach Schlüssel.')))
  ok('T12 „Sept. 2028" trennt nicht', eq(s('Die Übergabe ist für Sept. 2028 geplant, der Pool liegt nah. Supermarkt und Cafés sind nah.'), ['Die Übergabe ist für Sept. 2028 geplant, der Pool liegt nah.', 'Supermarkt und Cafés sind nah.']))
  ok('T12 „Okt." / „Dez." trennen nicht', eq(s('Von Okt. bis Dez. 2027 wird gebaut. Ende.'), ['Von Okt. bis Dez. 2027 wird gebaut.', 'Ende.']))
  ok('T12 „Mr. Smith" trennt nicht', eq(s('Your contact is Mr. Smith from Paphos. He knows the area.'), ['Your contact is Mr. Smith from Paphos.', 'He knows the area.']))
  ok('T12 „Co. KG" und „S. 4" trennen nicht', eq(s('Die Muster GmbH & Co. KG baut. Details auf S. 4 im Exposé. Ende.'), ['Die Muster GmbH & Co. KG baut.', 'Details auf S. 4 im Exposé.', 'Ende.']))
  ok('T12 Ordnungszahl am Satzende vor Artikel trennt („der 2. Die ...")', eq(s('Gebaut wird im Bauabschnitt der 2. Die Anlage liegt ruhig. Ende.'), ['Gebaut wird im Bauabschnitt der 2.', 'Die Anlage liegt ruhig.', 'Ende.']))
  ok('T12 „die 2. Wohnung" trennt weiter nicht', eq(s('Das ist die 2. Wohnung im Haus. Ende.'), ['Das ist die 2. Wohnung im Haus.', 'Ende.']))
  ok('T12 Dezimalzahl und Preis trennen nicht', eq(s('Es sind 84.5 m² und 403.410 €. Ende.'), ['Es sind 84.5 m² und 403.410 €.', 'Ende.']))
  // Prüfbefunde 12.10.26 (zweite Runde)
  ok('T12 „lt. Bauträger" trennt nicht', eq(s('Die Übergabe ist lt. Bauträger für 2028 geplant. Ende.'), ['Die Übergabe ist lt. Bauträger für 2028 geplant.', 'Ende.']))
  ok('T12 „rd. 20 Minuten" trennt nicht', eq(s('Der Flughafen liegt rd. 20 Minuten entfernt. Ende.'), ['Der Flughafen liegt rd. 20 Minuten entfernt.', 'Ende.']))
  // „gem." ist seit der Endprüfung 12.10.26 nur vor einer Ziffer ein Kürzel („a hidden gem. The ...").
  // „gem. Plan" trennt deshalb, die Grenze „gem." gilt aber als unsicher: dort wird nie geschnitten.
  ok('T12 „gem. Plan" trennt, Grenze unsicher; „bspw. Pool" trennt nicht', eq(s('Gebaut wird gem. Plan des Bauträgers. Extras, bspw. Pool und Gym, kommen dazu. Ende.'), ['Gebaut wird gem.', 'Plan des Bauträgers.', 'Extras, bspw. Pool und Gym, kommen dazu.', 'Ende.'])
    && !sichereGrenze('Gebaut wird gem. '))
  ok('T12 „gem. § 4" / „gem. 5" trennt nicht', eq(s('Gebaut wird gem. 5 Plänen. Ende.'), ['Gebaut wird gem. 5 Plänen.', 'Ende.']))
  ok('T12 „5 % p. a. Die ..." trennt', eq(s('Vergleichbare Wohnungen bringen 5 % p. a. Die genauen Zahlen rechnet Sven dir durch.'), ['Vergleichbare Wohnungen bringen 5 % p. a.', 'Die genauen Zahlen rechnet Sven dir durch.']))
  ok('T12 „u. a. Außerdem ..." trennt', eq(s('Die Anlage bietet Pool, Gym u. a. Außerdem gibt es ein Café.'), ['Die Anlage bietet Pool, Gym u. a.', 'Außerdem gibt es ein Café.']))
  ok('T12 „u. a. Wohnungen" (kein Satzanfang) trennt nicht', eq(s('Gefragt sind u. a. Wohnungen mit Pool. Ende.'), ['Gefragt sind u. a. Wohnungen mit Pool.', 'Ende.']))
  ok('T12 „d. h. Du ..." trennt nie', eq(s('Die Wohnung ist vermietet, d. h. Du bekommst ab Tag eins Miete. Ende.'), ['Die Wohnung ist vermietet, d. h. Du bekommst ab Tag eins Miete.', 'Ende.']))
  ok('T12 „Lieber Max. Die ..." trennt', eq(s('Lieber Max. Die Anlage liegt ruhig.'), ['Lieber Max.', 'Die Anlage liegt ruhig.']))
  ok('T12 „Hallo Jan. Die ..." trennt, „Jan. 2027" weiter nicht', eq(s('Hallo Jan. Die Übergabe ist im Jan. 2027. Ende.'), ['Hallo Jan.', 'Die Übergabe ist im Jan. 2027.', 'Ende.']))
  const d = deck()
  d[I.letter].paragraphs[1] = 'Die Wohnung liegt in der 1. Etage. Direkt am Meer. Supermarkt, Schulen und Cafés sind z. B. in wenigen Minuten erreichbar.'
  const r = run(d, { claims: [claim(I.letter, 'Direkt am Meer')] })
  const d2 = deck()
  d2[I.letter].paragraphs[1] = 'Die Übergabe ist für Sept. 2028 geplant, der Pool liegt direkt am Meer. Supermarkt und Cafés sind nah.'
  const r2 = run(d2, { claims: [claim(I.letter, 'der Pool liegt direkt am Meer')] })
  ok('T12 im Deck: „Sept. 2028"-Absatz bleibt ganz (fliesstext), kein Satzfragment', bleibt(r2, d2, I.letter, 'behauptung_unsupported'), wieso(r2))
  ok('T12 im Deck: „1. Etage"/„z. B."-Absatz bleibt ganz (fliesstext)', bleibt(r, d, I.letter, 'behauptung_unsupported'), wieso(r))
}

// ── T13: HTML-Feld ──────────────────────────────────────────────────────────
{
  const d = deck()
  d[I.unit].note = '<b>Hinweis:</b> Der Gesamtpreis liegt bei 403.410 € brutto.'
  const r = run(d)
  ok('T13 note mit HTML → html_feld', r.report.skipped[0]?.reason === 'html_feld' && stableEqual(r.blocks, d), JSON.stringify(r.report.skipped))
}

// ── T14: Grenzen ────────────────────────────────────────────────────────────
{
  // 11 Kandidaten: der elfte bekommt 'limit'. Ohne Fließtext-Chirurgie als ganze Karten:
  // je ein zusätzlicher Key-Facts-Block mit sechs Karten, eine Karte trägt die Behauptung.
  const d = deck()
  const claims = []
  for (let k = 0; k < 11; k++) {
    d.splice(I.cta + k, 0, { type: 'benefits', headline: `Details zur Anlage`, cards: [
      { icon: '🏖️', title: `Strand ${k}`, text: `Extra ${k} am Strand für alle Bewohner der Anlage.` },
      ...['Ruhige Lage im Wohngebiet', 'Kurze Wege zu Schulen', 'Cafés und Geschäfte in der Nähe', 'Moderne Bauweise mit guter Dämmung', 'Gepflegte Außenanlagen mit Grün']
        .map((t, j) => ({ icon: '✓', title: `Punkt ${j + 1}`, text: t })),
    ] })
    claims.push(claim(I.cta + k, `Extra ${k} am Strand`))
  }
  const r = run(d, { claims })
  ok('T14 elf Kandidaten (Karten) → zehn Korrekturen, einer limit', r.report.status === 'applied' && r.report.changes.length === 10
    && r.report.changes.every(c => c.action === 'karte_entfernt') && r.report.skipped.filter(s => s.reason === 'limit').length === 1,
    `${r.report.status} ${r.report.changes.length} ${JSON.stringify(r.report.skipped)} ${r.report.rollback_reason ?? ''}`)
  // Mehr als 15 % des Textes → alles zurück
  const d2 = deck()
  const lang = 'Diese Wohnung liegt direkt am Meer und bietet einen unverbaubaren Blick über die ganze Bucht von Paphos bis hinüber zum alten Hafen, mit eigenem Zugang zum Sandstrand, einem privaten Bootssteg und einer Strandbar, die exklusiv den Bewohnern der Anlage vorbehalten ist und das ganze Jahr über geöffnet hat, sodass du an jedem Tag des Jahres direkt vor der Haustür ins Meer springen kannst, ohne auch nur eine Straße zu überqueren.'
  // je eine lange Aussage als eigene Key-Facts-Karte in zwei Key-Facts-Blöcken (ganze
  // Absätze entfernt die Automatik nicht mehr): je Block unter 50 %, zusammen über 15 %
  d2[I.benefits].cards.push({ icon: '🌊', title: 'Strandlage', text: lang.replace('Diese Wohnung', 'Die Anlage') })
  const zweit = clone(deck()[I.benefits]); zweit.headline = 'Noch mehr Key Facts'
  zweit.cards.push({ icon: '🌊', title: 'Strand', text: lang })
  d2.splice(I.cta, 0, zweit)
  const inp = clone(d2)
  const cl = [claim(I.cta, lang), claim(I.benefits, lang.replace('Diese Wohnung', 'Die Anlage'))]
  const r2 = run(d2, { claims: cl })
  ok('T14 mehr als 15 % Text → rolled_back, Eingabe unverändert zurück', r2.report.status === 'rolled_back' && /15 %/.test(r2.report.rollback_reason ?? '') && r2.report.rollback_code === 'textanteil'
    && r2.blocks === d2 && stableEqual(r2.blocks, inp) && r2.findings.length === runDeckGate(d2, ctx()).findings.length + 2 && r2.applied === 0, `${r2.report.status} ${r2.report.rollback_reason}`)
  // Mehr als 50 % eines Blocks: diese Korrektur nicht (limit). Notiz aus genau einem langen Satz.
  const d3 = deck()
  const lang3 = 'Die Anlage liegt direkt am Meer, mit eigenem Strandzugang, einem Bootssteg für alle Bewohner der Anlage, einer Strandbar mit Liegen und Sonnenschirmen und einem Wassersportverleih gleich nebenan'
  d3[I.unit].note = lang3 + '.'
  const r3 = run(d3, { claims: [claim(I.unit, lang3)] })
  ok('T14 über 50 % eines Blocks → limit, Block unverändert', r3.report.skipped[0]?.reason === 'limit' && stableEqual(r3.blocks, d3), JSON.stringify(r3.report.skipped))
  // Gegenprobe: dieselbe Kurznotiz unter 50 % → entfernt
  const d4 = deck()
  d4[I.unit].note = 'Die Anlage liegt direkt am Meer.'
  const r4 = run(d4, { claims: [claim(I.unit, 'Die Anlage liegt direkt am Meer')] })
  ok('T14 Gegenprobe: kurze Notiz nur aus der Behauptung → entfernt', r4.report.status === 'applied' && r4.blocks[I.unit].note === undefined, wieso(r4))
}

// ── T15: Invarianten der Gesamtprüfung ──────────────────────────────────────
{
  const base = deck()
  const g = (...a) => gesamtPruefung(...a)?.grund ?? null
  const t = (fn, beruehrt = new Map()) => { const w = clone(base); fn(w); return g(base, w, beruehrt, 1, 0, 0) }
  ok('T15 unverändert → kein Grund', t(() => {}) === null)
  ok('T15 priceLines manipuliert → Grund', /priceLines/.test(t(w => { w[I.unit].priceLines[2].value = '1 €' }, new Map([[I.unit, new Map([['priceLines', 1]])]])) ?? ''))
  ok('T15 image manipuliert → Grund', /image/.test(t(w => { w[I.feature].image = IMG('x') }) ?? ''))
  ok('T15 mapLat manipuliert → Grund', /mapLat/.test(t(w => { w[I.facts].mapLat = 1 }) ?? ''))
  ok('T15 Marina-Block geändert → Grund', /Systemblock 7/.test(t(w => { w[I.marina].note = 'x' }) ?? ''))
  ok('T15 payment-Block geändert → Grund', /Systemblock 12/.test(t(w => { w[I.payment].intro = 'x' }) ?? ''))
  ok('T15 nicht berührtes Feld geändert → Grund', /ohne Korrektur/.test(t(w => { w[I.letter].headline = 'x' }) ?? ''))
  ok('T15 Blockfolge geändert → Grund', /Block/.test(t(w => { w.reverse() }) ?? ''))
  ok('T15 mehr rote Befunde → Grund', /rote/.test(g(base, clone(base), new Map(), 1, 0, 1) ?? ''))
  ok('T15 kein Ziel behoben → Grund', /kein Befund/.test(g(base, clone(base), new Map(), 0, 0, 0) ?? ''))
  ok('T15 mehr als 10 Korrekturen → Grund', /10 Korrekturen/.test(g(base, clone(base), new Map(), 11, 0, 0) ?? ''))
  ok('T15 LOCKED_TYPES vollständig', ['payment', 'gallery', 'marina', 'video', 'masterplan', 'amenity'].every(x => LOCKED_TYPES.has(x)))
  // Prüfbefund 12.10.26: Listen elementweise - eine Korrektur in cards[2] erlaubt keine Änderung in cards[4]
  const eine = new Map([[I.benefits, new Map([['cards', 1]])]])
  ok('T15 eine Korrektur in cards[2] → kein Grund', t(w => { w[I.benefits].cards[2].text = 'Ruhig und gut gedämmt.' }, eine) === null)
  ok('T15 eine Karte entfernt → kein Grund', t(w => { w[I.benefits].cards.splice(3, 1) }, eine) === null)
  ok('T15 Korrektur in cards[2] UND Änderung in cards[4] → Grund', /weiter verändert/.test(t(w => {
    w[I.benefits].cards[2].text = 'Ruhig und gut gedämmt.'; w[I.benefits].cards[4].text = 'x' }, eine) ?? ''))
  ok('T15 Karte hinzugefügt → Grund', /weiter verändert/.test(t(w => { w[I.benefits].cards.push({ title: 'x', text: 'y' }) }, eine) ?? ''))
  ok('T15 Rücknahme trägt einen Code', gesamtPruefung(base, clone(base), new Map(), 1, 0, 1)?.code === 'rot_mehr'
    && gesamtPruefung(base, clone(base), new Map(), 0, 0, 0)?.code === 'nichts_behoben')
}

// ── T16: Einzel-Rücknahme bei neuem Befund ──────────────────────────────────
{
  const d = deck()
  // „Fitness" im ersten Satz schützt die 92 m² vor dem Flächenbefund - fällt der Satz,
  // würde die Terrassenfläche neu rot. Diese Korrektur muss zurück.
  // (Endprüfung 12.10.26: „Gym." wäre eine unsichere Satzgrenze, „Dazu" ein Verweis - daher „Fitnessraum" / „Abends".)
  d[I.letter].paragraphs[2] = 'Deine Wohnung mit 4 Schlafzimmern liegt direkt beim Fitnessraum. Abends genießt du 92 m² Terrasse.'
  // Ohne Fließtext-Chirurgie fällt der Satz gar nicht erst: fliesstext, Fläche bleibt geschützt.
  d[I.unit].note = 'Der Gesamtpreis liegt bei 403.410 € brutto.'
  const before = runDeckGate(d, ctx()).findings
  ok('T16 Ausgang: zimmer hoch, keine Fläche', before.some(f => f.key === 'zimmer_abweichung') && !before.some(f => f.key === 'flaeche_abweichung'), keys(before))
  const r = run(d)
  ok('T16 zimmer im Fließtext → fliesstext, Anschreiben byte-gleich, keine neue Fläche', bleibt(r, d, I.letter, 'zimmer_abweichung')
    && !r.findings.some(f => f.key === 'flaeche_abweichung'), wieso(r))
  ok('T16 andere Korrektur bleibt (Notiz nur aus Preissatz)', r.report.status === 'applied' && r.blocks[I.unit].note === undefined && !r.findings.some(f => f.key === 'flaeche_abweichung'), r.report.status)
}

// ── T17: Idempotenz ─────────────────────────────────────────────────────────
{
  const d = deck()
  d[I.letter].paragraphs[1] = 'Emerald Park liegt in einem ruhigen Wohngebiet von Paphos. Die Anlage liegt direkt am Meer. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.'
  d[I.unit].specs[2] = '3 Schlafzimmer'
  d[I.unit].note = 'Die Einrichtung ist als Paket optional erhältlich. Der Gesamtpreis liegt bei 403.410 € brutto.'
  d[I.cover].title = 'Emerald Park mit Photovoltaik'
  const claims = [claim(I.letter, 'Die Anlage liegt direkt am Meer'), claim(I.cover, 'Emerald Park mit Photovoltaik')]
  const r1 = run(d, { claims })
  const rest = r1.findings.filter(f => f.key.startsWith('behauptung_'))
  const r2 = run(r1.blocks, { claims: rest })
  ok('T17 erster Lauf: specs gesetzt, Fließtext (Anschreiben, Notiz) bleibt', r1.report.status === 'applied' && r1.report.changes.length === 1
    && r1.report.changes[0].action === 'wert_gesetzt' && r1.report.skipped.filter(x => x.reason === 'fliesstext').length === 2
    && r1.blocks[I.letter].paragraphs[1] === d[I.letter].paragraphs[1] && r1.blocks[I.unit].note === d[I.unit].note, `${r1.report.changes.length} ${JSON.stringify(r1.report.skipped)}`)
  // Ganze Einheiten: Absatz nur aus der Behauptung, Notiz nur aus dem Preissatz
  const e = deck()
  e[I.letter].paragraphs.splice(1, 0, 'Die Anlage liegt direkt am Meer.')
  e[I.unit].specs[2] = '3 Schlafzimmer'
  e[I.unit].note = 'Der Gesamtpreis liegt bei 403.410 € brutto.'
  e[I.cover].title = 'Emerald Park mit Photovoltaik'
  const e1 = run(e, { claims })
  const e2 = run(e1.blocks, { claims: e1.findings.filter(f => f.key.startsWith('behauptung_')) })
  ok('T17 ganze Einheiten: erster Lauf bereinigt specs und Notiz, Absatz bleibt (fliesstext)', e1.report.status === 'applied' && e1.report.changes.length === 2
    && stableEqual(e1.blocks[I.letter], e[I.letter]) && e1.report.skipped.some(x => x.block === I.letter && x.reason === 'fliesstext'), `${e1.report.changes.length} ${JSON.stringify(e1.report.skipped)}`)
  ok('T17 ganze Einheiten: zweiter Lauf nothing_to_fix, Blöcke gleich', e2.report.status === 'nothing_to_fix' && stableEqual(e2.blocks, e1.blocks), `${e2.report.status} ${JSON.stringify(e2.report.changes)}`)
  ok('T17 zweiter Lauf: nothing_to_fix, Blöcke gleich', r2.report.status === 'nothing_to_fix' && stableEqual(r2.blocks, r1.blocks), `${r2.report.status} ${JSON.stringify(r2.report.changes)}`)
}

// ── T18: mitentfernte Behauptung ────────────────────────────────────────────
{
  const d = deck()
  // Ein Satz mit beiden Aussagen: die Karte fällt ganz weg (Kartentext nur aus der Aussage)
  d[I.benefits].cards[2] = { icon: '☀️', title: 'Photovoltaik', text: 'Photovoltaik auf dem Dach senkt die Nebenkosten, dazu kommt ein Batteriespeicher im Keller.' }
  const c1 = claim(I.benefits, 'Photovoltaik auf dem Dach senkt die Nebenkosten')
  const c2 = claim(I.benefits, 'dazu kommt ein Batteriespeicher im Keller', 'medium')
  const r = run(d, { claims: [c1, c2] })
  ok('T18 zweite Behauptung in derselben Karte → mit_entfernt, fällt aus den Befunden', r.report.fixed_findings.some(x => x.via === 'mit_entfernt' && /Batteriespeicher/.test(x.what))
    && !r.findings.some(f => f.key.startsWith('behauptung_')), JSON.stringify(r.report.fixed_findings))
  const c3 = claim(I.letter, 'Ein Satz, der nirgends steht', 'medium')
  const r2 = run(d, { claims: [c1, c3] })
  ok('T18 nie gefundene Behauptung bleibt stehen', r2.findings.some(f => f === c3))
}

// ── T19: keine Gedankenstriche, echte Umlaute ───────────────────────────────
{
  const all = []
  const d = deck()
  d[I.unit].specs = ['84,5 m² Innenfläche', '3 Schlafzimmer', '2 Bäder', 'Erdgeschoss']
  d[I.letter].paragraphs.splice(1, 0, 'Die Anlage liegt direkt am Meer.')
  const r = run(d, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  for (const c of r.report.changes) all.push(c.after)
  ok('T19 kein — oder – in geänderten Feldern', r.report.changes.length >= 3 && all.every(x => !/[—–]/.test(x)), JSON.stringify(all))
  const vorlagen = [
    ersatzWert('bad_abweichung', '2 Bäder', 1), ersatzWert('bad_abweichung', '1 Bad', 2), ersatzWert('bad_abweichung', '3 Badezimmer', 2),
    ersatzWert('zimmer_abweichung', '3 Schlafzimmer', 2), ersatzWert('zimmer_abweichung', 'drei Schlafzimmer', 1),
    ersatzWert('etage_abweichung', '3. Etage', 0), ersatzWert('etage_abweichung', 'Erdgeschoss', 2), ersatzWert('etage_abweichung', '3. Obergeschoss', 1),
  ]
  ok('T19 Vorlagen DE mit echten Umlauten', JSON.stringify(vorlagen) === JSON.stringify(['1 Bad', '2 Bäder', '2 Badezimmer', '2 Schlafzimmer', '1 Schlafzimmer', 'Erdgeschoss', '2. Etage', '1. Obergeschoss'])
    && vorlagen.every(v => !/ae|oe|ue/.test(v)), JSON.stringify(vorlagen))
  const en = [ersatzWert('zimmer_abweichung', '3 bedrooms', 1), ersatzWert('zimmer_abweichung', '1 Bedroom', 2), ersatzWert('bad_abweichung', '2 bathrooms', 1),
    ersatzWert('etage_abweichung', '3rd floor', 2), ersatzWert('etage_abweichung', '1st floor', 0), ersatzWert('etage_abweichung', 'ground floor', 11)]
  ok('T19 Vorlagen EN', JSON.stringify(en) === JSON.stringify(['1 bedroom', '2 Bedrooms', '1 bathroom', '2nd floor', 'ground floor', '11th floor']), JSON.stringify(en))
}

// ── T20: Probelauf und Aus ──────────────────────────────────────────────────
{
  const d = deck()
  d[I.unit].note = 'Die Anlage liegt direkt am Meer.'
  const inp = clone(d)
  const c1 = claim(I.unit, 'Die Anlage liegt direkt am Meer')
  const gateF = runDeckGate(d, ctx()).findings
  const r = autofixDeck(d, { gate: gateF, claims: [c1], other: [] }, ctx(), 'dry_run')
  ok('T20 dry_run: Blöcke und Befunde unverändert, report.changes gefüllt', r.report.status === 'dry_run' && r.blocks === d && stableEqual(d, inp)
    && r.findings.length === gateF.length + 1 && r.findings.includes(c1) && r.applied === 0 && r.report.changes.length === 1 && r.report.after.status === 'green', r.report.status)
  const r2 = autofixDeck(d, { gate: gateF, claims: [c1], other: [] }, ctx(), 'off')
  ok('T20 off: nichts berechnet, nichts geändert', r2.report.status === 'nothing_to_fix' && r2.report.changes.length === 0 && r2.blocks === d && stableEqual(d, inp) && r2.findings.includes(c1))
}

// ── T21: Indexverschiebung ──────────────────────────────────────────────────
{
  const d = deck()
  d[I.letter].paragraphs = [
    d[I.letter].paragraphs[0],
    'Die Anlage liegt direkt am Meer.',
    'Emerald Park liegt in einem ruhigen Wohngebiet von Paphos. Jede Wohnung hat einen privaten Pool. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.',
    d[I.letter].paragraphs[2],
  ]
  const r = run(d, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer'), claim(I.letter, 'Jede Wohnung hat einen privaten Pool')] })
  const p = r.blocks[I.letter].paragraphs
  // Seit Runde 5 fällt kein ganzer Absatz mehr weg: beide Befunde bleiben (fliesstext), Brief byte-gleich
  ok('T21 Ein-Satz-Absatz und Fließtext-Absatz: beide fliesstext, Brief byte-gleich', r.report.status === 'nothing_to_fix'
    && stableEqual(p, d[I.letter].paragraphs) && r.report.changes.length === 0
    && r.report.skipped.filter(x => x.reason === 'fliesstext').length === 2, `${JSON.stringify(p)} ${wieso(r)}`)
  // letzter Absatz darf nicht verschwinden
  const d2 = deck()
  d2[I.letter].paragraphs = ['Die Anlage liegt direkt am Meer.']
  const r2 = run(d2, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  ok('T21 letzter Absatz → pflichtfeld', r2.report.skipped[0]?.reason === 'pflichtfeld' && stableEqual(r2.blocks, d2))
}

// ── T22: Vertrag mit dem Gate ───────────────────────────────────────────────
{
  const c2b = ctx({ units: [{ ...unit, bathrooms: 2 }] })
  const d = deck()
  d[I.unit].specs = ['92 m² Innenfläche', '3 Schlafzimmer', '1 Badezimmer', '3. Etage']
  d[I.unit].note = 'Der Gesamtpreis liegt bei 403.410 € brutto.'
  d[I.letter].paragraphs[1] = 'Vergleichbare Wohnungen kosten 585.000 € netto.'
  d[I.feature].text = 'Erwartet wird eine Mietrendite von 6 % im Jahr.'
  const g = runDeckGate(d, c2b).findings
  const wl = ['preis_im_fliesstext', 'renditeaussage', 'flaeche_abweichung', 'zimmer_abweichung', 'bad_abweichung', 'etage_abweichung', 'betrag_fremd']
  ok('T22 alle Whitelist-Befunde des Gates vorhanden', wl.every(k => g.some(f => f.key === k)), keys(g))
  ok('T22 jeder Whitelist-Befund trägt loc.match (und field)', g.filter(f => wl.includes(f.key)).every(f => f.loc?.match && f.loc?.field), JSON.stringify(g.filter(f => wl.includes(f.key)).map(f => f.loc)))
  const cf = claimIssuesToFindings([{ block_index: 1, claim: 'Direkt am Meer', severity: 'high', status: 'conflict', reason: 'x' }])[0]
  ok('T22 claimIssuesToFindings setzt claim und loc', cf.claim === 'Direkt am Meer' && cf.loc?.match === 'Direkt am Meer' && cf.key === 'behauptung_conflict' && cf.severity === 'hoch')
}

// ── Fehler im Bereiniger reisst nichts ab ───────────────────────────────────
{
  const d = deck()
  const r = autofixDeck(d, { gate: [], claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')], other: [] }, null, 'on')
  ok('Fehler (kein Kontext) → status error, Eingabe zurück', r.report.status === 'error' && r.blocks === d && r.applied === 0 && r.findings.length === 1 && !!r.report.error, r.report.error)
  const d2 = deck(); d2[I.letter].fn = () => 1
  const r2 = autofixDeck(d2, { gate: [], claims: [], other: [] }, ctx(), 'on')
  ok('Fehler (nicht klonbar) → status error, Eingabe zurück', r2.report.status === 'error' && r2.blocks === d2)
}

// ── Gesperrte Blöcke und deterministische Felder über einen großen Lauf ─────
{
  const d = deck()
  d[I.cover].tagline = 'Wohnen mit eigenem Bootssteg in Paphos'
  d[I.letter].paragraphs[1] = 'Emerald Park liegt in einem ruhigen Wohngebiet von Paphos. Vergleichbare Wohnungen kosten 585.000 € netto. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.'
  d[I.unit].specs[2] = '3 Schlafzimmer'
  d[I.unit].note = 'Die Einrichtung ist als Paket optional erhältlich. Der Gesamtpreis liegt bei 403.410 € brutto.'
  d[I.feature].text = 'Paphos hat auch im Winter Gäste. Erwartet wird eine Mietrendite von 6 % im Jahr. Die Nachfrage ist das ganze Jahr über da.'
  d[I.amenity].intro = 'Die Anlage liegt direkt am Meer.'
  d[I.gallery].headline = 'Direkt am Meer'
  const inp = clone(d)
  const r = run(d, { claims: [claim(I.cover, 'mit eigenem Bootssteg'), claim(I.amenity, 'Die Anlage liegt direkt am Meer')] })
  ok('Großer Lauf: applied, Tagline + specs bereinigt, Fließtext (Anschreiben, Notiz, feature) bleibt, Systemblock bleibt', r.report.status === 'applied' && r.report.changes.length === 2
    && r.report.changes.some(c => c.action === 'feld_geleert' && c.block === I.cover) && r.report.changes.some(c => c.action === 'wert_gesetzt' && c.block === I.unit)
    && ['letter', 'unit', 'feature'].every(k => r.report.skipped.some(s => s.block === I[k] && s.reason === 'fliesstext'))
    && r.blocks[I.letter].paragraphs[1] === inp[I.letter].paragraphs[1] && r.blocks[I.unit].note === inp[I.unit].note && r.blocks[I.feature].text === inp[I.feature].text
    && r.report.after.red === 3 && r.findings.filter(f => f.severity === 'hoch' || f.severity === 'kritisch').every(f => [I.amenity, I.letter, I.feature].includes(f.block))
    && r.report.skipped.some(s => s.block === I.amenity && s.reason === 'systemblock'),
    `${r.report.status} ${r.report.changes.length} ${keys(r.findings)} ${JSON.stringify(r.report.skipped)}`)
  ok('Großer Lauf: payment, marina, video, amenity, gallery byte-gleich', lockedByteGleich(inp, r.blocks))
  ok('Großer Lauf: deterministische Felder aller Blöcke unverändert', detGleich(inp, r.blocks))
  ok('Großer Lauf: Blockzahl und -folge gleich', r.blocks.length === inp.length && r.blocks.every((b, i) => b.type === inp[i].type))
  ok('Großer Lauf: Bericht before.findings = Eingabe-Befunde', r.report.before.findings.length === runDeckGate(inp, ctx()).findings.length + 2)
}

// ── T23: Fundstellen nur an Wort- und Zahlgrenzen (Prüfbefund 12.10.26) ─────
{
  // „6 m²" (Abstellraum) darf die korrekte „16 m² Terrasse" nicht mitstreichen
  const d = deck()
  d[I.unit].specs = ['84,5 m² Innenfläche', '16 m² Terrasse', '6 m² Abstellraum', '2 Schlafzimmer', '1 Badezimmer', '1. Obergeschoss']
  const g = runDeckGate(d, ctx()).findings
  ok('T23 Gate: flaeche_abweichung „6 m²" in specs[2]', g.some(f => f.key === 'flaeche_abweichung' && f.loc?.match === '6 m²' && f.loc?.field === 'specs[2]'), JSON.stringify(g.map(f => f.loc)))
  const r = run(d)
  ok('T23 nur „6 m² Abstellraum" gestrichen, „16 m² Terrasse" bleibt', r.report.status === 'applied'
    && JSON.stringify(r.blocks[I.unit].specs) === JSON.stringify(['84,5 m² Innenfläche', '16 m² Terrasse', '2 Schlafzimmer', '1 Badezimmer', '1. Obergeschoss']), JSON.stringify(r.blocks[I.unit].specs))
  // „9.000 €" darf den korrekten Möbelpreis „19.000 €" nicht mitstreichen - weder im Nachbarabsatz noch im selben Absatz
  const d2 = deck()
  d2[I.letter].paragraphs[1] = 'Emerald Park liegt in einem ruhigen Wohngebiet von Paphos. Die Anschlussgebühren zahlst du einmalig mit 9.000 €. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.'
  d2[I.letter].paragraphs[2] = 'Das Möbelpaket kostet 19.000 € netto. Ich rechne dir die Zahlen gern persönlich durch, damit du eine klare Grundlage hast.'
  const r2 = run(d2)
  ok('T23 „9.000 €" im Fließtext → fliesstext, „19.000 €"-Absatz unberührt', bleibt(r2, d2, I.letter, 'betrag_fremd')
    && r2.report.skipped.filter(x => x.key === 'betrag_fremd').length === 1, wieso(r2))
  // Absatz nur aus dem 9.000-€-Satz: ganze Absätze fallen nie weg (Runde 5), beide Absätze bleiben
  const d2b = deck()
  // (Absatz mit „19.000 €" davor: „Das Möbelpaket ..." direkt danach wäre ein Verweis → kontext)
  d2b[I.letter].paragraphs = [d2b[I.letter].paragraphs[0], d2[I.letter].paragraphs[2], 'Die Anschlussgebühren zahlst du einmalig mit 9.000 €.', d2b[I.letter].paragraphs[2]]
  const r2b = run(d2b)
  ok('T23 Absatz nur mit „9.000 €" bleibt (fliesstext), „19.000 €" kein Befund', bleibt(r2b, d2b, I.letter, 'betrag_fremd')
    && r2b.report.skipped.filter(x => x.key === 'betrag_fremd').length === 1, `${JSON.stringify(r2b.blocks[I.letter].paragraphs)} ${wieso(r2b)}`)
  const d3 = deck()
  d3[I.letter].paragraphs[1] = 'Dein Einrichtungspaket für 19.000 € ist optional. Als Frühbucher sparst du 9.000 €. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.'
  const r3 = run(d3)
  ok('T23 im selben Absatz: Fließtext bleibt (fliesstext), „19.000 €" kein Befund', bleibt(r3, d3, I.letter, 'betrag_fremd')
    && !r3.findings.some(f => f.key === 'betrag_fremd' && /19\.000/.test(f.what)), wieso(r3))
  // Behauptungen: „ein Pool" trifft nicht „kein Poolhaus", „5 Minuten" nicht „15 Minuten"
  const d4 = deck()
  d4[I.feature].text = 'Die Anlage hat kein Poolhaus, aber einen Garten. Im Innenhof liegt ein Pool für alle Bewohner. Die Nachfrage ist das ganze Jahr über da.'
  const r4 = run(d4, { claims: [claim(I.feature, 'ein Pool')] })
  // Träfe „ein Pool" auch „kein Poolhaus", wäre es mehrdeutig - fliesstext heißt: genau eine Fundstelle.
  ok('T23 Behauptung „ein Pool": genau eine Fundstelle (fliesstext, nicht mehrdeutig), Text bleibt', bleibt(r4, d4, I.feature, 'behauptung_unsupported'), wieso(r4))
  const d5 = deck()
  d5[I.feature].text = 'Zum Strand sind es 15 Minuten zu Fuß. Paphos hat auch im Winter Gäste. Die Nachfrage ist das ganze Jahr über da.'
  const r5 = run(d5, { claims: [claim(I.feature, '5 Minuten zu Fuß')] })
  ok('T23 Behauptung „5 Minuten zu Fuß" trifft nicht „15 Minuten zu Fuß"', r5.report.skipped[0]?.reason === 'nicht_lokalisierbar' && stableEqual(r5.blocks, d5), JSON.stringify(r5.report.skipped))
}

// ── T24: Gate-Befund nur im gemeldeten Feld, Doppelte nur wo das Gate sie nennt ─
{
  // „3. Etage" im Listenpunkt ist falsch; „Stellplatz in der 3. Etage der Tiefgarage" meldet
  // das Gate bewusst nicht - die Notiz bleibt.
  const d = deck()
  d[I.unit].specs[4] = '3. Etage'
  d[I.unit].note = 'Dein Stellplatz liegt in der 3. Etage der Tiefgarage. Die Übergabe erfolgt schlüsselfertig.'
  const r = run(d)
  ok('T24 specs „3. Etage" korrigiert, Notiz mit Tiefgarage unverändert', r.report.status === 'applied' && r.blocks[I.unit].specs[4] === '1. Etage'
    && r.blocks[I.unit].note === d[I.unit].note, `${r.blocks[I.unit].specs[4]} | ${r.blocks[I.unit].note}`)
  // Derselbe falsche Wert in zwei Feldern eines Blocks: beide bereinigt (das Gate nennt beide)
  const d2 = deck()
  d2[I.unit].specs[2] = '3 Schlafzimmer'
  d2[I.unit].note = 'Die 3 Schlafzimmer liegen zur Sonnenseite. Die Übergabe erfolgt schlüsselfertig.'
  const r2 = run(d2)
  // Notiz mit zwei Sätzen: der Befund ist nicht ganz behebbar → nichts angefasst (auch specs nicht), bleibt für Sven
  ok('T24 doppelter Wert, Notiz ist Fließtext → fliesstext, Block byte-gleich, Befund bleibt', bleibt(r2, d2, I.unit, 'zimmer_abweichung'), wieso(r2))
  const d2b = deck()
  d2b[I.unit].specs[2] = '3 Schlafzimmer'
  d2b[I.unit].note = 'Die 3 Schlafzimmer liegen zur Sonnenseite.'
  const r2b = run(d2b)
  ok('T24 doppelter Wert, Notiz nur ein Satz: specs gesetzt und Notiz entfernt', r2b.report.status === 'applied' && r2b.blocks[I.unit].specs[2] === '2 Schlafzimmer'
    && r2b.blocks[I.unit].note === undefined && !r2b.findings.some(f => f.key === 'zimmer_abweichung'),
    `${JSON.stringify(r2b.blocks[I.unit].specs)} | ${r2b.blocks[I.unit].note} | ${JSON.stringify(r2b.report.skipped)}`)
}

// ── T25: Behauptung, die noch in einem anderen Block steht → kein falsches Grün ─
{
  // ohne block_index: Treffer im amenity-Systemblock → systemblock, nichts geändert
  const d = deck()
  d[I.amenity].intro = 'Die Anlage liegt direkt am Meer und bietet Pool, Gym und Café.'
  d[I.feature].text = 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Die Nachfrage ist das ganze Jahr über da.'
  const c1 = claimIssuesToFindings([{ claim: 'Die Anlage liegt direkt am Meer', severity: 'high', status: 'unsupported', reason: 'x' }])[0]
  const r = run(d, { claims: [c1] })
  ok('T25 ohne block_index, Treffer auch im Systemblock → systemblock, Deck unverändert, bleibt rot', r.report.skipped[0]?.reason === 'systemblock'
    && r.report.skipped[0]?.block === I.amenity && stableEqual(r.blocks, d) && r.report.after.status === 'red' && r.findings.includes(c1), JSON.stringify(r.report.skipped))
  // mit block_index: dieselbe Aussage auch in den Key Facts → ziel_nicht_behoben, nichts geändert
  const d2 = deck()
  d2[I.letter].paragraphs[1] = 'Emerald Park liegt in einem ruhigen Wohngebiet von Paphos. Inklusive Photovoltaik-Anlage auf dem Dach. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.'
  d2[I.benefits].cards[2] = { icon: '☀️', title: 'Solar', text: 'Inklusive Photovoltaik-Anlage auf dem Dach.' }
  const c2 = claim(I.benefits, 'Inklusive Photovoltaik-Anlage auf dem Dach')
  const r2 = run(d2, { claims: [c2] })
  ok('T25 mit block_index, Aussage auch in anderem Block → ziel_nicht_behoben, Deck unverändert, bleibt rot', r2.report.skipped[0]?.reason === 'ziel_nicht_behoben'
    && stableEqual(r2.blocks, d2) && r2.report.after.status === 'red' && r2.findings.includes(c2), `${r2.report.status} ${JSON.stringify(r2.report.skipped)}`)
}

// ── T26: Ersatzvorlagen an den Grenzen ──────────────────────────────────────
{
  const v = [
    ersatzWert('zimmer_abweichung', '2-bedroom', 3), ersatzWert('zimmer_abweichung', '2-Schlafzimmer', 3), ersatzWert('bad_abweichung', '2-bathroom', 1),
    ersatzWert('zimmer_abweichung', '1 Schlafzimmer', 0), ersatzWert('bad_abweichung', '2 Bäder', 0), ersatzWert('etage_abweichung', '3. Etage', -1),
    ersatzWert('etage_abweichung', '1st floor', -1), ersatzWert('bad_abweichung', '2 Bäder', 1.5),
  ]
  ok('T26 Bindestrich bleibt, Grenzwerte (0 Zimmer, 0 Bäder, Untergeschoss, halbe Werte) → null', JSON.stringify(v) === JSON.stringify(['3-bedroom', '3-Schlafzimmer', '1-bathroom', null, null, null, null, null]), JSON.stringify(v))
  const pl = [ersatzWert('bad_abweichung', '2-Bäder', 1), ersatzWert('zimmer_abweichung', '2-bedrooms', 1), ersatzWert('bad_abweichung', '2-bathrooms', 1),
    ersatzWert('bad_abweichung', '2-Badezimmer', 1)]
  ok('T26 Bindestrich mit Plural („2-Bäder", „2-bedrooms") → null, „2-Badezimmer" bleibt Vorlage', JSON.stringify(pl) === JSON.stringify([null, null, null, '1-Badezimmer']), JSON.stringify(pl))
  const d = deck(); d[I.unit].specs[3] = '2-Bäder'
  const r = run(d)
  ok('T26 specs „2-Bäder" bei CRM 1 → Punkt gestrichen, kein „1-Bäder"', r.report.status === 'applied' && !JSON.stringify(r.blocks[I.unit].specs).includes('Bäder')
    && r.report.changes[0]?.action === 'punkt_entfernt', JSON.stringify(r.blocks[I.unit].specs))
}

// ── T27: Gate-Befund nach Indexverschiebung (Prüfbefund 12.10.26) ───────────
{
  // Absatz 0 fällt weg; der Etage-Befund nannte paragraphs[2]. Danach steht dort der
  // Tiefgaragen-Absatz, den das Gate bewusst nicht meldet - er muss bleiben.
  // (Endprüfung 12.10.26: Absatz 0 ist die Anrede und bleibt immer; „Sie ist ..." wäre ein Verweis.)
  const d = deck()
  d[I.letter].paragraphs = [
    'Hallo Max, schön, dass wir gesprochen haben.',
    'Die Wohnung hat 3 Schlafzimmer.',
    'Ich rechne dir die Zahlen gern persönlich durch. Das dauert nicht lange.',
    'Die Wohnung liegt in der 3. Etage. Alle Räume sind hell und ruhig.',
    'Dein Stellplatz liegt in der 3. Etage der Tiefgarage, direkt am Aufzug. Supermarkt und Cafés sind nah.',
    'Bis bald und viele Grüße aus Paphos, schreib mir gern jederzeit.',
  ]
  const r = run(d)
  const p = r.blocks[I.letter].paragraphs
  const dp = d[I.letter].paragraphs
  // Seit Runde 5 fällt auch der Ein-Satz-Absatz nicht mehr weg: Brief byte-gleich, beide
  // Befunde bleiben (fliesstext), der Tiefgaragen-Absatz wird nie angefasst.
  ok('T27 letter: kein Absatz weg, Brief byte-gleich', r.report.status === 'nothing_to_fix'
    && JSON.stringify(p) === JSON.stringify(dp), JSON.stringify(p))
  ok('T27 Bericht: keine Änderung, Zimmer- und Etage-Befund bleiben (fliesstext)', r.report.changes.length === 0
    && ['zimmer_abweichung', 'etage_abweichung'].every(k => r.report.skipped.some(x => x.key === k && x.reason === 'fliesstext') && r.findings.some(f => f.key === k)),
    `${JSON.stringify(r.report.changes.map(c => c.field))} ${wieso(r)}`)
  // specs: der Stellplatz-Punkt rückt auf den Platz des Etage-Punkts
  const d2 = deck()
  d2[I.unit].specs = ['3 Schlafzimmer mit Meerblick', '3. Etage', 'Stellplatz in der 3. Etage der Tiefgarage', '84,5 m² Innenfläche', '1 Badezimmer']
  const r2 = run(d2)
  ok('T27 specs: Stellplatz-Punkt bleibt, Etage gesetzt', r2.report.status === 'applied'
    && JSON.stringify(r2.blocks[I.unit].specs) === JSON.stringify(['1. Etage', 'Stellplatz in der 3. Etage der Tiefgarage', '84,5 m² Innenfläche', '1 Badezimmer']), JSON.stringify(r2.blocks[I.unit].specs))
  // Fläche: der Gemeinschaftsgarten mit derselben Zahl bleibt
  const d3 = deck()
  d3[I.unit].specs = ['3 Schlafzimmer mit Meerblick', '92 m² Wohnfläche', '16 m² Terrasse', '92 m² Gemeinschaftsgarten der Anlage', '1 Badezimmer']
  const r3 = run(d3)
  ok('T27 specs: Gemeinschaftsgarten mit gleicher Zahl bleibt', r3.report.status === 'applied'
    && JSON.stringify(r3.blocks[I.unit].specs) === JSON.stringify(['16 m² Terrasse', '92 m² Gemeinschaftsgarten der Anlage', '1 Badezimmer']), JSON.stringify(r3.blocks[I.unit].specs))
}

// ── T28: bullets {strong, text} - Wertersatz nur beim ganzen Punkt ──────────
{
  const c2 = ctx({ units: [{ ...unit, bathrooms: 2 }] })
  const d = deck()
  d[I.unit].specs[3] = '2 Badezimmer'
  d[I.floorplan].bullets = [{ strong: '1 Badezimmer', text: 'en suite am Hauptschlafzimmer' }, { strong: 'Offene Küche', text: 'mit Essplatz und Blick auf die Terrasse' }]
  const r = run(d, { c: c2 })
  ok('T28 „1 Badezimmer" + „en suite": Punkt gestrichen, kein „2 Badezimmer en suite"', r.report.status === 'applied'
    && JSON.stringify(r.blocks[I.floorplan].bullets) === JSON.stringify([d[I.floorplan].bullets[1]])
    && r.report.changes.some(c => c.finding_key === 'bad_abweichung' && c.action === 'punkt_entfernt'), JSON.stringify(r.blocks[I.floorplan].bullets))
  const d2 = deck()
  d2[I.unit].specs[3] = '2 Badezimmer'
  d2[I.floorplan].bullets = [{ strong: '1 Badezimmer', text: '' }, { strong: 'Offene Küche', text: 'mit Essplatz und Blick auf die Terrasse' }]
  const r2 = run(d2, { c: c2 })
  ok('T28 „1 Badezimmer" ohne Text: Wert gesetzt', r2.report.status === 'applied' && r2.blocks[I.floorplan].bullets[0].strong === '2 Badezimmer'
    && r2.blocks[I.floorplan].bullets[0].text === '' && r2.report.changes.some(c => c.action === 'wert_gesetzt'), JSON.stringify(r2.blocks[I.floorplan].bullets))
}

// ── T29: Maß- und Mengenkürzel am Satzende ──────────────────────────────────
{
  const s = (t) => splitSaetze(t).map(x => x.text.trim())
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  ok('T29 „5 Min. Die ..." trennt', eq(s('Zum Strand sind es nur 5 Min. Die Anlage liegt ruhig.'), ['Zum Strand sind es nur 5 Min.', 'Die Anlage liegt ruhig.']))
  ok('T29 „12 Mio. Der ..." trennt', eq(s('Das Projekt kostet 12 Mio. Der Bau beginnt bald.'), ['Das Projekt kostet 12 Mio.', 'Der Bau beginnt bald.']))
  ok('T29 „approx. 5 min. The ..." trennt', eq(s('The beach is approx. 5 min. The pool is heated.'), ['The beach is approx. 5 min.', 'The pool is heated.']))
  ok('T29 „2 Std. Fahrt" trennt weiter nicht', eq(s('Es sind 2 Std. Fahrt bis Limassol. Ende.'), ['Es sind 2 Std. Fahrt bis Limassol.', 'Ende.']))
  ok('T29 „5 Min. Fußweg" trennt nicht', eq(s('Es sind 5 Min. Fußweg zum Strand. Ende.'), ['Es sind 5 Min. Fußweg zum Strand.', 'Ende.']))
  ok('T29 „max. 4 Personen" trennt nicht', eq(s('Platz für max. 4 Personen. Ende.'), ['Platz für max. 4 Personen.', 'Ende.']))
  const d = deck()
  d[I.feature].text = 'Paphos hat auch im Winter Gäste. Zum Strand sind es ca. 5 Min. Die Anlage hat eine Photovoltaikanlage. Die Nachfrage ist das ganze Jahr über da.'
  const r = run(d, { claims: [claim(I.feature, 'Die Anlage hat eine Photovoltaikanlage')] })
  ok('T29 im Deck: Text bleibt ganz (fliesstext), Strand-Satz unberührt', bleibt(r, d, I.feature, 'behauptung_unsupported'), wieso(r))
  // Prüfbefund 12.10.26: kein Halbsatz nach „lt." / „rd." im Kundentext
  const d2 = deck()
  d2[I.letter].paragraphs[2] = 'Die Wohnung C-105 hat lt. Plan 3 Schlafzimmer und eine Terrasse. Ich rechne dir die Zahlen gern persönlich durch, damit du eine klare Grundlage hast.'
  const r2 = run(d2)
  ok('T29 „lt. Plan 3 Schlafzimmer": Absatz bleibt ganz (fliesstext), kein „hat lt."', bleibt(r2, d2, I.letter, 'zimmer_abweichung'), wieso(r2))
  const d3 = deck()
  d3[I.columns].cols[2].text = 'Im Norden von Paphos entstehen neue Schulen und Geschäfte. Grundstücke kosten dort heute rd. 150.000 € mehr als vor fünf Jahren. Die Gegend wächst seit Jahren stetig.'
  const r3 = run(d3)
  ok('T29 „rd. 150.000 €": Spalte bleibt ganz (fliesstext), kein „heute rd."', bleibt(r3, d3, I.columns, 'betrag_fremd'), wieso(r3))
  // Unbekanntes Kürzel ohne Vokal an der Schnittstelle: lieber nicht bereinigen
  const d4 = deck()
  d4[I.letter].paragraphs[2] = 'Mehr dazu im Exposé auf Seite 4 ff. Die Wohnung C-105 hat 3 Schlafzimmer und eine Terrasse. Ich rechne dir die Zahlen gern persönlich durch, damit du eine klare Grundlage hast.'
  const r4 = run(d4)
  ok('T29 „ff." an der Satzgrenze → nicht_lokalisierbar, Absatz unverändert', r4.report.skipped.some(x => x.key === 'zimmer_abweichung' && x.reason === 'nicht_lokalisierbar')
    && r4.blocks[I.letter].paragraphs[2] === d4[I.letter].paragraphs[2], JSON.stringify(r4.report.skipped))
  // Renditesatz auf „p. a.": der wahre Folgesatz bleibt
  const d5 = deck()
  d5[I.feature].text = 'Paphos hat auch im Winter Gäste. Die Nachfrage wächst mit jedem neuen Arbeitgeber in der Region. Vergleichbare Wohnungen bringen 5 % p. a. Die genauen Zahlen rechnet Sven dir persönlich durch.'
  const r5 = run(d5)
  // Endprüfung 12.10.26: „a." ist ein kurzes Token, die Grenze gilt als unsicher - Befund bleibt rot für Sven.
  ok('T29 „5 % p. a. Die ...": Grenze unsicher → nicht_lokalisierbar, Text unverändert', r5.report.skipped.some(x => x.key === 'renditeaussage' && x.reason === 'nicht_lokalisierbar')
    && r5.blocks[I.feature].text === d5[I.feature].text, `${r5.blocks[I.feature].text} ${JSON.stringify(r5.report.skipped)}`)
  // Anrede mit Vornamen bleibt
  const d6 = deck()
  d6[I.letter].paragraphs[1] = 'Lieber Max. Die Anlage liegt direkt am Meer. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.'
  const r6 = run(d6, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  // Endprüfung 12.10.26: „Max." ist ein kurzes Token (unsichere Grenze) - lieber nicht bereinigen.
  ok('T29 „Lieber Max. Die Anlage ...": Anrede bleibt, Absatz unverändert (nicht_lokalisierbar)', r6.report.skipped.some(x => x.reason === 'nicht_lokalisierbar')
    && r6.blocks[I.letter].paragraphs[1] === d6[I.letter].paragraphs[1], `${r6.blocks[I.letter].paragraphs[1]} ${JSON.stringify(r6.report.skipped)}`)
}

// ── T30: zwei Preise in einem Feld ──────────────────────────────────────────
{
  const d = deck()
  d[I.unit].note = 'Netto kostet sie 339.000 €. Brutto sind es 403.410 €. Die Übergabe erfolgt schlüsselfertig.'
  const r = run(d)
  ok('T30 zwei Preise im Fließtext → fliesstext, Notiz byte-gleich, beide Befunde bleiben', r.report.status === 'nothing_to_fix' && bleibt(r, d, I.unit, 'preis_im_fliesstext')
    && r.findings.filter(f => f.key === 'preis_im_fliesstext').length >= 1, `${r.report.status} ${r.blocks[I.unit].note} ${JSON.stringify(r.report.skipped)}`)
  // Ein Satz mit beiden Preisen: die Notiz fällt ganz weg, der zweite Befund ist mit erledigt
  const d2 = deck()
  d2[I.unit].note = 'Netto kostet sie 339.000 €, brutto sind es 403.410 €.'
  const r2 = run(d2)
  ok('T30 ein Satz mit zwei Preisen → Notiz entfernt, beide Befunde weg', r2.report.status === 'applied' && r2.blocks[I.unit].note === undefined
    && r2.report.changes.length === 1 && r2.report.changes[0].field === 'note' && !r2.findings.some(f => f.key === 'preis_im_fliesstext'),
    `${r2.report.status} ${JSON.stringify(r2.report.changes)} ${JSON.stringify(r2.report.skipped)}`)
}

// ── T31: kurze Aussagen nur bei genau einer Fundstelle ──────────────────────
{
  const d = deck()
  d[I.feature].text = 'Paphos hat auch im Winter Gäste. Langzeitmieter suchen moderne Wohnungen mit Pool. Die Wohnungen mit Pool sind gefragt. Die Nachfrage ist das ganze Jahr über da.'
  const r = run(d, { claims: [claim(I.feature, 'mit Pool')] })
  ok('T31 „mit Pool" zweimal im Block → mehrdeutig, nichts gestrichen', r.report.skipped[0]?.reason === 'mehrdeutig' && stableEqual(r.blocks, d), JSON.stringify(r.report.skipped))
  const d2 = deck()
  d2[I.feature].text = 'Paphos hat auch im Winter Gäste. Langzeitmieter suchen moderne Wohnungen mit Pool. Die Nachfrage ist das ganze Jahr über da.'
  const r2 = run(d2, { claims: [claim(I.feature, 'mit Pool')] })
  ok('T31 „mit Pool" einmal → eindeutig, aber Fließtext (fliesstext)', bleibt(r2, d2, I.feature, 'behauptung_unsupported'), wieso(r2))
}

// ── T32: Anschreiben schrumpft nie auf die Begrüßung ────────────────────────
{
  const d = deck()
  d[I.letter].paragraphs = [d[I.letter].paragraphs[0], 'Die Anlage hat eine Photovoltaikanlage auf dem Dach.', 'Zum Haus gehört ein privater Bootssteg am Meer.']
  const r = run(d, { claims: [claim(I.letter, 'Die Anlage hat eine Photovoltaikanlage auf dem Dach'), claim(I.letter, 'Zum Haus gehört ein privater Bootssteg am Meer')] })
  const p = r.blocks[I.letter].paragraphs
  // Seit Runde 5 fällt nie ein ganzer Absatz weg: der Brief bleibt, beide Befunde für Sven.
  ok('T32 drei Absätze: nichts weg, der Brief bleibt', r.report.status === 'nothing_to_fix'
    && stableEqual(p, d[I.letter].paragraphs)
    && r.report.skipped.filter(s => ['pflichtfeld', 'fliesstext'].includes(s.reason)).length === 2, `${JSON.stringify(p)} ${JSON.stringify(r.report.skipped)}`)
  const d4 = deck()
  d4[I.letter].paragraphs = [d4[I.letter].paragraphs[0], 'Die Anlage hat eine Photovoltaikanlage auf dem Dach.', d4[I.letter].paragraphs[1], 'Zum Haus gehört ein privater Bootssteg am Meer.']
  const r4 = run(d4, { claims: [claim(I.letter, 'Die Anlage hat eine Photovoltaikanlage auf dem Dach'), claim(I.letter, 'Zum Haus gehört ein privater Bootssteg am Meer')] })
  ok('T32 vier Absätze: keiner weg, Brief byte-gleich', r4.report.status === 'nothing_to_fix'
    && stableEqual(r4.blocks[I.letter].paragraphs, d4[I.letter].paragraphs) && r4.report.skipped.length === 2, `${JSON.stringify(r4.blocks[I.letter].paragraphs)} ${wieso(r4)}`)
  const d2 = deck()
  d2[I.letter].paragraphs = [d2[I.letter].paragraphs[0], 'Zum Haus gehört ein privater Bootssteg am Meer.']
  const r2 = run(d2, { claims: [claim(I.letter, 'Zum Haus gehört ein privater Bootssteg am Meer')] })
  ok('T32 zwei Absätze, Behauptung im letzten → Brief unverändert', ['pflichtfeld', 'fliesstext'].includes(r2.report.skipped[0]?.reason) && stableEqual(r2.blocks, d2), JSON.stringify(r2.report.skipped))
}

// ── T33: Bericht schlank - before.findings nur bei applied ──────────────────
{
  const d = deck()
  d[I.unit].note = 'Der Gesamtpreis liegt bei 403.410 € brutto.'
  const rd = run(d, { mode: 'dry_run' })
  const rn = run(deck())
  const ra = run(d)
  ok('T33 Probelauf und nothing_to_fix ohne before.findings, applied mit', rd.report.status === 'dry_run' && rd.report.before.findings === undefined
    && rn.report.before.findings === undefined && Array.isArray(ra.report.before.findings) && ra.report.before.findings.length > 0, `${rd.report.status} ${ra.report.status}`)
}

// ── T34: Gate-Befund nur an der gemeldeten Stelle im Feld (Prüfbefund 12.10.26) ─
{
  const d = deck()
  d[I.letter].paragraphs[1] = 'Deine Wohnung liegt im Erdgeschoss und hat einen eigenen Garten, ideal für die Abende. Die Anlage hat viel Grün und einen großen Pool für alle Bewohner. Im Erdgeschoss liegt außerdem die Tiefgarage der Anlage.'
  const g = runDeckGate(d, ctx()).findings.filter(f => f.key === 'etage_abweichung')
  ok('T34 Gate: nur das erste „Erdgeschoss" gemeldet, mit Position', g.length === 1 && g[0].loc?.index === d[I.letter].paragraphs[1].indexOf('Erdgeschoss'), JSON.stringify(g.map(f => f.loc)))
  const r = run(d)
  ok('T34 Absatz mit Tiefgaragen-Satz bleibt ganz (fliesstext)', bleibt(r, d, I.letter, 'etage_abweichung'), wieso(r))
  // Zwei echte Vorkommen im selben Feld: beide weg (das Gate meldet das zweite nach der Korrektur neu)
  const d2 = deck()
  d2[I.unit].note = 'Die Wohnung hat 3 Schlafzimmer. Die Übergabe erfolgt schlüsselfertig. Alle 3 Schlafzimmer haben Einbauschränke.'
  const r2 = run(d2)
  ok('T34 zwei echte Vorkommen im Fließtext: Notiz bleibt (fliesstext), Befund bleibt', bleibt(r2, d2, I.unit, 'zimmer_abweichung'), wieso(r2))
  // Ein Satz mit beiden Vorkommen: ganze Notiz weg, auch das zweite Vorkommen ist erledigt
  const d3 = deck()
  d3[I.unit].note = 'Die Wohnung hat 3 Schlafzimmer, alle 3 Schlafzimmer haben Einbauschränke.'
  const r3 = run(d3)
  ok('T34 ein Satz mit zwei Vorkommen → Notiz entfernt, Befund weg', r3.report.status === 'applied' && r3.blocks[I.unit].note === undefined
    && !r3.findings.some(f => f.key === 'zimmer_abweichung'), `${r3.blocks[I.unit].note} ${wieso(r3)}`)
}

// ── T35: derselbe Zählwert in anderem Wortlaut (Prüfbefund 12.10.26) ────────
{
  const d = deck()
  d[I.unit].specs[2] = '3 Schlafzimmer'
  d[I.unit].note = 'Die Wohnung hat drei Schlafzimmer. Die Übergabe erfolgt schlüsselfertig.'
  const r = run(d)
  // Notiz ist Fließtext: derselbe Befund wäre nur halb behebbar → ganz stehen lassen (auch specs)
  ok('T35 „drei Schlafzimmer" im Fließtext: Block byte-gleich (fliesstext), Befund bleibt', bleibt(r, d, I.unit, 'zimmer_abweichung')
    && !r.report.skipped.some(x => x.reason === 'neuer_befund'), wieso(r))
  const e = deck()
  e[I.unit].specs[2] = '3 Schlafzimmer'
  e[I.unit].note = 'Die Wohnung hat drei Schlafzimmer.'
  const re = run(e)
  ok('T35 „3 Schlafzimmer" und Notiz nur „drei Schlafzimmer": beide bereinigt, kein neuer_befund', re.report.status === 'applied'
    && re.blocks[I.unit].specs[2] === '2 Schlafzimmer' && re.blocks[I.unit].note === undefined
    && !re.report.skipped.length && !re.findings.some(f => f.key === 'zimmer_abweichung'), `${JSON.stringify(re.blocks[I.unit])} ${JSON.stringify(re.report.skipped)}`)
  // Anderer Wert bleibt ein eigener Befund: „4 Schlafzimmer" wird nicht über den 3er-Befund mitgenommen
  const d2 = deck()
  d2[I.unit].specs[2] = '3 Schlafzimmer'
  d2[I.unit].note = 'Die Wohnung hat 4 Schlafzimmer. Die Übergabe erfolgt schlüsselfertig.'
  const r2 = run(d2)
  ok('T35 anderer Wert: eigener Befund, specs bereinigt, Fließtext-Notiz bleibt (fliesstext)', r2.report.status === 'applied' && r2.blocks[I.unit].specs[2] === '2 Schlafzimmer'
    && r2.blocks[I.unit].note === d2[I.unit].note && r2.report.fixed_findings.filter(x => x.key === 'zimmer_abweichung').length === 1
    && r2.report.skipped.some(x => x.key === 'zimmer_abweichung' && x.reason === 'fliesstext'), `${JSON.stringify(r2.report.fixed_findings)} ${wieso(r2)}`)
  const e2 = deck()
  e2[I.unit].specs[2] = '3 Schlafzimmer'
  e2[I.unit].note = 'Die Wohnung hat 4 Schlafzimmer.'
  const re2 = run(e2)
  ok('T35 anderer Wert, Notiz nur ein Satz: beide Befunde bereinigt', re2.report.status === 'applied' && re2.blocks[I.unit].specs[2] === '2 Schlafzimmer'
    && re2.blocks[I.unit].note === undefined && re2.report.fixed_findings.filter(x => x.key === 'zimmer_abweichung').length === 2, JSON.stringify(re2.report.fixed_findings))
}

// ── T36: Bericht nennt Original-Indizes für Karten und Listenpunkte ──────────
{
  const d = deck(); const cs = []
  for (const i of [0, 1, 2]) {
    d[I.benefits].cards[i].text = `Besonderheit ${i} mit Solaranlage auf dem Dach.`
    cs.push(claim(I.benefits, `Besonderheit ${i} mit Solaranlage auf dem Dach`))
  }
  const r = run(d, { claims: cs })
  ok('T36 drei Karten entfernt → cards[0], cards[1], cards[2]', r.report.status === 'applied' && r.blocks[I.benefits].cards.length === 3
    && JSON.stringify(r.report.changes.map(c => c.field)) === JSON.stringify(['cards[0]', 'cards[1]', 'cards[2]']), JSON.stringify(r.report.changes.map(c => c.field)))
  const d2 = deck()
  d2[I.unit].specs = ['6 m² Abstellraum', '84,5 m² Innenfläche', '3 Schlafzimmer', '1 Badezimmer']
  const r2 = run(d2)
  const f2 = Object.fromEntries(r2.report.changes.map(c => [c.finding_key, c.field]))
  ok('T36 specs: Punkt 0 entfernt, Wert in Punkt 2 → Bericht nennt specs[2]', r2.report.status === 'applied'
    && f2.flaeche_abweichung === 'specs[0]' && f2.zimmer_abweichung === 'specs[2]', JSON.stringify(r2.report.changes.map(c => [c.finding_key, c.field])))
}

// ── T37: Rücknahme im Deck-Chat (refine-deck) ───────────────────────────────
{
  const vorherF = [{ key: 'zimmer_abweichung', severity: 'hoch', what: 'x' }]
  const basis = () => ({ prev_content: { blocks: [{ type: 'cover' }] }, revision: 0, refining: false, quality_status: 'green',
    quality_report: { status: 'green', findings: [], autofix: { status: 'applied', before: { status: 'red', red: 1, findings: vorherF } } } })
  const u = undoNachAutofix(basis(), 'T')
  ok('T37 nach Autobereinigung: Inhalt und Ampel zurück', u.art === 'autofix' && u.update.quality_status === 'red' && u.update.prev_content === null
    && stableEqual(u.update.content, basis().prev_content) && stableEqual(u.update.quality_report.findings, vorherF)
    && u.update.quality_report.status === 'red' && u.update.quality_report.autofix.status === 'undone' && u.update.quality_report.autofix.undone_at === 'T'
    && u.update.quality_checked_at === 'T', JSON.stringify(u))
  ok('T37 Feinschliff läuft → laeuft (409)', undoNachAutofix({ ...basis(), refining: true }, 'T').art === 'laeuft')
  ok('T37 revision 1 → normales Undo', undoNachAutofix({ ...basis(), revision: 1 }, 'T').art === 'normal')
  ok('T37 revision fehlt → wie 0', undoNachAutofix({ ...basis(), revision: null }, 'T').art === 'autofix')
  const ohne = (fn) => { const b = basis(); fn(b); return undoNachAutofix(b, 'T').art }
  ok('T37 Probelauf / undone / ohne before.findings / ohne Bericht / ohne prev_content → normal',
    ohne(b => { b.quality_report.autofix.status = 'dry_run' }) === 'normal' && ohne(b => { b.quality_report.autofix.status = 'undone' }) === 'normal'
    && ohne(b => { delete b.quality_report.autofix.before.findings }) === 'normal' && ohne(b => { b.quality_report = null }) === 'normal'
    && ohne(b => { b.prev_content = null }) === 'normal')
}

// ══ Endprüfung 12.10.26 (vor dem Deploy, alle Befunde reproduziert) ═════════

// ── T38: Abkürzungen ohne Bruchstück (Art., Wfl., Ave., Apt., Fr., Hr., Bj.) ─
{
  const s = (t) => splitSaetze(t).map(x => x.text.trim())
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  ok('T38 „Art. 22 DBA" trennt nicht', eq(s('Nach Art. 22 DBA sparst du so rund 8.000 € im Jahr. Ich rechne dir die Zahlen gern persönlich durch.'),
    ['Nach Art. 22 DBA sparst du so rund 8.000 € im Jahr.', 'Ich rechne dir die Zahlen gern persönlich durch.']))
  ok('T38 „Wfl. 92 m²" / „Kings Ave. 12" / „Apt. B4" / „Fr. Müller" / „Hr. Schmidt" / „Bj. 2027" / „Zi. 3" trennen nicht', [
    'Die Wohnung hat Wfl. 92 m² plus Terrasse.', 'Das Büro liegt an der Kings Ave. 12 in Paphos.', 'Das Apt. B4 hat Meerblick.',
    'Deine Ansprechpartnerin ist Fr. Müller aus Paphos.', 'Dein Ansprechpartner ist Hr. Schmidt aus Limassol.', 'Das Haus hat Bj. 2027 und ist neu.', 'Die Wohnung hat Zi. 3 im Plan.',
  ].every(t => s(t + ' Ende folgt.').length === 2))
  // Unbekanntes kurzes Kürzel: trennt, aber die Grenze ist unsicher → nie dort schneiden
  ok('T38 sichereGrenze: kurze und vokallose Tokens unsicher, Wörter ab 4 Buchstaben, Zahlen, Einheiten, Klammer sicher',
    ['Gebaut von der Muster Ltd. ', 'Liegt am Gym. ', 'Lieber Max. ', 'Das ist gut. ', 'Siehe S. 4 ff. ', 'Die Muster GmbH. ', 'Bringt 5 % p. a. ', 'Paphos is a hidden gem. ', 'Is it far? No. '.slice(11)].every(x => !sichereGrenze(x))
    && ['Die Anlage liegt am Meer. ', 'Fertig im Jahr 2028. ', 'Es sind 92 m². ', 'Zum Strand sind es 5 Min. ', 'Sie kostet 403.410 €. ', 'Siehe Plan (Seite 4). ', 'Was für ein Blick! ', 'Willst du? ', 'Paphos hat Gäste … ', '„So ist es richtig.“ '].every(x => sichereGrenze(x)))
  const d = deck()
  d[I.letter].paragraphs[2] = 'Nach Art. 22 DBA sparst du so rund 8.000 € im Jahr. Ich rechne dir die Zahlen gern persönlich durch.'
  const r = run(d)
  ok('T38 Befund: „Nach Art. 22 DBA ... 8.000 €" → Absatz bleibt ganz (fliesstext), kein „Nach Art."', bleibt(r, d, I.letter, 'betrag_fremd'),
    `${r.blocks[I.letter].paragraphs[2]} ${keys(runDeckGate(d, ctx()).findings)} ${JSON.stringify(r.report.skipped)}`)
  const d2 = deck()
  d2[I.letter].paragraphs[2] = 'Nach Art. 22 DBA wird die zyprische Steuer voll angerechnet. Ich rechne dir die Zahlen gern persönlich durch.'
  const r2 = run(d2, { claims: [claim(I.letter, 'wird die zyprische Steuer voll angerechnet')] })
  ok('T38 Variante Behauptung: Absatz bleibt ganz (fliesstext)', bleibt(r2, d2, I.letter, 'behauptung_unsupported'), wieso(r2))
  const d3 = deck()
  d3[I.unit].note = 'Die Einrichtung ist als Paket optional erhältlich. Wfl. 92 m² plus Terrasse. Die Übergabe erfolgt schlüsselfertig.'
  const r3 = run(d3)
  ok('T38 Befund: „Wfl. 92 m²" → Notiz bleibt ganz (fliesstext), kein „Wfl."', bleibt(r3, d3, I.unit, 'flaeche_abweichung'), wieso(r3))
  const d4 = deck()
  d4[I.feature].text = 'Gebaut wird die Anlage von der Muster Ltd. Die Anlage liegt direkt am Meer. Die Nachfrage ist das ganze Jahr über da.'
  const r4 = run(d4, { claims: [claim(I.feature, 'Die Anlage liegt direkt am Meer')] })
  ok('T38 unbekanntes Kürzel „Ltd." an der Schnittstelle → nicht_lokalisierbar, Text unverändert', r4.report.skipped[0]?.reason === 'nicht_lokalisierbar' && stableEqual(r4.blocks, d4), JSON.stringify(r4.report.skipped))
}

// ── T39: Zitate über mehrere Sätze ──────────────────────────────────────────
{
  ok('T39 zitateAusgeglichen', zitateAusgeglichen('Er sagt „Hallo“ und geht’s an.') && zitateAusgeglichen('"It\'s fine," he says.')
    && !zitateAusgeglichen('„Die Anlage liegt direkt am Meer. ') && !zitateAusgeglichen('So etwas gibt es selten", sagt er.') && !zitateAusgeglichen('« Bonjour'))
  const d = deck()
  d[I.feature].text = 'Paphos hat auch im Winter Gäste. „Die Anlage liegt direkt am Meer. So etwas gibt es selten", sagt der Bauträger. Die Nachfrage ist das ganze Jahr über da.'
  const r = run(d, { claims: [claim(I.feature, 'Die Anlage liegt direkt am Meer')] })
  ok('T39 Befund DE: Zitat über zwei Sätze → kontext, Text unverändert', r.report.skipped[0]?.reason === 'kontext' && stableEqual(r.blocks, d), JSON.stringify(r.report.skipped))
  const d2 = deck()
  d2[I.feature].text = '"The complex sits right on the beach. Nothing like it exists," says the developer. Demand is strong all year round.'
  const r2 = run(d2, { claims: [claim(I.feature, 'The complex sits right on the beach')] })
  ok('T39 Befund EN: Zitat über zwei Sätze → kontext, Text unverändert', r2.report.skipped[0]?.reason === 'kontext' && stableEqual(r2.blocks, d2), JSON.stringify(r2.report.skipped))
  // Zitat ganz innerhalb des gestrichenen Satzes: darf weg
  const d3 = deck()
  d3[I.feature].text = 'Paphos hat auch im Winter Gäste. Der Bauträger nennt die Lage „direkt am Meer“. Die Nachfrage ist das ganze Jahr über da.'
  const r3 = run(d3, { claims: [claim(I.feature, 'Der Bauträger nennt die Lage „direkt am Meer“')] })
  ok('T39 Zitat ganz im Satz: Zitatprüfung besteht, Fließtext bleibt (fliesstext)', bleibt(r3, d3, I.feature, 'behauptung_unsupported'), wieso(r3))
}

// ── T40: Verweis-Folgesätze und Doppelpunkt-Absätze ─────────────────────────
{
  ok('T40 beginntMitVerweis', ['Dadurch sinken die Kosten.', 'So etwas gibt es selten.', 'Das ist viel wert.', '„Dies gilt auch.', 'This makes it ideal.', 'Außerdem gibt es ein Café.', 'Dafür zahlst du nichts.'].every(beginntMitVerweis)
    && !['Die Nachfrage ist da.', 'Sonne gibt es genug.', 'Dasselbe Bild.', 'Thisbe kommt.', 'Supermarkt und Cafés.'].some(beginntMitVerweis))
  const d = deck()
  d[I.feature].text = 'Paphos hat auch im Winter Gäste. Auf dem Dach liefert eine Solaranlage kostenlosen Strom. Dadurch sinken die Nebenkosten für dich deutlich. Die Nachfrage ist das ganze Jahr über da.'
  const r = run(d, { claims: [claim(I.feature, 'Auf dem Dach liefert eine Solaranlage kostenlosen Strom')] })
  ok('T40 Befund (a): Folgesatz „Dadurch ..." → kontext, Text unverändert', r.report.skipped[0]?.reason === 'kontext' && stableEqual(r.blocks, d), JSON.stringify(r.report.skipped))
  const d2 = deck()
  const p = d2[I.letter].paragraphs
  d2[I.letter].paragraphs = [p[0], p[1], 'Was die Anlage besonders macht:', 'Sie liegt direkt am Meer, mit eigenem Strandzugang für alle Bewohner.', p[2]]
  const r2 = run(d2, { claims: [claim(I.letter, 'Sie liegt direkt am Meer, mit eigenem Strandzugang für alle Bewohner')] })
  ok('T40 Befund (b): Absatz nach „...:" → kontext, Brief unverändert', r2.report.skipped[0]?.reason === 'kontext' && stableEqual(r2.blocks, d2), JSON.stringify(r2.report.skipped))
  const d3 = deck()
  d3[I.letter].paragraphs = [p[0], 'Die Anlage hat eine Photovoltaikanlage auf dem Dach.', 'Dadurch sparst du jeden Monat Stromkosten.', p[2]]
  const r3 = run(d3, { claims: [claim(I.letter, 'Die Anlage hat eine Photovoltaikanlage auf dem Dach')] })
  ok('T40 ganzer Absatz, nächster Absatz beginnt mit „Dadurch" → kontext', r3.report.skipped[0]?.reason === 'kontext' && stableEqual(r3.blocks, d3), JSON.stringify(r3.report.skipped))
  const d4 = deck()
  d4[I.feature].text = 'Paphos has guests in winter as well. The pool is heated all year round. This makes it ideal for winter guests.'
  const r4 = run(d4, { claims: [claim(I.feature, 'The pool is heated all year round')] })
  ok('T40 EN „This makes ..." → kontext', r4.report.skipped[0]?.reason === 'kontext' && stableEqual(r4.blocks, d4), JSON.stringify(r4.report.skipped))
  // Gegenprobe: ohne Verweis wird weiter bereinigt
  const d5 = deck()
  d5[I.feature].text = 'Paphos hat auch im Winter Gäste. Auf dem Dach liefert eine Solaranlage kostenlosen Strom. Die Nachfrage ist das ganze Jahr über da.'
  const r5 = run(d5, { claims: [claim(I.feature, 'Auf dem Dach liefert eine Solaranlage kostenlosen Strom')] })
  ok('T40 Gegenprobe ohne Verweis → kein kontext, sondern fliesstext', bleibt(r5, d5, I.feature, 'behauptung_unsupported'), wieso(r5))
}

// ── T41: Emoji, Ellipse, &nbsp;, **, „gem." und „No." ──────────────────────
{
  const s = (t) => splitSaetze(t).map(x => x.text.trim())
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const rest = ' Langzeitmieter suchen moderne Wohnungen mit Pool. Viele bleiben mehrere Jahre in der Wohnung. Die Nachfrage ist das ganze Jahr über da.'
  const d = deck()
  d[I.feature].text = 'Paphos hat auch im Winter Gäste. 🌊 Die Anlage liegt direkt am Meer.' + rest
  const r = run(d, { claims: [claim(I.feature, 'Die Anlage liegt direkt am Meer')] })
  ok('T41 Emoji nach dem Satzende: Text bleibt ganz (fliesstext)', bleibt(r, d, I.feature, 'behauptung_unsupported'), wieso(r))
  const d2 = deck()
  d2[I.feature].text = 'Paphos hat auch im Winter Gäste … Die Anlage liegt direkt am Meer.' + rest
  const r2 = run(d2, { claims: [claim(I.feature, 'Die Anlage liegt direkt am Meer')] })
  ok('T41 Ellipse „…" als Satzende: Text bleibt ganz (fliesstext)', bleibt(r2, d2, I.feature, 'behauptung_unsupported'), wieso(r2))
  for (const [name, text] of [['&nbsp;', 'Paphos hat auch im Winter Gäste.&nbsp;Die Anlage liegt direkt am Meer.' + rest], ['**', '**Paphos hat auch im Winter Gäste.** Die Anlage liegt direkt am Meer.' + rest]]) {
    const dx = deck(); dx[I.feature].text = text
    const rx = run(dx, { claims: [claim(I.feature, 'Die Anlage liegt direkt am Meer')] })
    ok(`T41 Feld mit ${name} → html_feld, unverändert`, rx.report.skipped[0]?.reason === 'html_feld' && stableEqual(rx.blocks, dx), JSON.stringify(rx.report.skipped))
  }
  const d3 = deck()
  d3[I.feature].text = 'Paphos is a hidden gem. The complex sits right on the beach. Long-term tenants look for modern flats with a pool. Demand is there all year round.'
  const r3 = run(d3, { claims: [claim(I.feature, 'The complex sits right on the beach')] })
  ok('T41 „hidden gem." wird nie mitgestrichen (Grenze unsicher → unverändert)', /Paphos is a hidden gem\./.test(r3.blocks[I.feature].text)
    && (r3.report.status === 'applied' ? r3.blocks[I.feature].text === 'Paphos is a hidden gem. Long-term tenants look for modern flats with a pool. Demand is there all year round.' : stableEqual(r3.blocks, d3)),
    `${r3.blocks[I.feature].text} ${JSON.stringify(r3.report.skipped)}`)
  ok('T41 „gem." / „No." trennen vor Satzanfang, als Kürzel nur vor Ziffer', eq(s('Paphos is a hidden gem. The complex is new.'), ['Paphos is a hidden gem.', 'The complex is new.'])
    && eq(s('Is it far? No. The beach is close.'), ['Is it far?', 'No.', 'The beach is close.']) && eq(s('Unit No. 5 is sold. The end.'), ['Unit No. 5 is sold.', 'The end.']))
  ok('T41 Emoji und * vor dem nächsten Wort: trennt', eq(s('Gäste im Winter. 🌊 Die Anlage. *Neu* ist der Pool.'), ['Gäste im Winter.', '🌊 Die Anlage.', '*Neu* ist der Pool.']))
}

// ── T42: Preis im Fließtext ab 1 Mio. ───────────────────────────────────────
{
  const d = deck()
  d[I.unit].note = 'Die Einrichtung ist optional. Die Wohnung kostet 1.250.000 € netto. Die Übergabe erfolgt schlüsselfertig.'
  const c = ctx({ units: [{ ...unit, netProperty: 1250000 }] })
  const g = runDeckGate(d, c).findings.filter(f => f.key === 'preis_im_fliesstext')
  ok('T42 Gate: loc.match enthält den ganzen Betrag „1.250.000 €"', g.length === 1 && g[0].loc?.match === '1.250.000 €' && g[0].loc?.index === d[I.unit].note.indexOf('1.250.000'), JSON.stringify(g.map(f => f.loc)))
  const r = run(d, { c })
  ok('T42 Millionenpreis im Fließtext → fliesstext, Notiz byte-gleich', bleibt(r, d, I.unit, 'preis_im_fliesstext'), wieso(r))
  const d1 = deck()
  d1[I.unit].note = 'Die Wohnung kostet 1.250.000 € netto.'
  const r1 = run(d1, { c })
  ok('T42 Notiz nur aus dem Millionenpreis → entfernt, Befund weg', r1.report.status === 'applied' && r1.blocks[I.unit].note === undefined
    && !r1.findings.some(f => f.key === 'preis_im_fliesstext'), wieso(r1))
  // Unter 1 Mio. wie bisher, 4-stellige Beträge weiter kein Befund
  const d2 = deck(); d2[I.unit].note = 'Die Rücklage beträgt 1.500 € im Jahr. Die Übergabe erfolgt schlüsselfertig.'
  ok('T42 „1.500 €" weiter kein preis_im_fliesstext, „403.410 €" weiter ja', !runDeckGate(d2, ctx()).findings.some(f => f.key === 'preis_im_fliesstext')
    && runDeckGate(Object.assign(deck(), { [I.unit]: { ...deck()[I.unit], note: 'Brutto 403.410 € gesamt.' } }), ctx()).findings.some(f => f.key === 'preis_im_fliesstext' && f.loc?.match === '403.410 €'))
}

// ── T43: Anrede wird nie gestrichen ─────────────────────────────────────────
{
  const d = deck()
  d[I.letter].paragraphs[0] = 'Hallo Max, die Anlage liegt direkt am Meer und ist damit ideal für dich. Du suchst eine Wohnung, die du ganzjährig vermieten kannst und die du selbst ein paar Wochen im Jahr nutzt.'
  const r = run(d, { claims: [claim(I.letter, 'die Anlage liegt direkt am Meer und ist damit ideal für dich')] })
  ok('T43 Befund: Behauptung im Begrüßungssatz → pflichtfeld, Anrede bleibt', r.report.skipped[0]?.reason === 'pflichtfeld' && stableEqual(r.blocks, d), JSON.stringify(r.report.skipped))
  const d2 = deck()
  d2[I.letter].paragraphs[0] = 'Die Anlage liegt direkt am Meer. Du suchst eine Wohnung, die du ganzjährig vermieten kannst.'
  const r2 = run(d2, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  ok('T43 erster Satz von paragraphs[0] auch ohne Grußwort geschützt', r2.report.skipped[0]?.reason === 'pflichtfeld' && stableEqual(r2.blocks, d2), JSON.stringify(r2.report.skipped))
  const d3 = deck()
  d3[I.letter].paragraphs[1] = 'Liebe Anna, die Anlage liegt direkt am Meer. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.'
  const r3 = run(d3, { claims: [claim(I.letter, 'die Anlage liegt direkt am Meer')] })
  ok('T43 Absatz mit „Liebe ..." am Anfang: erster Satz geschützt', r3.report.skipped[0]?.reason === 'pflichtfeld' && stableEqual(r3.blocks, d3), JSON.stringify(r3.report.skipped))
  const d4 = deck()
  d4[I.letter].paragraphs = ['Hallo Max, die Anlage liegt direkt am Meer.', d4[I.letter].paragraphs[1], d4[I.letter].paragraphs[2]]
  const r4 = run(d4, { claims: [claim(I.letter, 'die Anlage liegt direkt am Meer')] })
  ok('T43 paragraphs[0] nur aus Anrede + Behauptung → bleibt ganz (pflichtfeld)', r4.report.skipped[0]?.reason === 'pflichtfeld' && stableEqual(r4.blocks, d4), JSON.stringify(r4.report.skipped))
  // Gegenprobe: Behauptung im zweiten Satz des ersten Absatzes darf weg
  const d5 = deck()
  d5[I.letter].paragraphs[0] = 'Hallo Max, schön, dass wir gesprochen haben. Die Anlage liegt direkt am Meer. Du suchst eine Wohnung, die du ganzjährig vermieten kannst.'
  const r5 = run(d5, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  ok('T43 Gegenprobe: zweiter Satz im ersten Absatz → keine Anrede-Sperre, aber fliesstext', bleibt(r5, d5, I.letter, 'behauptung_unsupported'), wieso(r5))
}

// ── T44: HTML-Sperre für ganze Karten und Listenobjekte ─────────────────────
{
  const d = deck()
  d[I.benefits].cards[1].title = '<b>VRV</b>-Klima'
  // Kartentext nur aus der Aussage: nur dann fiele die ganze Karte weg (Runde 5)
  d[I.benefits].cards[1].text = 'Zentrale Klimatisierung für heiße Sommer.'
  const r = run(d, { claims: [claim(I.benefits, 'Zentrale Klimatisierung für heiße Sommer')] })
  ok('T44 Befund (1): Karte mit HTML-Titel → html_feld, Karte bleibt', r.report.skipped[0]?.reason === 'html_feld' && stableEqual(r.blocks, d), `${r.report.status} ${JSON.stringify(r.report.skipped)}`)
  const d2 = deck()
  d2[I.floorplan].bullets = [{ strong: '<b>Wohnen</b>', text: '3 Schlafzimmer' }, { strong: 'Terrasse', text: 'Süd' }]
  const g2 = runDeckGate(d2, ctx()).findings
  const r2 = run(d2)
  ok('T44 Befund (2): bullet mit HTML-strong → html_feld, bullets unverändert', g2.some(f => f.key === 'zimmer_abweichung' && f.block === I.floorplan)
    && r2.report.skipped.some(x => x.key === 'zimmer_abweichung' && x.reason === 'html_feld') && stableEqual(r2.blocks[I.floorplan], d2[I.floorplan]),
    `${keys(g2)} ${JSON.stringify(r2.report.skipped)}`)
  // Gegenprobe: ohne HTML wird die Karte weiter entfernt
  const d3 = deck(); d3[I.benefits].cards[1].text = 'Zentrale Klimatisierung für heiße Sommer.'
  const r3 = run(d3, { claims: [claim(I.benefits, 'Zentrale Klimatisierung für heiße Sommer')] })
  ok('T44 Gegenprobe: Karte ohne HTML → karte_entfernt', r3.report.status === 'applied' && r3.report.changes[0]?.action === 'karte_entfernt', JSON.stringify(r3.report.skipped))
}

// ── T45: UI-Kleinigkeiten (Quelltext-Prüfung, kein Browser) ─────────────────
{
  const { readFileSync } = await import('fs')
  const panel = readFileSync('src/components/crm/DeckQualityPanel.tsx', 'utf8')
  const chat = readFileSync('src/components/crm/DeckChat.tsx', 'utf8')
  const de = JSON.parse(readFileSync('src/locales/de.json', 'utf8'))
  const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8'))
  ok('T45 notApplied nur ohne superseded_at', /\(af\.status === 'rolled_back' \|\| af\.status === 'undone'\) && !af\.superseded_at && afChanges\.length > 0/.test(panel))
  ok('T45 hintFact nur bei status applied', /c\.hint === 'fakt_hinterlegen' && af\.status === 'applied'/.test(panel))
  ok('T45 DeckChat Undo: 409 → undoBusy, 400 → undoNothing, body.error nur Rückfall', /status === 409 \? t\('deckChat\.undoBusy'/.test(chat) && /status === 400 \? t\('deckChat\.undoNothing'/.test(chat)
    && /: body\?\.error \|\| error\.message/.test(chat))
  ok('T45 Locale-Schlüssel DE/EN vorhanden, ohne Gedankenstrich', [de, en].every(l => l.deckChat?.undoBusy && l.deckChat?.undoNothing && l.deckQuality?.autofix?.reason?.kontext
    && ![l.deckChat.undoBusy, l.deckChat.undoNothing, l.deckQuality.autofix.reason.kontext].some(x => /[—–]/.test(x))))
  ok('T45 DE-Texte mit echten Umlauten', /läuft|rückgängig/.test(de.deckChat.undoBusy) && /hängt/.test(de.deckQuality.autofix.reason.kontext))
}

// ── T46: Klammern über eine Satzgrenze (Prüfbefund 12.10.26) ────────────────
{
  ok('T46 klammernAusgeglichen', klammernAusgeglichen('Ruhig (siehe Karte) und [neu].') && klammernAusgeglichen('Ohne Klammer.')
    && !klammernAusgeglichen('(Die Anlage liegt direkt am Meer. ') && !klammernAusgeglichen('Der Strand ist nah.) ') && !klammernAusgeglichen(') (') && !klammernAusgeglichen('[Hinweis'))
  const d = deck()
  d[I.letter].paragraphs[1] = 'Emerald Park liegt ruhig. (Die Anlage liegt direkt am Meer. Der Strand ist nah.) Supermarkt und Cafés sind in wenigen Minuten erreichbar.'
  const r = run(d, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  ok('T46 Befund (1): Klammer öffnet vor der Behauptung → kontext, Text unverändert', r.report.skipped[0]?.reason === 'kontext' && stableEqual(r.blocks, d) && r.report.after.status === 'red',
    `${r.report.status} ${r.blocks[I.letter].paragraphs[1]} ${JSON.stringify(r.report.skipped)}`)
  const d2 = deck()
  d2[I.letter].paragraphs[1] = 'Emerald Park liegt ruhig (siehe Karte. Die Anlage liegt direkt am Meer.) Supermarkt und Cafés sind in wenigen Minuten erreichbar.'
  const r2 = run(d2, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  ok('T46 Befund (2): Klammer schließt nach der Behauptung → kontext, Text unverändert', r2.report.skipped[0]?.reason === 'kontext' && stableEqual(r2.blocks, d2) && r2.report.after.status === 'red',
    `${r2.report.status} ${r2.blocks[I.letter].paragraphs[1]} ${JSON.stringify(r2.report.skipped)}`)
  // Gegenprobe: Klammer ganz im gestrichenen Satz
  const d3 = deck()
  d3[I.letter].paragraphs[1] = 'Emerald Park liegt ruhig. Die Anlage liegt direkt am Meer (mit eigenem Strandzugang). Supermarkt und Cafés sind in wenigen Minuten erreichbar.'
  const r3 = run(d3, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  ok('T46 Gegenprobe: Klammer ganz im Satz → kein kontext, sondern fliesstext', bleibt(r3, d3, I.letter, 'behauptung_unsupported'), wieso(r3))
}

// ── T47: Maklerkürzel ohne Satzbruchstück (Prüfbefund 12.10.26) ─────────────
{
  const s = (t) => splitSaetze(t).map(x => x.text.trim())
  ok('T47 splitSaetze trennt nicht nach einschl./exkl./voraussichtl./monatl./nördl./Wohnfl./Govt.', [
    'Die Wohnung kostet 339.000 € einschl. Einrichtung.', 'Der Preis gilt exkl. Möbel.', 'Sie wird voraussichtl. Ende 2028 übergeben.',
    'Die monatl. Mieteinnahmen sind gut.', 'Sie liegt 2 km nördl. Paphos.', 'Die Wohnung hat Wohnfl. 84,5 m².', 'The Govt. Department agrees.',
    'Die durchschnittl. Belegung ist hoch.', 'Die tägl. Reinigung ist inklusive.', 'Die Dept. Store Kette baut.',
  ].every(t => s(t + ' Ende folgt.').length === 2))
  ok('T47 sichereGrenze: Konsonant + l und bekannte Kürzel unsicher, normale Wörter sicher',
    ['Die Miete kommt monatl. ', 'Sie liegt 2 km nördl. ', 'Das ist wesentl. ', 'Gebaut von der Muster Corp. ', 'Gebaut von Muster Intl. ', 'Geprüft vom Govt. ', 'Siehe Dept. ', 'Gezeigt von Prof. '].every(x => !sichereGrenze(x))
    && ['Das ist ein Modell. ', 'Das ist eine gute Wahl. ', 'Das Wasser ist kühl. ', 'Die Lage ist ideal. ', 'Es gibt ein Hotel. ', 'Die Anlage liegt am Strand. ', 'Daneben liegt ein Park. '].every(x => sichereGrenze(x)))
  ok('T47 mehrdeutigesKuerzel', mehrdeutigesKuerzel('Sie kostet 339.000 € einschl. Einrichtung.') && mehrdeutigesKuerzel('Wohnfl. 84,5 m²') && mehrdeutigesKuerzel('The Govt. Department')
    && !mehrdeutigesKuerzel('Sie kostet 339.000 € einschl. der Einrichtung.') && !mehrdeutigesKuerzel('Die Anlage liegt am Meer. Die Nachfrage ist da.'))
  const faelle = [
    ['note einschl.', I.unit, 'note', 'Die Wohnung kostet 339.000 € einschl. Einrichtung. Die Übergabe erfolgt schlüsselfertig.', null],
    ['note exkl.', I.unit, 'note', 'Die Einrichtung ist optional. Der Kaufpreis beträgt 320.000 € exkl. Möbel. Die Übergabe erfolgt schlüsselfertig.', null],
    ['letter voraussichtl.', I.letter, 'paragraphs.1', 'Emerald Park liegt in einem ruhigen Wohngebiet. Die Anlage liegt direkt am Meer und wird voraussichtl. Ende 2028 übergeben. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.', 'Die Anlage liegt direkt am Meer'],
    ['feature monatl.', I.feature, 'text', 'Paphos hat auch im Winter Gäste. Die monatl. Mieteinnahmen liegen bei 1.500 €. Die Nachfrage ist das ganze Jahr über da.', null],
    ['feature durchschnittl.', I.feature, 'text', 'Paphos hat auch im Winter Gäste. Die durchschnittl. Rendite liegt bei 5 %. Die Nachfrage ist das ganze Jahr über da.', null],
    ['cols nördl.', I.columns, 'cols.0.text', 'Die Anlage liegt direkt am Meer, nur 2 km nördl. Paphos. Kleine Cafés liegen um die Ecke.', 'Die Anlage liegt direkt am Meer'],
    ['note Wohnfl.', I.unit, 'note', 'Die Wohnung hat Wohnfl. 84,5 m² und liegt direkt am Meer. Die Übergabe erfolgt schlüsselfertig.', 'liegt direkt am Meer'],
    ['EN Govt.', I.feature, 'text', 'Paphos has guests all year. The Govt. Department expects 5 % yield p.a. on new builds. Demand stays strong.', null],
  ]
  const setz = (b, pfad, v) => { const t = pfad.split('.'); let o = b; for (const k of t.slice(0, -1)) o = o[k]; o[t[t.length - 1]] = v }
  for (const [name, bi, pfad, text, aussage] of faelle) {
    const d = deck()
    setz(d[bi], pfad, text)
    const claims = aussage ? [claim(bi, aussage)] : []
    const vorher = [...runDeckGate(d, ctx()).findings, ...claims].filter(f => f.block === bi && f.severity !== 'niedrig')
    const r = run(d, { claims })
    ok(`T47 Befund ${name}: Befund vorhanden, Block unverändert, nicht_lokalisierbar, Ampel wie vorher`, vorher.length > 0 && stableEqual(r.blocks[bi], d[bi])
      && r.report.skipped.some(x => x.block === bi && x.reason === 'nicht_lokalisierbar')
      && r.report.after.status === r.report.before.status && r.report.after.red === r.report.before.red,
      `${keys(vorher)} | ${r.report.status} ${JSON.stringify(r.blocks[bi]).slice(0, 200)} ${JSON.stringify(r.report.skipped)}`)
  }
  // Gegenprobe: Kürzel mit Kleinwort dahinter ist eindeutig → ganzer Satz weg
  const d = deck()
  d[I.unit].note = 'Die Wohnung kostet 339.000 € einschl. der Einrichtung. Die Übergabe erfolgt schlüsselfertig.'
  const r = run(d)
  ok('T47 Gegenprobe „einschl. der Einrichtung" → eindeutig, aber fliesstext', bleibt(r, d, I.unit, 'preis_im_fliesstext'), wieso(r))
}

// ── T48: Verwaiste Bezüge (Prüfbefund 12.10.26) ─────────────────────────────
{
  const ja = ['Deswegen sind die Wohnungen gefragt.', 'Trotzdem ist es abends ruhig.', 'Genau das suchen Urlaubsgäste.', 'Denn genau das macht die Lage aus.',
    'Gerade deshalb ziehen viele Familien hierher.', 'Auch deshalb lohnt es sich.', 'Nicht zuletzt deshalb ist die Lage gefragt.', 'Vor allem deshalb lohnt es sich.',
    'Deren Terrasse ist abends gut besucht.', 'Dessen Lage ist ideal.', 'Dabei bleibt es ruhig.', 'Davon profitieren auch Mieter.', 'Darüber freuen sich Gäste.',
    'Darauf kannst du bauen.', 'Daraus ergibt sich viel.', 'Darin liegt der Vorteil.', 'Daneben liegt ein Park.', 'Hierfür zahlst du nichts.', 'Hiervon profitierst du.',
    'Ihre Lage ist ideal für Mieter.', 'Seine Terrasse ist groß.', 'Doch das ist nicht alles.', 'Jedoch bleibt es ruhig.', 'Allerdings gibt es wenig Parkplätze.',
    'Gleichzeitig steigt die Nachfrage.', 'Ebenso gibt es ein Café.', 'Ebenfalls neu ist das Gym.', 'Zusätzlich gibt es einen Pool.', 'Somit lohnt es sich.',
    'Folglich steigt die Miete.', 'Dennoch bleibt es ruhig.', 'Hinzu kommt ein Pool.', 'Welche Vorteile das bringt, siehst du.', 'Dann rechne ich dir die Zahlen durch.',
    'Therefore demand stays high.', 'However, the nights stay quiet.', 'Its berths attract wealthy visitors.', 'Their terrace is large.', 'Which makes it ideal for tenants.',
    'As a result, demand stays high.', 'Moreover, there is a gym.', 'Furthermore, there is a gym.', 'Additionally, there is a pool.', 'Hence the demand.', 'Yet the nights stay quiet.',
    'Nevertheless, it stays quiet.', 'Plus, there is a gym.', 'Such locations are rare.', 'Especially this makes it ideal.', 'Exactly that is what guests want.']
  const nein = ['Die Nachfrage ist da.', 'Sonne gibt es genug.', 'Dasselbe Bild.', 'Thisbe kommt.', 'Supermarkt und Cafés.', 'Gerade im Winter ist viel los.',
    'Genau 200 Meter sind es zum Strand.', 'Daten zeigen eine hohe Nachfrage.', 'Dach und Fassade sind neu.', 'Darmstadt ist weit weg.', 'Asphalt liegt überall.',
    'Seitlich liegt der Garten.', 'Nur wenige Minuten sind es zum Strand.', 'Paphos hat Gäste.', 'The pool is heated.', 'Demand stays strong.', 'Hierzulande ist das selten.']
  const fehlJa = ja.filter(x => !beginntMitVerweis(x)), fehlNein = nein.filter(x => beginntMitVerweis(x))
  ok('T48 beginntMitVerweis erweitert (DE/EN, Pronominaladverbien, Verstärker)', !fehlJa.length && !fehlNein.length, `nicht erkannt: ${fehlJa.join(' | ')} / falsch erkannt: ${fehlNein.join(' | ')}`)
  const faelle = [
    ['letter Deswegen', I.letter, 'paragraphs.1', 'Emerald Park liegt in einem ruhigen Wohngebiet. Die Anlage liegt direkt am Meer. Deswegen sind die Wohnungen auch im Winter gefragt.', 'Die Anlage liegt direkt am Meer'],
    ['letter Trotzdem', I.letter, 'paragraphs.1', 'Emerald Park liegt in einem ruhigen Wohngebiet. Die Anlage liegt direkt am Meer. Trotzdem ist es abends ruhig.', 'Die Anlage liegt direkt am Meer'],
    ['letter Genau das', I.letter, 'paragraphs.1', 'Emerald Park liegt in einem ruhigen Wohngebiet. Du hast Meerblick von jedem Balkon. Genau das suchen Urlaubsgäste.', 'Du hast Meerblick von jedem Balkon'],
    ['letter Denn genau das', I.letter, 'paragraphs.1', 'Emerald Park liegt in einem ruhigen Wohngebiet. Die Anlage liegt direkt am Meer. Denn genau das macht die Lage so besonders.', 'Die Anlage liegt direkt am Meer'],
    ['cols Gerade deshalb', I.columns, 'cols.1.text', 'Die Küstenstraße ist schnell erreicht. Ein neuer Golfplatz entsteht direkt nebenan. Gerade deshalb ziehen viele Familien hierher.', 'Ein neuer Golfplatz entsteht direkt nebenan'],
    ['feature Deren', I.feature, 'text', 'Paphos hat auch im Winter Gäste. Die Anlage hat eine eigene Strandbar. Deren Terrasse ist abends gut besucht.', 'Die Anlage hat eine eigene Strandbar'],
    ['feature Dabei', I.feature, 'text', 'Paphos hat auch im Winter Gäste. Die Anlage liegt nur 200 Meter vom Strand entfernt. Dabei bleibt es nachts ruhig.', 'Die Anlage liegt nur 200 Meter vom Strand entfernt'],
    ['feature Davon', I.feature, 'text', 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Davon profitieren auch Mieter.', 'Die Anlage liegt direkt am Meer'],
    ['feature Ihre', I.feature, 'text', 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Ihre Lage ist ideal für Mieter.', 'Die Anlage liegt direkt am Meer'],
    ['EN Therefore', I.feature, 'text', 'Paphos has guests all year. The complex sits right on the beach. Therefore demand stays high in winter.', 'The complex sits right on the beach'],
    ['EN However', I.feature, 'text', 'Paphos has guests all year. The complex sits right on the beach. However, the nights stay quiet.', 'The complex sits right on the beach'],
    ['EN Its', I.feature, 'text', 'Paphos has guests all year. A new marina opens next to the complex in 2027. Its berths attract wealthy visitors.', 'A new marina opens next to the complex in 2027'],
    ['EN Which', I.feature, 'text', 'Paphos has guests in winter as well. The complex sits right on the beach. Which makes it ideal for tenants.', 'The complex sits right on the beach'],
  ]
  const setz = (b, pfad, v) => { const t = pfad.split('.'); let o = b; for (const k of t.slice(0, -1)) o = o[k]; o[t[t.length - 1]] = v }
  for (const [name, bi, pfad, text, aussage] of faelle) {
    const d = deck()
    setz(d[bi], pfad, text)
    const r = run(d, { claims: [claim(bi, aussage)] })
    ok(`T48 Befund ${name}: Folgesatz hängt → kontext, Text unverändert, Ampel rot`, r.report.skipped[0]?.reason === 'kontext' && stableEqual(r.blocks, d) && r.report.after.status === 'red',
      `${r.report.status} ${JSON.stringify(r.report.skipped)}`)
  }
  // Absatz-Variante: ganzer Absatz fällt weg, der nächste beginnt mit „Davon"
  const d = deck()
  const p = d[I.letter].paragraphs
  d[I.letter].paragraphs = [p[0], 'Die Anlage liegt direkt am Meer.', 'Davon profitieren auch deine Mieter, die den Strand lieben.', p[2]]
  const r = run(d, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  ok('T48 Absatz-Variante: nächster Absatz „Davon ..." → kontext, Brief unverändert', r.report.skipped[0]?.reason === 'kontext' && stableEqual(r.blocks, d), JSON.stringify(r.report.skipped))
  // Gegenprobe: Folgesatz ohne Bezug → Satz weg
  const d2 = deck()
  d2[I.feature].text = 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Gerade im Winter ist die Nachfrage hoch.'
  const r2 = run(d2, { claims: [claim(I.feature, 'Die Anlage liegt direkt am Meer')] })
  ok('T48 Gegenprobe „Gerade im Winter ..." → kein kontext, sondern fliesstext', bleibt(r2, d2, I.feature, 'behauptung_unsupported'), wieso(r2))
}

// ── T49: Mehrwortige Anschlüsse, Aufzählungen, angekündigte Anzahl (Prüfbefund 12.10.26, Runde 3) ──
{
  const ja = ['Aus diesem Grund ist die Nachfrage hoch.', 'Im Gegensatz dazu sind Wohnungen im Landesinneren günstiger.', 'Zum anderen ist die Altstadt nah.',
    'Zweitens ist die Altstadt nah.', 'Drittens gibt es einen Pool.', 'Schließlich ist der Flughafen nah.', 'Zuletzt noch ein Wort zur Lage.',
    'Ein weiterer Vorteil ist der Pool.', 'Eine weitere Stärke ist die Lage.', 'Ein weiteres Plus ist das Gym.', 'Noch dazu ist es ruhig.', 'Ferner gibt es ein Gym.',
    'Weiterhin ist die Nachfrage hoch.', 'Überdies ist es ruhig.', 'Obendrein gibt es ein Gym.', 'Kein Wunder, dass Mieter Schlange stehen.', 'Mehr Lage geht nicht.',
    'Mehr Meer geht kaum.', 'Besser geht es nicht.', 'Darüber hinaus gibt es ein Gym.', 'Stattdessen gibt es einen Pool.', 'Wodurch die Nachfrage steigt.',
    'Mieter lieben genau diese Lage.', 'In diesem Fall lohnt es sich.', 'Für Familien ist dazu ein Spielplatz da.',
    'For this reason, demand stays high.', 'Because of this, demand stays high.', 'In addition, there is a gym.', 'On top of that, there is a gym.',
    "What's more, there is a gym.", 'What’s more, there is a gym.', 'Another advantage is the pool.', 'No wonder tenants queue up.', 'Secondly, the old town is close.',
    'Second, the old town is close.', 'Finally, the airport is close.', 'On the other hand, prices are lower inland.', 'Investors love that location.']
  const nein = ['Die Nachfrage ist das ganze Jahr über da.', 'Gerade im Winter ist die Nachfrage hoch.', 'Mehrere Cafés liegen nah.', 'Weiter südlich liegt der Strand.',
    'Schließfächer gibt es im Keller.', 'Finanzierung ist möglich.', 'In der Altstadt gibt es Cafés.', 'Supermarkt und Cafés sind nah.', 'Langzeitmieter suchen moderne Wohnungen mit Pool.',
    'Demand stays strong in winter.', 'Second homes are popular in Paphos.', 'The old town is close.', 'Paphos has guests all year.', 'Ferngläser braucht man nicht.']
  const fehlJa = ja.filter(x => !beginntMitVerweis(x)), fehlNein = nein.filter(x => beginntMitVerweis(x))
  ok('T49 beginntMitVerweis: Phrasen, Aufzählungsglieder und Verweiswort in den ersten 4 Wörtern', !fehlJa.length && !fehlNein.length,
    `nicht erkannt: ${fehlJa.join(' | ')} / falsch erkannt: ${fehlNein.join(' | ')}`)
  const DE = 'Die Anlage liegt direkt am Meer', EN = 'The complex is right on the beach'
  const faelle = [
    ['Aus diesem Grund', 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Aus diesem Grund ist die Nachfrage bei Urlaubern das ganze Jahr hoch.', DE],
    ['Zum einen / Zum anderen', 'Zum einen liegt die Anlage direkt am Meer. Zum anderen ist die Altstadt nur zehn Minuten entfernt. Die Nachfrage ist das ganze Jahr über da.', 'direkt am Meer'],
    ['Zum anderen gestrichen', 'Paphos hat auch im Winter Gäste. Zum einen ist die Altstadt nur zehn Minuten entfernt. Zum anderen liegt die Anlage direkt am Meer.', 'direkt am Meer'],
    ['Erstens / Zweitens', 'Erstens liegt die Anlage direkt am Meer. Zweitens ist die Altstadt nur zehn Minuten entfernt.', 'direkt am Meer'],
    ['Im Gegensatz dazu', 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Im Gegensatz dazu sind Wohnungen im Landesinneren günstiger.', DE],
    ['Drei Dinge', 'Drei Dinge sprechen für die Lage. Die Anlage liegt direkt am Meer. Die Altstadt ist zu Fuß erreichbar. Der Flughafen ist nah.', DE],
    ['Kein Wunder', 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Kein Wunder, dass Mieter Schlange stehen.', DE],
    ['Noch dazu', 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Noch dazu ist die Altstadt nah.', DE],
    ['Ferner', 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Ferner ist die Altstadt nah.', DE],
    ['Weiterhin', 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Weiterhin ist die Altstadt nah.', DE],
    ['Überdies', 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Überdies ist die Altstadt nah.', DE],
    ['Ein weiterer Vorteil', 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Ein weiterer Vorteil ist die Altstadt.', DE],
    ['Mehr Lage geht nicht', 'Paphos hat auch im Winter Gäste. Die Anlage liegt direkt am Meer. Mehr Lage geht nicht.', DE],
    ['EN For this reason', 'Paphos welcomes visitors all winter. The complex is right on the beach. For this reason, demand from holidaymakers stays high all year.', EN],
    ['EN Because of this', 'Paphos welcomes visitors all winter. The complex is right on the beach. Because of this, demand stays high.', EN],
    ['EN In addition', 'Paphos welcomes visitors all winter. The complex is right on the beach. In addition, the old town is close.', EN],
    ['EN On top of that', 'Paphos welcomes visitors all winter. The complex is right on the beach. On top of that, the old town is close.', EN],
    ["EN What's more", "Paphos welcomes visitors all winter. The complex is right on the beach. What's more, the old town is close.", EN],
    ['EN Another advantage', 'Paphos welcomes visitors all winter. The complex is right on the beach. Another advantage is the old town.', EN],
    ['EN three reasons', 'Three reasons speak for the location. The complex is right on the beach. The old town is close. The airport is near.', EN],
  ]
  for (const [name, text, aussage] of faelle) {
    const d = deck()
    d[I.feature].text = text
    const r = run(d, { claims: [claim(I.feature, aussage)] })
    ok(`T49 Befund ${name}: Rest hängt → kontext, Text unverändert, Ampel rot`, r.report.skipped[0]?.reason === 'kontext' && stableEqual(r.blocks, d) && r.report.after.status === 'red',
      `${r.report.status} ${r.blocks[I.feature].text} ${JSON.stringify(r.report.skipped)}`)
  }
  // Gegenprobe: neutraler Folgesatz ohne Anschluss → Satz weg
  const d = deck()
  d[I.feature].text = 'Paphos welcomes visitors all winter. The complex is right on the beach. Demand from holidaymakers stays high all year.'
  const r = run(d, { claims: [claim(I.feature, EN)] })
  ok('T49 Gegenprobe EN ohne Anschluss → kein kontext, sondern fliesstext', bleibt(r, d, I.feature, 'behauptung_unsupported'), wieso(r))
}

// ── T50: Vorausweisender Satz davor (Prüfbefund 12.10.26, Runde 3) ─────────
{
  const DE = 'Die Anlage liegt direkt am Meer', EN = 'The complex is right on the beach'
  const faelle = [
    ['Das Beste daran?', 'Paphos hat auch im Winter Gäste. Das Beste daran? Die Anlage liegt direkt am Meer.', DE],
    ['Das Beste kommt zum Schluss', 'Paphos hat auch im Winter Gäste. Und das Beste kommt zum Schluss. Die Anlage liegt direkt am Meer.', DE],
    ['Warum gerade hier?', 'Warum gerade hier? Die Anlage liegt direkt am Meer. Langzeitmieter suchen moderne Wohnungen mit Pool.', DE],
    ['EN The best part?', 'Paphos welcomes visitors all winter. The best part? The complex is right on the beach.', EN],
    ['EN Here is why', 'Here is why investors love Paphos. The complex is right on the beach. Demand stays high.', EN],
    ['gestrichener Satz ist die Frage', 'Paphos hat auch im Winter Gäste. Liegt die Anlage direkt am Meer? Ja, nur wenige Schritte trennen dich vom Wasser.', 'Liegt die Anlage direkt am Meer'],
  ]
  for (const [name, text, aussage] of faelle) {
    const d = deck()
    d[I.feature].text = text
    const r = run(d, { claims: [claim(I.feature, aussage)] })
    ok(`T50 Befund ${name}: Frage oder Ankündigung bliebe allein → kontext, Text unverändert, Ampel rot`, r.report.skipped[0]?.reason === 'kontext' && stableEqual(r.blocks, d) && r.report.after.status === 'red',
      `${r.report.status} ${r.blocks[I.feature].text} ${JSON.stringify(r.report.skipped)}`)
  }
  // Absatz-Variante: der vorige Absatz endet mit einer Frage, der ganze Absatz fiele weg
  const d = deck()
  const p = d[I.letter].paragraphs
  d[I.letter].paragraphs = [p[0], 'Und was macht Emerald Park so besonders?', 'Die Anlage liegt direkt am Meer.', p[2]]
  const r = run(d, { claims: [claim(I.letter, DE)] })
  ok('T50 Absatz-Variante: voriger Absatz endet mit „?" → kontext, Brief unverändert', r.report.skipped[0]?.reason === 'kontext' && stableEqual(r.blocks, d), JSON.stringify(r.report.skipped))
}

// ── T51: Unbekannte Kürzel ohne Satzbruchstück (Prüfbefund 12.10.26, Runde 3) ──
{
  const s = (t) => splitSaetze(t).map(x => x.text.trim())
  ok('T51 splitSaetze trennt nicht nach Leof./Avda./allg./Gebr./Ausst./Erstbez./Wohnz./Schlafz.', [
    'Die Anlage liegt an der Leof. Poseidonos direkt am Meer.', 'Sie liegt an der Avda. Del Mar.', 'Sie liegt im allg. Wohngebiet.', 'Gebaut wird von Gebr. Ioannou.',
    'Die gehobene Ausst. Überzeugt.', 'Die Wohnung ist Erstbez. Mit Garantie.', 'Das Wohnz. Richtung Süden ist hell.', 'Zwei Schlafz. Mit Einbauschrank.',
  ].every(t => s(t + ' Ende folgt.').length === 2))
  ok('T51 sichereGrenze: unbekannte Kurzkürzel unsicher, normale Kurzwörter sicher',
    ['Die Möbel sind von Fabr. ', 'Sie liegt im zentr. ', 'Die Anlage liegt im südw. ', 'Gebaut von der gebr. ', 'Sie liegt an der Leof. ', 'Gebaut von Gebr. '].every(x => !sichereGrenze(x))
    && ['Die Lage ist ideal. ', 'Das Wasser ist kühl. ', 'Paphos has guests all year. ', 'The complex is right on the beach. ', 'Das ist die Wahl. ', 'Wir sehen uns im Jahr. ',
      'Die Anlage liegt am Meer. ', 'Paphos hat auch im Winter Gäste. ', 'Daneben liegt ein Park. '].every(x => sichereGrenze(x)))
  const faelle = [
    // [Name, Pfad, Text, Behauptung, erwarteter Grund: 'fliesstext' (Kürzel erkannt, Satz eindeutig) oder null = nicht_lokalisierbar]
    // Text bleibt in jedem Fall byte-gleich (Fließtext-Chirurgie aus).
    ['Leof.', 'feature.text', 'Die Anlage liegt an der Leof. Poseidonos direkt am Meer. Supermarkt und Cafés sind nah. Die Nachfrage ist das ganze Jahr über da.', 'Poseidonos direkt am Meer', 'fliesstext'],
    ['Avda.', 'feature.text', 'Die Anlage liegt an der Avda. Del Mar direkt am Meer. Supermarkt und Cafés sind nah. Die Nachfrage ist das ganze Jahr über da.', 'Del Mar direkt am Meer', 'fliesstext'],
    ['allg.', 'cols.1.text', 'Die Anlage liegt im allg. Wohngebiet direkt am Meer. Der Flughafen liegt rund 20 Minuten entfernt.', 'Wohngebiet direkt am Meer', null],
    ['Gebr.', 'feature.text', 'Gebaut wird von Gebr. Ioannou direkt am Meer. Die Nachfrage ist hoch.', 'Ioannou direkt am Meer', null],
    ['Ausst.', 'feature.text', 'Die Wohnung hat eine gehobene Ausst. Direkt am Meer gelegen ist sie ideal. Die Nachfrage ist hoch.', 'Direkt am Meer gelegen ist sie ideal', null],
    ['Erstbez.', 'feature.text', 'Die Wohnung ist Erstbez. Direkt am Meer gelegen ist sie ideal. Die Nachfrage ist hoch.', 'Direkt am Meer gelegen ist sie ideal', null],
    ['Wohnz.', 'feature.text', 'Das Wohnz. Richtung Süden liegt direkt am Meer. Die Nachfrage ist hoch.', 'Richtung Süden liegt direkt am Meer', null],
    ['Schlafz.', 'feature.text', 'Es gibt zwei Schlafz. Mit Blick auf den Strand liegt die Anlage direkt am Meer. Die Nachfrage ist hoch.', 'liegt die Anlage direkt am Meer', null],
    ['unbekannt Fabr.', 'feature.text', 'Die Möbel sind von Fabr. Direkt am Meer liegt die Anlage. Die Nachfrage ist hoch.', 'Direkt am Meer liegt die Anlage', null],
  ]
  const BI = { feature: I.feature, cols: I.columns }
  const setz = (b, pfad, v) => { const t = pfad.split('.'); let o = b; for (const k of t.slice(0, -1)) o = o[k]; o[t[t.length - 1]] = v }
  const hol = (b, pfad) => pfad.split('.').reduce((o, k) => o?.[k], b)
  for (const [name, pfad, text, aussage, soll] of faelle) {
    const bi = BI[pfad.split('.')[0]] ?? I.feature
    const feld = pfad.startsWith('feature.') ? pfad.slice(8) : pfad
    const d = deck()
    setz(d[bi], feld, text)
    const r = run(d, { claims: [claim(bi, aussage)] })
    const nachher = hol(r.blocks[bi], feld)
    const gut = stableEqual(r.blocks, d) && r.report.skipped.some(x => x.reason === (soll ?? 'nicht_lokalisierbar')) && r.report.after.status === 'red'
    ok(`T51 Kürzel ${name}: kein Satzbruchstück (${soll ?? 'nicht_lokalisierbar'}, Text unverändert)`, gut,
      `${r.report.status} ${nachher} ${JSON.stringify(r.report.skipped)}`)
  }
}

// ── T52: Zeilenlisten ohne Satzpunkt (Prüfbefund 12.10.26, Runde 3) ────────
{
  const faelle = [
    ['• Liste', 'Highlights:\n• Meerblick\n• direkt am Meer gelegen\n• Gemeinschaftspool\n• Fußbodenheizung'],
    ['- Liste', 'Highlights:\n- Meerblick\n- direkt am Meer gelegen\n- Gemeinschaftspool'],
    ['1. Liste', 'Highlights:\n1. Meerblick\n2. direkt am Meer gelegen\n3. Gemeinschaftspool'],
    ['Zeilen ohne Zeichen', 'Meerblick\ndirekt am Meer gelegen\nGemeinschaftspool'],
    ['Einzeilig mit •', 'Meerblick • direkt am Meer gelegen • Gemeinschaftspool'],
  ]
  for (const [name, text] of faelle) {
    const d = deck()
    d[I.unit].note = text
    const r = run(d, { claims: [claim(I.unit, 'direkt am Meer gelegen')] })
    ok(`T52 note ${name}: ganze Liste fiele weg → nicht_lokalisierbar, note unverändert, Ampel rot`, r.report.skipped[0]?.reason === 'nicht_lokalisierbar' && stableEqual(r.blocks, d)
      && r.report.after.status === 'red', `${r.report.status} ${JSON.stringify(r.blocks[I.unit].note)} ${JSON.stringify(r.report.skipped)}`)
  }
  // Gegenprobe: „ - " mitten im Satz ist keine Liste → Satz weg
  const d0 = deck()
  d0[I.unit].note = 'Die Einrichtung ist optional. Die Anlage liegt direkt am Meer - perfekt für Urlauber. Die Übergabe erfolgt schlüsselfertig.'
  const r0 = run(d0, { claims: [claim(I.unit, 'Die Anlage liegt direkt am Meer')] })
  ok('T52 Gegenprobe: „ - " mitten im Satz → keine Liste, sondern fliesstext', bleibt(r0, d0, I.unit, 'behauptung_unsupported'), wieso(r0))
  // Gegenprobe: Sätze mit Punkt auf eigenen Zeilen → nur der eine Satz weg
  const d = deck()
  d[I.unit].note = 'Die Einrichtung ist optional.\nDie Anlage liegt direkt am Meer.\nDie Übergabe erfolgt schlüsselfertig.'
  const r = run(d, { claims: [claim(I.unit, 'Die Anlage liegt direkt am Meer')] })
  ok('T52 Gegenprobe: Sätze mit Punkt je Zeile → keine Liste, sondern fliesstext', bleibt(r, d, I.unit, 'behauptung_unsupported'), wieso(r))
}

// ── T53: Nur ganze Einheiten (PROSA_CHIRURGIE aus, Sven 12.10.26) ───────────
{
  const MEER = 'direkt am Meer'
  // cover.tagline → feld_geleert
  const d1 = deck(); d1[I.cover].tagline = 'Wohnen direkt am Meer in Paphos'
  const r1 = run(d1, { claims: [claim(I.cover, MEER)] })
  ok('T53 cover.tagline mit „direkt am Meer" → feld_geleert, Ampel grün', r1.report.status === 'applied' && r1.blocks[I.cover].tagline === undefined
    && r1.report.changes.length === 1 && r1.report.changes[0].action === 'feld_geleert' && r1.report.after.status === 'green', wieso(r1))
  // unit.note nur „Preis X €" → entfernt
  const d2 = deck(); d2[I.unit].note = 'Preis 403.410 €'
  const r2 = run(d2)
  ok('T53 unit.note nur „Preis 403.410 €" → Notiz entfernt', runDeckGate(d2, ctx()).findings.some(f => f.key === 'preis_im_fliesstext')
    && r2.report.status === 'applied' && r2.blocks[I.unit].note === undefined && r2.report.changes[0]?.field === 'note'
    && !r2.findings.some(f => f.key === 'preis_im_fliesstext'), wieso(r2))
  // unit.note mit zwei Sätzen → fliesstext
  const d3 = deck(); d3[I.unit].note = 'Preis 403.410 €. Die Übergabe erfolgt schlüsselfertig.'
  const r3 = run(d3)
  ok('T53 unit.note mit zwei Sätzen → fliesstext, byte-gleich', r3.report.status === 'nothing_to_fix' && bleibt(r3, d3, I.unit, 'preis_im_fliesstext'), wieso(r3))
  // Zwei Sätze, BEIDE mit der Aussage: besteht nicht nur aus der Aussage → fliesstext
  const d3b = deck(); d3b[I.unit].note = 'Die Anlage liegt direkt am Meer, ideal für Familien. Für Urlauber liegt die Anlage direkt am Meer und nah an der Altstadt.'
  const r3b = run(d3b, { claims: [claim(I.unit, 'liegt die Anlage direkt am Meer')] })
  const r3c = run(d3b, { claims: [claim(I.unit, 'Anlage liegt direkt am Meer')] })
  ok('T53 Notiz mit zwei getroffenen Sätzen → nie ganz gelöscht (fliesstext/mehrdeutig)', bleibt(r3b, d3b, I.unit, 'behauptung_unsupported', ['fliesstext', 'mehrdeutig'])
    && bleibt(r3c, d3b, I.unit, 'behauptung_unsupported', ['fliesstext', 'mehrdeutig']), `${wieso(r3b)} ${wieso(r3c)}`)
  // letter: Absatz nur aus der Behauptung (Mitte) → entfernt; mit weiterem Satz → fliesstext;
  // erster und letzter Absatz → pflichtfeld
  const p0 = deck()[I.letter].paragraphs
  const d4 = deck(); d4[I.letter].paragraphs = [p0[0], 'Die Anlage liegt direkt am Meer.', p0[1], p0[2]]
  const r4 = run(d4, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  ok('T53 letter-Absatz nur aus der Behauptung (Mitte) → bleibt (fliesstext), Ampel rot', r4.report.status === 'nothing_to_fix'
    && bleibt(r4, d4, I.letter, 'behauptung_unsupported') && r4.report.after.status === 'red', wieso(r4))
  const d5 = deck(); d5[I.letter].paragraphs = [p0[0], 'Die Anlage liegt direkt am Meer. Supermarkt und Cafés sind nah.', p0[1], p0[2]]
  const r5 = run(d5, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  ok('T53 letter-Absatz mit Behauptung und weiterem Satz → fliesstext', bleibt(r5, d5, I.letter, 'behauptung_unsupported'), wieso(r5))
  const d6 = deck(); d6[I.letter].paragraphs = [p0[0], p0[1], 'Die Anlage liegt direkt am Meer.']
  const r6 = run(d6, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  const d7 = deck(); d7[I.letter].paragraphs = ['Die Anlage liegt direkt am Meer.', p0[1], p0[2]]
  const r7 = run(d7, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer')] })
  ok('T53 letter: letzter und erster Absatz nur aus der Behauptung → bleiben', bleibt(r6, d6, I.letter, 'behauptung_unsupported', ['pflichtfeld', 'fliesstext'])
    && bleibt(r7, d7, I.letter, 'behauptung_unsupported', ['pflichtfeld']), `${wieso(r6)} ${wieso(r7)}`)
  // feature.text und cols.text nur aus der Behauptung: Pflichttext bliebe leer → pflichtfeld
  const d8 = deck(); d8[I.feature].text = 'Die Anlage liegt direkt am Meer.'
  const r8 = run(d8, { claims: [claim(I.feature, 'Die Anlage liegt direkt am Meer')] })
  const d9 = deck(); d9[I.columns].cols[1].text = 'Die Anlage liegt direkt am Meer.'
  const r9 = run(d9, { claims: [claim(I.columns, 'Die Anlage liegt direkt am Meer')] })
  ok('T53 feature.text / cols.text nur aus der Behauptung → pflichtfeld, unverändert', bleibt(r8, d8, I.feature, 'behauptung_unsupported', ['pflichtfeld'])
    && bleibt(r9, d9, I.columns, 'behauptung_unsupported', ['pflichtfeld']), `${wieso(r8)} ${wieso(r9)}`)
  // quote: nur die Behauptung → entfernt; zwei Sätze → fliesstext
  const d10 = deck(); d10[I.feature].quote = 'Die Anlage liegt direkt am Meer.'
  const r10 = run(d10, { claims: [claim(I.feature, 'Die Anlage liegt direkt am Meer')] })
  const d11 = deck(); d11[I.feature].quote = 'Die Anlage liegt direkt am Meer. Supermarkt und Cafés sind nah.'
  const r11 = run(d11, { claims: [claim(I.feature, 'Die Anlage liegt direkt am Meer')] })
  ok('T53 feature.quote nur Behauptung → entfernt, mit zweitem Satz → fliesstext', r10.report.status === 'applied' && r10.blocks[I.feature].quote === undefined
    && r10.blocks[I.feature].text === d10[I.feature].text && bleibt(r11, d11, I.feature, 'behauptung_unsupported'), `${wieso(r10)} ${JSON.stringify(r10.blocks[I.feature])} ${wieso(r11)}`)
  // Kartentext nur aus der Behauptung → karte_entfernt (mindestens 3 bleiben); Behauptung in
  // einem von zwei Sätzen → fliesstext wie beim Gate-Befund (Runde 5)
  const d12 = deck(); d12[I.benefits].cards[4].text = 'Ein kleines Fitnessstudio direkt am Meer.'
  const r12 = run(d12, { claims: [claim(I.benefits, 'Ein kleines Fitnessstudio direkt am Meer')] })
  ok('T53 Kartentext nur aus der Behauptung → karte_entfernt, 5 Karten bleiben', r12.report.status === 'applied' && r12.report.changes[0]?.action === 'karte_entfernt'
    && r12.blocks[I.benefits].cards.length === 5 && !/Fitnessstudio/.test(JSON.stringify(r12.blocks[I.benefits])), wieso(r12))
  const d12b = deck(); d12b[I.benefits].cards[4].text = 'Ein kleines Fitnessstudio direkt am Meer. Kein Vertrag im Studio nötig.'
  const r12b = run(d12b, { claims: [claim(I.benefits, 'Ein kleines Fitnessstudio direkt am Meer')] })
  ok('T53 Behauptung in einem von zwei Sätzen der Karte → fliesstext, Karte bleibt', bleibt(r12b, d12b, I.benefits, 'behauptung_unsupported'), wieso(r12b))
  const d13 = deck(); d13[I.benefits].cards[5].text = 'Ein eigener Stellplatz kostet sonst 9.000 €. Parkplätze sind in Paphos knapp.'
  const r13 = run(d13)
  ok('T53 Kartentext mit Betrag in zwei Sätzen → fliesstext, Karte bleibt', bleibt(r13, d13, I.benefits, 'betrag_fremd'), wieso(r13))
  const d13b = deck(); d13b[I.benefits].cards[5].text = 'Ein eigener Stellplatz kostet sonst 9.000 €.'
  const r13b = run(d13b)
  ok('T53 Kartentext nur aus dem Betragssatz → ganze Karte entfernt', r13b.report.status === 'applied' && r13b.report.changes[0]?.action === 'karte_entfernt'
    && r13b.blocks[I.benefits].cards.length === 5, wieso(r13b))
  // specs „3 Schlafzimmer" bei CRM 2 → wert_gesetzt
  const d14 = deck(); d14[I.unit].specs[2] = '3 Schlafzimmer'
  const r14 = run(d14)
  ok('T53 specs „3 Schlafzimmer" (CRM 2) → wert_gesetzt „2 Schlafzimmer"', r14.report.status === 'applied' && r14.blocks[I.unit].specs[2] === '2 Schlafzimmer'
    && r14.report.changes.length === 1 && r14.report.changes[0].action === 'wert_gesetzt', wieso(r14))
  // specs „2 Schlafzimmer · 1 Bad" mit behauptung_conflict → punkt_entfernt
  const d15 = deck(); d15[I.unit].specs = ['84,5 m² Innenfläche', '16 m² Terrasse', '2 Schlafzimmer · 1 Bad', '1. Obergeschoss']
  const c15 = claim(I.unit, '2 Schlafzimmer · 1 Bad', 'high', 'conflict')
  const r15 = run(d15, { claims: [c15] })
  ok('T53 specs „2 Schlafzimmer · 1 Bad" mit behauptung_conflict → punkt_entfernt', c15.key === 'behauptung_conflict' && r15.report.status === 'applied'
    && JSON.stringify(r15.blocks[I.unit].specs) === JSON.stringify(['84,5 m² Innenfläche', '16 m² Terrasse', '1. Obergeschoss'])
    && r15.report.changes[0]?.action === 'punkt_entfernt' && !r15.findings.includes(c15), wieso(r15))
}

// ── T54: Michels Realfall (Mamba, 12.10.26): „direkt am Meer" in Tagline, Anschreiben und Spalte ─
{
  const d = deck()
  d[I.cover].tagline = 'Schlüsselfertig möbliert, mit Gemeinschaftspool - direkt am Meer in Paphos.'
  d[I.letter].paragraphs[1] = 'Emerald Park liegt in Paphos direkt am Meer, genau dort, wo die Stadt am ruhigsten wirkt. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.'
  d[I.columns].cols[0].text = 'Ein gewachsener Ort mit Straßen und Geschäften, direkt am Meer. Kleine Cafés und Bäckereien liegen um die Ecke.'
  const inp = clone(d)
  // Die Faktenprüfung meldet die Aussage je Block (wie im Realfall: Block 0 und 1 getrennt)
  const cs = [claim(I.cover, 'direkt am Meer'), claim(I.letter, 'direkt am Meer'), claim(I.columns, 'direkt am Meer')]
  const r = run(d, { claims: cs })
  ok('T54 Michel: nur die Tagline bereinigt (feld_geleert)', r.report.status === 'applied' && r.report.changes.length === 1
    && r.report.changes[0].action === 'feld_geleert' && r.report.changes[0].block === I.cover && r.blocks[I.cover].tagline === undefined, wieso(r))
  ok('T54 Michel: Anschreiben und Spalte byte-gleich (fliesstext)', JSON.stringify(r.blocks[I.letter]) === JSON.stringify(inp[I.letter])
    && JSON.stringify(r.blocks[I.columns]) === JSON.stringify(inp[I.columns])
    && [I.letter, I.columns].every(bi => r.report.skipped.some(x => x.block === bi && x.reason === 'fliesstext')), wieso(r))
  ok('T54 Michel: Ampel bleibt rot (2 Rest-Befunde), Tagline-Befund behoben', r.report.before.red === 3 && r.report.after.status === 'red' && r.report.after.red === 2
    && !r.findings.includes(cs[0]) && r.findings.includes(cs[1]) && r.findings.includes(cs[2])
    && r.report.fixed_findings.some(x => x.block === I.cover && x.via === 'korrektur'), `${r.report.before.red} -> ${r.report.after.red} ${wieso(r)}`)
  ok('T54 Michel: gesperrte Blöcke und deterministische Felder unverändert', lockedByteGleich(inp, r.blocks) && detGleich(inp, r.blocks))
  // Ohne eigenen Befund für die anderen Blöcke bliebe die Aussage unbemerkt stehen → Tagline nicht bereinigt
  const r2 = run(clone(inp), { claims: [claim(I.cover, 'direkt am Meer')] })
  ok('T54 nur Tagline-Befund, Aussage steht noch ungemeldet im Anschreiben → ziel_nicht_behoben, kein falsches Grün', r2.report.status === 'nothing_to_fix'
    && r2.report.skipped.some(x => x.block === I.cover && x.reason === 'ziel_nicht_behoben') && stableEqual(r2.blocks, inp) && r2.report.after.status === 'red', wieso(r2))
}

// ── T56: Prüfbefunde Runde 4 (12.10.26) ────────────────────────────────────
{
  const p0 = deck()[I.letter].paragraphs
  const GRUENDE = ['fliesstext', 'nicht_lokalisierbar']
  // 1) Kürzel am Satzende (inkl., zzgl., Tel., Str., & Co., Ave.): ganze Einheit nie weg
  const notizen = [
    ['Stellplatz und Abstellraum sind inkl. Der Gesamtpreis liegt bei 403.410 € brutto.', 'preis_im_fliesstext'],
    ['Der Gesamtpreis liegt bei 403.410 € brutto, Nebenkosten zzgl. Die Übergabe erfolgt schlüsselfertig.', 'preis_im_fliesstext'],
    ['Parking and storage incl. The total price is 403.410 € gross.', 'preis_im_fliesstext'],
    ['Fragen gern per Tel. Die Mietrendite liegt bei 6 % netto.', 'renditeaussage'],
    ['Die Anlage liegt an der Agiou Georgiou Str. Die Mietrendite liegt bei 6 % netto.', 'renditeaussage'],
  ]
  for (const [note, key] of notizen) {
    const d = deck(); d[I.unit].note = note
    const gemeldet = runDeckGate(d, ctx()).findings.some(f => f.key === key && f.block === I.unit)
    const r = run(d)
    ok(`T56 Notiz mit Kürzel am Satzende bleibt ganz: „${note.slice(0, 40)}…"`, gemeldet && r.report.status === 'nothing_to_fix'
      && bleibt(r, d, I.unit, key, GRUENDE) && r.blocks[I.unit].note === note, `${gemeldet} ${wieso(r)}`)
  }
  for (const [text, c] of [
    ['Gebaut wird von Ioannou & Co. Die Anlage liegt direkt am Meer mit eigenem Strandzugang.', 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang'],
    ['You will find it just off Poseidonos Ave. The complex sits right on the beach with private sea access.', 'The complex sits right on the beach with private sea access'],
  ]) {
    const d = deck(); d[I.letter].paragraphs = [p0[0], text, p0[1], p0[2]]
    const r = run(d, { claims: [claim(I.letter, c)] })
    ok(`T56 Absatz mit Kürzel am Satzende bleibt ganz: „${text.slice(0, 40)}…"`, r.report.status === 'nothing_to_fix'
      && bleibt(r, d, I.letter, 'behauptung_unsupported', GRUENDE) && r.report.after.status === 'red', wieso(r))
  }
  const dk = deck(); dk[I.benefits].cards[5].text = 'Stellplatz inkl. Er kostet sonst 9.000 €.'
  const rk = run(dk)
  ok('T56 Kartentext mit Kürzel am Satzende → Karte bleibt', bleibt(rk, dk, I.benefits, 'betrag_fremd', GRUENDE), wieso(rk))
  ok('T56 innererSatzpunkt: Kürzel vor Großbuchstabe/Ziffer ja, Satzende/klein nein', innererSatzpunkt('inkl. Der Preis.') && innererSatzpunkt('ca. 7 km.')
    && !innererSatzpunkt('Preis 403.410 €') && !innererSatzpunkt('Die Anlage liegt direkt am Meer.') && !innererSatzpunkt('z.B. die Lage.'))

  // 2) Der gestrichene Absatz kündigt selbst etwas an (Doppelpunkt, „folgende")
  for (const [ank, liste, c] of [
    ['Direkt am Meer mit eigenem Strandzugang bietet die Anlage folgende Extras:', 'Pool, Gym und ein Café im Erdgeschoss.', 'Direkt am Meer mit eigenem Strandzugang'],
    ['Right on the beach with private sea access, the complex offers these extras:', 'Pool, gym and a café.', 'Right on the beach with private sea access'],
  ]) {
    const d = deck(); d[I.letter].paragraphs = [p0[0], ank, liste, p0[2]]
    const r = run(d, { claims: [claim(I.letter, c)] })
    ok(`T56 Ankündigung mit Doppelpunkt bleibt: „${ank.slice(0, 35)}…"`, r.report.status === 'nothing_to_fix'
      && bleibt(r, d, I.letter, 'behauptung_unsupported', ['kontext']), wieso(r))
  }

  // 3) Angekündigte Anzahl zwei Absätze vor dem gestrichenen
  for (const anz of ['Drei Dinge sprechen für Emerald Park.', 'Three things make this project special.']) {
    const d = deck(); d[I.letter].paragraphs = [p0[0], anz, 'Die Wohnstraße ist ruhig und grün.', 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang.', 'Die Wohnungen sind modern ausgestattet.', p0[2]]
    const r = run(d, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang')] })
    ok(`T56 Anzahl zwei Absätze vorher („${anz.slice(0, 20)}…") → kontext`, r.report.status === 'nothing_to_fix'
      && bleibt(r, d, I.letter, 'behauptung_unsupported', ['kontext']), wieso(r))
  }
  // Gegenprobe ohne Ankündigung: seit Runde 5 fällt auch dann kein Absatz weg (fliesstext)
  {
    const d = deck(); d[I.letter].paragraphs = [p0[0], 'Die Wohnstraße ist ruhig und grün.', 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang.', 'Die Wohnungen sind modern ausgestattet.', p0[2]]
    const r = run(d, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang')] })
    ok('T56 Gegenprobe ohne Ankündigung → Absatz bleibt (fliesstext)', r.report.status === 'nothing_to_fix'
      && bleibt(r, d, I.letter, 'behauptung_unsupported'), wieso(r))
  }

  // 4) „solch*" verweist auf die gestrichene Aussage
  for (const folge of ['Eine solche Lage findest du in Paphos kaum noch.', 'Solche Lagen sind in Paphos selten geworden.']) {
    const d = deck(); d[I.letter].paragraphs = [p0[0], 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang.', folge, p0[2]]
    const r = run(d, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang')] })
    ok(`T56 Folgeabsatz „${folge.slice(0, 18)}…" → kontext`, beginntMitVerweis(folge) && r.report.status === 'nothing_to_fix'
      && bleibt(r, d, I.letter, 'behauptung_unsupported', ['kontext']), wieso(r))
  }
  ok('T56 beginntMitVerweis: solcher/solches/such', beginntMitVerweis('Ein solcher Ausblick ist selten.') && beginntMitVerweis('Such a location is rare.'))

  // 5) Anrede als eigener Absatz: der Brief verliert nie seinen ganzen Inhalt
  {
    const d = deck(); d[I.letter].paragraphs = ['Hallo Max,', 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang.', 'Ich freue mich auf dich.']
    const r = run(d, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang')] })
    ok('T56 Anrede + Behauptung + Schluss → Brief unverändert', r.report.status === 'nothing_to_fix'
      && bleibt(r, d, I.letter, 'behauptung_unsupported', ['pflichtfeld', 'fliesstext']), wieso(r))
    const d2 = deck(); d2[I.letter].paragraphs = ['Hallo Max,', p0[1], 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang.', 'Ich freue mich auf dich.']
    const r2 = run(d2, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang')] })
    ok('T56 Anrede + 1 Inhalt + Behauptung + Schluss → Brief unverändert', bleibt(r2, d2, I.letter, 'behauptung_unsupported', ['pflichtfeld', 'fliesstext']), wieso(r2))
    const d3 = deck(); d3[I.letter].paragraphs = ['Hallo Max,', p0[1], 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang.', 'Die Wohnungen sind modern ausgestattet.', 'Ich freue mich auf dich.']
    const r3 = run(d3, { claims: [claim(I.letter, 'Die Anlage liegt direkt am Meer mit eigenem Strandzugang')] })
    ok('T56 Anrede + 2 Inhalte + Behauptung + Schluss → Brief unverändert (fliesstext)', r3.report.status === 'nothing_to_fix'
      && bleibt(r3, d3, I.letter, 'behauptung_unsupported'), wieso(r3))
  }

  // 6) Ein-Wort-Aussage: Prüfung „steht nirgends mehr" sucht auch in längerem Text
  {
    const d = deck()
    d[I.unit].specs.push('Meerblick')
    d[I.letter].paragraphs[1] = 'Emerald Park liegt in einem ruhigen Wohngebiet von Paphos, mit Meerblick. Die Anlage hat einen Gemeinschaftspool und ein kleines Gym. Supermarkt, Schulen und Cafés sind in wenigen Minuten erreichbar.'
    const inp = clone(d)
    const r = run(d, { claims: [claim(I.unit, 'Meerblick')] })
    ok('T56 Ein-Wort-Aussage noch im Anschreiben → ziel_nicht_behoben, kein falsches Grün', r.report.status === 'nothing_to_fix'
      && r.report.skipped.some(x => x.block === I.unit && x.reason === 'ziel_nicht_behoben') && stableEqual(r.blocks, inp)
      && r.report.after.status === 'red' && !r.report.fixed_findings.length, wieso(r))
    const dh = deck(); dh[I.unit].specs.push('Meerblick'); dh[I.unit].kicker = 'Deine Wohnung mit Meerblick'
    const rh = run(dh, { claims: [claim(I.unit, 'Meerblick')] })
    ok('T56 Ein-Wort-Aussage noch im gesperrten kicker desselben Blocks → nicht bereinigt', rh.report.status === 'nothing_to_fix'
      && rh.report.after.status === 'red' && stableEqual(rh.blocks[I.unit].specs, dh[I.unit].specs), wieso(rh))
    const dn = deck(); dn[I.unit].specs.push('Café')
    const rn = run(dn, { claims: [claimIssuesToFindings([{ claim: 'Café', severity: 'high', status: 'unsupported', reason: 'x' }])[0]] })
    ok('T56 Ein-Wort-Aussage ohne Block, auch im Amenity-Intro (Systemblock) → systemblock', rn.report.status === 'nothing_to_fix'
      && rn.report.skipped.some(x => x.reason === 'systemblock') && stableEqual(rn.blocks, dn), wieso(rn))
    const dg = deck(); dg[I.unit].specs.push('Meerblick')
    const rg = run(dg, { claims: [claim(I.unit, 'Meerblick')] })
    ok('T56 Gegenprobe: Ein-Wort-Aussage nur als Listenpunkt → punkt_entfernt, grün', rg.report.status === 'applied'
      && rg.report.changes[0]?.action === 'punkt_entfernt' && !rg.blocks[I.unit].specs.includes('Meerblick') && rg.report.after.status === 'green', wieso(rg))
  }
}

// ── T55: Knopf „Im Deck-Chat beheben" (Anweisung immer deutsch, nichts automatisch senden) ─
{
  // Michels Realfall nach der Autobereinigung: Rest-Befunde aus Anschreiben und Spalte,
  // dazu Gate-Befunde, die nur per Text behebbar sind, und einer, der es nicht ist.
  const d = deck()
  d[I.letter].paragraphs[1] = 'Emerald Park liegt in Paphos direkt am Meer. Die Wohnung hat 3 Schlafzimmer und kostet 403.410 € brutto.'
  d[I.unit].note = 'Der Gesamtpreis liegt bei 403.410 € brutto. Die Übergabe erfolgt schlüsselfertig.'
  const cs = [claim(I.letter, 'direkt am Meer'), claim(I.columns, 'dem Meer direkt vor der Tür'), { ...claim(I.unit, '2 Schlafzimmer · 1 Bad', 'high', 'conflict'), evidence: "CRM: 'baeder': 2 für Wohnung C-105." },
    claim(I.unit, '2 Schlafzimmer · 1 Bad', 'high', 'conflict')]
  const gate = runDeckGate(d, ctx()).findings
  const alle = [...gate, ...cs, { key: 'zahlungsplan_fehlt', severity: 'hoch', what: 'Zahlungsplan fehlt.' }]
  const liste = chatBehebbar(alle)
  const txt = baueChatAnweisung(alle)
  const zeilen = txt.split('\n')
  ok('T55 nur per Text behebbare Befunde, ohne Doppelte', liste.length === 5 && liste.every(f => f.key !== 'zahlungsplan_fehlt')
    && liste.filter(f => f.key === 'behauptung_conflict').length === 1, JSON.stringify(liste.map(f => `${f.key}@${f.block}`)))
  ok('T55 Kopfzeile und nummerierte Liste', zeilen[0] === 'Bitte korrigiere nur diese Stellen und ändere sonst nichts am Deck:'
    && zeilen.length === 6 && zeilen.slice(1).every((z, i) => z.startsWith(`${i + 1}. Block `)), txt)
  const z = (re) => zeilen.find(x => re.test(x)) ?? ''
  ok('T55 Behauptung: Block, Aussage im Wortlaut, streichen oder belegt ersetzen', /^\d\. Block 1: „direkt am Meer“\. Unbelegte Aussage streichen oder durch eine belegte Formulierung ersetzen\.$/.test(z(/direkt am Meer/)), z(/direkt am Meer/))
  ok('T55 Zimmerzahl: Wert aus den Stammdaten', /Block 1, Absatz 2: „3 Schlafzimmer“\. Zahl auf den Wert aus den Stammdaten setzen: 2\./.test(z(/3 Schlafzimmer/)), z(/3 Schlafzimmer/))
  ok('T55 Preis im Fließtext: Preis raus, Preisbox bleibt', /Block 2, Hinweis: „403\.410 €“\. Preis aus dem Fließtext nehmen\. Die Preisbox bleibt unverändert\./.test(z(/Preisbox/)), z(/Preisbox/))
  ok('T55 Widerspruch: Stammdaten aus evidence', /„2 Schlafzimmer · 1 Bad“\. Aussage widerspricht den Stammdaten \(laut Prüfung: CRM: 'baeder': 2 für Wohnung C-105\)\. Auf die Stammdaten richtigstellen oder streichen\.$/.test(z(/widerspricht/)), z(/widerspricht/))
  ok('T55 Anweisung ohne Gedankenstriche, echte Umlaute', !/[—–]/.test(txt) && /ändere/.test(txt) && !/aendere|Praeis/.test(txt))
  ok('T55 englisches Deck: Anweisung trotzdem deutsch', baueChatAnweisung([claim(I.feature, 'The complex is right on the beach')]).startsWith('Bitte korrigiere nur diese Stellen'))
  ok('T55 keine behebbaren Befunde → leere Anweisung', baueChatAnweisung([{ key: 'zahlungsplan_fehlt', severity: 'hoch', what: 'x' }]) === '' && baueChatAnweisung([]) === '')
  // Verdrahtung (Quelltext, kein Browser): Panel-Knopf, Chat-Vorbefüllung ohne Auto-Senden, LeadAngebote
  const { readFileSync } = await import('fs')
  const panel = readFileSync('src/components/crm/DeckQualityPanel.tsx', 'utf8')
  const chat = readFileSync('src/components/crm/DeckChat.tsx', 'utf8')
  const la = readFileSync('src/components/crm/LeadAngebote.tsx', 'utf8')
  const de = JSON.parse(readFileSync('src/locales/de.json', 'utf8')), en = JSON.parse(readFileSync('src/locales/en.json', 'utf8'))
  ok('T55 Panel: optionales onFixInChat, Knopf nur bei behebbaren Befunden', /onFixInChat\?: \(instruction: string\) => void/.test(panel)
    && /onFixInChat && chatFixes\.length > 0/.test(panel) && /onFixInChat\(baueChatAnweisung\(findings\)\)/.test(panel))
  ok('T55 DeckChat: initialInput füllt nur das Feld vor, kein Senden beim Öffnen', /initialInput\?: string/.test(chat) && /useState\(initialInput \?\? ''\)/.test(chat)
    && !/useEffect\([^)]*send\(/.test(chat) && (chat.match(/void send\(\)/g) ?? []).length === 2)
  ok('T55 LeadAngebote: Panel zu, Chat für dasselbe Deck mit Anweisung auf', /setQuality\(null\); setChat\(\{ token: q\.token, label: q\.label, initialInput: instruction \}\)/.test(la)
    && /initialInput=\{chat\.initialInput\}/.test(la))
  // Prüfbefund Runde 4: Während eines laufenden Feinschliffs (refining) kein Chat aus dem Panel
  ok('T55 LeadAngebote: kein Chat-Knopf im Panel, solange das Deck in Bearbeitung ist', /onFixInChat=\{deckMeta\[quality\.token\]\?\.refining \? undefined : instruction => \{/.test(la)
    && /if \(deckMeta\[q\.token\]\?\.refining\) return/.test(la))
  ok('T55 Locale-Schlüssel DE/EN, ohne Gedankenstrich, DE mit Umlauten', [de, en].every(l => ['fixInChat', 'fixInChatTitle', 'fixInChatHint'].every(k => l.deckQuality?.[k] && !/[—–]/.test(l.deckQuality[k])))
    && /{{n}}/.test(de.deckQuality.fixInChat) && /{{n}}/.test(en.deckQuality.fixInChat) && /Öffnet|für/.test(de.deckQuality.fixInChatTitle + de.deckQuality.fixInChatHint))

  // Prüfbefund Runde 5: onStarted kam erst nach pollDone, also nach dem Lauf. Verhaltenstest
  // mit einer nachgebauten Angebots-Liste: Chat sendet, Lauf läuft (warten hängt), Chat zu,
  // Panel wieder auf - der Knopf darf nicht da sein, ein zweiter Lauf nicht starten.
  {
    const meta = { refining: false }                               // deckMeta[token] der Liste
    const onRefineStarted = () => { meta.refining = true }         // wie LeadAngebote.onRefineStarted
    const panelKnopf = () => !meta.refining                        // onFixInChat={refining ? undefined : ...}
    const ablauf = []; let aufrufe = 0; let fertig
    const invoke = async () => { aufrufe++; ablauf.push('invoke'); return { error: null } }
    const warten = () => { ablauf.push('warten'); return new Promise(res => { fertig = res }) }
    const erster = starteFeinschliff({ invoke, onStarted: () => { ablauf.push('started'); onRefineStarted() }, warten })
    await new Promise(r => setTimeout(r, 0))                       // Lauf gestartet, noch nicht fertig
    ok('T55 Verhalten: onStarted direkt nach dem Start, vor dem Warten', JSON.stringify(ablauf) === '["invoke","started","warten"]', JSON.stringify(ablauf))
    ok('T55 Verhalten: während des Laufs Deck „in Bearbeitung", Panel ohne Chat-Knopf', meta.refining === true && panelKnopf() === false)
    // Chat zu, Panel auf, Knopf (falls doch da) geklickt: der Handler bricht bei refining ab
    const knopfHandler = () => { if (meta.refining) return; void starteFeinschliff({ invoke, onStarted: onRefineStarted, warten: async () => ({}) }) }
    knopfHandler()
    await new Promise(r => setTimeout(r, 0))
    ok('T55 Verhalten: kein zweiter refine-deck-Aufruf, solange der erste läuft', aufrufe === 1, String(aufrufe))
    fertig({ summary: 'ok' })
    ok('T55 Verhalten: Ergebnis des Laufs kommt zurück', (await erster)?.summary === 'ok')
    // Fehler beim Start: nie als „in Bearbeitung" markieren
    const m2 = { refining: false }
    let fehler = ''
    await starteFeinschliff({ invoke: async () => ({ error: { message: 'kaputt' } }), onStarted: () => { m2.refining = true }, warten: async () => ({}) })
      .catch(e => { fehler = e.message })
    ok('T55 Verhalten: Startfehler → Fehler, kein onStarted', fehler === 'kaputt' && m2.refining === false)
    ok('T55 DeckChat: send nutzt starteFeinschliff, kein onStarted nach pollDone', /starteFeinschliff\(\{/.test(chat) && /warten: pollDone/.test(chat)
      && !/await pollDone\(\)/.test(chat), chat.match(/const send = [\s\S]*?\n  \}\n/)?.[0] ?? '')
  }
}

// ── T57: Chat-Anweisung bei Flächenbefunden (Prüfbefund 12.10.26, Runde 4) ──
{
  // Weiche Befunde (mittel) außerhalb der Wohnungsblöcke: nur prüfen, nie überschreiben lassen
  const d = deck()
  d[I.columns].cols[2].text = 'Im Norden von Paphos entstehen neue Schulen. Das Grundstück des Projekts umfasst 4.200 m².'
  d[I.feature].text = 'Paphos hat auch im Winter Gäste. Die Penthouse-Wohnungen ganz oben haben bis zu 150 m² Dachterrasse. Die Nachfrage ist das ganze Jahr über da.'
  const g = runDeckGate(d, ctx()).findings.filter(f => f.key === 'flaeche_abweichung')
  ok('T57 Gate: zwei weiche Flächenbefunde (mittel)', g.length === 2 && g.every(f => f.severity === 'mittel'), keys(g))
  ok('T57 weiche Flächenbefunde nicht im Chat-Knopf, keine Anweisung', chatBehebbar(g).length === 0 && baueChatAnweisung(g) === '')
  // Harter Befund im Wohnungsblock: Stammwerte mit Bedeutung statt blanker Liste
  const d2 = deck(); d2[I.unit].specs[0] = '90 m² Innenfläche'
  const h = runDeckGate(d2, ctx()).findings.filter(f => f.key === 'flaeche_abweichung')
  const txt = baueChatAnweisung(h)
  ok('T57 harter Flächenbefund: Gate liefert Stammwerte mit Bedeutung', h.length === 1 && h[0].severity === 'hoch'
    && h[0].stamm === 'C-105: Innenfläche 84,5 m², Terrasse 16 m², gesamt 100,5 m²', JSON.stringify(h))
  ok('T57 Anweisung nennt, welcher Wert wofür steht', chatBehebbar(h).length === 1
    && txt.includes('(C-105: Innenfläche 84,5 m², Terrasse 16 m², gesamt 100,5 m²)') && !/84,5 \/ 16/.test(txt) && !/[—–]/.test(txt), txt)
  // Älterer Bericht ohne stamm: Werteliste nur mit Hinweis auf die möglichen Bedeutungen
  const alt = baueChatAnweisung([{ ...h[0], stamm: undefined }])
  ok('T57 älterer Bericht ohne stamm: Bedeutungen genannt, sonst streichen', /84,5 \/ 16 \/ 100,5 m² \(Innenfläche, Terrasse, Grundstück oder Innenfläche plus Terrasse\)\. Ist nicht eindeutig/.test(alt), alt)
}

// ── T58: Prüfbefunde Runde 5 (12.10.26): keine ganzen Absätze, Karten nur bei reiner Aussage ─
{
  const p0 = deck()[I.letter].paragraphs
  const MEER = 'Die Anlage liegt direkt am Meer'
  // 1) Rückverweis im Folgeabsatz, den keine Wortliste kennt
  const folgen = ['Wie erwähnt, ist der Strand auch für Mieter ein starkes Argument.', 'Wie bereits gesagt, lieben Feriengäste diese Nähe.',
    'Gleiches gilt für den Gemeinschaftspool der Anlage.', 'Apropos Meer: Der Hafen von Paphos ist ebenfalls nah.', 'Im Gegenteil, auch im Winter ist hier viel los.',
    'Erst recht im Sommer ist das Gold wert.', 'Speaking of which, holiday guests love being close to the sea.', 'The same goes for the communal pool.',
    'Both make the apartment attractive for holiday guests.']
  for (const x of folgen) {
    const d = deck(); d[I.letter].paragraphs = [p0[0], p0[1], 'Die Anlage liegt direkt am Meer.', x, p0[2]]
    const r = run(d, { claims: [claim(I.letter, MEER)] })
    ok(`T58 Folgeabsatz „${x.slice(0, 28)}…": Absatz bleibt, Ampel rot`, r.report.status === 'nothing_to_fix' && stableEqual(r.blocks, d)
      && r.report.after.status === 'red' && !r.report.changes.length && r.report.skipped.some(s => s.block === I.letter), wieso(r))
  }
  // 2) Ankündigung im Vorabsatz, Aufzählung mit Ordinalwort, Anzahl in der Überschrift, Schluss vor PS
  const faelle = [
    ['(a) „Hier die wichtigsten Eckdaten."', [p0[0], p0[1], 'Hier die wichtigsten Eckdaten.', 'Die Wohnung hat 3 Schlafzimmer.', p0[2]], null, null],
    ['(b) „Mein Lieblingsargument kommt jetzt."', [p0[0], p0[1], 'Mein Lieblingsargument kommt jetzt.', 'Die Anlage liegt direkt am Meer.', p0[2]], MEER, null],
    ['(b) „Ein Punkt ist mir besonders wichtig."', [p0[0], p0[1], 'Ein Punkt ist mir besonders wichtig.', 'Die Anlage liegt direkt am Meer.', p0[2]], MEER, null],
    ['(b) EN „Here is my favourite part."', [p0[0], p0[1], 'Emerald Park is quiet. Here is my favourite part.', 'The complex is right on the beach.', p0[2]], 'The complex is right on the beach', null],
    ['(c) Erster/Zweiter/Dritter Punkt', [p0[0], 'Erster Punkt: Die Wohnstraße ist ruhig.', 'Zweiter Punkt: Die Anlage liegt direkt am Meer.', 'Dritter Punkt: Der Flughafen ist nah.', p0[2]], 'Zweiter Punkt: Die Anlage liegt direkt am Meer', null],
    ['(c) EN first/second/third reason', [p0[0], 'The first reason: the street is quiet.', 'The second reason: the complex is right on the beach.', 'The third reason: the airport is close.', p0[2]], 'The second reason: the complex is right on the beach', null],
    ['(d) Überschrift „Drei Gründe"', [p0[0], 'Die Wohnstraße ist ruhig und grün.', 'Die Anlage liegt direkt am Meer.', 'Der Flughafen ist nah.', p0[2]], MEER, 'Drei Gründe für Emerald Park'],
    ['(d) EN headline „Three reasons"', [p0[0], 'The street is quiet and green.', 'The complex is right on the beach.', 'The airport is close.', p0[2]], 'The complex is right on the beach', 'Three reasons for Emerald Park'],
    ['(e) Schluss vor dem PS', [p0[0], p0[1], p0[2], 'Ich freue mich darauf, dir die Wohnung mit direktem Meerzugang zu zeigen.', 'PS: Die Reservierung ist kostenlos.'], 'mit direktem Meerzugang', null],
  ]
  for (const [name, absaetze, aussage, headline] of faelle) {
    const d = deck(); d[I.letter].paragraphs = absaetze
    if (headline) d[I.letter].headline = headline
    const r = run(d, aussage ? { claims: [claim(I.letter, aussage)] } : {})
    const befund = aussage ? true : runDeckGate(d, ctx()).findings.some(f => f.key === 'zimmer_abweichung' && f.block === I.letter)
    ok(`T58 ${name}: kein Absatz weg, Brief byte-gleich, Ampel rot`, befund && r.report.status === 'nothing_to_fix' && stableEqual(r.blocks, d)
      && r.report.after.status === 'red' && !r.report.changes.length, wieso(r))
  }
  // 3) Behauptung im zweiten Satz einer Karte: Karte bleibt (fliesstext), wie beim Gate-Befund
  for (const [name, ci, karte, aussage] of [
    ['Fußbodenheizung', 0, { icon: '🔥', title: 'Fußbodenheizung', text: 'Angenehme Wärme im Winter in allen Räumen. Spart bis zu 40 Prozent Heizkosten.' }, 'Spart bis zu 40 Prozent Heizkosten'],
    ['Gemeinschaftspool', 3, { icon: '🏊', title: 'Gemeinschaftspool', text: 'Der Pool der Anlage steht allen Bewohnern offen. Er ist ganzjährig beheizt.' }, 'Er ist ganzjährig beheizt'],
    ['EN Underfloor heating', 0, { icon: '🔥', title: 'Underfloor heating', text: 'Warm floors in every room during winter. Cuts heating bills by 40 percent.' }, 'Cuts heating bills by 40 percent'],
  ]) {
    const d = deck(); d[I.benefits].cards[ci] = karte
    const r = run(d, { claims: [claim(I.benefits, aussage)] })
    ok(`T58 Karte „${name}": Behauptung im zweiten Satz → Karte bleibt (fliesstext), Ampel rot`, r.report.status === 'nothing_to_fix'
      && bleibt(r, d, I.benefits, 'behauptung_unsupported', ['fliesstext', 'kontext']) && r.blocks[I.benefits].cards.length === 6 && r.report.after.status === 'red', wieso(r))
  }
  // Gegenproben: Treffer im Kartentitel → ganze Karte; Kartentext nur aus der Aussage → ganze Karte
  {
    const d = deck(); d[I.benefits].cards[2] = { icon: '☀️', title: 'Photovoltaik auf dem Dach', text: 'Senkt die Nebenkosten spürbar.' }
    const r = run(d, { claims: [claim(I.benefits, 'Photovoltaik auf dem Dach')] })
    ok('T58 Gegenprobe: Behauptung im Kartentitel → karte_entfernt', r.report.status === 'applied' && r.report.changes[0]?.action === 'karte_entfernt'
      && r.blocks[I.benefits].cards.length === 5 && !/Photovoltaik/.test(JSON.stringify(r.blocks[I.benefits])), wieso(r))
    const d2 = deck(); d2[I.benefits].cards[0] = { icon: '🔥', title: 'Fußbodenheizung', text: 'Spart bis zu 40 Prozent Heizkosten.' }
    const r2 = run(d2, { claims: [claim(I.benefits, 'Spart bis zu 40 Prozent Heizkosten')] })
    ok('T58 Gegenprobe: Kartentext nur aus der Aussage → karte_entfernt', r2.report.status === 'applied' && r2.report.changes[0]?.action === 'karte_entfernt'
      && r2.blocks[I.benefits].cards.length === 5, wieso(r2))
  }
}

// ── T59: Endpruefung 13.10.26 - kein falsches Gruen, wenn die Aussage formatiert noch woanders steht ─
{
  for (const [name, setze] of [
    ['note mit **', d => { d[I.unit].note = 'Die Einrichtung ist optional. **Direkter Meerblick** aus jedem Zimmer.' }],
    ['feature mit <b>', d => { d[I.feature].text = 'Paphos hat auch im Winter Gäste. <b>Direkter Meerblick</b> aus jedem Zimmer.' }],
    ['Spalte mit weichem Trennstrich', d => { d[I.columns].cols[0].text = 'Ruhige Wohnstraßen. Direkter Meer\u00ADblick aus jedem Zimmer.' }],
  ]) {
    const d = deck(); d[I.cover].tagline = 'Direkter Meerblick aus jedem Zimmer.'; setze(d)
    const r = run(d, { claims: [claim(I.cover, 'Direkter Meerblick aus jedem Zimmer')] })
    ok(`T59 ${name}: Aussage steht formatiert noch im Deck → kein Gruen`, r.report.after?.status !== 'green' && r.report.status !== 'applied', wieso(r))
  }
  {
    const d = deck(); d[I.letter].paragraphs[1] = 'Emerald Park liegt ruhig. Nur 5&nbsp;Minuten zum Strand. Supermarkt und Cafés sind nah.'
    d[I.cover].tagline = 'Nur 5 Minuten zum Strand.'
    const r = run(d, { claims: [claim(I.cover, 'Nur 5 Minuten zum Strand')] })
    ok('T59 Absatz mit &nbsp;: Aussage steht noch → kein Gruen', r.report.after?.status !== 'green' && r.report.status !== 'applied', wieso(r))
  }
}
// ── T60: Anweisung - weiche Befunde als Pruefbitte, keine Feldpfade ──────────
{
  const a = baueChatAnweisung([
    { key: 'betrag_fremd', severity: 'mittel', block: 5, loc: { field: 'cols[0].text', match: '1.200 €' }, what: 'Betrag' },
    { key: 'behauptung_unsupported', severity: 'niedrig', block: 5, claim: 'Die Grundsteuer ist gering' },
    { key: 'behauptung_unsupported', severity: 'hoch', block: 0, claim: 'direkt am Meer' },
  ])
  ok('T60 weicher Betrag/Behauptung → Pruefbitte', /„1\.200 €“\. Bitte prüfen/.test(a) && /„Die Grundsteuer ist gering“\. Bitte prüfen/.test(a), a)
  ok('T60 harte Behauptung → streichen', /„direkt am Meer“\. Unbelegte Aussage streichen/.test(a), a)
  ok('T60 keine internen Feldpfade', !/Feld |\[\d+\]|\.text/.test(a) && /Spalte 1/.test(a), a)
}

// ── T61: Endpruefung 13.10.26 (2) - zaehlende Ueberschrift, gebeugte Aussage, Notizen ─
{
  for (const [name, setze] of [
    ['Überschrift 6 Gründe', d => { d[I.benefits].headline = '6 Gründe für Emerald Park' }],
    ['Überschrift Sechs Vorteile', d => { d[I.benefits].headline = 'Sechs Vorteile auf einen Blick' }],
    ['EN Six reasons', d => { d[I.benefits].headline = 'Six reasons to choose Emerald Park' }],
    ['Kicker 6 Highlights', d => { d[I.benefits].kicker = '6 Highlights' }],
  ]) {
    const d = deck(); setze(d); d[I.benefits].cards[2] = { icon: '☀️', title: 'Eigene Solaranlage', text: 'Strom vom Dach für jede Wohnung.' }
    const r = run(d, { claims: [claim(I.benefits, 'Eigene Solaranlage')] })
    ok(`T61 ${name}: Karte bleibt (kontext), Ampel rot`, r.blocks[I.benefits].cards.length === 6 && r.report.after?.status !== 'green', wieso(r))
  }
  {
    const d = deck(); d[I.letter].paragraphs[2] = 'Unten findest du die fünf wichtigsten Eckdaten. Ich rechne dir die Zahlen gern persönlich durch, damit du eine klare Grundlage hast.'
    d[I.unit].specs[1] = 'Erdgeschoss mit eigenem Garten'
    const r = run(d, { claims: [claim(I.unit, 'Erdgeschoss mit eigenem Garten')] })
    ok('T61 Anschreiben nennt fünf Eckdaten: Listenpunkt bleibt', r.blocks[I.unit].specs.length === 5, wieso(r))
  }
  for (const [name, tag, sonst] of [
    ['privaten Pool', 'Mit privatem Pool', d => { d[I.letter].paragraphs[1] = 'Emerald Park liegt ruhig. Jede Wohnung hat einen privaten Pool. Supermarkt und Cafés sind nah.' }],
    ['Meerblickterrasse', 'Wohnen mit Meerblick', d => { d[I.unit].specs[1] = '16 m² Meerblickterrasse' }],
  ]) {
    const d = deck(); d[I.cover].tagline = tag; sonst(d)
    const r = run(d, { claims: [claim(I.cover, tag)] })
    ok(`T61 gebeugt „${name}" noch im Deck: kein Gruen`, r.report.after?.status !== 'green' && r.report.status !== 'applied', wieso(r))
  }
  {
    const d = deck(); d[I.cover].tagline = 'Mit privatem Pool'
    const r = run(d, { claims: [claim(I.cover, 'Mit privatem Pool')] })
    ok('T61 Gegenprobe: Aussage nur in der Tagline → bereinigt', r.report.status === 'applied' && r.report.after?.status === 'green', wieso(r))
  }
  for (const [name, note] of [
    ['Semikolon', 'Möbelpaket optional für 25.000 €; Übergabe schlüsselfertig im September 2028.'],
    ['Gedankenstrich', 'Möbelpaket 25.000 € – Übergabe schlüsselfertig, Gemeinschaftspool, Gym'],
    ['Fußnote', '¹ Optional für 25.000 € netto.'],
  ]) {
    const d = deck(); d[I.unit].note = note
    const r = run(d)
    ok(`T61 Notiz mit ${name}: bleibt stehen`, r.blocks[I.unit].note === note, wieso(r))
  }
}

// ── T62: Endpruefung r7 - jede Zahl in der eigenen Ueberschrift sperrt, Behauptungs-Notiz mit Zusatzinfo bleibt ─
{
  for (const h of ['Die Top 6', '6 Vorzüge der Anlage', 'Sechs Stärken der Anlage', 'Ein halbes Dutzend Gründe', 'Six perks you will love']) {
    const d = deck(); d[I.benefits].headline = h; d[I.benefits].cards[2] = { icon: '🏊', title: 'Privater Pool', text: 'Jede Wohnung mit eigenem Becken.' }
    const r = run(d, { claims: [claim(I.benefits, 'Privater Pool')] })
    ok(`T62 Überschrift „${h}": Karte bleibt`, r.blocks[I.benefits].cards.length === 6, wieso(r))
  }
  {
    const d = deck(); d[I.unit].note = 'Die Anlage liegt direkt am Meer, die Einrichtung ist optional erhältlich.'
    const r = run(d, { claims: [claim(I.unit, 'Die Anlage liegt direkt am Meer')] })
    ok('T62 Behauptungs-Notiz mit Zusatzinfo: bleibt (fliesstext)', r.blocks[I.unit].note === d[I.unit].note, wieso(r))
  }
}

console.log(fails ? `\n❌ ${fails} Test(s) fehlgeschlagen` : '\n✅ Autobereinigungs-Tests bestanden')
process.exit(fails ? 1 : 0)
