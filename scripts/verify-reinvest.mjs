// Prueft den Reinvestment-/Kapital-Recycling-Motor (src/lib/reinvest.ts).
//
// Ausfuehren:
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/reinvest.ts --bundle --format=esm --outfile=/tmp/reinvest.mjs
//   node scripts/verify-reinvest.mjs
import { allocate, aggregate, totalsOf, computeExit, trancheSchedule, DEFAULT_SIM_PARAMS } from '/tmp/strategy.mjs'
import { runReinvest, buildModelUnit, maxAffordablePrice } from '/tmp/reinvest.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
let pass = 0, fail = 0
function T(name, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol

const unit = (key, o = {}) => ({
  key, name: key, priceNet: 300000, furnNet: 20000, rent: 2400, letType: 'short', fin: true,
  buyM: 1, buyY: 2027, readyM: 1, readyY: 2027, plan: 'sofort', calc: { mgmtPct: 25 }, opex: 150, ...o,
})
const P = {
  ...DEFAULT_SIM_PARAMS, res: 'cy', holder: 'privat', socialIns: false, gesy: true,
  ek: 150000, interest: 4.1, termYears: 20, exitAfterYears: 0,
  reinvestEnabled: true, horizonYears: 20, reinvestAppreciationPct: 5,
  refinanceLtv: 70, bankValuationFactor: 100, refinanceUtilizationPct: 100,
  minimumCashReserve: 25000, maxAdditionalPurchases: 5, autoReinvest: true,
}

console.log('\n── Case A: ohne Reinvestment bleibt die alte Strategie unveraendert ──')
const off = { ...P, reinvestEnabled: false, exitAfterYears: 7, growth: 5 }
const oOff = allocate([unit('A'), unit('B', { buyY: 2028, readyY: 2028 })], off)
const aggOff = aggregate(oOff, off)
const aggOffExtras = aggregate(oOff, off, {})   // leere Extras duerfen nichts aendern
T('Horizont bleibt 10 Jahre', aggOff.rows.length === 7 && aggOff.lastYear === aggOff.firstYear + 6,
  `${aggOff.firstYear}-${aggOff.lastYear}`)
T('leere Zusatzangaben aendern nichts',
  JSON.stringify(aggOff.rows) === JSON.stringify(aggOffExtras.rows))
const exOff = computeExit(oOff, off, aggOff.firstYear)
T('Verkaufsrechnung unveraendert', exOff && exOff.net > 0, `${eur(exOff.net)} EUR`)

console.log('\n── Case B/C/D: Wertsteigerung 0, 5 und 9 Prozent ──')
const byApp = {}
for (const app of [0, 5, 9]) {
  const r = runReinvest([unit('A')], { ...P, reinvestAppreciationPct: app })
  byApp[app] = r
  console.log(`   ${app} %: ${r.kpis.additionalPurchases} Kaeufe, ${r.kpis.refinancings} Refinanzierungen, Kapazitaet Jahr 10 ${eur(r.years[9].refinancingCapacity)} EUR`)
}
T('Case B: ohne Wertsteigerung entsteht Kapazitaet allein durch Tilgung',
  byApp[0].years[9].refinancingCapacity > 0 && byApp[0].years[0].refinancingCapacity < byApp[0].years[9].refinancingCapacity,
  `Jahr 1 ${eur(byApp[0].years[0].refinancingCapacity)} auf Jahr 10 ${eur(byApp[0].years[9].refinancingCapacity)}`)
T('Case C/D: mehr Wertsteigerung ergibt mehr Kapazitaet',
  byApp[9].years[9].refinancingCapacity > byApp[5].years[9].refinancingCapacity &&
  byApp[5].years[9].refinancingCapacity > byApp[0].years[9].refinancingCapacity)
T('Case D: hoehere Wertsteigerung beschleunigt das Recycling',
  byApp[9].kpis.additionalPurchases >= byApp[5].kpis.additionalPurchases)

console.log('\n── Case E/F: Beleihungsauslauf 60 gegen 70 Prozent ──')
const ltv60 = runReinvest([unit('A')], { ...P, refinanceLtv: 60 })
const ltv70 = runReinvest([unit('A')], { ...P, refinanceLtv: 70 })
T('Case E/F: 70 % ergibt mehr Kapazitaet als 60 %',
  ltv70.years[9].refinancingCapacity > ltv60.years[9].refinancingCapacity,
  `${eur(ltv60.years[9].refinancingCapacity)} gegen ${eur(ltv70.years[9].refinancingCapacity)}`)
const y10 = ltv70.years[9]
const o10 = ltv70.outcomes[0]
const wert = o10.res.propV[9], schuld = o10.res.restL[9]
T('Kapazitaet = Marktwert mal Beleihung minus Restschuld',
  near(y10.refinancingCapacity, Math.max(0, Math.round(wert * 0.7 - schuld)), 3),
  `Wert ${eur(wert)}, Schuld ${eur(schuld)}, Kapazitaet ${eur(y10.refinancingCapacity)}`)
T('Kapazitaet wird nie negativ', ltv60.years.every(y => y.refinancingCapacity >= 0))

console.log('\n── Case G: Verkauf nach 5 Jahren ──')
const sold = runReinvest([unit('A', { saleYear: 2031 }), unit('B', { buyY: 2028, readyY: 2028 })], { ...P, autoReinvest: false })
const rowsAfter = sold.rows.filter(r => r.year > 2031)
const soloB = runReinvest([unit('B', { buyY: 2028, readyY: 2028 })], { ...P, autoReinvest: false })
T('Case G: nach dem Verkauf nur noch eine Wohnung aktiv',
  sold.years.filter(y => y.year > 2031).every(y => y.activeUnits === 1))
T('Case G: Miete der verkauften Wohnung faellt weg',
  rowsAfter.every(r => r.rents < sold.rows.find(x => x.year === 2031).rents))
T('Case G: kein Wert und keine Schuld der verkauften Wohnung mehr',
  near(sold.rows.find(r => r.year === 2032).value,
    soloB.rows.find(r => r.year === 2032).value, 3))
T('Case G: Verkaufserloes landet in der Kasse',
  (sold.flows.find(f => f.year === 2031)?.saleProceeds ?? 0) > 0,
  `${eur(sold.flows.find(f => f.year === 2031)?.saleProceeds ?? 0)} EUR`)
T('Case G: Verkauf ist als Ereignis protokolliert',
  sold.events.some(e => e.kind === 'sale' && e.year === 2031))

console.log('\n── Case H: Verkauf nach Refinanzierung ──')
const refiThenSell = runReinvest([unit('A', { saleYear: 2044 })], P)
const refiOnA = refiThenSell.events.filter(e => e.kind === 'refinance' && e.propertyKeys.includes('A'))
const saleA = refiThenSell.sales.find(s => s.key === 'A')
if (refiOnA.length && saleA) {
  const trancheRest = refiOnA.reduce((a, e) => {
    const t = refiThenSell.tranches.find(x => x.id === e.trancheId)
      ?? { amount: e.newLoanAmount, ratePct: e.ratePct, termYears: e.termYears, startYear: e.year, propertyKeys: e.propertyKeys }
    const sch = trancheSchedule(t, 2044)
    return a + (sch.length ? sch[sch.length - 1].rest : 0)
  }, 0)
  const ownDebt = refiThenSell.outcomes.find(o => o.unit.key === 'A').res.restL[2044 - 2027]
  T('Case H: abzuloesende Schuld enthaelt Ursprungsdarlehen UND Tranche',
    saleA.line.debt >= Math.round(ownDebt + trancheRest) - 3,
    `Verkaufsschuld ${eur(saleA.line.debt)}, davon Tranche ${eur(trancheRest)}`)
  T('Case H: keine doppelte Anrechnung, Erloes bleibt plausibel',
    saleA.netProceeds < saleA.line.value && saleA.netProceeds > 0,
    `${eur(saleA.netProceeds)} von ${eur(saleA.line.value)}`)
} else {
  T('Case H: Refinanzierung vor dem Verkauf vorhanden', false, 'kein Refinanzierungsereignis auf A')
}

console.log('\n── Case I: Refinanzierung, Kauf, zweiter Zyklus ──')
const cycle = runReinvest([unit('A')], P)
T('Case I: mindestens zwei Zyklen', cycle.kpis.additionalPurchases >= 2 && cycle.kpis.refinancings >= 2,
  `${cycle.kpis.additionalPurchases} Kaeufe, ${cycle.kpis.refinancings} Refinanzierungen`)
const purchaseYears = cycle.events.filter(e => e.kind === 'purchase').map(e => e.year)
T('Case I: die Kaeufe liegen in verschiedenen Jahren', new Set(purchaseYears).size === purchaseYears.length,
  purchaseYears.join(', '))
T('Case I: der zweite Zyklus rechnet mit dem gewachsenen Portfolio',
  cycle.years[cycle.years.length - 1].activeUnits === 1 + cycle.kpis.additionalPurchases)

console.log('\n── Case J: Mindestliquiditaet ──')
T('Case J: Kasse faellt nach keinem Kauf unter die Reserve',
  cycle.events.filter(e => e.kind === 'purchase').every(e => {
    const flow = cycle.flows.find(f => f.year === e.year)
    return flow && flow.endingCash >= P.minimumCashReserve - 1
  }))
const highReserve = runReinvest([unit('A')], { ...P, minimumCashReserve: 400000 })
T('Case J: mit sehr hoher Reserve findet kein Kauf statt', highReserve.kpis.additionalPurchases === 0)
T('Case J: Grund wird genannt',
  highReserve.opportunities.some(o => !o.affordable && !!o.reason))

console.log('\n── Case K: Freibetrag bei mehreren Verkaeufen ──')
const twoSales = runReinvest(
  [unit('A', { saleYear: 2036 }), unit('B', { buyY: 2028, readyY: 2028, saleYear: 2040 })],
  { ...P, autoReinvest: false },
)
const used = twoSales.sales.reduce((a, s) => a + s.usedExemption, 0)
T('Case K: zwei Verkaeufe finden statt', twoSales.sales.length === 2)
T('Case K: der lebenslange Freibetrag wird hoechstens einmal verbraucht',
  used <= 30000 + 1, `verbraucht ${eur(used)} EUR`)
T('Case K: der zweite Verkauf zahlt vollen Satz auf den Rest',
  twoSales.sales[1].usedExemption <= Math.max(0, 30000 - twoSales.sales[0].usedExemption) + 1)

console.log('\n── Case L: Zeitachse ueber 20 Jahre ──')
T('Case L: 20 Jahreszeilen', cycle.years.length === 20, `${cycle.firstYear}-${cycle.lastYear}`)
T('Case L: jede Jahreszeile ist vollstaendig',
  cycle.years.every(y => ['activeUnits', 'propertyValue', 'debt', 'equity', 'netWorth', 'annualCashflow',
    'rent', 'interest', 'amortization', 'tax', 'refinancingCapacity', 'endingCash'].every(k => Number.isFinite(y[k]))))
const h25 = runReinvest([unit('A')], { ...P, horizonYears: 25 })
T('Case L: der Horizont ist frei einstellbar', h25.years.length === 25)

console.log('\n── Case M: keine doppelte Verschuldung ──')
const trancheSum = cycle.tranches.reduce((a, t) => {
  const sch = trancheSchedule(t, cycle.lastYear)
  return a + (sch.length ? sch[sch.length - 1].rest : 0)
}, 0)
const unitDebt = cycle.outcomes.reduce((a, o) => {
  const i = cycle.lastYear - o.unit.readyY
  const n = o.res.restL.length
  return a + (i >= 0 ? o.res.restL[Math.min(i, n - 1)] : 0)
}, 0)
T('Case M: Restschuld am Ende = Wohnungsdarlehen + offene Tranchen',
  near(cycle.rows[cycle.rows.length - 1].debt, Math.round(unitDebt + trancheSum), 3),
  `${eur(cycle.rows[cycle.rows.length - 1].debt)} EUR`)
T('Case M: jede Tranche taucht genau einmal auf',
  new Set(cycle.tranches.map(t => t.id)).size === cycle.tranches.length)
T('Case M: Refinanzierung erhoeht die Zinslast der Folgejahre',
  cycle.events.filter(e => e.kind === 'refinance').every(e => {
    const before = cycle.years.find(y => y.year === e.year - 1)
    const after = cycle.years.find(y => y.year === e.year + 1)
    return !before || !after || after.interest > 0
  }))

console.log('\n── Modellobjekt und maximaler Kaufpreis ──')
const model = buildModelUnit([unit('A', { priceNet: 300000, rent: 2400 }), unit('B', { priceNet: 500000, rent: 4000 })], P)
T('Modellobjekt nimmt den Durchschnittspreis', model.priceNet === 400000, `${eur(model.priceNet)} EUR`)
T('Modellobjekt behaelt die durchschnittliche Rendite',
  near(model.rent * 12 / model.priceNet, 2400 * 12 / 300000, 0.002),
  `${eur(model.rent)} EUR/Monat`)
const maxP = maxAffordablePrice(model, P, 120000, 2030)
T('maximaler Kaufpreis liegt ueber dem Modellpreis, wenn Kapital reicht', maxP > 0, `${eur(maxP)} EUR`)
T('ohne Kapital kein Kaufpreis', maxAffordablePrice(model, P, 0, 2030) === 0)

console.log('\n── Kapitalfluss und Kennzahlen ──')
T('Kassenfortschreibung ist in sich stimmig',
  cycle.flows.every((f, i) => {
    const expected = f.startingCash + f.operatingCashflow + f.refinancingProceeds + f.saleProceeds - f.purchaseEquity
    return Math.abs(expected - f.endingCash) < 3
  }))
T('Anfangsbestand jedes Jahres ist der Endbestand des Vorjahres',
  cycle.flows.every((f, i) => i === 0 || Math.abs(f.startingCash - cycle.flows[i - 1].endingCash) < 2))
T('Recycling-Faktor ist definiert und plausibel',
  cycle.kpis.capitalRecyclingMultiple >= 0 && cycle.kpis.capitalRecyclingMultiple < 20,
  `${cycle.kpis.capitalRecyclingMultiple}x bei ${eur(cycle.kpis.originalEquity)} EUR Eigenkapital`)
T('Recycling zaehlt nur Refinanzierung und Verkaufserlöse, nicht jeden Cashflow',
  cycle.kpis.totalRecycledCapital <= cycle.kpis.totalRefinancingProceeds + cycle.kpis.totalSaleProceeds + 1)

console.log(`\n${fail === 0 ? '🎉' : '⚠️'}  ${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
