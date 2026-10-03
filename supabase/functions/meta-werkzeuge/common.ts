// meta-werkzeuge: gemeinsame Bausteine (Kontext, Fehler, Schreib-Sperre,
// Meta-POST mit Protokoll, Seiten-Token, Housing-Eignung). Keine Modus-Logik.
//
// Bewusst eigenständig (keine Imports aus meta-builder/): die Function wird
// getrennt deployt und darf nicht brechen, wenn meta-builder umgebaut wird.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { AdsCaller } from '../_shared/adsAuth.ts'
import {
  getLastUsage, graphAll, graphGet, graphPost, GRAPH, logMetaWrite, MetaApiError, metaEnv, metaErrorFromBody,
  metaErrorLogFelder, metaWritesDisabled, type MetaEnv, type MetaUsage,
} from '../_shared/metaGraph.ts'
import type { WerkzeugErrorCode, WerkzeugMode, WerkzeugUsage } from './typen.ts'

export const FN = 'meta-werkzeuge'
export const HP_PAGE_ID = '556440087559971'
export const HP_PIXEL_ID = '1083578343946189'
/** Ab dieser Meta-Auslastung (Prozent) keine optionalen Zusatzabfragen mehr */
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
export const digits = (v: unknown): string => str(v).replace(/[^0-9]/g, '')
export const uniq = <T>(list: T[]): T[] => list.filter((x, i) => list.indexOf(x) === i)
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Text säubern: Leerraum zusammenfassen, kürzen */
export function cleanText(v: unknown, max: number): string {
  return str(v).replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Unix-Sekunden oder ISO-String -> ISO-String (oder null) */
export function isoZeit(v: unknown): string | null {
  const n = num(v)
  if (n !== null && n > 1_000_000_000 && n < 10_000_000_000) return new Date(n * 1000).toISOString()
  const s = str(v)
  if (!s) return null
  const t = Date.parse(s.replace(/\+0000$/, 'Z'))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** Meta-Objekt-ID (nur Ziffern, 6-25 Stellen) oder WerkzeugError 400. */
export function metaId(v: unknown, label: string): string {
  const s = str(v).trim()
  if (!/^[0-9]{6,25}$/.test(s)) throw new WerkzeugError(400, 'invalid_request', `${label} fehlt oder ist keine gültige Meta-ID.`)
  return s
}

/** Ganze Zahl in [min, max] oder WerkzeugError 400. */
export function ganzzahl(v: unknown, min: number, max: number, label: string): number {
  const n = num(v)
  if (n === null || !Number.isInteger(n) || n < min || n > max) {
    throw new WerkzeugError(400, 'invalid_request', `${label}: bitte eine ganze Zahl von ${min} bis ${max}.`)
  }
  return n
}

export function name200(v: unknown, label = 'Name'): string {
  const n = cleanText(v, 200)
  if (!n) throw new WerkzeugError(400, 'invalid_request', `${label} fehlt.`)
  return n
}

export const HTTPS_URL_RE = /^https:\/\/[^\s/?#]+\.[^\s]+$/i

export const softMsg = (e: unknown): string =>
  e instanceof MetaApiError ? (e.userMsg || e.message).slice(0, 200) : 'unbekannter Fehler'

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

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

export const auslastungHoch = (): boolean => (getLastUsage()?.accUtilPct ?? 0) > USAGE_STOPP_PCT

// ── Fehler ───────────────────────────────────────────────────────────────────

export class WerkzeugError extends Error {
  status: number
  code: WerkzeugErrorCode | string
  hint?: string
  data?: unknown
  meta?: unknown
  constructor(status: number, code: WerkzeugErrorCode | string, message: string, hint?: string, data?: unknown, meta?: unknown) {
    super(message)
    this.name = 'WerkzeugError'
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
  permission: 'Dem Meta-Token fehlt eine Berechtigung (ads_management, pages_manage_ads, pages_show_list, leads_retrieval) oder die Nutzungsbedingungen für Custom Audiences sind im Werbekonto noch nicht akzeptiert.',
  transient: 'Meta war kurz nicht erreichbar. Bitte noch einmal versuchen.',
  validation: 'Meta lehnt einen Wert ab, siehe Meldung.',
  unknown: 'Unerwartete Antwort von Meta. Bitte erneut versuchen; bleibt der Fehler, die fbtrace_id an den Support geben.',
}

/** MetaApiError -> WerkzeugError mit deutscher Meldung und Hinweis. */
export function fromMetaError(err: MetaApiError, prefix?: string): WerkzeugError {
  if (err.userMsg === 'META_WRITES_DISABLED') {
    return new WerkzeugError(503, 'writes_disabled', 'Schreibzugriffe an Meta sind gesperrt (Secret META_WRITES_DISABLED=1).',
      'Not-Aus aufheben: Secret META_WRITES_DISABLED entfernen oder auf 0 setzen.')
  }
  const text = err.userMsg || err.message
  const msg = prefix ? `${prefix}: ${text}` : text
  const status = err.kind === 'rate_limit' ? 429 : err.kind === 'dev_mode' ? 409 : 502
  const code = err.kind === 'dev_mode' ? 'app_dev_mode' : err.kind === 'rate_limit' ? 'rate_limited' : 'meta_error'
  // Terms of Service für Custom Audiences nicht akzeptiert (200/1870090)
  const hint = err.subcode === 1870090
    ? 'Im Werbeanzeigenmanager unter Zielgruppen einmal die Nutzungsbedingungen für Custom Audiences akzeptieren (Business-Admin).'
    : (META_HINT[err.kind] ?? META_HINT.unknown)
  return new WerkzeugError(status, code, msg, hint, undefined, err.detail())
}

export interface ErrorResponse { status: number; body: { error: string; hint?: string; code?: string; data?: unknown; meta?: unknown } }

export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof WerkzeugError) {
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
  default_pixel_id: string
  default_ig_user_id: string | null
  /** true, wenn ad_settings die Assistenten-Spalten noch nicht hat (Migration fehlt) */
  missing: boolean
}

export interface Ctx {
  sb: SupabaseClient
  caller: AdsCaller
  env: MetaEnv
  mode: WerkzeugMode
  settings(): Promise<Settings>
}

export function makeCtx(sb: SupabaseClient, caller: AdsCaller, mode: WerkzeugMode): Ctx {
  let cached: Promise<Settings> | null = null
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
  const fallback: Settings = {
    builder_enabled: false, default_page_id: env.pageId || HP_PAGE_ID, default_pixel_id: env.pixelId || HP_PIXEL_ID,
    default_ig_user_id: null, missing: true,
  }
  const { data, error } = await sb.from('ad_settings')
    .select('builder_enabled, default_page_id, default_pixel_id, default_ig_user_id').eq('id', 'default').maybeSingle()
  if (error) {
    console.warn('[meta-werkzeuge] ad_settings:', String(error.message ?? error).slice(0, 200))
    return fallback
  }
  const r = obj(data)
  const t = (v: unknown): string | null => (str(v).trim() ? str(v).trim() : null)
  return {
    builder_enabled: r.builder_enabled === true,
    default_page_id: t(r.default_page_id) ?? fallback.default_page_id,
    default_pixel_id: t(r.default_pixel_id) ?? fallback.default_pixel_id,
    default_ig_user_id: t(r.default_ig_user_id),
    missing: false,
  }
}

/**
 * ad_settings.kundenliste_freigegeben (Migration 20261004100000). Eigene Abfrage,
 * damit eine fehlende Spalte die übrigen Einstellungen nicht mitreißt.
 * null = Spalte fehlt (Migration nicht eingespielt).
 */
export async function kundenlisteFreigegeben(sb: SupabaseClient): Promise<boolean | null> {
  const { data, error } = await sb.from('ad_settings').select('kundenliste_freigegeben').eq('id', 'default').maybeSingle()
  if (error) {
    console.warn('[meta-werkzeuge] kundenliste_freigegeben:', String(error.message ?? error).slice(0, 200))
    return null
  }
  return obj(data).kundenliste_freigegeben === true
}

/** Recht „Werbung“ zum Ändern (admin/verwalter oder permissions.werbung). null = erlaubt. */
export async function schreibRecht(ctx: Ctx): Promise<WerkzeugError | null> {
  const c = ctx.caller
  if (c.system || c.role === 'admin' || c.role === 'verwalter') return null
  const { data, error } = await ctx.sb.from('profiles').select('permissions').eq('id', c.userId).maybeSingle()
  const perms = obj(obj(data).permissions)
  if (error || perms.werbung !== true) {
    return new WerkzeugError(403, 'forbidden', 'Für Änderungen bei Meta brauchst du das Recht „Werbung“.',
      'Das Recht vergibt ein Admin in der Mitarbeiter-Verwaltung.')
  }
  return null
}

/**
 * Schreib-Sperre wie meta-builder: META_WRITES_DISABLED, Schreibrecht,
 * ad_settings.builder_enabled. null = erlaubt.
 */
export async function writeGate(ctx: Ctx): Promise<WerkzeugError | null> {
  if (metaWritesDisabled()) {
    return new WerkzeugError(503, 'writes_disabled', 'Schreibzugriffe an Meta sind gesperrt (Secret META_WRITES_DISABLED=1).',
      'Not-Aus aufheben: Secret META_WRITES_DISABLED entfernen oder auf 0 setzen.')
  }
  const recht = await schreibRecht(ctx)
  if (recht) return recht
  const st = await ctx.settings()
  if (st.missing) {
    return new WerkzeugError(503, 'builder_disabled', 'Der Werbemanager ist noch nicht eingerichtet (Datenbank-Migration fehlt).',
      'Migration 20261003100000_werbung_fundament.sql einspielen.')
  }
  if (!st.builder_enabled) {
    return new WerkzeugError(403, 'builder_disabled', 'Änderungen bei Meta sind ausgeschaltet (Kampagnen-Assistent aus).',
      'Einschalten kann nur ein Admin in den Werbe-Einstellungen (Kampagnen-Assistent).')
  }
  return null
}

export function usageInfo(u: MetaUsage | null = getLastUsage()): WerkzeugUsage {
  if (!u || !u.present) return { accUtilPct: null, resetSec: null, tier: u?.tier ?? null }
  return { accUtilPct: u.accUtilPct, resetSec: u.resetSec, tier: u.tier }
}

// ── Meta-POST mit Protokoll ──────────────────────────────────────────────────

export function actorFields(ctx: Ctx): { actor: string | null; actor_kind: 'user' | 'system' } {
  return { actor: ctx.caller.userId, actor_kind: ctx.caller.system ? 'system' : 'user' }
}

export interface PostOpts {
  level: string
  /** Ziel-Objekt bei Änderungen; bei Neuanlagen wird die neue ID protokolliert */
  entityId?: string | null
  /** statt body ins Protokoll (z. B. ohne Hashes) */
  logRequest?: unknown
  /** statt Antwort ins Protokoll */
  logAfter?: (res: Raw) => unknown
  timeoutMs?: number
}

/** graphPost (nie wiederholt: Neuanlagen) + Zeile in meta_write_log (Erfolg und Fehler). */
export async function metaPost(ctx: Ctx, path: string, body: Raw, o: PostOpts): Promise<Raw> {
  const base = {
    ...actorFields(ctx), fn: FN, mode: ctx.mode, entity_level: o.level, method: 'POST', path,
    validate_only: false, request: o.logRequest !== undefined ? o.logRequest : body,
  }
  try {
    const res = obj(await graphPost<Raw>(path, body, { timeoutMs: o.timeoutMs }))
    await logMetaWrite(ctx.sb, {
      ...base, entity_id: o.entityId ?? (str(res.id) || null), ok: true,
      after: o.logAfter ? o.logAfter(res) : res, usage: getLastUsage(),
    })
    return res
  } catch (err) {
    await logMetaWrite(ctx.sb, { ...base, entity_id: o.entityId ?? null, ok: false, ...metaErrorLogFelder(err), usage: getLastUsage() })
    throw err
  }
}

/** Protokollzeile für Schreibzugriffe außerhalb von graphPost (Seiten-Token). */
export async function logWrite(ctx: Ctx, row: { level: string; path: string; entityId?: string | null; request?: unknown; after?: unknown; err?: unknown }): Promise<void> {
  await logMetaWrite(ctx.sb, {
    ...actorFields(ctx), fn: FN, mode: ctx.mode, entity_level: row.level, entity_id: row.entityId ?? null,
    method: 'POST', path: row.path, validate_only: false, request: row.request ?? null, after: row.after ?? null,
    ok: row.err === undefined, ...(row.err !== undefined ? metaErrorLogFelder(row.err) : {}), usage: getLastUsage(),
  })
}

// ── Seiten-Token (Sofortformulare) ───────────────────────────────────────────
// leadgen_forms lesen und anlegen verlangt einen Page Access Token. Den holt der
// System-User-Token über /me/accounts (Muster aus meta-leads-sync). Der
// Seiten-Token bleibt nur im Speicher: nie in Logs, Antworten oder URLs.

export async function pageAccessToken(pageId: string): Promise<string | null> {
  const list = await graphAll<{ id?: string; access_token?: string }>('me/accounts', { fields: 'id,access_token', limit: 100 }, { maxPages: 3 })
  const own = list.find(p => str(p.id) === pageId)
  return own?.access_token ? String(own.access_token) : null
}

export async function seitenToken(pageId: string): Promise<string> {
  const token = await pageAccessToken(pageId)
  if (!token) {
    throw new WerkzeugError(403, 'forbidden', 'Für diese Seite gibt es keinen Seiten-Token.',
      'Die Seite muss im Business Manager dem System-User zugewiesen sein (Rechte pages_show_list, pages_manage_ads, leads_retrieval).')
  }
  return token
}

/** GET/POST mit Seiten-Token. Pfad nur „<id>“ oder „<id>/<edge>“. */
export async function pageFetch<T>(method: 'GET' | 'POST', path: string, pageToken: string, params: Raw, timeoutMs: number): Promise<T> {
  if (method === 'POST' && metaWritesDisabled()) {
    throw new MetaApiError({ status: 0, kind: 'permission', userMsg: 'META_WRITES_DISABLED', message: 'Schreibzugriffe an Meta sind per META_WRITES_DISABLED gesperrt' })
  }
  const clean = path.replace(/^\/+/, '')
  if (!/^[0-9]{6,25}(\/[a-z_]+)?$/.test(clean)) throw new MetaApiError({ status: 0, kind: 'validation', message: 'Ungültiger Seiten-Pfad' })
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
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 200) } }
  if (!res.ok || obj(json).error) throw metaErrorFromBody(res.status, json, `HTTP ${res.status}`)
  return json as T
}

// ── Konto-Prüfungen ──────────────────────────────────────────────────────────

/** Pixel des Werbekontos (id -> name). null, wenn die Liste nicht lesbar ist. */
export async function kontoPixel(account: string): Promise<Map<string, string> | null> {
  try {
    const list = await graphAll<Raw>(`act_${account}/adspixels`, { fields: 'id,name', limit: 50 }, { maxPages: 2 })
    return new Map(list.map(p => [str(p.id), str(p.name)] as [string, string]).filter(([id]) => id))
  } catch (e) {
    console.warn('[meta-werkzeuge] adspixels:', softMsg(e))
    return null
  }
}

/** Pixel muss zum Werbekonto gehören (sonst 403). Liste nicht lesbar -> Hinweis, weiter. */
export async function pruefePixel(ctx: Ctx, pixelId: string, hinweise: string[]): Promise<void> {
  const pixel = await kontoPixel(ctx.env.account)
  if (pixel === null) {
    hinweise.push('Pixel-Liste des Werbekontos nicht lesbar, Zugehörigkeit nicht geprüft.')
    return
  }
  if (!pixel.has(pixelId)) {
    throw new WerkzeugError(403, 'forbidden', `Pixel ${pixelId} gehört nicht zum Werbekonto.`,
      `Erlaubt: ${Array.from(pixel.keys()).join(', ') || 'keine Pixel gefunden'}`)
  }
}

/**
 * Housing-Eignung einer Custom Audience (Sonderkategorie Wohnen im Land).
 * GET /{ca}?fields=is_eligible_for_sac_campaigns&special_ad_categories=HOUSING&special_ad_category_countries=DE
 */
export async function sacEligibility(account: string, audienceId: string, land: string): Promise<{ eligible: boolean | null; reason?: string }> {
  try {
    const j = await graphGet<Raw>(audienceId, {
      fields: 'is_eligible_for_sac_campaigns',
      ad_account_id: `act_${account}`,
      special_ad_categories: 'HOUSING',
      special_ad_category_countries: land,
    }, { retry: false })
    const v = j.is_eligible_for_sac_campaigns
    return typeof v === 'boolean' ? { eligible: v } : { eligible: null, reason: 'Meta liefert keine Angabe.' }
  } catch (e) {
    return { eligible: null, reason: softMsg(e) }
  }
}

/**
 * Doppelklick-Schutz: Zielgruppe gleichen Namens (ohne Groß/klein) im Werbekonto.
 * Wirft, wenn die Liste nicht vollständig lesbar ist (strict).
 */
export async function zielgruppeGleichenNamens(account: string, name: string): Promise<Raw | null> {
  const list = await graphAll<Raw>(`act_${account}/customaudiences`, { fields: 'id,name', limit: 100 }, { maxPages: 10, strict: true })
  const n = name.trim().toLowerCase()
  return list.find(a => str(a.name).trim().toLowerCase() === n) ?? null
}

/** Ländercode(s) „DE“ bzw. „DE,AT“ -> bereinigt, Standard DE */
export function laenderParam(v: unknown): string {
  const list = uniq(str(v).toUpperCase().split(/[,\s]+/).filter(c => /^[A-Z]{2}$/.test(c)))
  return list.length ? list.slice(0, 5).join(',') : 'DE'
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
  if (p.error) console.warn('[meta-werkzeuge] crm_projects:', String(p.error.message ?? p.error).slice(0, 200))
  for (const r of arr<Raw>(p.data)) { add(r.name); add(r.developer) }
  const d = await sb.from('crm_developers').select('name').limit(2000)
  if (d.error) console.warn('[meta-werkzeuge] crm_developers:', String(d.error.message ?? d.error).slice(0, 200))
  for (const r of arr<Raw>(d.data)) add(r.name)
  return out
}
