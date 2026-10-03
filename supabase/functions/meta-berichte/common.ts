// meta-berichte: gemeinsame Bausteine (Kontext, Fehler, Prüfungen, Paging mit
// Auslastungs-Stopp). Keine Modus-Logik hier. Liest nur bei Meta (graphGet).

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { AdsCaller } from '../_shared/adsAuth.ts'
import { getLastUsage, graphGet, MetaApiError, metaEnv, type GraphParams } from '../_shared/metaGraph.ts'
import type { BerichteErrorCode, BerichteMode, BerichtUsage, Zeitraum } from './types.ts'

export const FN = 'meta-berichte'
/** Ab dieser Meta-Auslastung (Prozent) keine weiteren Abrufe in diesem und folgenden Aufrufen */
export const STOP_PCT = 75

export type Raw = Record<string, unknown>

export interface Ctx {
  sb: SupabaseClient
  caller: AdsCaller
  mode: BerichteMode
  /** Werbekonto ohne act_ */
  account: string
  /** Hinweise für die Antwort (deutsch) */
  hinweise: string[]
}

export function makeCtx(sb: SupabaseClient, caller: AdsCaller, mode: BerichteMode): Ctx {
  return { sb, caller, mode, account: metaEnv().account, hinweise: [] }
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
export const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : null)
export const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null
export const uniq = <T>(l: T[]): T[] => l.filter((x, i) => l.indexOf(x) === i)

// ── Fehler ───────────────────────────────────────────────────────────────────

export class BerichtError extends Error {
  status: number
  code: BerichteErrorCode
  hint?: string
  meta?: unknown
  constructor(status: number, code: BerichteErrorCode, message: string, hint?: string, meta?: unknown) {
    super(message)
    this.name = 'BerichtError'
    this.status = status
    this.code = code
    this.hint = hint
    this.meta = meta
  }
}

const META_HINT: Record<string, string> = {
  auth: 'Der Meta-Zugang (Secret META_ACCESS_TOKEN) ist ungültig oder abgelaufen. Im Business Manager einen neuen System-User-Token erzeugen und als Supabase-Secret hinterlegen.',
  rate_limit: 'Meta drosselt gerade die Abfragen (Konto auf „Limited access“). In ein paar Minuten erneut versuchen oder einen kürzeren Zeitraum wählen.',
  deprecated_version: 'Die Graph-API-Version ist bei Meta abgelaufen. Secret META_GRAPH_VERSION prüfen (Standard v25.0).',
  dev_mode: 'Die Meta-App steht im Entwicklungsmodus.',
  permission: 'Dem Meta-Token fehlt eine Leseberechtigung (ads_read). Im Business Manager beim System-User prüfen.',
  transient: 'Meta war kurz nicht erreichbar oder die Abfrage war zu groß. Kürzeren Zeitraum oder weniger Aufschlüsselungen wählen und erneut versuchen.',
  validation: 'Meta lehnt die Abfrage ab, siehe Meldung.',
  unknown: 'Unerwartete Antwort von Meta. Bitte erneut versuchen.',
}

export function fromMetaError(err: MetaApiError, prefix?: string): BerichtError {
  const textMsg = err.userMsg || err.message
  const msg = prefix ? `${prefix}: ${textMsg}` : textMsg
  const status = err.kind === 'rate_limit' ? 429 : err.kind === 'auth' ? 502 : err.kind === 'validation' ? 400 : 502
  const code: BerichteErrorCode = err.kind === 'rate_limit' ? 'rate_limited' : err.kind === 'auth' ? 'meta_auth' : 'meta_error'
  return new BerichtError(status, code, msg, META_HINT[err.kind] ?? META_HINT.unknown, err.detail())
}

export interface ErrorResponse { status: number; body: { error: string; hint?: string; code?: string; meta?: unknown } }

export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof BerichtError) {
    return { status: err.status, body: { error: err.message, hint: err.hint, code: err.code, meta: err.meta } }
  }
  if (err instanceof MetaApiError) return toErrorResponse(fromMetaError(err))
  const e = err as { status?: unknown; message?: unknown } | null
  if (e && typeof e.status === 'number' && (e.status === 401 || e.status === 403)) {
    return {
      status: e.status,
      body: { error: String(e.message ?? 'Keine Berechtigung'), code: e.status === 401 ? 'unauthorized' : 'forbidden' },
    }
  }
  return { status: 500, body: { error: `Interner Fehler: ${errText(err).slice(0, 300)}`, code: 'internal' } }
}

// ── Recht ────────────────────────────────────────────────────────────────────

/**
 * Meta-Daten nur mit Recht „Werbung“ oder „Werbemanager: nur Meta“ (wie die RLS auf
 * meta_write_log, meta_campaigns, meta_adsets, ad_catalog). requireAdsAccess lässt
 * jedes werbung_* durch, also auch „nur YouTube“ oder „nur Google“; diese Function
 * liest aber mit Service-Role. Admin, Verwalter und System-Aufrufe immer.
 */
export async function pruefeMetaRecht(sb: SupabaseClient, caller: AdsCaller): Promise<void> {
  if (caller.system || caller.role === 'admin' || caller.role === 'verwalter') return
  let perms: Raw = {}
  let fehler = caller.role !== 'mitarbeiter' || !caller.userId
  if (!fehler) {
    const { data, error } = await sb.from('profiles').select('permissions').eq('id', caller.userId ?? '').maybeSingle()
    fehler = !!error
    perms = obj(obj(data)?.permissions) ?? {}
  }
  if (fehler || (perms.werbung !== true && perms.werbung_meta !== true)) {
    throw new BerichtError(403, 'forbidden', 'Für Meta-Berichte brauchst du das Recht „Werbung“ oder „Werbemanager: nur Meta“.',
      'Das Recht vergibt ein Admin in der Mitarbeiter-Verwaltung.')
  }
}

// ── Prüfungen ────────────────────────────────────────────────────────────────

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/
const TAG_MS = 86_400_000

/** Heutiges Datum in Europe/Berlin (YYYY-MM-DD). */
export function heuteBerlin(jetzt: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(jetzt))
}

export function tageZwischen(since: string, until: string): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / TAG_MS) + 1
}

export function datumPlus(d: string, tage: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + tage * TAG_MS).toISOString().slice(0, 10)
}

function istDatum(v: unknown): v is string {
  if (typeof v !== 'string' || !DATUM_RE.test(v)) return false
  const t = Date.parse(`${v}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v
}

/** Meta liefert Insights nur für die letzten 37 Monate. */
export const MAX_RUECKBLICK_TAGE = 1125
/**
 * Stündliche Aufschlüsselung, Reichweite mit Aufschlüsselung und eindeutige Klicks
 * liefert Meta nur 13 Monate rückwirkend (Änderungen Juni 2025 und Januar 2026).
 */
export const MAX_RUECKBLICK_13_MONATE = 13

/** Datum plus/minus ganze Monate (Tag auf das Monatsende gekappt). */
export function monatePlus(d: string, monate: number): string {
  const [y, m, t] = d.split('-').map(Number)
  const idx = y * 12 + (m - 1) + monate
  const ny = Math.floor(idx / 12)
  const nm = idx - ny * 12 + 1
  const letzter = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(t, letzter)).padStart(2, '0')}`
}

/**
 * Prüft einen Zeitraum. Bis-Datum in der Zukunft wird auf heute (Berlin) gesetzt.
 * maxTage: längster erlaubter Zeitraum.
 */
export function pruefeZeitraum(since: unknown, until: unknown, label: string, maxTage: number, hinweise: string[]): Zeitraum {
  if (!istDatum(since) || !istDatum(until)) {
    throw new BerichtError(400, 'invalid_request', `${label}: since und until im Format JJJJ-MM-TT angeben.`)
  }
  const heute = heuteBerlin()
  let bis = until
  if (bis > heute) {
    bis = heute
    hinweise.push(`${label}: Bis-Datum auf heute (${heute}) gesetzt.`)
  }
  if (since > bis) throw new BerichtError(400, 'invalid_request', `${label}: Das Von-Datum liegt nach dem Bis-Datum.`)
  if (since < datumPlus(heute, -MAX_RUECKBLICK_TAGE)) {
    throw new BerichtError(400, 'invalid_request', `${label}: Meta liefert Daten nur für die letzten 37 Monate.`)
  }
  const tage = tageZwischen(since, bis)
  if (tage > maxTage) {
    throw new BerichtError(400, 'invalid_request', `${label}: höchstens ${maxTage} Tage auf einmal (gewählt ${tage}).`,
      'Kürzeren Zeitraum wählen oder gröber auflösen (Woche, Monat, gesamter Zeitraum).')
  }
  return { since, until: bis }
}

/** true, wenn der Zeitraum heute (Berlin) enthält: dann laufen die Zahlen noch. */
export function enthaeltHeute(z: Zeitraum): boolean {
  return z.until >= heuteBerlin()
}

/** Meta-Objekt-IDs (nur Ziffern, 6-25 Stellen), dedupliziert. */
export function pruefeIds(v: unknown, label: string, max: number, pflicht: boolean): string[] {
  if (v === undefined || v === null) {
    if (pflicht) throw new BerichtError(400, 'invalid_request', `${label} fehlt.`)
    return []
  }
  if (!Array.isArray(v)) throw new BerichtError(400, 'invalid_request', `${label} muss eine Liste sein.`)
  const ids = uniq(v.map(x => String(x ?? '').trim()).filter(Boolean))
  const falsch = ids.filter(x => !/^[0-9]{6,25}$/.test(x))
  if (falsch.length) throw new BerichtError(400, 'invalid_request', `${label}: ungültige Meta-ID ${falsch[0].slice(0, 30)}.`)
  if (pflicht && ids.length === 0) throw new BerichtError(400, 'invalid_request', `${label} ist leer.`)
  if (ids.length > max) throw new BerichtError(400, 'invalid_request', `${label}: höchstens ${max} IDs auf einmal.`)
  return ids
}

export function pruefeId(v: unknown, label: string): string | null {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  if (!/^[0-9]{6,25}$/.test(s)) throw new BerichtError(400, 'invalid_request', `${label} ist keine gültige Meta-ID.`)
  return s
}

// ── Meta lesen mit Auslastungs-Stopp ─────────────────────────────────────────

export function usageJetzt(): BerichtUsage | null {
  const u = getLastUsage()
  return u && u.present ? { accUtilPct: u.accUtilPct, resetSec: u.resetSec, tier: u.tier } : null
}

/** Folge-URL von Meta (paging.next) -> Pfad + Parameter für graphGet (Token wird nie übernommen). */
export function folgeSeite(next: string): { path: string; params: GraphParams } {
  const u = new URL(next)
  if (u.protocol !== 'https:' || u.hostname !== 'graph.facebook.com') {
    throw new MetaApiError({ status: 0, kind: 'validation', message: 'Unerwartete Paging-URL' })
  }
  const path = u.pathname.replace(/^\/v\d+\.\d+\//, '').replace(/^\/+/, '')
  const params: GraphParams = {}
  u.searchParams.forEach((val, key) => {
    if (!/^access_token$/i.test(key)) params[key] = val
  })
  return { path, params }
}

export interface Seiten<T> {
  rows: T[]
  /** abgebrochen wegen Auslastung oder Seitenlimit */
  unvollstaendig: boolean
  grund: string | null
}

/**
 * Liest eine Graph-Liste Seite für Seite. Bricht ab, sobald Meta mehr als STOP_PCT
 * Auslastung meldet oder maxSeiten erreicht sind (Ergebnis dann unvollständig).
 */
export async function graphSeiten<T = Raw>(path: string, params: GraphParams, maxSeiten: number): Promise<Seiten<T>> {
  const rows: T[] = []
  let p = path
  let q: GraphParams = params
  for (let seite = 1; ; seite++) {
    const res = await graphGet<{ data?: T[]; paging?: { next?: string } } | null>(p, q)
    const data = res?.data
    if (Array.isArray(data)) rows.push(...data)
    const next = res?.paging?.next
    if (!next) return { rows, unvollstaendig: false, grund: null }
    const u = getLastUsage()
    if (u && u.accUtilPct > STOP_PCT) {
      return { rows, unvollstaendig: true, grund: `Meta-Auslastung ${Math.round(u.accUtilPct)} %, weitere Seiten nicht abgerufen.` }
    }
    if (seite >= maxSeiten) {
      return { rows, unvollstaendig: true, grund: `Mehr als ${maxSeiten} Seiten, Liste gekürzt.` }
    }
    const f = folgeSeite(next)
    p = f.path
    q = f.params
  }
}

/** true, wenn ein DB-Fehler „Tabelle fehlt“ bedeutet (Migration noch nicht eingespielt). */
export function tabelleFehlt(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === '42P01' || e?.code === 'PGRST205' ||
    /relation .* does not exist|could not find the table/i.test(String(e?.message ?? ''))
}

/** true, wenn ein DB-Fehler „Spalte fehlt“ bedeutet. */
export function spalteFehlt(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === 'PGRST204' || e?.code === '42703' ||
    /column .* does not exist|could not find the .* column/i.test(String(e?.message ?? ''))
}
