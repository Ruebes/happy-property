// Prüft supabase/functions/_shared/saisonZiel.ts gegen die Engine (src/lib/rechner.ts):
// gleiche Saisonmiete wie seasonBreakdown, und der gefundene Hochsaisonpreis ergibt in
// compute() mindestens die Zielrendite, ein Euro weniger liegt darunter.
// Ausführen: node scripts/verify-saison-ziel.mjs
import { execSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'hpsaison-'))
execSync(`npx --yes esbuild src/lib/rechner.ts --format=esm --outfile=${join(dir, 'r.mjs')}`, { stdio: 'pipe' })
execSync(`npx --yes esbuild supabase/functions/_shared/saisonZiel.ts --format=esm --outfile=${join(dir, 's.mjs')}`, { stdio: 'pipe' })
const { seasonBreakdown, compute, DEFAULT_PARAMS } = await import(join(dir, 'r.mjs'))
const { saisonMiete, saisonPreisFuer } = await import(join(dir, 's.mjs'))

let fehler = 0
for (const occ of [40, 55, 56, 63.5, 70, 80, 90]) for (let adr = 30; adr <= 400; adr += 7) {
  const a = seasonBreakdown({ totalOcc: occ, adrHigh: adr }).rent, b = saisonMiete(occ, adr)
  if (a !== b) { fehler++; console.log('Miete', occ, adr, a, b) }
}
for (const net of [150000, 155000, 160000, 165000, 255000, 265000, 199999, 420000]) for (const ziel of [8, 10, 10.5, 12]) {
  const adr = saisonPreisFuer(ziel, 70, net * 1.19)
  const y = p => compute({ ...DEFAULT_PARAMS, priceNet: net, vatMode: 'standard19', letType: 'short', dealType: 'single', season: { totalOcc: 70, adrHigh: p } }).effYield
  if (!(Math.round(y(adr) * 100) / 100 >= ziel) || Math.round(y(adr - 1) * 100) / 100 >= ziel) { fehler++; console.log('Preis', net, ziel, adr, y(adr), y(adr - 1)) }
}
console.log(fehler ? `FEHLER: ${fehler}` : 'ok: Saisonmiete und Zielpreis stimmen mit der Engine überein')
process.exit(fehler ? 1 : 0)
