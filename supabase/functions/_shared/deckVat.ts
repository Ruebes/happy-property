// MwSt und Kaufpreis — EINE Wahrheit für Deck, Rechner und Nachrichten.
//
// Vorher gab es fünf Implementierungen: src/lib/price.ts, der bereits gedriftete
// _shared/price.ts, src/lib/rechner.ts vatSplit, ein eigenes vatSplitDeck in
// generate-deck (ohne reduced200) und eine Ad-hoc-Rechnung im Projektformular.
// Folge: dieselbe Wohnung konnte in der Reservierungsmail einen anderen
// Bruttopreis tragen als im Deck.
//
// Diese Datei ist der Deno-Zwilling von src/lib/rechner.ts (vatSplit) und muss
// BIT-GENAU dasselbe liefern. Abgesichert durch scripts/verify-deck-vat.mjs.
//
// ACHTUNG (CLAUDE.md Regel 8): Änderung wirkt erst nach Redeploy jeder
// importierenden Function.

export type VatMode = 'standard19' | 'reduced130' | 'reduced200'

export interface VatSplit {
  netReduced: number
  netStandard: number
  vatReduced: number
  vatStandard: number
  vat: number
  gross: number
  /** Warum die Begünstigung ganz entfällt (leer = sie greift). */
  entfallen?: 'wert' | 'flaeche'
}

// Grenzen der aktuellen zyprischen Regelung (seit 16.6.2023):
//  - 5 % nur auf die ersten 130 m² UND die ersten 350.000 EUR
//  - Voraussetzung: Wohnfläche <= 190 m² UND Kaufpreis <= 475.000 EUR
//  - Wird eine Voraussetzung gerissen, gilt für die GESAMTE Immobilie 19 %.
// Die Übergangsregelung (reduced200) kennt keine Wertgrenzen: 5 % bis 200 m².
export const VAT_CAP_SQM = 130
export const VAT_CAP_WERT = 350000
export const VAT_MAX_SQM = 190
export const VAT_MAX_WERT = 475000
export const VAT_STANDARD = 0.19
export const VAT_REDUCED = 0.05

/** Aufteilung des Nettopreises in begünstigten und regulären Anteil. */
export function vatSplit(net: number, mode: VatMode | undefined, livingSqm?: number | null): VatSplit {
  const alles19 = (grund?: 'wert' | 'flaeche'): VatSplit => {
    // Bit-genau wie der Rechner: brutto = round(netto × 1,19), MwSt = brutto − netto.
    const gross = Math.round(net * 1.19)
    const vat = gross - net
    return { netReduced: 0, netStandard: net, vatReduced: 0, vatStandard: vat, vat, gross, entfallen: grund }
  }
  if (!mode || mode === 'standard19') return alles19()

  if (mode === 'reduced130') {
    if (net > VAT_MAX_WERT) return alles19('wert')
    if (livingSqm && livingSqm > VAT_MAX_SQM) return alles19('flaeche')
    const flaechenAnteil = (livingSqm && livingSqm > 0) ? Math.min(VAT_CAP_SQM / livingSqm, 1) : 1
    const netReduced = Math.min(Math.round(net * flaechenAnteil), VAT_CAP_WERT)
    const netStandard = net - netReduced
    const vatReduced = Math.round(netReduced * VAT_REDUCED)
    const vatStandard = Math.round(netStandard * VAT_STANDARD)
    const vat = vatReduced + vatStandard
    return { netReduced, netStandard, vatReduced, vatStandard, vat, gross: net + vat }
  }

  const share = (livingSqm && livingSqm > 0) ? Math.min(200 / livingSqm, 1) : 1
  const netReduced = Math.round(net * share)
  const netStandard = net - netReduced
  const vatReduced = Math.round(netReduced * VAT_REDUCED)
  const vatStandard = Math.round(netStandard * VAT_STANDARD)
  const vat = vatReduced + vatStandard
  return { netReduced, netStandard, vatReduced, vatStandard, vat, gross: net + vat }
}

/** Deck-Winkel → MwSt-Regelung. Sven wählt den Winkel manuell; das System
 *  prüft NIE selbst, ob ein Käufer Anspruch auf den reduzierten Satz hat. */
export function vatModeForAngle(angle: string | undefined): VatMode {
  return angle === 'eigennutz' ? 'reduced130' : 'standard19'
}

/** Vollständige Preisrechnung EINER Wohnung inklusive Einrichtung.
 *  Die Einrichtung ist bewegliches Inventar und trägt IMMER 19 %. */
export interface UnitPriceInput {
  /** Nettopreis der Immobilie (bei furnitureMode 'included' bereits inkl. Möbel). */
  netProperty: number
  /** Separat ausgewiesenes Möbelpaket netto (0 bei 'none' und 'included'). */
  netFurniture: number
  /** Wohnfläche für die 130-m²-Regel. */
  livingSqm: number | null | undefined
  mode: VatMode
}

export interface UnitPriceResult {
  netProperty: number
  netFurniture: number
  netTotal: number
  split: VatSplit
  vatFurniture: number
  vatTotal: number
  gross: number
  /** true = die Wohnung trägt zwei MwSt-Sätze (5 % und 19 %). */
  mixed: boolean
}

export function computeUnitPrice(input: UnitPriceInput): UnitPriceResult {
  const netProperty = Math.max(0, input.netProperty || 0)
  const netFurniture = Math.max(0, input.netFurniture || 0)
  const split = vatSplit(netProperty, input.mode, input.livingSqm)
  const vatFurniture = Math.round(netFurniture * VAT_STANDARD)
  const vatTotal = split.vat + vatFurniture
  const netTotal = netProperty + netFurniture
  return {
    netProperty, netFurniture, netTotal, split, vatFurniture, vatTotal,
    gross: netTotal + vatTotal,
    mixed: split.netReduced > 0 && (split.netStandard > 0 || vatFurniture > 0),
  }
}

/** Prüfregel des Quality-Gates: brutto = netto + MwSt, exakt. */
export function priceIsConsistent(r: UnitPriceResult): boolean {
  return r.gross === r.netTotal + r.vatTotal
      && r.vatTotal === r.split.vat + r.vatFurniture
      && r.split.vat === r.split.vatReduced + r.split.vatStandard
      && r.split.netReduced + r.split.netStandard === r.netProperty
}

export const eur = (n: number): string =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)

/** Kanonischer Wohnungs-Schlüssel — identisch zur generierten Spalte
 *  crm_project_units.unit_key. Die EINZIGE gültige Normalisierung. */
export const unitKey = (s: unknown): string =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
