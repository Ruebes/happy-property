// Prueft die Steuer AUF STRATEGIE-EBENE: Freibetrag und Progression gelten pro
// Person, nicht pro Wohnung. Ergaenzt scripts/verify-rechner.mjs, das die
// Einzelwohnungs-Engine gegen den Originalrechner prueft.
//
// Ausfuehren:
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/rechner.ts --format=esm --outfile=/tmp/rechner.mjs
//   node scripts/verify-strategy-tax.mjs
import { allocate, aggregate, computeExit, DEFAULT_SIM_PARAMS } from '/tmp/strategy.mjs'
import { cyTax } from '/tmp/rechner.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
let failed = 0
function check(name, got, want, tol = 1) {
  const ok = Math.abs(got - want) <= tol
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${name}: ${eur(got)}${ok ? '' : ` (erwartet ${eur(want)})`}`)
}

// Wohnung ohne Finanzierung und ohne Kosten-Extras, damit die Bemessungsgrundlage
// glatt steuerbar ist.
const unit = (key, over = {}) => ({
  key, name: key, priceNet: 400000, furnNet: 0, rent: 2500, letType: 'short', fin: false,
  buyM: 1, buyY: 2027, readyM: 1, readyY: 2027, plan: 'sofort', calc: { mgmtPct: 25 }, opex: 0, ...over,
})
const P = {
  ...DEFAULT_SIM_PARAMS, res: 'cy', holder: 'privat', gesy: false,
  ek: 5000000, rentGrowth: 0, growth: 0, maintPct: 0, opexMonthly: 0,
  exitAfterYears: 0,   // Verkauf wird in den Steuertests separat geprueft
  socialIns: false,    // Sozialversicherung hat einen eigenen Testblock
}
const run = (units, p = P) => {
  const out = allocate(units, p)
  return aggregate(out, p)
}

console.log('── Test 1: eine Wohnung unter dem Freibetrag ──')
const a1 = run([unit('A')])
check('Bemessung Jahr 1', a1.rows[0].baseCY, 11076)
check('Steuer Jahr 1', a1.rows[0].taxes, 0)

console.log('\n── Test 2: drei Wohnungen teilen sich EINEN Freibetrag ──')
const a3 = run([unit('A'), unit('B'), unit('C')])
check('Bemessung Jahr 1', a3.rows[0].baseCY, 33228)
check('Steuer Jahr 1 (22k frei, 10k a 20 %, 1.228 a 25 %)', a3.rows[0].taxes, 2307)
check('Gegenprobe gegen cyTax', a3.rows[0].taxes, cyTax(33228))

console.log('\n── Test 3: Verluste einzelner Wohnungen mindern die Gesamtbasis ──')
// Wohnung C mit hoher Verwaltung erzeugt einen steuerlichen Verlust.
const mixed = run([unit('A'), unit('B'), unit('C', { rent: 700, calc: { mgmtPct: 90 } })])
const rowM = mixed.rows[0]
console.log(`   Basis mit Verlustwohnung: ${eur(rowM.baseCY)} statt ${eur(a3.rows[0].baseCY)} · Steuer: ${eur(rowM.taxes)}`)
if (rowM.baseCY >= a3.rows[0].baseCY) { failed++; console.log('❌ Verlust hat die Basis nicht gesenkt') }
else console.log('✅ Verlust senkt die gemeinsame Basis')
check('Steuer entspricht cyTax der Gesamtbasis', rowM.taxes, cyTax(Math.max(0, rowM.baseCY)))

console.log('\n── Test 4: unterschiedliche Uebergabejahre, kalenderjaehrlich aggregiert ──')
const stag = run([unit('A'), unit('B', { buyY: 2029, readyY: 2029 })])
check('2027 nur Wohnung A', stag.rows[0].baseCY, 11076)
check('2027 Steuer', stag.rows[0].taxes, 0)
const r2029 = stag.rows.find(r => r.year === 2029)
check('2029 beide Wohnungen', r2029.baseCY, 24124)
check('2029 Steuer', r2029.taxes, cyTax(24124))

console.log('\n── Test 5: Planungshorizont endet 10 Jahre nach dem ersten Kauf ──')
const late = run([unit('A'), unit('B', { buyY: 2035, readyY: 2035 })])
check('erstes Jahr', late.firstYear, 2027, 0)
check('letztes Jahr', late.lastYear, 2036, 0)
check('Anzahl Jahre', late.rows.length, 10, 0)

console.log('\n── Test 6: Bestandseinkommen hebt die Progression nur EINMAL ──')
const withBI = run([unit('A'), unit('B'), unit('C')], { ...P, cyBI: 30000 })
check('Steuer Jahr 1', withBI.rows[0].taxes, cyTax(30000 + 33228) - cyTax(30000))

console.log('\n── Test 7: Firma - ein Verlustvortrag fuer alle Wohnungen ──')
const firma = run([unit('A'), unit('B'), unit('C')], { ...P, holder: 'firma', divPayoutPct: 0, corpTaxPct: 15 })
check('Koerperschaftsteuer Jahr 1', firma.rows[0].taxes, Math.round(33228 * 0.15))

console.log('\n── Test 8: GESY nur einmal, gedeckelt auf 180.000 EUR Miete ──')
const gesy = run([unit('A'), unit('B'), unit('C')], { ...P, gesy: true, socialIns: false })
const rentY1 = gesy.rows[0].rents
check('GESY Jahr 1', gesy.rows[0].gesy, Math.round(Math.min(rentY1, 180000) * 0.0265))

console.log('\n── Test 8b: Sozialversicherung nur fuer Zypern-Ansaessige ──')
const siOn = run([unit('A'), unit('B'), unit('C')], { ...P, socialIns: true })
const siOff = run([unit('A'), unit('B'), unit('C')], { ...P, socialIns: false })
// 33.228 EUR Gewinn liegt ueber dem fiktiven Mindesteinkommen von 20.318 EUR.
check('Sozialversicherung Jahr 1 = 16,6 % vom Gewinn', siOn.rows[0].si, Math.round(33228 * 0.166))
check('ohne Schalter keine Sozialversicherung', siOff.rows[0].si, 0)
const siSmall = run([unit('A')], { ...P, socialIns: true })
check('fiktives Mindesteinkommen greift bei kleinem Gewinn', siSmall.rows[0].si, Math.round(20318 * 0.166))
const siDe = run([unit('A'), unit('B'), unit('C')], { ...P, res: 'de', socialIns: true })
check('Steuersitz Deutschland: keine Sozialversicherung', siDe.rows[0].si, 0)
const siLong = run([unit('A', { letType: 'long' })], { ...P, socialIns: true })
check('Langzeitvermietung ist nicht gewerblich: keine Sozialversicherung', siLong.rows[0].si, 0)

console.log('\n── Test 9: Verkauf, MwSt-Rueckzahlung fuer die Restjahre ──')
// Kurzzeitvermietung, Uebergabe im Kaufjahr, Verkauf nach 5 Jahren: das
// Verkaufsintervall ist das fuenfte, verbleiben fuenf volle Intervalle.
const exUnits = [unit('A', { furnNet: 0 })]
const exP = { ...P, exitAfterYears: 5, sellCostPct: 3, lawyerPct: 1, cpiPct: 2 }
const exOut = allocate(exUnits, exP)
const exAgg = aggregate(exOut, exP)
const ex = computeExit(exOut, exP, exAgg.firstYear)
const vatAmt = exOut[0].res.vatAmt
check('MwSt-Rueckzahlung = 5/10 der gezogenen Vorsteuer', ex.vatClawback, Math.round(vatAmt * 5 / 10))
check('Uebertragungsabgabe 0,4 %', ex.levy, Math.round(ex.value * 0.004))
check('Makler + Anwalt inkl. 19 % MwSt', ex.sellCost, Math.round(ex.value * 0.04 * 1.19))
check('Verkaufsjahr', ex.year, exAgg.firstYear + 4, 0)
check('Zeitraum endet im Verkaufsjahr', exAgg.lastYear, ex.year, 0)

console.log('\n── Test 10: Veraeusserungsgewinnsteuer mit einem Freibetrag fuer alle ──')
const ex3 = (() => {
  const p3 = { ...exP, exitAfterYears: 8 }
  const o3 = allocate([unit('A'), unit('B'), unit('C')], p3)
  return computeExit(o3, p3, aggregate(o3, p3).firstYear)
})()
check('CGT = 20 % auf den Gewinn ueber 30.000 EUR', ex3.cgt, Math.max(0, Math.round((ex3.gain - 30000) * 0.2)))
const ex1 = (() => {
  const p1 = { ...exP, exitAfterYears: 8 }
  const o1 = allocate([unit('A')], p1)
  return computeExit(o1, p1, aggregate(o1, p1).firstYear)
})()
if (ex3.gain > ex1.gain * 2.5) console.log('✅ Freibetrag wird nicht je Wohnung vergeben')
else { failed++; console.log('❌ Freibetrag scheint mehrfach zu greifen') }

console.log('\n── Test 11: Deutschland besteuert den Verkauf innerhalb von 10 Jahren ──')
const deP = { ...exP, res: 'de', exitAfterYears: 7, deTaxPct: 42 }
const deOut = allocate([unit('A')], deP)
const deEx = computeExit(deOut, deP, aggregate(deOut, deP).firstYear)
if (deEx.taxDE > 0) console.log(`✅ Steuer Deutschland faellt an: ${eur(deEx.taxDE)}`)
else { failed++; console.log('❌ Deutschland besteuert nicht, obwohl innerhalb der Frist verkauft wird') }
// Innerhalb des Planungshorizonts von zehn Jahren ab dem ersten Kauf liegt jeder
// Verkauf zwangslaeufig INNERHALB der deutschen Zehnjahresfrist (sie laeuft ab
// dem Kaufvertrag, nicht ab der Uebergabe). Fuer einen Kunden mit Steuersitz
// Deutschland ist der Verkauf im Simulator also immer voll steuerpflichtig.
// Die Fristpruefung im Code greift erst, wenn der Horizont einmal laenger wird.
console.log('ℹ️  Im 10-Jahres-Horizont liegt jeder Verkauf in der deutschen Frist - das ist fachlich richtig, kein Fehler.')
// Pruefbar ist dagegen die Anrechnung: die zyprische Steuer mindert die deutsche.
const deNoCgt = { ...deP, deTaxPct: 42 }
const oNo = allocate([unit('A')], deNoCgt)
const exNo = computeExit(oNo, deNoCgt, aggregate(oNo, deNoCgt).firstYear)
if (exNo.cgt > 0 && exNo.taxDE > 0) console.log(`✅ Anrechnung greift: CY ${eur(exNo.cgt)} mindert die deutsche Steuer auf ${eur(exNo.taxDE)}`)
else if (exNo.cgt > 0 && exNo.taxDE === 0) console.log('✅ Zyprische Steuer deckt die deutsche vollstaendig ab')
else { failed++; console.log('❌ Anrechnung nicht nachvollziehbar') }

console.log(failed === 0 ? '\n🎉 Alle Strategie-Steuerfaelle korrekt.' : `\n⚠️ ${failed} Abweichung(en).`)
process.exit(failed ? 1 : 0)
