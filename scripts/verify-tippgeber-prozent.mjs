// Tests der prozentualen Tippgeber-Provision (Sven, 5.11.2026).
//
// Offline, ohne Datenbank und ohne Versand: Rechnung, Eingabe und Basis aus
// supabase/functions/affiliate-api/commission.ts. Die Prozentrechnung wird gegen eine
// eigene Rechnung mit BigInt geprüft, die nichts vom Produktionscode benutzt.
//
// Ausführen:
//   node scripts/verify-tippgeber-prozent.mjs

import { execSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(mkdtempSync(join(tmpdir(), 'hptippgeber-')), 'commission.mjs')
execSync(`npx --yes esbuild ${JSON.stringify(join(root, 'supabase/functions/affiliate-api/commission.ts'))} --bundle --format=esm --platform=neutral --outfile=${JSON.stringify(out)} --log-level=error`)
const C = await import(out)

const fails = []
const same = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${name}: ${JSON.stringify(got)} statt ${JSON.stringify(want)}`)
}

// ── Rechnung: von Hand nachgerechnete Fälle ──────────────────────────────────
same('10 % von 28.313,40', C.percentOf(28313.4, 10), 2831.34)
same('10 % von 13.089', C.percentOf(13089, 10), 1308.9)
same('25 % von 39.900', C.percentOf(39900, 25), 9975)
same('7,5 % von 13.089 (981,675 rundet auf)', C.percentOf(13089, 7.5), 981.68)
same('12,5 % von 7.425 (928,125 rundet auf)', C.percentOf(7425, 12.5), 928.13)
same('3,33 % von 1.000 (33,30 ohne Rest)', C.percentOf(1000, 3.33), 33.3)
same('1,11 % von 1.234,56 (13,703616 rundet ab)', C.percentOf(1234.56, 1.11), 13.7)
same('100 % von 20.995', C.percentOf(20995, 100), 20995)
same('0,01 % von 100', C.percentOf(100, 0.01), 0.01)
same('33,33 % von 100,01', C.percentOf(100.01, 33.33), 33.33)

// ── Rechnung: gegen eigene BigInt-Rechnung (kaufmännisch gerundet) ───────────
const exact = (cents, hundredths) => {
  const n = BigInt(cents) * BigInt(hundredths)
  const q = n / 10000n
  return Number(n % 10000n >= 5000n ? q + 1n : q) / 100
}
let seed = 20261105
const next = (max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max }
for (let i = 0; i < 200000; i++) {
  const cents = 1 + next(10000000)      // bis 100.000,00 €
  const hundredths = 1 + next(10000)    // 0,01 % bis 100 %
  const got = C.percentOf(cents / 100, hundredths / 100)
  const want = exact(cents, hundredths)
  if (got !== want) { fails.push(`Zufall: ${hundredths / 100} % von ${cents / 100}: ${got} statt ${want}`); break }
}

// ── Eingabe ──────────────────────────────────────────────────────────────────
for (const [raw, want] of [
  ['10', 10], ['7,5', 7.5], ['7.5', 7.5], ['7,5 %', 7.5], [' 12,25% ', 12.25], [10, 10], ['100', 100], ['0,01', 0.01],
  ['0', null], ['-5', null], ['100,01', null], ['101', null], ['abc', null], ['', null], [null, null], [undefined, null], ['1,5,5', null], ['0,001', null],
]) same(`Eingabe ${JSON.stringify(raw)}`, C.parsePercent(raw), want)

// ── Basis ────────────────────────────────────────────────────────────────────
const deal = (id, phase, amount, from = null) => ({ id, phase, archived_from_phase: from, commission_amount: amount })
same('Rechnung schlägt Betrag am Deal', C.commissionBase([deal('a', 'provision_erhalten', 100)], [{ deal_id: 'a', subtotal_net: 200 }]), 200)
same('ohne Rechnung zählt der Deal', C.commissionBase([deal('a', 'provision_erhalten', 100)], []), 100)
same('Teilrechnungen werden addiert', C.commissionBase([deal('a', 'provision_erhalten', 100)], [{ deal_id: 'a', subtotal_net: 60.1 }, { deal_id: 'a', subtotal_net: 40.2 }]), 100.3)
same('archiviert aus Provision erhalten zählt', C.commissionBase([deal('a', 'archiviert', 500, 'provision_erhalten')], []), 500)
same('nur abgeschlossene Deals, wenn es welche gibt', C.commissionBase([deal('a', 'provision_erhalten', 500), deal('b', 'reservierung', 900)], []), 500)
same('zwei abgeschlossene Deals addiert', C.commissionBase([deal('a', 'provision_erhalten', 500), deal('b', 'archiviert', 300, 'provision_erhalten')], []), 800)
same('Vorschau aus laufendem Deal', C.commissionBase([deal('a', 'provisionsrechnung', 900)], []), 900)
same('anders archiviert zählt nicht', C.commissionBase([deal('a', 'archiviert', 500, 'reservierung')], []), null)
same('keine Beträge = keine Basis', C.commissionBase([deal('a', 'provision_erhalten', null)], []), null)
same('Betrag 0 = keine Basis', C.commissionBase([deal('a', 'provision_erhalten', 0)], []), null)
same('keine Deals = keine Basis', C.commissionBase([], []), null)

// ── Auszahlung ───────────────────────────────────────────────────────────────
same('Standard', C.resolveCommission(null, null, null, 1000), { amount: 1000, percent: null, base: null })
same('fester Betrag', C.resolveCommission(1500, null, 20000, 1000), { amount: 1500, percent: null, base: null })
same('Prozent', C.resolveCommission(null, 10, 28313.4, 1000), { amount: 2831.34, percent: 10, base: 28313.4 })
same('Prozent ohne Basis wartet (nie 1.000 € raten)', C.resolveCommission(null, 10, null, 1000), null)
same('Prozent mit Basis 0 wartet', C.resolveCommission(null, 10, 0, 1000), null)
same('Prozent, das auf 0 Cent rundet, wartet', C.resolveCommission(null, 0.01, 0.1, 1000), null)

if (fails.length) {
  console.error(`FEHLER (${fails.length}):\n- ${fails.join('\n- ')}`)
  process.exit(1)
}
console.log('Alle Prüfungen der prozentualen Tippgeber-Provision bestanden.')
