// Prueft Kaeuferstruktur (Einzelperson / Paar) und die Kaufpreissteigerung
// spaeterer Kaeufe im Reinvestment-Motor.
//
// Kern: Freibetraege gelten JE PERSON, niemals je Wohnung. Drei Wohnungen bei
// einer Einzelperson bedeuten 22.000 Euro insgesamt, nicht 66.000. Beim Verkauf
// mehrerer Wohnungen im selben Jahr wird der lebenslange Freibetrag einmal
// verbraucht, nicht je Wohnung.
//
// Ausfuehren:
//   npx esbuild src/lib/rechner.ts  --bundle --format=esm --outfile=/tmp/rechner.mjs
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/reinvest.ts --bundle --format=esm --outfile=/tmp/reinvest.mjs
//   node scripts/verify-buyer.mjs
import { cyTax, cyTaxFor, personsOf } from '/tmp/rechner.mjs'
import { aggregate, allocate, computeExit, computeSale, scenarioParams, runScenarios, purchaseGrowthOf, DEFAULT_SIM_PARAMS } from '/tmp/strategy.mjs'
import { runReinvest, modelPriceAt, buildModelUnit } from '/tmp/reinvest.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
let pass = 0, fail = 0
function T(name, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

// ── 1. Einkommensteuer je Person ────────────────────────────────────────────
console.log('\n[1] Einkommensteuer Einzelperson vs. Paar')
T('single 20.000 = 0', cyTaxFor(1, 20000) === 0)
T('single 22.000 = 0', cyTaxFor(1, 22000) === 0)
T('single 30.000 = 1.600', cyTaxFor(1, 30000) === 1600, eur(cyTaxFor(1, 30000)))
T('couple 20.000 = 0', cyTaxFor(2, 20000) === 0)
T('couple 44.000 = 0', cyTaxFor(2, 44000) === 0)
T('couple 50.000 = 1.200', cyTaxFor(2, 50000) === 1200, eur(cyTaxFor(2, 50000)))
T('couple = 2 × single(halb)', cyTaxFor(2, 100000) === 2 * cyTax(50000))
T('personsOf', personsOf('single') === 1 && personsOf('couple') === 2 && personsOf(undefined) === 1)

// ── 2. Drei Wohnungen: Freibetrag nicht je Wohnung ──────────────────────────
console.log('\n[2] Portfolio: Freibetrag je Person, nicht je Wohnung')
// Miete bewusst hoch, damit der Gewinn dreier Wohnungen ueber 44.000 liegt und
// der Unterschied zwischen 22.000 und 44.000 Freibetrag sichtbar wird.
const u = (k, o = {}) => ({
  key: k, name: k, priceNet: 320000, furnNet: 22000, rent: 4500, letType: 'short', fin: false,
  buyM: 1, buyY: 2027, readyM: 1, readyY: 2027, plan: 'sofort', calc: { mgmtPct: 25 }, opex: 150, ...o,
})
const UNITS = [u('A'), u('B'), u('C')]
const BASE = {
  ...DEFAULT_SIM_PARAMS, ek: 1500000, res: 'cy', holder: 'privat', gesy: false, socialIns: false, cyBI: 0,
  interest: 4.1, termYears: 20, rentGrowth: 2, opexMonthly: 150, maintPct: 0.75,
  reinvestEnabled: false, exitAfterYears: 0, buyerStructure: 'single',
}
const rowsOf = p => aggregate(allocate(UNITS, p), p).rows
const rS = rowsOf(BASE), rC = rowsOf({ ...BASE, buyerStructure: 'couple' })
const yS = rS[2], yC = rC[2]   // drittes Jahr, voll vermietet
// Bemessungsgrundlage der Steuer ist baseCY abzueglich Zwischenfinanzierungszins.
const bS = yS.baseCY - yS.bridgeInterest, bC = yC.baseCY - yC.bridgeInterest
T('gleiche Bemessungsgrundlage', bS === bC, eur(bS))
T('Gewinn > 44.000 (Test aussagekraeftig)', bS > 44000, eur(bS))
T('single = cyTax(Gewinn), Freibetrag 22.000 EINMAL', near(yS.taxCY, cyTax(bS)), `${eur(yS.taxCY)} vs ${eur(cyTax(bS))}`)
T('single ≠ 3 × Freibetrag', yS.taxCY !== cyTax(Math.max(0, bS - 44000)))
T('couple = cyTaxFor(2, Gewinn), Freibetrag 44.000 EINMAL', near(yC.taxCY, cyTaxFor(2, bC)), `${eur(yC.taxCY)} vs ${eur(cyTaxFor(2, bC))}`)
T('couple < single', yC.taxCY < yS.taxCY, `${eur(yC.taxCY)} < ${eur(yS.taxCY)}`)
T('couple zahlt trotzdem Steuer (Gewinn > 44.000)', yC.taxCY > 0)
// 1 Wohnung allein: Gewinn unter 22.000 → beide 0
const one = p => aggregate(allocate([u('A', { rent: 2000 })], p), p).rows[2]
const oS = one(BASE), oC = one({ ...BASE, buyerStructure: 'couple' })
T('1 Wohnung: Gewinn unter Freibetrag → 0 fuer beide', oS.taxCY === 0 && oC.taxCY === 0, `base ${eur(oS.baseCY)}`)
// Firma: Struktur irrelevant
const fS = rowsOf({ ...BASE, holder: 'firma' })[2], fC = rowsOf({ ...BASE, holder: 'firma', buyerStructure: 'couple' })[2]
T('Firma: Kaeuferstruktur ohne Wirkung', fS.taxCY === fC.taxCY && fS.taxes === fC.taxes)

// ── 3. Exit: lebenslanger Freibetrag einmal je Person ───────────────────────
console.log('\n[3] Exit-Freibetrag 30.000 / 60.000, nicht je Wohnung')
const EX = { ...BASE, exitAfterYears: 8 }
const outS = allocate(UNITS, EX), outC = allocate(UNITS, { ...EX, buyerStructure: 'couple' })
const eS = computeExit(outS, EX, 2027), eC = computeExit(outC, { ...EX, buyerStructure: 'couple' }, 2027)
T('Exit gleicher Gewinn', eS.gain === eC.gain, eur(eS.gain))
T('Gewinn > 60.000 (Test aussagekraeftig)', eS.gain > 60000)
T('single CGT = 20 % × (Gewinn − 30.000)', near(eS.cgt, Math.round((eS.gain - 30000) * 0.2)), eur(eS.cgt))
T('couple CGT = 20 % × (Gewinn − 60.000)', near(eC.cgt, Math.round((eC.gain - 60000) * 0.2)), eur(eC.cgt))
T('Differenz exakt 6.000 (3 Wohnungen, NICHT 18.000)', near(eS.cgt - eC.cgt, 6000), eur(eS.cgt - eC.cgt))
T('couple net > single net', eC.net > eS.net)
// Einzelverkaeufe nacheinander: Freibetrag wird verbraucht
let left = 30000
const s1 = computeSale(outS[0], 2034, EX, left); left -= s1.usedExemption
const s2 = computeSale(outS[1], 2034, EX, left); left -= s2.usedExemption
const s3 = computeSale(outS[2], 2034, EX, left)
T('single: Freibetrag ueber 3 Verkaeufe insgesamt ≤ 30.000', s1.usedExemption + s2.usedExemption + s3.usedExemption <= 30000,
  `${eur(s1.usedExemption)} + ${eur(s2.usedExemption)} + ${eur(s3.usedExemption)}`)
T('single: 1. Verkauf nutzt 30.000 voll (Gewinn gross genug)', s1.usedExemption === 30000)
T('single: 2. und 3. Verkauf ohne Freibetrag', s2.usedExemption === 0 && s3.usedExemption === 0)
let leftC = 60000
const c1 = computeSale(outC[0], 2034, { ...EX, buyerStructure: 'couple' }, leftC); leftC -= c1.usedExemption
const c2 = computeSale(outC[1], 2034, { ...EX, buyerStructure: 'couple' }, leftC); leftC -= c2.usedExemption
const c3 = computeSale(outC[2], 2034, { ...EX, buyerStructure: 'couple' }, leftC)
T('couple: Freibetrag ueber 3 Verkaeufe insgesamt = 60.000', c1.usedExemption + c2.usedExemption + c3.usedExemption === 60000,
  `${eur(c1.usedExemption)} + ${eur(c2.usedExemption)} + ${eur(c3.usedExemption)}`)
// Reinvest-Motor: Verkaeufe ueber mehrere Jahre, Topf lebenslang
const RE = { ...BASE, ek: 400000, reinvestEnabled: true, horizonYears: 12, autoReinvest: false, maxAdditionalPurchases: 0 }
const REU = [u('A', { fin: true, saleYear: 2033 }), u('B', { fin: true, saleYear: 2035 }), u('C', { fin: true, saleYear: 2037 })]
const rrS = runReinvest(REU, RE), rrC = runReinvest(REU, { ...RE, buyerStructure: 'couple' })
const usedS = rrS.sales.reduce((a, s) => a + s.usedExemption, 0), usedC = rrC.sales.reduce((a, s) => a + s.usedExemption, 0)
T('Motor single: 3 Verkaeufe in 3 Jahren nutzen zusammen 30.000', usedS === 30000, eur(usedS))
T('Motor couple: zusammen 60.000', usedC === 60000, eur(usedC))
T('Motor: CGT-Differenz 6.000', near(rrS.sales.reduce((a, s) => a + s.cgt, 0) - rrC.sales.reduce((a, s) => a + s.cgt, 0), 6000))

// ── 4. Szenarien behalten die Struktur ──────────────────────────────────────
console.log('\n[4] Szenarien')
for (const k of ['basis', 'konservativ', 'optimistisch']) {
  T(`scenarioParams ${k} behaelt couple`, scenarioParams({ ...BASE, buyerStructure: 'couple' }, k).buyerStructure === 'couple')
}
const scS = runScenarios(UNITS, EX), scC = runScenarios(UNITS, { ...EX, buyerStructure: 'couple' })
// Erwartete Differenz haengt vom Gewinn ab: 20 % × (min(60k, Gewinn) − min(30k, Gewinn)).
const expDiff = g => Math.round((Math.min(60000, g) - Math.min(30000, g)) * 0.2)
for (const k of ['basis', 'konservativ', 'optimistisch']) {
  T(`Szenario ${k}: couple CGT = single CGT − ${eur(expDiff(scS[k].exit.gain))}`, near(scS[k].exit.cgt - scC[k].exit.cgt, expDiff(scS[k].exit.gain)),
    `Gewinn ${eur(scS[k].exit.gain)}, Diff ${eur(scS[k].exit.cgt - scC[k].exit.cgt)}`)
}

// ── 5. Kaufpreissteigerung spaeterer Kaeufe ─────────────────────────────────
console.log('\n[5] Kaufpreissteigerung im Reinvestment-Motor')
const RI = {
  ...DEFAULT_SIM_PARAMS, ek: 350000, res: 'cy', holder: 'privat', gesy: true, socialIns: false,
  interest: 4.1, termYears: 30, rentGrowth: 2, opexMonthly: 150, maintPct: 0.75,
  reinvestEnabled: true, horizonYears: 20, reinvestAppreciationPct: 5, refinanceLtv: 70,
  minimumCashReserve: 25000, maxAdditionalPurchases: 12, autoReinvest: true, exitAfterYears: 0,
}
const RIU = [u('A', { fin: true }), u('B', { fin: true, priceNet: 285000, rent: 2350 })]
T('Default: Kaufpreissteigerung = Wertsteigerung', purchaseGrowthOf(RI) === 5 && RI.purchasePriceGrowth === null)
T('eigener Wert gewinnt', purchaseGrowthOf({ ...RI, purchasePriceGrowth: 3 }) === 3)
T('ohne Reinvest: folgt growth', purchaseGrowthOf({ ...RI, reinvestEnabled: false, growth: 4 }) === 4)
const model = buildModelUnit(RIU, RI)
T('Modellpreis Jahr 0 = Basis', modelPriceAt(model, RI, 2027, 2027) === model.priceNet, eur(model.priceNet))
T('Modellpreis Jahr 5 = Basis × 1,05^5', modelPriceAt(model, RI, 2032, 2027) === Math.round(model.priceNet * 1.05 ** 5 / 1000) * 1000, eur(modelPriceAt(model, RI, 2032, 2027)))
T('Modellpreis mit 0 % konstant', modelPriceAt(model, { ...RI, purchasePriceGrowth: 0 }, 2040, 2027) === model.priceNet)
const withG = runReinvest(RIU, RI), noG = runReinvest(RIU, { ...RI, purchasePriceGrowth: 0 })
const opp = y => withG.opportunities.find(o => o.year === y)
T('Opportunity-Preis steigt mit dem Jahr', opp(2032).modelPurchasePrice > opp(2027).modelPurchasePrice, `${eur(opp(2027).modelPurchasePrice)} → ${eur(opp(2032).modelPurchasePrice)}`)
T('Opportunity-Preis ohne Steigerung konstant', noG.opportunities.every(o => o.modelPurchasePrice === model.priceNet))
T('mit Steigerung nicht mehr Kaeufe als ohne', withG.kpis.additionalPurchases <= noG.kpis.additionalPurchases, `${withG.kpis.additionalPurchases} vs ${noG.kpis.additionalPurchases}`)
const buys = withG.events.filter(e => e.kind === 'purchase')
T('Kaufereignisse vorhanden', buys.length > 0, String(buys.length))
const later = buys.find(e => e.year > 2027)
if (later) {
  const n = later.year - 2027
  const expectPrice = Math.round(model.priceNet * 1.05 ** n / 1000) * 1000
  T(`Kauf ${later.year}: Preis = Basis × 1,05^${n}`, later.price === expectPrice, `${eur(later.price)} vs ${eur(expectPrice)}`)
  const bought = withG.units?.find?.(x => x.key === later.key) ?? null
  if (bought) {
    const expectRent = Math.round(model.rent * 1.02 ** n)
    T(`Kauf ${later.year}: Miete nur mit Mietsteigerung (× 1,02^${n}), NICHT mit Kaufpreis`, bought.rent === expectRent, `${eur(bought.rent)} vs ${eur(expectRent)}`)
    T('Anfangsrendite spaeterer Kauf < heute', (bought.rent * 12) / bought.priceNet < (model.rent * 12) / model.priceNet)
  } else T('Modellwohnung im Ergebnis auffindbar', false, 'units fehlt im ReinvestResult')
}
T('Szenario optimistisch: null bleibt null (folgt automatisch)', scenarioParams(RI, 'optimistisch').purchasePriceGrowth === null && purchaseGrowthOf(scenarioParams(RI, 'optimistisch')) === 7)
T('Szenario optimistisch: eigener Wert 3 → 5', scenarioParams({ ...RI, purchasePriceGrowth: 3 }, 'optimistisch').purchasePriceGrowth === 5)

console.log(`\n${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
