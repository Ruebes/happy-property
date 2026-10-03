import type { WerbeVorratEintrag } from '../../../../lib/werbungTypes'

// ── Typen des Werbemittel-Vorrats (ad_creative_pool) ─────────────────────────
// Die Zeile selbst kommt aus src/lib/werbungTypes.ts (zentral, über crmTypes
// re-exportiert). Hier nur, was die Vorrat-Oberfläche zusätzlich braucht.
// Ändert sich der zentrale Typ, ist dies die einzige Stelle, die nachzieht.

export type VorratEintrag = WerbeVorratEintrag

/** Status-Spalten des Boards in Reihenfolge des Lebenslaufs */
export const VORRAT_STATUS = [
  'entwurf', 'geprueft', 'freigegeben', 'hochgeladen', 'aktiv', 'ermuedet', 'gekillt', 'pausiert', 'verworfen',
] as const
export type VorratStatus = typeof VORRAT_STATUS[number]
/** Immer sichtbare Spalten */
export const VORRAT_HAUPT: readonly VorratStatus[] = ['entwurf', 'geprueft', 'freigegeben', 'hochgeladen', 'aktiv']
/** Beendete Werbemittel: Spalten nur auf Wunsch */
export const VORRAT_ENDE: readonly VorratStatus[] = ['ermuedet', 'gekillt', 'pausiert', 'verworfen']

export type VorratFormat = 'bild' | 'video' | 'karussell'
export const VORRAT_FORMATE: readonly VorratFormat[] = ['bild', 'video', 'karussell']

/** texte-Spalte: bis zu 5 Primärtexte, 5 Überschriften (<= 40), 5 Beschreibungen (<= 30) */
export interface VorratTexte {
  primaer: string[]
  ueberschriften: string[]
  beschreibungen: string[]
}
export const MAX_VARIANTEN = 5

/** Ergebnis der automatischen Prüfung (werbe-autopilot vorrat_pruefen, Spalte qa) */
export interface VorratQa {
  bestanden?: boolean
  fehlend?: string[]
  pruefnote?: number
  note?: number | null
  note_quelle?: string
  lint?: Array<{ severity: string; rule: string; field: string; match?: string }>
  lint_zaehlung?: Record<string, number>
  medien?: Record<string, unknown>
  fakten?: string[]
  geprueft_at?: string
  min_review_score?: number
  /** Grundlage der Prognose {merkmal, ja, n, globale_quote, ...} */
  prognose_basis?: Record<string, unknown>
  /** letzter Fehler beim Hochladen (werbe-ausfuehren hochladen) */
  hochladen?: { fehler?: string; at?: string; schritt?: string }
}

/** Schalter aus ad_settings, die der Vorrat braucht */
export interface VorratEinstellungen {
  builderEnabled: boolean
  /** pool_auto_release_level 0..3 */
  autoStufe: number
  /** pool_auto_release_threshold 0..1 */
  schwelle: number
}

/** Kennzahlen der menschlichen Entscheidungen (Grundlage der Freigabe-Prognose) */
export interface VorratStatistik {
  entscheidungen: number
  freigaben: number
  ablehnungen: number
  /** Entscheidungen mit Prognose >= Schwelle (so rechnet auch werbe-autopilot) */
  faelle: number
  /** Anteil Freigaben unter diesen Fällen, null ohne Fälle */
  quote: number | null
}

/** Ziel-Anzeigengruppe zur Auswahl (aus dem Anzeigen-Katalog) */
export interface VorratAdset {
  id: string
  name: string
  kampagne: string
  aktiv: boolean
}

/** Formularwerte (Anlegen und Bearbeiten) */
export interface VorratFormWerte {
  kennung: string
  winkel: string
  hook_typ: string
  format: VorratFormat
  visual_typ: string
  lp_url: string
  primaer: string[]
  ueberschriften: string[]
  beschreibungen: string[]
  asset_feed_url: string | null
  asset_story_url: string | null
  eu_band: boolean
  ki_generiert: boolean
  ki_label: boolean
  fakten_pruefung: boolean
  ziel_adset_ids: string[]
}
