// Der Deck-Kontext: alle harten Fakten eines Decks, deterministisch aus der
// Datenbank gebaut — Wohnungen, Preise, MwSt, Zahlungsplan, Grundrisse, Karte.
//
// Warum als eigenes Modul: Bisher entstanden diese Werte ausschliesslich in
// generate-deck und lebten danach nur noch IM Block. Ein Feinschliff, der einen
// Block ersetzt, loeschte sie damit (refine-deck konnte priceLines/priceSummary/
// planNote gar nicht zurueckgeben, weil sein Schema sie nicht kannte). Jetzt
// laesst sich der Kontext jederzeit aus sales_decks.deck_context oder aus der DB
// neu aufbauen und nach JEDER Bearbeitung erneut anwenden.
//
// ACHTUNG (CLAUDE.md Regel 8): Aenderung wirkt erst nach Redeploy jeder
// importierenden Function.

import { computeUnitPrice, eur, unitKey, vatModeForAngle, type UnitPriceResult, type VatMode,
         VAT_CAP_SQM, VAT_CAP_WERT, VAT_MAX_SQM, VAT_MAX_WERT } from './deckVat.ts'

export type FurnitureMode = 'none' | 'included' | 'optional'
export type DeckLang = 'de' | 'en'

export interface PriceLine { label: string; value: string; strong?: boolean }
export interface PriceSummary { net: string; vatRate: string; vat: string; gross: string }

export interface PayStage { label: string; sub?: string; pct: number }
export interface PaySchedule { reservation?: number; currency?: string; stages: PayStage[] }

export interface DeckUnitCtx {
  unitId: string | null
  unitNumber: string
  unitKey: string
  bedrooms: number | null
  sizeSqm: number | null
  terraceSqm: number | null
  plotSqm: number | null
  floor: number | null
  unitType: string | null
  /** Nettopreis der Immobilie (bei furnitureMode 'included' die zweite
   *  Preisspalte des Bautraegers, also bereits inklusive Moebel). */
  netProperty: number
  /** Separat ausgewiesenes Moebelpaket netto (0 bei 'none' und 'included'). */
  netFurniture: number
  price: UnitPriceResult | null
  priceLines: PriceLine[]
  priceSummary: PriceSummary | null
  floorplanUrl: string | null
  floorplanNote: string | null
  /** Woher der Grundriss stammt — fuer Bericht und Gate nachvollziehbar.
   *  unit_map = hinterlegte Zuordnung je Wohnungsnummer (verifizierter HP-Plan
   *  oder von Hand abgelegte Zeichnung) · hp = verifizierter HP-Plan an der
   *  Wohnung · drive = ORIGINAL-Bautraegerplan, zugeordnet von
   *  prepare-project-assets · suffix = dieselbe Wohnungsnummer ohne Zusatz wie
   *  "(P)" · bedroom_fallback = nur ueber die Zimmerzahl geraten. */
  floorplanSource: 'unit_map' | 'hp' | 'drive' | 'suffix' | 'bedroom_fallback' | null
  /** true = der Grundriss wurde ueber Zimmerzahl statt ueber die Wohnungsnummer
   *  gefunden. Muss im Bericht sichtbar bleiben (Regel: Fallback markieren). */
  floorplanFallback: boolean
}

export interface DeckContext {
  projectId: string | null
  projectName: string
  developer: string | null
  location: string | null
  lat: number | null
  lng: number | null
  /** Geplante Fertigstellung als MM/JJJJ, sonst null. */
  completion: string | null
  angle: string
  vatMode: VatMode
  furnitureMode: FurnitureMode
  /** true, wenn die Stammdaten die Einrichtung ausdruecklich als enthalten
   *  ausweisen. Steuert den Moebel-Backstop im Scrubber. */
  furnitureIncluded: boolean
  /** true, wenn zu den Moebeln in den Stammdaten NICHTS gepflegt ist. */
  furnitureUnknown: boolean
  /** Projektweiter Netto-Moebelpreis (crm_projects.furniture_cost). */
  furnitureDefault: number
  /** Netto-Moebelpreis je Zimmerzahl (calc_defaults.furniture_by_bedrooms). */
  furnitureByBedrooms: Record<string, number> | null
  lang: DeckLang
  generic: boolean
  units: DeckUnitCtx[]
  paymentSchedule: PaySchedule | null
  paymentSource: 'project' | 'luma' | 'none'
  videoUrl: string | null
  marinaImage: string
  /** Wohnungen des Decks, fuer die nirgends ein Grundriss hinterlegt ist. */
  missingFloorplans: string[]
  /** Wohnungs-Schluessel, die im Projekt mehrfach vorkommen (Dubletten). */
  ambiguousUnitKeys: string[]
}

export const MARINA_MODEL =
  'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/paphos-marina-model.jpg'

/** Luma-Standard aus dem Agent-Guide. Greift, wenn ein Luma-Projekt keinen
 *  eigenen payment_schedule hinterlegt hat.
 *  Die letzte Stufe hiess frueher "Bei Übergabe · Title Deeds". Das Quality-Gate
 *  hat den Widerspruch gemeldet: Title Deeds sind laut Agent-Guide eine SEPARATE
 *  Gebuehr (1.500 EUR + MwSt), nicht Teil der 10-%-Rate. */
export const LUMA_PAYMENT: PaySchedule = {
  reservation: 10000, currency: 'EUR',
  stages: [
    { label: 'Bei Vertragsunterzeichnung', sub: 'abzüglich Reservierung', pct: 35 },
    { label: '2. Rate · Baufortschritt', pct: 20 },
    { label: '3. Rate · Baufortschritt', pct: 20 },
    { label: '4. Rate · Baufortschritt', pct: 15 },
    { label: 'Bei Übergabe', pct: 10 },
  ],
}

/** Zahlungsplan aus crm_projects.payment_schedule lesen — BEIDE Formate.
 *  (a) { reservation, stages: [{ label, sub, pct }] } — das Zielformat.
 *  (b) [{ label, percent, trigger }] — so legt es das Projektformular ab, wobei
 *      percent entweder "35 %" oder ein Betrag wie "10.000 €" (Reservierung) ist.
 *  Format (b) wurde bisher nicht erkannt: `Array.isArray(sched.stages)` ist bei
 *  einem Array undefined, also fiel das Projekt still auf den Luma-Standard
 *  zurueck — und Emerald Park zeigte 35/20/20/15/10 statt der hinterlegten
 *  35/30/20/10/5 (Sven 3.9.). */
export function normalizePaySchedule(raw: unknown): PaySchedule | null {
  if (!raw) return null
  if (!Array.isArray(raw) && typeof raw === 'object') {
    const o = raw as PaySchedule
    return Array.isArray(o.stages) && o.stages.length ? o : null
  }
  if (!Array.isArray(raw) || !raw.length) return null
  const zahl = (s: string) => Number(String(s).replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '')) || 0
  // GROSSBUCHSTABEN aus dem Formular in lesbare Form bringen (Kundendokument).
  const lesbar = (s: string) => {
    const t = String(s ?? '').trim()
    if (!t) return t
    if (t !== t.toUpperCase()) return t          // schon gemischt -> unveraendert
    // Wortweise, sonst wird aus "BEI VERTRAG" ein "Bei vertrag".
    return t.toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (_m, pre, c) => pre + c.toUpperCase())
  }
  let reservation: number | undefined
  const stages: PayStage[] = []
  for (const r of raw as Array<Record<string, unknown>>) {
    const roh = String(r.percent ?? r.pct ?? '')
    const label = lesbar(String(r.label ?? ''))
    const sub = r.trigger ? String(r.trigger) : (r.sub ? String(r.sub) : undefined)
    if (/%/.test(roh)) stages.push({ label, sub, pct: zahl(roh) })
    else if (/€|eur/i.test(roh)) reservation = zahl(roh)
    else if (typeof r.pct === 'number') stages.push({ label, sub, pct: r.pct })
  }
  return stages.length ? { reservation, currency: 'EUR', stages } : null
}

// ── Preiszeilen ──────────────────────────────────────────────────────────────
// Wortlaut 1:1 aus generate-deck uebernommen: die Beschriftungen sind mit Sven
// abgestimmt und stehen so in versendeten Decks.
function labels(lang: DeckLang) {
  const EN = lang === 'en'
  return {
    nettoImmo: EN ? 'Net price (property)' : 'Nettopreis Immobilie',
    nettoInklMoebel: EN ? 'Net price (incl. furniture)' : 'Nettopreis (inkl. Möbel)',
    netto: EN ? 'Net price' : 'Nettopreis',
    nettoInklEinr: EN ? 'Net price (incl. furnishing)' : 'Nettopreis (inkl. Einrichtung)',
    mwstGesamt: EN ? 'VAT total' : 'MwSt gesamt',
    brutto: EN ? 'Gross price' : 'Bruttopreis',
    einrichtungNetto: EN ? 'Furniture package (net)' : 'Einrichtungspaket (netto)',
    mwstEinr: EN ? 'VAT 19 % on furniture' : 'MwSt 19 % auf Einrichtung',
    einrichtung: EN ? 'Furnishing' : 'Einrichtung',
    imPreis: EN ? 'included in the purchase price' : 'im Kaufpreis enthalten',
    nichtImPreis: EN ? 'not included - price on request' : 'nicht im Kaufpreis - Preis auf Anfrage',
    davonEinr: EN ? 'of which furniture package' : 'davon Einrichtungspaket',
    moebelpaket: EN ? 'Furniture package' : 'Einrichtungspaket',
    zzglMwst: (pct: string) => EN ? `plus VAT (${pct})` : `zzgl. MwSt (${pct})`,
  }
}

export function buildPriceLines(
  p: UnitPriceResult, mode: FurnitureMode, vatMode: VatMode, lang: DeckLang, sizeSqm: number | null | undefined,
): PriceLine[] {
  const L = labels(lang)
  const EN = lang === 'en'
  const vatPct = vatMode === 'standard19' ? '19 %' : '5 %'
  const s = p.split

  if (vatMode !== 'standard19' && s.entfallen) {
    // Beguenstigung gekippt — eine ehrliche 19-%-Zeile plus Begruendung.
    return [
      { label: mode === 'included' ? L.nettoInklMoebel : L.nettoImmo, value: eur(p.netProperty) },
      { label: s.entfallen === 'wert'
          ? (EN ? `VAT 19 % (purchase price above ${eur(VAT_MAX_WERT)} — reduced rate does not apply)`
                : `MwSt 19 % (Kaufpreis über ${eur(VAT_MAX_WERT)} — 5 %-Regelung gilt nicht)`)
          : (EN ? `VAT 19 % (living area above ${VAT_MAX_SQM} m² — reduced rate does not apply)`
                : `MwSt 19 % (Wohnfläche über ${VAT_MAX_SQM} m² — 5 %-Regelung gilt nicht)`),
        value: eur(s.vatStandard) },
      ...(p.netFurniture > 0
        ? [{ label: L.einrichtungNetto, value: eur(p.netFurniture) },
           { label: L.mwstEinr, value: eur(p.vatFurniture) }]
        : []),
      { label: L.mwstGesamt, value: eur(p.vatTotal) },
      { label: L.brutto, value: eur(p.gross), strong: true },
    ]
  }

  if (vatMode !== 'standard19') {
    // Aufgeschluesselt: beguenstigter und regulaerer Anteil getrennt.
    const lines: PriceLine[] = [
      { label: mode === 'included' ? L.nettoInklMoebel : L.nettoImmo, value: eur(p.netProperty) },
      { label: (EN ? `VAT 5 % on ${eur(s.netReduced)}` : `MwSt 5 % auf ${eur(s.netReduced)}`)
          + (s.netStandard > 0
              ? (s.netReduced >= VAT_CAP_WERT
                  ? (EN ? ' (cap of the reduced rate)' : ' (Höchstbetrag der 5 %-Regelung)')
                  : (EN ? ` (share up to ${VAT_CAP_SQM} m² living area)` : ` (Anteil bis ${VAT_CAP_SQM} m² Wohnfläche)`))
              : ''),
        value: eur(s.vatReduced) },
    ]
    if (s.netStandard > 0) {
      const ueberFlaeche = !!(sizeSqm && sizeSqm > VAT_CAP_SQM)
      const ueberWert = s.netReduced >= VAT_CAP_WERT
      const grund = ueberFlaeche && ueberWert
        ? (EN ? `above ${VAT_CAP_SQM} m² and above ${eur(VAT_CAP_WERT)}` : `über ${VAT_CAP_SQM} m² und über ${eur(VAT_CAP_WERT)}`)
        : ueberFlaeche ? (EN ? `above ${VAT_CAP_SQM} m² living area` : `über ${VAT_CAP_SQM} m² Wohnfläche`)
        : (EN ? `share above ${eur(VAT_CAP_WERT)} — the reduced rate covers no more than this amount`
              : `Anteil über ${eur(VAT_CAP_WERT)} — die 5 %-Regelung deckt höchstens diesen Betrag`)
      lines.push({ label: EN ? `VAT 19 % on ${eur(s.netStandard)} (${grund})` : `MwSt 19 % auf ${eur(s.netStandard)} (${grund})`,
                   value: eur(s.vatStandard) })
    }
    if (p.netFurniture > 0) {
      lines.push({ label: L.einrichtungNetto, value: eur(p.netFurniture) })
      lines.push({ label: L.mwstEinr, value: eur(p.vatFurniture) })
    } else if (mode === 'included') lines.push({ label: L.einrichtung, value: L.imPreis })
    else if (mode === 'optional') lines.push({ label: L.moebelpaket, value: L.nichtImPreis })
    lines.push({ label: L.mwstGesamt, value: eur(p.vatTotal) })
    lines.push({ label: L.brutto, value: eur(p.gross), strong: true })
    return lines
  }

  const lines: PriceLine[] = [
    { label: p.netFurniture > 0 ? L.nettoInklEinr : (mode === 'included' ? L.nettoInklMoebel : L.netto),
      value: eur(p.netTotal) },
    { label: L.zzglMwst(vatPct), value: eur(p.vatTotal) },
    { label: L.brutto, value: eur(p.gross), strong: true },
  ]
  if (p.netFurniture > 0) {
    lines.push({ label: L.davonEinr, value: EN
      ? `${eur(p.netFurniture)} net · ${eur(p.netFurniture + p.vatFurniture)} gross`
      : `${eur(p.netFurniture)} netto · ${eur(p.netFurniture + p.vatFurniture)} brutto` })
  } else if (mode === 'included') lines.push({ label: L.einrichtung, value: L.imPreis })
  // Schweigen las der Kunde bisher als "ist dabei" — deshalb immer benennen.
  // Bei 'none' bleibt die Zeile weg: das Objekt wird ohne Moebel verkauft.
  else if (mode === 'optional') lines.push({ label: L.moebelpaket, value: L.nichtImPreis })
  return lines
}

export function buildPriceSummary(p: UnitPriceResult, vatMode: VatMode): PriceSummary {
  const vatPct = vatMode === 'standard19' ? '19 %' : '5 %'
  return {
    net: eur(p.netTotal),
    vatRate: p.mixed ? '5 %/19 %' : vatPct,
    vat: eur(p.vatTotal),
    gross: eur(p.gross),
  }
}

/** Netto-Moebelpreis einer Wohnung aus den Projekt-Stammdaten.
 *  Kette: zimmerabhaengige Staffel -> projektweiter Standard -> zweite Preisspalte
 *  des Bautraegers (Differenz) -> 0. Genau diese Kette nutzt auch der Wizard fuer
 *  die Vorbelegung, damit Deck und Rendite-Berechnung nie auseinanderlaufen. */
/** Ist die Quelle im Deck ueberhaupt darstellbar? Der Renderer nutzt ein
 *  <img>-Tag und faellt bei einem Ladefehler still auf einen grauen Farbverlauf
 *  zurueck — ein PDF als Grundriss ist damit unsichtbar und kommt trotzdem durch
 *  jede Pruefung. Solche Quellen werden gar nicht erst uebernommen. */
export function istDarstellbaresBild(url: string | null | undefined): boolean {
  if (!url) return false
  const pfad = String(url).split('?')[0].split('#')[0].toLowerCase()
  if (/\.(pdf|docx?|xlsx?|zip)$/.test(pfad)) return false
  // Supabase-Transform-URLs und Endungslose aus dem Storage gelten als Bild,
  // solange sie nicht ausdruecklich ein Dokument sind.
  return /\.(jpe?g|png|webp|gif|svg|avif)$/.test(pfad) || !/\.[a-z0-9]{2,5}$/.test(pfad)
}

export function furnitureNetFromProject(
  bedrooms: number | null | undefined,
  byBedrooms: Record<string, number> | null | undefined,
  projectDefault: number | null | undefined,
  priceNet?: number | null,
  priceNetFurnished?: number | null,
): number {
  if (byBedrooms && bedrooms != null && byBedrooms[String(bedrooms)] != null) {
    return Number(byBedrooms[String(bedrooms)]) || 0
  }
  const std = Number(projectDefault) || 0
  if (std > 0) return std
  if (priceNet != null && priceNetFurnished != null && priceNetFurnished > priceNet) {
    return Number(priceNetFurnished) - Number(priceNet)
  }
  return 0
}

// ── Kontext aus der Datenbank bauen ──────────────────────────────────────────
export interface BuildContextInput {
  projectId: string | null
  angle: string
  lang: DeckLang
  furnitureMode?: FurnitureMode
  generic?: boolean
  /** Wohnungen des Decks. Ohne Preis (price_net null) wird der Preis aus der DB
   *  gezogen; ist auch dort keiner, bleibt die Wohnung ohne Preiszeilen.
   *  furniture_net ueberschreibt den Moebelpreis aus den Stammdaten — Sven setzt
   *  ihn je Wohnung im Wizard. 0 ist ein gueltiger Wert (kein Paket), null/undefined
   *  bedeutet "Stammdaten verwenden". */
  units: Array<{ unit_number: string; unit_id?: string | null; price_net?: number | null; furniture_net?: number | null }>
}

type Sb = { from: (t: string) => any }

export async function buildDeckContext(sb: Sb, input: BuildContextInput): Promise<DeckContext> {
  const vatMode = vatModeForAngle(input.angle)
  const ctx: DeckContext = {
    projectId: input.projectId, projectName: '', developer: null, location: null,
    lat: null, lng: null, completion: null,
    angle: input.angle, vatMode,
    furnitureMode: input.furnitureMode ?? 'optional',
    furnitureIncluded: false, furnitureUnknown: false,
    furnitureDefault: 0, furnitureByBedrooms: null,
    lang: input.lang, generic: !!input.generic,
    units: [], paymentSchedule: null, paymentSource: 'none',
    videoUrl: null, marinaImage: MARINA_MODEL,
    missingFloorplans: [], ambiguousUnitKeys: [],
  }
  if (!input.projectId) return ctx

  const { data: proj } = await sb.from('crm_projects')
    .select('name, developer, location, latitude, longitude, video_url, completion_date, payment_schedule, furniture_cost, furniture_included, calc_defaults, deck_assets')
    .eq('id', input.projectId).maybeSingle()
  const p = (proj ?? {}) as Record<string, any>

  ctx.projectName = String(p.name ?? '')
  ctx.developer = p.developer ?? null
  ctx.location = p.location ?? null
  ctx.lat = p.latitude ?? null
  ctx.lng = p.longitude ?? null
  ctx.videoUrl = p.video_url ?? null
  if (p.completion_date) {
    const d = new Date(p.completion_date)
    if (!isNaN(d.getTime())) ctx.completion = `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
  }

  const sched = normalizePaySchedule(p.payment_schedule)
  if (sched) { ctx.paymentSchedule = sched; ctx.paymentSource = 'project' }
  else if (/luma/i.test(String(p.developer ?? ''))) { ctx.paymentSchedule = LUMA_PAYMENT; ctx.paymentSource = 'luma' }

  const furnIncluded = !!p.furniture_included
  const furnDefault = Number(p.furniture_cost) || 0
  const furnByBed = (p.calc_defaults?.furniture_by_bedrooms ?? null) as Record<string, number> | null
  // Der ausdrueckliche Wunsch aus dem Wizard schlaegt die Projekt-Stammdaten.
  const mode: FurnitureMode = input.furnitureMode ?? (furnIncluded ? 'included' : 'optional')
  ctx.furnitureMode = mode
  ctx.furnitureIncluded = mode === 'included'
  ctx.furnitureUnknown = mode === 'optional' && !furnIncluded && furnDefault <= 0 && !furnByBed
  ctx.furnitureDefault = furnDefault
  ctx.furnitureByBedrooms = furnByBed

  // Alle Wohnungen des Projekts — fuer Zimmerzahl, Flaeche, Typ und Dubletten.
  const { data: allU } = await sb.from('crm_project_units')
    .select('id, unit_number, unit_key, bedrooms, size_sqm, terrace_sqm, plot_sqm, floor, type, price_net, price_net_furnished, floorplan_url, hp_floorplan_url')
    .eq('project_id', input.projectId)
  const rows = (allU ?? []) as Array<Record<string, any>>
  const byKey = new Map<string, Record<string, any>>()
  const seen = new Map<string, number>()
  for (const r of rows) {
    const k = String(r.unit_key ?? unitKey(r.unit_number))
    seen.set(k, (seen.get(k) ?? 0) + 1)
    if (!byKey.has(k)) byKey.set(k, r)
  }
  ctx.ambiguousUnitKeys = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)

  // Hinterlegte HP-Grundrisse (Quelle: deck_assets.unit_floorplans, Fallback-Key "<n>br").
  const da = (p.deck_assets ?? {}) as Record<string, any>
  const rawFp: Record<string, string> = da.unit_floorplans
    ?? ((da.floorplans && !Array.isArray(da.floorplans)) ? da.floorplans : {}) ?? {}
  const fpMap: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawFp)) if (typeof v === 'string') fpMap[unitKey(k)] = v
  const fpNotes: Record<string, string> = {}
  for (const [k, v] of Object.entries(da.unit_floorplan_notes ?? {})) if (typeof v === 'string') fpNotes[unitKey(k)] = v

  const furnFor = (bedrooms: number | null, row: Record<string, any> | null): number => {
    if (mode === 'none' || mode === 'included') return 0
    if (furnIncluded) return 0
    return furnitureNetFromProject(bedrooms, furnByBed, furnDefault, row?.price_net, row?.price_net_furnished)
  }

  for (const u of input.units) {
    const k = unitKey(u.unit_number)
    const row = byKey.get(k) ?? null
    const bedrooms = row?.bedrooms ?? null
    const sizeSqm = row?.size_sqm != null ? Number(row.size_sqm) : null
    // Bei "mit Moebeln" gilt die ZWEITE Preisspalte des Bautraegers, nicht
    // Grundpreis plus geschaetztes Paket.
    const dbNet = mode === 'included'
      ? (row?.price_net_furnished ?? row?.price_net)
      : row?.price_net
    const netProperty = Number(u.price_net ?? dbNet ?? 0) || 0
    // Ausdrueckliche Eingabe aus dem Wizard schlaegt die Stammdaten. 0 ist gueltig.
    const netFurniture = (mode === 'none' || mode === 'included')
      ? 0
      : (u.furniture_net != null ? Math.max(0, Number(u.furniture_net) || 0) : furnFor(bedrooms, row))
    const price = netProperty > 0
      ? computeUnitPrice({ netProperty, netFurniture, livingSqm: sizeSqm, mode: vatMode })
      : null

    // ── Grundriss-Kette (Reihenfolge ist verbindlich) ────────────────────────
    //   1. hinterlegte Zuordnung je Wohnungsnummer (verifizierter HP-Plan oder
    //      von Hand abgelegte Zeichnung)
    //   2. verifizierter HP-Plan an der Wohnungszeile
    //   3. ORIGINAL-Bautraegerplan, den prepare-project-assets der Wohnung
    //      zugeordnet hat — DIE Quelle, die bisher niemand gelesen hat
    //   4. dieselbe Wohnungsnummer ohne Zusatz: "B-301 (P)" -> "B-301".
    //      Emerald Park fuehrt die Penthouses als "(P)", die Plaene ohne Zusatz —
    //      dadurch fanden 13 von 30 Wohnungen ihren vorhandenen Plan nicht.
    //   5. NUR wenn nichts davon greift: Zimmerzahl-Typplan, ausdruecklich als
    //      Fallback markiert.
    // Kein Treffer heisst KEIN Grundriss — niemals ein Ersatzbild.
    let fpUrl: string | null = null
    let fpSource: DeckUnitCtx['floorplanSource'] = null
    let fallback = false
    const nimm = (u: unknown, q: DeckUnitCtx['floorplanSource']) => {
      if (fpUrl || typeof u !== 'string' || !u.trim()) return
      if (!istDarstellbaresBild(u)) return
      fpUrl = u; fpSource = q
    }
    nimm(fpMap[k], 'unit_map')
    nimm(row?.hp_floorplan_url, 'hp')
    nimm(row?.floorplan_url, 'drive')
    if (!fpUrl) {
      // Zusatz am Ende der Wohnungsnummer abstreifen: "b301p" -> "b301".
      const ohneZusatz = k.replace(/[a-z]$/, '')
      if (ohneZusatz && ohneZusatz !== k) nimm(fpMap[ohneZusatz], 'suffix')
    }
    if (!fpUrl && bedrooms != null) {
      nimm(fpMap[`${bedrooms}br`], 'bedroom_fallback')
      if (fpUrl) fallback = true
    }

    ctx.units.push({
      unitId: u.unit_id ?? row?.id ?? null,
      unitNumber: u.unit_number,
      unitKey: k,
      bedrooms,
      sizeSqm,
      terraceSqm: row?.terrace_sqm != null ? Number(row.terrace_sqm) : null,
      plotSqm: row?.plot_sqm != null ? Number(row.plot_sqm) : null,
      floor: row?.floor ?? null,
      unitType: row?.type ?? null,
      netProperty, netFurniture, price,
      priceLines: price ? buildPriceLines(price, mode, vatMode, input.lang, sizeSqm) : [],
      priceSummary: price ? buildPriceSummary(price, vatMode) : null,
      floorplanUrl: fpUrl,
      floorplanNote: fpNotes[k] ?? null,
      floorplanSource: fpSource,
      floorplanFallback: fallback,
    })
  }
  ctx.missingFloorplans = ctx.units.filter(u => !u.floorplanUrl).map(u => u.unitNumber)
  return ctx
}
