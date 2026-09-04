// Vertragstest für das Block-Vokabular eines Sales-Decks.
//
// Es gab vier Wahrheiten, die auseinanderliefen — und daraus einen Live-Bug:
// generate-deck erzeugte einen Block vom Typ 'map', den weder die Typdatei noch
// der Renderer kennt. Er fiel in `default: return null` und rendert seitdem in
// jedem Deck mit Koordinaten nichts.
//
// Dieser Test hält die vier Stellen deckungsgleich:
//   1. supabase/functions/_shared/deckBlocks.ts   (kanonisches Vokabular)
//   2. src/lib/deckTypes.ts                        (DeckBlock-Union)
//   3. src/pages/Deck.tsx                          (switch im Renderer)
//   4. das emit_deck-Enum, das generate-deck an die KI schickt
//
// Ausführen: npm run verify:deck

import { readFileSync } from 'fs'
import { execSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'hpblocks-'))
const out = join(dir, 'deckBlocks.mjs')
execSync(`npx --yes esbuild supabase/functions/_shared/deckBlocks.ts --format=esm --outfile=${out}`, { stdio: 'pipe' })
const { ALL_BLOCK_TYPES, AI_BLOCK_TYPES, SYSTEM_BLOCK_TYPES, emitDeckSchema } = await import(out)

const fails = []
const set = a => new Set(a)
const diff = (a, b) => [...a].filter(x => !b.has(x))

// ── 2. DeckBlock-Union aus src/lib/deckTypes.ts ──────────────────────────────
const typesSrc = readFileSync('src/lib/deckTypes.ts', 'utf8')
const unionStart = typesSrc.indexOf('export type DeckBlock')
if (unionStart < 0) fails.push('deckTypes.ts: export type DeckBlock nicht gefunden')
const unionBody = typesSrc.slice(unionStart, typesSrc.indexOf('export interface DeckContent', unionStart))
const unionTypes = set([...unionBody.matchAll(/\{\s*type:\s*'([a-z_]+)'/g)].map(m => m[1]))

// ── 3. switch im Renderer ────────────────────────────────────────────────────
const deckSrc = readFileSync('src/pages/Deck.tsx', 'utf8')
const switchStart = deckSrc.indexOf('function Block({ block }')
if (switchStart < 0) fails.push('Deck.tsx: function Block nicht gefunden')
const switchBody = deckSrc.slice(switchStart, switchStart + 1600)
const rendered = set([...switchBody.matchAll(/case\s+'([a-z_]+)':/g)].map(m => m[1]))

// ── 4. Enum, das wirklich an die KI geht ─────────────────────────────────────
const emitEnum = set(emitDeckSchema().properties.blocks.items.properties.type.enum)

const canonical = set(ALL_BLOCK_TYPES)
const ai = set(AI_BLOCK_TYPES)
const sys = set(SYSTEM_BLOCK_TYPES)

const check = (label, a, b, aName, bName) => {
  const onlyA = diff(a, b), onlyB = diff(b, a)
  if (onlyA.length) fails.push(`${label}: nur in ${aName}: ${onlyA.join(', ')}`)
  if (onlyB.length) fails.push(`${label}: nur in ${bName}: ${onlyB.join(', ')}`)
}

check('Vokabular vs. Typdatei', canonical, unionTypes, 'deckBlocks.ts', 'deckTypes.ts')
check('Vokabular vs. Renderer', canonical, rendered, 'deckBlocks.ts', 'Deck.tsx')
check('KI-Enum vs. AI_BLOCK_TYPES', emitEnum, ai, 'emit_deck-Schema', 'AI_BLOCK_TYPES')

// System-Typen dürfen NICHT im KI-Enum stehen (sie entstehen deterministisch).
for (const t of sys) if (emitEnum.has(t)) fails.push(`System-Typ '${t}' steht fälschlich im KI-Enum`)
// AI- und System-Typen müssen disjunkt sein.
for (const t of ai) if (sys.has(t)) fails.push(`'${t}' ist gleichzeitig AI- und System-Typ`)

// Der tote 'map'-Block darf nirgends mehr auftauchen.
for (const [name, s] of [['deckBlocks.ts', canonical], ['deckTypes.ts', unionTypes], ['Deck.tsx', rendered], ['emit_deck', emitEnum]]) {
  if (s.has('map')) fails.push(`'map' ist wieder aufgetaucht in ${name} — Kartenfelder gehören an den facts-Block`)
}
// generate-deck darf keinen map-Block mehr erzeugen.
// Kommentarzeilen ausnehmen — der Umbau erklärt den alten Bug im Fließtext.
const genCode = readFileSync('supabase/functions/generate-deck/index.ts', 'utf8')
  .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
if (/type:\s*'map'/.test(genCode)) fails.push("generate-deck erzeugt wieder einen Block mit type: 'map' (wird vom Renderer verworfen)")

if (fails.length) {
  console.error(`❌ Block-Vokabular inkonsistent (${fails.length}):`)
  for (const f of fails) console.error('   ' + f)
  process.exit(1)
}
console.log(`✅ Block-Vokabular deckungsgleich in Vokabular, Typdatei, Renderer und KI-Enum (${canonical.size} Typen: ${[...canonical].sort().join(', ')})`)
