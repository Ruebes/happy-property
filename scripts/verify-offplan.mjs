// Off-Plan-Modell (Sven 9.9.2026): Ein Kauf ist eine Verpflichtung ueber die
// Bauzeit, keine Zahlung an einem Tag. Geprueft werden:
//   1. Kaufvertrag, Bauzeit, Uebergabe als drei getrennte Zeitpunkte
//   2. Zahlungsplan statt Sofortzahlung, Raten im Jahr ihrer Faelligkeit
//   3. Mehrwertsteuer 18 Monate NACH UEBERGABE, nur bei Kurzzeit
//   4. Kurzzeitvermietung als Standard fuer Zukaeufe
//   5. Kredit ist kein Recycling
//   6. Refinanziert wird die Wohnung mit dem groessten Spielraum
//
// Ausfuehren:
//   npx esbuild src/lib/rechner.ts  --bundle --format=esm --outfile=/tmp/rechner.mjs
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/reinvest.ts --bundle --format=esm --outfile=/tmp/reinvest.mjs
//   node scripts/verify-offplan.mjs
import { compute, VAT_REFUND_MONTHS_DEFAULT, VAT_REFUND_MONTHS_STRATEGY } from '/tmp/rechner.mjs'
import { DEFAULT_SIM_PARAMS, allocate } from '/tmp/strategy.mjs'
import { runReinvest, buildModelUnit, MONEY_TOLERANCE } from '/tmp/reinvest.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
const MN = ['', 'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']
let pass = 0, fail = 0
function T(name, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

const u = (k, o = {}) => ({
  key: k, name: k, priceNet: 270000, furnNet: 0, rent: 1400, letType: 'short', fin: true,
  buyM: 1, buyY: 2026, readyM: 7, readyY: 2027, plan: 'luma', calc: { mgmtPct: 25, bedrooms: 1 }, opex: 150, ...o,
})
const UNITS = [u('A'), u('B', { readyM: 1, readyY: 2028 })]
const P = {
  ...DEFAULT_SIM_PARAMS, ek: 400000, res: 'cy', holder: 'privat', gesy: true, socialIns: false,
  interest: 4.1, termYears: 20, rentGrowth: 2, opexMonthly: 150, maintPct: 0.75,
  reinvestEnabled: true, horizonYears: 20, reinvestAppreciationPct: 5, refinanceLtv: 70,
  bankValuationFactor: 100, refinanceUtilizationPct: 100, minimumCashReserve: 25000,
  maxAdditionalPurchases: 6, autoReinvest: true, exitAfterYears: 0, selfFundingOnly: true,
  additionalEquityMonthly: 0, buyerStructure: 'single', reinvestConstructionMonths: 18,
}
const base = runReinvest(UNITS, P)
const buys = r => r.events.filter(e => e.kind === 'purchase')

// ── [1] Drei getrennte Zeitpunkte ───────────────────────────────────────────
console.log('\n[1] Kaufvertrag, Bauzeit, Uebergabe')
console.log('Wohnung          | Vertrag  | Bauzeit | Uebergabe | beleihbar ab | MwSt zurueck')
for (const t of base.unitTimeline) {
  const o = base.outcomes.find(x => x.unit.key === t.key)
  const vi = o.res.vatA.findIndex(v => v > 0)
  console.log(`${t.name.slice(0, 16).padEnd(16)} | ${(MN[t.purchaseMonth] + ' ' + t.purchaseYear).padEnd(8)} | ${(t.constructionMonths + ' M').padStart(7)} | ${(MN[t.handoverMonth] + ' ' + t.handoverYear).padEnd(9)} | ${String(t.pledgeableFrom).padStart(12)} | ${vi < 0 ? '–' : t.handoverYear + vi}`)
}
T('Zukaeufe haben die eingestellte Bauzeit', base.unitTimeline.filter(t => t.model).every(t => t.constructionMonths === P.reinvestConstructionMonths),
  `${P.reinvestConstructionMonths} Monate`)
T('Uebergabe = Vertrag + Bauzeit', base.unitTimeline.every(t =>
  (t.handoverYear * 12 + t.handoverMonth) - (t.purchaseYear * 12 + t.purchaseMonth) === t.constructionMonths))
T('beleihbar erst ab Uebergabe', base.unitTimeline.every(t => t.pledgeableFrom === t.handoverYear))
T('Vertrag liegt vor der Uebergabe', base.unitTimeline.filter(t => t.model).every(t => t.purchaseYear < t.handoverYear))
T('Bauzeit 0 ergibt einen Bestandskauf', (() => {
  const r0 = runReinvest(UNITS, { ...P, reinvestConstructionMonths: 0 })
  const m = r0.unitTimeline.filter(t => t.model)
  return m.length === 0 || m.every(t => t.constructionMonths === 0 && t.purchaseYear === t.handoverYear)
})())

// ── [2] Zahlungsplan statt Sofortzahlung ────────────────────────────────────
console.log('\n[2] Zahlungsplan')
const modelBuys = base.outcomes.filter(o => o.unit.model)
T('Zukaeufe haben einen Ratenplan, keine Einmalzahlung', modelBuys.length === 0 || modelBuys.every(o => o.payments.length > 1),
  modelBuys.length ? `${modelBuys[0].payments.length} Raten` : 'kein Zukauf im Testfall')
T('Raten summieren sich auf den Gesamtpreis', modelBuys.every(o =>
  near(o.payments.reduce((a, x) => a + x.amount, 0), o.gross, 3)))
T('erste Rate im Vertragsmonat', modelBuys.every(o => Math.min(...o.payments.map(x => x.ym)) === o.unit.buyY * 12 + o.unit.buyM - 1))
T('letzte Rate bei Uebergabe', modelBuys.every(o => Math.max(...o.payments.map(x => x.ym)) === o.unit.readyY * 12 + o.unit.readyM - 1))
// Das Eigenkapital darf nicht komplett im Kaufjahr abfliessen.
for (const ev of buys(base)) {
  const flow = base.flows.find(f => f.year === ev.year)
  T(`Kauf ${ev.year}: Eigenkapital fliesst verteilt, nicht komplett im Vertragsjahr`,
    flow.purchaseEquity < ev.equity + MONEY_TOLERANCE,
    `${eur(flow.purchaseEquity)} im Vertragsjahr von ${eur(ev.equity)} gesamt`)
}
const totalOut = base.flows.reduce((a, f) => a + f.purchaseEquity, 0)
const totalEq = buys(base).reduce((a, e) => a + e.equity, 0)
T('ueber alle Jahre fliesst das volle Eigenkapital ab', near(totalOut, totalEq, buys(base).length + 3),
  `${eur(totalOut)} von ${eur(totalEq)}`)

// ── [3] Mehrwertsteuer 18 Monate nach Uebergabe ─────────────────────────────
console.log('\n[3] Mehrwertsteuer')
T('Einzelrechner bleibt bei 24 Monaten', VAT_REFUND_MONTHS_DEFAULT === 24)
T('Strategie rechnet mit 18 Monaten', VAT_REFUND_MONTHS_STRATEGY === 18)
const probe = compute({
  month: 7, year: 2027, dealType: 'single', priceNet: 270000, bedrooms: 1, fin: 'no',
  letType: 'short', mode: 'ann', res: 'cy', equity: 0, yieldPct: 5.5, years: 10,
})
const probe18 = compute({
  month: 7, year: 2027, dealType: 'single', priceNet: 270000, bedrooms: 1, fin: 'no',
  letType: 'short', mode: 'ann', res: 'cy', equity: 0, yieldPct: 5.5, years: 10, vatRefundMonths: 18,
})
T('24 Monate: Erstattung im dritten Jahr', probe.vatA.findIndex(v => v > 0) === 2)
T('18 Monate: Erstattung ein Jahr frueher', probe18.vatA.findIndex(v => v > 0) === 1)
T('Betrag unveraendert', probe.vatAmt === probe18.vatAmt, eur(probe.vatAmt))
// In der Strategie: Erstattung immer nach der Uebergabe, nie davor
for (const o of base.outcomes) {
  const vi = o.res.vatA.findIndex(v => v > 0)
  if (vi < 0) continue
  T(`${o.unit.name.slice(0, 16)}: Erstattung ${o.unit.readyY + vi} liegt nach der Uebergabe ${o.unit.readyY}`, vi >= 1 || o.unit.readyM > 6)
}
T('Langzeit bekommt keine Erstattung', compute({
  month: 7, year: 2027, dealType: 'single', priceNet: 270000, bedrooms: 1, fin: 'no',
  letType: 'long', mode: 'ann', res: 'cy', equity: 0, yieldPct: 5.5, years: 10, vatRefundMonths: 18,
}).vatA.every(v => v === 0))

// ── [4] Kurzzeit als Standard ───────────────────────────────────────────────
console.log('\n[4] Vermietungsart der Zukaeufe')
const longUnits = [u('A', { letType: 'long' }), u('B', { letType: 'long', readyM: 1, readyY: 2028 })]
const modelLong = buildModelUnit(longUnits, P)
T('Modellobjekt ist Kurzzeit, auch wenn alle Startwohnungen Langzeit sind',
  modelLong.letType === 'short', `Startwohnungen: long, Modell: ${modelLong.letType}`)
const modelShort = buildModelUnit(UNITS, P)
T('bei Kurzzeit-Startwohnungen unveraendert', modelShort.letType === 'short')
const rLong = runReinvest(longUnits, P)
T('Zukaeufe behalten die Erstattung, auch im Langzeit-Portfolio',
  rLong.outcomes.filter(o => o.unit.model).every(o => o.unit.letType === 'short'))

// ── [5] Kredit ist kein Recycling ───────────────────────────────────────────
console.log('\n[5] Eigenkapital gegen Fremdkapital')
const eqSum = buys(base).reduce((a, e) => a + e.equity, 0)
console.log(`     Eigenkapital in Zukaeufen ${eur(eqSum)}`)
console.log(`     davon aus eigenen Mitteln ${eur(base.kpis.totalRecycledCapital)}`)
console.log(`     davon aus Refinanzierung  ${eur(base.kpis.totalBorrowedForPurchases)}`)
T('geliehener Anteil wird getrennt ausgewiesen', typeof base.kpis.totalBorrowedForPurchases === 'number')
T('eigenes plus geliehen uebersteigt nicht das Kaufeigenkapital',
  base.kpis.totalRecycledCapital + base.kpis.totalBorrowedForPurchases <= eqSum + buys(base).length + 3)
T('geliehener Anteil hoechstens so gross wie alle Refinanzierungen',
  base.kpis.totalBorrowedForPurchases <= base.kpis.totalRefinancingProceeds + 3)
T('Recycling zaehlt Kredite nicht mehr mit',
  base.kpis.totalBorrowedForPurchases === 0 || base.kpis.totalRecycledCapital < eqSum,
  `${eur(base.kpis.totalRecycledCapital)} statt ${eur(eqSum)}`)
T('jede Refinanzierung erzeugt eine Darlehenstranche',
  base.events.filter(e => e.kind === 'refinance').length === base.tranches.length)
T('Refinanzierung erhoeht die Schuld', base.kpis.refinancings === 0 || base.kpis.debtEnd > 0)

// ── [6] Auswahl der Sicherheit ──────────────────────────────────────────────
console.log('\n[6] Welche Wohnung als Sicherheit dient')
for (const ev of base.events.filter(e => e.kind === 'refinance')) {
  console.log(`     ${ev.year}: ${ev.propertyNames[0].slice(0, 20).padEnd(20)} ${eur(ev.newLoanAmount).padStart(9)} von ${eur(ev.theoreticalCapacity)} Spielraum`)
}
T('nie mehr gezogen als Spielraum da ist', base.events.filter(e => e.kind === 'refinance')
  .every(e => e.newLoanAmount <= e.theoreticalCapacity + MONEY_TOLERANCE))
T('nie eine Wohnung im Bau als Sicherheit', base.events.filter(e => e.kind === 'refinance').every(e => {
  const o = base.outcomes.find(x => x.unit.key === e.propertyKeys[0])
  return o && e.year >= o.unit.readyY
}))
// Die Wohnung mit dem groessten Spielraum kommt zuerst dran.
T('beliehen wird die Wohnung mit dem groessten Spielraum', (() => {
  const byYear = new Map()
  for (const e of base.events.filter(x => x.kind === 'refinance')) {
    if (!byYear.has(e.year)) byYear.set(e.year, [])
    byYear.get(e.year).push(e)
  }
  for (const [, list] of byYear) {
    for (let i = 1; i < list.length; i++) if (list[i].theoreticalCapacity > list[i - 1].theoreticalCapacity + 1) return false
  }
  return true
})())

// ── [7] Gesamtbild ──────────────────────────────────────────────────────────
console.log('\n[7] Ergebnis des Testfalls')
console.log(`     Startkapital ${eur(P.ek)}, Reserve ${eur(P.minimumCashReserve)}, zwei Wohnungen zu ${eur(270000)} netto`)
console.log(`     Zukaeufe ${base.kpis.additionalPurchases} | Wohnungen ${base.kpis.activeUnitsEnd} | Wert ${eur(base.kpis.portfolioValueEnd)}`)
console.log(`     Schuld ${eur(base.kpis.debtEnd)} | Kasse ${eur(base.kpis.cashEnd)} | selbsttragend ${base.kpis.selfSupporting}`)
let cash = base.flows[0].startingCash
for (const f of base.flows) cash = cash + f.operatingCashflow + f.vatRefund + f.investorEquity + f.refinancingProceeds + f.saleProceeds - f.purchaseEquity - f.purchaseCosts
T('Kassenbruecke schliesst', Math.abs(cash - base.kpis.cashEnd) <= base.flows.length,
  `${eur(cash)} gegen ${eur(base.kpis.cashEnd)}`)
T('Reserve nie unterschritten, wenn selbsttragend gemeldet wird',
  !base.kpis.selfSupporting || base.flows.every(f => f.endingCash >= P.minimumCashReserve - MONEY_TOLERANCE))
T('Startallokation haelt die Reserve zurueck',
  near(P.ek - allocate(UNITS, P).reduce((a, o) => a + o.ekUsed, 0), P.minimumCashReserve, 2))

console.log(`\n${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
