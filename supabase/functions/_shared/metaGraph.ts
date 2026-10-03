// Gemeinsamer Zugang zur Meta Graph / Marketing API für alle Werbe-Functions.
//
// WARUM DIESE DATEI EXISTIERT:
// Bis Oktober 2026 hatte jede Werbe-Function ihre eigene Kopie von GRAPH
// ('https://graph.facebook.com/v21.0'), graphGet und graphPost. v21 ist für die
// Marketing API seit 9.9.2025 abgelaufen; Schreib-Endpunkte (adcreatives, ads,
// adsets) antworten dann mit Fehler 2635. Version, Token-Handling, Timeouts,
// Fehlerklassen, Nutzungs-Header und der globale Not-Aus stehen deshalb NUR hier.
//
// Exporte (Kurzreferenz):
//   GRAPH_VERSION, GRAPH         Secret META_GRAPH_VERSION (Form vNN.0), sonst v25.0
//   metaEnv()                    { token, account, pixelId, pageId } aus den Secrets
//   graphGet<T>(path, params?, opts?)            GET, 25 s Timeout, 1 Wiederholung bei transient
//   graphAll<T>(path, params, { maxPages, strict })  Liste mit Paging; stoppt über 90 % Nutzung
//   graphPost<T>(path, body, { validateOnly, syncReview, timeoutMs, idempotent })
//                                POST als JSON, 30 s; wirft MetaApiError(kind 'permission',
//                                userMsg 'META_WRITES_DISABLED'), solange META_WRITES_DISABLED=1
//                                (validate_only ist davon ausgenommen)
//   MetaApiError                 status, code, subcode, userTitle, userMsg, blame[], fbtraceId,
//                                kind ('auth'|'rate_limit'|'deprecated_version'|'dev_mode'|
//                                'validation'|'permission'|'transient'|'unknown'), retryable
//   parseUsage(res), getLastUsage()   X-Ad-Account-Usage / X-Business-Use-Case-Usage /
//                                X-FB-Ads-Insights-Throttle -> MetaUsage
//   logMetaWrite(sb, row)        Zeile in meta_write_log (wirft nie), metaErrorLogFelder(err)
//   uploadImage(account, bytes, contentType, name) -> image_hash   (adimages, 120 s)
//   assertOwnAccount(objectId)   GET ?fields=account_id, wirft wenn fremdes Konto
//   URL_TAGS_STANDARD, checkUrlTags(tags, link)
//   wechselkurs(sb)              USD je EUR aus ad_insights_daily (7 Tage), Fallback 1,14
//   budgetHeadroom(sb, { addDailyUsdCents, replaceEntityId?, replaceEntityIds? })
//                                Summe aktiver Tagesbudgets (live bei Meta) in EUR gegen
//                                ad_settings.max_account_daily_budget
//
// Regeln:
//   - Token IMMER im Authorization-Header, nie in URL, Log oder Fehlertext.
//   - Nichts in dieser Datei löscht oder archiviert etwas bei Meta.
//   - Schreibende Aufrufer loggen selbst über logMetaWrite (graphPost kennt kein sb).
//
// Nach Änderungen: grep -rln "_shared/metaGraph.ts" supabase/functions/ und JEDE
// Fundstelle neu deployen (CLAUDE.md Regel 8).

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

// ── Version + Umgebung ───────────────────────────────────────────────────────

const VERSION_RE = /^v\d{2}\.0$/
const ENV_VERSION = (Deno.env.get('META_GRAPH_VERSION') ?? '').trim()

export const GRAPH_VERSION: string = VERSION_RE.test(ENV_VERSION) ? ENV_VERSION : 'v25.0'
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`

export const DEFAULT_AD_ACCOUNT_ID = '4065490590399677'
export const DEFAULT_PIXEL_ID = '1083578343946189'
export const DEFAULT_PAGE_ID = '556440087559971'

export const GET_TIMEOUT_MS = 25_000
export const POST_TIMEOUT_MS = 30_000
export const UPLOAD_TIMEOUT_MS = 120_000

export interface MetaEnv {
  /** System-User-Token; leer, wenn das Secret fehlt (dann wirft jeder Graph-Aufruf kind 'auth') */
  token: string
  /** Werbekonto ohne Präfix act_ */
  account: string
  pixelId: string
  pageId: string
}

const digits = (v: string | undefined | null): string => String(v ?? '').replace(/[^0-9]/g, '')

export function metaEnv(): MetaEnv {
  return {
    token: (Deno.env.get('META_ACCESS_TOKEN') ?? '').trim(),
    account: digits(Deno.env.get('META_AD_ACCOUNT_ID')) || DEFAULT_AD_ACCOUNT_ID,
    pixelId: digits(Deno.env.get('META_PIXEL_ID')) || DEFAULT_PIXEL_ID,
    pageId: digits(Deno.env.get('META_PAGE_ID')) || DEFAULT_PAGE_ID,
  }
}

/** Globaler Not-Aus für alle Schreibzugriffe an Meta (Secret META_WRITES_DISABLED=1). */
export function metaWritesDisabled(): boolean {
  return (Deno.env.get('META_WRITES_DISABLED') ?? '').trim() === '1'
}

// ── Fehler ───────────────────────────────────────────────────────────────────

export type MetaErrorKind =
  | 'auth' | 'rate_limit' | 'deprecated_version' | 'dev_mode'
  | 'validation' | 'permission' | 'transient' | 'unknown'

export interface MetaBlame { field?: string; message?: string }

export interface MetaApiErrorInit {
  status: number
  code?: number | null
  subcode?: number | null
  userTitle?: string | null
  userMsg?: string | null
  message?: string | null
  blame?: MetaBlame[]
  fbtraceId?: string | null
  kind?: MetaErrorKind
}

function classify(status: number, code: number | null, subcode: number | null): MetaErrorKind {
  if (subcode === 1885183) return 'dev_mode'
  if (code === 190 || code === 102) return 'auth'
  if (code !== null && ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014))) return 'rate_limit'
  if (code === 2635) return 'deprecated_version'
  if (code === 100) return 'validation'
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return 'permission'
  if (code === 1 || code === 2) return 'transient'
  if (code === null && (status === 0 || status >= 500)) return 'transient'
  return 'unknown'
}

export class MetaApiError extends Error {
  status: number
  code: number | null
  subcode: number | null
  userTitle: string | null
  userMsg: string | null
  blame: MetaBlame[]
  fbtraceId: string | null
  kind: MetaErrorKind
  retryable: boolean

  constructor(init: MetaApiErrorInit) {
    const code = init.code ?? null
    const subcode = init.subcode ?? null
    const text = init.userMsg || init.message || 'Unbekannter Meta-Fehler'
    super(`Meta ${init.status}${code !== null ? ` (${code}${subcode !== null ? `/${subcode}` : ''})` : ''}: ${text}`.slice(0, 400))
    this.name = 'MetaApiError'
    this.status = init.status
    this.code = code
    this.subcode = subcode
    this.userTitle = init.userTitle ?? null
    this.userMsg = init.userMsg ?? null
    this.blame = init.blame ?? []
    this.fbtraceId = init.fbtraceId ?? null
    this.kind = init.kind ?? classify(init.status, code, subcode)
    this.retryable = this.kind === 'transient' || this.kind === 'rate_limit'
  }

  /** Für Logs / API-Antworten (ohne Stack, ohne Token). */
  detail(): Record<string, unknown> {
    return {
      status: this.status, code: this.code, subcode: this.subcode, kind: this.kind,
      user_title: this.userTitle, user_msg: this.userMsg, message: this.message,
      blame: this.blame, fbtrace_id: this.fbtraceId,
    }
  }
}

const toNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const toStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

function parseErrorData(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try { return JSON.parse(v) as Record<string, unknown> } catch { return null }
  }
  return null
}

/** Baut aus einer Graph-Fehlerantwort einen MetaApiError (blame_field_specs -> blame). */
export function metaErrorFromBody(status: number, body: unknown, fallback?: string): MetaApiError {
  const e = ((body as { error?: Record<string, unknown> } | null)?.error ?? {}) as Record<string, unknown>
  const userMsg = toStr(e.error_user_msg)
  const message = toStr(e.message) ?? fallback ?? null
  const data = parseErrorData(e.error_data)
  const specs = Array.isArray(data?.blame_field_specs) ? data!.blame_field_specs as unknown[] : []
  const blame: MetaBlame[] = specs.map(spec => ({
    field: Array.isArray(spec) ? spec.map(String).join('.') : String(spec),
    message: userMsg ?? message ?? undefined,
  }))
  return new MetaApiError({
    status,
    code: toNum(e.code),
    subcode: toNum(e.error_subcode),
    userTitle: toStr(e.error_user_title),
    userMsg,
    message,
    blame,
    fbtraceId: toStr(e.fbtrace_id),
  })
}

function writesDisabledError(): MetaApiError {
  return new MetaApiError({
    status: 0, kind: 'permission', userMsg: 'META_WRITES_DISABLED',
    message: 'Schreibzugriffe an Meta sind per META_WRITES_DISABLED gesperrt',
  })
}

function tokenMissingError(): MetaApiError {
  return new MetaApiError({ status: 0, kind: 'auth', message: 'META_ACCESS_TOKEN fehlt (Supabase Secrets)' })
}

// ── Nutzungs-Header ──────────────────────────────────────────────────────────

export interface MetaBucEntry {
  type: string
  callCount: number
  totalCputime: number
  totalTime: number
  regainMinutes: number
}

export interface MetaUsage {
  /** höchster bekannter Auslastungswert in Prozent (Konto, Insights, BUC); 0 wenn kein Header */
  accUtilPct: number
  /** Sekunden bis zur Entsperrung (0 = nicht gesperrt) */
  resetSec: number
  /** ads_api_access_tier, z.B. development_access / standard_access */
  tier: string | null
  buc: MetaBucEntry[]
  /** true wenn mindestens ein Nutzungs-Header vorhanden war */
  present: boolean
}

function jsonHeader(res: Response, name: string): unknown {
  const raw = res.headers.get(name)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export function parseUsage(res: Response): MetaUsage {
  const out: MetaUsage = { accUtilPct: 0, resetSec: 0, tier: null, buc: [], present: false }
  const acc = jsonHeader(res, 'x-ad-account-usage') as Record<string, unknown> | null
  if (acc) {
    out.present = true
    out.accUtilPct = Math.max(out.accUtilPct, toNum(acc.acc_id_util_pct) ?? 0)
    out.resetSec = Math.max(out.resetSec, toNum(acc.reset_time_duration) ?? 0)
    out.tier = toStr(acc.ads_api_access_tier) ?? out.tier
  }
  const ins = jsonHeader(res, 'x-fb-ads-insights-throttle') as Record<string, unknown> | null
  if (ins) {
    out.present = true
    out.accUtilPct = Math.max(out.accUtilPct, toNum(ins.acc_id_util_pct) ?? 0, toNum(ins.app_id_util_pct) ?? 0)
    out.tier = out.tier ?? toStr(ins.ads_api_access_tier)
  }
  const buc = jsonHeader(res, 'x-business-use-case-usage') as Record<string, unknown> | null
  if (buc && typeof buc === 'object') {
    out.present = true
    for (const list of Object.values(buc)) {
      if (!Array.isArray(list)) continue
      for (const raw of list as Record<string, unknown>[]) {
        const entry: MetaBucEntry = {
          type: String(raw.type ?? ''),
          callCount: toNum(raw.call_count) ?? 0,
          totalCputime: toNum(raw.total_cputime) ?? 0,
          totalTime: toNum(raw.total_time) ?? 0,
          regainMinutes: toNum(raw.estimated_time_to_regain_access) ?? 0,
        }
        out.buc.push(entry)
        out.accUtilPct = Math.max(out.accUtilPct, entry.callCount, entry.totalCputime, entry.totalTime)
        out.resetSec = Math.max(out.resetSec, entry.regainMinutes * 60)
        out.tier = out.tier ?? toStr(raw.ads_api_access_tier)
      }
    }
  }
  return out
}

let lastUsage: MetaUsage | null = null
/** Nutzung aus der letzten Graph-Antwort dieses Aufrufs (null vor dem ersten Aufruf). */
export function getLastUsage(): MetaUsage | null {
  return lastUsage
}

// ── Kern-Request ─────────────────────────────────────────────────────────────

type ParamValue = string | number | boolean | null | undefined | unknown[] | Record<string, unknown>
export type GraphParams = Record<string, ParamValue>

function cleanPath(path: string): string {
  const p = String(path ?? '').trim().replace(/^\/+/, '')
  if (!p || /^https?:/i.test(p) || p.includes('..')) {
    throw new MetaApiError({ status: 0, kind: 'validation', message: `Ungültiger Graph-Pfad "${p.slice(0, 80)}"` })
  }
  return p
}

function buildQuery(params: GraphParams | undefined): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue
    if (/^access_token$/i.test(k)) continue
    q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** Paging-URL von Meta: nur graph.facebook.com, access_token immer entfernen. */
function safePagingUrl(raw: string): string {
  const u = new URL(raw)
  if (u.protocol !== 'https:' || u.hostname !== 'graph.facebook.com') {
    throw new MetaApiError({ status: 0, kind: 'validation', message: 'Unerwartete Paging-URL' })
  }
  u.searchParams.delete('access_token')
  return u.toString()
}

/** Entfernt Token aus einem Pfad/URL-String (für Logs). */
export function scrubPath(path: string): string {
  return String(path ?? '').replace(/([?&])access_token=[^&]*/gi, '$1access_token=REDACTED').slice(0, 500)
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

interface RawResult { status: number; json: unknown; usage: MetaUsage }

async function rawRequest(
  method: 'GET' | 'POST',
  url: string,
  body: BodyInit | undefined,
  contentType: string | null,
  timeoutMs: number,
): Promise<RawResult> {
  const { token } = metaEnv()
  if (!token) throw tokenMissingError()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (contentType) headers['Content-Type'] = contentType
    res = await fetch(url, { method, headers, body, signal: ctrl.signal })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new MetaApiError({
      status: 0, kind: 'transient',
      message: aborted ? `Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s` : `Netzwerkfehler: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    })
  } finally {
    clearTimeout(timer)
  }
  const usage = parseUsage(res)
  lastUsage = usage
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 300) } }
  const errBody = json as { error?: unknown; success?: unknown } | null
  if (!res.ok || (errBody && errBody.error)) throw metaErrorFromBody(res.status, json, `HTTP ${res.status}`)
  if (errBody && errBody.success === false) {
    throw new MetaApiError({ status: res.status, kind: 'unknown', message: 'Meta meldet success=false' })
  }
  return { status: res.status, json, usage }
}

export interface GraphGetOptions {
  timeoutMs?: number
  /** Standard true: einmal nach 2 s wiederholen, wenn der Fehler transient ist */
  retry?: boolean
}

/** GET auf einen Graph-Pfad (ohne Version, z.B. 'act_123/campaigns' oder '120…'). */
export async function graphGet<T = Record<string, unknown>>(
  path: string,
  params?: GraphParams,
  opts: GraphGetOptions = {},
): Promise<T> {
  const url = `${GRAPH}/${cleanPath(path)}${buildQuery(params)}`
  return await getUrl<T>(url, opts)
}

async function getUrl<T>(url: string, opts: GraphGetOptions): Promise<T> {
  const timeout = opts.timeoutMs ?? GET_TIMEOUT_MS
  try {
    return (await rawRequest('GET', url, undefined, null, timeout)).json as T
  } catch (err) {
    if (opts.retry !== false && err instanceof MetaApiError && err.kind === 'transient') {
      await sleep(2000)
      return (await rawRequest('GET', url, undefined, null, timeout)).json as T
    }
    throw err
  }
}

export interface GraphAllOptions {
  /** Standard 30 Seiten */
  maxPages?: number
  /** true: wirft statt eine unvollständige Liste zurückzugeben (Leitplanken!) */
  strict?: boolean
  timeoutMs?: number
}

/** Liste mit Paging einsammeln. Stoppt, wenn die Konto-Nutzung über 90 % liegt. */
export async function graphAll<T = Record<string, unknown>>(
  path: string,
  params: GraphParams,
  opts: GraphAllOptions = {},
): Promise<T[]> {
  const maxPages = Math.max(1, opts.maxPages ?? 30)
  const out: T[] = []
  let url: string | null = `${GRAPH}/${cleanPath(path)}${buildQuery(params)}`
  let pages = 0
  while (url) {
    const page: { data?: T[]; paging?: { next?: string } } | null =
      await getUrl<{ data?: T[]; paging?: { next?: string } } | null>(url, { timeoutMs: opts.timeoutMs })
    pages++
    out.push(...(Array.isArray(page?.data) ? page.data : []))
    const next: string | null = page?.paging?.next ? safePagingUrl(page.paging.next) : null
    if (!next) break
    const usage = lastUsage
    if (usage && usage.accUtilPct > 90) {
      const msg = `Meta-Nutzung ${Math.round(usage.accUtilPct)} % - Paging nach ${pages} Seiten abgebrochen`
      if (opts.strict) throw new MetaApiError({ status: 0, kind: 'rate_limit', message: msg })
      console.warn(`[metaGraph] ${msg} (${scrubPath(path)})`)
      break
    }
    if (pages >= maxPages) {
      const msg = `mehr als ${maxPages} Seiten bei ${scrubPath(path)}`
      if (opts.strict) throw new MetaApiError({ status: 0, kind: 'unknown', message: `Liste unvollständig: ${msg}` })
      console.warn(`[metaGraph] Liste abgeschnitten: ${msg}`)
      break
    }
    url = next
  }
  return out
}

export interface GraphPostOptions {
  /** execution_options ['validate_only'] - nichts wird bei Meta verändert */
  validateOnly?: boolean
  /** zusätzlich 'synchronous_ad_review' (nur mit validateOnly, nur /ads) */
  syncReview?: boolean
  timeoutMs?: number
  /**
   * true nur für Aufrufe, die man gefahrlos wiederholen kann (Status/Budget setzen,
   * CAPI mit event_id). Neuanlagen NIE wiederholen (Dubletten-Gefahr).
   */
  idempotent?: boolean
}

/** POST (JSON) auf einen Graph-Pfad. Respektiert META_WRITES_DISABLED. */
export async function graphPost<T = Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
  opts: GraphPostOptions = {},
): Promise<T> {
  if (metaWritesDisabled() && !opts.validateOnly) throw writesDisabledError()
  const url = `${GRAPH}/${cleanPath(path)}`
  const payload: Record<string, unknown> = { ...body }
  delete payload.access_token
  if (opts.validateOnly) {
    payload.execution_options = opts.syncReview ? ['validate_only', 'synchronous_ad_review'] : ['validate_only']
  }
  const timeout = opts.timeoutMs ?? POST_TIMEOUT_MS
  const send = async () => (await rawRequest('POST', url, JSON.stringify(payload), 'application/json', timeout)).json as T
  try {
    return await send()
  } catch (err) {
    const mayRetry = opts.idempotent === true || opts.validateOnly === true
    if (mayRetry && err instanceof MetaApiError && err.kind === 'transient') {
      await sleep(2000)
      return await send()
    }
    throw err
  }
}

// ── Audit-Log meta_write_log ─────────────────────────────────────────────────

export interface MetaWriteLogRow {
  actor?: string | null
  actor_kind: 'user' | 'system' | 'autopilot'
  fn: string
  mode?: string | null
  entity_level?: string | null
  entity_id?: string | null
  draft_id?: string | null
  method?: string
  /** Graph-Pfad ohne Version und ohne Token */
  path: string
  validate_only?: boolean
  request?: unknown
  before?: unknown
  after?: unknown
  ok: boolean
  http_status?: number | null
  meta_error?: unknown
  fbtrace_id?: string | null
  usage?: unknown
}

const SECRET_KEY_RE = /(access_token|appsecret|secret|password|passwort|authorization|^token$)/i

function redact(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v ?? null
  if (typeof v === 'string') return v.length > 2000 ? `${v.slice(0, 2000)}…` : v
  if (typeof v !== 'object') return v
  if (depth > 6) return '[tief]'
  if (v instanceof Uint8Array || v instanceof ArrayBuffer || (typeof Blob !== 'undefined' && v instanceof Blob)) return '[binär]'
  if (Array.isArray(v)) return v.slice(0, 100).map(x => redact(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? 'REDACTED' : redact(val, depth + 1)
  }
  return out
}

/** Felder für meta_write_log aus einem Fehler (meta_error, http_status, fbtrace_id). */
export function metaErrorLogFelder(err: unknown): Pick<MetaWriteLogRow, 'meta_error' | 'http_status' | 'fbtrace_id'> {
  if (err instanceof MetaApiError) {
    return { meta_error: err.detail(), http_status: err.status || null, fbtrace_id: err.fbtraceId }
  }
  return { meta_error: { message: err instanceof Error ? err.message : String(err) }, http_status: null, fbtrace_id: null }
}

/** Schreibt eine Zeile in meta_write_log. Wirft nie (Log darf nichts blockieren). */
export async function logMetaWrite(sb: SupabaseClient, row: MetaWriteLogRow): Promise<void> {
  try {
    const { error } = await sb.from('meta_write_log').insert({
      actor: row.actor ?? null,
      actor_kind: row.actor_kind,
      fn: row.fn,
      mode: row.mode ?? null,
      entity_level: row.entity_level ?? null,
      entity_id: row.entity_id ?? null,
      draft_id: row.draft_id ?? null,
      method: row.method ?? 'POST',
      path: scrubPath(row.path),
      validate_only: row.validate_only === true,
      request: redact(row.request ?? null),
      before: redact(row.before ?? null),
      after: redact(row.after ?? null),
      ok: row.ok,
      http_status: row.http_status ?? null,
      meta_error: redact(row.meta_error ?? null),
      fbtrace_id: row.fbtrace_id ?? null,
      usage: row.usage ?? null,
    })
    if (error) console.warn('[metaGraph] meta_write_log:', String(error.message ?? error).slice(0, 200))
  } catch (err) {
    console.warn('[metaGraph] meta_write_log:', err instanceof Error ? err.message : String(err))
  }
}

// ── Medien ───────────────────────────────────────────────────────────────────

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/webp': 'webp',
}

/**
 * Lädt ein Bild in die Bildbibliothek des Werbekontos (POST act_X/adimages) und
 * gibt den image_hash zurück. Port aus studio/index.ts (uploadToMeta), aber mit
 * echtem Content-Type statt immer image/png. Wirft bei META_WRITES_DISABLED.
 */
export async function uploadImage(
  account: string,
  bytes: Uint8Array | ArrayBuffer,
  contentType: string,
  name: string,
): Promise<string> {
  if (metaWritesDisabled()) throw writesDisabledError()
  const acct = digits(account) || metaEnv().account
  const type = String(contentType || '').toLowerCase().split(';')[0].trim()
  if (!type.startsWith('image/')) {
    throw new MetaApiError({ status: 0, kind: 'validation', message: `Kein Bild-Content-Type: "${type}"` })
  }
  const ext = EXT_BY_TYPE[type] ?? 'jpg'
  const base = String(name || `bild-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const fileName = /\.[A-Za-z0-9]{2,5}$/.test(base) ? base : `${base}.${ext}`
  const copy = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes)
  const form = new FormData()
  form.append('filename', new Blob([copy], { type }), fileName)
  const { json } = await rawRequest('POST', `${GRAPH}/act_${acct}/adimages`, form, null, UPLOAD_TIMEOUT_MS)
  const images = (json as { images?: Record<string, { hash?: string }> } | null)?.images ?? {}
  const hash = Object.values(images)[0]?.hash
  if (!hash) throw new MetaApiError({ status: 200, kind: 'unknown', message: 'Meta-Upload ohne image_hash' })
  return hash
}

/** Wirft MetaApiError(kind 'permission'), wenn das Objekt nicht zu unserem Werbekonto gehört. */
export async function assertOwnAccount(objectId: string): Promise<string> {
  const id = digits(objectId)
  if (!id) throw new MetaApiError({ status: 0, kind: 'validation', message: 'Objekt-ID fehlt' })
  const own = metaEnv().account
  const j = await graphGet<{ account_id?: string }>(id, { fields: 'account_id' })
  const acc = digits(j?.account_id)
  if (!acc || acc !== own) {
    throw new MetaApiError({ status: 403, kind: 'permission', message: 'Objekt gehört nicht zu unserem Werbekonto', userMsg: 'Objekt gehört nicht zu unserem Werbekonto' })
  }
  return acc
}

// ── UTM-Schema ───────────────────────────────────────────────────────────────

export const URL_TAGS_STANDARD =
  'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}'

export interface UrlTagsCheck {
  ok: boolean
  /** Schlüssel des Standards, die fehlen oder einen anderen Wert haben */
  abweichend: Array<{ key: string; erwartet: string; ist: string | null }>
  /** utm-Schlüssel, die sowohl im Link als auch in den url_tags stehen (doppelte Zuordnung) */
  doppelt: string[]
  /** utm-Schlüssel, die nur im Link stehen (statisch, nicht je Anzeige) */
  nurImLink: string[]
}

function parseTagString(s: string | null | undefined): Map<string, string> {
  const m = new Map<string, string>()
  for (const part of String(s ?? '').replace(/^[?&]+/, '').split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    const k = (i >= 0 ? part.slice(0, i) : part).trim().toLowerCase()
    const v = i >= 0 ? part.slice(i + 1).trim() : ''
    if (k) m.set(k, v)
  }
  return m
}

/** Prüft url_tags einer Anzeige gegen URL_TAGS_STANDARD und den Ziel-Link (rein, ohne Netz). */
export function checkUrlTags(tags: string | null | undefined, link?: string | null): UrlTagsCheck {
  const std = parseTagString(URL_TAGS_STANDARD)
  const ist = parseTagString(tags)
  const abweichend: UrlTagsCheck['abweichend'] = []
  for (const [k, v] of std) {
    const cur = ist.get(k) ?? null
    if (cur === null || decodeURIComponent(cur) !== v) abweichend.push({ key: k, erwartet: v, ist: cur })
  }
  let linkTags = new Map<string, string>()
  if (link) {
    const q = String(link).split('#')[0].split('?')[1] ?? ''
    linkTags = parseTagString(q)
  }
  const doppelt: string[] = []
  const nurImLink: string[] = []
  for (const k of linkTags.keys()) {
    if (!k.startsWith('utm_')) continue
    if (ist.has(k)) doppelt.push(k)
    else nurImLink.push(k)
  }
  return { ok: abweichend.length === 0 && doppelt.length === 0, abweichend, doppelt, nurImLink }
}

// ── Wechselkurs + Budget-Leitplanke ──────────────────────────────────────────

export const USD_PER_EUR_FALLBACK = 1.14

export interface Wechselkurs { usdPerEur: number; quelle: 'insights_7d' | 'fallback' }

/** USD je EUR aus ad_insights_daily der letzten 7 Tage (spend / spend_eur), sonst 1,14. */
export async function wechselkurs(sb: SupabaseClient): Promise<Wechselkurs> {
  try {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
    const { data, error } = await sb.from('ad_insights_daily')
      .select('spend, spend_eur').gte('day', since).gt('spend', 0).limit(5000)
    if (error) throw new Error(String(error.message ?? error))
    let usd = 0, eur = 0
    for (const r of (data ?? []) as Array<{ spend: unknown; spend_eur: unknown }>) {
      const s = toNum(r.spend) ?? 0
      const e = toNum(r.spend_eur) ?? 0
      if (s > 0 && e > 0) { usd += s; eur += e }
    }
    const rate = eur > 1 ? usd / eur : NaN
    if (Number.isFinite(rate) && rate >= 0.9 && rate <= 1.6) return { usdPerEur: rate, quelle: 'insights_7d' }
  } catch (err) {
    console.warn('[metaGraph] Kurs aus ad_insights_daily nicht lesbar:', err instanceof Error ? err.message : String(err))
  }
  return { usdPerEur: USD_PER_EUR_FALLBACK, quelle: 'fallback' }
}

export interface BudgetEintrag {
  id: string
  level: 'campaign' | 'adset'
  name: string
  art: 'daily' | 'lifetime'
  /** USD-Cent je Tag (bei Laufzeitbudget: Restbudget / Resttage) */
  usdCents: number
  eur: number
}

export interface BudgetHeadroom {
  ok: boolean
  limitEur: number
  /** Summe der heute aktiven Tagesbudgets in EUR */
  activeEur: number
  /** Summe nach der geplanten Änderung in EUR */
  afterEur: number
  /** afterEur - activeEur */
  deltaEur: number
  usdPerEur: number
  rateEurPerUsd: number
  rateQuelle: 'insights_7d' | 'fallback'
  eintraege: BudgetEintrag[]
}

export interface BudgetDelta {
  /** neues Tagesbudget in USD-Cent, das dazukommt (bzw. das ersetzte Budget ersetzt) */
  addDailyUsdCents: number
  /** Kampagne/Anzeigengruppe, deren heutiger Beitrag durch addDailyUsdCents ersetzt wird */
  replaceEntityId?: string
  /** wie replaceEntityId, für mehrere Objekte (Gruppen-Änderung) */
  replaceEntityIds?: string[]
}

const centsOf = (v: unknown): number => {
  const n = toNum(v)
  return n !== null && n > 0 ? Math.round(n) : 0
}
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Leitplanke „Summe aktiver Tagesbudgets <= ad_settings.max_account_daily_budget“.
 * Liest live bei Meta alle ACTIVE-Kampagnen (Kampagnenbudget zählt einmal) und
 * ACTIVE-Anzeigengruppen mit eigenem Budget; Laufzeitbudgets als Restbudget je
 * Resttag. Wirft, wenn die Liste nicht vollständig gelesen werden kann (lieber
 * nichts tun als falsch rechnen).
 */
export async function budgetHeadroom(sb: SupabaseClient, delta: BudgetDelta): Promise<BudgetHeadroom> {
  const { data: st, error: stErr } = await sb.from('ad_settings')
    .select('max_account_daily_budget').eq('id', 'default').maybeSingle()
  if (stErr) throw new Error(`ad_settings lesen: ${String(stErr.message ?? stErr)}`)
  const limitEur = toNum((st as { max_account_daily_budget?: unknown } | null)?.max_account_daily_budget) ?? 250

  const kurs = await wechselkurs(sb)
  const { account } = metaEnv()
  const now = Date.now()
  const perDay = (remaining: number, endIso: unknown): number => {
    const end = typeof endIso === 'string' ? Date.parse(endIso) : NaN
    const days = Number.isFinite(end) ? Math.max(1, Math.ceil((end - now) / 86_400_000)) : 1
    return Math.round(remaining / days)
  }

  type Row = Record<string, unknown>
  const campaigns = await graphAll<Row>(`act_${account}/campaigns`, {
    fields: 'id,name,effective_status,daily_budget,lifetime_budget,budget_remaining,stop_time',
    effective_status: ['ACTIVE'], limit: 200,
  }, { strict: true })
  const adsets = await graphAll<Row>(`act_${account}/adsets`, {
    fields: 'id,name,campaign_id,effective_status,daily_budget,lifetime_budget,budget_remaining,end_time',
    effective_status: ['ACTIVE'], limit: 500,
  }, { strict: true })

  const eintraege: BudgetEintrag[] = []
  const cboCampaigns = new Set<string>()
  for (const c of campaigns) {
    if (String(c.effective_status ?? '') !== 'ACTIVE') continue
    const daily = centsOf(c.daily_budget)
    const lifetime = centsOf(c.lifetime_budget)
    if (!daily && !lifetime) continue
    cboCampaigns.add(String(c.id))
    const usdCents = daily || perDay(centsOf(c.budget_remaining), c.stop_time)
    eintraege.push({ id: String(c.id), level: 'campaign', name: String(c.name ?? ''), art: daily ? 'daily' : 'lifetime', usdCents, eur: usdCents / 100 / kurs.usdPerEur })
  }
  for (const a of adsets) {
    if (String(a.effective_status ?? '') !== 'ACTIVE') continue
    if (cboCampaigns.has(String(a.campaign_id ?? ''))) continue
    const daily = centsOf(a.daily_budget)
    const lifetime = centsOf(a.lifetime_budget)
    if (!daily && !lifetime) continue
    const usdCents = daily || perDay(centsOf(a.budget_remaining), a.end_time)
    eintraege.push({ id: String(a.id), level: 'adset', name: String(a.name ?? ''), art: daily ? 'daily' : 'lifetime', usdCents, eur: usdCents / 100 / kurs.usdPerEur })
  }

  const replaced = new Set<string>([
    ...(delta.replaceEntityId ? [digits(delta.replaceEntityId)] : []),
    ...(delta.replaceEntityIds ?? []).map(digits),
  ].filter(Boolean))
  const activeEur = eintraege.reduce((s, e) => s + e.eur, 0)
  const replacedEur = eintraege.filter(e => replaced.has(e.id)).reduce((s, e) => s + e.eur, 0)
  const addEur = Math.max(0, Number(delta.addDailyUsdCents) || 0) / 100 / kurs.usdPerEur
  const afterEur = activeEur - replacedEur + addEur

  return {
    ok: afterEur <= limitEur + 0.005,
    limitEur: round2(limitEur),
    activeEur: round2(activeEur),
    afterEur: round2(afterEur),
    deltaEur: round2(afterEur - activeEur),
    usdPerEur: kurs.usdPerEur,
    rateEurPerUsd: 1 / kurs.usdPerEur,
    rateQuelle: kurs.quelle,
    eintraege: eintraege.map(e => ({ ...e, eur: round2(e.eur) })),
  }
}
