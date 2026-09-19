// Bildauswahl fuers Deck aus dem Asset-Katalog (deck_assets_catalog).
//
// Bis 19.9.26 bekam jeder Block "das naechste Bild aus der Liste" (nextRender):
// ein Villen-Render landete im Apartment-Deck, das Cover zeigte ein Schlafzimmer.
// Ab jetzt gilt (Sven 19.9.26):
//
//   Projekt -> Wohnungstyp -> Wohnung -> Zweck des Blocks -> Kategorie -> Rotation
//
//   1. Bild dieser Wohnung (unit_key)
//   2. Bild dieses Wohnungstyps (apartment/villa/townhouse)
//   3. Projektweites Bild (project_generic: Anlage, Pool, Umgebung)
//   4. kein Bild + Befund
//   NIE: Bild eines anderen Wohnungstyps.
//
// Unklassifizierte Bilder (property_type unknown) gelten nur in Projekten mit
// EINEM Wohnungstyp als Bilder dieses Typs - dort gibt es nichts zu verwechseln.
// Bilder im Status review kommen nie automatisch auf cover oder unit.
//
// ACHTUNG (CLAUDE.md Regel 8): Aenderung wirkt erst nach Redeploy jeder
// importierenden Function.

import type { DeckContext } from './deckContext.ts'
import type { Finding, GalleryImage } from './deckGate.ts'
import { ROOM_CATS } from './deckBlocks.ts'

export interface CatalogAsset {
  id: string | null
  url: string
  category: string
  label: string
  propertyType: 'apartment' | 'villa' | 'townhouse' | 'project_generic' | 'unknown'
  unitKey: string | null
  status: 'unclassified' | 'classified' | 'approved' | 'review' | 'rejected'
  confidence: number | null
}

export type Block = Record<string, unknown>

export { ROOM_CATS }
export type RoomCat = typeof ROOM_CATS[number]
const isRoomCat = (c: unknown): c is RoomCat => (ROOM_CATS as readonly string[]).includes(String(c))

// deno-lint-ignore no-explicit-any
type Sb = { from: (t: string) => any }

/** Katalogzeilen eines Projekts (nur zeigbare Renders, nicht rejected). */
export async function loadCatalogAssets(sb: Sb, projectId: string): Promise<CatalogAsset[]> {
  const { data, error } = await sb.from('deck_assets_catalog')
    .select('id, storage_url, primary_category, label, property_type, unit_key, status, confidence, source_type')
    .eq('project_id', projectId).eq('active', true).neq('status', 'rejected')
    .in('source_type', ['developer_render', 'ai_generated', 'other'])
  if (error) throw new Error(`Katalog: ${error.message}`)
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter(r => isRoomCat(r.primary_category))
    .map(r => ({
      id: String(r.id), url: String(r.storage_url), category: String(r.primary_category), label: String(r.label ?? ''),
      propertyType: (r.property_type as CatalogAsset['propertyType']) ?? 'unknown',
      unitKey: (r.unit_key as string | null) ?? null,
      status: (r.status as CatalogAsset['status']) ?? 'unclassified',
      confidence: r.confidence == null ? null : Number(r.confidence),
    }))
}

/** Fallback ohne Katalogzeilen: die Galerie aus crm_projects.deck_assets. */
export function assetsFromGallery(gal: GalleryImage[]): CatalogAsset[] {
  const typ = (t: string | undefined): CatalogAsset['propertyType'] => {
    const x = String(t ?? '').toLowerCase()
    if (x === 'villa' || x === 'townhouse' || x === 'apartment') return x
    if (x === 'anlage') return 'project_generic'
    return 'unknown'
  }
  return gal.filter(g => isRoomCat(g.category)).map(g => ({
    id: null, url: g.url, category: g.category, label: g.label ?? '', propertyType: typ(g.unitType),
    unitKey: null, status: g.unitType ? 'classified' : 'unclassified', confidence: null,
  }))
}

/** Welche Kategorien passen zum Text eines Blocks? Reihenfolge = Praeferenz. */
const BILD_REGELN: Array<{ re: RegExp; cats: RoomCat[] }> = [
  { re: /\bpool|schwimm|sundeck|sonnendeck|planschen/i,           cats: ['pool', 'aussenbereich'] },
  { re: /\bk[üu]che|kochen|kulinar|essbereich|esszimmer|dinner/i, cats: ['kueche', 'esszimmer', 'wohnzimmer'] },
  { re: /schlafzimmer|schlafen|master|r[üu]ckzug|nachtruhe/i,      cats: ['schlafzimmer'] },
  { re: /\bbad|badezimmer|dusche|wanne|sanit[äa]r|wellness/i,     cats: ['badezimmer'] },
  { re: /wohnzimmer|wohnbereich|wohnen|lounge|sofa|kamin/i,        cats: ['wohnzimmer', 'esszimmer'] },
  { re: /terrasse|veranda|garten|au[ßs]en|outdoor|bbq|grill/i,     cats: ['aussenbereich', 'fassade'] },
  { re: /aussicht|blick|panorama|meer|sonnenunter|horizont/i,      cats: ['aussicht', 'aussenbereich', 'fassade'] },
  { re: /\bgym|fitness|sport|yoga/i,                              cats: ['gym', 'lobby'] },
  { re: /lobby|eingang|empfang|foyer/i,                            cats: ['lobby', 'fassade'] },
  { re: /architekt|fassade|geb[äa]ude|bauweise|konstruktion|lage|standort|umgebung|nachbarschaft/i, cats: ['fassade', 'aussenbereich', 'aussicht'] },
]

/** Zweck eines Blocks: erst die Absicht der KI (imageIntent), sonst der Text. */
export function blockPurpose(b: Block): RoomCat[] | null {
  if (isRoomCat(b.imageIntent)) {
    const regel = BILD_REGELN.find(r => r.cats[0] === b.imageIntent)
    return regel ? [b.imageIntent, ...regel.cats.filter(c => c !== b.imageIntent)] : [b.imageIntent]
  }
  const t = String(b.type)
  if (t === 'cover') return ['fassade', 'aussenbereich', 'aussicht', 'pool']
  const txt = [b.headline, b.kicker, b.intro, b.text, b.tagline, b.title].filter(x => typeof x === 'string').join(' ')
  const regel = BILD_REGELN.find(r => r.re.test(txt))
  if (regel) return regel.cats
  if (t === 'unit') return ['fassade', 'aussenbereich', 'wohnzimmer', 'aussicht']
  return null
}

export interface SelectResult {
  findings: Finding[]
  coverage: Record<string, unknown>
}

/**
 * Setzt die Bilder aller cover/unit/feature/columns-Bloecke und baut die
 * Bildstrecken (gallery) neu - ausschliesslich aus erlaubten Assets.
 */
export function selectImages(blocks: Block[], assetsIn: CatalogAsset[], ctx: DeckContext, opts: { lang: 'de' | 'en'; galleryCap?: number }): SelectResult {
  const findings: Finding[] = []
  const deckTypes = [...new Set(ctx.units.map(u => String(u.unitType ?? '').toLowerCase()).filter(Boolean))]
  const deckTyp = deckTypes.length === 1 ? (deckTypes[0] === 'studio' ? 'apartment' : deckTypes[0]) : ''
  const projTypes = (ctx.projectUnitTypes ?? []).map(t => (t === 'studio' ? 'apartment' : t))
  const singleType = new Set(projTypes.filter(Boolean)).size <= 1
  const unitKeys = new Set(ctx.units.map(u => u.unitKey))

  // Erlaubt = passt zum Wohnungstyp. Ohne eindeutigen Deck-Typ (gemischtes Deck)
  // bleiben nur projektweite Bilder.
  const typOk = (a: CatalogAsset): boolean => {
    if (a.propertyType === 'project_generic') return true
    if (!deckTyp) return false
    if (a.propertyType === deckTyp) return true
    if (a.propertyType === 'unknown') return singleType
    return false
  }
  const assets = assetsIn.filter(a => a.status !== 'rejected' && typOk(a))
  const wrongClass = assetsIn.filter(a => a.status !== 'rejected' && !typOk(a) && a.propertyType !== 'unknown')
  const excludedUnknown = assetsIn.filter(a => a.status !== 'rejected' && !typOk(a) && a.propertyType === 'unknown')
  const used = new Map<string, number>()
  const usage = (u: string) => used.get(u) ?? 0
  const take = (a: CatalogAsset) => { used.set(a.url, usage(a.url) + 1); return a.url }

  // Rang: eigene Wohnung (nur fuer den unit-Block) > eigener Typ > projektweit > unklassifiziert
  const rang = (a: CatalogAsset, forUnit: boolean) =>
    forUnit && a.unitKey && unitKeys.has(a.unitKey) ? 0 : a.propertyType === deckTyp ? 1 : a.propertyType === 'project_generic' ? 2 : 3
  const pick = (cats: readonly string[], forCoverOrUnit: boolean, forUnit = false): CatalogAsset | null => {
    const pool = assets.filter(a => cats.includes(a.category)
      && (!forCoverOrUnit || (a.status !== 'review' && !(a.propertyType === 'unknown' && !singleType)))
      // Bilder einer bestimmten Wohnung gehoeren dem unit-Block, nicht dem Cover.
      && (forUnit || !a.unitKey || !unitKeys.has(a.unitKey)))
    if (!pool.length) return null
    // Unbenutzt vor benutzt, dann Motiv-Praeferenz, dann Naehe zur Wohnung.
    pool.sort((x, y) =>
      usage(x.url) - usage(y.url)
      || cats.indexOf(x.category) - cats.indexOf(y.category)
      || rang(x, forUnit) - rang(y, forUnit)
      || (y.confidence ?? 0) - (x.confidence ?? 0))
    return pool[0]
  }

  // ── Blockbilder: erst Bloecke mit klarem Motiv, dann cover/unit ──────────
  const bildBloecke = blocks.map((b, i) => ({ b, i })).filter(({ b }) => ['cover', 'unit', 'columns', 'feature'].includes(String(b.type)))
  const reihenfolge = [
    ...bildBloecke.filter(({ b }) => !['cover', 'unit'].includes(String(b.type))),
    ...bildBloecke.filter(({ b }) => b.type === 'unit'),
    ...bildBloecke.filter(({ b }) => b.type === 'cover'),
  ]
  for (const { b, i } of reihenfolge) {
    const vorhanden = typeof b.image === 'string' ? b.image.trim() : ''
    if (vorhanden.startsWith('http') && (vorhanden === ctx.marinaImage || vorhanden.includes('/deck-assets/brand/'))) { continue }
    const t = String(b.type)
    const cats = blockPurpose(b)
    if (!cats) {
      delete b.image
      findings.push({ key: 'bild_kein_motiv', severity: 'niedrig', block: i,
        what: `Block ${i} (${t}) nennt kein erkennbares Motiv - er bleibt ohne Bild.`,
        evidence: String(b.headline ?? b.kicker ?? '').slice(0, 80) })
      continue
    }
    const a = pick(cats, t === 'cover' || t === 'unit', t === 'unit')
    if (!a) {
      delete b.image
      findings.push({ key: 'bild_fehlt', severity: t === 'cover' ? 'hoch' : t === 'unit' ? 'hoch' : 'mittel', block: i,
        what: `Für Block ${i} (${t}, Motiv ${cats[0]}) gibt es kein Bild des richtigen Wohnungstyps${deckTyp ? ` (${deckTyp})` : ''} - Block bleibt ohne Bild.`,
        evidence: String(b.headline ?? b.kicker ?? '').slice(0, 80),
        fix: 'Passende Bilder im Projekt hinterlegen (Aus Drive laden) oder im Katalog freigeben.' })
      continue
    }
    b.image = take(a)
  }

  // ── Bildstrecken: alle erlaubten Bilder, nach Motiv gruppiert ───────────
  const EN = opts.lang === 'en'
  const GROUPS: Array<{ cats: string[]; kicker: string; headline: string }> = EN ? [
    { cats: ['fassade', 'aussenbereich', 'aussicht'], kicker: 'Project',   headline: 'Exterior & Setting' },
    { cats: ['wohnzimmer', 'esszimmer'],            kicker: 'Interiors',  headline: 'Living & Dining' },
    { cats: ['kueche'],                             kicker: 'Interiors',  headline: 'Kitchen' },
    { cats: ['schlafzimmer'],                       kicker: 'Interiors',  headline: 'Bedrooms' },
    { cats: ['badezimmer'],                         kicker: 'Interiors',  headline: 'Bathrooms' },
    { cats: ['pool'],                               kicker: 'Highlight',  headline: 'Pool & Sundeck' },
    { cats: ['lobby', 'gym'],                       kicker: 'Amenities',  headline: 'Lobby & Communal Areas' },
  ] : [
    { cats: ['fassade', 'aussenbereich', 'aussicht'], kicker: 'Projekt',  headline: 'Außenansicht & Lage' },
    { cats: ['wohnzimmer', 'esszimmer'],            kicker: 'Innenräume', headline: 'Wohnen & Essen' },
    { cats: ['kueche'],                             kicker: 'Innenräume', headline: 'Küche' },
    { cats: ['schlafzimmer'],                       kicker: 'Innenräume', headline: 'Schlafen' },
    { cats: ['badezimmer'],                         kicker: 'Innenräume', headline: 'Bäder' },
    { cats: ['pool'],                               kicker: 'Highlight',  headline: 'Pool & Sundeck' },
    { cats: ['lobby', 'gym'],                       kicker: 'Anlage',     headline: 'Lobby & Gemeinschaft' },
  ]
  const cap = opts.galleryCap ?? 8
  const galleryBlocks: Block[] = []
  const inGallery = new Set<string>()
  for (const g of GROUPS) {
    const imgs = assets
      .filter(a => g.cats.includes(a.category) && !inGallery.has(a.url))
      .sort((x, y) => rang(x, true) - rang(y, true) || (y.confidence ?? 0) - (x.confidence ?? 0))
      .slice(0, cap)
    if (!imgs.length) continue
    imgs.forEach(a => { inGallery.add(a.url); take(a) })
    galleryBlocks.push({ type: 'gallery', kicker: g.kicker, headline: g.headline, items: imgs.map(a => ({ image: a.url, title: a.label || undefined })) })
  }
  // Rest: alles, was erlaubt ist und noch nirgends gezeigt wird (Sven: Assets
  // moeglichst breit nutzen, nicht kuenstlich auf wenige Bilder kuerzen).
  const rest = assets.filter(a => !inGallery.has(a.url) && usage(a.url) === 0).slice(0, 12)
  if (rest.length >= 2) {
    rest.forEach(a => { inGallery.add(a.url); take(a) })
    galleryBlocks.push({ type: 'gallery', kicker: EN ? 'Project' : 'Projekt', headline: EN ? 'More impressions' : 'Weitere Eindrücke', items: rest.map(a => ({ image: a.url, title: a.label || undefined })) })
  }
  if (galleryBlocks.length) {
    const filtered = blocks.filter(b => b.type !== 'gallery')
    let at = filtered.findIndex(b => b.type === 'amenity')
    if (at < 0) at = filtered.findIndex(b => b.type === 'payment')
    if (at < 0) at = filtered.findIndex(b => b.type === 'cta')
    if (at < 0) at = filtered.length
    blocks.splice(0, blocks.length, ...filtered.slice(0, at), ...galleryBlocks, ...filtered.slice(at))
  } else {
    // Keine erlaubten Bilder: KI-Galerien (ohne Bilder) entfernen statt sie mit
    // irgendetwas zu fuellen.
    const ohne = blocks.filter(b => b.type === 'gallery').length
    if (ohne) blocks.splice(0, blocks.length, ...blocks.filter(b => b.type !== 'gallery'))
  }

  // ── Coverage ─────────────────────────────────────────────────────────────
  const usable = assets.length
  const usedN = assets.filter(a => usage(a.url) > 0).length
  const byType: Record<string, { usable: number; used: number }> = {}
  for (const a of assetsIn.filter(a => a.status !== 'rejected')) {
    const k = a.propertyType
    byType[k] = byType[k] ?? { usable: 0, used: 0 }
    byType[k].usable++
    if (usage(a.url) > 0) byType[k].used++
  }
  const byCat: Record<string, { usable: number; used: number }> = {}
  for (const a of assets) {
    byCat[a.category] = byCat[a.category] ?? { usable: 0, used: 0 }
    byCat[a.category].usable++
    if (usage(a.url) > 0) byCat[a.category].used++
  }
  const duplicates = [...used.entries()].filter(([, n]) => n > 1).length
  const coverage = {
    deck_type: deckTyp || null, single_type_project: singleType,
    total: assetsIn.length, usable, used: usedN, ratio: usable ? Math.round(usedN / usable * 100) / 100 : null,
    excluded_wrong_type: wrongClass.length, excluded_unknown: excludedUnknown.length, review: assetsIn.filter(a => a.status === 'review').length,
    by_type: byType, by_category: byCat, duplicates,
  }
  if (usable && usedN / usable < 0.5) {
    findings.push({ key: 'bild_coverage_niedrig', severity: 'niedrig',
      what: `Nur ${usedN} von ${usable} verwendbaren Projektbildern sind im Deck.`, evidence: JSON.stringify(byCat).slice(0, 200) })
  }
  return { findings, coverage }
}
