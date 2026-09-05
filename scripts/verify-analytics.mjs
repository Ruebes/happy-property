// Prueft die Datenaufbereitung der Kundenauswertung (src/lib/analytics.ts).
// Die Kundenseite rendert nur, was hier herauskommt - also wird hier geprueft.
//
// Ausfuehren:
//   npx esbuild src/lib/analytics.ts --bundle --format=esm --outfile=/tmp/analytics.mjs
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   node scripts/verify-analytics.mjs
import { buildCustomerAnalytics } from '/tmp/analytics.mjs'
import { DEFAULT_SIM_PARAMS } from '/tmp/strategy.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
let pass = 0, fail = 0
function T(name, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const unit = (key, o = {}) => ({
  key, name: key, priceNet: 300000, furnNet: 20000, rent: 2400, letType: 'short', fin: true,
  buyM: 1, buyY: 2027, readyM: 1, readyY: 2027, plan: 'sofort', calc: { mgmtPct: 25 }, opex: 150, ...o,
})
const base = {
  ...DEFAULT_SIM_PARAMS, res: 'cy', holder: 'privat', socialIns: false, gesy: true,
  ek: 150000, interest: 4.1, termYears: 20,
}
const OFF = { ...base, reinvestEnabled: false, exitAfterYears: 7 }
const ON = { ...base, reinvestEnabled: true, horizonYears: 20, reinvestAppreciationPct: 5, exitAfterYears: 0 }

console.log('\n── Fall 1: ohne Reinvestment ──')
const off = buildCustomerAnalytics([unit('A')], OFF)
T('Auswertung entsteht', !!off)
T('zehn Jahre oder weniger', off.wealth.length <= 10, `${off.summary.firstYear}-${off.summary.lastYear}`)
T('kein Reinvestment-Teil', !off.reinvest && off.capitalSteps.length === 0 && off.liquidity.length === 0)
T('Verkaufsrechnung vorhanden', off.summary.exitNet != null && off.exits.length > 0)
T('Recycling wird nicht ausgewiesen', off.summary.recyclingMultiple === null)
T('Szenarien vollstaendig', off.scenarios.length === 3)
T('Zusammenfassungstext passt zum Ergebnis',
  off.summary.text.includes(String(off.summary.unitsEnd)) && !off.summary.text.includes('weitere Wohnungen werden'))

console.log('\n── Fall 2: mit Reinvestment ──')
const on = buildCustomerAnalytics([unit('A')], ON)
T('zwanzig Jahreszeilen', on.wealth.length === 20, `${on.summary.firstYear}-${on.summary.lastYear}`)
T('Portfolio, Cashflow, Finanzierung gleich lang',
  on.portfolio.length === 20 && on.cashflow.length === 20 && on.financing.length === 20)
T('Recycling-Faktor vorhanden', typeof on.summary.recyclingMultiple === 'number')
T('Kapitalschritte und Recycling-Tabelle gefuellt', on.capitalSteps.length > 2 && on.recyclingRows.length > 0)
T('Liquiditaetsreihe vorhanden', on.liquidity.length === 20)
T('Sensitivitaet mit fuenf Stufen', on.sensitivity.length === 5,
  on.sensitivity.map(s => `${s.appreciation}%:${s.units}`).join(' '))
T('kumulierter Cashflow ist wirklich kumuliert',
  Math.abs(on.cashflow[on.cashflow.length - 1].cumulative - on.cashflow.reduce((a, c) => a + c.cashflow, 0)) < 3)

console.log('\n── Fall 3: ein Verkauf ──')
const one = buildCustomerAnalytics([unit('A', { saleYear: 2034 }), unit('B', { buyY: 2029, readyY: 2029 })],
  { ...ON, autoReinvest: false })
const after = one.portfolio.filter(p => p.year > 2034)
T('Wohnung verschwindet ab dem Folgejahr', after.every(p => p.units === 1))
T('Verkauf ist in der Tabelle', one.exits.some(e => e.year === 2034))
T('Verkaufserloes taucht in der Kapitalbewegung auf',
  one.recyclingRows.some(r => r.year === 2034 && r.event === 'Verkauf'))
T('Objektkarte ist als verkauft markiert',
  one.properties.find(p => p.key === 'A')?.soldYear === 2034)
T('Nettoerloes der verkauften Wohnung ist ausgewiesen',
  (one.properties.find(p => p.key === 'A')?.netSaleProceeds ?? 0) > 0,
  eur(one.properties.find(p => p.key === 'A')?.netSaleProceeds ?? 0))

console.log('\n── Fall 4: mehrere Verkaeufe ──')
const two = buildCustomerAnalytics(
  [unit('A', { saleYear: 2036 }), unit('B', { buyY: 2029, readyY: 2029, saleYear: 2040 })],
  { ...ON, autoReinvest: false })
T('beide Verkaeufe erscheinen', two.exits.length === 2, two.exits.map(e => e.year).join(', '))
const steuerSumme = two.exits.reduce((a, e) => a + e.tax, 0)
T('Steuer beim Verkauf wird ausgewiesen', steuerSumme >= 0, `${eur(steuerSumme)} EUR`)
T('Portfolio ist am Ende leer', two.portfolio[two.portfolio.length - 1].units === 0)

console.log('\n── Fall 5: Refinanzierung ──')
T('Refinanzierung erscheint in der Kapitaltabelle',
  on.recyclingRows.some(r => r.event === 'Refinanzierung'))
T('Refinanzierungssumme ist ausgewiesen', on.financingKpis.totalRefinanced > 0,
  `${eur(on.financingKpis.totalRefinanced)} EUR`)
T('Beleihungskapazitaet ist eine eigene Reihe',
  on.financing.some(f => f.capacity > 0))
const refiYear = on.events.find(e => e.kind === 'refinance')?.year
T('nach der Refinanzierung steigt die Schuld',
  !refiYear || (on.financing.find(f => f.year === refiYear)?.debt ?? 0) >
  (on.financing.find(f => f.year === refiYear - 1)?.debt ?? Infinity) ||
  on.events.some(e => e.kind === 'purchase' && e.year === refiYear))

console.log('\n── Fall 6: neue Immobilie ──')
const buyYear = on.events.find(e => e.kind === 'purchase')?.year
if (buyYear) {
  const vor = on.portfolio.find(p => p.year === buyYear - 1)
  const nach = on.portfolio.find(p => p.year === buyYear)
  T('Anzahl steigt genau im Kaufjahr', (nach?.units ?? 0) > (vor?.units ?? 0),
    `${vor?.units} auf ${nach?.units} in ${buyYear}`)
  const wVor = on.wealth.find(w => w.year === buyYear - 1)
  const wNach = on.wealth.find(w => w.year === buyYear)
  T('Portfolio-Wert steigt im Kaufjahr', (wNach?.propertyValue ?? 0) > (wVor?.propertyValue ?? 0))
  T('Objektkarte fuer das Modellobjekt vorhanden', on.properties.some(p => p.model))
} else {
  T('Kaufereignis vorhanden', false, 'kein Kauf im Basisfall')
}

console.log('\n── Fall 7: negative Liquiditaet ──')
const tight = buildCustomerAnalytics([unit('A', { rent: 900, calc: { mgmtPct: 45 } })],
  { ...ON, ek: 90000, minimumCashReserve: 25000 })
T('Warnung wird erzeugt', !!tight.liquidityWarning,
  tight.liquidityWarning ? `${tight.liquidityWarning.from}-${tight.liquidityWarning.to}, tiefster ${eur(tight.liquidityWarning.lowest)}` : '')
T('Warnung taucht in den Erkenntnissen auf',
  !tight.liquidityWarning || tight.insights.some(i => i.text.includes('Reserve') || i.title.includes('Liquidität')))
T('zusaetzlich noetiges Kapital wird beziffert', tight.summary.additionalEquityNeeded >= 0)

console.log('\n── Fall 8/9: konservativ und optimistisch ──')
const basis = on.scenarios.find(s => s.key === 'basis')
const kons = on.scenarios.find(s => s.key === 'konservativ')
const opti = on.scenarios.find(s => s.key === 'optimistisch')
T('alle drei Szenarien gerechnet', !!basis && !!kons && !!opti)
T('konservativ liegt unter Basis', kons.netWorth < basis.netWorth,
  `${eur(kons.netWorth)} gegen ${eur(basis.netWorth)}`)
T('optimistisch liegt ueber Basis', opti.netWorth > basis.netWorth,
  `${eur(opti.netWorth)} gegen ${eur(basis.netWorth)}`)
T('im Reinvestment-Modus unterscheidet sich auch die Anzahl der Wohnungen',
  new Set([kons.units, basis.units, opti.units]).size > 1,
  `${kons.units} / ${basis.units} / ${opti.units}`)

console.log('\n── Fall 10: keine Reinvestitionsmoeglichkeit ──')
const nope = buildCustomerAnalytics([unit('A')], { ...ON, minimumCashReserve: 900000 })
T('kein Kauf findet statt', nope.portfolio[nope.portfolio.length - 1].units === 1)
T('keine irrefuehrende Kaufmeldung', nope.opportunity === null)
T('Zusammenfassung sagt das auch',
  nope.summary.text.includes('ergibt sich unter diesen Annahmen im Betrachtungszeitraum nicht'))

console.log('\n── Datenvertrag ──')
const felder = ['summary', 'wealth', 'portfolio', 'cashflow', 'cashflowRows', 'liquidity', 'financing',
  'financingKpis', 'capitalSteps', 'recyclingRows', 'properties', 'tax', 'taxKpis', 'scenarios',
  'exits', 'risks', 'insights', 'drivers', 'sensitivity', 'events']
T('alle Bereiche der Auswertung sind vorhanden', felder.every(f => on[f] !== undefined),
  felder.filter(f => on[f] === undefined).join(', ') || 'vollstaendig')
T('jede Vermoegenszeile ist vollstaendig',
  on.wealth.every(w => ['propertyValue', 'debt', 'propertyEquity', 'netWorth', 'cash'].every(k => Number.isFinite(w[k]))))
T('Eigenkapital = Wert minus Schuld', on.wealth.every(w => w.propertyEquity === w.propertyValue - w.debt))
// assessRisk liefert das Verkaufsrisiko nur, wenn ein gemeinsamer Verkauf
// gerechnet wird; im Reinvestment-Modus sind es deshalb fuenf Felder.
T('Risiko kommt aus der bestehenden Logik', on.risks.length >= 5 && off.risks.length === 6,
  `${on.risks.length} mit Reinvestment, ${off.risks.length} ohne`)
T('hoechstens drei Erkenntnisse', on.insights.length <= 3 && on.insights.length > 0)
T('Erkenntnisse sind datengetrieben, keine Textbausteine',
  on.insights.some(i => /\d/.test(i.text)))

console.log('\n── Regression 3B: die korrigierten Befunde ──')
// 1/2: Rendite mit Endwert statt negativer Scheinrendite
T('Rendite ist positiv, wenn das Vermoegen waechst', on.summary.irr > 0,
  `${(on.summary.irr * 100).toFixed(1)} %`)
T('ohne Reinvestment bleibt die Rendite unveraendert berechenbar', isFinite(off.summary.irr))
// 3: Cashflow-Tabelle geht auf
const bad = on.cashflowRows.filter(r => {
  const summe = r.rent - r.costs - r.interest - r.amortization - r.tax + r.vatRefund
  return Math.abs(summe - r.net) > 3
})
T('jede Cashflow-Zeile rechnet sich auf den ausgewiesenen Cashflow',
  bad.length === 0, bad.length ? `${bad.length} Zeilen weichen ab, erste ${bad[0].year}` : 'alle Zeilen stimmen')
T('MwSt-Erstattung ist eine eigene Spalte', on.cashflowRows.some(r => r.vatRefund > 0))
// 4: Objektrendite ehrlich benannt
T('Objektkarten nennen den Zuwachs kumuliert, nicht als Jahresrendite',
  on.properties.every(p => p.equityGrowthPct === null || p.equityGrowthYears > 1))
// 5: Szenarien schluessig
const sc3 = Object.fromEntries(on.scenarios.map(s => [s.key, s]))
T('konservativ hat nicht mehr Wohnungen als Basis', sc3.konservativ.units <= sc3.basis.units,
  `${sc3.konservativ.units} gegen ${sc3.basis.units}`)
T('optimistisch hat nicht weniger Wohnungen als Basis', sc3.optimistisch.units >= sc3.basis.units,
  `${sc3.optimistisch.units} gegen ${sc3.basis.units}`)
T('Vermoegen steigt von konservativ ueber Basis nach optimistisch',
  sc3.konservativ.netWorth < sc3.basis.netWorth && sc3.basis.netWorth < sc3.optimistisch.netWorth)
T('jedes Szenario hat eine berechenbare Rendite',
  on.scenarios.every(s => isFinite(s.irr)))
T('Recycling ist positiv, wo zusaetzlich gekauft wurde',
  on.scenarios.every(s => s.units <= 3 || s.recyclingMultiple > 0))
// 6: gekauft gegen im Bestand
T('das erste Jahr zeigt die gekauften Wohnungen', on.portfolio[0].owned > 0,
  `${on.portfolio[0].owned} gekauft, ${on.portfolio[0].units} im Bestand`)
T('kein Text behauptet null Wohnungen',
  !on.insights.some(i => i.text.includes('Aus 0 ')) && !on.summary.text.includes('von 0 '))
// 7: Risiko aus derselben Quelle
const finRisk = on.risks.find(r => r.key === 'finanzierung')
const ltvEnd = on.financingKpis.ltvEnd
T('Risiko und Finanzierungskennzahl nennen denselben Beleihungsgrad',
  Math.abs(parseFloat(finRisk.value) - ltvEnd) < 1.5,
  `Risiko ${finRisk.value}, Kennzahl ${ltvEnd} %`)
// 8: Steuer aufgeschluesselt
T('Einkommensteuer wird getrennt ausgewiesen', typeof on.taxKpis.incomeTax === 'number')
T('Gesamtabgaben sind mindestens so hoch wie die Einkommensteuer',
  on.taxKpis.total >= on.taxKpis.incomeTax)
// 9: Sensitivitaet trennt sich von den Szenarien
T('Sensitivitaet variiert nur die Wertentwicklung',
  new Set(on.sensitivity.map(s => s.appreciation)).size === on.sensitivity.length)
T('hoehere Wertentwicklung ergibt mehr Vermoegen',
  on.sensitivity.every((s, i) => i === 0 || s.netWorth > on.sensitivity[i - 1].netWorth))
// 10: Mindestreserve
const reserveKept = on.liquidity.filter(l => l.cash < on.minimumReserve).length
T('Unterschreitungen der Reserve werden gemeldet, nicht verschwiegen',
  reserveKept === 0 || !!on.liquidityWarning)
// 11: 20-Jahres-Horizont
T('zwanzig Jahre durchgaengig', on.wealth.length === 20 && on.cashflowRows.length === 20)

console.log(`\n${fail === 0 ? '🎉' : '⚠️'}  ${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
