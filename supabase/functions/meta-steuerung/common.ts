// meta-steuerung: gemeinsame Bausteine (Kontext, Fehler, Schreib-Sperre, Geld,
// Meta-POST mit Protokoll, Objekte des Werbekontos lesen). Keine Modus-Logik.
//
// Bewusst eigenständig (keine Imports aus meta-builder/ oder meta-werkzeuge/): die
// Function wird getrennt deployt und darf nicht brechen, wenn andere umgebaut werden.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { AdsCaller } from '../_shared/adsAuth.ts'
import {
  getLastUsage, graphAll, graphGet, graphPost, logMetaWrite, MetaApiError, metaEnv, metaErrorLogFelder,
  metaWritesDisabled, wechselkurs, type MetaEnv, type MetaUsage,
} from '../_shared/metaGraph.ts'
import type { SteuerungEbene, SteuerungErrorCode, SteuerungGeld, SteuerungMode, SteuerungUsage } from './typen.ts'

export const FN = 'meta-steuerung'
/** Business-Manager von Happy Property (Ad Studies hängen am Business, nicht am Werbekonto) */
export const HP_BUSINESS_ID = '877580267476541'
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
export const uniq = <T>(list: T[]): T[] => list.filter((x, i) => list.indexOf(x) === i)
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Gedankenstriche (U+2012 bis U+2015) durch Bindestrich ersetzen, Leerraum zusammenfassen, kürzen */
export function cleanText(v: unknown, max: number): string {
  return str(v).replace(/[\u2012-\u2015]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Unix-Sekunden oder ISO-String -> ISO-String (oder null) */
export function isoZeit(v: unknown): string | null {
  const n = num(v)
  if (n !== null && n > 1_000_000_000 && n < 10_000_000_000) return new Date(n * 1000).toISOString()
  const s = str(v)
  if (!s) return null
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** Meta-Objekt-ID (nur Ziffern, 6-25 Stellen) oder SteuerungError 400. */
export function metaId(v: unknown, label: string): string {
  const s = str(v).trim()
  if (!/^[0-9]{6,25}$/.test(s)) throw new SteuerungError(400, 'invalid_request', `${label} fehlt oder ist keine gültige Meta-ID.`)
  return s
}

/** Liste von Meta-IDs (bereinigt, ohne Dubletten) oder SteuerungError 400. */
export function metaIds(v: unknown, label: string, max: number): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new SteuerungError(400, 'invalid_request', `${label}: bitte eine Liste von Meta-IDs.`)
  const out = uniq(v.map(x => metaId(x, label)))
  if (out.length > max) throw new SteuerungError(400, 'invalid_request', `${label}: höchstens ${max} IDs.`)
  return out
}

export const softMsg = (e: unknown): string =>
  e instanceof MetaApiError ? (e.userMsg || e.message).slice(0, 200) : errText(e).slice(0, 200)

export const auslastungHoch = (): boolean => (getLastUsage()?.accUtilPct ?? 0) > USAGE_STOPP_PCT

export function usageInfo(u: MetaUsage | null = getLastUsage()): SteuerungUsage {
  if (!u || !u.present) return { accUtilPct: null, resetSec: null, tier: u?.tier ?? null }
  return { accUtilPct: u.accUtilPct, resetSec: u.resetSec, tier: u.tier }
}

const EUR_FMT = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const ZAHL_FMT = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 })
export const eurText = (eur: number): string => `${EUR_FMT.format(eur)} €`
export const zahlText = (n: number): string => ZAHL_FMT.format(n)

// ── Fehler ───────────────────────────────────────────────────────────────────

export class SteuerungError extends Error {
  status: number
  code: SteuerungErrorCode | string
  hint?: string
  data?: unknown
  meta?: unknown
  constructor(status: number, code: SteuerungErrorCode | string, message: string, hint?: string, data?: unknown, meta?: unknown) {
    super(message)
    this.name = 'SteuerungError'
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
  permission: 'Dem Meta-Token fehlt eine Berechtigung (ads_management, ads_read, business_management) oder der System-User ist dem Business bzw. Werbekonto nicht zugewiesen.',
  transient: 'Meta war kurz nicht erreichbar. Bitte noch einmal versuchen.',
  validation: 'Meta lehnt einen Wert ab, siehe Meldung.',
  unknown: 'Unerwartete Antwort von Meta. Bitte erneut versuchen; bleibt der Fehler, die fbtrace_id an den Support geben.',
}

/** MetaApiError -> SteuerungError mit deutscher Meldung und Hinweis. */
export function fromMetaError(err: MetaApiError, prefix?: string): SteuerungError {
  if (err.userMsg === 'META_WRITES_DISABLED') {
    return new SteuerungError(503, 'writes_disabled', 'Schreibzugriffe an Meta sind gesperrt (Secret META_WRITES_DISABLED=1).',
      'Not-Aus aufheben: Secret META_WRITES_DISABLED entfernen oder auf 0 setzen.')
  }
  // Ad Rules: „Rules that turn off ads can't have cost conditions“ (Referenz ad-rule, Fehler 2703)
  if (err.code === 2703) {
    return new SteuerungError(422, 'meta_error',
      'Meta erlaubt bei Regeln, die etwas ausschalten, keine Kosten-Bedingung (z. B. Kosten pro Lead, CPC, CPM).',
      'Kosten-Bedingung durch Ausgaben plus Ergebnisse ersetzen oder die Aktion „Nur Benachrichtigung senden“ wählen.',
      undefined, err.detail())
  }
  const text = err.userMsg || err.message
  const msg = prefix ? `${prefix}: ${text}` : text
  const status = err.kind === 'rate_limit' ? 429 : err.kind === 'dev_mode' ? 409 : 502
  const code = err.kind === 'dev_mode' ? 'app_dev_mode' : err.kind === 'rate_limit' ? 'rate_limited' : 'meta_error'
  return new SteuerungError(status, code, msg, META_HINT[err.kind] ?? META_HINT.unknown, undefined, err.detail())
}

export interface ErrorResponse { status: number; body: { error: string; hint?: string; code?: string; data?: unknown; meta?: unknown } }

export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof SteuerungError) {
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
  /** Leitplanke: Summe aktiver Tagesbudgets in EUR */
  max_account_daily_budget: number
  /** Ziel-Kosten pro Termin-Äquivalent (Autopilot) */
  target_cpte_eur: number
  /** true, wenn ad_settings die Assistenten-Spalten noch nicht hat (Migration fehlt) */
  missing: boolean
}

export interface Ctx {
  sb: SupabaseClient
  caller: AdsCaller
  env: MetaEnv
  mode: SteuerungMode
  businessId: string
  settings(): Promise<Settings>
  /** Kontowährung + Kurs (einmal je Aufruf) */
  geld(): Promise<SteuerungGeld>
  /** Zeitzone des Werbekontos (IANA, z. B. Europe/Berlin); nicht lesbar = UTC */
  zeitzone(): Promise<string>
}

export function businessId(): string {
  const raw = String(Deno.env.get('META_BUSINESS_ID') ?? '').replace(/[^0-9]/g, '')
  return raw.length >= 6 ? raw : HP_BUSINESS_ID
}

export function makeCtx(sb: SupabaseClient, caller: AdsCaller, mode: SteuerungMode): Ctx {
  let st: Promise<Settings> | null = null
  let g: Promise<SteuerungGeld> | null = null
  let k: Promise<KontoKopf> | null = null
  const env = metaEnv()
  const konto = () => {
    if (!k) k = loadKontoKopf(env.account)
    return k
  }
  return {
    sb, caller, mode, env,
    businessId: businessId(),
    settings() {
      if (!st) st = loadSettings(sb)
      return st
    },
    geld() {
      if (!g) g = konto().then(kk => loadGeld(sb, kk.waehrung))
      return g
    },
    async zeitzone() {
      return (await konto()).zeitzone
    },
  }
}

interface KontoKopf { waehrung: string; zeitzone: string }

/** Währung + Zeitzone des Werbekontos (ein Aufruf); nicht lesbar = USD bzw. UTC */
async function loadKontoKopf(account: string): Promise<KontoKopf> {
  let waehrung = 'USD'
  let zeitzone = 'UTC'
  try {
    const a = await graphGet<Raw>(`act_${account}`, { fields: 'currency,timezone_name' })
    waehrung = str(a.currency).toUpperCase() || 'USD'
    const tz = str(a.timezone_name)
    if (tz && gueltigeZeitzone(tz)) zeitzone = tz
  } catch (e) {
    console.warn(`[${FN}] Kontowährung/Zeitzone nicht lesbar, nehme USD/UTC:`, softMsg(e))
  }
  return { waehrung, zeitzone }
}

function gueltigeZeitzone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Kalenderdatum (YYYY-MM-DD) eines Zeitpunkts in der Zeitzone des Werbekontos */
export function kontoDatum(ms: number, zeitzone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zeitzone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

async function loadSettings(sb: SupabaseClient): Promise<Settings> {
  const fallback: Settings = { builder_enabled: false, max_account_daily_budget: 250, target_cpte_eur: 145, missing: true }
  const { data, error } = await sb.from('ad_settings')
    .select('builder_enabled, max_account_daily_budget, target_cpte_eur').eq('id', 'default').maybeSingle()
  if (error) {
    console.warn(`[${FN}] ad_settings:`, String(error.message ?? error).slice(0, 200))
    return fallback
  }
  const r = obj(data)
  const pos = (v: unknown, d: number) => { const n = num(v); return n !== null && n > 0 ? n : d }
  return {
    builder_enabled: r.builder_enabled === true,
    max_account_daily_budget: pos(r.max_account_daily_budget, 250),
    target_cpte_eur: pos(r.target_cpte_eur, 145),
    missing: false,
  }
}

async function loadGeld(sb: SupabaseClient, waehrung: string): Promise<SteuerungGeld> {
  if (waehrung === 'EUR') return { waehrung, konto_pro_eur: 1, kurs_quelle: 'eur_konto' }
  if (waehrung !== 'USD') {
    throw new SteuerungError(409, 'unsupported', `Das Werbekonto rechnet in ${waehrung}; die Umrechnung kennt nur USD und EUR.`)
  }
  const k = await wechselkurs(sb)
  return { waehrung, konto_pro_eur: k.usdPerEur, kurs_quelle: k.quelle }
}

/** EUR -> Cent der Kontowährung (ganzzahlig) */
export const eurZuKontoCent = (eur: number, g: SteuerungGeld): number => Math.round(eur * g.konto_pro_eur * 100)
/** Cent der Kontowährung -> EUR */
export const kontoCentZuEur = (cent: number, g: SteuerungGeld): number => cent / 100 / g.konto_pro_eur
/** Kontowährung (Einheiten, z. B. Insights-spend) -> EUR */
export const kontoZuEur = (betrag: number, g: SteuerungGeld): number => betrag / g.konto_pro_eur

export const istAdmin = (ctx: Ctx): boolean => ctx.caller.system || ctx.caller.role === 'admin'

/** Recht „Werbung“ zum Ändern (admin/verwalter oder permissions.werbung). null = erlaubt. */
export async function schreibRecht(ctx: Ctx): Promise<SteuerungError | null> {
  const c = ctx.caller
  if (c.system || c.role === 'admin' || c.role === 'verwalter') return null
  const { data, error } = await ctx.sb.from('profiles').select('permissions').eq('id', c.userId).maybeSingle()
  const perms = obj(obj(data).permissions)
  if (error || perms.werbung !== true) {
    return new SteuerungError(403, 'forbidden', 'Für Änderungen bei Meta brauchst du das Recht „Werbung“.',
      'Das Recht vergibt ein Admin in der Mitarbeiter-Verwaltung.')
  }
  return null
}

/** Schreib-Sperre wie meta-builder: META_WRITES_DISABLED, Schreibrecht, ad_settings.builder_enabled. null = erlaubt. */
export async function writeGate(ctx: Ctx): Promise<SteuerungError | null> {
  if (metaWritesDisabled()) {
    return new SteuerungError(503, 'writes_disabled', 'Schreibzugriffe an Meta sind gesperrt (Secret META_WRITES_DISABLED=1).',
      'Not-Aus aufheben: Secret META_WRITES_DISABLED entfernen oder auf 0 setzen.')
  }
  const recht = await schreibRecht(ctx)
  if (recht) return recht
  const st = await ctx.settings()
  if (st.missing) {
    return new SteuerungError(503, 'builder_disabled', 'Der Werbemanager ist noch nicht eingerichtet (Datenbank-Migration fehlt).',
      'Migration 20261003100000_werbung_fundament.sql einspielen.')
  }
  if (!st.builder_enabled) {
    return new SteuerungError(403, 'builder_disabled', 'Änderungen bei Meta sind ausgeschaltet (Kampagnen-Assistent aus).',
      'Einschalten kann nur ein Admin in den Werbe-Einstellungen (Kampagnen-Assistent).')
  }
  return null
}

export function adminNoetig(was: string): SteuerungError {
  return new SteuerungError(403, 'admin_required', `${was} darf nur ein Admin.`,
    'Regeln, die Ausgaben erhöhen können, gibt Sven frei. Ausschalten und Senken darf jeder mit dem Recht „Werbung“.')
}

// ── Meta-POST mit Protokoll ──────────────────────────────────────────────────

export function actorFields(ctx: Ctx): { actor: string | null; actor_kind: 'user' | 'system' } {
  return { actor: ctx.caller.userId, actor_kind: ctx.caller.system ? 'system' : 'user' }
}

export interface PostOpts {
  level: string
  /** Ziel-Objekt bei Änderungen; bei Neuanlagen wird die neue ID protokolliert */
  entityId?: string | null
  before?: unknown
  /** true nur für gefahrlos wiederholbare Aufrufe (Status setzen) */
  idempotent?: boolean
}

/** graphPost + Zeile in meta_write_log (Erfolg und Fehler). Neuanlagen nie wiederholt. */
export async function metaPost(ctx: Ctx, path: string, body: Raw, o: PostOpts): Promise<Raw> {
  const base = {
    ...actorFields(ctx), fn: FN, mode: ctx.mode, entity_level: o.level, method: 'POST', path,
    validate_only: false, request: body, before: o.before ?? null,
  }
  try {
    const res = obj(await graphPost<Raw>(path, body, { idempotent: o.idempotent === true }))
    await logMetaWrite(ctx.sb, { ...base, entity_id: o.entityId ?? (str(res.id) || null), ok: true, after: res, usage: getLastUsage() })
    return res
  } catch (err) {
    await logMetaWrite(ctx.sb, { ...base, entity_id: o.entityId ?? null, ok: false, ...metaErrorLogFelder(err), usage: getLastUsage() })
    throw err
  }
}

// ── Objekte des Werbekontos ──────────────────────────────────────────────────

export interface KontoObjekt {
  id: string
  ebene: SteuerungEbene
  name: string | null
  status: string | null
  campaign_id: string | null
  adset_id: string | null
  /** Cent der Kontowährung */
  daily_budget: number | null
  lifetime_budget: number | null
  /** Restbudget bei Laufzeitbudget (Cent der Kontowährung) */
  budget_remaining: number | null
  /** Ende (Kampagne stop_time, Anzeigengruppe end_time), ISO */
  ende: string | null
  optimization_goal: string | null
  special_ad_categories: string[]
}

const EDGE: Record<SteuerungEbene, string> = { campaign: 'campaigns', adset: 'adsets', ad: 'ads' }
const FELDER: Record<SteuerungEbene, string> = {
  campaign: 'id,name,effective_status,daily_budget,lifetime_budget,budget_remaining,stop_time,special_ad_categories',
  adset: 'id,name,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,end_time,optimization_goal',
  ad: 'id,name,effective_status,campaign_id,adset_id',
}

function kontoObjekt(r: Raw, ebene: SteuerungEbene): KontoObjekt {
  const id = str(r.id)
  return {
    id, ebene,
    name: str(r.name) || null,
    status: str(r.effective_status) || null,
    campaign_id: ebene === 'campaign' ? id : (str(r.campaign_id) || null),
    adset_id: ebene === 'ad' ? (str(r.adset_id) || null) : ebene === 'adset' ? id : null,
    daily_budget: num(r.daily_budget),
    lifetime_budget: num(r.lifetime_budget),
    budget_remaining: num(r.budget_remaining),
    ende: isoZeit(ebene === 'campaign' ? r.stop_time : r.end_time),
    optimization_goal: str(r.optimization_goal) || null,
    special_ad_categories: arr<unknown>(r.special_ad_categories).map(str).filter(Boolean),
  }
}

/**
 * Tagesbeitrag eines Objekts in Cent der Kontowährung (wie budgetHeadroom): Tagesbudget,
 * sonst Laufzeitbudget als Restbudget je verbleibendem Tag (ohne Ende: alles an einem Tag).
 */
export function tagesCent(o: Pick<KontoObjekt, 'daily_budget' | 'lifetime_budget' | 'budget_remaining' | 'ende'>, jetzt = Date.now()): number {
  if (o.daily_budget !== null && o.daily_budget > 0) return Math.round(o.daily_budget)
  if (o.lifetime_budget !== null && o.lifetime_budget > 0) {
    const rest = o.budget_remaining !== null && o.budget_remaining >= 0 ? o.budget_remaining : o.lifetime_budget
    const ende = Date.parse(o.ende ?? '')
    const tage = Number.isFinite(ende) ? Math.max(1, Math.ceil((ende - jetzt) / 86_400_000)) : 1
    return Math.round(rest / tage)
  }
  return 0
}

/**
 * Liest Objekte einer Ebene aus dem Werbekonto (ein Aufruf, filtering <ebene>.id IN).
 * Was nicht zurückkommt, gehört nicht zum Konto oder existiert nicht.
 */
export async function kontoObjekte(ctx: Ctx, ebene: SteuerungEbene, ids: string[]): Promise<Map<string, KontoObjekt>> {
  const m = new Map<string, KontoObjekt>()
  if (!ids.length) return m
  const list = await graphAll<Raw>(`act_${ctx.env.account}/${EDGE[ebene]}`, {
    fields: FELDER[ebene],
    filtering: [{ field: `${ebene}.id`, operator: 'IN', value: ids }],
    limit: 100,
  }, { maxPages: 2, strict: true })
  for (const r of list) {
    const id = str(r.id)
    if (!id || ids.indexOf(id) < 0) continue
    m.set(id, kontoObjekt(r, ebene))
  }
  return m
}

/**
 * Alle Anzeigengruppen der Kampagnen (ein Aufruf, filtering campaign.id IN, vollständig
 * oder Fehler). Für die Leitplanke bei Kampagnen ohne Kampagnenbudget.
 */
export async function gruppenDerKampagnen(ctx: Ctx, kampagnenIds: string[]): Promise<KontoObjekt[]> {
  if (!kampagnenIds.length) return []
  const list = await graphAll<Raw>(`act_${ctx.env.account}/adsets`, {
    fields: FELDER.adset,
    filtering: [{ field: 'campaign.id', operator: 'IN', value: kampagnenIds }],
    limit: 200,
  }, { maxPages: 5, strict: true })
  return list
    .filter(r => str(r.id) && kampagnenIds.indexOf(str(r.campaign_id)) >= 0)
    .map(r => kontoObjekt(r, 'adset'))
}

/** Prüft, dass alle IDs zum Werbekonto gehören; sonst 403 mit Liste. */
export async function pruefeKontoObjekte(ctx: Ctx, ebene: SteuerungEbene, ids: string[], label: string): Promise<Map<string, KontoObjekt>> {
  const m = await kontoObjekte(ctx, ebene, ids)
  const fehlt = ids.filter(id => !m.has(id))
  if (fehlt.length) {
    throw new SteuerungError(403, 'forbidden', `${label}: ${fehlt.length} ID(s) gehören nicht zum Werbekonto oder existieren nicht.`,
      `Nicht gefunden: ${fehlt.slice(0, 10).join(', ')}`, { fehlt })
  }
  return m
}

/** Namen aus dem Spiegel (meta_campaigns, meta_adsets, ad_catalog). Seriell, nur Komfort. */
export async function spiegelNamen(sb: SupabaseClient, ids: string[]): Promise<Map<string, { name: string; ebene: SteuerungEbene }>> {
  const m = new Map<string, { name: string; ebene: SteuerungEbene }>()
  const quellen: Array<[string, string, string, SteuerungEbene]> = [
    ['meta_campaigns', 'campaign_id', 'name', 'campaign'],
    ['meta_adsets', 'adset_id', 'name', 'adset'],
    ['ad_catalog', 'ad_id', 'ad_name', 'ad'],
  ]
  for (const [tabelle, idSpalte, nameSpalte, ebene] of quellen) {
    const rest = uniq(ids.filter(id => id && !m.has(id))).slice(0, 300)
    if (!rest.length) break
    try {
      const { data, error } = await sb.from(tabelle).select(`${idSpalte}, ${nameSpalte}`).in(idSpalte, rest).limit(300)
      if (error) {
        console.warn(`[${FN}] Spiegel ${tabelle}:`, String(error.message ?? error).slice(0, 200))
        continue
      }
      for (const r of arr<Raw>(data)) {
        const id = str(r[idSpalte])
        const name = str(r[nameSpalte])
        if (id && name) m.set(id, { name, ebene })
      }
    } catch (err) {
      console.warn(`[${FN}] Spiegel ${tabelle}:`, errText(err).slice(0, 200))
    }
  }
  return m
}

/** IDs, die diese Function erfolgreich angelegt hat (meta_write_log), z. B. für „im CRM angelegt“. */
export async function eigeneAnlagen(sb: SupabaseClient, mode: SteuerungMode): Promise<Set<string>> {
  const s = new Set<string>()
  try {
    const { data, error } = await sb.from('meta_write_log').select('entity_id')
      .eq('fn', FN).eq('mode', mode).eq('ok', true).limit(1000)
    if (error) {
      console.warn(`[${FN}] meta_write_log:`, String(error.message ?? error).slice(0, 200))
      return s
    }
    for (const r of arr<Raw>(data)) { const id = str(r.entity_id); if (id) s.add(id) }
  } catch (err) {
    console.warn(`[${FN}] meta_write_log:`, errText(err).slice(0, 200))
  }
  return s
}
