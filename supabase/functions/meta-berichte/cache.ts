// meta-berichte: Zwischenspeicher meta_report_cache und gemeinsame Drossel-Marke.
//
// Tabelle (Migration 20261004100000_werbe_paritaet_r1.sql):
//   key text pk (sha256 der normalisierten Anfrage), payload jsonb, fetched_at, ttl_s
// TTL: 1 h für vergangene Zeiträume, 15 min wenn der Zeitraum heute enthält,
// 5 min für Status und unvollständige Ergebnisse.
//
// Fehlt die Tabelle (Migration noch nicht eingespielt), läuft alles ohne
// Zwischenspeicher weiter (nur Warnung im Log). Schreibt nur die Service-Role.
//
// Drossel-Marke: Meldet Meta mehr als 75 % Auslastung (oder Fehler 17/80004 usw.),
// wird unter dem Schlüssel auslastung:act_<konto> vermerkt, bis wann keine neuen
// Abrufe laufen sollen. Jeder Aufruf dieser Function prüft das vor dem ersten
// Meta-Abruf und liefert dann ältere Zwischenstände (veraltet) statt Meta zu belasten.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { getLastUsage, MetaApiError } from '../_shared/metaGraph.ts'
import { errText, FN, STOP_PCT, tabelleFehlt } from './common.ts'

export const TABELLE = 'meta_report_cache'
export const TTL_VERGANGEN_S = 3600
export const TTL_HEUTE_S = 900
export const TTL_KURZ_S = 300
/** Einträge älter als das werden gelegentlich aufgeräumt (reiner Zwischenspeicher) */
const AUFRAEUMEN_NACH_MS = 2 * 86_400_000
/** Größere Ergebnisse nicht speichern (Micro-Instanz; JSON-Zeichen) */
const MAX_PAYLOAD_ZEICHEN = 3_000_000

/** Fehlt die Tabelle, 10 Minuten lang nicht erneut versuchen (danach z. B. nach dem Einspielen wieder). */
let tabelleFehltBis = 0
const tabelleDa = (): boolean => Date.now() >= tabelleFehltBis
const tabelleWeg = (): void => { tabelleFehltBis = Date.now() + 10 * 60_000 }

/** JSON mit sortierten Schlüsseln (Schlüssel unabhängig von der Reihenfolge). */
export function stableStringify(v: unknown): string {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(x => stableStringify(x)).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Schlüssel = Version + sha256 der Anfrage (ohne frisch). */
export async function cacheSchluessel(teile: Record<string, unknown>): Promise<string> {
  return `b1:${await sha256Hex(stableStringify(teile))}`
}

export interface CacheTreffer<T> {
  payload: T
  fetched_at: string
  /** innerhalb der TTL */
  frisch: boolean
  alterS: number
}

export async function cacheLesen<T>(sb: SupabaseClient, key: string): Promise<CacheTreffer<T> | null> {
  if (!tabelleDa()) return null
  try {
    const { data, error } = await sb.from(TABELLE).select('payload, fetched_at, ttl_s').eq('key', key).maybeSingle()
    if (error) {
      if (tabelleFehlt(error)) {
        tabelleWeg()
        console.warn(`[${FN}] ${TABELLE} fehlt (Migration 20261004100000 noch nicht eingespielt), ohne Zwischenspeicher`)
      } else {
        console.warn(`[${FN}] ${TABELLE} lesen:`, String((error as { message?: string }).message ?? error).slice(0, 200))
      }
      return null
    }
    const row = data as { payload?: unknown; fetched_at?: string; ttl_s?: number } | null
    if (!row || row.payload === null || row.payload === undefined || !row.fetched_at) return null
    const t = Date.parse(row.fetched_at)
    if (!Number.isFinite(t)) return null
    const alterS = Math.max(0, (Date.now() - t) / 1000)
    const ttl = typeof row.ttl_s === 'number' ? row.ttl_s : Number(row.ttl_s ?? 0)
    return { payload: row.payload as T, fetched_at: new Date(t).toISOString(), frisch: alterS <= ttl, alterS }
  } catch (err) {
    console.warn(`[${FN}] ${TABELLE} lesen:`, errText(err).slice(0, 200))
    return null
  }
}

/** Schreibt einen Eintrag (wirft nie). Räumt gelegentlich alte Einträge weg. */
export async function cacheSchreiben(sb: SupabaseClient, key: string, payload: unknown, ttlS: number): Promise<void> {
  if (!tabelleDa()) return
  try {
    const groesse = JSON.stringify(payload ?? null).length
    if (groesse > MAX_PAYLOAD_ZEICHEN) {
      console.warn(`[${FN}] ${TABELLE}: Ergebnis zu groß für den Zwischenspeicher (${Math.round(groesse / 1000)} kB), nicht gespeichert`)
      return
    }
    const { error } = await sb.from(TABELLE).upsert(
      { key, payload, fetched_at: new Date().toISOString(), ttl_s: Math.max(0, Math.round(ttlS)) },
      { onConflict: 'key' },
    )
    if (error) {
      if (tabelleFehlt(error)) tabelleWeg()
      console.warn(`[${FN}] ${TABELLE} schreiben:`, String((error as { message?: string }).message ?? error).slice(0, 200))
      return
    }
    if (Math.random() < 0.04) {
      const grenze = new Date(Date.now() - AUFRAEUMEN_NACH_MS).toISOString()
      const { error: delErr } = await sb.from(TABELLE).delete().lt('fetched_at', grenze)
      if (delErr) console.warn(`[${FN}] ${TABELLE} aufräumen:`, String((delErr as { message?: string }).message ?? delErr).slice(0, 200))
    }
  } catch (err) {
    console.warn(`[${FN}] ${TABELLE} schreiben:`, errText(err).slice(0, 200))
  }
}

// ── Drossel-Marke ────────────────────────────────────────────────────────────

const drosselKey = (account: string) => `auslastung:act_${account}`

interface DrosselPayload { pct: number; reset_s: number; grund: string }

export interface Drosselung {
  pct: number
  /** Sekunden, bis wieder abgerufen wird */
  nochS: number
  grund: string
}

/** Liefert die laufende Drosselung (Auslastung > 75 % innerhalb der Sperrzeit) oder null. */
export async function drosselungLesen(sb: SupabaseClient, account: string): Promise<Drosselung | null> {
  const t = await cacheLesen<DrosselPayload>(sb, drosselKey(account))
  if (!t || !t.frisch) return null
  const pct = Number(t.payload?.pct ?? 0)
  if (!(pct > STOP_PCT)) return null
  const reset = Number(t.payload?.reset_s ?? TTL_KURZ_S)
  return { pct, nochS: Math.max(30, Math.round(reset - t.alterS)), grund: String(t.payload?.grund ?? '') }
}

const sperrzeit = (resetSec: number): number => Math.min(3600, Math.max(60, Math.round(resetSec || TTL_KURZ_S)))

/** Nach Meta-Abrufen: liegt die Auslastung über 75 %, Drossel-Marke setzen. */
export async function auslastungMerken(sb: SupabaseClient, account: string): Promise<void> {
  const u = getLastUsage()
  if (!u || !u.present || !(u.accUtilPct > STOP_PCT)) return
  const s = sperrzeit(u.resetSec)
  await cacheSchreiben(sb, drosselKey(account), { pct: u.accUtilPct, reset_s: s, grund: 'auslastung' } satisfies DrosselPayload, s)
}

/** Nach einem Rate-Limit-Fehler von Meta: Drossel-Marke mit 100 % setzen. */
export async function drosselungMerken(sb: SupabaseClient, account: string, err: MetaApiError): Promise<void> {
  const u = getLastUsage()
  const s = sperrzeit(u?.resetSec ?? 0)
  await cacheSchreiben(sb, drosselKey(account), { pct: 100, reset_s: s, grund: `rate_limit ${err.code ?? ''}`.trim() } satisfies DrosselPayload, s)
}

export function drosselText(d: Drosselung): string {
  const min = Math.max(1, Math.ceil(d.nochS / 60))
  return `Meta ist gerade zu ${Math.round(Math.min(100, d.pct))} % ausgelastet. Neue Abfragen erst wieder in etwa ${min} Minuten.`
}
