// Weitere Einlagen (Sven 23.10.2026): „Man hat z.B. jetzt 500k und will in 5
// Jahren nochmal 200k einlegen." Geprueft werden:
//   1. Ohne Einlagen (Feld fehlt, leer, nach dem Zeitraum) rechnet alles exakt wie bisher
//   2. Einlage fuer einen spaeteren Kauf: das Darlehen dieser Wohnung sinkt um die Einlage
//   3. Einlage vor dem Bankdarlehen: bis zum Eingang ueberbrueckt der Kredit
//   4. Einlage nach dem Darlehensstart: Sondertilgung, Restschuld und Zins sinken
//   5. Mehr Einlage als Schuld: Rest bleibt beim Kunden, nicht im Vermoegen
//   6. Bautraeger-Raten nach Uebergabe (Liquiditaetsrechnung): Einlage zahlt spaetere Raten
//   7. Reinvestment: Einlage fliesst in die Kasse, zaehlt als Investorgeld
//   8. Rendite: Einlage ist Geld des Kunden zum Zeitpunkt ihres Eingangs
//   9. Kundenauswertung nennt die Einlagen und zieht sie vom Zuwachs ab
//
// Ausfuehren:
//   npx esbuild src/lib/strategy.ts  --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/reinvest.ts  --bundle --format=esm --outfile=/tmp/reinvest.mjs
//   npx esbuild src/lib/analytics.ts --bundle --format=esm --outfile=/tmp/analytics.mjs
//   node scripts/verify-einlagen.mjs
import {
  DEFAULT_SIM_PARAMS, allocate, aggregate, computeExit, totalsOf, runScenarios, financingPath,
  einlagenUse, equityOutflowByYear, ymOf, loanReadyYm, MITO_SCHEDULE,
} from '/tmp/strategy.mjs'
import { runReinvest } from '/tmp/reinvest.mjs'
import { buildCustomerAnalytics } from '/tmp/analytics.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
let pass = 0, fail = 0
function T(name, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol

const Y = 2027
const unit = (key, o = {}) => ({
  key, name: key, priceNet: 300000, furnNet: 0, rent: 1600, letType: 'short', fin: true,
  buyM: 1, buyY: Y, readyM: 6, readyY: Y + 1, plan: 'luma', ...o,
})
const P = (o = {}) => ({ ...DEFAULT_SIM_PARAMS, ek: 250000, exitAfterYears: 0, ...o })
const run = (units, p) => {
  const outs = allocate(units, p)
  const agg = aggregate(outs, p)
  const exit = computeExit(outs, p, agg.firstYear, agg.rows, agg.liquidity)
  const totals = totalsOf(outs, agg.rows, p, exit, agg.liquidity)
  return { outs, agg, exit, totals }
}
const key = r => JSON.stringify({ o: r.outs.map(o => [o.loan, o.ekUsed, o.ekAlloc]), rows: r.agg.rows, t: r.totals, e: r.exit })

// ── 1. Ohne Einlagen unveraendert ────────────────────────────────────────────
{
  let same = 0, n = 0
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let k = 0; k < 40; k++) {
    const cnt = 1 + Math.floor(rnd() * 3)
    const units = Array.from({ length: cnt }, (_, i) => unit(`u${i}`, {
      priceNet: 150000 + Math.round(rnd() * 400000), fin: rnd() > 0.2,
      buyY: Y + Math.floor(rnd() * 3), readyY: Y + 1 + Math.floor(rnd() * 3),
      plan: rnd() > 0.7 ? 'sofort' : rnd() > 0.5 ? 'dev' : 'luma',
      schedule: { ...MITO_SCHEDULE },
    }))
    const base = { ek: 100000 + Math.round(rnd() * 600000), exitAfterYears: rnd() > 0.5 ? 7 : 0, reinvestEnabled: rnd() > 0.8 }
    const { einlagen: _drop, ...noField } = P(base)
    const a = run(units, noField)
    const b = run(units, P({ ...base, einlagen: [] }))
    const c = run(units, P({ ...base, einlagen: [{ m: 6, y: Y + 40, amount: 500000 }] }))
    n++
    if (key(a) === key(b) && key(a) === key(c)) same++
  }
  T('ohne Einlagen bzw. Einlage nach dem Zeitraum: identisch', same === n, `${same}/${n}`)
}

// ── 2. Einlage fuer einen spaeteren Kauf ─────────────────────────────────────
{
  const units = [unit('A'), unit('B', { buyY: Y + 4, buyM: 6, readyY: Y + 5, readyM: 12 })]
  const p0 = P({ ek: 300000 })
  const p1 = P({ ek: 300000, einlagen: [{ m: 6, y: Y + 4, amount: 100000 }] })
  const r0 = run(units, p0), r1 = run(units, p1)
  const B0 = r0.outs.find(o => o.unit.key === 'B'), B1 = r1.outs.find(o => o.unit.key === 'B')
  const A0 = r0.outs.find(o => o.unit.key === 'A'), A1 = r1.outs.find(o => o.unit.key === 'A')
  T('spaeterer Kauf: Darlehen B sinkt um die Einlage', near(B0.loan - B1.loan, 100000), `${eur(B0.loan)} → ${eur(B1.loan)}`)
  T('spaeterer Kauf: Wohnung A unveraendert (Darlehen lief schon)', A0.loan === A1.loan)
  const use = einlagenUse(r1.outs, p1, r1.agg.lastYear)
  T('spaeterer Kauf: ganze Einlage in Kaufraten', near(use.placed, 100000) && use.prepaid === 0 && use.unused === 0, JSON.stringify(use))
  T('spaeterer Kauf: Eigenkapital gesamt + Einlage', near(r1.totals.ekTotal - r0.totals.ekTotal, 100000, 2),
    `${eur(r0.totals.ekTotal)} → ${eur(r1.totals.ekTotal)}`)
  const fp = financingPath(r1.outs)
  const row = fp.steps.find(s => s.einlage)
  T('Finanzierungsbedarf: Zeile fuer die Einlage', !!row && row.ym === ymOf(Y + 4, 6) && row.einlage === 100000)
  T('Finanzierungsbedarf: Kredit gesamt = Darlehen', near(fp.creditTotal, r1.outs.reduce((a, o) => a + o.loan, 0), 2),
    `${eur(fp.creditTotal)} vs ${eur(r1.outs.reduce((a, o) => a + o.loan, 0))}`)
}

// ── 3. Einlage vor dem Bankdarlehen: Ueberbrueckung bis zum Eingang ─────────
{
  // Barkauf ohne Bank, Kaufpreis komplett bei Kauf: das Startkapital reicht
  // nicht, die Einlage kommt ein Jahr spaeter.
  const units = [unit('C', { fin: false, plan: 'sofort', readyY: Y + 2 })]
  const gross = allocate(units, P())[0].gross
  const p1 = P({ ek: gross - 100000, einlagen: [{ m: 1, y: Y + 1, amount: 100000 }] })
  const r1 = run(units, p1)
  const r0 = run(units, P({ ek: gross - 100000 }))
  const b = y => r1.agg.rows.find(r => r.year === y)
  T('Barkauf: Kredit bis zur Einlage', (b(Y)?.bridgeDebt ?? 0) > 99000 && (b(Y + 1)?.bridgeDebt ?? 1) === 0,
    `${eur(b(Y)?.bridgeDebt ?? 0)} / ${eur(b(Y + 1)?.bridgeDebt ?? 0)}`)
  T('Barkauf: ohne Einlage bleibt der Kredit offen', (r0.agg.rows.at(-1)?.bridgeDebt ?? 0) > 99000)
  T('Barkauf: Zins nur im ersten Jahr', (b(Y)?.bridgeInterest ?? 0) > 0 && (b(Y + 2)?.bridgeInterest ?? 1) === 0)
  const out = equityOutflowByYear(r1.outs, p1)
  T('Rendite: Einlage fliesst im Jahr ihres Eingangs ab', near(out.get(Y + 1) ?? 0, 100000, 1), eur(out.get(Y + 1) ?? 0))
}

// ── 4. Sondertilgung ─────────────────────────────────────────────────────────
{
  const units = [unit('A'), unit('B', { priceNet: 400000 })]
  const p0 = P({ ek: 250000 })
  const p1 = P({ ek: 250000, einlagen: [{ m: 3, y: Y + 4, amount: 120000 }] })
  const r0 = run(units, p0), r1 = run(units, p1)
  const use = einlagenUse(r1.outs, p1, r1.agg.lastYear)
  T('Sondertilgung: ganze Einlage tilgt', near(use.prepaid, 120000, 1) && use.placed === 0, JSON.stringify(use))
  const B1 = r1.outs.find(o => o.unit.key === 'B')
  T('Sondertilgung: hoechstes Darlehen zuerst (B)', (B1.prepaid ?? 0) > 0)
  const ti = B1.res.prepayC.findIndex(v => v > 0)
  T('Sondertilgung: Jahr der Einlage (volles Darlehensjahr)', B1.unit.readyY + ti === Y + 4, String(B1.unit.readyY + ti))
  const d0 = r0.agg.rows.at(-1).debt, d1 = r1.agg.rows.at(-1).debt
  T('Sondertilgung: Restschuld am Ende sinkt um mehr als die Einlage', d0 - d1 > 120000, `${eur(d0)} → ${eur(d1)}`)
  const i0 = r0.agg.rows.filter(r => r.year > Y + 4).reduce((a, r) => a + r.interest, 0)
  const i1 = r1.agg.rows.filter(r => r.year > Y + 4).reduce((a, r) => a + r.interest, 0)
  T('Sondertilgung: weniger Zins danach', i1 < i0, `${eur(i0)} → ${eur(i1)}`)
  const same = r0.agg.rows.filter(r => r.year <= Y + 4).every((r, i) => r.interest === r1.agg.rows[i].interest)
  T('Sondertilgung: bis zum Tilgungsjahr unveraendert', same)
  T('Sondertilgung: zaehlt als Eigenkapital', near(r1.totals.ekTotal - r0.totals.ekTotal, 120000, 1))
  const out0 = equityOutflowByYear(r0.outs, p0), out1 = equityOutflowByYear(r1.outs, p1)
  T('Rendite: Sondertilgung fliesst im Tilgungsjahr ab', near((out1.get(Y + 4) ?? 0) - (out0.get(Y + 4) ?? 0), 120000, 1))
  T('Sondertilgung: Netto-Vermoegen steigt mindestens um die Einlage', r1.totals.netWorth - r0.totals.netWorth >= 120000)
}

// ── 5. Mehr Einlage als Schuld ───────────────────────────────────────────────
{
  const units = [unit('A')]
  const p1 = P({ ek: 250000, einlagen: [{ m: 1, y: Y + 3, amount: 2000000 }] })
  const r1 = run(units, p1)
  const use = einlagenUse(r1.outs, p1, r1.agg.lastYear)
  T('Ueberschuss: Darlehen voll getilgt', r1.agg.rows.find(r => r.year === Y + 3).debt === 0)
  T('Ueberschuss: Rest bleibt beim Kunden', near(use.unused, 2000000 - use.prepaid, 1) && use.unused > 1500000, eur(use.unused))
  T('Ueberschuss: Summe stimmt', near(use.placed + use.prepaid + use.unused, use.total, 1))
  T('Ueberschuss: nicht im Netto-Vermoegen', r1.totals.netWorth < 1500000, eur(r1.totals.netWorth))
}

// ── 6. Raten nach Uebergabe (Liquiditaetsrechnung) ───────────────────────────
{
  const units = [unit('M', { plan: 'dev', schedule: { ...MITO_SCHEDULE }, priceNet: 600000, readyY: Y + 1, readyM: 6 })]
  const p0 = P({ ek: 150000 })
  const p1 = P({ ek: 150000, einlagen: [{ m: 1, y: Y + 2, amount: 100000 }] })
  const r0 = run(units, p0), r1 = run(units, p1)
  T('Mito: Liquiditaetsrechnung aktiv', !!r1.agg.liquidity)
  // Etwas mehr als die Einlage: weniger Kreditzins laesst mehr Miete fuer die Raten uebrig
  const drop = r0.outs[0].loan - r1.outs[0].loan
  T('Mito: Darlehen sinkt um die Einlage (plus gesparten Zins)', drop >= 99999 && drop < 110000,
    `${eur(r0.outs[0].loan)} → ${eur(r1.outs[0].loan)}`)
  const recs = r1.agg.liquidity.records.filter(r => r.ym >= ymOf(Y + 2, 1))
  T('Mito: Einlage zahlt Raten nach ihrem Eingang', recs.reduce((a, r) => a + r.fromEquity, 0) >= 99999)
  const before = r1.agg.liquidity.records.filter(r => r.ym < ymOf(Y + 2, 1)).reduce((a, r) => a + r.fromEquity, 0)
  const before0 = r0.agg.liquidity.records.filter(r => r.ym < ymOf(Y + 2, 1)).reduce((a, r) => a + r.fromEquity, 0)
  T('Mito: vor dem Eingang gleich viel Eigenkapital', near(before, before0, 1))
}

// ── 7. Reinvestment ──────────────────────────────────────────────────────────
{
  const units = [unit('A'), unit('B')]
  const base = { ek: 250000, reinvestEnabled: true, horizonYears: 15 }
  const r0 = runReinvest(units, P(base))
  const r1 = runReinvest(units, P({ ...base, einlagen: [{ m: 7, y: Y + 5, amount: 200000 }] }))
  const f0 = r0.flows.find(f => f.year === Y + 5), f1 = r1.flows.find(f => f.year === Y + 5)
  T('Reinvest: Einlage als Investorgeld im Jahr des Eingangs', f1.investorEquity - f0.investorEquity === 200000)
  T('Reinvest: Investorkapital gesamt + Einlage', r1.kpis.totalInvestorCapital - r0.kpis.totalInvestorCapital === 200000)
  T('Reinvest: Startverteilung unveraendert', JSON.stringify(r0.outcomes.slice(0, 2).map(o => o.loan)) === JSON.stringify(r1.outcomes.slice(0, 2).map(o => o.loan)))
  T('Reinvest: mehr oder gleich viele Wohnungen', r1.kpis.activeUnitsEnd >= r0.kpis.activeUnitsEnd, `${r0.kpis.activeUnitsEnd} → ${r1.kpis.activeUnitsEnd}`)
  T('Reinvest: Einlage zaehlt nicht als Recycling', r1.kpis.totalRecycledCapital < r0.kpis.totalRecycledCapital + 200000,
    `${eur(r0.kpis.totalRecycledCapital)} → ${eur(r1.kpis.totalRecycledCapital)}`)
}

// ── 8. Szenarien rechnen mit ─────────────────────────────────────────────────
{
  const units = [unit('A'), unit('B', { priceNet: 400000 })]
  const sc = runScenarios(units, P({ einlagen: [{ m: 3, y: Y + 4, amount: 120000 }] }))
  T('Szenarien: alle drei mit Sondertilgung', ['basis', 'konservativ', 'optimistisch'].every(k => sc[k].outcomes.some(o => (o.prepaid ?? 0) > 0)))
}

// ── 9. Kundenauswertung ──────────────────────────────────────────────────────
{
  const units = [unit('A'), unit('B', { priceNet: 400000 })]
  const p1 = P({ einlagen: [{ m: 3, y: Y + 4, amount: 120000 }] })
  const a1 = buildCustomerAnalytics(units, p1)
  const a0 = buildCustomerAnalytics(units, P())
  T('Auswertung: Einlagen in der Zusammenfassung', a1.summary.einlagen.total === 120000 && /weiteren Einlagen von 120\.000/.test(a1.summary.text), a1.summary.text)
  T('Auswertung: Zuwachs ohne Einlage gerechnet', a1.cost.wealthGain < a1.summary.netWorth - 250000)
  T('Auswertung: Zeile „Weitere Einlagen" im Geldfluss', a1.moneyFlow.some(m => m.label === 'Weitere Einlagen' && m.amount === 120000))
  T('Auswertung: ohne Einlagen keine Zeile', !a0.moneyFlow.some(m => m.label === 'Weitere Einlagen') && a0.summary.einlagen.total === 0)
  T('Auswertung: Station mit Datum', a1.journey.some(j => j.label === 'Weitere Einlagen' && /03\/2031/.test(j.note)), a1.journey.find(j => j.label === 'Weitere Einlagen')?.note)
}

console.log(`\n${fail ? '❌' : '🎉'}  ${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
