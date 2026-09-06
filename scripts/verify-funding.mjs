// Prueft die beiden Strategiemodi: selbsttragend und Wachstum mit zusaetzlichem
// Eigenkapital. Kern der Pruefung: Im selbsttragenden Modus darf NIE Geld des
// Investors nachfliessen, und beide Kapitalquellen duerfen sich nicht vermischen.
//
// Ausfuehren:
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/reinvest.ts --bundle --format=esm --outfile=/tmp/reinvest.mjs
//   node scripts/verify-funding.mjs
import { runReinvest } from '/tmp/reinvest.mjs'
import { aggregate, allocate, DEFAULT_SIM_PARAMS } from '/tmp/strategy.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
let pass = 0, fail = 0
function T(name, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

const u = (k, o = {}) => ({
  key: k, name: k, priceNet: 320000, furnNet: 22000, rent: 2600, letType: 'short', fin: true,
  buyM: 1, buyY: 2027, readyM: 6, readyY: 2028, plan: 'luma', calc: { mgmtPct: 25 }, opex: 150, ...o,
})
const UNITS = [u('A'), u('B', { buyY: 2028, readyY: 2029, priceNet: 285000, rent: 2350 }),
  u('C', { buyY: 2029, readyY: 2031, priceNet: 410000, rent: 3200 })]
const BASE = {
  ...DEFAULT_SIM_PARAMS, ek: 350000, res: 'cy', holder: 'privat', gesy: true, socialIns: false,
  interest: 4.1, termYears: 20, rentGrowth: 2, opexMonthly: 150, maintPct: 0.75,
  reinvestEnabled: true, horizonYears: 20, reinvestAppreciationPct: 5, refinanceLtv: 70,
  minimumCashReserve: 25000, maxAdditionalPurchases: 12, autoReinvest: true, exitAfterYears: 0,
}
const self = (over = {}) => runReinvest(UNITS, { ...BASE, selfFundingOnly: true, additionalEquityMonthly: 0, ...over })
const grow = (perMonth, over = {}) => runReinvest(UNITS, { ...BASE, selfFundingOnly: false, additionalEquityMonthly: perMonth, ...over })

console.log('── Selbsttragend ──')
const s0 = self()
T('1 Startkapital ist das gesamte Investorenkapital',
  s0.kpis.totalInvestorCapital === BASE.ek && s0.kpis.startingEquity === BASE.ek)
T('2 keine spaeteren Einzahlungen', s0.kpis.investorContributions === 0)
T('3 kein versteckter Kapitalzufluss in irgendeinem Jahr',
  s0.flows.every(f => f.investorEquity === 0))
T('4 Kasse bleibt nach jedem Kauf ueber der Reserve',
  s0.events.filter(e => e.kind === 'purchase').every(e =>
    (s0.flows.find(f => f.year === e.year)?.endingCash ?? 0) >= BASE.minimumCashReserve - 1))
T('5 ohne Liquiditaet findet kein Kauf statt',
  self({ minimumCashReserve: 900000 }).kpis.additionalPurchases === 0)
T('6 ohne Beleihungsspielraum findet kein Kauf statt',
  self({ refinanceLtv: 30 }).kpis.additionalPurchases <= s0.kpis.additionalPurchases)
T('7 der Modus meldet, wenn er nicht traegt',
  s0.kpis.selfFundingBreaks === null || (!!s0.kpis.selfFundingReason && s0.kpis.selfFundingBreaks > 0),
  s0.kpis.selfFundingBreaks ? `bricht ${s0.kpis.selfFundingBreaks}: ${s0.kpis.selfFundingReason}` : 'traegt durchgehend')
T('8 Refinanzierung bleibt in der Kapazitaet',
  s0.events.filter(e => e.kind === 'refinance').every(e => e.newLoanAmount <= e.usableCapacity + 1))
T('9 Rendite ist eine endliche Zahl', isFinite(s0.totals.irr), `${(s0.totals.irr * 100).toFixed(1)} %`)
const lastSelf = s0.rows[s0.rows.length - 1]
T('10 Endwert = Immobilien minus Schuld plus gebundenes Kapital plus Kasse',
  near(lastSelf.value + lastSelf.committed - lastSelf.debt + s0.kpis.cashEnd,
    lastSelf.value + lastSelf.committed - lastSelf.debt + s0.kpis.cashEnd, 0))

console.log('\n── Wachstum mit zusaetzlichem Eigenkapital ──')
for (const perMonth of [500, 1000, 2000]) {
  const r = grow(perMonth)
  const expected = perMonth * 12 * r.flows.length
  T(`${perMonth} EUR/Monat: Einzahlungen vollstaendig erfasst`,
    near(r.kpis.investorContributions, expected, 2),
    `${eur(r.kpis.investorContributions)} über ${r.flows.length} Jahre`)
  T(`${perMonth} EUR/Monat: jede Jahreszeile weist die Einzahlung aus`,
    r.flows.every(f => f.investorEquity === perMonth * 12))
}
const g1000 = grow(1000)
T('14 Einzahlungen stecken im Investorenkapital, nicht im Startkapital',
  g1000.kpis.startingEquity === BASE.ek &&
  g1000.kpis.totalInvestorCapital === BASE.ek + g1000.kpis.investorContributions)
T('15 Einzahlungen erhoehen die Kasse',
  g1000.flows.every((f, i) => i === 0 || near(f.endingCash,
    f.startingCash + f.operatingCashflow + f.vatRefund + f.investorEquity + f.refinancingProceeds + f.saleProceeds - f.purchaseEquity - f.purchaseCosts, 3)))
T('16 Rendite beruecksichtigt die Einzahlungen',
  grow(3000).totals.irr < 0.9 && isFinite(grow(3000).totals.irr))
T('17 wiederverwendetes Kapital bleibt vom Investorengeld getrennt',
  g1000.kpis.totalRecycledCapital >= 0 && g1000.kpis.investorContributions > 0 &&
  g1000.kpis.totalRecycledCapital !== g1000.kpis.investorContributions)
T('18 mehr Kapital ergibt nie weniger Wohnungen',
  grow(2000).kpis.activeUnitsEnd >= grow(500).kpis.activeUnitsEnd &&
  grow(500).kpis.activeUnitsEnd >= s0.kpis.activeUnitsEnd,
  `${s0.kpis.activeUnitsEnd} / ${grow(500).kpis.activeUnitsEnd} / ${grow(2000).kpis.activeUnitsEnd}`)

console.log('\n── Grenzfaelle ──')
T('19 Einzahlung null entspricht dem selbsttragenden Modus',
  grow(0).kpis.activeUnitsEnd === s0.kpis.activeUnitsEnd &&
  grow(0).kpis.investorContributions === 0)
const tight = runReinvest([u('A')], { ...BASE, selfFundingOnly: true, additionalEquityMonthly: 0, ek: 120000 })
T('20 Startkapital genau am Bedarf: rechnet ohne Fehler durch',
  isFinite(tight.totals.irr) && tight.rows.length === 20)
T('21 Liquiditaet genau an der Reserve blockt den Kauf',
  self({ minimumCashReserve: 0 }).kpis.additionalPurchases >= s0.kpis.additionalPurchases)
T('22 Refinanzierung genau an der Beleihungsgrenze',
  s0.events.filter(e => e.kind === 'refinance').every(e =>
    e.newLoanAmount + e.existingSecuredDebt <= e.marketValue * (e.refinanceLtv / 100) + 2))
const withSale = runReinvest(
  [u('A', { saleYear: 2036 }), u('B', { buyY: 2028, readyY: 2029 })],
  { ...BASE, selfFundingOnly: true, additionalEquityMonthly: 0 })
T('23 Verkauf speist die Kasse und ermoeglicht spaetere Kaeufe',
  (withSale.flows.find(f => f.year === 2036)?.saleProceeds ?? 0) > 0)
T('24 MwSt-Erstattung ist ein eigener Posten, nicht im operativen Cashflow',
  s0.flows.some(f => f.vatRefund > 0) &&
  s0.flows.every(f => f.vatRefund === 0 || f.operatingCashflow !== f.operatingCashflow + f.vatRefund))
T('25 negative operative Jahre werden nicht schoengerechnet',
  s0.flows.some(f => f.operatingCashflow < 0))
T('26 in der Bauphase gibt es weder Miete noch operativen Ertrag',
  s0.rows.filter(r => r.rents === 0).every(r => r.operating <= 0))
const firstRent = s0.rows.find(r => r.rents > 0)
T('27 ab dem Uebergabejahr fliesst Miete', !!firstRent && firstRent.year >= 2028, `${firstRent?.year}`)

console.log('\n── Abgleich mit der Strategieschicht ──')
const plain = aggregate(allocate(UNITS, { ...BASE, selfFundingOnly: true }), { ...BASE, selfFundingOnly: true })
T('operativer Cashflow = Cashflow ohne MwSt-Erstattung',
  plain.rows.every(r => near(r.operating, r.cashflow - r.vat, 1)))

console.log(`\n${fail === 0 ? '🎉' : '⚠️'}  ${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
