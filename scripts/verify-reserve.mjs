// Geschuetzte Liquiditaetsreserve bei der Startallokation und die Trennung von
// Kaufvertrag, Uebergabe und Beleihbarkeit (Sven 9.9.2026).
//
// Kern: Die Mindestreserve wird beim Start NICHT mitinvestiert, ist aber auch
// kein Cash-Floor - faellt die Kasse spaeter darunter, ist das ein echter
// Verstoss. Und eine Wohnung im Bau taugt nicht als Sicherheit.
//
// Ausfuehren:
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/reinvest.ts --bundle --format=esm --outfile=/tmp/reinvest.mjs
//   node scripts/verify-reserve.mjs
import { DEFAULT_SIM_PARAMS, allocate, aggregate } from '/tmp/strategy.mjs'
import { runReinvest, MONEY_TOLERANCE } from '/tmp/reinvest.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
let pass = 0, fail = 0
function T(name, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

const u = (k, o = {}) => ({
  key: k, name: k, priceNet: 230000, furnNet: 0, rent: 1254, letType: 'short', fin: true,
  buyM: 9, buyY: 2026, readyM: 3, readyY: 2027, plan: 'luma', calc: { mgmtPct: 2, bedrooms: 1 }, ...o,
})
const UNITS = [u('A'), u('B', { priceNet: 210000, furnNet: 17000, rent: 1238, readyM: 9, readyY: 2028 })]
const P = {
  ...DEFAULT_SIM_PARAMS, ek: 400000, res: 'de', holder: 'privat', gesy: true, socialIns: true,
  interest: 4.1, termYears: 20, rentGrowth: 2, opexMonthly: 150, maintPct: 0.75, deTaxPct: 42,
  reinvestEnabled: true, horizonYears: 20, reinvestAppreciationPct: 5, refinanceLtv: 70,
  bankValuationFactor: 100, refinanceUtilizationPct: 100, minimumCashReserve: 25000,
  maxAdditionalPurchases: 5, autoReinvest: true, exitAfterYears: 7, selfFundingOnly: true,
  additionalEquityMonthly: 0, buyerStructure: 'single',
}

// ── [1] Reserve wird nicht mitinvestiert ───────────────────────────────────
console.log('\n[1] Startallokation haelt die Reserve zurueck')
console.log('Startkapital | geschuetzt | investierbar | investiert | Startkasse | Wohnungen | min. Liq. | Datum | selbsttragend | Endliq. | Nettovermoegen')
const table = []
for (const ek of [350000, 375000, 400000, 425000]) {
  const p = { ...P, ek }
  const out = allocate(UNITS, p)
  const used = out.reduce((a, o) => a + o.ekUsed, 0)
  const r = runReinvest(UNITS, p)
  const lo = Math.min(...r.flows.map(f => f.endingCash))
  const loY = r.flows.find(f => f.endingCash === lo).year
  const row = { ek, used, start: Math.max(0, ek - used), r, lo, loY }
  table.push(row)
  console.log(`${eur(ek).padStart(12)} | ${eur(P.minimumCashReserve).padStart(10)} | ${eur(ek - P.minimumCashReserve).padStart(12)} | ${eur(used).padStart(10)} | ${eur(row.start).padStart(10)} | ${String(r.kpis.activeUnitsEnd).padStart(9)} | ${eur(lo).padStart(9)} | ${String(loY).padStart(5)} | ${String(r.kpis.selfSupporting).padStart(13)} | ${eur(r.kpis.cashEnd).padStart(7)} | ${eur(r.years.at(-1).netWorth).padStart(14)}`)
}
for (const row of table) {
  T(`${eur(row.ek)}: Startkasse ist genau die Reserve`, near(row.start, P.minimumCashReserve, 2), eur(row.start))
  T(`${eur(row.ek)}: eingesetztes Kapital = Startkapital minus Reserve`, near(row.used, row.ek - P.minimumCashReserve, 2), eur(row.used))
  T(`${eur(row.ek)}: selbsttragend`, row.r.kpis.selfSupporting === true)
  T(`${eur(row.ek)}: Reserve nie unterschritten`, row.lo >= P.minimumCashReserve - MONEY_TOLERANCE, `Tiefpunkt ${eur(row.lo)} in ${row.loY}`)
}
T('mehr Startkapital gibt nicht weniger Vermoegen', table.every((x, i) => i === 0 || x.r.years.at(-1).netWorth >= table[i - 1].r.years.at(-1).netWorth - 1),
  table.map(x => eur(x.r.years.at(-1).netWorth)).join(' -> '))

// ── [2] Kein kuenstlicher Cash-Floor ────────────────────────────────────────
console.log('\n[2] Die Reserve ist kein Cash-Floor')
const base = runReinvest(UNITS, P)
T('Kasse steigt ueber die Reserve, wenn Cashflow kommt', base.flows.some(f => f.endingCash > P.minimumCashReserve + 1000),
  `Hoechststand ${eur(Math.max(...base.flows.map(f => f.endingCash)))}`)
// Reserve so hoch setzen, dass sie nicht zu halten ist: muss gemeldet werden.
const tight = runReinvest(UNITS, { ...P, minimumCashReserve: 250000 })
const tightLow = Math.min(...tight.flows.map(f => f.endingCash))
T('unerreichbare Reserve wird gemeldet statt aufgefuellt',
  tightLow < 250000 - MONEY_TOLERANCE && tight.kpis.selfSupporting === false,
  `Tiefpunkt ${eur(tightLow)}, selfSupporting ${tight.kpis.selfSupporting}`)
T('keine Kasse wird auf die Reserve hochgesetzt', tight.flows.some(f => f.endingCash !== 250000))
// Zu wenig Kapital: die Reserve darf nicht aus dem Nichts entstehen.
const poor = runReinvest(UNITS, { ...P, ek: 120000 })
T('reicht das Kapital nicht, entsteht keine Reserve aus dem Nichts',
  poor.flows[0].endingCash <= P.minimumCashReserve + 1, eur(poor.flows[0].endingCash))

// ── [3] Klassische Strategie bleibt unberuehrt ──────────────────────────────
console.log('\n[3] Ohne Reinvestment aendert sich nichts')
const classic = { ...P, reinvestEnabled: false }
const cOut = allocate(UNITS, classic)
// Ohne Reinvestment gilt die alte Regel: das volle Startkapital wird verteilt,
// die Nebenkosten zahlt der Kunde zusaetzlich aus eigener Tasche.
T('klassische Strategie verteilt weiter das volle Startkapital',
  near(cOut.reduce((a, o) => a + o.ekUsed, 0), P.ek + cOut.reduce((a, o) => a + o.res.costs, 0), 3),
  `${eur(cOut.reduce((a, o) => a + o.ekUsed, 0))} bei ${eur(P.ek)} Startkapital plus ${eur(cOut.reduce((a, o) => a + o.res.costs, 0))} Nebenkosten`)
const cAgg = aggregate(cOut, classic)
T('klassische Jahreszeilen weiter berechenbar', cAgg.rows.length > 0)

// ── [4] Kauf, Bauzeit, Uebergabe, Beleihbarkeit ────────────────────────────
console.log('\n[4] Kaufvertrag, Uebergabe und Beleihbarkeit')
const M = ['', 'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']
console.log('Wohnung              | Kaufdatum | Bauzeit  | Uebergabe | beleihbar ab | 1. Refinanzierung')
for (const tl of base.unitTimeline) {
  console.log(`${tl.name.padEnd(20)} | ${(M[tl.purchaseMonth] + ' ' + tl.purchaseYear).padEnd(9)} | ${(tl.constructionMonths + ' Mon.').padStart(8)} | ${(M[tl.handoverMonth] + ' ' + tl.handoverYear).padEnd(9)} | ${String(tl.pledgeableFrom).padStart(12)} | ${String(tl.firstRefinanceYear ?? '–').padStart(17)}`)
}
T('Timeline enthaelt jede Wohnung', base.unitTimeline.length === base.outcomes.length)
T('beleihbar ab dem Uebergabejahr, nie ab dem Kaufjahr',
  base.unitTimeline.every(tl => tl.pledgeableFrom === tl.handoverYear))
T('Bauzeit = Monate zwischen Kauf und Uebergabe', base.unitTimeline.every(tl =>
  tl.constructionMonths === Math.max(0, (tl.handoverYear * 12 + tl.handoverMonth) - (tl.purchaseYear * 12 + tl.purchaseMonth))))
T('Startwohnung im Bau: 6 und 24 Monate', base.unitTimeline.filter(tl => !tl.model).map(tl => tl.constructionMonths).join(',') === '6,24')
T('Modellwohnungen ohne Bauzeit', base.unitTimeline.filter(tl => tl.model).every(tl => tl.constructionMonths === 0))
T('keine Refinanzierung vor der Uebergabe', base.unitTimeline.every(tl =>
  tl.firstRefinanceYear == null || tl.firstRefinanceYear >= tl.handoverYear))
// Direkt gegen die Ereignisse gegengeprueft
const refis = base.events.filter(e => e.kind === 'refinance')
T('jedes Refinanzierungsereignis liegt im Uebergabejahr oder spaeter', refis.every(e => {
  const o = base.outcomes.find(x => x.unit.key === e.propertyKeys[0])
  return o && e.year >= o.unit.readyY
}), `${refis.length} Ereignisse geprueft`)
T('Beleihungswert nie hoeher als der Marktwert der Wohnung', refis.every(e => {
  const o = base.outcomes.find(x => x.unit.key === e.propertyKeys[0])
  const i = e.year - o.unit.readyY
  return i >= 0 && e.marketValue <= o.res.propV[Math.min(i, o.res.propV.length - 1)] + 1
}))
// Eine Wohnung mit langer Bauzeit darf in der Bauphase keine Kapazitaet liefern.
const late = [u('A'), u('LATE', { key: 'LATE', name: 'LATE', readyY: 2034, readyM: 6, fin: false })]
const rl = runReinvest(late, { ...P, ek: 700000, maxAdditionalPurchases: 0 })
const tlLate = rl.unitTimeline.find(x => x.key === 'LATE')
T('Wohnung mit Uebergabe 2034 ist erst ab 2034 beleihbar', tlLate.pledgeableFrom === 2034, `Bauzeit ${tlLate.constructionMonths} Monate`)
const capBefore = rl.years.filter(y => y.year < 2034).map(y => y.refinancingCapacity)
const capAfter = rl.years.find(y => y.year === 2034).refinancingCapacity
T('ihre Kapazitaet erscheint erst im Uebergabejahr', capAfter > Math.max(...capBefore),
  `bis 2033 hoechstens ${eur(Math.max(...capBefore))}, 2034 dann ${eur(capAfter)}`)

console.log(`\n${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
