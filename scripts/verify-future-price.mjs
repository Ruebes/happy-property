// STEP 3G: Zukuenftige Immobilien duerfen nicht zum heutigen Preis gekauft
// werden. Prueft die Trennung von Bestandswert und Kaufpreis, die Hochrechnung,
// den Kapitalbedarf ueber die Engine, das Timing der Kaeufe und die Modi.
//
// Ausfuehren:
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/reinvest.ts --bundle --format=esm --outfile=/tmp/reinvest.mjs
//   node scripts/verify-future-price.mjs
import { DEFAULT_SIM_PARAMS, purchaseGrowthOf, scenarioParams } from '/tmp/strategy.mjs'
import { runReinvest, buildModelUnit, modelPriceAt, futurePurchaseQuote } from '/tmp/reinvest.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
let pass = 0, fail = 0
function T(name, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol
const grow = (base, g, n) => Math.round(base * Math.pow(1 + g / 100, n) / 1000) * 1000

const u = (k, o = {}) => ({
  key: k, name: k, priceNet: 320000, furnNet: 22000, rent: 2600, letType: 'short', fin: true,
  buyM: 1, buyY: 2027, readyM: 1, readyY: 2027, plan: 'sofort', calc: { mgmtPct: 25 }, opex: 150, ...o,
})
const U = [u('A'), u('B', { priceNet: 285000, rent: 2350, furnNet: 18000 })]
const P = {
  ...DEFAULT_SIM_PARAMS, ek: 350000, res: 'cy', holder: 'privat', gesy: true, socialIns: false,
  interest: 4.1, termYears: 30, rentGrowth: 2, opexMonthly: 150, maintPct: 0.75,
  reinvestEnabled: true, horizonYears: 20, reinvestAppreciationPct: 5, purchasePriceGrowth: null,
  refinanceLtv: 70, bankValuationFactor: 90, refinanceUtilizationPct: 100,
  minimumCashReserve: 25000, maxAdditionalPurchases: 30, autoReinvest: true, exitAfterYears: 0,
  selfFundingOnly: true, additionalEquityMonthly: 0,
}
const BASE_YEAR = 2027
const model = buildModelUnit(U, P)
const buysOf = r => r.events.filter(e => e.kind === 'purchase')

// ── [1] Referenzobjekt ──────────────────────────────────────────────────────
console.log('\n[1] Referenzobjekt')
T('Durchschnitt: (320k + 285k) / 2', model.priceNet === 303000 && P.reinvestTargetKey === null, eur(model.priceNet))
const mB = buildModelUnit(U, { ...P, reinvestTargetKey: 'B' })
T('Zielobjekt B: Preis, Moebel, Miete von B', mB.priceNet === 285000 && mB.furnNet === 18000 && mB.rent === 2350)
T('unbekannter Key faellt auf Durchschnitt zurueck', buildModelUnit(U, { ...P, reinvestTargetKey: 'zzz' }).priceNet === 303000)

// ── [2] Preissteigerung 0/3/5/7 × Kaufzeitpunkt +0/3/5/10 ───────────────────
console.log('\n[2] Zukuenftiger Kaufpreis = Basis × (1 + g)^n')
for (const g of [0, 3, 5, 7]) for (const n of [0, 3, 5, 10]) {
  const p = { ...P, purchasePriceGrowth: g }
  T(`g=${g} % n=${n}: ${eur(modelPriceAt(model, p, BASE_YEAR + n, BASE_YEAR))}`, modelPriceAt(model, p, BASE_YEAR + n, BASE_YEAR) === grow(model.priceNet, g, n))
}
T('Test A: 0 % → Preis konstant ueber 20 Jahre', [0, 5, 10, 19].every(n => modelPriceAt(model, { ...P, purchasePriceGrowth: 0 }, BASE_YEAR + n, BASE_YEAR) === model.priceNet))
T('Test B: 5 % → 2032 = 303k × 1,05^5 = 387k', modelPriceAt(model, P, 2032, BASE_YEAR) === 387000, eur(modelPriceAt(model, P, 2032, BASE_YEAR)))
T('Default null folgt Wertsteigerung (5 %)', purchaseGrowthOf(P) === 5)
T('Eigener Wert 7 % bei Wertsteigerung 5 %: getrennt', purchaseGrowthOf({ ...P, purchasePriceGrowth: 7 }) === 7 && P.reinvestAppreciationPct === 5)

// ── [3] Test C: Bestand und Zukunft nutzen verschiedene Parameter ───────────
console.log('\n[3] Test C: Bestandswert ≠ Kaufpreislogik')
const noBuy = p => runReinvest(U, { ...p, maxAdditionalPurchases: 0 })
const r37 = noBuy({ ...P, reinvestAppreciationPct: 3, purchasePriceGrowth: 7 })
const r77 = noBuy({ ...P, reinvestAppreciationPct: 7, purchasePriceGrowth: 7 })
const r50 = noBuy({ ...P, reinvestAppreciationPct: 5, purchasePriceGrowth: 0 })
const r57 = noBuy({ ...P, reinvestAppreciationPct: 5, purchasePriceGrowth: 7 })
const oppAt = (r, y) => r.opportunities.find(o => o.year === y)
T('gleiche Kaufpreissteigerung → gleicher Kaufpreis 2035, trotz anderer Bestandswertsteigerung', oppAt(r37, 2035).modelPurchasePrice === oppAt(r77, 2035).modelPurchasePrice)
T('andere Bestandswertsteigerung → anderer Portfoliowert 2035', r37.years.find(y => y.year === 2035).propertyValue < r77.years.find(y => y.year === 2035).propertyValue)
T('gleiche Bestandswertsteigerung → gleicher Portfoliowert 2035, trotz anderer Kaufpreissteigerung', r50.years.find(y => y.year === 2035).propertyValue === r57.years.find(y => y.year === 2035).propertyValue)
T('andere Kaufpreissteigerung → anderer Kaufpreis 2035', oppAt(r50, 2035).modelPurchasePrice < oppAt(r57, 2035).modelPurchasePrice)
T('Bestand: Kaufpreis von A bleibt 320.000 (nicht nachtraeglich veraendert)', r57.units.find(x => x.key === 'A').priceNet === 320000)

// ── [4] Kapitalbedarf ueber die Engine ──────────────────────────────────────
console.log('\n[4] Kapitalbedarf: Kredit, Eigenkapital, Nebenkosten, MwSt aus der Engine')
const q27 = futurePurchaseQuote(model, P, 2027, BASE_YEAR), q30 = futurePurchaseQuote(model, P, 2030, BASE_YEAR)
const q32 = futurePurchaseQuote(model, P, 2032, BASE_YEAR), q35 = futurePurchaseQuote(model, P, 2035, BASE_YEAR)
for (const q of [q27, q30, q32, q35]) {
  T(`${q.year}: Kredit = 70 % × Gesamtpreis`, near(q.loan, q.gross * 0.7, 2), `${eur(q.loan)} / ${eur(q.gross)}`)
  // Nebenkosten werden bar bezahlt: Eigenkapital = Gesamtpreis − Kredit + Nebenkosten.
  T(`${q.year}: Eigenkapital = Gesamtpreis − Kredit + Nebenkosten`, near(q.equity, q.gross - q.loan + q.costs, 2), `${eur(q.equity)}`)
}
T('Nebenkosten steigen mit dem Preis (preisabhaengig)', q32.costs > q27.costs && near(q32.costs / q27.costs, q32.price / q27.price, 0.05), `${eur(q27.costs)} → ${eur(q32.costs)}`)
T('Gesamtpreis 2032 / 2027 ≈ Preisfaktor (Moebel konstant druecken leicht darunter)', q32.gross / q27.gross > 1.2 && q32.gross / q27.gross <= q32.price / q27.price + 0.001, (q32.gross / q27.gross).toFixed(3))
T('Miete 2032 = heute × 1,02^5, nicht × Preisfaktor', q32.rent === Math.round(model.rent * 1.02 ** 5), eur(q32.rent))
T('Anfangsrendite 2032 < 2027', q32.rent * 12 / q32.price < q27.rent * 12 / q27.price)

// ── [5] Kaufereignisse: Preis, Finanzierung, Moebel, keine Vorwegnahme ──────
console.log('\n[5] Kaufereignisse im Motor')
const run5 = runReinvest(U, P)
const buys5 = buysOf(run5)
T('Kaeufe vorhanden', buys5.length > 0, String(buys5.length))
T('jeder Kauf: Preis = Basis × 1,05^(Jahr − 2027)', buys5.every(e => e.price === grow(model.priceNet, 5, e.year - BASE_YEAR)))
T('jeder Kauf: Kredit = 70 % Gesamtpreis, EK = Rest + Nebenkosten (< 3 %)', buys5.every(e => near(e.loan, e.gross * 0.7, 2) && e.equity >= e.gross - e.loan - 1 && e.equity - (e.gross - e.loan) < e.gross * 0.03))
T('jeder Kauf: Moebel bleiben 20.000 (Durchschnitt), nicht hochgerechnet', buys5.every(e => run5.units.find(x => x.key === e.key)?.furnNet === model.furnNet))
// Kaufvertrag und Uebergabe sind zwei Zeitpunkte (Sven 9.9.26): Der Vertrag
// faellt ins Kaufjahr, die Uebergabe liegt um die Bauzeit spaeter.
T('jeder Kauf: Vertrag im Kaufjahr, Uebergabe nach der Bauzeit', buys5.every(e => {
  const x = run5.units.find(x => x.key === e.key)
  return x.buyY === e.year && (x.readyY * 12 + x.readyM) - (x.buyY * 12 + x.buyM) === P.reinvestConstructionMonths
}), `Bauzeit ${P.reinvestConstructionMonths} Monate`)
T('Kaufpreise steigen monoton mit dem Jahr', buys5.every((e, i) => i === 0 || e.price >= buys5[i - 1].price))
T('spaetester Kauf teurer als erster', buys5.length > 1 && buys5[buys5.length - 1].price > buys5[0].price, `${eur(buys5[0].price)} (${buys5[0].year}) → ${eur(buys5[buys5.length - 1].price)} (${buys5[buys5.length - 1].year})`)

// Test D: keine Wertsteigerung vor dem Kauf.
console.log('\n[6] Test D: keine Wertsteigerung vor dem Kauf, keine doppelte Wertsteigerung')
const ref = noBuy(P)
const firstLate = buys5.find(e => e.year >= BASE_YEAR + 3)
if (firstLate) {
  const y = firstLate.year
  const sameYear = buys5.filter(e => e.year === y)
  const grossSum = sameYear.reduce((a, e) => a + e.gross, 0)
  const contrib = run5.years.find(r => r.year === y).propertyValue - ref.years.find(r => r.year === y).propertyValue
    - buysOf(run5).filter(e => e.year < y).reduce((a, e) => a + run5.years.find(r => r.year === y).propertyValue * 0, 0)
  // Vorherige Kaeufe stecken auch im Portfolio: deshalb gegen den Lauf mit
  // einem Kauf weniger vergleichen.
  const fewer = runReinvest(U, { ...P, maxAdditionalPurchases: buysOf(run5).filter(e => e.year <= y).length - sameYear.length })
  const delta = run5.years.find(r => r.year === y).propertyValue - fewer.years.find(r => r.year === y).propertyValue
  // Im Kaufjahr steht die Wohnung noch im Bau: Sie taucht erst mit der
  // Uebergabe im Portfoliowert auf, vorher zaehlt sie als gebundenes Kapital.
  T(`Kauf ${y}: im Kaufjahr noch kein Wertbeitrag (Bauphase)`, delta <= 2, `${eur(delta)}`)
  const hy = run5.units.find(x => x.key === firstLate.key).readyY
  const fewer2 = runReinvest(U, { ...P, maxAdditionalPurchases: buysOf(run5).filter(e => e.year <= y).length - sameYear.length })
  const deltaH = run5.years.find(r => r.year === hy).propertyValue - fewer2.years.find(r => r.year === hy).propertyValue
  T(`Kauf ${y}: Wertbeitrag ab Uebergabe ${hy} vorhanden`, deltaH > grossSum * 0.9, `${eur(deltaH)} vs Kaufpreis ${eur(grossSum)}`)
  T(`Kauf ${y}: NICHT seit ${BASE_YEAR} mitgewachsen`, deltaH < grossSum * Math.pow(1.05, hy - BASE_YEAR) * 0.98)
  void contrib
} else T('Test D: spaeter Kauf vorhanden', false)

// ── [7] Test E + Timing: hoeherer Preis verhindert Kaeufe ───────────────────
console.log('\n[7] Test E: Preissteigerung verschiebt und verhindert Kaeufe')
const counts = {}
for (const g of [0, 3, 5, 7, 15, 30]) counts[g] = runReinvest(U, { ...P, purchasePriceGrowth: g }).kpis.additionalPurchases
T('Kaeufe fallen monoton mit der Preissteigerung', [0, 3, 5, 7, 15, 30].every((g, i, a) => i === 0 || counts[g] <= counts[a[i - 1]]), JSON.stringify(counts))
T('0 % > 5 % > 30 % Kaeufe (echter Effekt)', counts[0] > counts[5] && counts[5] > counts[30])
const r30 = runReinvest(U, { ...P, purchasePriceGrowth: 30 })
const lastOpp = r30.opportunities[r30.opportunities.length - 2]
T('30 %: am Ende kein Kauf, obwohl Kapital vorhanden (Preis davongelaufen)', !lastOpp.affordable && lastOpp.requiredEquity > lastOpp.availableCash + lastOpp.refinancingCapacity, `Bedarf ${eur(lastOpp.requiredEquity)} vs Mittel ${eur(lastOpp.availableCash + lastOpp.refinancingCapacity)}`)
T('30 %: Motor rechnet NICHT mit konstantem Preis weiter', lastOpp.modelPurchasePrice > model.priceNet * 50)
const first = g => (buysOf(runReinvest(U, { ...P, purchasePriceGrowth: g }))[0] || {}).year ?? 9999
T('erster Kauf bei 15 % nicht frueher als bei 0 %', first(15) >= first(0), `${first(0)} vs ${first(15)}`)
// Kein Kauf wegen fehlendem Kapital: kleines EK, hoher Preisanstieg.
const poor = runReinvest(U, { ...P, ek: 200000, purchasePriceGrowth: 30, maxAdditionalPurchases: 1 })
T('kein Kauf wegen fehlendem Kapital (ek 200k, 30 %)', poor.kpis.additionalPurchases === 0, String(poor.kpis.additionalPurchases))

// ── [8] Funding-Modi ────────────────────────────────────────────────────────
console.log('\n[8] Selbsttragend und Wachstumsmodus')
const mode = (self, m) => runReinvest(U, { ...P, selfFundingOnly: self, additionalEquityMonthly: m })
const mSelf = mode(true, 0), m500 = mode(false, 500), m1000 = mode(false, 1000), m2000 = mode(false, 2000)
T('selbsttragend: kein Investorengeld nach Start', mSelf.flows.every(f => (f.investorEquity ?? 0) === 0), '')
// Im Startjahr steckt das ganze Eigenkapital in den Startwohnungen; die Reserve
// gilt fuer die Kaeufe des Motors, also ab dem Folgejahr.
T('selbsttragend: Mindestliquiditaet ab dem Folgejahr nie unterschritten', mSelf.years.filter(y => y.year > BASE_YEAR).every(y => y.endingCash >= P.minimumCashReserve - 1))
T('Wachstumsmodus: mehr EK → nicht weniger Wohnungen', mSelf.kpis.activeUnitsEnd <= m500.kpis.activeUnitsEnd && m500.kpis.activeUnitsEnd <= m1000.kpis.activeUnitsEnd && m1000.kpis.activeUnitsEnd <= m2000.kpis.activeUnitsEnd,
  `${mSelf.kpis.activeUnitsEnd} / ${m500.kpis.activeUnitsEnd} / ${m1000.kpis.activeUnitsEnd} / ${m2000.kpis.activeUnitsEnd}`)
T('Wachstumsmodus: Kaufpreis steigt trotzdem', buysOf(m2000).every(e => e.price === grow(model.priceNet, 5, e.year - BASE_YEAR)))
// Der Motor kauft hoechstens eine Wohnung je Jahr; bei 5 % liegen 0 % und 5 %
// deshalb beide am Jahresdeckel. Der Bremseffekt zeigt sich bei 15 %.
T('2.000 €/Monat: nicht beliebig viele Kaeufe (15 % Preis bremst gegen 0 %)', runReinvest(U, { ...P, selfFundingOnly: false, additionalEquityMonthly: 2000, purchasePriceGrowth: 15 }).kpis.additionalPurchases < runReinvest(U, { ...P, selfFundingOnly: false, additionalEquityMonthly: 2000, purchasePriceGrowth: 0 }).kpis.additionalPurchases)

// ── [9] Reinvestment-Varianten ──────────────────────────────────────────────
console.log('\n[9] Kauf mit/ohne Refinanzierung, mit/ohne Eigenkapital')
const noRefi = runReinvest(U, { ...P, refinanceUtilizationPct: 0 })
const refi = runReinvest(U, P)
const ekOnly = runReinvest(U, { ...P, refinanceUtilizationPct: 0, selfFundingOnly: false, additionalEquityMonthly: 1000 })
const both = runReinvest(U, { ...P, selfFundingOnly: false, additionalEquityMonthly: 1000 })
T('ohne Refi: keine Refinanzierungen', noRefi.kpis.refinancings === 0)
T('mit Refi: Refinanzierungen vorhanden', refi.kpis.refinancings > 0)
T('ohne Refi ≤ mit Refi', noRefi.kpis.additionalPurchases <= refi.kpis.additionalPurchases, `${noRefi.kpis.additionalPurchases} ≤ ${refi.kpis.additionalPurchases}`)
T('nur EK ≥ ohne alles', ekOnly.kpis.additionalPurchases >= noRefi.kpis.additionalPurchases)
T('Refi + EK ≥ beide einzeln', both.kpis.additionalPurchases >= Math.max(refi.kpis.additionalPurchases, ekOnly.kpis.additionalPurchases))
T('alle Varianten: Kaufpreis nach Formel', [noRefi, refi, ekOnly, both].every(r => buysOf(r).every(e => e.price === grow(model.priceNet, 5, e.year - BASE_YEAR))))

// ── [10] Szenarien ──────────────────────────────────────────────────────────
console.log('\n[10] Szenarien')
T('optimistisch: null bleibt gekoppelt → 7 %', purchaseGrowthOf(scenarioParams(P, 'optimistisch')) === 7)
T('konservativ: null bleibt gekoppelt → 3 %', purchaseGrowthOf(scenarioParams(P, 'konservativ')) === 3)
T('eigener Wert 7 wird mitgeschoben (konservativ → 5)', scenarioParams({ ...P, purchasePriceGrowth: 7 }, 'konservativ').purchasePriceGrowth === 5)

// ── Ergebnistabelle (Punkt 22) ──────────────────────────────────────────────
console.log('\n════ Referenz ════')
console.log(`Basispreis ${eur(model.priceNet)} (Durchschnitt aus ${eur(U[0].priceNet)} und ${eur(U[1].priceNet)}), Basisjahr ${BASE_YEAR}, Preissteigerung ${purchaseGrowthOf(P)} % (gekoppelt an Wertsteigerung), Moebel ${eur(model.furnNet)} konstant, LTV ${P.refinanceLtv} %`)
console.log('\nKaufjahr | Kaufpreis | Gesamtpreis | Kredit  | Eigenkapital | Nebenkosten | Miete/Monat')
for (const q of [q27, q30, q32, q35]) console.log(`${q.year}     | ${eur(q.price).padStart(9)} | ${eur(q.gross).padStart(11)} | ${eur(q.loan).padStart(7)} | ${eur(q.equity).padStart(12)} | ${eur(q.costs).padStart(11)} | ${eur(q.rent).padStart(6)}`)
console.log('\n════ Strategieergebnis (20 Jahre, 2 Startwohnungen, EK 350.000) ════')
for (const [l, r] of [['Selbsttragend', mSelf], ['500 €/Monat', m500], ['1.000 €/Monat', m1000], ['2.000 €/Monat', m2000]])
  console.log(`${l.padEnd(14)} ${String(r.kpis.activeUnitsEnd).padStart(2)} Wohnungen | Kaeufe ${String(r.kpis.additionalPurchases).padStart(2)} | Portfolio ${eur(r.kpis.portfolioValueEnd).padStart(11)} | Nettovermoegen ${eur(r.years[r.years.length - 1].netWorth).padStart(10)} | letzter Kaufpreis ${eur((buysOf(r).slice(-1)[0] || { price: 0 }).price)}`)
console.log('\nZum Vergleich ohne Preissteigerung (alt):')
for (const [l, self, m] of [['Selbsttragend', true, 0], ['2.000 €/Monat', false, 2000]]) {
  const r = runReinvest(U, { ...P, selfFundingOnly: self, additionalEquityMonthly: m, purchasePriceGrowth: 0 })
  console.log(`${l.padEnd(14)} ${String(r.kpis.activeUnitsEnd).padStart(2)} Wohnungen | Kaeufe ${String(r.kpis.additionalPurchases).padStart(2)} | Nettovermoegen ${eur(r.years[r.years.length - 1].netWorth)}`)
}

console.log(`\n${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
