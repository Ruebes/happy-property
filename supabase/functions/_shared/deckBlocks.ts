// Das Block-Vokabular eines Sales-Decks — EINE Wahrheit für vier Stellen, die
// bisher auseinanderliefen:
//   (a) emit_deck-Enum in generate-deck        11 Typen, ohne inventory
//   (b) BLOCK_ITEM in refine-deck              Typ ohne Enum, dafür ein image-Feld
//   (c) DeckBlock-Union in src/lib/deckTypes   14 Typen
//   (d) switch in src/pages/Deck.tsx           14 cases, default: return null
//
// Folge war unter anderem ein LIVE-Bug: generate-deck fügte bei vorhandenen
// Kartendaten einen Block { type: 'map' } ein, den niemand rendert — er fiel in
// `default: return null`. Die „Karte fehlt"-Reparatur reparierte nichts, und weil
// das KI-Enum 'map' nicht kennt, passierte das in JEDEM Deck mit Koordinaten.
// Kartenfelder gehören an den facts-Block (so führt es deckTypes.ts auch).
//
// ACHTUNG (CLAUDE.md Regel 8): Änderung wirkt erst nach Redeploy jeder
// importierenden Function. Der Abgleich gegen Renderer und Typdatei läuft über
// scripts/verify-deck-blocks.mjs.

/** Typen, die die KI selbst schreiben darf (Enum des emit_deck-Tools). */
export const AI_BLOCK_TYPES = [
  'cover', 'letter', 'unit', 'facts', 'columns', 'feature',
  'gallery', 'benefits', 'inventory', 'floorplan', 'payment', 'cta',
] as const

/** Typen, die AUSSCHLIESSLICH das System deterministisch einsetzt. */
export const SYSTEM_BLOCK_TYPES = ['marina', 'video'] as const

/** Alles, was im Deck vorkommen darf. Muss deckungsgleich sein mit der
 *  DeckBlock-Union (src/lib/deckTypes.ts) und dem switch in Deck.tsx. */
export const ALL_BLOCK_TYPES = [...AI_BLOCK_TYPES, ...SYSTEM_BLOCK_TYPES] as const

export type BlockType = typeof ALL_BLOCK_TYPES[number]
export type Block = Record<string, unknown>

export const isKnownBlockType = (t: unknown): t is BlockType =>
  typeof t === 'string' && (ALL_BLOCK_TYPES as readonly string[]).includes(t)

/** Felder, die AUSSCHLIESSLICH deterministisch gesetzt werden. Die KI darf sie
 *  weder erfinden noch überschreiben; nach jedem Feinschliff werden sie aus dem
 *  Deck-Kontext neu gesetzt. */
export const DETERMINISTIC_FIELDS = [
  'priceLines', 'priceSummary', 'priceMain', 'priceSub',
  'mapLat', 'mapLng', 'mapQuery', 'mapEmbed', 'mapMarker', 'mapUrl', 'mapLabel',
  'planNote', 'rooms',
  'embedUrl', 'videoUrl', 'poster',
  'image',
] as const

// ── JSON-Schema-Bausteine ────────────────────────────────────────────────────
const str = { type: 'string' }
const num = { type: 'number' }
const bool = { type: 'boolean' }
const strArr = { type: 'array', items: { type: 'string' } }
const objArr = { type: 'array', items: { type: 'object' } }

/** Felder, die die KI in einem Block schreiben darf (Text und Struktur). */
const TEXT_FIELDS: Record<string, unknown> = {
  kicker: str, title: str, tagline: str, forLine: str, headline: str,
  paragraphs: strArr, signoff: str, signName: str,
  number: str, nickname: str, specs: strArr,
  note: str, text: str, quote: str, intro: str, caption: str,
  link: str, linkLabel: str,
  items: objArr, cols: objArr, cards: objArr, groups: objArr,
  stats: objArr, bullets: objArr, steps: objArr,
  phase1: { type: 'object' }, phase2: { type: 'object' },
}

/** Deterministische Felder als Schema — NUR für refine-deck, damit ein
 *  bearbeiteter Block sie unverändert zurückgeben KANN. Ohne sie löschte jeder
 *  Feinschliff am unit-Block die verbindlichen Preiszeilen, am payment-Block die
 *  Netto/MwSt/Brutto-Box, am facts-Block die Karte und am floorplan-Block die
 *  echte Flächen-Note aus hp-floorplan. */
const DETERMINISTIC_SCHEMA: Record<string, unknown> = {
  image: str, mapUrl: str, mapLabel: str, mapLat: num, mapLng: num,
  mapQuery: str, mapEmbed: str, mapMarker: { type: 'object' },
  priceMain: str, priceSub: str,
  priceLines: { type: 'array', items: { type: 'object', properties: { label: str, value: str, strong: bool }, required: ['label', 'value'] } },
  priceSummary: { type: 'object' },
  planNote: str, rooms: objArr,
  embedUrl: str, videoUrl: str, poster: str,
  /** Stabile Bild-Identität aus deck_assets_catalog. */
  assetId: str,
}

/** Tool-Schema für die Erstgenerierung. Die KI darf hier KEINE Bilder setzen —
 *  die hängt die Bildzuordnung deterministisch an. */
export function emitDeckSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      blocks: {
        type: 'array',
        description: 'Die geordnete Liste der Deck-Blöcke.',
        items: {
          type: 'object',
          properties: { type: { type: 'string', enum: [...AI_BLOCK_TYPES] }, ...TEXT_FIELDS },
          required: ['type'],
        },
      },
    },
    required: ['blocks'],
  }
}

/** Block-Schema für den Feinschliff: Text- UND deterministische Felder, damit
 *  ein vollständig ersetzter Block nichts verliert. */
export function refineBlockSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...ALL_BLOCK_TYPES] },
      ...TEXT_FIELDS,
      ...DETERMINISTIC_SCHEMA,
    },
    required: ['type'],
  }
}

/** Unbekannte Blöcke aussortieren — ein Typ, den der Renderer nicht kennt,
 *  verschwindet dort lautlos und täuscht ein vollständiges Deck vor. */
export function dropUnknownBlocks(blocks: Block[]): { kept: Block[]; dropped: string[] } {
  const dropped: string[] = []
  const kept = blocks.filter(b => {
    if (isKnownBlockType(b?.type)) return true
    dropped.push(String(b?.type ?? '(ohne type)'))
    return false
  })
  return { kept, dropped }
}
