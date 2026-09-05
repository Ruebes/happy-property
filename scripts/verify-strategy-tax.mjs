// Prueft die Steuer AUF STRATEGIE-EBENE: Freibetrag und Progression gelten pro
// Person, nicht pro Wohnung. Ergaenzt scripts/verify-rechner.mjs, das die
// Einzelwohnungs-Engine gegen den Originalrechner prueft.
//
// Ausfuehren:
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/rechner.ts --format=esm --outfile=/tmp/rechner.mjs
//   node scripts/verify-strategy-tax.mjs
import { allocate, aggregate, DEFAULT_SIM_PARAMS } from '/tmp/strategy.mjs'
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
const gesy = run([unit('A'), unit('B'), unit('C')], { ...P, gesy: true })
const rentY1 = gesy.rows[0].rents
check('GESY Jahr 1', gesy.rows[0].gesy, Math.round(Math.min(rentY1, 180000) * 0.0265))

console.log(failed === 0 ? '\n🎉 Alle Strategie-Steuerfaelle korrekt.' : `\n⚠️ ${failed} Abweichung(en).`)
process.exit(failed ? 1 : 0)
