// Golden-Master-Test: supabase/functions/_shared/deckVat.ts muss BIT-GENAU
// dasselbe liefern wie src/lib/rechner.ts (vatSplit) — sonst weicht der Preis im
// Deck vom Preis im Rendite-Rechner ab, und genau das war der ARCA-Fehlerfall.
//
// Ausführen:
//   npm run verify:vat
//
// Der Test ist absichtlich erschöpfend statt stichprobenhaft: er läuft über alle
// drei MwSt-Regelungen, ein Preisraster um jede gesetzliche Grenze herum und ein
// Flächenraster um 130/190/200 m². Ein einziger Cent Abweichung bricht ihn.

import { execSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'hpvat-'))
const outA = join(dir, 'rechner.mjs')
const outB = join(dir, 'deckvat.mjs')
execSync(`npx --yes esbuild src/lib/rechner.ts --format=esm --outfile=${outA}`, { stdio: 'pipe' })
execSync(`npx --yes esbuild supabase/functions/_shared/deckVat.ts --format=esm --outfile=${outB}`, { stdio: 'pipe' })

const { vatSplit: refSplit } = await import(outA)
const { vatSplit: newSplit, computeUnitPrice, priceIsConsistent } = await import(outB)

const MODES = [undefined, 'standard19', 'reduced130', 'reduced200']

// Preise: rund um 350.000 (Wertdeckel) und 475.000 (Ausschlussgrenze), plus
// krumme Beträge, die Rundungsdifferenzen sichtbar machen.
const PRICES = []
for (const anchor of [0, 1, 99, 100000, 349999, 350000, 350001, 474999, 475000, 475001, 620000, 1250000]) {
  for (const d of [-3, -1, 0, 1, 3, 7]) if (anchor + d >= 0) PRICES.push(anchor + d)
}
PRICES.push(430000.5, 96333.33)

// Flächen: rund um 130 (Deckel), 190 (Ausschluss) und 200 (Übergangsregelung).
const SQMS = [null, undefined, 0, 1, 42, 95.5, 129, 130, 131, 189, 190, 191, 199, 200, 201, 340]

let checked = 0
const fails = []

for (const mode of MODES) {
  for (const net of PRICES) {
    for (const sqm of SQMS) {
      const a = refSplit(net, mode, sqm)
      const b = newSplit(net, mode, sqm)
      checked++
      for (const k of ['netReduced', 'netStandard', 'vatReduced', 'vatStandard', 'vat', 'gross', 'entfallen']) {
        if (a[k] !== b[k] && !(a[k] === undefined && b[k] === undefined)) {
          fails.push(`vatSplit(${net}, ${mode}, ${sqm}).${k}: Rechner=${a[k]} Deck=${b[k]}`)
        }
      }
      // Interne Konsistenz der Referenz selbst — brutto muss netto + MwSt sein.
      if (a.gross !== net + a.vat) fails.push(`vatSplit(${net}, ${mode}, ${sqm}): gross != net + vat (${a.gross} != ${net + a.vat})`)
    }
  }
}

// computeUnitPrice: die Deck-Ebene oben drauf (Immobilie + Möbel).
let priceChecked = 0
for (const mode of ['standard19', 'reduced130']) {
  for (const net of [96000, 349000, 430000, 499000]) {
    for (const furn of [0, 17000, 30000]) {
      for (const sqm of [null, 96, 131, 195]) {
        const r = computeUnitPrice({ netProperty: net, netFurniture: furn, livingSqm: sqm, mode })
        priceChecked++
        if (!priceIsConsistent(r)) fails.push(`computeUnitPrice(${net}, ${furn}, ${sqm}, ${mode}): inkonsistent ${JSON.stringify(r)}`)
        if (r.gross !== r.netTotal + r.vatTotal) fails.push(`computeUnitPrice(${net}, ${furn}, ${sqm}, ${mode}): brutto != netto + MwSt`)
        // Möbel tragen IMMER 19 % — auch bei Eigennutz.
        if (r.vatFurniture !== Math.round(furn * 0.19)) fails.push(`computeUnitPrice: Möbel-MwSt falsch bei furn=${furn}`)
      }
    }
  }
}

if (fails.length) {
  console.error(`❌ ${fails.length} Abweichung(en) bei ${checked} vatSplit- und ${priceChecked} Preis-Fällen:`)
  for (const f of fails.slice(0, 40)) console.error('   ' + f)
  if (fails.length > 40) console.error(`   … und ${fails.length - 40} weitere`)
  process.exit(1)
}
console.log(`✅ deckVat.ts stimmt bit-genau mit rechner.ts überein (${checked} vatSplit-Fälle, ${priceChecked} Preis-Fälle)`)
