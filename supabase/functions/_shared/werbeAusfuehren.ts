// Gemeinsamer Ausführer für die Aktions-Warteschlange ad_actions (Meta-Schreibzugriffe).
//
// WARUM DIESE DATEI EXISTIERT:
// Bis Oktober 2026 führte nur meta-ads-sync (Schritt 2) bestätigte Pause/Aktivieren-
// Zeilen aus, ohne Vorher-Zustand, Leitplanken, Rücklesen oder Log. Der Autopilot
// braucht genau EINEN Ausführer mit diesen Sicherungen; werbe-ausfuehren
// (Freigabe-Klick, Änderungsfenster, Validieren) und meta-ads-sync (manuelle
// Zeilen, Modus 'manuell') rufen beide ausfuehren() auf.
//
// API:
//   ausfuehren(sb, { modus, ids?, gruppeId?, validateOnly?, akteur?, laufId?, fn? })
//     -> { ausgefuehrt, fehlgeschlagen, uebersprungen: [{id, grund}], gestoppt?, abgebrochen?, validiert? }
//     modus 'manuell'  : origin manuell (oder leer), status 'bestätigt' - verhält sich exakt wie der
//                        bisherige Ausführer in meta-ads-sync (nur pause/activate, Katalog-Kontoprüfung,
//                        'Status → X', Spiegel in ad_catalog; Fehler -> 'fehlgeschlagen'); zusätzlich Log.
//     modus 'freigabe' : origin autopilot, status 'bestätigt', nur mit gruppeId oder ids (Ein-Klick).
//     modus 'fenster'  : alle bestätigten Autopilot-Zeilen (Lauf im Änderungsfenster).
//     validateOnly     : prüft Zeilen (auch noch nicht freigegebene) inkl. Leitplanken und
//                        execution_options validate_only bei Meta; ändert keinen Status.
//   autopilotStoppen(sb, grund, { laufId?, akteur? })  Modus ein_klick/autonom -> vorschlag,
//                        autopilot_stop_grund, Log 'stopp', offene autonome Zeilen -> abgelehnt.
//                        Die Mail an Sven verschickt der Aufrufer (Ergebnis.gestoppt gesetzt).
//   preStateHash({ status, effective_status, daily_budget | daily_budget_cents, updated_time })
//                        sha256 über normalisierte Werte; werbe-autopilot MUSS diese Funktion für
//                        ad_actions.pre_state_hash benutzen (Snapshot- und Live-Werte ergeben dasselbe).
//   berlinTag(date)      { datum 'YYYY-MM-DD', isoDow 1..7 } in Europe/Berlin
//
// Ablauf je Autopilot-Gruppe (gruppe_id, sonst Einzelzeile), PLAN-B §3:
//   1 Not-Aus, Modus, autopilot_paused_until (freigabe 'autonom' nur im Modus autonom, sonst
//     abgelehnt mit freigabe 'abgelaufen', result 'Modus gesenkt'; 'freigegeben' in
//     vorschlag/ein_klick/autonom)    2 Claim per RPC werbe_aktionen_claimen(p_ids)
//   3 Ablauf (expires_at) -> abgelehnt/abgelaufen    4 Live-Zustand + Konto + pre_state_hash -> veraltet
//   5 Leitplanken (Fenster, Budget, Summe, Monat, Plan-B-Symmetrie, Lernschutz, Takt, Tageslimit)
//   6 graphPost    7 Rücklesen + Vergleich    8 Spiegel + Log    9 Gruppe teilweise fehlgeschlagen ->
//   vorherige Mitglieder zurücksetzen + Stopp    10 Rate-Limit -> Claim lösen, 'bestätigt' lassen, Abbruch.
//
// Payload-Vertrag (vom Regel-Motor geschrieben):
//   budget_set: payload.daily_budget_cents (Ziel, USD-Cent, ganzzahlig), entity_level adset|campaign
//   payload.nur_im_fenster === true: Zeile nur an Tagen aus ad_settings.change_window_dows
//   activate, ersatz_aktivieren, budget_set laufen IMMER nur im Änderungsfenster.
//   ersatz_aktivieren: payload.pool_id (+ ersetzt_kennung); nach Erfolg Vorrat -> aktiv,
//     aktiv_seit, ersetzt_kennung (Grundlage für R1b).
//   ersatz_hochladen (payload.pool_id, payload.adset_id): eigene Gruppe. Nach Claim, Ablauf,
//     Fenster und Modus-Prüfung gibt der Ausführer die Gruppe in Ergebnis.delegiert zurück
//     (Claim bleibt); werbe-ausfuehren lädt dann über hochladen.ts hoch und schließt die Zeilen.
//   Plan-B-Budgets: Gruppen aus ad_autopilot_rules.params.budget_gruppen, sonst das bekannte
//     Plan-B-Paar (PLAN_B_BUDGET_GRUPPE, wie werbe-autopilot/kontext.ts).
//   Gruppen-Rücksetzung: zurückgesetzte Zeilen gehen ausgeführt -> fehlgeschlagen mit result
//     'zurückgenommen: …' (werbe_actions_guard erlaubt genau das nur dem System).
//
// Log-Vertrag ad_autopilot_log (art 'ausfuehrung'): ergebnis 'ok' nur bei echter Änderung bei
// Meta; akteur_art 'system' = Autopilot-Zeile (eigene Änderung), 'mensch' = manuelle Zeile.
// Die 72-h-Sperre für Handänderungen darf nur ergebnis='ok' UND akteur_art='system' als eigene
// Änderung werten.
//
// Nie: löschen, archivieren, Ziel/Gebot/Targeting/Platzierung ändern. Nur status ACTIVE|PAUSED
// und daily_budget.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import {
  type BudgetHeadroom, budgetHeadroom, graphGet, graphPost, logMetaWrite, metaEnv, metaErrorLogFelder,
  metaWritesDisabled, MetaApiError, getLastUsage, wechselkurs,
} from './metaGraph.ts'

type Sb = SupabaseClient
type Level = 'ad' | 'adset' | 'campaign'

export type AusfuehrModus = 'freigabe' | 'fenster' | 'manuell'

export interface AusfuehrenOptionen {
  ids?: string[]
  modus: AusfuehrModus
  gruppeId?: string
  validateOnly?: boolean
  /** Profil-ID des Menschen, der den Lauf ausgelöst hat (Freigabe-Klick) */
  akteur?: string | null
  laufId?: string
  /** aufrufende Function für meta_write_log (Standard 'werbe-ausfuehren') */
  fn?: string
}

export interface Uebersprungen { id: string; grund: string }

export interface AusfuehrenErgebnis {
  ausgefuehrt: number
  fehlgeschlagen: number
  uebersprungen: Uebersprungen[]
  /** gesetzt, wenn dieser Lauf den Autopilot gestoppt hat (Aufrufer mailt an Sven) */
  gestoppt?: string
  /** gesetzt, wenn der Lauf abgebrochen wurde (z.B. Rate-Limit); Zeilen bleiben 'bestätigt' */
  abgebrochen?: string
  /** nur bei validateOnly */
  validiert?: Array<{ id: string; ok: boolean; fehler?: string }>
  /**
   * ersatz_hochladen-Gruppen, die alle Prüfungen bestanden haben (Claim gehalten, außer bei
   * validateOnly). Der Aufrufer (werbe-ausfuehren) lädt hoch und schließt die Zeilen ab;
   * nie an die Oberfläche durchreichen.
   */
  delegiert?: AktionsZeile[][]
}

/** Eine Zeile aus ad_actions (Spalten ab Migration 20261003110000 optional). */
export interface AktionsZeile {
  id: string
  platform?: string | null
  ad_id: string | null
  ad_name?: string | null
  campaign_name?: string | null
  action: string
  reason?: string | null
  status: string | null
  created_by?: string | null
  created_at?: string
  executed_at?: string | null
  result?: string | null
  origin?: string | null
  entity_level?: string | null
  entity_id?: string | null
  gruppe_id?: string | null
  payload?: Record<string, unknown> | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  readback?: Record<string, unknown> | null
  rule_key?: string | null
  rule_version?: number | null
  evidence?: Record<string, unknown> | null
  approval_level?: number | null
  freigabe?: string | null
  approved_by?: string | null
  approved_at?: string | null
  expires_at?: string | null
  window_date?: string | null
  idempotency_key?: string | null
  pre_state_hash?: string | null
  claimed_at?: string | null
  undo_of?: string | null
}

// ── Harte Leitplanken (SPEC §3; nur per Code-Änderung + Svens OK verschiebbar) ──
export const BUDGET_MIN_CENTS = 100
export const BUDGET_MAX_CENTS = 500_000
export const MAX_BUDGET_SCHRITT = 0.2
export const MIN_TAGESBUDGET_EUR = 30
export const BUDGET_ABSTAND_MS = 3 * 86_400_000
export const BUDGET_TAKT_MS = 3_600_000
export const LERNSCHUTZ_MS = 72 * 3_600_000
export const MAX_NEUE_ANZEIGEN_JE_FENSTER = 2
/**
 * Kurs-Toleranz der 30-€-Untergrenze: Regel-Motor und Ausführer nehmen beide
 * metaGraph.wechselkurs, aber zu verschiedenen Zeitpunkten (Vorschlag nachts, Ausführung im
 * Fenster). Ohne Toleranz scheitert jeder D1-Schritt genau auf der Untergrenze, sobald der
 * Dollar minimal steigt.
 */
export const UNTERGRENZE_KURS_TOLERANZ = 0.02
/** Bekanntes Plan-B-Paar (Kalt · Kurz / Kalt · Lang), Spiegel von werbe-autopilot/kontext.ts PLAN_B_GRUPPE. */
export const PLAN_B_BUDGET_GRUPPE = ['120249505116660314', '120248678452700314']

const ERLAUBT = new Set(['pause', 'activate', 'ersatz_aktivieren', 'budget_set'])
const NUR_IM_FENSTER = new Set(['activate', 'ersatz_aktivieren', 'budget_set'])
const REIHENFOLGE: Record<string, number> = { activate: 0, ersatz_aktivieren: 0, budget_set: 1, pause: 2 }
const STATUS_BESTAETIGT = 'bestätigt'
/** result autonomer Zeilen, wenn der Modus seit dem Anlegen unter 'autonom' gesenkt wurde */
const MODUS_GESENKT = 'Modus gesenkt'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Präfix, mit dem werbe_actions_guard dem System ausgeführt -> fehlgeschlagen erlaubt. */
export const ZURUECKGENOMMEN_PRAEFIX = 'zurückgenommen: '

// ── kleine Helfer ────────────────────────────────────────────────────────────

const digits = (v: unknown): string => String(v ?? '').replace(/[^0-9]/g, '')
/** Trimmen wie werbeMathe.kennungBasis bzw. SQL btrim: nur Leerzeichen, kein Tab/Umbruch/NBSP. */
const nurLeerzeichenTrimmen = (s: string): string => s.replace(/^ +| +$/g, '')
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const toNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const centsOrNull = (v: unknown): number | null => {
  const n = toNum(v)
  return n !== null && n > 0 ? Math.round(n) : null
}
const eur = (cents: number, usdPerEur: number) => Math.round((cents / 100 / usdPerEur) * 100) / 100
const istAutopilot = (r: AktionsZeile) => r.origin === 'autopilot'
const levelOf = (r: AktionsZeile): Level => {
  const l = String(r.entity_level ?? 'ad')
  return l === 'adset' || l === 'campaign' ? l : 'ad'
}
const entityOf = (r: AktionsZeile): string => digits(r.entity_id ?? r.ad_id)

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface ZustandFuerHash {
  status?: unknown
  effective_status?: unknown
  daily_budget?: unknown
  daily_budget_cents?: unknown
  updated_time?: unknown
}

/** sha256(status|effective_status|daily_budget|updated_time), normalisiert (Snapshot == Live). */
export async function preStateHash(z: ZustandFuerHash): Promise<string> {
  const up = (v: unknown) => String(v ?? '').trim().toUpperCase()
  const budget = centsOrNull(z.daily_budget ?? z.daily_budget_cents)
  const t = z.updated_time instanceof Date ? z.updated_time.getTime() : zeitMs(z.updated_time)
  const time = t !== null && Number.isFinite(t) ? new Date(t).toISOString() : ''
  return await sha256Hex(`${up(z.status)}|${up(z.effective_status)}|${budget ?? ''}|${time}`)
}

const WOCHENTAG: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

/** Kalendertag und ISO-Wochentag (Mo=1 … So=7) in Europe/Berlin (Zeitzone des Werbekontos). */
export function berlinTag(d: Date = new Date()): { datum: string; isoDow: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return { datum: `${get('year')}-${get('month')}-${get('day')}`, isoDow: WOCHENTAG[get('weekday')] ?? 0 }
}

function tabelleFehlt(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === '42P01' || e?.code === 'PGRST205' || /does not exist|could not find the table/i.test(String(e?.message ?? ''))
}
function funktionFehlt(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === 'PGRST202' || e?.code === '42883' || /could not find the function/i.test(String(e?.message ?? ''))
}

// ── Einstellungen ────────────────────────────────────────────────────────────

interface Einstellungen {
  autopilot_mode: string
  autopilot_paused_until: string | null
  max_auto_actions_per_day: number
  monthly_cap_eur: number
  change_window_dows: number[]
  budget_autonomie_freigegeben_at: string | null
}

async function ladeEinstellungen(sb: Sb): Promise<Einstellungen> {
  const { data, error } = await sb.from('ad_settings').select('*').eq('id', 'default').maybeSingle()
  if (error) throw new Error(`ad_settings lesen: ${String(error.message ?? error)}`)
  const r = (data ?? {}) as Record<string, unknown>
  const dows = Array.isArray(r.change_window_dows) ? (r.change_window_dows as unknown[]).map(Number) : [1, 4]
  return {
    // vor der Migration gibt es die Spalte nicht: dann ist der Autopilot aus
    autopilot_mode: typeof r.autopilot_mode === 'string' ? r.autopilot_mode : 'aus',
    autopilot_paused_until: typeof r.autopilot_paused_until === 'string' ? r.autopilot_paused_until : null,
    max_auto_actions_per_day: toNum(r.max_auto_actions_per_day) ?? 5,
    monthly_cap_eur: toNum(r.monthly_cap_eur) ?? 7500,
    change_window_dows: dows.filter(Number.isFinite).map(d => (d === 0 ? 7 : d)),
    budget_autonomie_freigegeben_at: typeof r.budget_autonomie_freigegeben_at === 'string' ? r.budget_autonomie_freigegeben_at : null,
  }
}

// ── Live-Zustand bei Meta ────────────────────────────────────────────────────

interface LiveZustand {
  id: string
  level: Level
  account_id: string
  name: string
  status: string
  effective_status: string
  daily_budget: number | null
  lifetime_budget: number | null
  updated_time: string | null
  adset_id: string | null
  campaign_id: string | null
  last_sig_edit_ms: number | null
  issues_info: unknown
  ad_review_feedback: unknown
}

const FELDER: Record<Level, string> = {
  ad: 'account_id,name,status,effective_status,updated_time,adset_id,campaign_id',
  adset: 'account_id,name,status,effective_status,daily_budget,lifetime_budget,updated_time,campaign_id,learning_stage_info',
  campaign: 'account_id,name,status,effective_status,daily_budget,lifetime_budget,updated_time',
}

function zeitMs(v: unknown): number | null {
  const n = toNum(v)
  if (n !== null) return n < 1e12 ? n * 1000 : n
  if (typeof v === 'string') {
    const t = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
    return Number.isFinite(t) ? t : null
  }
  return null
}

async function liveZustand(level: Level, id: string, mitPruefung = false): Promise<LiveZustand> {
  const fields = level === 'ad' && mitPruefung ? `${FELDER.ad},issues_info,ad_review_feedback` : FELDER[level]
  const j = await graphGet<Record<string, unknown>>(id, { fields })
  const lsi = (j.learning_stage_info ?? null) as Record<string, unknown> | null
  return {
    id,
    level,
    account_id: digits(j.account_id),
    name: String(j.name ?? ''),
    status: String(j.status ?? ''),
    effective_status: String(j.effective_status ?? ''),
    daily_budget: centsOrNull(j.daily_budget),
    lifetime_budget: centsOrNull(j.lifetime_budget),
    updated_time: typeof j.updated_time === 'string' ? j.updated_time : null,
    adset_id: j.adset_id ? String(j.adset_id) : null,
    campaign_id: j.campaign_id ? String(j.campaign_id) : null,
    last_sig_edit_ms: lsi ? zeitMs(lsi.last_sig_edit_ts) : null,
    issues_info: j.issues_info ?? null,
    ad_review_feedback: j.ad_review_feedback ?? null,
  }
}

const zustandKurz = (z: LiveZustand) => ({
  status: z.status, effective_status: z.effective_status,
  daily_budget: z.daily_budget, lifetime_budget: z.lifetime_budget, updated_time: z.updated_time,
})

function zielCents(r: AktionsZeile): number | null {
  const v = r.payload?.daily_budget_cents ?? r.after?.daily_budget_cents
  const n = toNum(v)
  return n !== null && Number.isInteger(n) ? n : null
}

function zielPatch(r: AktionsZeile): Record<string, unknown> {
  if (r.action === 'pause') return { status: 'PAUSED' }
  if (r.action === 'activate' || r.action === 'ersatz_aktivieren') return { status: 'ACTIVE' }
  if (r.action === 'budget_set') {
    const c = zielCents(r)
    if (c === null) throw new Error('Zielbudget fehlt')
    return { daily_budget: c }
  }
  throw new Error(`Unbekannte Aktion "${r.action}"`)
}

function passtRuecklesen(patch: Record<string, unknown>, rb: LiveZustand): boolean {
  if (typeof patch.status === 'string' && rb.status !== patch.status) return false
  if (typeof patch.daily_budget === 'number' && rb.daily_budget !== patch.daily_budget) return false
  return true
}

// ── Kontext + Logs ───────────────────────────────────────────────────────────

interface Ctx {
  sb: Sb
  opts: AusfuehrenOptionen
  laufId: string
  fn: string
  account: string
  erg: AusfuehrenErgebnis
  logAus: boolean
}

async function logAp(ctx: Ctx, z: Record<string, unknown>): Promise<void> {
  if (ctx.logAus) return
  try {
    const { error } = await ctx.sb.from('ad_autopilot_log').insert({ lauf_id: ctx.laufId, ...z })
    if (error) {
      if (tabelleFehlt(error)) ctx.logAus = true
      console.warn('[werbeAusfuehren] ad_autopilot_log:', String(error.message ?? error).slice(0, 200))
    }
  } catch (err) {
    console.warn('[werbeAusfuehren] ad_autopilot_log:', errMsg(err))
  }
}

function logFelder(ctx: Ctx, r: AktionsZeile, name?: string | null): Record<string, unknown> {
  const auto = istAutopilot(r)
  return {
    art: 'ausfuehrung',
    rule_key: r.rule_key ?? null,
    rule_version: r.rule_version ?? null,
    modus: ctx.opts.validateOnly ? 'validieren' : ctx.opts.modus,
    approval_level: r.approval_level ?? null,
    entity_level: levelOf(r),
    entity_id: entityOf(r) || null,
    entity_name: name ?? r.ad_name ?? (typeof r.payload?.entity_name === 'string' ? r.payload.entity_name : null),
    aktion: r.action,
    evidence: r.evidence ?? null,
    action_id: r.id,
    gruppe_id: r.gruppe_id ?? null,
    idempotency_key: r.idempotency_key ?? null,
    undo_of: r.undo_of ?? null,
    akteur: auto ? (ctx.opts.akteur ?? r.approved_by ?? null) : (r.created_by ?? null),
    akteur_art: auto ? 'system' : 'mensch',
  }
}

async function updateAktion(ctx: Ctx, id: string, patch: Record<string, unknown>, nurWennBestaetigt = false): Promise<void> {
  try {
    let q = ctx.sb.from('ad_actions').update(patch).eq('id', id)
    if (nurWennBestaetigt) q = q.eq('status', STATUS_BESTAETIGT)
    const { error } = await q
    if (error) console.warn(`[werbeAusfuehren] ad_actions ${id}:`, String(error.message ?? error).slice(0, 200))
  } catch (err) {
    console.warn(`[werbeAusfuehren] ad_actions ${id}:`, errMsg(err))
  }
}

async function claimsLoesen(ctx: Ctx, ids: string[]): Promise<void> {
  if (!ids.length || ctx.opts.validateOnly) return
  try {
    const { error } = await ctx.sb.from('ad_actions').update({ claimed_at: null }).in('id', ids).eq('status', STATUS_BESTAETIGT)
    if (error && !/claimed_at/.test(String(error.message ?? ''))) {
      console.warn('[werbeAusfuehren] Claim lösen:', String(error.message ?? error).slice(0, 200))
    }
  } catch (err) {
    console.warn('[werbeAusfuehren] Claim lösen:', errMsg(err))
  }
}

async function spiegeln(ctx: Ctx, level: Level, id: string, z: LiveZustand | null, status: string | null, mitEffektiv: boolean): Promise<void> {
  const now = new Date().toISOString()
  const warn = (t: string, e: unknown) => console.warn(`[werbeAusfuehren] Spiegel ${t}:`, String((e as { message?: string })?.message ?? e).slice(0, 200))
  try {
    if (level === 'ad') {
      if (status) {
        const { error } = await ctx.sb.from('ad_catalog').update({ status, updated_at: now }).eq('ad_id', id)
        if (error) warn('ad_catalog', error)
      }
      if (mitEffektiv && z?.effective_status) {
        // eigene Abfrage: Spalte effective_status kommt erst mit Migration 20261003100000
        const { error } = await ctx.sb.from('ad_catalog').update({ effective_status: z.effective_status }).eq('ad_id', id)
        if (error) warn('ad_catalog.effective_status', error)
      }
      return
    }
    if (!z) return
    const patch = { status: z.status, effective_status: z.effective_status, daily_budget_cents: z.daily_budget }
    const { error } = level === 'adset'
      ? await ctx.sb.from('meta_adsets').update(patch).eq('adset_id', id)
      : await ctx.sb.from('meta_campaigns').update(patch).eq('campaign_id', id)
    if (error) warn(level === 'adset' ? 'meta_adsets' : 'meta_campaigns', error)
  } catch (err) {
    warn(level, err)
  }
}

// ── Stopp ────────────────────────────────────────────────────────────────────

/**
 * Stoppt den Autopilot: ein_klick/autonom -> vorschlag, Grund speichern, Log 'stopp',
 * offene autonome Zeilen ablehnen. Wirft nie. Mail an Sven macht der Aufrufer.
 */
export async function autopilotStoppen(
  sb: Sb,
  grund: string,
  kontext: { laufId?: string; akteur?: string | null; evidence?: Record<string, unknown> } = {},
): Promise<void> {
  const text = String(grund).slice(0, 500)
  try {
    const { data } = await sb.from('ad_settings').select('autopilot_mode').eq('id', 'default').maybeSingle()
    const vorher = String((data as { autopilot_mode?: string } | null)?.autopilot_mode ?? '')
    const nachher = vorher === 'ein_klick' || vorher === 'autonom' ? 'vorschlag' : vorher
    const { error } = await sb.from('ad_settings')
      .update({ autopilot_mode: nachher || 'vorschlag', autopilot_stop_grund: text }).eq('id', 'default')
    if (error) console.error('[werbeAusfuehren] Stopp setzen:', String(error.message ?? error).slice(0, 200))
    const { error: e2 } = await sb.from('ad_actions')
      .update({ status: 'abgelehnt', freigabe: 'veraltet', result: `Autopilot gestoppt: ${text}`.slice(0, 200) })
      .eq('origin', 'autopilot').eq('status', STATUS_BESTAETIGT).eq('freigabe', 'autonom')
    if (e2) console.warn('[werbeAusfuehren] autonome Zeilen ablehnen:', String(e2.message ?? e2).slice(0, 200))
    const { error: e3 } = await sb.from('ad_autopilot_log').insert({
      lauf_id: kontext.laufId ?? null, art: 'stopp', ergebnis: text, modus: nachher || 'vorschlag',
      before: { autopilot_mode: vorher }, after: { autopilot_mode: nachher || 'vorschlag' },
      evidence: kontext.evidence ?? null, akteur: kontext.akteur ?? null, akteur_art: kontext.akteur ? 'mensch' : 'system',
    })
    if (e3) console.warn('[werbeAusfuehren] Stopp-Log:', String(e3.message ?? e3).slice(0, 200))
    console.error(`[werbeAusfuehren] AUTOPILOT GESTOPPT: ${text}`)
  } catch (err) {
    console.error('[werbeAusfuehren] Stopp fehlgeschlagen:', errMsg(err))
  }
}

// ── Prüf-Ergebnisse ──────────────────────────────────────────────────────────

type Pruefung =
  | { art: 'ok' }
  | { art: 'ablehnen'; grund: string; freigabe?: string; zeile?: string; result?: string }
  | { art: 'warten'; grund: string }
  | { art: 'stopp'; grund: string }
  | { art: 'abbruch'; grund: string }

const OK: Pruefung = { art: 'ok' }
type Befund = Exclude<Pruefung, { art: 'ok' }>

function metaFehlerPruefung(err: unknown, wobei: string): Befund {
  if (err instanceof MetaApiError) {
    if (err.kind === 'rate_limit') return { art: 'abbruch', grund: `rate_limit (${wobei})` }
    if (err.kind === 'auth' || err.kind === 'deprecated_version') return { art: 'stopp', grund: `Meta ${err.kind} bei ${wobei}: ${err.message}` }
    if (err.kind === 'transient') return { art: 'warten', grund: `meta_voruebergehend (${wobei})` }
    if (err.kind === 'validation' || err.kind === 'permission') return { art: 'ablehnen', grund: `${wobei}: ${err.userMsg ?? err.message}`.slice(0, 180) }
  }
  return { art: 'warten', grund: `${wobei}: ${errMsg(err)}`.slice(0, 180) }
}

/** Schließt eine Gruppe ohne Meta-Schreibzugriff ab (ablehnen/warten/stopp/abbruch). */
async function gruppeBeenden(ctx: Ctx, rows: AktionsZeile[], p: Befund): Promise<void> {
  const ids = rows.map(r => r.id)
  if (ctx.opts.validateOnly) {
    ctx.erg.validiert ??= []
    for (const r of rows) ctx.erg.validiert.push({ id: r.id, ok: false, fehler: `${p.art}: ${p.grund}` })
    for (const r of rows) await logAp(ctx, { ...logFelder(ctx, r), ergebnis: `validierung_${p.art}: ${p.grund}`.slice(0, 300) })
    if (p.art === 'abbruch') ctx.erg.abgebrochen = p.grund
    return
  }
  if (p.art === 'ablehnen') {
    for (const r of rows) {
      const eigene = !p.zeile || p.zeile === r.id
      const result = (eigene ? (p.result ?? (p.freigabe === 'abgelaufen' ? 'Abgelaufen' : p.freigabe === 'veraltet' ? `Veraltet: ${p.grund}` : `Leitplanke: ${p.grund}`)) : `Gruppe abgelehnt: ${p.grund}`).slice(0, 200)
      const patch: Record<string, unknown> = { status: 'abgelehnt', executed_at: new Date().toISOString(), result }
      if (p.freigabe) patch.freigabe = p.freigabe
      await updateAktion(ctx, r.id, patch, true)
      await logAp(ctx, { ...logFelder(ctx, r), ergebnis: p.freigabe ?? 'abgelehnt', after: { grund: p.grund } })
      ctx.erg.uebersprungen.push({ id: r.id, grund: `abgelehnt: ${p.grund}`.slice(0, 200) })
    }
    return
  }
  await claimsLoesen(ctx, ids)
  for (const r of rows) ctx.erg.uebersprungen.push({ id: r.id, grund: p.grund.slice(0, 200) })
  if (p.art === 'stopp') {
    await autopilotStoppen(ctx.sb, p.grund, { laufId: ctx.laufId })
    ctx.erg.gestoppt = p.grund
  }
  if (p.art === 'abbruch') ctx.erg.abgebrochen = p.grund
}

// ── Leitplanken ──────────────────────────────────────────────────────────────

function pruefeFenster(rows: AktionsZeile[], st: Einstellungen, jetzt: Date): Pruefung {
  const heute = berlinTag(jetzt)
  const imFenster = st.change_window_dows.includes(heute.isoDow)
  for (const r of rows) {
    if (r.window_date && r.window_date > heute.datum) return { art: 'warten', grund: `fenster_noch_nicht_erreicht (${r.window_date})` }
    const braucht = NUR_IM_FENSTER.has(r.action) || r.payload?.nur_im_fenster === true
    if (braucht && !imFenster) return { art: 'warten', grund: 'ausserhalb_aenderungsfenster' }
  }
  return OK
}

async function zaehleLog(ctx: Ctx, aktionen: string[] | null, seitMs: number, nurAutonom: boolean): Promise<number> {
  let q = ctx.sb.from('ad_autopilot_log').select('id')
    .eq('art', 'ausfuehrung').eq('ergebnis', 'ok').eq('akteur_art', 'system')
    .gte('ts', new Date(Date.now() - seitMs).toISOString())
  if (aktionen) q = q.in('aktion', aktionen)
  if (nurAutonom) q = q.eq('approval_level', 3)
  const { data, error } = await q.limit(500)
  if (error) throw new Error(`ad_autopilot_log lesen: ${String(error.message ?? error)}`)
  return ((data ?? []) as unknown[]).length
}

async function summeSpendEur(sb: Sb, abTag: string): Promise<number> {
  let summe = 0
  for (let seite = 0; seite < 20; seite++) {
    const { data, error } = await sb.from('ad_insights_daily').select('spend_eur')
      .gte('day', abTag).order('day', { ascending: true }).range(seite * 1000, seite * 1000 + 999)
    if (error) throw new Error(`ad_insights_daily lesen: ${String(error.message ?? error)}`)
    const rows = (data ?? []) as Array<{ spend_eur: unknown }>
    for (const r of rows) summe += toNum(r.spend_eur) ?? 0
    if (rows.length < 1000) return summe
  }
  throw new Error('ad_insights_daily: zu viele Zeilen für die Monatssumme')
}

/**
 * Budget-Gruppen (Plan-B-Paare) aus ad_autopilot_rules.params.budget_gruppen der budget_set-Regeln,
 * sonst PLAN_B_BUDGET_GRUPPE. Wirft bei DB-Fehler. Auch von werbe-ausfuehren/hochladen.ts genutzt
 * (Namen _lang/_kurz und Links je Hälfte eines Paars).
 */
export async function budgetGruppenLesen(sb: Sb): Promise<string[][]> {
  const { data, error } = await sb.from('ad_autopilot_rules').select('rule_key, params').eq('aktion', 'budget_set')
  if (error) throw new Error(`ad_autopilot_rules lesen: ${String(error.message ?? error)}`)
  const out: string[][] = []
  for (const r of (data ?? []) as Array<{ params?: Record<string, unknown> | null }>) {
    const g = r.params?.budget_gruppen
    if (!Array.isArray(g)) continue
    for (const grp of g) if (Array.isArray(grp) && grp.length > 1) out.push(grp.map(digits).filter(Boolean))
  }
  // Solange in den Regeln keine Gruppen gepflegt sind: das bekannte Plan-B-Paar (wie der Regel-Motor)
  if (!out.length) out.push([...PLAN_B_BUDGET_GRUPPE])
  return out
}

async function budgetTakt(ctx: Ctx, id: string): Promise<Pruefung> {
  const seit = new Date(Date.now() - BUDGET_ABSTAND_MS).toISOString()
  const { data: eigene, error } = await ctx.sb.from('ad_autopilot_log').select('ts')
    .eq('entity_id', id).eq('art', 'ausfuehrung').eq('aktion', 'budget_set').eq('ergebnis', 'ok').gte('ts', seit).limit(1)
  if (error) return { art: 'warten', grund: `leitplanke_nicht_pruefbar (ad_autopilot_log): ${String(error.message ?? error)}`.slice(0, 180) }
  if (((eigene ?? []) as unknown[]).length) return { art: 'ablehnen', grund: 'Budget dieser Gruppe wurde in den letzten 3 Tagen schon geändert', zeile: id }
  const { data: writes, error: e2 } = await ctx.sb.from('meta_write_log').select('ts, request')
    .eq('entity_id', id).eq('ok', true).eq('validate_only', false).gte('ts', seit).order('ts', { ascending: false }).limit(50)
  if (e2) return { art: 'warten', grund: `leitplanke_nicht_pruefbar (meta_write_log): ${String(e2.message ?? e2)}`.slice(0, 180) }
  for (const w of (writes ?? []) as Array<{ ts: string; request?: Record<string, unknown> | null }>) {
    const req = w.request ?? {}
    if (req.daily_budget === undefined && req.lifetime_budget === undefined) continue
    const ms = Date.parse(w.ts)
    if (Number.isFinite(ms) && Date.now() - ms < BUDGET_TAKT_MS) return { art: 'ablehnen', grund: 'höchstens eine Budgetänderung je Stunde', zeile: id }
    return { art: 'ablehnen', grund: 'Budget wurde in den letzten 3 Tagen schon geändert (meta_write_log)', zeile: id }
  }
  return OK
}

async function undoZiel(ctx: Ctx, undoOf: string): Promise<number | null> {
  const { data, error } = await ctx.sb.from('ad_actions').select('before, readback, action').eq('id', undoOf).maybeSingle()
  if (error || !data) return null
  const o = data as { before?: Record<string, unknown> | null; readback?: Record<string, unknown> | null; action?: string }
  if (o.action !== 'budget_set') return null
  const vorher = (o.readback?.vorher ?? null) as Record<string, unknown> | null
  return centsOrNull(vorher?.daily_budget ?? o.before?.daily_budget_cents ?? o.before?.daily_budget)
}

async function pruefeLeitplanken(
  ctx: Ctx, rows: AktionsZeile[], live: Map<string, LiveZustand>, st: Einstellungen,
): Promise<Pruefung> {
  const kurs = await wechselkurs(ctx.sb)
  const budgetRows = rows.filter(r => r.action === 'budget_set')
  const aktivRows = rows.filter(r => r.action === 'activate' || r.action === 'ersatz_aktivieren')
  const pauseRows = rows.filter(r => r.action === 'pause')
  let erhoehung = false
  const ersetzt: string[] = []
  let addCents = 0

  // Budget je Zeile
  for (const r of budgetRows) {
    const z = live.get(r.id)!
    const id = entityOf(r)
    const ziel = zielCents(r)
    if (ziel === null) return { art: 'ablehnen', grund: 'Zielbudget fehlt (payload.daily_budget_cents)', zeile: r.id }
    if (ziel < BUDGET_MIN_CENTS || ziel > BUDGET_MAX_CENTS) return { art: 'ablehnen', grund: `Budget ${ziel} USD-Cent außerhalb ${BUDGET_MIN_CENTS}..${BUDGET_MAX_CENTS}`, zeile: r.id }
    if (z.lifetime_budget) return { art: 'ablehnen', grund: 'Laufzeitbudgets ändert der Autopilot nie', zeile: r.id }
    const alt = z.daily_budget
    if (!alt) return { art: 'ablehnen', grund: 'Kein eigenes Tagesbudget (Kampagnenbudget?)', zeile: r.id }
    if (ziel === alt) return { art: 'ablehnen', grund: 'Budget ist bereits so eingestellt', zeile: r.id }
    if (r.freigabe === 'autonom' && !st.budget_autonomie_freigegeben_at) {
      return { art: 'ablehnen', grund: 'Budget-Autonomie nicht freigegeben', zeile: r.id }
    }
    if (r.undo_of) {
      const soll = await undoZiel(ctx, r.undo_of)
      if (soll === null || soll !== ziel) return { art: 'ablehnen', grund: 'Rückgängig nur auf den exakten Vorher-Wert', zeile: r.id }
    } else {
      if (ziel > Math.round(alt * (1 + MAX_BUDGET_SCHRITT))) return { art: 'ablehnen', grund: 'Erhöhung über +20 %', zeile: r.id }
      if (ziel < Math.round(alt * (1 - MAX_BUDGET_SCHRITT))) return { art: 'ablehnen', grund: 'Senkung über -20 %', zeile: r.id }
      if (ziel < alt && eur(ziel, kurs.usdPerEur) < MIN_TAGESBUDGET_EUR * (1 - UNTERGRENZE_KURS_TOLERANZ)) {
        return { art: 'ablehnen', grund: `Untergrenze ${MIN_TAGESBUDGET_EUR} €/Tag`, zeile: r.id }
      }
      if (z.last_sig_edit_ms && Date.now() - z.last_sig_edit_ms < LERNSCHUTZ_MS) {
        return { art: 'ablehnen', grund: 'Lernschutz: wesentliche Änderung vor weniger als 72 h', zeile: r.id }
      }
      const takt = await budgetTakt(ctx, id)
      if (takt.art !== 'ok') return takt.art === 'ablehnen' ? { ...takt, zeile: r.id } : takt
    }
    if (ziel > alt) erhoehung = true
    ersetzt.push(id)
    addCents += ziel
  }

  // Plan-B-Gruppen symmetrisch (alle Mitglieder in derselben Gruppe, gleiches Ziel)
  if (budgetRows.length) {
    let gruppen: string[][]
    try { gruppen = await budgetGruppenLesen(ctx.sb) } catch (err) { return { art: 'warten', grund: `leitplanke_nicht_pruefbar: ${errMsg(err)}`.slice(0, 180) } }
    const zielJe = new Map(budgetRows.map(r => [entityOf(r), zielCents(r)]))
    for (const grp of gruppen) {
      const betroffen = grp.filter(id => zielJe.has(id))
      if (!betroffen.length) continue
      const werte = grp.map(id => zielJe.get(id))
      if (werte.some(w => w === undefined || w === null) || new Set(werte).size !== 1) {
        return { art: 'ablehnen', grund: `Plan-B-Gruppe ${grp.join('/')} nicht symmetrisch` }
      }
    }
  }

  // Aktivierungen
  const neueAnzeigen = aktivRows.filter(r => levelOf(r) === 'ad' && !r.undo_of)
  for (const r of aktivRows) {
    const z = live.get(r.id)!
    if (levelOf(r) === 'ad') {
      if (['DISAPPROVED', 'WITH_ISSUES'].includes(z.effective_status)) return { art: 'ablehnen', grund: `Anzeige ist ${z.effective_status}`, zeile: r.id }
      const fb = z.ad_review_feedback
      if (fb && typeof fb === 'object' && Object.keys(fb as Record<string, unknown>).length) {
        return { art: 'ablehnen', grund: 'Anzeige hat Prüf-Hinweise von Meta', zeile: r.id }
      }
    } else {
      if (z.lifetime_budget) return { art: 'ablehnen', grund: 'Laufzeitbudget: Aktivieren nur von Hand', zeile: r.id }
      if (z.daily_budget) { erhoehung = true; ersetzt.push(entityOf(r)); addCents += z.daily_budget }
    }
  }
  if (neueAnzeigen.length) {
    try {
      const schon = await zaehleLog(ctx, ['activate', 'ersatz_aktivieren'], 86_400_000, false)
      if (schon + neueAnzeigen.length > MAX_NEUE_ANZEIGEN_JE_FENSTER) {
        return { art: 'ablehnen', grund: `höchstens ${MAX_NEUE_ANZEIGEN_JE_FENSTER} neue Anzeigen je Fenster` }
      }
    } catch (err) {
      return { art: 'warten', grund: `leitplanke_nicht_pruefbar: ${errMsg(err)}`.slice(0, 180) }
    }
  }

  // Nie die letzte aktive Anzeige einer Anzeigengruppe pausieren
  const pausenJeAdset = new Map<string, Set<string>>()
  for (const r of pauseRows) {
    if (levelOf(r) !== 'ad' || r.undo_of) continue
    const adset = live.get(r.id)!.adset_id
    if (!adset) return { art: 'ablehnen', grund: 'Anzeigengruppe der Anzeige unbekannt', zeile: r.id }
    if (!pausenJeAdset.has(adset)) pausenJeAdset.set(adset, new Set())
    pausenJeAdset.get(adset)!.add(entityOf(r))
  }
  for (const [adset, pausiert] of pausenJeAdset) {
    let ads: Array<{ id?: string; effective_status?: string }>
    try {
      const j = await graphGet<{ data?: Array<{ id?: string; effective_status?: string }> }>(`${digits(adset)}/ads`, { fields: 'id,effective_status', limit: 200 })
      ads = j.data ?? []
    } catch (err) {
      return metaFehlerPruefung(err, 'Anzeigen der Gruppe lesen')
    }
    const andere = ads.filter(a => a.effective_status === 'ACTIVE' && !pausiert.has(digits(a.id)))
    if (!andere.length) return { art: 'ablehnen', grund: 'letzte aktive Anzeige der Anzeigengruppe' }
  }

  // Summe aktiver Tagesbudgets + Monatsrahmen (nur wenn es teurer werden kann)
  if (erhoehung) {
    let h: BudgetHeadroom
    try {
      h = await budgetHeadroom(ctx.sb, { addDailyUsdCents: addCents, replaceEntityIds: ersetzt })
    } catch (err) {
      return err instanceof MetaApiError ? metaFehlerPruefung(err, 'Budget-Summe lesen') : { art: 'warten', grund: `leitplanke_nicht_pruefbar: ${errMsg(err)}`.slice(0, 180) }
    }
    if (!h.ok) return { art: 'ablehnen', grund: `Summe aktiver Tagesbudgets ${h.afterEur} € über Limit ${h.limitEur} €` }
    const heute = berlinTag()
    const [y, m, d] = heute.datum.split('-').map(Number)
    const tageImMonat = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const restTage = tageImMonat - d + 1
    let bisher: number
    try { bisher = await summeSpendEur(ctx.sb, `${heute.datum.slice(0, 8)}01`) } catch (err) {
      return { art: 'warten', grund: `leitplanke_nicht_pruefbar: ${errMsg(err)}`.slice(0, 180) }
    }
    const prognose = Math.round((bisher + restTage * h.afterEur) * 100) / 100
    if (prognose > st.monthly_cap_eur) {
      return { art: 'ablehnen', grund: `Monatsprognose ${prognose} € über Rahmen ${st.monthly_cap_eur} €` }
    }
  }
  return OK
}

// ── Zurücksetzen (Gruppe teilweise fehlgeschlagen) ───────────────────────────

interface Ausgefuehrt { row: AktionsZeile; vorher: LiveZustand; nachher?: LiveZustand; markieren: boolean }

/**
 * Setzt bereits ausgeführte Gruppenmitglieder bei Meta auf den Vorher-Wert zurück.
 * Gelingt das, geht die Zeile ausgeführt -> fehlgeschlagen ('zurückgenommen: …', vom
 * werbe_actions_guard nur dem System erlaubt). Scheitert es, ist die Änderung bei Meta noch
 * aktiv: die Zeile bleibt 'ausgeführt' und bekommt den Fehler in result/readback.
 */
async function zuruecksetzen(ctx: Ctx, items: Ausgefuehrt[], grund: string): Promise<{ fehler: string[]; zurueckgenommen: number }> {
  const fehler: string[] = []
  let zurueckgenommen = 0
  for (const it of [...items].reverse()) {
    const { row, vorher } = it
    const id = entityOf(row)
    const level = levelOf(row)
    let patch: Record<string, unknown> | null = null
    if (row.action === 'budget_set' && vorher.daily_budget) patch = { daily_budget: vorher.daily_budget }
    else if (row.action !== 'budget_set' && (vorher.status === 'ACTIVE' || vorher.status === 'PAUSED')) patch = { status: vorher.status }
    if (!patch) { fehler.push(`${id}: kein Vorher-Wert`); continue }
    let rb: LiveZustand | null = null
    let fehlerText: string | null = null
    try {
      const resp = await graphPost(id, patch, { idempotent: true })
      await logMetaWrite(ctx.sb, {
        actor_kind: 'autopilot', actor: ctx.opts.akteur ?? null, fn: ctx.fn, mode: 'zuruecksetzen',
        entity_level: level, entity_id: id, path: id, request: patch, before: null, after: resp, ok: true, usage: getLastUsage(),
      })
      rb = await liveZustand(level, id)
      if (!passtRuecklesen(patch, rb)) fehlerText = 'Rücklesen nach Zurücksetzen weicht ab'
    } catch (err) {
      fehlerText = errMsg(err)
      await logMetaWrite(ctx.sb, {
        actor_kind: 'autopilot', actor: ctx.opts.akteur ?? null, fn: ctx.fn, mode: 'zuruecksetzen',
        entity_level: level, entity_id: id, path: id, request: patch, ok: false, ...metaErrorLogFelder(err), usage: getLastUsage(),
      })
    }
    if (fehlerText) fehler.push(`${id}: ${fehlerText}`)
    if (it.markieren) {
      if (fehlerText) {
        // Änderung ist bei Meta noch aktiv: Status bleibt 'ausgeführt' (Rückgängig bleibt möglich)
        await updateAktion(ctx, row.id, {
          result: `Zurücknehmen fehlgeschlagen, Änderung bei Meta noch aktiv: ${fehlerText}`.slice(0, 200),
          readback: {
            vorher: zustandKurz(vorher), nachher: it.nachher ? zustandKurz(it.nachher) : null,
            zuruecknehmen_fehler: fehlerText, nach_versuch: rb ? zustandKurz(rb) : null,
          },
        })
      } else {
        await updateAktion(ctx, row.id, {
          status: 'fehlgeschlagen', executed_at: new Date().toISOString(),
          result: `${ZURUECKGENOMMEN_PRAEFIX}${grund}`.slice(0, 200),
          readback: {
            vorher: zustandKurz(vorher), nachher: it.nachher ? zustandKurz(it.nachher) : null,
            zurueckgesetzt: rb ? zustandKurz(rb) : null,
          },
        })
        zurueckgenommen++
      }
    }
    await logAp(ctx, {
      ...logFelder(ctx, row, vorher.name), ergebnis: fehlerText ? 'fehler' : 'zurueckgesetzt',
      before: zustandKurz(vorher), after: patch, readback: rb ? zustandKurz(rb) : null,
      meta_response: fehlerText ? { fehler: fehlerText } : null,
    })
  }
  return { fehler, zurueckgenommen }
}

// ── Vorrat nach ersatz_aktivieren ────────────────────────────────────────────

/**
 * Ersatz-Anzeige ist ACTIVE: Vorrat-Zeile (payload.pool_id) -> 'aktiv' mit aktiv_seit und
 * ersetzt_kennung (payload.ersetzt_kennung). R1b pausiert die ersetzte Anzeige erst danach.
 * Wirft nie (die Meta-Änderung ist schon geschehen).
 */
async function vorratAktivSetzen(ctx: Ctx, r: AktionsZeile): Promise<void> {
  const poolId = String(r.payload?.pool_id ?? '').trim()
  if (!UUID_RE.test(poolId)) {
    console.warn(`[werbeAusfuehren] ersatz_aktivieren ${r.id}: payload.pool_id fehlt, Vorrat bleibt unverändert`)
    return
  }
  const ersetzt = typeof r.payload?.ersetzt_kennung === 'string' ? nurLeerzeichenTrimmen(r.payload.ersetzt_kennung) : ''
  try {
    const { data, error } = await ctx.sb.from('ad_creative_pool').select('id, status, ersetzt_kennung').eq('id', poolId).maybeSingle()
    if (error || !data) {
      console.warn(`[werbeAusfuehren] Vorrat ${poolId} lesen:`, error ? String(error.message ?? error).slice(0, 200) : 'nicht gefunden')
      return
    }
    const p = data as { status?: string | null; ersetzt_kennung?: string | null }
    const patch: Record<string, unknown> = {}
    if (p.status !== 'aktiv') {
      if (p.status !== 'hochgeladen' && p.status !== 'pausiert') {
        console.warn(`[werbeAusfuehren] Vorrat ${poolId} steht auf ${p.status}, nicht auf aktiv gesetzt`)
        return
      }
      patch.status = 'aktiv'
      patch.aktiv_seit = new Date().toISOString()
      if (ersetzt) patch.ersetzt_kennung = ersetzt
    } else if (ersetzt && !p.ersetzt_kennung) {
      patch.ersetzt_kennung = ersetzt
    }
    if (!Object.keys(patch).length) return
    const { error: uErr } = await ctx.sb.from('ad_creative_pool').update(patch).eq('id', poolId)
    if (uErr) console.warn(`[werbeAusfuehren] Vorrat ${poolId} aktiv setzen:`, String(uErr.message ?? uErr).slice(0, 200))
  } catch (err) {
    console.warn(`[werbeAusfuehren] Vorrat ${poolId} aktiv setzen:`, errMsg(err))
  }
}

// ── Autopilot-Gruppe ─────────────────────────────────────────────────────────

async function verarbeiteGruppe(ctx: Ctx, gruppe: AktionsZeile[], st: Einstellungen): Promise<void> {
  const rows = [...gruppe].sort((a, b) =>
    (REIHENFOLGE[a.action] ?? 9) - (REIHENFOLGE[b.action] ?? 9) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
  const validate = ctx.opts.validateOnly === true
  const jetzt = new Date()

  // Autonome Zeilen nur, solange der Modus autonom ist; Modus gesenkt -> ganze Gruppe ablehnen
  if (rows.some(r => r.freigabe === 'autonom') && st.autopilot_mode !== 'autonom') {
    return await gruppeBeenden(ctx, rows, { art: 'ablehnen', grund: MODUS_GESENKT, freigabe: 'abgelaufen', result: MODUS_GESENKT })
  }

  // 3 Ablauf
  if (!validate && rows.some(r => r.expires_at && Date.parse(r.expires_at) < jetzt.getTime())) {
    return await gruppeBeenden(ctx, rows, { art: 'ablehnen', grund: 'abgelaufen', freigabe: 'abgelaufen' })
  }

  // Hochladen (ersatz_hochladen) nur als eigene Gruppe; Ausführung über werbe-ausfuehren
  const hochladen = rows.filter(r => r.action === 'ersatz_hochladen').length
  if (hochladen && hochladen !== rows.length) {
    return await gruppeBeenden(ctx, rows, { art: 'ablehnen', grund: 'Hochladen nur als eigene Gruppe' })
  }

  // Aktionen + Ziele
  for (const r of rows) {
    if (!hochladen && !ERLAUBT.has(r.action)) return await gruppeBeenden(ctx, rows, { art: 'ablehnen', grund: `Unbekannte Aktion "${r.action}"`, zeile: r.id })
    if (!entityOf(r)) return await gruppeBeenden(ctx, rows, { art: 'ablehnen', grund: 'Ziel-ID fehlt', zeile: r.id })
    if (r.action === 'budget_set' && levelOf(r) === 'ad') {
      return await gruppeBeenden(ctx, rows, { art: 'ablehnen', grund: 'Budget nur auf Anzeigengruppe oder Kampagne', zeile: r.id })
    }
  }

  // 5a Änderungsfenster
  if (!validate) {
    const f = pruefeFenster(rows, st, jetzt)
    if (f.art !== 'ok') return await gruppeBeenden(ctx, rows, f)
  }

  // Tageslimit autonomer Aktionen (darüber: Stopp)
  const autonom = rows.filter(r => r.freigabe === 'autonom').length
  if (autonom && !validate) {
    try {
      const heute = await zaehleLog(ctx, null, 86_400_000, true)
      if (heute + autonom > st.max_auto_actions_per_day) {
        return await gruppeBeenden(ctx, rows, { art: 'stopp', grund: `Tageslimit autonomer Aktionen (${st.max_auto_actions_per_day}) erreicht` })
      }
    } catch (err) {
      return await gruppeBeenden(ctx, rows, { art: 'warten', grund: `leitplanke_nicht_pruefbar: ${errMsg(err)}`.slice(0, 180) })
    }
  }

  // ersatz_hochladen: Rest (Konto, HOUSING, Lint, Bilder, validate_only, Lease) macht hochladen.ts
  if (hochladen) {
    ctx.erg.delegiert ??= []
    ctx.erg.delegiert.push(rows)
    return
  }

  // 4 Live-Zustand, Konto, Vorher-Hash
  const live = new Map<string, LiveZustand>()
  for (const r of rows) {
    try {
      const z = await liveZustand(levelOf(r), entityOf(r), r.action === 'activate' || r.action === 'ersatz_aktivieren')
      if (z.account_id !== ctx.account) return await gruppeBeenden(ctx, rows, { art: 'ablehnen', grund: 'Objekt gehört nicht zu unserem Werbekonto', zeile: r.id })
      if (r.pre_state_hash && (await preStateHash(z)) !== r.pre_state_hash) {
        return await gruppeBeenden(ctx, rows, { art: 'ablehnen', grund: 'Zustand bei Meta hat sich seit dem Vorschlag geändert', freigabe: 'veraltet', zeile: r.id })
      }
      live.set(r.id, z)
    } catch (err) {
      return await gruppeBeenden(ctx, rows, metaFehlerPruefung(err, 'Zustand lesen'))
    }
  }

  // 5b Leitplanken
  const lp = await pruefeLeitplanken(ctx, rows, live, st)
  if (lp.art !== 'ok') return await gruppeBeenden(ctx, rows, lp)

  // Validieren: nur execution_options validate_only, kein Status
  if (validate) {
    ctx.erg.validiert ??= []
    for (const r of rows) {
      const id = entityOf(r)
      const patch = zielPatch(r)
      try {
        await graphPost(id, patch, { validateOnly: true })
        await logMetaWrite(ctx.sb, {
          actor_kind: 'autopilot', actor: ctx.opts.akteur ?? null, fn: ctx.fn, mode: 'validieren',
          entity_level: levelOf(r), entity_id: id, path: id, validate_only: true, request: patch, ok: true, usage: getLastUsage(),
        })
        ctx.erg.validiert.push({ id: r.id, ok: true })
        await logAp(ctx, { ...logFelder(ctx, r, live.get(r.id)?.name), ergebnis: 'validiert', after: patch })
      } catch (err) {
        await logMetaWrite(ctx.sb, {
          actor_kind: 'autopilot', actor: ctx.opts.akteur ?? null, fn: ctx.fn, mode: 'validieren',
          entity_level: levelOf(r), entity_id: id, path: id, validate_only: true, request: patch, ok: false,
          ...metaErrorLogFelder(err), usage: getLastUsage(),
        })
        ctx.erg.validiert.push({ id: r.id, ok: false, fehler: errMsg(err).slice(0, 300) })
        await logAp(ctx, { ...logFelder(ctx, r, live.get(r.id)?.name), ergebnis: `validierung_fehler: ${errMsg(err)}`.slice(0, 300), after: patch })
        if (err instanceof MetaApiError && err.kind === 'rate_limit') { ctx.erg.abgebrochen = 'rate_limit'; return }
      }
    }
    return
  }

  // 6-9 Ausführen, Rücklesen, Spiegeln, Log; bei Teil-Fehler zurücksetzen + Stopp
  const erledigt: Ausgefuehrt[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const id = entityOf(r)
    const level = levelOf(r)
    const vorher = live.get(r.id)!
    const patch = zielPatch(r)
    const rest = rows.slice(i + 1)
    let resp: unknown
    try {
      resp = await graphPost(id, patch, { idempotent: true })
      await logMetaWrite(ctx.sb, {
        actor_kind: 'autopilot', actor: ctx.opts.akteur ?? r.approved_by ?? null, fn: ctx.fn, mode: ctx.opts.modus,
        entity_level: level, entity_id: id, path: id, request: patch, before: zustandKurz(vorher), after: resp, ok: true, usage: getLastUsage(),
      })
    } catch (err) {
      await logMetaWrite(ctx.sb, {
        actor_kind: 'autopilot', actor: ctx.opts.akteur ?? r.approved_by ?? null, fn: ctx.fn, mode: ctx.opts.modus,
        entity_level: level, entity_id: id, path: id, request: patch, before: zustandKurz(vorher), ok: false,
        ...metaErrorLogFelder(err), usage: getLastUsage(),
      })
      const me = err instanceof MetaApiError ? err : null
      if (me?.kind === 'rate_limit' && !erledigt.length) {
        return await gruppeBeenden(ctx, rows, { art: 'abbruch', grund: 'rate_limit' })
      }
      const msg = errMsg(err)
      await updateAktion(ctx, r.id, { status: 'fehlgeschlagen', executed_at: new Date().toISOString(), result: msg.slice(0, 200) })
      await logAp(ctx, { ...logFelder(ctx, r, vorher.name), ergebnis: 'fehler', before: zustandKurz(vorher), after: patch, meta_response: me ? me.detail() : { message: msg } })
      ctx.erg.fehlgeschlagen++
      for (const x of rest) {
        await updateAktion(ctx, x.id, { status: 'abgelehnt', executed_at: new Date().toISOString(), result: `Gruppe abgebrochen: ${msg}`.slice(0, 200) }, true)
        ctx.erg.uebersprungen.push({ id: x.id, grund: 'gruppe_abgebrochen' })
      }
      let stopp: string | null = null
      if (erledigt.length) {
        const rz = await zuruecksetzen(ctx, erledigt, `Gruppe unvollständig (${msg})`)
        const rf = rz.fehler
        ctx.erg.ausgefuehrt -= rz.zurueckgenommen
        ctx.erg.fehlgeschlagen += rz.zurueckgenommen
        stopp = `Gruppe teilweise fehlgeschlagen, zurückgesetzt${rf.length ? ` (Fehler beim Zurücksetzen: ${rf.join('; ')})` : ''}: ${msg}`
      } else if (me && ['auth', 'deprecated_version', 'permission', 'dev_mode'].includes(me.kind)) {
        stopp = `Meta ${me.kind}: ${msg}`
      }
      if (stopp) {
        await autopilotStoppen(ctx.sb, stopp, { laufId: ctx.laufId })
        ctx.erg.gestoppt = stopp
      }
      return
    }

    // 7 Rücklesen
    let rb: LiveZustand | null = null
    let rbFehler: string | null = null
    try { rb = await liveZustand(level, id) } catch (err) { rbFehler = errMsg(err) }
    if (!rb || !passtRuecklesen(patch, rb)) {
      const grund = rb ? 'Rücklesen weicht ab' : `Rücklesen fehlgeschlagen: ${rbFehler}`
      await updateAktion(ctx, r.id, {
        status: 'fehlgeschlagen', executed_at: new Date().toISOString(), result: grund.slice(0, 200),
        readback: { vorher: zustandKurz(vorher), nachher: rb ? zustandKurz(rb) : null, fehler: rbFehler },
      })
      await logAp(ctx, {
        ...logFelder(ctx, r, vorher.name), ergebnis: 'fehler', before: zustandKurz(vorher), after: patch,
        readback: rb ? zustandKurz(rb) : null, meta_response: { response: resp ?? null, fehler: grund },
      })
      ctx.erg.fehlgeschlagen++
      for (const x of rest) {
        await updateAktion(ctx, x.id, { status: 'abgelehnt', executed_at: new Date().toISOString(), result: `Gruppe abgebrochen: ${grund}`.slice(0, 200) }, true)
        ctx.erg.uebersprungen.push({ id: x.id, grund: 'gruppe_abgebrochen' })
      }
      const rz = await zuruecksetzen(ctx, [...erledigt, { row: r, vorher, markieren: false }], grund)
      const rf = rz.fehler
      ctx.erg.ausgefuehrt -= rz.zurueckgenommen
      ctx.erg.fehlgeschlagen += rz.zurueckgenommen
      const stopp = `${grund} bei ${id}${rf.length ? ` (Fehler beim Zurücksetzen: ${rf.join('; ')})` : ''}`
      await autopilotStoppen(ctx.sb, stopp, { laufId: ctx.laufId })
      ctx.erg.gestoppt = stopp
      return
    }

    // 8 Status, Spiegel, Log
    const result = r.action === 'budget_set'
      ? `Tagesbudget ${vorher.daily_budget} → ${rb.daily_budget} USD-Cent`
      : `Status → ${rb.status}`
    const patchRow: Record<string, unknown> = {
      status: 'ausgeführt', executed_at: new Date().toISOString(), result,
      readback: { vorher: zustandKurz(vorher), nachher: zustandKurz(rb) },
    }
    if (!r.before) patchRow.before = zustandKurz(vorher)
    if (!r.after) patchRow.after = patch
    await updateAktion(ctx, r.id, patchRow)
    await spiegeln(ctx, level, id, rb, typeof patch.status === 'string' ? rb.status : null, true)
    await logAp(ctx, {
      ...logFelder(ctx, r, vorher.name), ergebnis: 'ok', before: zustandKurz(vorher), after: patch,
      readback: zustandKurz(rb), meta_response: resp ?? null,
    })
    erledigt.push({ row: r, vorher, nachher: rb, markieren: true })
    ctx.erg.ausgefuehrt++
  }

  // Ganze Gruppe ok: Ersatz-Werbemittel im Vorrat auf aktiv (erst jetzt, eine Rücksetzung wäre sonst falsch)
  for (const e of erledigt) if (e.row.action === 'ersatz_aktivieren') await vorratAktivSetzen(ctx, e.row)
}

// ── Manuelle Zeilen (exakt wie der bisherige Ausführer in meta-ads-sync) ──────

async function manuellAusfuehren(ctx: Ctx, a: AktionsZeile): Promise<void> {
  const validate = ctx.opts.validateOnly === true
  const adId = String(a.ad_id ?? '')
  const logBasis = {
    actor_kind: 'user' as const, actor: a.created_by ?? null, fn: ctx.fn, mode: validate ? 'validieren' : 'manuell',
    entity_level: 'ad', entity_id: adId, path: adId, validate_only: validate,
  }
  let newStatus = ''
  try {
    if (a.action !== 'pause' && a.action !== 'activate') throw new Error(`Unbekannte Aktion "${a.action}"`)
    // Sicherheitscheck: Ad muss zu unserem Konto gehören
    const { data: cat } = await ctx.sb.from('ad_catalog')
      .select('ad_id').eq('ad_id', adId).eq('account_id', ctx.account).maybeSingle()
    if (!cat) throw new Error('Ad nicht im Konto-Katalog')

    newStatus = a.action === 'pause' ? 'PAUSED' : 'ACTIVE'
    const resp = await graphPost(adId, { status: newStatus }, validate ? { validateOnly: true } : {})
    await logMetaWrite(ctx.sb, { ...logBasis, request: { status: newStatus }, after: resp, ok: true, usage: getLastUsage() })
    if (validate) {
      ctx.erg.validiert ??= []
      ctx.erg.validiert.push({ id: a.id, ok: true })
      await logAp(ctx, { ...logFelder(ctx, a), ergebnis: 'validiert', after: { status: newStatus } })
      return
    }
    await updateAktion(ctx, a.id, { status: 'ausgeführt', executed_at: new Date().toISOString(), result: `Status → ${newStatus}` })
    await spiegeln(ctx, 'ad', adId, null, newStatus, false)
    await logAp(ctx, { ...logFelder(ctx, a), ergebnis: 'ok', after: { status: newStatus }, meta_response: resp ?? null })
    ctx.erg.ausgefuehrt++
    console.log(`[werbeAusfuehren] Aktion ausgeführt: ${a.action} ${a.ad_name ?? adId}`)
  } catch (err) {
    const msg = errMsg(err)
    if (newStatus) {
      await logMetaWrite(ctx.sb, { ...logBasis, request: { status: newStatus }, ok: false, ...metaErrorLogFelder(err), usage: getLastUsage() })
    }
    if (validate) {
      ctx.erg.validiert ??= []
      ctx.erg.validiert.push({ id: a.id, ok: false, fehler: msg.slice(0, 300) })
      return
    }
    ctx.erg.fehlgeschlagen++
    console.error(`[werbeAusfuehren] Aktion fehlgeschlagen (${a.ad_name ?? adId}):`, msg)
    await updateAktion(ctx, a.id, { status: 'fehlgeschlagen', executed_at: new Date().toISOString(), result: msg.slice(0, 200) })
    await logAp(ctx, { ...logFelder(ctx, a), ergebnis: 'fehler', after: newStatus ? { status: newStatus } : null, meta_response: { message: msg.slice(0, 300) } })
  }
}

// ── Einstieg ─────────────────────────────────────────────────────────────────

function spalteFehlt(error: unknown, spalte: string): boolean {
  const e = error as { code?: string; message?: string } | null
  return (e?.code === '42703' || e?.code === 'PGRST204' || /does not exist|could not find/i.test(String(e?.message ?? '')))
    && String(e?.message ?? '').includes(spalte)
}

async function ladeZeilen(sb: Sb, opts: AusfuehrenOptionen): Promise<AktionsZeile[]> {
  // select('*'): funktioniert vor UND nach der Migration 20261003110000 (neue Spalten optional)
  const basis = () => {
    let q = sb.from('ad_actions').select('*')
    if (opts.gruppeId) q = q.eq('gruppe_id', opts.gruppeId)
    if (opts.ids?.length) q = q.in('id', opts.ids.slice(0, 200))
    if (!opts.validateOnly) q = q.eq('status', STATUS_BESTAETIGT)
    return q
  }
  // Herkunft VOR dem Limit filtern, sonst verdrängen hängende Autopilot-Zeilen die manuellen
  let q = basis()
  if (opts.modus === 'fenster') q = q.eq('origin', 'autopilot')
  else if (opts.modus === 'manuell') q = q.or('origin.is.null,origin.neq.autopilot')
  let { data, error } = await q.order('created_at', { ascending: true }).limit(200)
  if (error && opts.modus === 'manuell' && spalteFehlt(error, 'origin')) {
    // vor der Migration gibt es origin nicht: dann sind alle Zeilen manuell
    ({ data, error } = await basis().order('created_at', { ascending: true }).limit(200))
  }
  if (error) throw new Error(`Queue lesen: ${String(error.message ?? error)}`)
  return (data ?? []) as AktionsZeile[]
}

/**
 * Ist Migration 20261003110000 eingespielt (Spalte ad_actions.claimed_at da)? Dann ist ein
 * „Funktion nicht gefunden“ beim Claim ein echter Fehler (z.B. falscher Parametername) und
 * darf die Ausführung nie still abschalten. Im Zweifel (anderer Fehler): ja.
 */
async function claimSpalteDa(sb: Sb): Promise<boolean> {
  try {
    const { error } = await sb.from('ad_actions').select('claimed_at').limit(1)
    return !(error && spalteFehlt(error, 'claimed_at'))
  } catch {
    return true
  }
}

/**
 * Claim per RPC werbe_aktionen_claimen(p_ids uuid[]); null = Migration 20261003110000 fehlt.
 * Ist die Migration da und der RPC trotzdem nicht aufrufbar, wirft claimen (harter Fehler).
 */
async function claimen(sb: Sb, ids: string[]): Promise<Set<string> | null> {
  if (!ids.length) return new Set()
  const { data, error } = await sb.rpc('werbe_aktionen_claimen', { p_ids: ids })
  if (error) {
    if (funktionFehlt(error) && !(await claimSpalteDa(sb))) return null
    throw new Error(`Claim (werbe_aktionen_claimen): ${String(error.message ?? error)}`)
  }
  return new Set(((data ?? []) as Array<{ id?: string }>).map(r => String(r.id ?? '')).filter(Boolean))
}

export async function ausfuehren(sb: Sb, opts: AusfuehrenOptionen): Promise<AusfuehrenErgebnis> {
  const erg: AusfuehrenErgebnis = { ausgefuehrt: 0, fehlgeschlagen: 0, uebersprungen: [] }
  if (opts.validateOnly) erg.validiert = []
  const env = metaEnv()
  if (!env.token) throw new Error('META_ACCESS_TOKEN fehlt (Supabase Secrets)')
  if ((opts.modus === 'freigabe' || opts.validateOnly) && !opts.gruppeId && !opts.ids?.length) {
    throw new Error(`${opts.validateOnly ? 'Validieren' : 'Modus freigabe'} braucht gruppeId oder ids`)
  }
  const ctx: Ctx = {
    sb, opts, erg, laufId: opts.laufId ?? crypto.randomUUID(), fn: opts.fn ?? 'werbe-ausfuehren',
    account: env.account, logAus: false,
  }

  const alle = await ladeZeilen(sb, opts)
  const passend: AktionsZeile[] = []
  for (const r of alle) {
    if (opts.validateOnly && r.status !== null && r.status !== STATUS_BESTAETIGT) {
      erg.uebersprungen.push({ id: r.id, grund: `status_${r.status}` })
    } else if (opts.validateOnly && ['verworfen', 'abgelaufen', 'veraltet'].includes(String(r.freigabe ?? ''))) {
      erg.uebersprungen.push({ id: r.id, grund: `freigabe_${r.freigabe}` })
    } else if (opts.modus === 'manuell' ? istAutopilot(r) : !istAutopilot(r)) {
      erg.uebersprungen.push({ id: r.id, grund: `nicht_im_modus_${opts.modus}` })
    } else {
      passend.push(r)
    }
  }
  if (!passend.length) return erg

  // 1 Not-Aus (kein Claim, nichts anfassen)
  if (metaWritesDisabled() && !opts.validateOnly) {
    for (const r of passend) erg.uebersprungen.push({ id: r.id, grund: 'META_WRITES_DISABLED' })
    erg.abgebrochen = 'META_WRITES_DISABLED'
    return erg
  }

  // ── manuelle Zeilen ──
  if (opts.modus === 'manuell') {
    let claimed: Set<string> | null = null
    if (!opts.validateOnly) claimed = await claimen(sb, passend.map(r => r.id))
    for (const a of passend) {
      if (claimed && !claimed.has(a.id)) { erg.uebersprungen.push({ id: a.id, grund: 'bereits_in_arbeit' }); continue }
      await manuellAusfuehren(ctx, a)
    }
    return erg
  }

  // ── Autopilot-Zeilen ──
  const st = await ladeEinstellungen(sb)
  const modusOk = ['vorschlag', 'ein_klick', 'autonom'].includes(st.autopilot_mode)
  const pausiert = st.autopilot_paused_until && Date.parse(st.autopilot_paused_until) > Date.now()
  const kandidaten: AktionsZeile[] = []
  for (const r of passend) {
    // autonome Zeilen bei gesenktem Modus: nicht liegen lassen, verarbeiteGruppe lehnt sie ab
    const gesenkt = r.freigabe === 'autonom' && st.autopilot_mode !== 'autonom'
    if (!opts.validateOnly && !gesenkt) {
      if (!modusOk) { erg.uebersprungen.push({ id: r.id, grund: `autopilot_modus_${st.autopilot_mode}` }); continue }
      if (pausiert) { erg.uebersprungen.push({ id: r.id, grund: 'autopilot_pausiert' }); continue }
      if (r.freigabe !== 'freigegeben' && r.freigabe !== 'autonom') { erg.uebersprungen.push({ id: r.id, grund: 'nicht_freigegeben' }); continue }
    }
    kandidaten.push(r)
  }

  // Gruppen bilden (ohne gruppe_id: Einzelzeile)
  const gruppen = new Map<string, AktionsZeile[]>()
  for (const r of kandidaten) {
    const key = r.gruppe_id ? `g:${r.gruppe_id}` : `e:${r.id}`
    if (!gruppen.has(key)) gruppen.set(key, [])
    gruppen.get(key)!.push(r)
  }

  // Vollständigkeit: alle offenen Mitglieder einer Gruppe müssen dabei sein
  if (!opts.validateOnly) {
    for (const [key, rows] of [...gruppen]) {
      const gid = rows[0].gruppe_id
      if (!gid) continue
      const { data, error } = await sb.from('ad_actions').select('id, status').eq('gruppe_id', gid).limit(100)
      const dabei = new Set(rows.map(r => r.id))
      const offen = ((data ?? []) as Array<{ id: string; status: string | null }>)
        .filter(m => !dabei.has(m.id) && m.status !== 'ausgeführt')
      if (error || offen.length) {
        for (const r of rows) erg.uebersprungen.push({ id: r.id, grund: error ? 'gruppe_nicht_lesbar' : 'gruppe_unvollstaendig' })
        gruppen.delete(key)
      }
    }
  }

  // 2 Claim
  let claimed: Set<string> | null = new Set()
  if (!opts.validateOnly) {
    claimed = await claimen(sb, [...gruppen.values()].flat().map(r => r.id))
    if (claimed === null) {
      for (const rows of gruppen.values()) for (const r of rows) erg.uebersprungen.push({ id: r.id, grund: 'claim_rpc_fehlt' })
      return erg
    }
  }

  const reihenfolge = [...gruppen.values()].sort((a, b) =>
    String(a[0].created_at ?? '').localeCompare(String(b[0].created_at ?? '')))
  for (const rows of reihenfolge) {
    if (!opts.validateOnly) {
      const fehlt = rows.filter(r => !claimed!.has(r.id))
      if (fehlt.length) {
        await claimsLoesen(ctx, rows.filter(r => claimed!.has(r.id)).map(r => r.id))
        for (const r of rows) erg.uebersprungen.push({ id: r.id, grund: 'bereits_in_arbeit' })
        continue
      }
    }
    if (erg.gestoppt || erg.abgebrochen) {
      await claimsLoesen(ctx, rows.map(r => r.id))
      for (const r of rows) erg.uebersprungen.push({ id: r.id, grund: erg.gestoppt ? 'autopilot_gestoppt' : `abgebrochen_${erg.abgebrochen}` })
      continue
    }
    try {
      await verarbeiteGruppe(ctx, rows, st)
    } catch (err) {
      // unerwarteter Fehler (Bug/DB): nichts weiter ausführen, Claims lösen, Autopilot stoppen
      const msg = `Ausführer-Fehler: ${errMsg(err)}`.slice(0, 300)
      console.error('[werbeAusfuehren]', msg)
      await claimsLoesen(ctx, rows.map(r => r.id))
      for (const r of rows) erg.uebersprungen.push({ id: r.id, grund: 'interner_fehler' })
      if (!opts.validateOnly) {
        await autopilotStoppen(sb, msg, { laufId: ctx.laufId })
        erg.gestoppt = msg
      }
    }
  }
  return erg
}
