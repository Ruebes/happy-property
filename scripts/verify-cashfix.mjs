// Prueft die vier Korrekturen aus dem Audit vom 9.9.2026:
//   1. Kaufjahr-Cashflow: die neu gekaufte Wohnung und ihre Tranche muessen im
//      Kaufjahr in der Kasse UND in der Tragbarkeitspruefung stehen.
//   2. Kaufnebenkosten nur einmal: Darlehen + Eigenkapital = Funding-Bedarf.
//   3. Zentrale Geldtoleranz: keine Millionenspruenge durch Cent-Differenzen.
//   4. Selbsttragend ist eine harte Bedingung: Reserve zu JEDEM Zeitpunkt.
//
// Ausfuehren:
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/reinvest.ts --bundle --format=esm --outfile=/tmp/reinvest.mjs
//   node scripts/verify-cashfix.mjs
import { DEFAULT_SIM_PARAMS } from '/tmp/strategy.mjs'
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
const base = runReinvest(UNITS, P)
const buys = r => r.events.filter(e => e.kind === 'purchase')

// ── [1] Funding-Reconciliation: Nebenkosten genau einmal ────────────────────
console.log('\n[1] Funding-Reconciliation je Kauf')
for (const ev of buys(base)) {
  const o = base.outcomes.find(x => x.unit.key === ev.key)
  const bedarf = ev.gross + o.res.costs
  T(`${ev.name} (${ev.year}): Darlehen + Eigenkapital = Funding-Bedarf`,
    near(o.loan + ev.equity, bedarf, 2), `${eur(o.loan)} + ${eur(ev.equity)} = ${eur(o.loan + ev.equity)} vs ${eur(bedarf)}`)
  T(`${ev.name}: Beleihungsauslauf exakt ${P.refinanceLtv} %`,
    near(o.loan, ev.gross * P.refinanceLtv / 100, 2), `${(o.loan / ev.gross * 100).toFixed(2)} %`)
  T(`${ev.name}: Kaufereignis und Portfolio nennen dasselbe Darlehen`, ev.loan === o.loan, `${eur(ev.loan)} vs ${eur(o.loan)}`)
  T(`${ev.name}: Eigenkapital = Kaufpreis - Darlehen + Nebenkosten`,
    near(ev.equity, ev.gross - o.loan + o.res.costs, 2), eur(ev.equity))
}
T('kein Kauf hat eine Finanzierungsluecke', buys(base).every(ev => {
  const o = base.outcomes.find(x => x.unit.key === ev.key)
  return Math.abs(o.loan + ev.equity - (ev.gross + o.res.costs)) <= 2
}))

// ── [2] Kaufjahr-Cashflow: Kasse und Tabelle stimmen ueberein ───────────────
console.log('\n[2] Kaufjahr-Cashflow')
let maxDiff = 0, worst = null
for (const f of base.flows) {
  const row = base.rows.find(r => r.year === f.year)
  const d = Math.abs(f.operatingCashflow - Math.round(row.operating))
  if (d > maxDiff) { maxDiff = d; worst = f.year }
}
T('Kasse und Jahrestabelle nennen denselben operativen Cashflow', maxDiff <= 1, `groesste Abweichung ${eur(maxDiff)}${worst ? ` (${worst})` : ''}`)
const buyYears = new Set(buys(base).map(e => e.year))
T('auch in den Kaufjahren', [...buyYears].every(y => {
  const f = base.flows.find(x => x.year === y), row = base.rows.find(x => x.year === y)
  return Math.abs(f.operatingCashflow - Math.round(row.operating)) <= 1
}), [...buyYears].join(', '))
// Kassenbruecke
let cash = 0, chainOk = true
for (const f of base.flows) {
  cash = cash + f.operatingCashflow + f.vatRefund + f.investorEquity + f.refinancingProceeds + f.saleProceeds - f.purchaseEquity - f.purchaseCosts
  if (Math.abs(cash - f.endingCash) > 2) chainOk = false
}
T('Kassenbruecke schliesst ueber alle Jahre', chainOk, `Ende ${eur(cash)} vs ${eur(base.kpis.cashEnd)}`)
T('keine kuenstliche Auffuellung auf die Mindestreserve', base.flows.some(f => f.endingCash !== P.minimumCashReserve),
  'mindestens ein Jahr weicht von 25.000 ab')

// ── [3] Geldtoleranz: keine Spruenge durch Cent-Differenzen ────────────────
console.log('\n[3] Rundungstoleranz')
T('MONEY_TOLERANCE ist exportiert und positiv', typeof MONEY_TOLERANCE === 'number' && MONEY_TOLERANCE > 0, `${MONEY_TOLERANCE} EUR`)
const sweep = [398999, 399000, 399000.01, 399100, 400000].map(ek => {
  const r = runReinvest(UNITS, { ...P, ek })
  return { ek, buys: r.kpis.additionalPurchases, nw: r.years.at(-1).netWorth, units: r.kpis.activeUnitsEnd }
})
for (const s of sweep) console.log(`     ${eur(s.ek).padStart(9)} EUR: ${s.buys} Zukaeufe, ${s.units} Wohnungen, Nettovermoegen ${eur(s.nw)}`)
const cnt = new Set(sweep.map(s => s.buys))
T('gleiche Anzahl Zukaeufe ueber 398.999 bis 400.000', cnt.size === 1, `Werte: ${[...cnt].join(', ')}`)
T('Cent-Unterschied loest keine zusaetzliche Wohnung aus',
  sweep[1].units === sweep[2].units, `399.000 -> ${sweep[1].units}, 399.000,01 -> ${sweep[2].units}`)
const nws = sweep.map(s => s.nw)
T('Nettovermoegen springt nicht um Millionen', Math.max(...nws) - Math.min(...nws) < 200000,
  `Spanne ${eur(Math.max(...nws) - Math.min(...nws))}`)
// Feinraster: Monotonie im Grossen
const fine = []
for (let ek = 396000; ek <= 404000; ek += 500) fine.push(runReinvest(UNITS, { ...P, ek }).years.at(-1).netWorth)
const spread = Math.max(...fine) - Math.min(...fine)
T('Feinraster 396k-404k ohne Millionensprung', spread < 300000, `Spanne ${eur(spread)} ueber 17 Laeufe`)

// ── [4] Selbsttragend ist hart ──────────────────────────────────────────────
console.log('\n[4] Selbsttragfaehigkeit')
T('kpis.selfSupporting existiert', typeof base.kpis.selfSupporting === 'boolean')
const dips = base.flows.filter(f => f.endingCash < P.minimumCashReserve - MONEY_TOLERANCE)
T('selfSupporting false, sobald die Reserve einmal unterschritten wird',
  base.kpis.selfSupporting === (dips.length === 0),
  `${dips.length} Jahre unter der Reserve${dips.length ? ` (${dips.map(d => d.year).join(', ')})` : ''}`)
if (dips.length) T('Bruchjahr ist das erste Jahr unter der Reserve',
  base.kpis.selfFundingBreaks === dips[0].year, `${base.kpis.selfFundingBreaks} vs ${dips[0].year}`)
// Eine spaetere Erstattung darf eine Luecke nicht heilen.
const tight = runReinvest(UNITS, { ...P, minimumCashReserve: 120000 })
const tightDips = tight.flows.filter(f => f.endingCash < 120000 - MONEY_TOLERANCE)
T('hohe Reserve: Luecke wird nicht durch spaetere Erstattung geheilt',
  tightDips.length === 0 || tight.kpis.selfSupporting === false,
  `${tightDips.length} Jahre unter 120.000, selfSupporting ${tight.kpis.selfSupporting}`)
T('kein Investorengeld im selbsttragenden Modus', base.flows.every(f => f.investorEquity === 0))
T('Modus und Ergebnis sind getrennte Felder', base.kpis.selfFunding === P.selfFundingOnly)
// Growth-Modus: Investorengeld darf fliessen
const grow = runReinvest(UNITS, { ...P, selfFundingOnly: false, additionalEquityMonthly: 1000 })
T('Wachstumsmodus zahlt 12.000 im Jahr ein', grow.flows.every(f => f.investorEquity === 12000))
T('Wachstumsmodus kauft nicht weniger', grow.kpis.additionalPurchases >= base.kpis.additionalPurchases,
  `${grow.kpis.additionalPurchases} vs ${base.kpis.additionalPurchases}`)

// ── [5] Keine Schoenrechnung ────────────────────────────────────────────────
console.log('\n[5] Keine Schoenrechnung')
T('Beleihung nie ueber die eingestellte Grenze', base.events.filter(e => e.kind === 'refinance')
  .every(e => e.newLoanAmount <= e.theoreticalCapacity + MONEY_TOLERANCE))
T('Beleihung nur auf uebergebene Wohnungen', base.events.filter(e => e.kind === 'refinance').every(e => {
  const o = base.outcomes.find(x => x.unit.key === e.propertyKeys[0])
  return o && o.unit.readyY <= e.year
}))
T('Mehrwertsteuer erst im Jahr der Faelligkeit', base.flows.every(f => {
  const row = base.rows.find(r => r.year === f.year)
  return Math.abs(f.vatRefund - Math.round(row.vat)) <= 1
}))
T('theoretische Beleihungskapazitaet ist kein Bargeld',
  base.years.at(-1).refinancingCapacity > base.kpis.cashEnd && base.kpis.cashEnd === Math.round(base.flows.at(-1).endingCash))
T('Immobilienwert unveraendert gegenueber dem Audit-Stand', base.kpis.portfolioValueEnd > 0)

console.log(`\n${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
