// meta-builder: gemeinsame Bausteine (Kontext, Fehler, Schreib-Sperre, Entwurf
// laden, Meta-POST mit Protokoll, Hilfsfunktionen). Keine Modus-Logik hier.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { AdsCaller } from '../_shared/adsAuth.ts'
import {
  getLastUsage, graphPost, logMetaWrite, MetaApiError, metaEnv, metaErrorLogFelder, metaWritesDisabled,
  type BudgetHeadroom, type MetaEnv, type MetaUsage,
} from '../_shared/metaGraph.ts'
import {
  apiPathToFieldKey, HP_DEFAULT_LINK, HP_PAGE_ID, HP_PIXEL_ID,
  type AdDraft, type BuilderErrorCode, type BuilderMode, type BuilderSettings, type DraftSpec,
  type DraftValidation, type GuardrailInfo, type Level, type MediaRef, type MetaDraftRow,
  type MetaFieldIssue, type MetaMediaRow, type MetaUsageInfo,
} from '../_shared/metaSpec.ts'

export const FN = 'meta-builder'
export const BUCKET = 'ad-creatives'
/** Sperre gegen doppelte Anlege-Läufe */
export const LEASE_MS = 5 * 60_000
/** Prüfung (validate) darf beim Anlegen höchstens so alt sein */
export const VALIDATION_MAX_AGE_MS = 30 * 60_000

export const APP_DEV_MODE_HINT =
  'Die Meta-App „appy Property Analytics“ (ID 1645131469886027) steht noch im Entwicklungsmodus. ' +
  'Auf developers.facebook.com unter App-Einstellungen auf „Live“ schalten, dann klappt das Anlegen von Werbemitteln.'

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
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
export const nowIso = (): string => new Date().toISOString()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** Meta-Objekt-ID (nur Ziffern, 6-25 Stellen) oder BuilderError 400. */
export function metaId(v: unknown, label: string): string {
  const s = str(v).trim()
  if (!/^[0-9]{6,25}$/.test(s)) throw new BuilderError(400, 'invalid_request', `${label} fehlt oder ist keine gültige Meta-ID.`)
  return s
}

export function uuidParam(v: unknown, label: string): string {
  if (!isUuid(v)) throw new BuilderError(400, 'invalid_request', `${label} fehlt oder ist keine gültige ID.`)
  return v
}

/** JSON mit sortierten Schlüsseln (für Hashes, unabhängig von der jsonb-Reihenfolge). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(x => stableStringify(x === undefined ? null : x)).join(',')}]`
  const o = v as Raw
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  // Kopie: digest verlangt einen ArrayBuffer-gestützten View (kein SharedArrayBuffer)
  const buf = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export const hashSpec = (spec: unknown): Promise<string> => sha256Hex(stableStringify(spec ?? null))

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

export class BuilderError extends Error {
  status: number
  code: BuilderErrorCode | string
  hint?: string
  data?: unknown
  meta?: unknown
  constructor(status: number, code: BuilderErrorCode | string, message: string, hint?: string, data?: unknown, meta?: unknown) {
    super(message)
    this.name = 'BuilderError'
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
  permission: 'Dem Meta-Token fehlt eine Berechtigung (ads_management, pages_manage_ads, pages_show_list, leads_retrieval). Im Business Manager beim System-User prüfen.',
  transient: 'Meta war kurz nicht erreichbar. Bitte noch einmal versuchen.',
  validation: 'Meta lehnt einen Wert ab, siehe Meldung.',
  unknown: 'Unerwartete Antwort von Meta. Bitte erneut versuchen; bleibt der Fehler, die fbtrace_id an den Support geben.',
}

export function metaHint(err: MetaApiError): string {
  return META_HINT[err.kind] ?? META_HINT.unknown
}

/** MetaApiError -> BuilderError mit deutscher Meldung und Hinweis. */
export function fromMetaError(err: MetaApiError, prefix?: string): BuilderError {
  if (err.userMsg === 'META_WRITES_DISABLED') {
    return new BuilderError(503, 'writes_disabled', 'Schreibzugriffe an Meta sind gesperrt (Secret META_WRITES_DISABLED=1).',
      'Not-Aus aufheben: Secret META_WRITES_DISABLED entfernen oder auf 0 setzen.')
  }
  const text = err.userMsg || err.message
  const msg = prefix ? `${prefix}: ${text}` : text
  const status = err.kind === 'rate_limit' ? 429 : err.kind === 'dev_mode' ? 409 : 502
  const code = err.kind === 'dev_mode' ? 'app_dev_mode' : err.kind === 'rate_limit' ? 'rate_limited' : 'meta_error'
  return new BuilderError(status, code, msg, metaHint(err), undefined, err.detail())
}

export interface ErrorResponse { status: number; body: { error: string; hint?: string; code?: string; data?: unknown; meta?: unknown } }

export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof BuilderError) {
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

/** Meta-Fehler eines validate_only-/Anlege-Aufrufs -> Feldmeldungen (blame_field_specs). */
export function issuesFromError(level: Level, err: MetaApiError): MetaFieldIssue[] {
  const title = err.userTitle ?? 'Meta'
  const msg = err.userMsg || err.message
  const base: Omit<MetaFieldIssue, 'field_key'> = {
    title,
    user_msg: msg,
    ...(err.code !== null ? { code: err.code } : {}),
    ...(err.subcode !== null ? { subcode: err.subcode } : {}),
  }
  if (!err.blame.length) return [{ field_key: null, ...base }]
  return err.blame.map(b => ({ ...base, field_key: apiPathToFieldKey(level, b.field ?? null), user_msg: b.message || msg }))
}

// ── Kontext ──────────────────────────────────────────────────────────────────

export interface SettingsRow extends BuilderSettings {
  /** true, wenn ad_settings die Assistenten-Spalten noch nicht hat (Migration fehlt) */
  missing?: boolean
}

export interface Ctx {
  sb: SupabaseClient
  caller: AdsCaller
  env: MetaEnv
  mode: BuilderMode
  settings(): Promise<SettingsRow>
}

export function makeCtx(sb: SupabaseClient, caller: AdsCaller, mode: BuilderMode): Ctx {
  let cached: Promise<SettingsRow> | null = null
  return {
    sb, caller, mode,
    env: metaEnv(),
    settings() {
      if (!cached) cached = loadSettings(sb)
      return cached
    },
  }
}

const SETTINGS_COLS =
  'builder_enabled, dsa_beneficiary, dsa_payor, default_page_id, default_ig_user_id, default_pixel_id, default_link, max_account_daily_budget'

async function loadSettings(sb: SupabaseClient): Promise<SettingsRow> {
  const fallback: SettingsRow = {
    builder_enabled: false, dsa_beneficiary: null, dsa_payor: null, default_page_id: HP_PAGE_ID,
    default_ig_user_id: null, default_pixel_id: HP_PIXEL_ID, default_link: HP_DEFAULT_LINK,
    max_account_daily_budget: null, missing: true,
  }
  const { data, error } = await sb.from('ad_settings').select(SETTINGS_COLS).eq('id', 'default').maybeSingle()
  if (error) {
    console.warn('[meta-builder] ad_settings:', String(error.message ?? error).slice(0, 200))
    return fallback
  }
  const r = obj(data)
  const t = (v: unknown): string | null => (str(v).trim() ? str(v).trim() : null)
  return {
    builder_enabled: r.builder_enabled === true,
    dsa_beneficiary: t(r.dsa_beneficiary),
    dsa_payor: t(r.dsa_payor),
    default_page_id: t(r.default_page_id) ?? HP_PAGE_ID,
    default_ig_user_id: t(r.default_ig_user_id),
    default_pixel_id: t(r.default_pixel_id) ?? HP_PIXEL_ID,
    default_link: t(r.default_link) ?? HP_DEFAULT_LINK,
    max_account_daily_budget: num(r.max_account_daily_budget),
  }
}

/**
 * Schreib-Sperre für BUILDER_WRITE_MODES: META_WRITES_DISABLED, Schreibrecht
 * (admin/verwalter oder Recht „werbung“, System-Aufrufe erlaubt) und
 * ad_settings.builder_enabled. null = erlaubt.
 */
export async function writeGate(ctx: Ctx): Promise<BuilderError | null> {
  if (metaWritesDisabled()) {
    return new BuilderError(503, 'writes_disabled', 'Schreibzugriffe an Meta sind gesperrt (Secret META_WRITES_DISABLED=1).',
      'Not-Aus aufheben: Secret META_WRITES_DISABLED entfernen oder auf 0 setzen.')
  }
  const c = ctx.caller
  if (!c.system && c.role !== 'admin' && c.role !== 'verwalter') {
    const { data, error } = await ctx.sb.from('profiles').select('permissions').eq('id', c.userId).maybeSingle()
    const perms = obj(obj(data).permissions)
    if (error || perms.werbung !== true) {
      return new BuilderError(403, 'forbidden', 'Für Änderungen bei Meta brauchst du das Recht „Werbung“.',
        'Das Recht vergibt ein Admin in der Mitarbeiter-Verwaltung.')
    }
  }
  const st = await ctx.settings()
  if (st.missing) {
    return new BuilderError(503, 'builder_disabled', 'Der Kampagnen-Assistent ist noch nicht eingerichtet (Datenbank-Migration fehlt).',
      'Migration 20261003100000_werbung_fundament.sql einspielen.')
  }
  if (!st.builder_enabled) {
    return new BuilderError(403, 'builder_disabled', 'Der Kampagnen-Assistent ist ausgeschaltet. Anlegen, Hochladen und Aktivieren sind gesperrt.',
      'Einschalten kann nur ein Admin in den Werbe-Einstellungen (Kampagnen-Assistent).')
  }
  return null
}

// ── Meta-POST mit Protokoll ──────────────────────────────────────────────────

export interface PostOpts {
  level: string
  /** Ziel-Objekt (bei Änderungen) - bei Neuanlagen wird die neue ID protokolliert */
  entityId?: string | null
  draftId?: string | null
  validateOnly?: boolean
  syncReview?: boolean
  idempotent?: boolean
  timeoutMs?: number
  /** zusätzliche Felder fürs Protokoll (z. B. Lint-Übersteuerung) */
  logExtra?: Raw
  /** Vorher-Stand fürs Protokoll (Bearbeiten, Massenbearbeitung) */
  before?: unknown
}

export function actorFields(ctx: Ctx): { actor: string | null; actor_kind: 'user' | 'system' } {
  return { actor: ctx.caller.userId, actor_kind: ctx.caller.system ? 'system' : 'user' }
}

/** graphPost + Zeile in meta_write_log (Erfolg und Fehler, auch validate_only). */
export async function metaPost<T = Raw>(ctx: Ctx, path: string, body: Raw, o: PostOpts): Promise<T> {
  const base = {
    ...actorFields(ctx),
    fn: FN,
    mode: ctx.mode,
    entity_level: o.level,
    draft_id: o.draftId ?? null,
    method: 'POST',
    path,
    validate_only: o.validateOnly === true,
    request: o.logExtra ? { ...body, _hp: o.logExtra } : body,
    ...(o.before !== undefined ? { before: o.before } : {}),
  }
  try {
    const res = await graphPost<T>(path, body, {
      validateOnly: o.validateOnly, syncReview: o.syncReview, idempotent: o.idempotent, timeoutMs: o.timeoutMs,
    })
    const r = obj(res)
    await logMetaWrite(ctx.sb, {
      ...base, entity_id: o.entityId ?? (str(r.id) || null), ok: true, after: res, usage: getLastUsage(),
    })
    return res
  } catch (err) {
    await logMetaWrite(ctx.sb, { ...base, entity_id: o.entityId ?? null, ok: false, ...metaErrorLogFelder(err), usage: getLastUsage() })
    throw err
  }
}

/** Protokollzeile für Schreibzugriffe außerhalb von graphPost (Bild-Upload, Seiten-Token). */
export async function logWrite(ctx: Ctx, row: {
  level: string; path: string; entityId?: string | null; draftId?: string | null; request?: unknown; after?: unknown; err?: unknown
}): Promise<void> {
  await logMetaWrite(ctx.sb, {
    ...actorFields(ctx), fn: FN, mode: ctx.mode, entity_level: row.level, entity_id: row.entityId ?? null,
    draft_id: row.draftId ?? null, method: 'POST', path: row.path, validate_only: false,
    request: row.request ?? null, after: row.after ?? null, ok: row.err === undefined,
    ...(row.err !== undefined ? metaErrorLogFelder(row.err) : {}), usage: getLastUsage(),
  })
}

export function usageInfo(u: MetaUsage | null, verbose = false): MetaUsageInfo {
  if (!u || !u.present) return { accUtilPct: null, resetSec: null, tier: u?.tier ?? null }
  return { accUtilPct: u.accUtilPct, resetSec: u.resetSec, tier: u.tier, ...(verbose ? { buc: u.buc } : {}) }
}

export function guardrailInfo(h: BudgetHeadroom): GuardrailInfo {
  return { limitEur: h.limitEur, activeEur: h.activeEur, afterEur: h.afterEur, rateEurPerUsd: h.rateEurPerUsd, ok: h.ok }
}

// ── Entwürfe ─────────────────────────────────────────────────────────────────

export type DraftRow = MetaDraftRow & { run_lease: string | null; run_lease_at: string | null }
/** meta_drafts.validation mit Spec-Fingerabdruck (für „Prüfung veraltet“). */
export type StoredValidation = DraftValidation & { spec_hash?: string; graph_version?: string }

export async function loadDraft(ctx: Ctx, idParam: unknown): Promise<DraftRow> {
  const id = uuidParam(idParam, 'draft_id')
  const { data, error } = await ctx.sb.from('meta_drafts').select('*').eq('id', id).maybeSingle()
  if (error) throw new BuilderError(500, 'internal', `Entwurf konnte nicht gelesen werden: ${String(error.message ?? error).slice(0, 200)}`)
  if (!data) throw new BuilderError(404, 'not_found', 'Entwurf nicht gefunden.')
  const row = data as DraftRow
  row.meta_ids = (row.meta_ids && typeof row.meta_ids === 'object') ? row.meta_ids : {}
  return row
}

export function leaseActive(d: { run_lease: string | null; run_lease_at: string | null }): boolean {
  if (!d.run_lease || !d.run_lease_at) return false
  const at = Date.parse(d.run_lease_at)
  return Number.isFinite(at) && Date.now() - at < LEASE_MS
}

/** DraftSpec aus der DB-Zeile, mit leeren Listen statt undefined. */
export function specOf(d: DraftRow): DraftSpec {
  const s = clone(obj(d.spec)) as unknown as DraftSpec
  if (!s.campaign || typeof s.campaign !== 'object') {
    throw new BuilderError(422, 'validation_failed', 'Der Entwurf hat noch keine Kampagne.', 'Im Assistenten zuerst die Kampagnen-Ebene ausfüllen.')
  }
  s.v = 1
  s.adsets = Array.isArray(s.adsets) ? s.adsets : []
  s.ads = Array.isArray(s.ads) ? s.ads : []
  return s
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
  if (p.error) console.warn('[meta-builder] crm_projects:', String(p.error.message ?? p.error).slice(0, 200))
  for (const r of arr<Raw>(p.data)) { add(r.name); add(r.developer) }
  const d = await sb.from('crm_developers').select('name').limit(2000)
  if (d.error) console.warn('[meta-builder] crm_developers:', String(d.error.message ?? d.error).slice(0, 200))
  for (const r of arr<Raw>(d.data)) add(r.name)
  return out
}

// ── Medien-Referenzen ────────────────────────────────────────────────────────

/**
 * Alle Medien einer Anzeige (Plätze, Karten) plus eigene Video-Vorschaubilder
 * (thumbnail_media_id als eigene Bild-Referenz, damit sie geladen und hochgeladen werden).
 * Vorhandener Beitrag: keine Medien.
 */
export function adMediaRefs(ad: AdDraft): MediaRef[] {
  if (ad.beitrag) return []
  const m = ad.media ?? {}
  const out: MediaRef[] = []
  const add = (r: MediaRef | undefined) => {
    if (!r || !r.media_id) return
    out.push(r)
    if (r.thumbnail_media_id && isUuid(r.thumbnail_media_id)) out.push({ media_id: r.thumbnail_media_id })
  }
  for (const r of [m.feed_4x5, m.story_9x16, m.square_1x1, m.landscape_191x1]) add(r)
  for (const cd of m.cards ?? []) add(cd?.media)
  return out
}

/** Video-Referenz mit eigenem Vorschaubild (hochgeladenes Bild oder bewusst gewählter Meta-Vorschlag)? */
export const hatEigenesVorschaubild = (r: MediaRef | undefined): boolean =>
  !!r && ((!!r.thumbnail_media_id && isUuid(r.thumbnail_media_id)) || (r.thumbnail_quelle === 'meta_liste' && !!r.thumbnail_hash))

/**
 * Medien-IDs, deren Video in ALLEN Verwendungen dieser Anzeigen ein eigenes Vorschaubild hat:
 * dafür muss Metas Standard-Vorschaubild nicht abgewartet werden.
 */
export function eigeneVorschaubilder(ads: AdDraft[]): Set<string> {
  const ja = new Set<string>(), nein = new Set<string>()
  for (const ad of ads) {
    if (ad.beitrag) continue
    const m = ad.media ?? {}
    for (const r of [m.feed_4x5, m.story_9x16, m.square_1x1, m.landscape_191x1, ...(m.cards ?? []).map(cd => cd?.media)]) {
      if (!r || !r.media_id) continue
      if (hatEigenesVorschaubild(r)) ja.add(r.media_id)
      else nein.add(r.media_id)
    }
  }
  nein.forEach(id => ja.delete(id))
  return ja
}

export async function loadMediaRows(sb: SupabaseClient, ids: string[]): Promise<Record<string, MetaMediaRow>> {
  const list = uniq(ids.filter(isUuid))
  if (!list.length) return {}
  const { data, error } = await sb.from('meta_media').select('*').in('id', list)
  if (error) throw new BuilderError(500, 'internal', `Medien konnten nicht gelesen werden: ${String(error.message ?? error).slice(0, 200)}`)
  const out: Record<string, MetaMediaRow> = {}
  for (const r of arr<MetaMediaRow>(data)) out[r.id] = r
  return out
}

export interface MediaIds { image_hash?: string; video_id?: string; thumbnail_hash?: string }

/**
 * Trägt Hash/Video-ID in eine Medien-Referenz ein (meta_media bzw. meta_ids.media gewinnen).
 * Video-Vorschaubild: eigenes Bild (thumbnail_media_id) vor bewusst gewähltem Meta-Vorschlag
 * (thumbnail_quelle 'meta_liste', Hash bleibt) vor Metas Standardbild aus meta_media.
 */
export function fillRef(ref: MediaRef, rows: Record<string, MetaMediaRow>, extra: Record<string, MediaIds> = {}): MediaRef {
  const out: MediaRef = { ...ref }
  const row = rows[ref.media_id]
  const ex = extra[ref.media_id]
  const img = row?.meta_image_hash || ex?.image_hash
  const vid = row?.meta_video_id || ex?.video_id
  const thumb = row?.thumbnail_hash || ex?.thumbnail_hash
  if (img) out.image_hash = img
  if (vid) out.video_id = vid
  const eigenes = ref.thumbnail_media_id ? (rows[ref.thumbnail_media_id]?.meta_image_hash || extra[ref.thumbnail_media_id]?.image_hash) : undefined
  if (eigenes) out.thumbnail_hash = eigenes
  else if (ref.thumbnail_quelle === 'meta_liste' && ref.thumbnail_hash) out.thumbnail_hash = ref.thumbnail_hash
  else if (thumb) out.thumbnail_hash = thumb
  return out
}

export function fillAdMedia(ad: AdDraft, rows: Record<string, MetaMediaRow>, extra: Record<string, MediaIds> = {}): AdDraft {
  const a = clone(ad)
  const m = a.media ?? {}
  if (m.feed_4x5?.media_id) m.feed_4x5 = fillRef(m.feed_4x5, rows, extra)
  if (m.story_9x16?.media_id) m.story_9x16 = fillRef(m.story_9x16, rows, extra)
  if (m.square_1x1?.media_id) m.square_1x1 = fillRef(m.square_1x1, rows, extra)
  if (m.landscape_191x1?.media_id) m.landscape_191x1 = fillRef(m.landscape_191x1, rows, extra)
  if (m.cards) m.cards = m.cards.map(cd => (cd?.media?.media_id ? { ...cd, media: fillRef(cd.media, rows, extra) } : cd))
  a.media = m
  return a
}

export function publicUrl(path: string): string {
  const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')
  return `${base}/storage/v1/object/public/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`
}
