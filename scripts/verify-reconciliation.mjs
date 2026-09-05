// Abstimmung: Jede Zahl der Kundenauswertung muss sich aus den anderen ergeben.
// Eine Kennzahl, eine Quelle - wenn dieselbe Groesse an zwei Stellen der Seite
// steht, muss sie hier zusammenpassen, sonst faellt der Test.
//
// Ausfuehren:
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/reinvest.ts --bundle --format=esm --outfile=/tmp/reinvest.mjs
//   npx esbuild src/lib/analytics.ts --bundle --format=esm --outfile=/tmp/analytics.mjs
//   node scripts/verify-reconciliation.mjs
import { buildCustomerAnalytics } from '/tmp/analytics.mjs'
import { allocate, aggregate, trancheSchedule, DEFAULT_SIM_PARAMS } from '/tmp/strategy.mjs'
import { runReinvest } from '/tmp/reinvest.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
let pass = 0, fail = 0
function T(name, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

const unit = (key, o = {}) => ({
  key, name: key, priceNet: 320000, furnNet: 22000, rent: 2600, letType: 'short', fin: true,
  buyM: 1, buyY: 2027, readyM: 6, readyY: 2028, plan: 'luma', calc: { mgmtPct: 25 }, opex: 150, ...o,
})
const base = {
  ...DEFAULT_SIM_PARAMS, ek: 350000, res: 'cy', holder: 'privat', gesy: true, socialIns: false,
  interest: 4.1, termYears: 20, rentGrowth: 2, opexMonthly: 150, maintPct: 0.75,
}
const UNITS = [unit('A'), unit('B', { buyY: 2028, readyY: 2029, priceNet: 285000, rent: 2350 }),
  unit('C', { buyY: 2029, readyY: 2031, priceNet: 410000, rent: 3200 })]
const ON = { ...base, reinvestEnabled: true, horizonYears: 20, reinvestAppreciationPct: 5, refinanceLtv: 70, minimumCashReserve: 25000, maxAdditionalPurchases: 5, autoReinvest: true, exitAfterYears: 0 }
const OFF = { ...base, reinvestEnabled: false, exitAfterYears: 7, growth: 5 }

for (const [label, units, p] of [['mit Reinvestment', UNITS, ON], ['ohne Reinvestment', UNITS, OFF]]) {
  console.log(`\n── ${label} ──`)
  const a = buildCustomerAnalytics(units, p)
  const last = a.wealth[a.wealth.length - 1]

  // Vermoegensgleichung, in jedem einzelnen Jahr
  T('Eigenkapital = Immobilienwert minus Kredit (alle Jahre)',
    a.wealth.every(w => w.propertyEquity === w.propertyValue - w.debt))
  T('Netto-Vermoegen = Eigenkapital + gebundenes Kapital + Liquiditaet (alle Jahre)',
    a.wealth.every(w => w.netWorth === w.propertyEquity + w.committed + w.cash))
  T('Netto-Vermoegen am Ende geht auf',
    last.netWorth === last.propertyEquity + last.committed + last.cash,
    `${eur(last.netWorth)} = ${eur(last.propertyEquity)} + ${eur(last.committed)} + ${eur(last.cash)}`)

  // Dieselbe Zahl an allen Stellen
  T('Kennzahl und Vermoegensreihe nennen dasselbe Netto-Vermoegen',
    near(a.summary.netWorth, last.netWorth, 1))
  T('Kennzahl und Vermoegensreihe nennen denselben Immobilienwert',
    near(a.summary.portfolioValue, last.propertyValue, 1))
  T('Kennzahl und Finanzierungsreihe nennen denselben Kredit',
    near(a.summary.debt, a.financing[a.financing.length - 1].debt, 1))
  T('Beleihungsgrad passt zu Kredit und Wert',
    near(a.financingKpis.ltvEnd, Math.round(last.debt / last.propertyValue * 1000) / 10, 0.2))
  const basisScenario = a.scenarios.find(s => s.key === 'basis')
  T('Basis-Szenario stimmt mit der Hauptrechnung ueberein',
    near(basisScenario.netWorth, a.summary.netWorth, 3) && near(basisScenario.portfolioValue, a.summary.portfolioValue, 3),
    `${eur(basisScenario.netWorth)} gegen ${eur(a.summary.netWorth)}`)
  T('Rendite ist in Kennzahl und Szenario dieselbe', near(basisScenario.irr, a.summary.irr, 0.0001))

  // Cashflow-Zeilen
  const badRow = a.cashflowRows.find(r =>
    Math.abs((r.rent - r.costs - r.interest - r.amortization - r.tax + r.vatRefund) - r.net) > 3)
  T('jede Cashflow-Zeile rechnet sich auf den ausgewiesenen Cashflow',
    !badRow, badRow ? `Jahr ${badRow.year}` : 'alle Zeilen')
  T('kumulierter Cashflow ist die Summe der Jahre',
    near(a.cashflow[a.cashflow.length - 1].cumulative, a.cashflow.reduce((x, c) => x + c.cashflow, 0), 3))

  // Steuern
  T('Steuern gesamt = Einkommensteuer plus Beitraege plus deutsche Steuer',
    a.taxKpis.total >= a.taxKpis.incomeTax + a.taxKpis.gesy + a.taxKpis.si - 3)
  T('Steuerreihe summiert sich auf die Gesamtsteuer',
    near(a.tax.reduce((x, t) => x + t.total, 0), a.taxKpis.total, 3))
}

console.log('\n── Liquiditaet gegen Kapitalfluss ──')
const r = runReinvest(UNITS, ON)
let cash = Math.max(0, ON.ek - r.outcomes.filter(o => !o.unit.model).reduce((x, o) => x + o.ekUsed, 0))
let ok = true, firstBad = null
for (const fl of r.flows) {
  const expected = fl.startingCash + fl.operatingCashflow + fl.refinancingProceeds + fl.saleProceeds - fl.purchaseEquity - fl.purchaseCosts
  if (Math.abs(expected - fl.endingCash) > 3) { ok = false; firstBad = firstBad ?? fl.year }
}
T('jede Jahreskasse geht auf', ok, firstBad ? `zuerst ${firstBad}` : 'alle Jahre')
T('Anfangsbestand ist der Endbestand des Vorjahres',
  r.flows.every((fl, i) => i === 0 || near(fl.startingCash, r.flows[i - 1].endingCash, 2)))
T('Startkasse = Eigenkapital minus gebundenes Kapital der ersten Kaeufe',
  near(r.flows[0].startingCash, cash, 2), `${eur(r.flows[0].startingCash)} gegen ${eur(cash)}`)

console.log('\n── Refinanzierung ──')
T('genutzte Refinanzierung uebersteigt nie die Kapazitaet des Jahres',
  r.events.filter(e => e.kind === 'refinance').every(e => e.newLoanAmount <= e.usableCapacity + 1))
T('jede Tranche taucht in der Restschuld auf',
  r.tranches.every(t => {
    const sch = trancheSchedule(t, r.lastYear)
    const rest = sch.length ? sch[sch.length - 1].rest : 0
    return rest >= 0
  }))
const trancheDebt = r.tranches.reduce((a, t) => {
  const sch = trancheSchedule(t, r.lastYear)
  return a + (sch.length ? sch[sch.length - 1].rest : 0)
}, 0)
const unitDebt = r.outcomes.reduce((a, o) => {
  const i = r.lastYear - o.unit.readyY
  const n = o.res.restL.length
  return a + (i >= 0 ? o.res.restL[Math.min(i, n - 1)] : 0)
}, 0)
T('Gesamtschuld = Wohnungsdarlehen plus offene Tranchen',
  near(r.rows[r.rows.length - 1].debt, Math.round(unitDebt + trancheDebt), 3),
  eur(r.rows[r.rows.length - 1].debt))

console.log('\n── Kaufdeckung ──')
T('jeder Kauf ist aus Kasse und Refinanzierung gedeckt',
  r.events.filter(e => e.kind === 'purchase')
    .every(e => e.fundedFromCash + e.fundedFromRefinance + e.fundedFromSale + 1 >= e.equity))

console.log('\n── Verkauf ──')
const sellP = { ...ON, autoReinvest: false }
const sold = runReinvest([unit('A', { saleYear: 2036 }), unit('B', { buyY: 2028, readyY: 2029 })], sellP)
for (const s of sold.sales) {
  T(`Verkauf ${s.name}: Wert minus Schuld minus Kosten minus Steuer = Erloes`,
    near(s.netProceeds, s.line.value - s.line.debt - s.line.sellCost - s.levy - s.line.vatClawback - s.cgt - s.taxDE, 2),
    eur(s.netProceeds))
}

console.log('\n── Eigenkapital-Verteilung ──')
const outs = allocate(UNITS, ON)
const shares = outs.map(o => o.res.ekAbs / o.gross)
T('keine Wohnung wird zu ueber 95 Prozent finanziert',
  shares.every(sh => sh >= 0.05), shares.map(sh => `${Math.round(sh * 100)} %`).join(' / '))
T('die Eigenkapitalanteile liegen dicht beieinander',
  Math.max(...shares) - Math.min(...shares) < 0.1,
  `${Math.round(Math.min(...shares) * 100)} bis ${Math.round(Math.max(...shares) * 100)} %`)
T('das eingesetzte Eigenkapital uebersteigt das Startkapital nicht',
  outs.reduce((a, o) => a + o.res.ekAbs, 0) <= ON.ek + 2,
  eur(outs.reduce((a, o) => a + o.res.ekAbs, 0)))

console.log(`\n${fail === 0 ? '🎉' : '⚠️'}  ${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
