// Prüft src/components/shell/iconPaths.ts:
//   1. jeder Pfad entspricht der SVG-Pfad-Grammatik (Befehle M L H V C S Q T A Z,
//      groß oder klein, mit der richtigen Anzahl numerischer Argumente)
//   2. alle Punkte liegen in der 24x24-ViewBox, Bogenradien sind positiv,
//      Bogen-Flags sind 0 oder 1
//   3. keine doppelten Icon-Ids, kein Icon ohne Pfad
//   4. alle Ids, die die Shell braucht, sind vorhanden
// Aufruf: node scripts/verify-icons.mjs   (Exit 1 bei Fehlern)

import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'src/components/shell/iconPaths.ts')

// Ids aus dem Shell-Vertrag (SHELL-SPEC Abschnitt 4)
const REQUIRED = [
  'home', 'overview', 'pipeline', 'customers', 'tasks', 'calendar', 'archive', 'inbox', 'outbox',
  'newsletter', 'lists', 'workflow', 'projects', 'developers', 'contacts', 'portal', 'properties',
  'occupancy', 'bookings', 'documents', 'ownerContent', 'companies', 'ads', 'funnel', 'funnelEditor',
  'social', 'thumbnail', 'youtube', 'reviews', 'affiliates', 'statistics', 'webAnalytics', 'seo',
  'invoices', 'finance', 'settings', 'messages', 'ai', 'link', 'connectors', 'users', 'downloads',
  'drive', 'key', 'rules', 'confirmation', 'chat', 'user', 'search', 'more', 'menu', 'close',
  'chevronDown', 'chevronRight', 'chevronLeft', 'sidebarCollapse', 'sidebarExpand', 'logout', 'globe',
  'externalLink', 'unit', 'clock', 'check', 'enter',
]

const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/
const BOX_MIN = 0, BOX_MAX = 24

// Zerlegt einen Pfad in Befehle mit Zahlen. Wirft bei jedem Grammatikfehler.
function parsePath(d) {
  if (typeof d !== 'string' || !d.trim()) throw new Error('leerer Pfad')
  const commands = []
  let i = 0
  const skip = () => { while (i < d.length && /[\s,]/.test(d[i])) i++ }
  const readNumber = () => {
    skip()
    const m = NUMBER.exec(d.slice(i))
    if (!m) throw new Error(`Zahl erwartet an Position ${i}: "${d.slice(i, i + 12)}"`)
    i += m[0].length
    return Number(m[0])
  }
  // Bogen-Flags sind genau ein Zeichen (0 oder 1) und dürfen ohne Trenner stehen
  const readFlag = () => {
    skip()
    const ch = d[i]
    if (ch !== '0' && ch !== '1') throw new Error(`Bogen-Flag 0 oder 1 erwartet an Position ${i}: "${d.slice(i, i + 8)}"`)
    i++
    return Number(ch)
  }
  skip()
  while (i < d.length) {
    const letter = d[i]
    const upper = letter.toUpperCase()
    if (!(upper in ARGS)) throw new Error(`unbekannter Befehl "${letter}" an Position ${i}`)
    i++
    const count = ARGS[upper]
    if (count === 0) {
      commands.push({ letter, args: [] })
    } else {
      // Ein Befehl darf mehrere Argumentgruppen tragen (z.B. "L1 2 3 4")
      let groups = 0
      for (;;) {
        const args = []
        for (let k = 0; k < count; k++) args.push(upper === 'A' && (k === 3 || k === 4) ? readFlag() : readNumber())
        commands.push({ letter, args })
        groups++
        skip()
        if (i >= d.length || /[a-zA-Z]/.test(d[i])) break
      }
      if (groups === 0) throw new Error(`Befehl "${letter}" ohne Argumente`)
    }
    skip()
  }
  if (!commands.length) throw new Error('kein Befehl')
  if (commands[0].letter.toUpperCase() !== 'M') throw new Error('Pfad muss mit M beginnen')
  return commands
}

// Läuft den Pfad ab und prüft, dass alle End- und Kontrollpunkte in der ViewBox liegen.
function checkBounds(commands) {
  let x = 0, y = 0, startX = 0, startY = 0
  const problems = []
  const inBox = (px, py, what) => {
    if (!(px >= BOX_MIN && px <= BOX_MAX && py >= BOX_MIN && py <= BOX_MAX)) {
      problems.push(`${what} (${+px.toFixed(2)}, ${+py.toFixed(2)}) liegt außerhalb 0..24`)
    }
  }
  for (const { letter, args } of commands) {
    const rel = letter !== letter.toUpperCase()
    const bx = rel ? x : 0, by = rel ? y : 0
    switch (letter.toUpperCase()) {
      case 'M': x = bx + args[0]; y = by + args[1]; startX = x; startY = y; break
      case 'L': case 'T': x = bx + args[0]; y = by + args[1]; break
      case 'H': x = bx + args[0]; break
      case 'V': y = by + args[0]; break
      case 'C':
        inBox(bx + args[0], by + args[1], 'Kontrollpunkt'); inBox(bx + args[2], by + args[3], 'Kontrollpunkt')
        x = bx + args[4]; y = by + args[5]; break
      case 'S': case 'Q':
        inBox(bx + args[0], by + args[1], 'Kontrollpunkt')
        x = bx + args[2]; y = by + args[3]; break
      case 'A':
        if (!(args[0] > 0 && args[1] > 0)) problems.push(`Bogenradius muss positiv sein (${args[0]}, ${args[1]})`)
        x = bx + args[5]; y = by + args[6]; break
      case 'Z': x = startX; y = startY; break
    }
    inBox(x, y, 'Punkt')
  }
  return problems
}

const errors = []
const source = readFileSync(SOURCE, 'utf8')

// Doppelte Ids am Quelltext prüfen: im geladenen Objekt würde die zweite
// Definition die erste lautlos überschreiben.
const block = source.slice(source.indexOf('export const ICON_PATHS'))
const keyCount = new Map()
for (const m of block.matchAll(/^ {2}['"]?([A-Za-z][A-Za-z0-9]*)['"]?\s*:\s*\[/gm)) {
  keyCount.set(m[1], (keyCount.get(m[1]) ?? 0) + 1)
}
for (const [id, count] of keyCount) if (count > 1) errors.push(`doppelte Icon-Id "${id}" (${count}x)`)

// Datei mit esbuild nach ESM übersetzen und laden
const outDir = mkdtempSync(join(tmpdir(), 'hp-verify-icons-'))
let ICON_PATHS
try {
  const outfile = join(outDir, 'iconPaths.mjs')
  await build({ entryPoints: [SOURCE], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  ;({ ICON_PATHS } = await import(pathToFileURL(outfile).href))
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

const ids = Object.keys(ICON_PATHS)
if (keyCount.size !== ids.length) {
  errors.push(`Quelltext nennt ${keyCount.size} Ids, geladen wurden ${ids.length} (Format der Datei geändert?)`)
}
for (const id of REQUIRED) if (!ids.includes(id)) errors.push(`benötigtes Icon fehlt: ${id}`)

let pathCount = 0
for (const id of ids) {
  const paths = ICON_PATHS[id]
  if (!Array.isArray(paths) || paths.length === 0) { errors.push(`${id}: kein Pfad`); continue }
  paths.forEach((d, index) => {
    pathCount++
    try {
      const commands = parsePath(d)
      for (const problem of checkBounds(commands)) errors.push(`${id}[${index}]: ${problem}`)
    } catch (e) {
      errors.push(`${id}[${index}]: ${e.message}`)
    }
  })
}

// Selbsttest der Grammatikprüfung: diese Pfade MÜSSEN durchfallen bzw. bestehen
const mustFail = ['', 'L1 2', 'M1', 'M1 2 X3', 'M1 2A3 3 0 2 0 5 5', 'M1 2L3', 'M1 2C1 2 3 4 5', 'M1 2 L']
const mustPass = ['M1 2L3 4', 'm1 2-3 .5', 'M3 12a9 9 0 1018 0', 'M1 2H3V4Z', 'M1,2 C1,2 3,4 5,6 S7 8 9 10 Q1 2 3 4 T5 6']
for (const d of mustFail) {
  let failed = false
  try { parsePath(d) } catch { failed = true }
  if (!failed) errors.push(`Selbsttest: ungültiger Pfad "${d}" wurde akzeptiert`)
}
for (const d of mustPass) {
  try { parsePath(d) } catch (e) { errors.push(`Selbsttest: gültiger Pfad "${d}" wurde abgelehnt (${e.message})`) }
}

if (errors.length) {
  console.error(`verify-icons: ${errors.length} Fehler`)
  for (const e of errors) console.error('  FEHLER ' + e)
  process.exit(1)
}
console.log(`verify-icons: OK (${ids.length} Icons, ${pathCount} Pfade, ${REQUIRED.length} Pflicht-Ids vorhanden)`)
