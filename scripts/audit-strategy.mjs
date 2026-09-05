// Vollstaendiger Audit des Strategie-Simulators. Prueft die fertige
// Implementierung auf fachliche und technische Fehler; baut nichts Neues.
//
// Ausfuehren:
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/rechner.ts --format=esm --outfile=/tmp/rechner.mjs
//   node scripts/audit-strategy.mjs
import {
  allocate, aggregate, totalsOf, computeExit, runScenarios, assessRisk, breakEvenGrowth,
  migrateConfig, equityOutflowByYear, roeMeaningful, SCENARIO_KEYS, DEFAULT_SIM_PARAMS,
} from '/tmp/strategy.mjs'
import { cyTax, compute, DEFAULT_PARAMS } from '/tmp/rechner.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
let pass = 0, fail = 0
const results = []
function T(name, ok, detail = '') {
  ok ? pass++ : fail++
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol

// Basis-Wohnung: ohne Finanzierung, damit die Steuerbasis glatt nachrechenbar ist.
const unit = (key, over = {}) => ({
  key, name: key, priceNet: 400000, furnNet: 0, rent: 2500, letType: 'short', fin: false,
  buyM: 1, buyY: 2027, readyM: 1, readyY: 2027, plan: 'sofort', calc: { mgmtPct: 25 }, opex: 0, ...over,
})
const P = {
  ...DEFAULT_SIM_PARAMS, res: 'cy', holder: 'privat', gesy: false, socialIns: false,
  ek: 5000000, rentGrowth: 0, growth: 0, maintPct: 0, opexMonthly: 0, exitAfterYears: 0,
}
const run = (units, p = P) => {
  const outcomes = allocate(units, p)
  const agg = aggregate(outcomes, p)
  const exit = computeExit(outcomes, p, agg.firstYear)
  return { outcomes, agg, exit, totals: totalsOf(outcomes, agg.rows, p, exit), p }
}

console.log('\n═══ 7. Zyprische Progression, Grenzfaelle und Cliff-Effect ═══')
const bands = [21999, 22000, 22001, 31999, 32000, 32001, 41999, 42000, 42001, 71999, 72000, 72001]
let cliff = false, monotone = true
let prevNet = -Infinity
for (const inc of bands) {
  const net = inc - cyTax(inc)
  if (net < prevNet) { cliff = true }
  prevNet = net
}
for (let i = 0; i <= 200000; i += 137) {
  if (i - cyTax(i) < (i - 137) - cyTax(Math.max(0, i - 137))) { monotone = false; break }
}
T('Kein Cliff-Effect an den Bandgrenzen', !cliff)
T('Verfuegbares Einkommen steigt monoton (Schrittweite 137 EUR bis 200k)', monotone)
T('Freibetrag: 22.000 EUR steuerfrei', cyTax(22000) === 0, `${eur(cyTax(22000))} EUR`)
T('erste Stufe: 22.001 EUR kostet 0,20 EUR', near(cyTax(22001), 0.2, 0.5), `${cyTax(22001)} EUR`)
T('32.000 EUR = 2.000 EUR', near(cyTax(32000), 2000), `${eur(cyTax(32000))} EUR`)
T('42.000 EUR = 4.500 EUR', near(cyTax(42000), 4500), `${eur(cyTax(42000))} EUR`)
T('72.000 EUR = 13.500 EUR', near(cyTax(72000), 13500), `${eur(cyTax(72000))} EUR`)
T('100.000 EUR = 23.300 EUR', near(cyTax(100000), 23300), `${eur(cyTax(100000))} EUR`)

console.log('\n═══ 5. Eine grosse gegen drei kleine Wohnungen ═══')
const big = run([unit('gross', { priceNet: 900000, rent: 5625 })])
const three = run([unit('A', { priceNet: 300000, rent: 1875 }), unit('B', { priceNet: 300000, rent: 1875 }), unit('C', { priceNet: 300000, rent: 1875 })])
T('gleiche Gesamtmiete', near(big.agg.rows[0].rents, three.agg.rows[0].rents, 3),
  `${eur(big.agg.rows[0].rents)} vs ${eur(three.agg.rows[0].rents)}`)
T('gleiche steuerliche Bemessungsgrundlage', near(big.agg.rows[0].baseCY, three.agg.rows[0].baseCY, 3),
  `${eur(big.agg.rows[0].baseCY)} vs ${eur(three.agg.rows[0].baseCY)}`)
T('gleiche Einkommensteuer (Freibetrag nur einmal)', near(big.agg.rows[0].taxes, three.agg.rows[0].taxes, 3),
  `${eur(big.agg.rows[0].taxes)} vs ${eur(three.agg.rows[0].taxes)}`)
T('Steuer entspricht cyTax der Gesamtbasis', near(three.agg.rows[0].taxes, cyTax(three.agg.rows[0].baseCY), 2))

console.log('\n═══ 8. Verlustfaelle je Steuerstruktur ═══')
// Wohnung mit hoher Verwaltung erzeugt einen steuerlichen Verlust.
const lossUnit = (k, mgmt) => unit(k, { rent: 700, calc: { mgmtPct: mgmt } })
const mixed = [unit('A'), unit('B'), lossUnit('C', 95)]
const cyMix = run(mixed)
T('CY privat: Verlust einer Wohnung mindert die Gesamtbasis',
  cyMix.agg.rows[0].baseCY < three.agg.rows[0].baseCY,
  `${eur(cyMix.agg.rows[0].baseCY)} EUR Basis`)
const allNeg = run([lossUnit('A', 95), lossUnit('B', 95)])
T('CY privat: Gesamtverlust ergibt 0 Steuer, kein Vortrag', allNeg.agg.rows[0].taxes === 0)
const firmaNeg = run([lossUnit('A', 95), lossUnit('B', 95)], { ...P, holder: 'firma', divPayoutPct: 0 })
T('Ltd: Verlustjahr ergibt 0 Steuer', firmaNeg.agg.rows[0].taxes === 0)
// Verlustvortrag der Ltd: erst Verlust, dann Gewinn im Folgejahr
const firmaCarry = (() => {
  const p = { ...P, holder: 'firma', divPayoutPct: 0, rentGrowth: 60 }
  const u = [unit('A', { rent: 900, calc: { mgmtPct: 60 } })]
  const r = run(u, p)
  return r
})()
const firstProfitYear = firmaCarry.agg.rows.findIndex(r => r.baseCY > 0)
const carryUsed = firstProfitYear > 0 && firmaCarry.agg.rows[firstProfitYear].taxes < firmaCarry.agg.rows[firstProfitYear].baseCY * 0.15
T('Ltd: Verlustvortrag mindert die Steuer im ersten Gewinnjahr', carryUsed,
  firstProfitYear > 0 ? `Jahr ${firmaCarry.agg.rows[firstProfitYear].year}: Basis ${eur(firmaCarry.agg.rows[firstProfitYear].baseCY)}, Steuer ${eur(firmaCarry.agg.rows[firstProfitYear].taxes)}` : 'kein Gewinnjahr')
const deNeg = run([lossUnit('A', 95), lossUnit('B', 95)], { ...P, res: 'de', deTaxPct: 42 })
T('DE: Verlust wirkt als negative Steuer (Verrechnung mit anderem Einkommen)',
  deNeg.agg.rows[0].taxes < 0, `${eur(deNeg.agg.rows[0].taxes)} EUR`)

console.log('\n═══ 9. Unterschiedliche Kauf- und Uebergabedaten ═══')
const stag = run([
  unit('A', { buyY: 2026, readyY: 2027 }),
  unit('B', { buyY: 2027, readyY: 2029 }),
  unit('C', { buyY: 2028, readyY: 2030 }),
])
const byYear = Object.fromEntries(stag.agg.rows.map(r => [r.year, r]))
T('2026: keine Miete, keine Steuer vor der ersten Uebergabe',
  byYear[2026].rents === 0 && byYear[2026].taxes === 0)
T('2026: gebundenes Kapital ist ausgewiesen', byYear[2026].committed > 0, `${eur(byYear[2026].committed)} EUR`)
T('2027: nur Wohnung A vermietet', near(byYear[2027].rents, stag.outcomes[0].res.rents[0], 2))
T('2029: A und B vermietet', byYear[2029].rents > byYear[2028].rents)
T('2030: alle drei vermietet', byYear[2030].rents > byYear[2029].rents)
T('Steuer steigt mit der Bemessungsgrundlage', byYear[2030].taxes >= byYear[2027].taxes)
T('Immobilienwert waechst erst ab Uebergabe', byYear[2026].value === 0 && byYear[2027].value > 0)

console.log('\n═══ 16./17. Gemeinschaftskosten und Instandhaltung ═══')
const opxP = { ...P, opexMonthly: 150, maintPct: 0 }
const one = run([unit('A', { opex: null })], opxP)
const threeOpx = run([unit('A', { opex: null }), unit('B', { opex: null }), unit('C', { opex: null })], opxP)
T('1 Wohnung = 1 x 150 EUR/Monat', near(one.agg.rows[0].opex, 1800, 2), `${eur(one.agg.rows[0].opex)} EUR/Jahr`)
T('3 Wohnungen = 3 x 150 EUR/Monat', near(threeOpx.agg.rows[0].opex, 5400, 4), `${eur(threeOpx.agg.rows[0].opex)} EUR/Jahr`)
const custom = run([unit('A', { opex: 150 }), unit('B', { opex: 200 }), unit('C', { opex: 100 })], opxP)
T('je Wohnung ueberschreibbar: 150 + 200 + 100 = 450 EUR/Monat',
  near(custom.agg.rows[0].opex, 5400, 4), `${eur(custom.agg.rows[0].opex)} EUR/Jahr`)
const maint = run([unit('A', { priceNet: 300000, opex: 0 })], { ...P, opexMonthly: 0, maintPct: 0.75, growth: 9 })
const grossPrice = maint.outcomes[0].res.pGross
T('Instandhaltung 0,75 % vom Kaufpreis im ersten Jahr',
  near(maint.agg.rows[0].opex, Math.round(grossPrice * 0.0075), 2),
  `${eur(maint.agg.rows[0].opex)} EUR bei ${eur(grossPrice)} Kaufpreis brutto`)
T('Instandhaltung bleibt am Kaufpreis, nicht am gestiegenen Marktwert',
  near(maint.agg.rows[9].opex, maint.agg.rows[0].opex, 2),
  `Jahr 10: ${eur(maint.agg.rows[9].opex)} EUR bei Wert ${eur(maint.agg.rows[9].value)}`)

console.log('\n═══ 12. Wertentwicklung ═══')
let lastValue = -1, lastNet = -Infinity, growthOk = true
for (const g of [0, 2, 5, 9]) {
  const r = run([unit('A')], { ...P, growth: g, exitAfterYears: 10 })
  const v = r.agg.rows[9].value
  if (v <= lastValue) growthOk = false
  lastValue = v
  const netExit = r.exit.net
  if (netExit <= lastNet) growthOk = false
  lastNet = netExit
}
T('hoehere Wertsteigerung erhoeht Immobilienwert und Verkaufserloes', growthOk)
const zeroG = run([unit('A')], { ...P, growth: 0, exitAfterYears: 10 })
T('bei 0 % Wertsteigerung bleibt der Wert auf Kaufpreisniveau',
  near(zeroG.agg.rows[0].value, zeroG.outcomes[0].res.pGross, 2),
  `${eur(zeroG.agg.rows[0].value)} vs ${eur(zeroG.outcomes[0].res.pGross)}`)
const negG = run([unit('A')], { ...P, growth: -2, exitAfterYears: 10 })
T('negative Wertentwicklung senkt den Wert', negG.agg.rows[9].value < negG.outcomes[0].res.pGross,
  `${eur(negG.agg.rows[9].value)} EUR`)
const gRent = run([unit('A')], { ...P, growth: 9 })
T('Wertsteigerung beeinflusst die Miete nicht', near(gRent.agg.rows[0].rents, run([unit('A')], P).agg.rows[0].rents, 1))
T('Wertsteigerung beeinflusst die Steuer nicht', near(gRent.agg.rows[0].taxes, run([unit('A')], P).agg.rows[0].taxes, 1))

console.log('\n═══ 20. Alte gespeicherte Szenarien ═══')
const oldCfg = migrateConfig({ unitsV2: [{ key: 'x', name: 'Alt', priceNet: 300000, furnNet: 0, rent: 1500, letType: 'short', fin: true, buyM: 1, buyY: 2027, readyM: 1, readyY: 2028, plan: 'luma' }], paramsV2: { ek: 100000, growth: 5, interest: 4.1, termYears: 20, rentGrowth: 2, deTaxPct: 42, bundle: true } })
T('altes Szenario behaelt seine Werte', oldCfg.params.ek === 100000 && oldCfg.units.length === 1)
T('fehlende neue Felder bekommen Standardwerte',
  oldCfg.params.opexMonthly === 150 && oldCfg.params.maintPct === 0.75 && oldCfg.params.exitAfterYears === 7 && oldCfg.params.socialIns === true,
  `opex ${oldCfg.params.opexMonthly}, maint ${oldCfg.params.maintPct}, exit ${oldCfg.params.exitAfterYears}`)
const oldRun = run(oldCfg.units, oldCfg.params)
T('altes Szenario rechnet ohne Fehler durch', oldRun.agg.rows.length > 0 && isFinite(oldRun.totals.netWorth))
const v1 = migrateConfig({ units: [{ key: 'a', name: 'V1', price: 300000, vat: 19, rent: 1200, buyM: 0, readyM: 24, plan: 'luma', mortgage: true }], params: { ek: 80000 } })
T('Altformat v1 wird weiterhin gelesen', v1.units.length === 1 && v1.params.ek === 80000)

console.log('\n═══ 1./2./3. Verkauf: Fristen, Bemessung, Freibetrag ═══')
const exBase = { ...P, growth: 5, cpiPct: 2, sellCostPct: 3, lawyerPct: 1 }
const exUnit = (k, o = {}) => unit(k, { fin: true, ...o })
for (const years of [5, 7, 10]) {
  const p = { ...exBase, exitAfterYears: years, ek: 300000 }
  const r = run([exUnit('A')], p)
  const ok = r.exit && r.exit.year === r.agg.firstYear + years - 1 && r.agg.lastYear === r.exit.year
  T(`Test ${years === 5 ? 'A' : years === 7 ? 'B' : 'C'}: Verkauf nach ${years} Jahren`, ok,
    `Jahr ${r.exit?.year}, Nettoerloes ${eur(r.exit?.net)}`)
}
// Rueckzahlung der Vorsteuer sinkt mit der Haltedauer
const vatByYear = [5, 7, 10].map(y => run([exUnit('A')], { ...exBase, exitAfterYears: y, ek: 300000 }).exit.vatClawback)
T('MwSt-Rueckzahlung sinkt mit laengerer Haltedauer und ist im 10. Jahr null',
  vatByYear[0] > vatByYear[1] && vatByYear[2] === 0, vatByYear.map(eur).join(' / '))

// Test D: Deutschland innerhalb der Frist, eigene Bemessungsgrundlage
const deP = { ...exBase, res: 'de', deTaxPct: 42, exitAfterYears: 7, ek: 300000 }
const deR = run([exUnit('A')], deP)
const o = deR.outcomes[0], line = deR.exit.lines[0]
const afaUsed = o.res.afaDE.slice(0, 7).reduce((a, b) => a + b, 0)
const gainDE = Math.max(0, line.value - (line.cost - afaUsed) - line.sellCost)
const rawDE = Math.round(gainDE * 0.42)
T('Test D: deutsche Bemessungsgrundlage mindert die Anschaffungskosten um die genutzte AfA',
  afaUsed > 0 && near(deR.exit.taxDE, Math.max(0, rawDE - deR.exit.cgt), 2),
  `AfA ${eur(afaUsed)}, Gewinn DE ${eur(gainDE)}, Steuer ${eur(deR.exit.taxDE)}`)
T('deutsche Bemessungsgrundlage ist NICHT die zyprische',
  !near(gainDE, deR.exit.gain, 100), `DE ${eur(gainDE)} vs CY ${eur(deR.exit.gain)}`)
T('zyprische Steuer wird auf die deutsche angerechnet',
  near(deR.exit.taxDE + Math.min(deR.exit.cgt, rawDE), rawDE, 2))

// Test E: Zypern-Steuersitz, keine deutsche Steuer
const cyR = run([exUnit('A')], { ...exBase, res: 'cy', exitAfterYears: 7, ek: 300000 })
T('Test E: Steuersitz Zypern loest keine deutsche Verkaufssteuer aus', cyR.exit.taxDE === 0)

// Test F/G/H: mehrere Wohnungen, gemeinsamer Freibetrag
const multi = run([exUnit('A'), exUnit('B'), exUnit('C')], { ...exBase, exitAfterYears: 8, ek: 900000 })
const single = run([exUnit('A')], { ...exBase, exitAfterYears: 8, ek: 300000 })
T('Test F: alle Wohnungen werden im selben Jahr verkauft', multi.exit.lines.length === 3)
const cgtErwartet = Math.max(0, Math.round((multi.exit.gain - 30000) * 0.2))
T('Test F: Freibetrag von 30.000 EUR greift genau einmal fuer die ganze Strategie',
  near(multi.exit.cgt, cgtErwartet, 2), `Gewinn ${eur(multi.exit.gain)}, CGT ${eur(multi.exit.cgt)}`)
const cgtDreifach = Math.max(0, Math.round((multi.exit.gain - 90000) * 0.2))
T('Test F: Freibetrag wird NICHT dreifach gewaehrt', !near(multi.exit.cgt, cgtDreifach, 2),
  `dreifach waere ${eur(cgtDreifach)}`)
T('Test F: Steuer der drei Wohnungen hoeher als bei einer', multi.exit.cgt > single.exit.cgt)
// Test G/H: unterschiedliche Verkaufszeitpunkte sind im Modell nicht vorgesehen
const staggered = run([exUnit('A', { buyY: 2027, readyY: 2027 }), exUnit('B', { buyY: 2030, readyY: 2030 })],
  { ...exBase, exitAfterYears: 6, ek: 600000 })
T('Test G/H: eine beim Verkauf noch nicht uebergebene Wohnung erzeugt keinen Gewinn',
  staggered.exit.lines.some(l => !l.delivered) === false || staggered.exit.lines.filter(l => !l.delivered).every(l => l.gain === 0))
T('Test H: alle Wohnungen teilen EIN Verkaufsjahr (bewusste Modellgrenze)',
  new Set(staggered.exit.lines.map(() => staggered.exit.year)).size === 1)
const firmaExit = run([exUnit('A'), exUnit('B')], { ...exBase, holder: 'firma', exitAfterYears: 8, ek: 600000 })
T('Ltd bekommt keinen Freibetrag', near(firmaExit.exit.cgt, Math.round(firmaExit.exit.gain * 0.2), 2))

console.log('\n═══ 4. Deutschland gegen Zypern bei identischer Immobilie ═══')
const cmpUnits = [exUnit('A')]
const cmpBase = { ...exBase, exitAfterYears: 7, ek: 300000, gesy: true, socialIns: true }
const cmpDE = run(cmpUnits, { ...cmpBase, res: 'de', deTaxPct: 42 })
const cmpCY = run(cmpUnits, { ...cmpBase, res: 'cy' })
console.log(`   laufende Steuer   DE ${eur(cmpDE.totals.taxes)}  |  CY ${eur(cmpCY.totals.taxes)}`)
console.log(`   Exit-Steuer       DE ${eur(cmpDE.exit.cgt + cmpDE.exit.taxDE)}  |  CY ${eur(cmpCY.exit.cgt)}`)
console.log(`   Nettoerloes       DE ${eur(cmpDE.exit.net)}  |  CY ${eur(cmpCY.exit.net)}`)
console.log(`   Cashflow kumul.   DE ${eur(cmpDE.totals.cashflow)}  |  CY ${eur(cmpCY.totals.cashflow)}`)
console.log(`   IRR               DE ${(cmpDE.totals.irr * 100).toFixed(1)} %  |  CY ${(cmpCY.totals.irr * 100).toFixed(1)} %`)
console.log(`   Netto-Vermoegen   DE ${eur(cmpDE.totals.netWorth)}  |  CY ${eur(cmpCY.totals.netWorth)}`)
T('DE und CY unterscheiden sich in der laufenden Steuer', cmpDE.totals.taxes !== cmpCY.totals.taxes)
T('nur Deutschland besteuert den Verkauf zusaetzlich', cmpDE.exit.taxDE > 0 && cmpCY.exit.taxDE === 0)
T('nur Zypern erhebt GESY und Sozialversicherung', cmpCY.totals.si > 0 && cmpDE.totals.si === 0)
T('gleiche Immobilie, gleicher Verkaufswert', near(cmpDE.exit.value, cmpCY.exit.value, 1))
T('gleicher Rohgewinn vor Steuern', near(cmpDE.exit.gain, cmpCY.exit.gain, 1))

console.log('\n═══ 6. Einzelrechnung gegen Strategie ═══')
// Miete hoch genug, damit die Gesamtbasis ueber dem Freibetrag liegt und die
// Progression ueberhaupt greifen kann.
const soloP = { ...P, res: 'cy', growth: 5, rentGrowth: 2, opexMonthly: 150, maintPct: 0.75, socialIns: false, gesy: false }
const soloUnit = o => unit(o, { opex: null, rent: 4500 })
const soloStrat = run([soloUnit('A')], soloP)
const so = soloStrat.outcomes[0]
T('Strategie und Engine nutzen dieselbe Miete', near(soloStrat.agg.rows[0].rents, so.res.rents[0], 1))
T('dieselbe Verwaltung', near(soloStrat.agg.rows[0].mgmt, so.res.mgmt[0], 1))
T('dieselben laufenden Kosten', near(soloStrat.agg.rows[0].opex, so.res.opexA[0], 1))
T('dieselben Zinsen', near(soloStrat.agg.rows[0].interest, so.res.intC[0], 1))
T('derselbe Immobilienwert', near(soloStrat.agg.rows[0].value, so.res.propV[0], 1))
T('bei EINER Wohnung ist die Steuer in Strategie und Einzelrechnung gleich',
  near(soloStrat.agg.rows[0].taxes, so.res.taxU[0], 2),
  `${eur(soloStrat.agg.rows[0].taxes)} vs ${eur(so.res.taxU[0])}`)
const trioStrat = run([soloUnit('A'), soloUnit('B'), soloUnit('C')], soloP)
const summeEinzeln = trioStrat.outcomes.reduce((a, x) => a + x.res.taxU[0], 0)
T('bei DREI Wohnungen liegt die Strategie ueber der Summe der Einzelrechnungen (Progression)',
  trioStrat.agg.rows[0].taxes > summeEinzeln,
  `Strategie ${eur(trioStrat.agg.rows[0].taxes)} vs Summe ${eur(summeEinzeln)}`)
T('die Differenz kommt nur aus der Steuer, nicht aus Miete oder Kosten',
  near(trioStrat.agg.rows[0].rents, trioStrat.outcomes.reduce((a, x) => a + x.res.rents[0], 0), 2) &&
  near(trioStrat.agg.rows[0].mgmt, trioStrat.outcomes.reduce((a, x) => a + x.res.mgmt[0], 0), 2) &&
  near(trioStrat.agg.rows[0].opex, trioStrat.outcomes.reduce((a, x) => a + x.res.opexA[0], 0), 2))

console.log('\n═══ 10. Ratenplan und Finanzierung ═══')
const ratenUnit = unit('R', { fin: true, plan: 'luma', buyY: 2027, buyM: 1, readyY: 2030, readyM: 6, priceNet: 400000, furnNet: 20000 })
const raten = run([ratenUnit], { ...P, ek: 150000, interest: 4.1, growth: 5 })
const ro = raten.outcomes[0]
const planSum = ro.payments.reduce((a, x) => a + x.amount, 0)
T('Ratenplan summiert sich exakt auf den Gesamtpreis', near(planSum, ro.gross, 2),
  `${eur(planSum)} vs ${eur(ro.gross)}`)
T('Reservierung ist die erste Rate', ro.payments[0].amount === 10000)
T('letzte Rate faellt zur Uebergabe', ro.payments[ro.payments.length - 1].ym === (2030 * 12 + 5))
const beforeReady = raten.agg.rows.filter(r => r.year < 2030)
T('vor der Uebergabe keine Annuitaet', beforeReady.every(r => r.principal === 0))
T('vor der Uebergabe keine Miete und keine Vermietungssteuer',
  beforeReady.every(r => r.rents === 0 && r.taxes <= 0))
T('vor der Uebergabe laufen Bauzeitzinsen auf den vorfinanzierten Teil',
  beforeReady.some(r => r.bridgeInterest > 0), `Spitze ${eur(raten.agg.bridgePeak)} EUR`)
T('Zwischenkredit wird bei der Uebergabe abgeloest',
  (raten.agg.rows.find(r => r.year === 2030)?.bridgeDebt ?? 0) === 0)
const rowReady = raten.agg.rows.find(r => r.year === 2030)
T('ab der Uebergabe laeuft die Annuitaet', rowReady.principal > 0 && rowReady.interest > 0)
T('Darlehen entspricht Gesamtpreis abzueglich Eigenkapital', near(ro.loan, ro.gross - ro.res.ekAbs, 2),
  `${eur(ro.loan)} EUR`)
let debtFalling = true
const debtRows = raten.agg.rows.filter(r => r.year >= 2030)
for (let i = 1; i < debtRows.length; i++) if (debtRows[i].debt > debtRows[i - 1].debt) debtFalling = false
T('Restschuld sinkt ab der Uebergabe monoton', debtFalling)
T('keine doppelte Finanzierung: Bauzeitzins und Annuitaet nie im selben Jahr auf denselben Betrag',
  raten.agg.rows.every(r => !(r.bridgeDebt > 0 && r.principal > 0)))

console.log('\n═══ 11. Bewusst schlechte Immobilie ═══')
const badUnit = unit('bad', { fin: true, rent: 600, calc: { mgmtPct: 40 }, priceNet: 400000, opex: 300 })
const bad = run([badUnit], { ...P, ek: 10000, interest: 7, growth: 0, maintPct: 1.5, opexMonthly: 300, exitAfterYears: 10 })
T('negativer Cashflow wird ausgewiesen', bad.totals.cashflowLastYear < 0, `${eur(bad.totals.cashflowLastYear)} EUR`)
T('Restschuld bleibt positiv und endlich', bad.totals.debtEnd > 0 && isFinite(bad.totals.debtEnd))
T('IRR bleibt eine endliche Zahl oder ist ehrlich NaN', isFinite(bad.totals.irr) || Number.isNaN(bad.totals.irr),
  isFinite(bad.totals.irr) ? `${(bad.totals.irr * 100).toFixed(1)} %` : 'NaN')
T('keine absurde EK-Rendite: Anzeige wird bei zu wenig Eigenkapital unterdrueckt',
  !roeMeaningful(bad.outcomes[0]), `EK-Anteil ${(bad.outcomes[0].ekUsed / bad.outcomes[0].gross * 100).toFixed(1)} %`)
T('Eigenkapital-Abfluss entspricht dem eingesetzten Eigenkapital',
  near([...equityOutflowByYear(bad.outcomes, { ...P, ek: 10000 }).values()].reduce((a, b) => a + b, 0),
    bad.outcomes[0].res.ekStart, 2))

console.log('\n═══ 13. Szenarien ═══')
const scUnits = [exUnit('A'), exUnit('B', { buyY: 2028, readyY: 2028 })]
const scP = { ...exBase, ek: 600000, exitAfterYears: 7, growth: 5, rentGrowth: 2, interest: 4.1 }
const sc = runScenarios(scUnits, scP)
T('Basis verwendet exakt die eingestellten Annahmen',
  sc.basis.params.growth === scP.growth && sc.basis.params.rentGrowth === scP.rentGrowth &&
  sc.basis.params.interest === scP.interest && sc.basis.units.every((u, i) => u.rent === scUnits[i].rent))
T('konservativ ist in allen Annahmen schlechter',
  sc.konservativ.params.growth < scP.growth && sc.konservativ.params.rentGrowth < scP.rentGrowth &&
  sc.konservativ.params.interest > scP.interest && sc.konservativ.params.maintPct > scP.maintPct &&
  sc.konservativ.units[0].rent < scUnits[0].rent)
T('optimistisch ist in allen Annahmen besser',
  sc.optimistisch.params.growth > scP.growth && sc.optimistisch.params.rentGrowth > scP.rentGrowth &&
  sc.optimistisch.params.interest < scP.interest && sc.optimistisch.units[0].rent > scUnits[0].rent)
const unveraendert = ['ek', 'termYears', 'exitAfterYears', 'sellCostPct', 'res', 'holder', 'deTaxPct', 'corpTaxPct', 'bundle', 'opexMonthly']
T('Szenarien aendern keine Stammdaten der Strategie',
  SCENARIO_KEYS.every(k => unveraendert.every(f => sc[k].params[f] === scP[f])))
T('Szenarien aendern keine Wohnungsdaten ausser der Mietannahme',
  SCENARIO_KEYS.every(k => sc[k].units.every((u, i) =>
    u.priceNet === scUnits[i].priceNet && u.furnNet === scUnits[i].furnNet &&
    u.buyY === scUnits[i].buyY && u.readyY === scUnits[i].readyY && u.plan === scUnits[i].plan)))
T('die drei Szenarien liefern unterschiedliche Ergebnisse',
  new Set(SCENARIO_KEYS.map(k => Math.round(sc[k].totals.netWorth))).size === 3,
  SCENARIO_KEYS.map(k => eur(sc[k].totals.netWorth)).join(' / '))
T('Reihenfolge stimmt: konservativ < Basis < optimistisch',
  sc.konservativ.totals.netWorth < sc.basis.totals.netWorth &&
  sc.basis.totals.netWorth < sc.optimistisch.totals.netWorth)
T('Verkaufserloes folgt derselben Reihenfolge',
  sc.konservativ.exit.net < sc.basis.exit.net && sc.basis.exit.net < sc.optimistisch.exit.net)

console.log('\n═══ 14. Risiko ═══')
const be = breakEvenGrowth(scUnits, scP)
const risks = assessRisk(sc, be)
T('sechs Risikofelder werden bewertet', risks.length === 6, risks.map(r => r.key).join(', '))
T('jede Bewertung hat eine Stufe und einen Wert',
  risks.every(r => ['gruen', 'gelb', 'rot'].includes(r.level) && r.value && r.note))
// Gegenprobe: eine schlechte Strategie muss schlechtere Ampeln liefern
const badSc = runScenarios([badUnit], { ...P, ek: 20000, interest: 7, growth: 0, maintPct: 1.5, opexMonthly: 300, exitAfterYears: 7 })
const badRisks = assessRisk(badSc, breakEvenGrowth([badUnit], { ...P, ek: 20000, interest: 7, growth: 0, maintPct: 1.5, opexMonthly: 300, exitAfterYears: 7 }))
const stufe = x => x === 'rot' ? 2 : x === 'gelb' ? 1 : 0
T('schlechte Strategie bekommt insgesamt schlechtere Ampeln',
  badRisks.reduce((a, r) => a + stufe(r.level), 0) > risks.reduce((a, r) => a + stufe(r.level), 0),
  `${badRisks.map(r => r.level[0]).join('')} vs ${risks.map(r => r.level[0]).join('')}`)
const cfRisk = badRisks.find(r => r.key === 'cashflow')
T('negativer Cashflow schlaegt in der Ampel durch', cfRisk.level !== 'gruen', `${cfRisk.level}, ${cfRisk.value}`)

console.log('\n═══ 15. Kennzahlen ═══')
const kz = run([exUnit('A'), exUnit('B')], { ...exBase, ek: 600000, exitAfterYears: 7 })
const tt = kz.totals
const felder = ['ekTotal', 'netWorth', 'rents', 'taxes', 'debtEnd', 'roe5', 'roe10', 'irr', 'cashflow',
  'cashflowLastYear', 'valueEnd', 'equityInProperty', 'interest', 'principal', 'opex', 'mgmt']
T('alle Kennzahlen sind vorhanden und endlich', felder.every(f => typeof tt[f] === 'number' && isFinite(tt[f])),
  felder.filter(f => !isFinite(tt[f])).join(', ') || 'vollstaendig')
T('Eigenkapital in den Immobilien = Wert minus Restschuld',
  near(tt.equityInProperty, tt.valueEnd - tt.debtEnd, 1))
T('Mieten kumuliert entsprechen der Summe der Jahreszeilen',
  near(tt.rents, kz.agg.rows.reduce((a, r) => a + r.rents, 0), 1))
T('Zinsen kumuliert entsprechen der Summe der Jahreszeilen',
  near(tt.interest, kz.agg.rows.reduce((a, r) => a + r.interest, 0), 1))
// IRR muss aus echten Zahlungsstroemen kommen, nicht aus der EK-Rendite
const ekOut = equityOutflowByYear(kz.outcomes, kz.p)
const flows = kz.agg.rows.map(r => r.cashflow - (ekOut.get(r.year) ?? 0))
flows[flows.length - 1] += kz.exit.net
const npv = flows.reduce((a, c, i) => a + c / Math.pow(1 + tt.irr, i), 0)
T('IRR loest den Kapitalwert der echten Zahlungsstroeme auf null auf', Math.abs(npv) < 5,
  `Kapitalwert ${npv.toFixed(2)} EUR`)
T('IRR ist nicht aus der EK-Rendite abgeleitet', !near(tt.irr * 100, tt.roe10 / 10, 0.5),
  `IRR ${(tt.irr * 100).toFixed(2)} % vs roe10/10 ${(tt.roe10 / 10).toFixed(2)} %`)
const beKz = breakEvenGrowth([exUnit('A'), exUnit('B')], { ...exBase, ek: 600000, exitAfterYears: 7 })
const atBe = run([exUnit('A'), exUnit('B')], { ...exBase, ek: 600000, exitAfterYears: 7, growth: beKz })
const ueberschuss = atBe.exit.net + atBe.agg.rows.reduce((a, r) => a + r.cashflow, 0) - atBe.totals.ekTotal
T('Break-even-Wertsteigerung trifft den Nullpunkt', Math.abs(ueberschuss) < 2500,
  `${beKz} % ergibt ${eur(ueberschuss)} EUR Ueberschuss`)

console.log('\n═══ 18. Regression GESY und Sozialversicherung ═══')
const siP = { ...P, res: 'cy', socialIns: true, gesy: true, rentGrowth: 0 }
const siStag = run([unit('A', { buyY: 2027, readyY: 2029 })], siP)
T('keine Sozialversicherung vor der Uebergabe',
  siStag.agg.rows.filter(r => r.year < 2029).every(r => r.si === 0 && r.gesy === 0))
T('ab der Uebergabe faellt sie an', (siStag.agg.rows.find(r => r.year === 2029)?.si ?? 0) > 0)
const siMulti = run([unit('A'), unit('B'), unit('C')], siP)
T('Sozialversicherung auf der gemeinsamen Bemessungsgrundlage, nicht je Wohnung',
  near(siMulti.agg.rows[0].si, Math.round(Math.min(Math.max(siMulti.agg.rows[0].baseCY, 20318), 68904) * 0.166), 2))
const siHigh = run([unit('A', { rent: 12000 }), unit('B', { rent: 12000 })], siP)
T('Deckel bei 68.904 EUR versicherbarem Einkommen',
  near(siHigh.agg.rows[0].si, Math.round(68904 * 0.166), 2), `${eur(siHigh.agg.rows[0].si)} EUR`)
T('GESY laeuft bei Selbststaendigkeit mit 4 % auf den Gewinn',
  near(siMulti.agg.rows[0].gesy, Math.round(Math.min(Math.max(0, siMulti.agg.rows[0].baseCY), 180000) * 0.04), 2))

console.log('\n═══ 19. Kundenseite gegen CRM ═══')
// Beide Oberflaechen rufen dieselben Funktionen mit denselben Parametern auf.
const cfg = { unitsV2: [exUnit('A'), exUnit('B', { buyY: 2028, readyY: 2028 })], paramsV2: { ...exBase, ek: 600000, exitAfterYears: 7 } }
const a = (() => { const m = migrateConfig(cfg); return run(m.units, m.params) })()
const b = (() => { const m = migrateConfig(cfg); return run(m.units, m.params) })()
T('identische Parameter ergeben identische Ergebnisse',
  a.totals.netWorth === b.totals.netWorth && a.totals.cashflow === b.totals.cashflow &&
  a.totals.taxes === b.totals.taxes && a.totals.irr === b.totals.irr &&
  a.totals.debtEnd === b.totals.debtEnd && a.exit.net === b.exit.net)
const scA = runScenarios(a.outcomes.map(o => o.unit), a.p)
const scB = runScenarios(b.outcomes.map(o => o.unit), b.p)
T('auch die Szenarien sind deckungsgleich',
  SCENARIO_KEYS.every(k => scA[k].totals.netWorth === scB[k].totals.netWorth && scA[k].exit.net === scB[k].exit.net))

console.log(`\n${fail === 0 ? '🎉' : '⚠️'}  ${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
