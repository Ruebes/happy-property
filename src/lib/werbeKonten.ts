// Meta-Werbekonten des CRM (seit 24.10.2026 zwei).
//
//   4065490590399677 Sveru Marketing LLC, USD: läuft aus, bis auf Weiteres Anlagekonto
//   576349958305345  Happy Property (Sveru Ltd), EUR: vorbereitet
//
// Der Server (supabase/functions/_shared/metaGraph.ts) ist die Wahrheit: welche Konten
// gelesen werden (META_AD_ACCOUNT_IDS) und wo neu angelegt wird (META_CREATE_ACCOUNT_ID).
// Hier stehen nur Anzeige-Namen, Währungen und die Kontowahl der Seite für die Reiter,
// die je Konto bei Meta lesen (Zentrale, Zielgruppen, Formulare, Tests & Regeln, Messung,
// Kommentare). Die Wahl geht als account_id an meta-berichte, meta-steuerung,
// meta-werkzeuge und meta-konto; ohne account_id nimmt der Server das Anlagekonto.
// Statistik und Autopilot zeigen immer beide Konten, Summen nur über spend_eur.

import { useSyncExternalStore } from 'react'

export type KontoWaehrung = 'USD' | 'EUR'

export interface WerbeKonto {
  /** ohne act_ */
  id: string
  name: string
  waehrung: KontoWaehrung
  /** kurze Kennung für Badges */
  kurz: string
}

export const ALTES_KONTO_ID = '4065490590399677'
export const NEUES_KONTO_ID = '576349958305345'
/** Anlagekonto für neue Kampagnen (Spiegel des Server-Standards; Server entscheidet) */
export const ANLAGE_KONTO_ID = ALTES_KONTO_ID

export const WERBEKONTEN: readonly WerbeKonto[] = [
  { id: ALTES_KONTO_ID, name: 'Sveru Marketing LLC', waehrung: 'USD', kurz: 'LLC · USD' },
  { id: NEUES_KONTO_ID, name: 'Happy Property (Sveru Ltd)', waehrung: 'EUR', kurz: 'Ltd · EUR' },
]

const nurZiffern = (v: unknown): string => String(v ?? '').replace(/[^0-9]/g, '')

export function kontoVon(id: unknown): WerbeKonto | null {
  const k = nurZiffern(id)
  return WERBEKONTEN.find(w => w.id === k) ?? null
}

/** Währung eines Kontos; unbekannt = Server-Angabe, sonst USD (wie bisher) */
export function waehrungVon(id: unknown, serverWaehrung?: string | null): KontoWaehrung {
  const s = String(serverWaehrung ?? '').toUpperCase()
  if (s === 'EUR' || s === 'USD') return s
  return kontoVon(id)?.waehrung ?? 'USD'
}

/** Einheiten der Kontowährung je EUR: EUR-Konto 1, USD-Konto der Kurs (USD je EUR) */
export function kontoJeEur(waehrung: KontoWaehrung, usdProEur: number): number {
  return waehrung === 'EUR' ? 1 : usdProEur
}

export const waehrungZeichen = (w: KontoWaehrung): string => (w === 'EUR' ? '€' : '$')

// ── Kontowahl der Seite (je Browser gemerkt) ────────────────────────────────

const SPEICHER = 'hp-werbekonto'
let gewaehlt: string = (() => {
  try {
    const v = nurZiffern(window.localStorage.getItem(SPEICHER))
    if (kontoVon(v)) return v
  } catch { /* privater Modus: Standard */ }
  return ANLAGE_KONTO_ID
})()
const hoerer = new Set<() => void>()

/** Gewähltes Konto (ohne act_) für die Reiter, die je Konto bei Meta lesen */
export function gewaehltesKonto(): string {
  return gewaehlt
}

export function setGewaehltesKonto(id: string): void {
  const k = nurZiffern(id)
  if (!kontoVon(k) || k === gewaehlt) return
  gewaehlt = k
  try { window.localStorage.setItem(SPEICHER, k) } catch { /* ohne Speicher: nur diese Sitzung */ }
  for (const h of hoerer) h()
}

export function useGewaehltesKonto(): string {
  return useSyncExternalStore(
    cb => { hoerer.add(cb); return () => { hoerer.delete(cb) } },
    () => gewaehlt,
    () => gewaehlt,
  )
}

/** body ergänzen: account_id des gewählten Kontos, wenn der Aufrufer keins setzt */
export function mitKonto<T extends object>(body: T): T & { account_id?: string } {
  const b = body as T & { account_id?: unknown }
  if (b.account_id !== undefined && b.account_id !== null && b.account_id !== '') return b as T & { account_id?: string }
  return { ...body, account_id: gewaehlt }
}
