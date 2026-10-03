// meta-konto: gemeinsame Bausteine (Kontext, Fehler, Schreib-Sperre, Seiten-Token,
// Seiten-Aufrufe, Protokoll, Lint-Namen). Keine Modus-Logik.
//
// Bewusst eigenständig (keine Imports aus meta-werkzeuge/ oder meta-leads-sync/):
// die Function wird getrennt deployt und darf nicht brechen, wenn die anderen
// umgebaut werden. Seiten-Token-Muster kopiert aus meta-werkzeuge/common.ts.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { AdsCaller } from '../_shared/adsAuth.ts'
import {
  getLastUsage, graphAll, GRAPH, logMetaWrite, MetaApiError, metaEnv, metaErrorFromBody, metaErrorLogFelder,
  metaWritesDisabled, parseUsage, type MetaEnv, type MetaUsage,
} from '../_shared/metaGraph.ts'
import type { KontoErrorCode, KontoMode, KontoUsage } from './typen.ts'

export const FN = 'meta-konto'
export const HP_PAGE_ID = '556440087559971'
/** Ab dieser Meta-Auslastung (Prozent) keine weiteren optionalen Abfragen */
export const USAGE_STOPP_PCT = 75

export const APP_DEV_MODE_HINT =
  'Die Meta-App „appy Property Analytics“ (ID 1645131469886027) steht noch im Entwicklungsmodus. ' +
  'Auf developers.facebook.com unter App-Einstellungen auf „Live“ schalten.'

// ── Kleine Helfer ────────────────────────────────────────────────────────────

export type Raw = Record<string, unknown>

export const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : {})
export const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : [])
export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
export const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
export const uniq = <T>(list: T[]): T[] => list.filter((x, i) => list.indexOf(x) === i)

/** Text säubern: Leerraum am Rand weg, kürzen (Zeilenumbrüche bleiben) */
export function cleanText(v: unknown, max: number): string {
  return str(v).replace(/\r\n?/g, '\n').trim().slice(0, max)
}

/** Unix-Sekunden oder ISO-String (auch „+0000“) -> ISO-String (oder null) */
export function isoZeit(v: unknown): string | null {
  const n = num(v)
  if (n !== null && n > 1_000_000_000 && n < 10_000_000_000) return new Date(n * 1000).toISOString()
  const s = str(v)
  if (!s) return null
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** Meta-Objekt-ID (nur Ziffern, 6-25 Stellen) oder KontoError 400. */
export function metaId(v: unknown, label: string): string {
  const s = str(v).trim()
  if (!/^[0-9]{6,25}$/.test(s)) throw new KontoError(400, 'invalid_request', `${label} fehlt oder ist keine gültige Meta-ID.`)
  return s
}

/** Facebook-Beitrag „<seite>_<beitrag>“ */
export const STORY_ID_RE = /^([0-9]{6,25})_([0-9]{6,25})$/
/** Kommentar-ID: Facebook „<beitrag>_<kommentar>“, Instagram nur Ziffern */
export const COMMENT_ID_RE = /^[0-9]{6,25}(_[0-9]{6,25}){0,2}$/

export const softMsg = (e: unknown): string =>
  e instanceof MetaApiError ? (e.userMsg || e.message).slice(0, 200) : 'unbekannter Fehler'

export async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker))
  return out
}

// ── Fehler ───────────────────────────────────────────────────────────────────

export class KontoError extends Error {
  status: number
  code: KontoErrorCode | string
  hint?: string
  data?: unknown
  meta?: unknown
  constructor(status: number, code: KontoErrorCode | string, message: string, hint?: string, data?: unknown, meta?: unknown) {
    super(message)
    this.name = 'KontoError'
    this.status = status
    this.code = code
    this.hint = hint
    this.data = data
    this.meta = meta
  }
}

const META_HINT: Record<string, string> = {
  auth: 'Der Meta-Zugang (Secret META_ACCESS_TOKEN) ist ungültig oder abgelaufen. Im Business Manager einen neuen System-User-Token erzeugen und als Supabase-Secret hinterlegen.',
  rate_limit: 'Meta drosselt gerade die Anfragen (Rate-Limit). In ein paar Minuten erneut versuchen.',
  deprecated_version: 'Die Graph-API-Version ist bei Meta abgelaufen. Secret META_GRAPH_VERSION prüfen (Standard v25.0).',
  dev_mode: APP_DEV_MODE_HINT,
  permission: 'Dem Meta-Token fehlt eine Berechtigung (ads_read, ads_management, pages_show_list, pages_read_engagement, pages_manage_engagement, instagram_basic, instagram_manage_comments) oder die Seite bzw. das Instagram-Konto ist dem System-User nicht zugewiesen.',
  transient: 'Meta war kurz nicht erreichbar. Bitte noch einmal versuchen.',
  validation: 'Meta lehnt einen Wert ab, siehe Meldung.',
  unknown: 'Unerwartete Antwort von Meta. Bitte erneut versuchen; bleibt der Fehler, die fbtrace_id an den Support geben.',
}

/** MetaApiError -> KontoError mit deutscher Meldung und Hinweis. */
export function fromMetaError(err: MetaApiError, prefix?: string): KontoError {
  if (err.userMsg === 'META_WRITES_DISABLED') {
    return new KontoError(503, 'writes_disabled', 'Schreibzugriffe an Meta sind gesperrt (Secret META_WRITES_DISABLED=1).',
      'Not-Aus aufheben: Secret META_WRITES_DISABLED entfernen oder auf 0 setzen.')
  }
  const text = err.userMsg || err.message
  const msg = prefix ? `${prefix}: ${text}` : text
  const status = err.kind === 'rate_limit' ? 429 : err.kind === 'dev_mode' ? 409 : 502
  const code = err.kind === 'dev_mode' ? 'app_dev_mode' : err.kind === 'rate_limit' ? 'rate_limited' : 'meta_error'
  return new KontoError(status, code, msg, META_HINT[err.kind] ?? META_HINT.unknown, undefined, err.detail())
}

export interface ErrorResponse { status: number; body: { error: string; hint?: string; code?: string; data?: unknown; meta?: unknown } }

export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof KontoError) {
    return {
      status: err.status,
      body: {
        error: err.message, code: String(err.code),
        ...(err.hint ? { hint: err.hint } : {}),
        ...(err.data !== undefined ? { data: err.data } : {}),
        ...(err.meta !== undefined ? { meta: err.meta } : {}),
      },
    }
  }
  if (err instanceof MetaApiError) return toErrorResponse(fromMetaError(err))
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500
  if (status === 401 || status === 403) return { status, body: { error: errText(err), code: 'forbidden' } }
  return { status: 500, body: { error: `Interner Fehler: ${errText(err).slice(0, 300)}`, code: 'internal' } }
}

// ── Kontext + Einstellungen ──────────────────────────────────────────────────

export interface Settings {
  builder_enabled: boolean
  default_page_id: string
  default_ig_user_id: string | null
  /** true, wenn ad_settings die Assistenten-Spalten noch nicht hat (Migration fehlt) */
  missing: boolean
}

export interface Ctx {
  sb: SupabaseClient
  caller: AdsCaller
  env: MetaEnv
  mode: KontoMode
  settings(): Promise<Settings>
}

export function makeCtx(sb: SupabaseClient, caller: AdsCaller, mode: KontoMode): Ctx {
  let cached: Promise<Settings> | null = null
  // Seiten-Auslastung gilt nur innerhalb eines Aufrufs: ein alter Wert aus einem früheren
  // Aufruf derselben Instanz würde sonst Abfragen sperren, ohne je aufgefrischt zu werden.
  seitenUsage = null
  return {
    sb, caller, mode,
    env: metaEnv(),
    settings() {
      if (!cached) cached = loadSettings(sb)
      return cached
    },
  }
}

async function loadSettings(sb: SupabaseClient): Promise<Settings> {
  const env = metaEnv()
  const fallback: Settings = { builder_enabled: false, default_page_id: env.pageId || HP_PAGE_ID, default_ig_user_id: null, missing: true }
  const { data, error } = await sb.from('ad_settings')
    .select('builder_enabled, default_page_id, default_ig_user_id').eq('id', 'default').maybeSingle()
  if (error) {
    console.warn('[meta-konto] ad_settings:', String(error.message ?? error).slice(0, 200))
    return fallback
  }
  const r = obj(data)
  const t = (v: unknown): string | null => (/^[0-9]{6,25}$/.test(str(v).trim()) ? str(v).trim() : null)
  return {
    builder_enabled: r.builder_enabled === true,
    default_page_id: t(r.default_page_id) ?? fallback.default_page_id,
    default_ig_user_id: t(r.default_ig_user_id),
    missing: false,
  }
}

/** Recht „Werbung“ zum Ändern (admin/verwalter oder permissions.werbung). null = erlaubt. */
export async function schreibRecht(ctx: Ctx): Promise<KontoError | null> {
  const c = ctx.caller
  if (c.system || c.role === 'admin' || c.role === 'verwalter') return null
  const { data, error } = await ctx.sb.from('profiles').select('permissions').eq('id', c.userId).maybeSingle()
  const perms = obj(obj(data).permissions)
  if (error || perms.werbung !== true) {
    return new KontoError(403, 'forbidden', 'Für Änderungen bei Meta brauchst du das Recht „Werbung“.',
      'Das Recht vergibt ein Admin in der Mitarbeiter-Verwaltung.')
  }
  return null
}

/** Nur ein eingeloggter Admin (kein System-Aufruf). null = erlaubt. */
export function adminRecht(ctx: Ctx): KontoError | null {
  if (ctx.caller.system || ctx.caller.role !== 'admin') {
    return new KontoError(403, 'forbidden', 'Das Ausgabenlimit des Werbekontos darf nur ein Admin ändern.',
      'Bitte Sven fragen.')
  }
  return null
}

/** Grund, warum geschrieben werden darf oder nicht (ohne Rechte-Prüfung). null = erlaubt. */
export async function schreibSperre(ctx: Ctx): Promise<KontoError | null> {
  if (metaWritesDisabled()) {
    return new KontoError(503, 'writes_disabled', 'Schreibzugriffe an Meta sind gesperrt (Secret META_WRITES_DISABLED=1).',
      'Not-Aus aufheben: Secret META_WRITES_DISABLED entfernen oder auf 0 setzen.')
  }
  const st = await ctx.settings()
  if (st.missing) {
    return new KontoError(503, 'builder_disabled', 'Der Werbemanager ist noch nicht eingerichtet (Datenbank-Migration fehlt).',
      'Migration 20261003100000_werbung_fundament.sql einspielen.')
  }
  if (!st.builder_enabled) {
    return new KontoError(403, 'builder_disabled', 'Änderungen bei Meta sind ausgeschaltet (Kampagnen-Assistent aus).',
      'Einschalten kann nur ein Admin in den Werbe-Einstellungen (Kampagnen-Assistent).')
  }
  return null
}

/** Schreib-Sperre wie meta-builder: META_WRITES_DISABLED, Schreibrecht, builder_enabled. null = erlaubt. */
export async function writeGate(ctx: Ctx): Promise<KontoError | null> {
  if (metaWritesDisabled()) return await schreibSperre(ctx)
  const recht = await schreibRecht(ctx)
  if (recht) return recht
  return await schreibSperre(ctx)
}

// ── Nutzung (Konto-Token und Seiten-Token) ───────────────────────────────────

let seitenUsage: MetaUsage | null = null

const hoechste = (): MetaUsage | null => {
  const a = getLastUsage()
  const b = seitenUsage
  if (!a) return b
  if (!b) return a
  return a.accUtilPct >= b.accUtilPct ? a : b
}

export const auslastungHoch = (): boolean => (hoechste()?.accUtilPct ?? 0) > USAGE_STOPP_PCT

export function usageInfo(): KontoUsage {
  const u = hoechste()
  if (!u || !u.present) return { accUtilPct: null, resetSec: null, tier: u?.tier ?? null }
  return { accUtilPct: u.accUtilPct, resetSec: u.resetSec, tier: u.tier }
}

// ── Protokoll ────────────────────────────────────────────────────────────────

export function actorFields(ctx: Ctx): { actor: string | null; actor_kind: 'user' | 'system' } {
  return { actor: ctx.caller.userId, actor_kind: ctx.caller.system ? 'system' : 'user' }
}

/** Zeile in meta_write_log (Erfolg oder Fehler). Wirft nie. */
export async function logWrite(ctx: Ctx, row: {
  level: string; path: string; entityId?: string | null; request?: unknown; before?: unknown; after?: unknown; err?: unknown
}): Promise<void> {
  await logMetaWrite(ctx.sb, {
    ...actorFields(ctx), fn: FN, mode: ctx.mode, entity_level: row.level, entity_id: row.entityId ?? null,
    method: 'POST', path: row.path, validate_only: false, request: row.request ?? null,
    before: row.before ?? null, after: row.after ?? null,
    ok: row.err === undefined, ...(row.err !== undefined ? metaErrorLogFelder(row.err) : {}), usage: hoechste(),
  })
}

/**
 * Erfolgreiche Schreibzugriffe dieses Modus (optional je Objekt) seit sinceIso.
 * null = Protokoll nicht lesbar (Tabelle fehlt o. ä.).
 */
export async function protokollZaehlen(ctx: Ctx, mode: KontoMode, sinceIso: string, entityId?: string): Promise<number | null> {
  let q = ctx.sb.from('meta_write_log').select('id').eq('fn', FN).eq('mode', mode).eq('ok', true).gte('ts', sinceIso)
  if (entityId) q = q.eq('entity_id', entityId)
  const { data, error } = await q.limit(50)
  if (error) {
    console.warn('[meta-konto] meta_write_log lesen:', String(error.message ?? error).slice(0, 200))
    return null
  }
  return arr(data).length
}

/** SHA-256 als Hex (für Protokolle: Text wiedererkennbar, ohne ihn zu speichern) */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Feld in after einer Fehlerzeile, das die Reservierung mit dieser ID wieder freigibt */
export const RESERVIERUNG_FREI = 'reservierung_frei'

/**
 * Doppelklick-Schutz ohne eigene Tabelle: VOR dem Meta-POST eine Reservierung in
 * meta_write_log schreiben (ok = null, ohne Texte), dann alle Zeilen desselben Objekts im
 * Zeitfenster lesen. Senden darf nur, wessen Reservierung die früheste noch gültige ist;
 * gültig ist jede Zeile mit ok true oder null, außer eine Fehlerzeile gibt sie frei
 * (after.reservierung_frei = id, nur wenn Meta sicher nichts übernommen hat).
 * Ergebnis: eigene Reservierungs-ID, 'belegt' oder null (Protokoll nicht nutzbar, ohne Schutz weiter).
 */
export async function reservieren(ctx: Ctx, row: { level: string; path: string; entityId: string; request: unknown }, fensterMs: number): Promise<{ id: string | number } | 'belegt' | null> {
  const seit = new Date(Date.now() - fensterMs).toISOString()
  const ins = await ctx.sb.from('meta_write_log').insert({
    ...actorFields(ctx), fn: FN, mode: ctx.mode, entity_level: row.level, entity_id: row.entityId,
    method: 'POST', path: row.path, validate_only: false, request: row.request,
    after: { reserviert: true }, ok: null, usage: hoechste(),
  }).select('id').single()
  const eigen = obj(ins.data).id
  if (ins.error || (typeof eigen !== 'string' && typeof eigen !== 'number')) {
    console.warn('[meta-konto] Reservierung schreiben:', String(ins.error?.message ?? 'ohne id').slice(0, 200))
    return null
  }
  const { data, error } = await ctx.sb.from('meta_write_log').select('id, ok, after')
    .eq('fn', FN).eq('mode', ctx.mode).eq('entity_id', row.entityId).gte('ts', seit)
    .order('id', { ascending: true }).limit(100)
  if (error) {
    console.warn('[meta-konto] Reservierung prüfen:', String(error.message ?? error).slice(0, 200))
    return { id: eigen }
  }
  const rows = arr<Raw>(data)
  const frei = new Set(rows.filter(r => r.ok === false).map(r => String(obj(r.after)[RESERVIERUNG_FREI] ?? '')).filter(Boolean))
  const gueltig = rows.filter(r => r.ok !== false && !frei.has(String(r.id)))
  const erste = gueltig.find(r => String(r.id) === String(eigen)) ? gueltig[0] : undefined
  // eigene Zeile nicht gelesen (z. B. Uhrzeit-Versatz): nur senden, wenn sonst nichts im Fenster steht
  if (erste ? String(erste.id) !== String(eigen) : gueltig.length > 0) return 'belegt'
  return { id: eigen }
}

// ── Seiten-Token ─────────────────────────────────────────────────────────────
// Kommentare lesen/beantworten/ausblenden verlangt einen Page Access Token. Den
// holt der System-User-Token über /me/accounts (Muster aus meta-leads-sync und
// meta-werkzeuge). Der Seiten-Token bleibt nur im Speicher: nie in Logs,
// Antworten oder URLs.

export async function pageAccessToken(pageId: string): Promise<string | null> {
  const list = await graphAll<{ id?: string; access_token?: string }>('me/accounts', { fields: 'id,access_token', limit: 100 }, { maxPages: 3 })
  const own = list.find(p => str(p.id) === pageId)
  return own?.access_token ? String(own.access_token) : null
}

export async function seitenToken(pageId: string): Promise<string> {
  const token = await pageAccessToken(pageId)
  if (!token) {
    throw new KontoError(403, 'forbidden', 'Für die Facebook-Seite gibt es keinen Seiten-Token.',
      'Die Seite muss im Business Manager dem System-User zugewiesen sein (Rechte pages_show_list, pages_read_engagement, pages_manage_engagement).')
  }
  return token
}

/** Pfad „<id>“ oder „<id>/<edge>“; IDs auch „<a>_<b>“ (Beiträge, Kommentare). */
const PAGE_PATH_RE = /^[0-9]{6,25}(_[0-9]{6,25}){0,2}(\/[a-z_]+)?$/

/** GET/POST mit Seiten-Token. Respektiert META_WRITES_DISABLED. */
export async function pageFetch<T>(method: 'GET' | 'POST', path: string, pageToken: string, params: Raw, timeoutMs = 25_000): Promise<T> {
  if (method === 'POST' && metaWritesDisabled()) {
    throw new MetaApiError({ status: 0, kind: 'permission', userMsg: 'META_WRITES_DISABLED', message: 'Schreibzugriffe an Meta sind per META_WRITES_DISABLED gesperrt' })
  }
  const clean = path.replace(/^\/+/, '')
  if (!PAGE_PATH_RE.test(clean)) throw new MetaApiError({ status: 0, kind: 'validation', message: 'Ungültiger Seiten-Pfad' })
  let url = `${GRAPH}/${clean}`
  let body: string | undefined
  if (method === 'GET') {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || /^access_token$/i.test(k)) continue
      q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
    const qs = q.toString()
    if (qs) url += `?${qs}`
  } else {
    const p: Raw = { ...params }
    delete p.access_token
    body = JSON.stringify(p)
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${pageToken}` }
    if (body) headers['Content-Type'] = 'application/json'
    res = await fetch(url, { method, headers, body, signal: ctrl.signal })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    // bewusst ohne err.message (könnte die URL enthalten)
    throw new MetaApiError({ status: 0, kind: 'transient', message: aborted ? `Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s` : 'Netzwerkfehler beim Seiten-Aufruf' })
  } finally {
    clearTimeout(timer)
  }
  const u = parseUsage(res)
  // letzter Stand (wie metaGraph), kein Maximum; makeCtx setzt ihn je Aufruf zurück
  if (u.present) seitenUsage = u
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 200) } }
  if (!res.ok || obj(json).error) throw metaErrorFromBody(res.status, json, `HTTP ${res.status}`)
  if (obj(json).success === false) throw new MetaApiError({ status: res.status, kind: 'unknown', message: 'Meta meldet success=false' })
  return json as T
}

// ── Projekt-/Bauträgernamen für den Lint ─────────────────────────────────────

export async function forbiddenNames(sb: SupabaseClient): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (v: unknown) => {
    const t = str(v).trim()
    if (t.length < 3) return
    const k = t.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    out.push(t)
  }
  const p = await sb.from('crm_projects').select('name, developer').limit(3000)
  if (p.error) console.warn('[meta-konto] crm_projects:', String(p.error.message ?? p.error).slice(0, 200))
  for (const r of arr<Raw>(p.data)) { add(r.name); add(r.developer) }
  const d = await sb.from('crm_developers').select('name').limit(2000)
  if (d.error) console.warn('[meta-konto] crm_developers:', String(d.error.message ?? d.error).slice(0, 200))
  for (const r of arr<Raw>(d.data)) add(r.name)
  return out
}
