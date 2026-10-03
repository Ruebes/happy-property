// Werbe-Autopilot: reine Regel-Engine (keine DB, kein Netz, keine Uhr).
//
// Eingabe: RegelKontext (Einstellungen, Regeln mit Parametern und Freigabestufen,
// Qualitätszeilen aus ad_quality_daily, Schnappschüsse aus ad_entity_snapshot,
// letzte Aktionen + Log, Vorrat, freie Termin-Slots, Kurs, Zeitpunkt `now`).
// Ausgabe: Vorschläge (je Entität eine Zeile für ad_actions bzw. das Schatten-Log),
// Stopp-Gründe (Modus fällt auf 'vorschlag') und Hinweise (Morgenmail/Log).
//
// Reihenfolge (05-automation-design §4-5, PLAN-B §3):
//   Stopps -> Sperre nach manueller Änderung (72 h) -> Lernschutz L1-L4 ->
//   K0-K4 je Kennung -> F1-F6 je Anzeige -> R1-R4 Rotation -> S1/D1/D2/D3 Budget ->
//   Freigabestufe, Aktionslimit, Idempotenz-Schlüssel.
//
// Freigabestufe = min(Regel-Stufe, Regel-Maximum, Modus-Stufe); Modus aus/schatten = 0
// (schatten protokolliert nur), vorschlag = 1, ein_klick = 2, autonom = 3.
// Zusätzliche Deckel: Zuordnungsquote < 0,8 -> K-Regeln höchstens 1; D2 höchstens 1;
// Stopp oder Pause -> höchstens 1; budget_set auf 3 nur mit budget_autonomie_freigegeben_at.
//
// `now` kommt immer von außen (testbar); innerhalb dieser Datei gibt es kein Date.now().
// Prüfung: node scripts/verify-werbe-regeln.mjs

import {
  berlinTag,
  centsZuEur,
  datumPlus,
  eurZuCents,
  gammaP,
  kennungBasis,
  kennungId,
  maxAktiveAnzeigen,
  monatsende,
  pCpteGreater,
  pCpteLess,
  posterior,
  tageZwischen,
  USD_PRO_EUR_FALLBACK,
  wochentagVonDatum,
} from './werbeMathe.ts'

// ── Typen: Eingabe ──────────────────────────────────────────────────────────

export type AutopilotModus = 'aus' | 'schatten' | 'vorschlag' | 'ein_klick' | 'autonom'
export type WerbeAktion = 'pause' | 'activate' | 'budget_set' | 'ersatz_hochladen' | 'ersatz_aktivieren'
export type RegelAktion = WerbeAktion | 'meldung'
export type Ebene = 'ad' | 'adset' | 'campaign'
export type Stufe = 0 | 1 | 2 | 3

export interface RegelSettings {
  autopilot_mode: AutopilotModus
  autopilot_paused_until?: string | null
  target_cpte_eur: number
  /** EUR, Summe aller aktiven Tagesbudgets */
  max_account_daily_budget: number
  monthly_cap_eur: number
  max_auto_actions_per_day: number
  kap_floor: number
  /** Wochentage der Änderungsfenster (0/7 = Sonntag, 1 = Montag ... 4 = Donnerstag) */
  change_window_dows: number[]
  budget_autonomie_freigegeben_at?: string | null
}

export interface RegelDef {
  rule_key: string
  aktion: RegelAktion
  enabled: boolean
  approval_level: number
  max_level: number
  params?: Record<string, unknown> | null
  version?: number | null
}

/** Zeile aus ad_quality_daily (nur die genutzten Spalten). */
export interface QualitaetZeile {
  stichtag: string
  fenster: number
  entity_level: 'ad' | 'kennung' | 'adset' | 'campaign' | 'account'
  entity_id: string
  parent_id?: string | null
  campaign_id?: string | null
  name?: string | null
  spend_eur: number
  impressions?: number | null
  link_clicks?: number | null
  leads?: number | null
  leads_kap_ja?: number | null
  booked?: number | null
  booked_kap_ja?: number | null
  held?: number | null
  te_capped?: number | null
  prior_cpte?: number | null
  alpha?: number | null
  beta?: number | null
  cpte_hat?: number | null
  p_bad?: number | null
  p_good?: number | null
  kap_ja_share_booked?: number | null
  attribution_coverage?: number | null
}

export interface LernInfo {
  status?: string | null
  /** Meta liefert Unix-Sekunden; ISO-Text und Millisekunden werden auch akzeptiert. */
  last_sig_edit_ts?: number | string | null
  conversions?: number | null
}

/** Zeile aus ad_entity_snapshot (+ optional created_time/start_time aus ad_catalog / meta_campaigns). */
export interface SnapshotZeile {
  snap_date: string
  entity_level: Ebene
  entity_id: string
  parent_id?: string | null
  campaign_id?: string | null
  name?: string | null
  status?: string | null
  effective_status?: string | null
  daily_budget_cents?: number | null
  lifetime_budget_cents?: number | null
  special_ad_categories?: string[] | null
  learning_stage_info?: LernInfo | null
  issues_info?: unknown
  ad_review_feedback?: unknown
  creative_id?: string | null
  updated_time?: string | null
  created_time?: string | null
  start_time?: string | null
  reach_7d?: number | null
  impressions_7d?: number | null
  frequency_7d?: number | null
  video_3s_7d?: number | null
  link_clicks_7d?: number | null
  spend_7d_usd?: number | null
  usd_per_eur?: number | null
  synced_at?: string | null
  /** Metas Lieferstatus „Creative fatigue“, falls separat ermittelt */
  kreativ_ermuedet?: boolean | null
}

/** Tageszeile aus ad_insights_daily (für F2-F4 und Lebensalter). */
export interface InsightTag {
  day: string
  ad_id: string
  spend_eur: number
  impressions: number
  link_clicks?: number | null
  video_3s_true?: number | null
}

/** Zeile aus ad_actions (letzte 14 Tage). */
export interface AktionZeile {
  id?: string | null
  ad_id?: string | null
  entity_id?: string | null
  entity_level?: string | null
  action: string
  status?: string | null
  origin?: string | null
  freigabe?: string | null
  rule_key?: string | null
  created_at?: string | null
  executed_at?: string | null
  window_date?: string | null
  idempotency_key?: string | null
  payload?: Record<string, unknown> | null
}

/** Zeile aus ad_autopilot_log (letzte 14 Tage). */
export interface LogZeile {
  id?: number | string | null
  ts: string
  art: string
  rule_key?: string | null
  entity_level?: string | null
  entity_id?: string | null
  aktion?: string | null
  ergebnis?: string | null
  evidence?: Record<string, unknown> | null
}

/** Zeile aus ad_creative_pool. */
export interface PoolEintrag {
  id: string
  kennung: string
  status: string
  winkel?: string | null
  hook_typ?: string | null
  format?: string | null
  released_at?: string | null
  ziel_adset_ids?: string[] | null
  /** {adset_id: ad_id} nach dem Hochladen */
  meta_ad_ids?: Record<string, string> | null
  ersetzt_kennung?: string | null
  aktiv_seit?: string | null
  fakten_pruefung?: boolean | null
  prognose?: number | null
}

export interface RegelKontext {
  /** Zeitpunkt des Laufs (ISO oder ms). Pflicht, nie Date.now() in der Engine. */
  now: string | number
  settings: RegelSettings
  rules: RegelDef[]
  qualitaet: QualitaetZeile[]
  /** Schnappschüsse heute + bis zu 3 Tage zurück */
  snapshots: SnapshotZeile[]
  insights?: InsightTag[]
  /** Frühestes Datum, ab dem `insights` vollständig sind (sonst: kleinstes day) */
  insights_ab?: string | null
  /** Kosten/TE der ersten 14 Lebenstage je Anzeige (F5): ad_id -> {spend_eur, te} */
  fruehphase?: Record<string, { spend_eur: number; te: number }>
  aktionen: AktionZeile[]
  log: LogZeile[]
  /** Eigene Schreibvorgänge bei Meta (meta_write_log, Ursprung Autopilot) */
  eigene_writes?: { entity_id: string; ts: string }[]
  vorrat: PoolEintrag[]
  freie_slots_7d: number | null
  fx: { usd_per_eur?: number | null; mittel_7d?: number | null }
  konto?: { spend_gestern_eur?: number | null; spend_7d_eur?: number | null; spend_monat_eur?: number | null }
  sync?: { letzter_erfolg?: string | null }
  meta_fehler?: { kind: string; code?: number | null; ts: string }[]
  capi_laeufe?: { ts: string; ok: boolean }[]
  /** Nur diese Kampagnen steuert der Autopilot (null/leer = alle) */
  verwaltete_kampagnen?: string[] | null
  /** Globale Parameter-Überschreibungen (Regel-Parameter haben Vorrang) */
  parameter?: Record<string, unknown> | null
}

// ── Typen: Ausgabe ──────────────────────────────────────────────────────────

export interface Evidenz {
  fenster: number
  spend_eur: number
  te: number
  alpha: number
  beta: number
  p_bad?: number
  p_good?: number
  frequency_7d?: number
  ctr_ratio?: number
  cpm_ratio?: number
  hook_ratio?: number
  coverage: number | null
  fx: number
  regeln?: string[]
  details?: Record<string, unknown>
}

export interface Vorschlag {
  rule_key: string
  rule_version: number
  aktion: WerbeAktion
  entity_level: Ebene
  entity_id: string
  entity_name: string
  /** für ad_actions.ad_id (nur Anzeigen-Ebene) */
  ad_id: string | null
  gruppe_schluessel: string
  payload: Record<string, unknown>
  before: Record<string, unknown>
  after: Record<string, unknown>
  evidence: Evidenz
  nur_im_fenster: boolean
  /** wirksame Freigabestufe 0-3 (0 = nur Schatten-Log) */
  stufe: Stufe
  freigabe: 'schatten' | 'vorgeschlagen' | 'autonom'
  /** Kalendertag Europe/Berlin */
  window_date: string
  idempotency_key: string
  /** Text für pre_state_hash = sha256(status|effective_status|daily_budget|updated_time) */
  pre_state: string
  grund: string
}

export type StoppCode =
  | 'sync_alt'
  | 'meta_auth'
  | 'meta_rate_limit'
  | 'capi_fehler'
  | 'spend_woche'
  | 'spend_tag'
  | 'kurs_fehlt'
  | 'kurs_abweichung'
  | 'zu_viele_aktionen'

export interface StoppGrund {
  code: StoppCode
  text: string
  /** alles = keine Vorschläge; budget = keine Budget-Vorschläge; autonom = nur Deckel Stufe 1 */
  sperrt: 'alles' | 'budget' | 'autonom'
  details?: Record<string, unknown>
}

export interface Hinweis {
  code: string
  text: string
  rule_key?: string
  entity_level?: Ebene
  entity_id?: string
  entity_name?: string
  details?: Record<string, unknown>
}

export interface RegelInfo {
  modus: AutopilotModus
  modus_stufe: Stufe
  datum: string
  fenstertag: boolean
  naechstes_fenster: string | null
  coverage: number | null
  usd_per_eur: number
  summe_budgets_eur: number
  heute_autonom: number
  max_aktionen: number
  modus_neu: AutopilotModus | null
}

export interface RegelErgebnis {
  vorschlaege: Vorschlag[]
  stopps: StoppGrund[]
  hinweise: Hinweis[]
  info: RegelInfo
}

// ── Parameter (Startwerte aus 05-automation-design §10) ─────────────────────

export const REGEL_STANDARD: Record<string, number | boolean> = {
  // Modell
  prior_strength_te: 1.5,
  attribution_coverage_min: 0.8,
  coverage_fenster: 14,
  // Lernschutz L1-L4
  learning_protect_hours: 72,
  /** Toleranz, damit ein Fenster 3 Tage nach dem letzten (Cron-Versatz) nicht knapp verfehlt wird */
  lernschutz_toleranz_h: 3,
  min_days_between_sig_edits: 3,
  neue_anzeigen_ab_tag: 8,
  max_new_ads_per_window: 2,
  // Manuelle Änderung
  manuell_sperre_h: 72,
  manuell_toleranz_min: 15,
  // Rotation
  min_active_ads: 4,
  eur_pro_aktive_anzeige: 20,
  max_active_ads_min: 4,
  max_active_ads_max: 10,
  gewinner_p: 0.7,
  r1b_min_hours_active: 24,
  r2_rueckblick_tage: 14,
  // Kill
  k_fenster: 0,
  k1_spend: 150,
  k2_spend: 300,
  kill_factor: 2.0,
  p_kill: 0.8,
  k3_min_spend_factor: 2,
  k4_min_age_days: 7,
  k4_spend_factor: 3,
  k4_rel_factor: 2,
  k4_p: 0.8,
  k4_gruppen_fenster: 30,
  // Ermüdung
  freq_max_7d: 3.0,
  ctr_decay: 0.7,
  cpm_rise: 1.3,
  hook_decay: 0.75,
  hook_min: 0.2,
  cpte_rise: 1.5,
  f5_min_te: 1.5,
  f5_min_age_days: 28,
  fatigue_min_age_days: 10,
  min_impressions: 3000,
  laufzeit_max_tage: 75,
  // Budget
  budget_fenster: 14,
  s1_min_booked: 3,
  p_scale: 0.8,
  s1_freq_max: 2.5,
  min_free_slots_7d: 10,
  s1_step: 0.2,
  d1_spend_factor: 3,
  d1_factor: 1.4,
  d1_p: 0.8,
  d1_step: 0.2,
  adset_min_daily_eur: 30,
  d2_spend_factor: 6,
  d2_factor: 2.5,
  d2_p: 0.9,
  min_budget_cents: 100,
  max_budget_cents: 500000,
  min_budget_delta_eur: 1,
  // Stopps
  sync_max_hours: 30,
  meta_fehler_stunden: 26,
  capi_fail_runs: 2,
  spend_week_factor: 1.1,
  spend_day_factor: 1.75,
  fx_max_deviation: 0.05,
}

/** Regeln, deren Vorschläge standardmäßig nur in Änderungsfenstern entstehen (Param nur_im_fenster). */
const FENSTER_STANDARD: Record<string, boolean> = {
  S1: true, D1: true, R1b: true, R2: true, F1: true, F2: true, F3: true, F4: true, F5: true, F6: true,
}

const MODUS_STUFE: Record<AutopilotModus, Stufe> = { aus: 0, schatten: 0, vorschlag: 1, ein_klick: 2, autonom: 3 }
const MODUS_ORDNUNG: AutopilotModus[] = ['aus', 'schatten', 'vorschlag', 'ein_klick', 'autonom']

const PAUSIERT_EFF = new Set(['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED', 'ARCHIVED', 'DELETED'])
const ABGELEHNT_EFF = new Set(['DISAPPROVED', 'WITH_ISSUES'])
const PRUEFUNG_EFF = new Set(['PENDING_REVIEW', 'IN_PROCESS', 'PENDING_BILLING_INFO'])
const STUNDE = 3600000
const TAG = 86400000

// ── Kleine Helfer (exportiert für werbe-autopilot / werbe-ausfuehren / UI-Tests) ──

/** rule:entity:window_date:aktion */
export function idempotenzSchluessel(ruleKey: string, entityId: string, windowDate: string, aktion: string): string {
  return `${ruleKey}:${entityId}:${windowDate}:${aktion}`
}

/** Text für pre_state_hash: status|effective_status|daily_budget|updated_time */
export function preStateText(z: Pick<SnapshotZeile, 'status' | 'effective_status' | 'daily_budget_cents' | 'updated_time'> | null | undefined): string {
  if (!z) return '|||'
  return `${z.status ?? ''}|${z.effective_status ?? ''}|${z.daily_budget_cents ?? ''}|${z.updated_time ?? ''}`
}

/** Wirksame Freigabestufe: min(Regel-Stufe, Regel-Maximum, Modus-Stufe). */
export function effektiveStufe(approvalLevel: number, maxLevel: number, modus: AutopilotModus): Stufe {
  const m = MODUS_STUFE[modus] ?? 0
  const v = Math.max(0, Math.min(3, Math.floor(Math.min(approvalLevel, maxLevel, m))))
  return v as Stufe
}

/** Ist der Kalendertag (Berlin) ein Änderungsfenster? dows: 0/7 = Sonntag. */
export function istFenstertag(wochentag: number, dows: number[]): boolean {
  return (dows ?? []).some(d => ((Number(d) % 7) + 7) % 7 === wochentag)
}

/** Nächster Fenstertag ab `datum` (inklusive), null wenn keine Fenster gesetzt sind. */
export function naechsterFenstertag(datum: string, dows: number[]): string | null {
  if (!dows || !dows.length) return null
  for (let i = 0; i < 8; i++) {
    const d = datumPlus(datum, i)
    if (istFenstertag(wochentagVonDatum(d), dows)) return d
  }
  return null
}

/** Niedrigerer der beiden Modi (für Stopps: nie höher als der aktuelle). */
export function modusMin(a: AutopilotModus, b: AutopilotModus): AutopilotModus {
  return MODUS_ORDNUNG.indexOf(a) <= MODUS_ORDNUNG.indexOf(b) ? a : b
}

function zeit(v: string | number | null | undefined): number {
  if (v == null || v === '') return Number.NaN
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  const n = Number(v)
  if (Number.isFinite(n) && /^\d+(\.\d+)?$/.test(v.trim())) return n < 1e12 ? n * 1000 : n
  return Date.parse(v)
}

function zahl(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN
  return Number.isFinite(n) ? n : 0
}

function rund(v: number, stellen = 4): number {
  const f = Math.pow(10, stellen)
  return Math.round(v * f) / f
}

function enthaeltFatigue(v: unknown): boolean {
  if (v == null) return false
  try {
    return /creative[\s_-]*fatigue/i.test(typeof v === 'string' ? v : JSON.stringify(v))
  } catch {
    return false
  }
}

function leer(v: unknown): boolean {
  if (v == null) return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0
  if (typeof v === 'string') return v.trim() === '' || v.trim() === '[]' || v.trim() === '{}'
  return false
}

// ── Interne Kandidaten ──────────────────────────────────────────────────────

interface Kandidat {
  rule: RegelDef
  aktion: WerbeAktion
  entity_level: Ebene
  entity_id: string
  entity_name: string
  ad_id: string | null
  gruppe: string
  payload: Record<string, unknown>
  before: Record<string, unknown>
  after: Record<string, unknown>
  evidence: Evidenz
  nur_im_fenster: boolean
  /** zusätzlicher Deckel der Freigabestufe */
  deckel: number
  prio: number
  pre_state: string
  grund: string
}

interface Stat {
  spend: number
  te: number
  booked: number
  bookedKap: number
  leadsKap: number
  alpha: number
  beta: number
  coverage: number | null
}

// ── Engine ──────────────────────────────────────────────────────────────────

export function bewerteRegeln(ctx: RegelKontext): RegelErgebnis {
  const nowMs = zeit(ctx.now)
  if (!Number.isFinite(nowMs)) throw new Error('bewerteRegeln: now fehlt oder ist ungültig')
  const s = ctx.settings
  const heute = berlinTag(nowMs)
  const dows = s.change_window_dows ?? [1, 4]
  const fenstertag = istFenstertag(heute.wochentag, dows)
  const modus: AutopilotModus = s.autopilot_mode ?? 'schatten'
  const modusStufe = MODUS_STUFE[modus] ?? 0
  const target = s.target_cpte_eur > 0 ? s.target_cpte_eur : 145

  const vorschlaege: Vorschlag[] = []
  const stopps: StoppGrund[] = []
  const hinweise: Hinweis[] = []
  const info: RegelInfo = {
    modus,
    modus_stufe: modusStufe,
    datum: heute.datum,
    fenstertag,
    naechstes_fenster: naechsterFenstertag(fenstertag ? datumPlus(heute.datum, 1) : heute.datum, dows),
    coverage: null,
    usd_per_eur: USD_PRO_EUR_FALLBACK,
    summe_budgets_eur: 0,
    heute_autonom: 0,
    max_aktionen: Math.max(0, Math.floor(zahl(s.max_auto_actions_per_day))),
    modus_neu: null,
  }

  if (modus === 'aus') {
    hinweise.push({ code: 'modus_aus', text: 'Autopilot ist aus, keine Regeln bewertet.' })
    return { vorschlaege, stopps, hinweise, info }
  }

  const regeln = new Map<string, RegelDef>()
  for (const r of ctx.rules ?? []) regeln.set(r.rule_key, r)
  const regel = (key: string): RegelDef | undefined => {
    const r = regeln.get(key)
    return r && r.enabled ? r : undefined
  }
  const P = (key: string, rule?: RegelDef): number => {
    const v = rule?.params?.[key] ?? ctx.parameter?.[key] ?? REGEL_STANDARD[key]
    const n = typeof v === 'string' ? Number(v) : v
    if (typeof n === 'number' && Number.isFinite(n)) return n
    const d = REGEL_STANDARD[key]
    return typeof d === 'number' ? d : 0
  }
  const nurImFenster = (rule: RegelDef): boolean => {
    const v = rule.params?.nur_im_fenster ?? ctx.parameter?.nur_im_fenster
    if (typeof v === 'boolean') return v
    return FENSTER_STANDARD[rule.rule_key] ?? false
  }
  const hin = (h: Hinweis) => { hinweise.push(h) }

  // ── Kurs ──────────────────────────────────────────────────────────────────
  const fxCur = ctx.fx?.usd_per_eur != null && ctx.fx.usd_per_eur > 0 ? ctx.fx.usd_per_eur : null
  const fxMit = ctx.fx?.mittel_7d != null && ctx.fx.mittel_7d > 0 ? ctx.fx.mittel_7d : null
  const fx = fxMit ?? fxCur ?? USD_PRO_EUR_FALLBACK
  info.usd_per_eur = fx
  if (fxMit == null) hin({ code: 'kurs_fallback', text: `Kein 7-Tage-Kurs, rechne mit ${rund(fx, 4)} USD je EUR.` })

  // ── Indizes: Schnappschüsse ──────────────────────────────────────────────
  const snapAktuell = new Map<string, SnapshotZeile>()
  const snapHistorie = new Map<string, SnapshotZeile[]>()
  for (const z of ctx.snapshots ?? []) {
    const key = `${z.entity_level}|${z.entity_id}`
    const alt = snapAktuell.get(key)
    if (!alt || z.snap_date > alt.snap_date || (z.snap_date === alt.snap_date && (z.synced_at ?? '') >= (alt.synced_at ?? ''))) {
      snapAktuell.set(key, z)
    }
    const h = snapHistorie.get(key) ?? []
    h.push(z)
    snapHistorie.set(key, h)
  }
  for (const h of snapHistorie.values()) h.sort((a, b) => (a.snap_date < b.snap_date ? -1 : a.snap_date > b.snap_date ? 1 : 0))
  const snap = (level: Ebene, id: string | null | undefined) => (id ? snapAktuell.get(`${level}|${id}`) : undefined)
  const alleAktuell = [...snapAktuell.values()]
  const kampagnen = alleAktuell.filter(z => z.entity_level === 'campaign')
  const adsets = alleAktuell.filter(z => z.entity_level === 'adset')
  const ads = alleAktuell.filter(z => z.entity_level === 'ad')
  const adsetVonAd = (ad: SnapshotZeile) => ad.parent_id ?? ''
  const kampagneVonAdset = (as: SnapshotZeile) => as.parent_id ?? as.campaign_id ?? ''
  const adsJeAdset = new Map<string, SnapshotZeile[]>()
  for (const a of ads) {
    const k = adsetVonAd(a)
    const l = adsJeAdset.get(k) ?? []
    l.push(a)
    adsJeAdset.set(k, l)
  }
  const adsetsJeKampagne = new Map<string, SnapshotZeile[]>()
  for (const a of adsets) {
    const k = kampagneVonAdset(a)
    const l = adsetsJeKampagne.get(k) ?? []
    l.push(a)
    adsetsJeKampagne.set(k, l)
  }
  const verwaltet = (campaignId: string | null | undefined): boolean => {
    const l = ctx.verwaltete_kampagnen
    if (!l || !l.length) return true
    return !!campaignId && l.includes(campaignId)
  }
  const objektAktiv = (z: SnapshotZeile | undefined): boolean =>
    !!z && z.status === 'ACTIVE' && !PAUSIERT_EFF.has(String(z.effective_status ?? ''))
  /** Anzeige ist eingeschaltet und nicht durch Gruppe/Kampagne pausiert (pausierbar). */
  const adKandidat = (a: SnapshotZeile) => a.status === 'ACTIVE' && !PAUSIERT_EFF.has(String(a.effective_status ?? ''))
  /** Anzeige liefert tatsächlich aus. */
  const adLiefert = (a: SnapshotZeile) => a.status === 'ACTIVE' && (a.effective_status == null || a.effective_status === 'ACTIVE')
  const kampagneAktiv = (id: string) => objektAktiv(snap('campaign', id))

  // ── Indizes: Qualität (je Schlüssel die jüngste Zeile) ───────────────────
  const qual = new Map<string, QualitaetZeile>()
  for (const z of ctx.qualitaet ?? []) {
    const key = `${z.entity_level}|${z.fenster}|${z.entity_id}`
    const alt = qual.get(key)
    if (!alt || z.stichtag > alt.stichtag) qual.set(key, z)
  }
  const q = (level: QualitaetZeile['entity_level'], fenster: number, id: string | null | undefined) =>
    (id ? qual.get(`${level}|${fenster}|${id}`) : undefined)

  // Zuordnungsquote (Konto-Ebene)
  const covFenster = P('coverage_fenster')
  let coverage: number | null = null
  for (const f of [covFenster, 14, 7, 30, 60, 0]) {
    const z = [...qual.values()].find(r => r.entity_level === 'account' && r.fenster === f && r.attribution_coverage != null)
    if (z) { coverage = zahl(z.attribution_coverage); break }
  }
  info.coverage = coverage
  const coverageOk = coverage != null && coverage >= P('attribution_coverage_min')
  if (!coverageOk) {
    hin({ code: 'coverage_niedrig', text: `Zuordnungsquote ${coverage == null ? 'unbekannt' : Math.round(coverage * 100) + ' %'}: Kill-Regeln nur als Vorschlag.`, details: { coverage } })
  }

  const statAus = (z: QualitaetZeile | undefined, priorFallback: number): Stat | null => {
    if (!z) return null
    const te = zahl(z.te_capped)
    const spend = zahl(z.spend_eur)
    let alpha = zahl(z.alpha)
    let beta = zahl(z.beta)
    if (!(alpha > 0) || !(beta > 0)) {
      const p = posterior(te, spend, z.prior_cpte != null && z.prior_cpte > 0 ? z.prior_cpte : priorFallback, P('prior_strength_te'))
      alpha = p.alpha
      beta = p.beta
    }
    return {
      spend, te, alpha, beta,
      booked: zahl(z.booked), bookedKap: zahl(z.booked_kap_ja), leadsKap: zahl(z.leads_kap_ja),
      coverage: z.attribution_coverage != null ? zahl(z.attribution_coverage) : null,
    }
  }

  // ── Insights: Lebensbeginn, Fenster-Summen ───────────────────────────────
  const insights = ctx.insights ?? []
  const insJeAd = new Map<string, InsightTag[]>()
  let letzterTag = ''
  let ersterTag = ''
  for (const r of insights) {
    const l = insJeAd.get(r.ad_id) ?? []
    l.push(r)
    insJeAd.set(r.ad_id, l)
    if (r.day > letzterTag) letzterTag = r.day
    if (!ersterTag || r.day < ersterTag) ersterTag = r.day
  }
  const insightsAb = ctx.insights_ab ?? ersterTag
  for (const l of insJeAd.values()) l.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  /** Erster Tag mit Impressionen; `sicher` = nicht durch den Datenbeginn abgeschnitten. */
  const lebensbeginn = (ad: SnapshotZeile): { tag: string | null; sicher: boolean } => {
    const l = insJeAd.get(ad.entity_id) ?? []
    const erst = l.find(r => zahl(r.impressions) > 0)?.day ?? null
    const erstellt = Number.isFinite(zeit(ad.created_time)) ? berlinTag(zeit(ad.created_time)).datum : null
    if (erst && (erst > insightsAb || (erstellt != null && erstellt >= insightsAb))) return { tag: erst, sicher: true }
    if (erst && erstellt) return { tag: erstellt < erst ? erstellt : erst, sicher: false }
    return { tag: erst ?? erstellt, sicher: false }
  }
  const summe = (adId: string, von: string, bis: string) => {
    let spend = 0, impr = 0, klicks = 0, v3 = 0
    for (const r of insJeAd.get(adId) ?? []) {
      if (r.day < von || r.day > bis) continue
      spend += zahl(r.spend_eur); impr += zahl(r.impressions); klicks += zahl(r.link_clicks); v3 += zahl(r.video_3s_true)
    }
    return { spend, impr, klicks, v3 }
  }
  const cpmMedian = (von: string, bis: string): number | null => {
    const werte: number[] = []
    for (const adId of insJeAd.keys()) {
      const x = summe(adId, von, bis)
      if (x.impr > 0 && x.spend > 0) werte.push((x.spend / x.impr) * 1000)
    }
    if (!werte.length) return null
    werte.sort((a, b) => a - b)
    const m = Math.floor(werte.length / 2)
    return werte.length % 2 ? werte[m] : (werte[m - 1] + werte[m]) / 2
  }

  // ── Aktionen/Log: eigene Schreibvorgänge, Zähler ─────────────────────────
  const aktionen = ctx.aktionen ?? []
  const log = ctx.log ?? []
  const ausgefuehrt = (a: AktionZeile) => a.status === 'ausgeführt'
  const zielId = (a: AktionZeile) => String(a.entity_id ?? a.ad_id ?? '')
  const toleranz = P('manuell_toleranz_min') * 60000
  const eigeneSchreibzeiten = (id: string): number[] => {
    const t: number[] = []
    for (const a of aktionen) if (a.origin === 'autopilot' && ausgefuehrt(a) && zielId(a) === id) t.push(zeit(a.executed_at))
    for (const l of log) if ((l.art === 'ausfuehrung' || l.art === 'ruecklesen') && l.entity_id === id) t.push(zeit(l.ts))
    for (const w of ctx.eigene_writes ?? []) if (w.entity_id === id) t.push(zeit(w.ts))
    return t.filter(Number.isFinite)
  }

  // Autonome Aktionen heute (Berlin-Tag)
  const heuteAutonom = aktionen.filter(a =>
    a.origin === 'autopilot' && a.freigabe === 'autonom' &&
    (a.status === 'bestätigt' || a.status === 'ausgeführt' || a.status === 'fehlgeschlagen') &&
    Number.isFinite(zeit(a.executed_at ?? a.created_at)) && berlinTag(zeit(a.executed_at ?? a.created_at)).datum === heute.datum,
  ).length
  info.heute_autonom = heuteAutonom
  const vorhandeneSchluessel = new Set(aktionen.map(a => a.idempotency_key).filter((k): k is string => !!k))

  // ── 1. Stopps ────────────────────────────────────────────────────────────
  const stopp = (g: StoppGrund) => { stopps.push(g) }
  {
    let syncMs = zeit(ctx.sync?.letzter_erfolg)
    if (!Number.isFinite(syncMs)) {
      for (const z of ctx.snapshots ?? []) {
        const t = zeit(z.synced_at)
        if (Number.isFinite(t) && (!Number.isFinite(syncMs) || t > syncMs)) syncMs = t
      }
    }
    const maxH = P('sync_max_hours')
    if (!Number.isFinite(syncMs) || nowMs - syncMs > maxH * STUNDE) {
      stopp({
        code: 'sync_alt', sperrt: 'alles',
        text: Number.isFinite(syncMs) ? `Letzter Sync vor ${Math.round((nowMs - syncMs) / STUNDE)} h (Grenze ${maxH} h).` : 'Kein erfolgreicher Sync bekannt.',
        details: { letzter_sync: Number.isFinite(syncMs) ? new Date(syncMs).toISOString() : null },
      })
    }
    const fehlerFenster = P('meta_fehler_stunden') * STUNDE
    const frisch = (ctx.meta_fehler ?? []).filter(f => nowMs - zeit(f.ts) <= fehlerFenster)
    const auth = frisch.filter(f => f.kind === 'auth' || f.kind === 'permission' || f.kind === 'dev_mode')
    if (auth.length) stopp({ code: 'meta_auth', sperrt: 'alles', text: `Meta-Zugriff gestört (${auth.map(f => f.code ?? f.kind).join(', ')}).`, details: { fehler: auth } })
    const rate = frisch.filter(f => f.kind === 'rate_limit')
    if (rate.length) stopp({ code: 'meta_rate_limit', sperrt: 'autonom', text: 'Meta-Ratenlimit erreicht.', details: { fehler: rate } })
    const runs = Math.max(1, Math.floor(P('capi_fail_runs')))
    const capi = [...(ctx.capi_laeufe ?? [])].sort((a, b) => zeit(b.ts) - zeit(a.ts)).slice(0, runs)
    if (capi.length >= runs && capi.every(c => !c.ok)) stopp({ code: 'capi_fehler', sperrt: 'autonom', text: `CAPI ${runs} Läufe in Folge fehlerhaft.` })
  }

  // Summe aktiver Tagesbudgets (EUR) je Schnappschuss-Tag, Konto gesamt
  const budgetSummeEur = (zeilen: SnapshotZeile[]): number => {
    let cents = 0
    for (const c of zeilen) {
      if (c.entity_level !== 'campaign' || !objektAktiv(c)) continue
      if (zahl(c.daily_budget_cents) > 0) { cents += zahl(c.daily_budget_cents); continue }
      for (const a of zeilen) {
        if (a.entity_level === 'adset' && (a.parent_id ?? a.campaign_id) === c.entity_id && objektAktiv(a)) cents += zahl(a.daily_budget_cents)
      }
    }
    return centsZuEur(cents, fx)
  }
  const summeAktuellEur = budgetSummeEur(alleAktuell)
  info.summe_budgets_eur = rund(summeAktuellEur, 2)
  {
    const tage = new Map<string, SnapshotZeile[]>()
    for (const z of ctx.snapshots ?? []) {
      const l = tage.get(z.snap_date) ?? []
      l.push(z)
      tage.set(z.snap_date, l)
    }
    const summen = [...tage.values()].map(budgetSummeEur)
    const maxSumme = Math.max(summeAktuellEur, ...summen, 0)
    const woche = ctx.konto?.spend_7d_eur
    const gestern = ctx.konto?.spend_gestern_eur
    if (maxSumme > 0 && woche != null && woche > 7 * maxSumme * P('spend_week_factor')) {
      stopp({ code: 'spend_woche', sperrt: 'budget', text: `Wochen-Spend ${Math.round(woche)} € über 7 x Budgets x ${P('spend_week_factor')}.`, details: { woche, summe_budgets_eur: rund(maxSumme, 2) } })
    }
    if (maxSumme > 0 && gestern != null && gestern > P('spend_day_factor') * maxSumme) {
      stopp({ code: 'spend_tag', sperrt: 'budget', text: `Tages-Spend ${Math.round(gestern)} € über ${P('spend_day_factor')} x Budgets.`, details: { gestern, summe_budgets_eur: rund(maxSumme, 2) } })
    }
    if (fxCur == null && fxMit == null) {
      stopp({ code: 'kurs_fehlt', sperrt: 'budget', text: 'Kein USD/EUR-Kurs vorhanden.' })
    } else if (fxCur != null && fxMit != null && Math.abs(fxCur - fxMit) / fxMit > P('fx_max_deviation')) {
      stopp({ code: 'kurs_abweichung', sperrt: 'budget', text: `Kurs ${rund(fxCur, 4)} weicht mehr als ${Math.round(P('fx_max_deviation') * 100)} % vom 7-Tage-Mittel ${rund(fxMit, 4)} ab.`, details: { aktuell: fxCur, mittel_7d: fxMit } })
    }
    if (heuteAutonom > info.max_aktionen) {
      stopp({ code: 'zu_viele_aktionen', sperrt: 'autonom', text: `${heuteAutonom} autonome Aktionen heute (Grenze ${info.max_aktionen}).` })
    }
  }
  const sperrtAlles = stopps.some(g => g.sperrt === 'alles')
  const sperrtBudget = stopps.some(g => g.sperrt === 'budget' || g.sperrt === 'alles')
  if (stopps.length) info.modus_neu = modusMin(modus, 'vorschlag')
  const pausiert = Number.isFinite(zeit(s.autopilot_paused_until)) && zeit(s.autopilot_paused_until) > nowMs
  if (pausiert) hin({ code: 'pausiert', text: `Autopilot pausiert bis ${s.autopilot_paused_until}: höchstens Vorschläge.` })

  // ── 2. Sperre nach manueller Änderung (72 h) ─────────────────────────────
  const manuellCache = new Map<string, { bis: number; updated: string } | null>()
  const manuellGesperrt = (z: SnapshotZeile | undefined): { bis: number; updated: string } | null => {
    if (!z) return null
    const key = `${z.entity_level}|${z.entity_id}`
    if (manuellCache.has(key)) return manuellCache.get(key) ?? null
    let erg: { bis: number; updated: string } | null = null
    const u = zeit(z.updated_time)
    if (Number.isFinite(u) && nowMs - u < P('manuell_sperre_h') * STUNDE) {
      const c = zeit(z.created_time)
      const anlage = Number.isFinite(c) && Math.abs(u - c) <= toleranz
      const eigen = eigeneSchreibzeiten(z.entity_id).some(t => Math.abs(t - u) <= toleranz)
      if (!anlage && !eigen) {
        erg = { bis: u + P('manuell_sperre_h') * STUNDE, updated: String(z.updated_time) }
        const schonGeloggt = log.some(l => l.art === 'manuell_erkannt' && l.entity_id === z.entity_id && (l.evidence?.updated_time ?? null) === z.updated_time)
        hin({
          code: 'manuell_erkannt', entity_level: z.entity_level, entity_id: z.entity_id, entity_name: z.name ?? z.entity_id,
          text: `Von Hand geändert (${z.updated_time}), für die Automatik gesperrt bis ${new Date(erg.bis).toISOString()}.`,
          details: { updated_time: z.updated_time, gesperrt_bis: new Date(erg.bis).toISOString(), neu: !schonGeloggt },
        })
      }
    }
    manuellCache.set(key, erg)
    return erg
  }
  // Alle Objekte der verwalteten Kampagnen einmal prüfen, damit jede erkannte Handänderung geloggt wird
  for (const z of alleAktuell.slice().sort((a, b) => (`${a.entity_level}${a.entity_id}` < `${b.entity_level}${b.entity_id}` ? -1 : 1))) {
    const camp = z.entity_level === 'campaign' ? z.entity_id : z.entity_level === 'adset' ? kampagneVonAdset(z) : z.campaign_id
    if (verwaltet(camp)) manuellGesperrt(z)
  }

  // ── 3. Lernschutz ───────────────────────────────────────────────────────
  const SIG_AKTIONEN = new Set(['activate', 'ersatz_aktivieren', 'budget_set'])
  const adsetDerAktion = (a: AktionZeile): string | null => {
    if (a.entity_level === 'adset') return zielId(a)
    if (a.entity_level === 'campaign') return null
    const p = a.payload?.adset_id
    if (typeof p === 'string' && p) return p
    const ad = snap('ad', zielId(a))
    return ad ? adsetVonAd(ad) : null
  }
  /** Letzte wesentliche Änderung (ms) je Anzeigengruppe: learning_stage_info + eigene Aktionen. */
  const letzteSigEdit = (adsetId: string): number => {
    const asSnap = snap('adset', adsetId)
    const eigeneKampagne = asSnap ? kampagneVonAdset(asSnap) : null
    let t = zeit(asSnap?.learning_stage_info?.last_sig_edit_ts ?? null)
    for (const a of aktionen) {
      if (!ausgefuehrt(a) || !SIG_AKTIONEN.has(a.action)) continue
      const as = adsetDerAktion(a)
      const camp = a.entity_level === 'campaign' ? zielId(a) : null
      const passt = as === adsetId || (camp != null && eigeneKampagne === camp)
      if (!passt) continue
      const e = zeit(a.executed_at)
      if (Number.isFinite(e) && (!Number.isFinite(t) || e > t)) t = e
    }
    return t
  }
  /** L1: true, wenn die Anzeigengruppe im Lernschutz ist (72 h nach wesentlicher Änderung). */
  const lernschutz = (adsetId: string): { bis: number } | null => {
    const t = letzteSigEdit(adsetId)
    if (!Number.isFinite(t)) return null
    const fenster = (P('learning_protect_hours') - P('lernschutz_toleranz_h')) * STUNDE
    return nowMs - t < fenster ? { bis: t + P('learning_protect_hours') * STUNDE } : null
  }
  /** L2: Abstand in Kalendertagen seit der letzten wesentlichen Änderung. */
  const tageSeitSig = (adsetId: string): number | null => {
    const t = letzteSigEdit(adsetId)
    if (!Number.isFinite(t)) return null
    return tageZwischen(berlinTag(t).datum, heute.datum)
  }
  /** L3: Kampagnenalter in Tagen (Tag 1 = Starttag). */
  const kampagnenTag = (campaignId: string): number | null => {
    const c = snap('campaign', campaignId)
    let start = zeit(c?.start_time ?? c?.created_time ?? null)
    if (!Number.isFinite(start)) {
      for (const as of adsetsJeKampagne.get(campaignId) ?? []) {
        for (const ad of adsJeAdset.get(as.entity_id) ?? []) {
          const lb = lebensbeginn(ad).tag
          const t = lb ? Date.parse(`${lb}T12:00:00Z`) : zeit(ad.created_time)
          if (Number.isFinite(t) && (!Number.isFinite(start) || t < start)) start = t
        }
      }
    }
    if (!Number.isFinite(start)) return null
    return tageZwischen(berlinTag(start).datum, heute.datum) + 1
  }

  // Wesentliche Änderungen (Aktivierungen) in diesem Fenster je Anzeigengruppe
  const neueImFenster = new Map<string, number>()
  for (const a of aktionen) {
    if (a.action !== 'activate' && a.action !== 'ersatz_aktivieren') continue
    if (a.status === 'abgelehnt' || a.status === 'fehlgeschlagen') continue
    if (a.freigabe === 'verworfen' || a.freigabe === 'abgelaufen' || a.freigabe === 'veraltet') continue
    const wd = a.window_date ?? (Number.isFinite(zeit(a.executed_at ?? a.created_at)) ? berlinTag(zeit(a.executed_at ?? a.created_at)).datum : '')
    if (wd !== heute.datum) continue
    const as = adsetDerAktion(a)
    if (as) neueImFenster.set(as, (neueImFenster.get(as) ?? 0) + 1)
  }

  // ── Kandidaten sammeln ──────────────────────────────────────────────────
  const kandidaten: Kandidat[] = []
  const geplantePause = new Set<string>()
  const geplanteAktivierung = new Map<string, number>() // adset -> Anzahl
  /** Aktivierungen je Vorrat + Gruppe (ein Werbemittel liegt bei Plan B in A und B) */
  const genutzteAktivierung = new Set<string>()
  /** Vorratseinträge, die in diesem Lauf hochgeladen werden */
  const genutzterUpload = new Set<string>()
  const lieferndeNach = (adsetId: string): number =>
    (adsJeAdset.get(adsetId) ?? []).filter(a => adLiefert(a) && !geplantePause.has(a.entity_id)).length
  const evidenzAus = (st: Stat | null, fenster: number, extra: Partial<Evidenz> = {}): Evidenz => ({
    fenster,
    spend_eur: rund(st?.spend ?? 0, 2),
    te: rund(st?.te ?? 0, 3),
    alpha: rund(st?.alpha ?? 0, 4),
    beta: rund(st?.beta ?? 0, 2),
    coverage,
    fx: rund(fx, 4),
    ...extra,
  })
  /** Sperren für das Pausieren einer Anzeige: Handänderung an der Anzeige, Lernschutz der Gruppe. */
  const kSperre = (ad: SnapshotZeile): string | null => {
    if (manuellGesperrt(ad)) return 'manuell_gesperrt'
    if (lernschutz(adsetVonAd(ad))) return 'lernschutz'
    return null
  }
  const pauseKandidat = (ad: SnapshotZeile, rule: RegelDef, gruppe: string, ev: Evidenz, grund: string, prio: number, deckel = 3): boolean => {
    if (geplantePause.has(ad.entity_id)) return false
    if (adLiefert(ad) && lieferndeNach(adsetVonAd(ad)) <= 1) {
      hin({
        code: 'letzte_aktive_anzeige', rule_key: rule.rule_key, entity_level: 'ad', entity_id: ad.entity_id, entity_name: ad.name ?? ad.entity_id,
        text: `${rule.rule_key}: ${ad.name ?? ad.entity_id} ist die letzte aktive Anzeige der Gruppe und wird nicht pausiert. ${grund}`,
      })
      return false
    }
    geplantePause.add(ad.entity_id)
    kandidaten.push({
      rule, aktion: 'pause', entity_level: 'ad', entity_id: ad.entity_id, entity_name: ad.name ?? ad.entity_id, ad_id: ad.entity_id,
      gruppe, payload: { status: 'PAUSED', adset_id: adsetVonAd(ad), campaign_id: ad.campaign_id ?? null },
      before: { status: ad.status ?? null, effective_status: ad.effective_status ?? null },
      after: { status: 'PAUSED' },
      evidence: ev, nur_im_fenster: nurImFenster(rule), deckel, prio, pre_state: preStateText(ad), grund,
    })
    return true
  }

  // ── 4. K0-K4 je Kennung ──────────────────────────────────────────────────
  const K0 = regel('K0')
  const k0Adsets = new Set<string>()
  if (K0) {
    for (const ad of ads) {
      if (!verwaltet(ad.campaign_id) || ad.status !== 'ACTIVE') continue
      if (!ABGELEHNT_EFF.has(String(ad.effective_status ?? ''))) continue
      k0Adsets.add(adsetVonAd(ad))
      hin({
        code: 'K0', rule_key: 'K0', entity_level: 'ad', entity_id: ad.entity_id, entity_name: ad.name ?? ad.entity_id,
        text: `Anzeige ${ad.name ?? ad.entity_id} ist ${ad.effective_status}: prüfen, Ersatz aus dem Vorrat ist vorgemerkt.`,
        details: { effective_status: ad.effective_status, ad_review_feedback: ad.ad_review_feedback ?? null, issues_info: ad.issues_info ?? null },
      })
    }
  }

  const kennungAds = new Map<string, SnapshotZeile[]>()
  for (const ad of ads) {
    const k = kennungId(ad.campaign_id, ad.name)
    const l = kennungAds.get(k) ?? []
    l.push(ad)
    kennungAds.set(k, l)
  }
  const kFenster = P('k_fenster')
  const kRegeln = ['K1', 'K2', 'K3', 'K4'].map(k => regel(k)).filter((r): r is RegelDef => !!r)
  const kZeilen = [...qual.values()]
    .filter(z => z.entity_level === 'kennung' && z.fenster === kFenster)
    .sort((a, b) => (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0))
  const kGefeuert = new Set<string>() // Kennungs-IDs mit K-Treffer
  if (kRegeln.length) {
    for (const z of kZeilen) {
      const camp = z.campaign_id ?? z.entity_id.split(':')[0]
      if (!verwaltet(camp)) continue
      const kandidatAds = (kennungAds.get(z.entity_id) ?? []).filter(adKandidat)
      if (!kandidatAds.length) continue
      const st = statAus(z, target)
      if (!st) continue
      const treffer: { rule: RegelDef; grund: string; p?: number }[] = []
      const K1 = regel('K1'), K2 = regel('K2'), K3 = regel('K3'), K4 = regel('K4')
      if (K1 && st.spend >= P('k1_spend', K1) && st.booked === 0 && st.leadsKap === 0) {
        treffer.push({ rule: K1, grund: `${Math.round(st.spend)} € ohne Termin und ohne Lead mit Kapitalbasis Ja (Grenze ${P('k1_spend', K1)} €).` })
      }
      if (K2 && st.spend >= P('k2_spend', K2) && st.booked === 0) {
        treffer.push({ rule: K2, grund: `${Math.round(st.spend)} € ohne gebuchten Termin (Grenze ${P('k2_spend', K2)} €).` })
      }
      let pBadK3: number | undefined
      if (K3 && st.spend >= P('k3_min_spend_factor', K3) * target) {
        pBadK3 = pCpteGreater(st.alpha, st.beta, P('kill_factor', K3) * target)
        if (pBadK3 >= P('p_kill', K3)) {
          treffer.push({ rule: K3, p: pBadK3, grund: `P(Kosten/TE > ${Math.round(P('kill_factor', K3) * target)} €) = ${Math.round(pBadK3 * 100)} %.` })
        }
      }
      let pRel: number | undefined
      if (K4 && st.spend >= P('k4_spend_factor', K4) * target) {
        let start = ''
        for (const ad of kennungAds.get(z.entity_id) ?? []) {
          const lb = lebensbeginn(ad).tag
          if (lb && (!start || lb < start)) start = lb
        }
        const alter = start ? tageZwischen(start, heute.datum) : -1
        const gf = P('k4_gruppen_fenster', K4)
        const ref = (z.parent_id ? q('adset', gf, z.parent_id) ?? q('campaign', gf, z.parent_id) : undefined) ?? q('campaign', gf, camp)
        const refStat = statAus(ref, target)
        const refCpte = ref && zahl(ref.cpte_hat) > 0 ? zahl(ref.cpte_hat) : refStat ? refStat.beta / refStat.alpha : 0
        if (alter >= P('k4_min_age_days', K4) && refCpte > 0) {
          pRel = gammaP(st.alpha, st.beta / (P('k4_rel_factor', K4) * refCpte))
          if (pRel >= P('k4_p', K4)) {
            treffer.push({ rule: K4, p: pRel, grund: `P(Kosten/TE > ${P('k4_rel_factor', K4)} x Gruppe ${Math.round(refCpte)} €) = ${Math.round(pRel * 100)} %.` })
          }
        }
      }
      if (!treffer.length) continue
      kGefeuert.add(z.entity_id)
      // Primärregel: höchste Freigabestufe (jede Regel rechtfertigt die Pause für sich), sonst Reihenfolge
      const primaer = treffer.reduce((a, b) => (Math.min(b.rule.approval_level, b.rule.max_level) > Math.min(a.rule.approval_level, a.rule.max_level) ? b : a))
      const ev = evidenzAus(st, kFenster, {
        p_bad: rund(pBadK3 ?? pCpteGreater(st.alpha, st.beta, P('kill_factor') * target), 4),
        p_good: rund(pCpteLess(st.alpha, st.beta, target), 4),
        regeln: treffer.map(t => t.rule.rule_key),
        details: { kennung: z.entity_id, booked: st.booked, leads_kap_ja: st.leadsKap, p_rel: pRel != null ? rund(pRel, 4) : null },
      })
      const gruppe = `${primaer.rule.rule_key}:${z.entity_id}:${heute.datum}`
      for (const ad of kandidatAds.sort((a, b) => (a.entity_id < b.entity_id ? -1 : 1))) {
        const sperre = kSperre(ad)
        if (sperre) {
          hin({ code: sperre, rule_key: primaer.rule.rule_key, entity_level: 'ad', entity_id: ad.entity_id, entity_name: ad.name ?? ad.entity_id, text: `${primaer.rule.rule_key} würde pausieren, aber ${sperre === 'lernschutz' ? 'Lernschutz (72 h)' : 'von Hand gesteuert'}: ${primaer.grund}` })
          continue
        }
        pauseKandidat(ad, primaer.rule, gruppe, ev, primaer.grund, 10, coverageOk ? 3 : 1)
      }
    }
  }

  // ── 5. F1-F6 Ermüdung je Anzeige ─────────────────────────────────────────
  interface Muede { ad: SnapshotZeile; rule: RegelDef; regeln: string[]; ev: Evidenz; grund: string }
  const ermuedet: Muede[] = []
  const fRegeln = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].map(k => regel(k)).filter((r): r is RegelDef => !!r)
  const laufzeitBedarf = new Set<string>()
  {
    for (const ad of ads.slice().sort((a, b) => (a.entity_id < b.entity_id ? -1 : 1))) {
      if (!adLiefert(ad) || !verwaltet(ad.campaign_id) || geplantePause.has(ad.entity_id)) continue
      const lb = lebensbeginn(ad)
      if (!lb.tag) continue
      const alter = tageZwischen(lb.tag, heute.datum)
      if (alter > P('laufzeit_max_tage')) {
        laufzeitBedarf.add(adsetVonAd(ad))
        hin({ code: 'laufzeit_lang', entity_level: 'ad', entity_id: ad.entity_id, entity_name: ad.name ?? ad.entity_id, text: `${ad.name ?? ad.entity_id} läuft seit ${alter} Tagen: Ersatz vorbereiten.` })
      }
      if (!fRegeln.length || alter < P('fatigue_min_age_days')) continue
      const fired: string[] = []
      const ev: Partial<Evidenz> = {}
      const F1 = regel('F1'), F2 = regel('F2'), F3 = regel('F3'), F4 = regel('F4'), F5 = regel('F5'), F6 = regel('F6')
      const freq = ad.frequency_7d != null ? zahl(ad.frequency_7d) : null
      if (freq != null) ev.frequency_7d = rund(freq, 3)
      if (F1 && freq != null && freq > P('freq_max_7d', F1)) fired.push('F1')
      // Baseline = Lebenstage 2-8, Vergleich = letzte 7 Tage
      if ((F2 || F3 || F4) && lb.sicher && letzterTag) {
        const bVon = datumPlus(lb.tag, 1), bBis = datumPlus(lb.tag, 7)
        const vVon = datumPlus(letzterTag, -6), vBis = letzterTag
        const b = summe(ad.entity_id, bVon, bBis)
        const v = summe(ad.entity_id, vVon, vBis)
        const minImpr = P('min_impressions')
        if (b.impr >= minImpr && v.impr >= minImpr) {
          const ctrB = b.klicks / b.impr, ctrV = v.klicks / v.impr
          if (ctrB > 0) {
            ev.ctr_ratio = rund(ctrV / ctrB, 4)
            if (F2 && ctrV < P('ctr_decay', F2) * ctrB) fired.push('F2')
          }
          const mB = cpmMedian(bVon, bBis), mV = cpmMedian(vVon, vBis)
          if (mB && mV && b.spend > 0 && v.spend > 0) {
            const rB = ((b.spend / b.impr) * 1000) / mB, rV = ((v.spend / v.impr) * 1000) / mV
            ev.cpm_ratio = rund(rV / rB, 4)
            if (F3 && rV > P('cpm_rise', F3) * rB) fired.push('F3')
          }
          if (b.v3 > 0) {
            const hB = b.v3 / b.impr, hV = v.v3 / v.impr
            ev.hook_ratio = rund(hV / hB, 4)
            if (F4 && (hV < P('hook_decay', F4) * hB || hV < P('hook_min', F4))) fired.push('F4')
          }
        }
      }
      if (F5 && alter >= P('f5_min_age_days', F5)) {
        const jetzt = q('ad', 14, ad.entity_id)
        const frueh = ctx.fruehphase?.[ad.entity_id]
        const minTe = P('f5_min_te', F5)
        if (jetzt && frueh && zahl(jetzt.te_capped) >= minTe && zahl(frueh.te) >= minTe) {
          const cJ = zahl(jetzt.spend_eur) / zahl(jetzt.te_capped), cF = zahl(frueh.spend_eur) / zahl(frueh.te)
          if (cF > 0 && cJ > P('cpte_rise', F5) * cF) fired.push('F5')
        }
      }
      if (F6 && (ad.kreativ_ermuedet === true || enthaeltFatigue(ad.issues_info) || enthaeltFatigue(ad.ad_review_feedback))) fired.push('F6')
      const zwei = fired.filter(f => f === 'F2' || f === 'F3' || f === 'F4' || f === 'F5')
      const istMuede = fired.includes('F1') || fired.includes('F6') || zwei.length >= 2
      if (!istMuede) continue
      let rule: RegelDef | undefined
      if (fired.includes('F1')) rule = F1
      else if (fired.includes('F6')) rule = F6
      else rule = zwei.map(k => regel(k)).filter((r): r is RegelDef => !!r).sort((a, b) => Math.min(a.approval_level, a.max_level) - Math.min(b.approval_level, b.max_level))[0]
      if (!rule) continue
      const st7 = statAus(q('ad', 7, ad.entity_id), target)
      ermuedet.push({
        ad, rule, regeln: fired,
        ev: evidenzAus(st7, 7, { ...ev, regeln: fired, details: { alter_tage: alter } }),
        grund: `Ermüdet (${fired.join(', ')}), Lebensalter ${alter} Tage.`,
      })
    }
  }

  // ── 6. R1-R4 Rotation ───────────────────────────────────────────────────
  const vorrat = ctx.vorrat ?? []
  const poolJeKennung = new Map<string, PoolEintrag>()
  for (const p of vorrat) poolJeKennung.set(p.kennung, p)
  const reviewOk = (a: SnapshotZeile | undefined) =>
    !!a && !ABGELEHNT_EFF.has(String(a.effective_status ?? '')) && !PRUEFUNG_EFF.has(String(a.effective_status ?? '')) &&
    leer(a.ad_review_feedback) && leer(a.issues_info)
  const imReview = (a: SnapshotZeile | undefined) => !!a && PRUEFUNG_EFF.has(String(a.effective_status ?? ''))
  /** Hochgeladener, geprüfter, pausierter Ersatz für eine Gruppe (gleicher Winkel bevorzugt). */
  const ersatzFuer = (adsetId: string, winkel: string | null): { pool: PoolEintrag; ad: SnapshotZeile } | null => {
    const liste: { pool: PoolEintrag; ad: SnapshotZeile }[] = []
    for (const p of vorrat) {
      if (p.status !== 'hochgeladen' || genutzteAktivierung.has(`${p.id}|${adsetId}`)) continue
      const adId = p.meta_ad_ids?.[adsetId]
      const a = snap('ad', adId)
      if (!a || a.status === 'ACTIVE' || !reviewOk(a) || manuellGesperrt(a)) continue
      liste.push({ pool: p, ad: a })
    }
    liste.sort((x, y) => {
      const wx = winkel && x.pool.winkel === winkel ? 0 : 1
      const wy = winkel && y.pool.winkel === winkel ? 0 : 1
      if (wx !== wy) return wx - wy
      const rx = x.pool.released_at ?? '', ry = y.pool.released_at ?? ''
      if (rx !== ry) return rx < ry ? -1 : 1
      return x.pool.id < y.pool.id ? -1 : 1
    })
    return liste[0] ?? null
  }
  const uploadsImReview = (adsetId: string) =>
    vorrat.filter(p => p.status === 'hochgeladen' && imReview(snap('ad', p.meta_ad_ids?.[adsetId]))).length
  const maxAktiv = (adsetId: string): number => {
    const as = snap('adset', adsetId)
    let eur = centsZuEur(zahl(as?.daily_budget_cents), fx)
    if (!(eur > 0) && as) {
      const c = snap('campaign', kampagneVonAdset(as))
      const n = (adsetsJeKampagne.get(kampagneVonAdset(as)) ?? []).filter(objektAktiv).length || 1
      eur = centsZuEur(zahl(c?.daily_budget_cents), fx) / n
    }
    return maxAktiveAnzeigen(eur, P('eur_pro_aktive_anzeige'), P('max_active_ads_min'), P('max_active_ads_max'))
  }
  /** Warum eine neue Anzeige in dieser Gruppe heute nicht live gehen darf (L1-L3, Sperren). */
  const neuSperre = (adsetId: string, rule: RegelDef): string | null => {
    const as = snap('adset', adsetId)
    if (!as) return 'unbekannte_gruppe'
    if (nurImFenster(rule) && !fenstertag) return 'wartet_auf_fenster'
    if (manuellGesperrt(as)) return 'manuell_gesperrt'
    if (lernschutz(adsetId)) return 'lernschutz'
    const t = tageSeitSig(adsetId)
    if (t != null && t < P('min_days_between_sig_edits')) return 'aenderungsabstand'
    const kt = kampagnenTag(kampagneVonAdset(as))
    if (kt == null || kt < P('neue_anzeigen_ab_tag')) return 'kampagne_zu_jung'
    return null
  }
  const SPERRTEXT: Record<string, string> = {
    wartet_auf_fenster: `wartet auf das nächste Änderungsfenster (${info.naechstes_fenster ?? 'keins gesetzt'})`,
    manuell_gesperrt: 'Gruppe von Hand gesteuert (72 h)',
    lernschutz: 'Lernschutz (72 h nach wesentlicher Änderung)',
    aenderungsabstand: `weniger als ${P('min_days_between_sig_edits')} Tage seit der letzten wesentlichen Änderung`,
    kampagne_zu_jung: `Kampagne jünger als Tag ${P('neue_anzeigen_ab_tag')}`,
    max_neu: `schon ${P('max_new_ads_per_window')} neue Anzeigen in diesem Fenster`,
    max_aktiv: 'Höchstzahl aktiver Anzeigen erreicht',
    unbekannte_gruppe: 'Anzeigengruppe nicht im Schnappschuss',
  }
  const uploadBedarf = new Map<string, number>()
  const aktivierung = (adsetId: string, rule: RegelDef, ev: Evidenz, grund: string, winkel: string | null, ersetzt: SnapshotZeile | null, overlap: number): 'ok' | 'kein_ersatz' | string => {
    const sperre = neuSperre(adsetId, rule)
    const schon = (neueImFenster.get(adsetId) ?? 0) + (geplanteAktivierung.get(adsetId) ?? 0)
    if (!sperre && schon >= P('max_new_ads_per_window')) return 'max_neu'
    if (!sperre && lieferndeNach(adsetId) + (geplanteAktivierung.get(adsetId) ?? 0) - overlap >= maxAktiv(adsetId)) return 'max_aktiv'
    const e = ersatzFuer(adsetId, winkel)
    if (!e) return 'kein_ersatz'
    if (sperre) return sperre
    genutzteAktivierung.add(`${e.pool.id}|${adsetId}`)
    geplanteAktivierung.set(adsetId, (geplanteAktivierung.get(adsetId) ?? 0) + 1)
    kandidaten.push({
      rule, aktion: 'ersatz_aktivieren', entity_level: 'ad', entity_id: e.ad.entity_id, entity_name: e.ad.name ?? e.pool.kennung, ad_id: e.ad.entity_id,
      gruppe: `${rule.rule_key}:${adsetId}:${heute.datum}`,
      payload: {
        status: 'ACTIVE', pool_id: e.pool.id, kennung: e.pool.kennung, adset_id: adsetId, campaign_id: e.ad.campaign_id ?? null,
        ersetzt_ad_id: ersetzt?.entity_id ?? null, ersetzt_kennung: ersetzt ? kennungBasis(ersetzt.name) : null,
      },
      before: { status: e.ad.status ?? null, effective_status: e.ad.effective_status ?? null },
      after: { status: 'ACTIVE' },
      evidence: ev, nur_im_fenster: nurImFenster(rule), deckel: 3, prio: 30, pre_state: preStateText(e.ad), grund,
    })
    return 'ok'
  }

  // R1: ermüdete Anzeige -> Ersatz im Fenster; R1b: alte Anzeige nach 24 h ACTIVE des Ersatzes pausieren
  const ersatzLaeuft = new Set<string>() // `${adset}|${kennungBasis}`
  for (const p of vorrat) {
    if (p.status !== 'aktiv' || !p.ersetzt_kennung) continue
    for (const adsetId of Object.keys(p.meta_ad_ids ?? {})) ersatzLaeuft.add(`${adsetId}|${p.ersetzt_kennung}`)
  }
  // Überlappung: ermüdete Anzeigen einer Gruppe gehen nach dem Ersatz, zählen also nicht gegen max_active_ads
  const muedeJeAdset = new Map<string, number>()
  for (const m of ermuedet) {
    const as = adsetVonAd(m.ad)
    if (!ersatzLaeuft.has(`${as}|${kennungBasis(m.ad.name)}`)) muedeJeAdset.set(as, (muedeJeAdset.get(as) ?? 0) + 1)
  }
  for (const m of ermuedet) {
    const adsetId = adsetVonAd(m.ad)
    const basis = kennungBasis(m.ad.name)
    if (ersatzLaeuft.has(`${adsetId}|${basis}`)) continue // R1b übernimmt
    const winkel = poolJeKennung.get(basis)?.winkel ?? null
    const r = aktivierung(adsetId, m.rule, m.ev, `${m.grund} Ersatz aus dem freigegebenen Vorrat.`, winkel, m.ad, muedeJeAdset.get(adsetId) ?? 1)
    if (r === 'ok') continue
    if (r === 'kein_ersatz') {
      uploadBedarf.set(adsetId, (uploadBedarf.get(adsetId) ?? 0) + 1)
      hin({ code: 'kein_ersatz', rule_key: m.rule.rule_key, entity_level: 'ad', entity_id: m.ad.entity_id, entity_name: m.ad.name ?? m.ad.entity_id, text: `${m.grund} Kein geprüfter Ersatz hochgeladen.` })
    } else {
      hin({ code: r, rule_key: m.rule.rule_key, entity_level: 'ad', entity_id: m.ad.entity_id, entity_name: m.ad.name ?? m.ad.entity_id, text: `${m.grund} Ersatz ${SPERRTEXT[r] ?? r}.` })
    }
  }

  const R1b = regel('R1b')
  if (R1b) {
    for (const p of vorrat) {
      if (p.status !== 'aktiv' || !p.ersetzt_kennung) continue
      const seit = zeit(p.aktiv_seit)
      if (!Number.isFinite(seit) || nowMs - seit < P('r1b_min_hours_active', R1b) * STUNDE) continue
      for (const [adsetId, neuId] of Object.entries(p.meta_ad_ids ?? {})) {
        const neu = snap('ad', neuId)
        if (!neu || neu.effective_status !== 'ACTIVE') continue
        for (const alt of adsJeAdset.get(adsetId) ?? []) {
          if (alt.entity_id === neuId || !adKandidat(alt) || kennungBasis(alt.name) !== p.ersetzt_kennung) continue
          if (geplantePause.has(alt.entity_id)) continue
          const kz = q('kennung', P('k_fenster'), kennungId(alt.campaign_id, alt.name))
          const kst = statAus(kz, target)
          const pGood = kst ? pCpteLess(kst.alpha, kst.beta, target) : 0
          if (kst && pGood >= P('gewinner_p', R1b)) {
            hin({ code: 'gewinner_bleibt', rule_key: 'R1b', entity_level: 'ad', entity_id: alt.entity_id, entity_name: alt.name ?? alt.entity_id, text: `${alt.name ?? alt.entity_id} ist Gewinner (P(Kosten/TE < Ziel) ${Math.round(pGood * 100)} %) und bleibt neben dem Ersatz aktiv.` })
            continue
          }
          if (nurImFenster(R1b) && !fenstertag) {
            hin({ code: 'wartet_auf_fenster', rule_key: 'R1b', entity_level: 'ad', entity_id: alt.entity_id, entity_name: alt.name ?? alt.entity_id, text: `Ersatz läuft, ${alt.name ?? alt.entity_id} wird im nächsten Fenster (${info.naechstes_fenster ?? '-'}) pausiert.` })
            continue
          }
          const sperre = kSperre(alt)
          if (sperre) {
            hin({ code: sperre, rule_key: 'R1b', entity_level: 'ad', entity_id: alt.entity_id, entity_name: alt.name ?? alt.entity_id, text: `R1b wartet: ${SPERRTEXT[sperre] ?? sperre}.` })
            continue
          }
          pauseKandidat(alt, R1b, `R1b:${adsetId}:${heute.datum}`, evidenzAus(kst, P('k_fenster'), { p_good: rund(pGood, 4), details: { ersatz_ad_id: neuId, ersatz_kennung: p.kennung, aktiv_seit: p.aktiv_seit } }),
            `Ersatz ${p.kennung} läuft seit ${Math.round((nowMs - seit) / STUNDE)} h, ermüdete Anzeige wird pausiert.`, 20)
        }
      }
    }
  }

  // R2: gekillte/abgelehnte Anzeigen -> Ersatz, solange aktive Anzeigen < min_active_ads
  const R2 = regel('R2')
  if (R2) {
    const r2Adsets = new Set<string>(k0Adsets)
    for (const k of kandidaten) if (k.aktion === 'pause' && k.rule.rule_key.startsWith('K')) r2Adsets.add(String(k.payload.adset_id ?? ''))
    const rueck = nowMs - P('r2_rueckblick_tage', R2) * TAG
    for (const a of aktionen) {
      if (a.origin !== 'autopilot' || a.action !== 'pause' || !ausgefuehrt(a) || !(a.rule_key ?? '').startsWith('K')) continue
      if (zeit(a.executed_at) < rueck) continue
      const as = adsetDerAktion(a)
      if (as) r2Adsets.add(as)
    }
    for (const adsetId of [...r2Adsets].filter(Boolean).sort()) {
      const as = snap('adset', adsetId)
      if (!as || !objektAktiv(as) || !verwaltet(kampagneVonAdset(as)) || !kampagneAktiv(kampagneVonAdset(as))) continue
      let fehlt = P('min_active_ads', R2) - lieferndeNach(adsetId) - (geplanteAktivierung.get(adsetId) ?? 0)
      while (fehlt > 0) {
        const r = aktivierung(adsetId, R2, evidenzAus(null, 0, { details: { liefernde: lieferndeNach(adsetId), min_active_ads: P('min_active_ads', R2) } }),
          `Weniger als ${P('min_active_ads', R2)} aktive Anzeigen nach Kill/Ablehnung, Ersatz aus dem Vorrat.`, null, null, 0)
        if (r === 'ok') { fehlt--; continue }
        if (r === 'kein_ersatz') uploadBedarf.set(adsetId, (uploadBedarf.get(adsetId) ?? 0) + fehlt)
        else hin({ code: r, rule_key: 'R2', entity_level: 'adset', entity_id: adsetId, entity_name: as.name ?? adsetId, text: `R2: Ersatz ${SPERRTEXT[r] ?? r}.` })
        break
      }
    }
  }

  // POOL_UPLOAD: freigegebene Werbemittel PAUSED hochladen, wo Ersatz fehlt (nicht fensterpflichtig)
  for (const adsetId of laufzeitBedarf) {
    if (!(uploadBedarf.get(adsetId) ?? 0) && !ersatzFuer(adsetId, null)) uploadBedarf.set(adsetId, 1)
  }
  const UP = regel('POOL_UPLOAD')
  const budgetGruppen = gruppenLesen([regeln.get('S1')?.params?.budget_gruppen, regeln.get('D1')?.params?.budget_gruppen, ctx.parameter?.budget_gruppen])
  const gruppeVon = (id: string): string[] | null => budgetGruppen.find(g => g.includes(id)) ?? null
  if (uploadBedarf.size) {
    const frei = vorrat
      .filter(p => p.status === 'freigegeben')
      .sort((a, b) => (zahl(b.prognose) - zahl(a.prognose)) || ((a.released_at ?? '') < (b.released_at ?? '') ? -1 : (a.released_at ?? '') > (b.released_at ?? '') ? 1 : 0) || (a.id < b.id ? -1 : 1))
    const offen = new Map<string, number>()
    for (const [adsetId, n] of uploadBedarf) offen.set(adsetId, Math.max(0, n - uploadsImReview(adsetId)))
    for (const adsetId of [...offen.keys()].sort()) {
      while ((offen.get(adsetId) ?? 0) > 0) {
        const as = snap('adset', adsetId)
        const camp = as ? snap('campaign', kampagneVonAdset(as)) : undefined
        if (!UP) {
          hin({ code: 'upload_regel_aus', entity_level: 'adset', entity_id: adsetId, entity_name: as?.name ?? adsetId, text: 'Ersatz fehlt, Regel POOL_UPLOAD ist aus.' })
          break
        }
        if (!camp || !(camp.special_ad_categories ?? []).includes('HOUSING')) {
          hin({ code: 'kein_housing', rule_key: 'POOL_UPLOAD', entity_level: 'adset', entity_id: adsetId, entity_name: as?.name ?? adsetId, text: 'Upload nur in Kampagnen mit Sonderkategorie HOUSING.' })
          break
        }
        const item = frei.find(p => !genutzterUpload.has(p.id) && (!p.ziel_adset_ids || !p.ziel_adset_ids.length || p.ziel_adset_ids.includes(adsetId)))
        if (!item) {
          hin({ code: 'vorrat_leer', rule_key: 'POOL_UPLOAD', entity_level: 'adset', entity_id: adsetId, entity_name: as?.name ?? adsetId, text: 'Kein freigegebenes Werbemittel im Vorrat für diese Anzeigengruppe.' })
          break
        }
        genutzterUpload.add(item.id)
        // Plan B: dasselbe Werbemittel in alle Gruppen der Budget-Gruppe, die Ersatz brauchen
        const ziele = [adsetId]
        for (const g of gruppeVon(adsetId) ?? []) if (g !== adsetId && (offen.get(g) ?? 0) > 0) ziele.push(g)
        for (const zid of ziele) {
          offen.set(zid, (offen.get(zid) ?? 0) - 1)
          const zs = snap('adset', zid)
          kandidaten.push({
            rule: UP, aktion: 'ersatz_hochladen', entity_level: 'adset', entity_id: zid, entity_name: zs?.name ?? zid, ad_id: null,
            gruppe: `POOL_UPLOAD:${item.id}:${heute.datum}`,
            payload: { pool_id: item.id, kennung: item.kennung, adset_id: zid, campaign_id: zs ? kampagneVonAdset(zs) : null, status: 'PAUSED' },
            before: { pool_status: item.status }, after: { pool_status: 'hochgeladen', status: 'PAUSED' },
            evidence: evidenzAus(null, 0, { details: { winkel: item.winkel ?? null, prognose: item.prognose ?? null } }),
            nur_im_fenster: nurImFenster(UP), deckel: 3, prio: 40, pre_state: preStateText(zs), grund: `Werbemittel ${item.kennung} PAUSED hochladen, damit Metas Prüfung vor dem Fenster durch ist.`,
          })
        }
      }
    }
  }

  // ── 7. Budget S1 / D1 / D2 / D3 ─────────────────────────────────────────
  const S1 = regel('S1'), D1 = regel('D1'), D2 = regel('D2'), D3 = regel('D3')
  interface Einheit { ebene: 'adset' | 'campaign'; ids: string[] }
  const budgetObjekte: SnapshotZeile[] = []
  for (const c of kampagnen) {
    if (!objektAktiv(c) || !verwaltet(c.entity_id)) continue
    if (zahl(c.daily_budget_cents) > 0) { budgetObjekte.push(c); continue }
    for (const as of adsetsJeKampagne.get(c.entity_id) ?? []) if (objektAktiv(as) && zahl(as.daily_budget_cents) > 0) budgetObjekte.push(as)
  }
  const einheiten: Einheit[] = []
  const vergeben = new Set<string>()
  for (const o of budgetObjekte.sort((a, b) => (a.entity_id < b.entity_id ? -1 : 1))) {
    if (vergeben.has(o.entity_id)) continue
    const g = gruppeVon(o.entity_id)
    if (g) {
      const mitglieder = g.map(id => budgetObjekte.find(b => b.entity_id === id)).filter((b): b is SnapshotZeile => !!b)
      g.forEach(id => vergeben.add(id))
      if (mitglieder.length !== g.length || mitglieder.some(m => m.entity_level !== o.entity_level)) {
        hin({ code: 'gruppe_unvollstaendig', entity_level: o.entity_level, entity_id: o.entity_id, entity_name: o.name ?? o.entity_id, text: `Budget-Gruppe ${g.join(' + ')} nicht vollständig aktiv mit Tagesbudget: keine Budgetregel.` })
        continue
      }
      einheiten.push({ ebene: o.entity_level as 'adset' | 'campaign', ids: g.slice() })
    } else {
      vergeben.add(o.entity_id)
      einheiten.push({ ebene: o.entity_level as 'adset' | 'campaign', ids: [o.entity_id] })
    }
  }
  const adsetsVon = (e: Einheit, id: string): string[] => (e.ebene === 'adset' ? [id] : (adsetsJeKampagne.get(id) ?? []).map(a => a.entity_id))
  /** Letzte Budgetänderung (Berlin-Datum) aus eigenen Aktionen, Log und Schnappschuss-Historie. */
  const letzteBudgetAenderung = (ebene: Ebene, id: string): string | null => {
    let d: string | null = null
    const nimm = (t: number) => {
      if (!Number.isFinite(t)) return
      const x = berlinTag(t).datum
      if (!d || x > d) d = x
    }
    for (const a of aktionen) if (a.action === 'budget_set' && ausgefuehrt(a) && zielId(a) === id) nimm(zeit(a.executed_at))
    for (const l of log) if (l.art === 'ausfuehrung' && l.aktion === 'budget_set' && l.entity_id === id) nimm(zeit(l.ts))
    const h = snapHistorie.get(`${ebene}|${id}`) ?? []
    for (let i = 1; i < h.length; i++) {
      if (zahl(h[i].daily_budget_cents) !== zahl(h[i - 1].daily_budget_cents)) {
        const x = h[i].snap_date
        if (!d || x > d) d = x
      }
    }
    return d
  }
  const restTage = tageZwischen(heute.datum, monatsende(heute.datum)) + 1
  const monat = ctx.konto?.spend_monat_eur
  const fl = P('adset_min_daily_eur', D1)
  const floorCents = Math.ceil(eurZuCents(fl, fx))
  const minC = P('min_budget_cents'), maxC = P('max_budget_cents')

  for (const e of einheiten) {
    const objs = e.ids.map(id => snap(e.ebene, id) as SnapshotZeile)
    const name = objs.map(o => o.name ?? o.entity_id).join(' + ')
    const schl = e.ids.join('+')
    const bf = P('budget_fenster', S1 ?? D1)
    const zeilen = e.ids.map(id => q(e.ebene, bf, id))
    if (zeilen.some(z => !z)) {
      if (S1 || D1 || D2) hin({ code: 'keine_qualitaet', entity_level: e.ebene, entity_id: e.ids[0], entity_name: name, text: `Keine Qualitätszeile (${bf} Tage) für ${name}: keine Budgetregel.` })
      continue
    }
    let st: Stat
    if (zeilen.length === 1) {
      st = statAus(zeilen[0], target) as Stat
    } else {
      const spend = zeilen.reduce((a, z) => a + zahl(z?.spend_eur), 0)
      const te = zeilen.reduce((a, z) => a + zahl(z?.te_capped), 0)
      const priors = zeilen.map(z => zahl(z?.prior_cpte)).filter(v => v > 0)
      const prior = priors.length ? priors.reduce((a, b) => a + b, 0) / priors.length : target
      const p = posterior(te, spend, prior, P('prior_strength_te'))
      st = {
        spend, te, alpha: p.alpha, beta: p.beta,
        booked: zeilen.reduce((a, z) => a + zahl(z?.booked), 0),
        bookedKap: zeilen.reduce((a, z) => a + zahl(z?.booked_kap_ja), 0),
        leadsKap: zeilen.reduce((a, z) => a + zahl(z?.leads_kap_ja), 0),
        coverage: null,
      }
    }
    const pGood = pCpteLess(st.alpha, st.beta, target)
    const centsAlle = objs.map(o => zahl(o.daily_budget_cents))
    const altCents = centsAlle[0]
    const freqs = e.ids.flatMap(id => adsetsVon(e, id)).map(id => snap('adset', id)?.frequency_7d).filter((v): v is number => v != null)
    const freq = freqs.length ? Math.max(...freqs) : null
    const kapAnteil = st.booked > 0 ? st.bookedKap / st.booked : 0
    const slots = ctx.freie_slots_7d

    // D3: keine freien Slots -> Meldung (Budget auf Untergrenze bzw. pausieren)
    if (D3 && slots === 0) {
      hin({
        code: 'D3', rule_key: 'D3', entity_level: e.ebene, entity_id: e.ids[0], entity_name: name,
        text: `Keine freien Termin-Slots in 7 Tagen: Budget von ${name} auf ${fl} € senken oder pausieren (Pause > 7 Tage startet die Lernphase neu).`,
        details: { vorschlag_cents: floorCents, ids: e.ids },
      })
    }

    // gemeinsame Sperren der Einheit
    const sperren: string[] = []
    if (e.ids.length > 1 && Math.max(...centsAlle) - Math.min(...centsAlle) > 1) sperren.push('gruppe_asymmetrisch')
    if (objs.some(o => manuellGesperrt(o))) sperren.push('manuell_gesperrt')
    if (e.ids.some(id => adsetsVon(e, id).some(a => lernschutz(a)))) sperren.push('lernschutz')
    const abstaende = e.ids.map(id => letzteBudgetAenderung(e.ebene, id)).filter((d): d is string => !!d).map(d => tageZwischen(d, heute.datum))
    const minAbstand = P('min_days_between_sig_edits')
    if (abstaende.some(t => t < minAbstand)) sperren.push('budget_abstand')
    const sigAbstand = e.ids.flatMap(id => adsetsVon(e, id)).map(tageSeitSig).filter((t): t is number => t != null)
    if (sigAbstand.some(t => t < minAbstand)) sperren.push('aenderungsabstand')

    const evBasis = (extra: Partial<Evidenz>): Evidenz => evidenzAus(st, bf, {
      p_good: rund(pGood, 4),
      ...(freq != null ? { frequency_7d: rund(freq, 3) } : {}),
      ...extra,
    })
    const budgetVorschlag = (rule: RegelDef, neuCents: number, grund: string, ev: Evidenz, prio: number) => {
      for (const o of objs) {
        kandidaten.push({
          rule, aktion: 'budget_set', entity_level: e.ebene, entity_id: o.entity_id, entity_name: o.name ?? o.entity_id, ad_id: null,
          gruppe: `${rule.rule_key}:${schl}:${heute.datum}`,
          payload: { daily_budget: neuCents, daily_budget_cents: neuCents, vorher_cents: zahl(o.daily_budget_cents), gruppe_ids: e.ids },
          before: { daily_budget_cents: zahl(o.daily_budget_cents), daily_budget_eur: rund(centsZuEur(zahl(o.daily_budget_cents), fx), 2) },
          after: { daily_budget_cents: neuCents, daily_budget_eur: rund(centsZuEur(neuCents, fx), 2) },
          evidence: ev, nur_im_fenster: nurImFenster(rule), deckel: 3, prio, pre_state: preStateText(o), grund,
        })
      }
    }
    const sperrTexte: Record<string, string> = {
      ...SPERRTEXT,
      gruppe_asymmetrisch: 'Plan-B-Gruppe hat ungleiche Budgets',
      budget_abstand: `letzte Budgetänderung vor weniger als ${minAbstand} Tagen`,
      frequenz: `Frequenz ${freq ?? 'unbekannt'} nicht unter ${P('s1_freq_max', S1)}`,
      slots: `freie Slots ${slots ?? 'unbekannt'} unter ${P('min_free_slots_7d', S1)}`,
      stopp: 'Stopp aktiv',
    }
    const sperrHinweis = (rule: RegelDef, liste: string[], grund: string) => {
      hin({ code: liste[0], rule_key: rule.rule_key, entity_level: e.ebene, entity_id: e.ids[0], entity_name: name, text: `${rule.rule_key} (${grund}) gesperrt: ${liste.map(x => sperrTexte[x] ?? x).join(', ')}.`, details: { sperren: liste } })
    }

    // S1 hochskalieren
    let s1Gefeuert = false
    if (S1) {
      // Kapitalbasis-Untergrenze aus ad_settings.kap_floor, Regel-Parameter kap_floor überschreibt
      const kapMin = S1.params?.kap_floor != null ? P('kap_floor', S1) : zahl(s.kap_floor)
      const bed = st.booked >= P('s1_min_booked', S1) && pGood >= P('p_scale', S1) && kapAnteil >= kapMin
      if (bed) {
        s1Gefeuert = true
        const grund = `${st.booked} Termine in ${bf} Tagen, P(Kosten/TE < ${target} €) = ${Math.round(pGood * 100)} %, Kapitalbasis-Ja-Anteil ${Math.round(kapAnteil * 100)} %.`
        const s1Sperren = [...sperren]
        if (freq == null || freq >= P('s1_freq_max', S1)) s1Sperren.push('frequenz')
        if (slots == null || slots < P('min_free_slots_7d', S1)) s1Sperren.push('slots')
        if (sperrtBudget || stopps.length) s1Sperren.push('stopp')
        if (nurImFenster(S1) && !fenstertag) s1Sperren.unshift('wartet_auf_fenster')
        if (s1Sperren.length) {
          sperrHinweis(S1, s1Sperren, grund)
        } else if (monat == null) {
          hin({ code: 'monatsprognose_unbekannt', rule_key: 'S1', entity_level: e.ebene, entity_id: e.ids[0], entity_name: name, text: 'S1 gesperrt: Monats-Spend unbekannt, Prognose nicht prüfbar.' })
        } else {
          const n = objs.length
          const altEur = centsZuEur(altCents, fx)
          const schritt = altEur * P('s1_step', S1) * n
          const kontoRaum = zahl(s.max_account_daily_budget) - summeAktuellEur
          const monatsRaum = (zahl(s.monthly_cap_eur) - monat) / restTage - summeAktuellEur
          const erlaubt = Math.min(schritt, kontoRaum, monatsRaum)
          if (!(erlaubt >= P('min_budget_delta_eur', S1) * n)) {
            const limit = erlaubt === kontoRaum ? 'Tageslimit' : erlaubt === monatsRaum ? 'Monatsrahmen' : 'Schritt'
            hin({ code: 'kein_spielraum', rule_key: 'S1', entity_level: e.ebene, entity_id: e.ids[0], entity_name: name, text: `S1 (${grund}) ohne Spielraum: ${limit} erreicht.`, details: { konto_raum_eur: rund(kontoRaum, 2), monats_raum_eur: rund(monatsRaum, 2), summe_eur: rund(summeAktuellEur, 2) } })
          } else {
            const jeObjekt = erlaubt / n
            let neu = Math.floor((altEur + jeObjekt) * fx * 100)
            neu = Math.min(neu, Math.floor(altCents * (1 + P('s1_step', S1))))
            if (neu < minC || neu > maxC) {
              hin({ code: 'cent_grenze', rule_key: 'S1', entity_level: e.ebene, entity_id: e.ids[0], entity_name: name, text: `S1: neues Budget ${neu} Cent außerhalb ${minC} bis ${maxC}.` })
            } else if (neu > altCents) {
              const summeNach = summeAktuellEur + n * (centsZuEur(neu, fx) - altEur)
              budgetVorschlag(S1, neu, `${grund} Budget +${Math.round(((neu - altCents) / altCents) * 1000) / 10} %.`, evBasis({
                details: {
                  booked: st.booked, kap_anteil: rund(kapAnteil, 3), freie_slots: slots, summe_vorher_eur: rund(summeAktuellEur, 2),
                  summe_nachher_eur: rund(summeNach, 2), monatsprognose_eur: rund(monat + restTage * summeNach, 2), ids: e.ids,
                },
              }), 50)
            }
          }
        }
      }
    }

    // D1 runterskalieren (Hysterese: andere Schwelle als S1, gleicher 3-Tage-Abstand)
    if (D1 && !s1Gefeuert && st.spend >= P('d1_spend_factor', D1) * target) {
      const pBad = pCpteGreater(st.alpha, st.beta, P('d1_factor', D1) * target)
      if (pBad >= P('d1_p', D1)) {
        const grund = `P(Kosten/TE > ${Math.round(P('d1_factor', D1) * target)} €) = ${Math.round(pBad * 100)} % bei ${Math.round(st.spend)} € in ${bf} Tagen.`
        const d1Sperren = [...sperren]
        if (sperrtBudget) d1Sperren.push('stopp')
        if (nurImFenster(D1) && !fenstertag) d1Sperren.unshift('wartet_auf_fenster')
        if (altCents <= floorCents) {
          hin({ code: 'untergrenze', rule_key: 'D1', entity_level: e.ebene, entity_id: e.ids[0], entity_name: name, text: `D1 (${grund}): Budget schon an der Untergrenze ${fl} €.` })
        } else if (d1Sperren.length) {
          sperrHinweis(D1, d1Sperren, grund)
        } else {
          const neu = Math.max(Math.round(altCents * (1 - P('d1_step', D1))), floorCents)
          if (neu < minC || neu > maxC) {
            hin({ code: 'cent_grenze', rule_key: 'D1', entity_level: e.ebene, entity_id: e.ids[0], entity_name: name, text: `D1: neues Budget ${neu} Cent außerhalb ${minC} bis ${maxC}.` })
          } else {
            budgetVorschlag(D1, neu, `${grund} Budget -${Math.round(((altCents - neu) / altCents) * 1000) / 10} %.`, evBasis({ p_bad: rund(pBad, 4), details: { ids: e.ids, untergrenze_eur: fl } }), 15)
          }
        }
      }
    }

    // D2 Gruppe pausieren: nur Vorschlag (Deckel Stufe 1)
    if (D2 && e.ebene === 'adset' && st.spend >= P('d2_spend_factor', D2) * target) {
      const pBad2 = pCpteGreater(st.alpha, st.beta, P('d2_factor', D2) * target)
      if (pBad2 >= P('d2_p', D2)) {
        const grund = `P(Kosten/TE > ${Math.round(P('d2_factor', D2) * target)} €) = ${Math.round(pBad2 * 100)} % bei ${Math.round(st.spend)} €.`
        const d2Sperren = sperren.filter(x => x === 'manuell_gesperrt' || x === 'lernschutz')
        if (d2Sperren.length) sperrHinweis(D2, d2Sperren, grund)
        else {
          for (const o of objs) {
            kandidaten.push({
              rule: D2, aktion: 'pause', entity_level: 'adset', entity_id: o.entity_id, entity_name: o.name ?? o.entity_id, ad_id: null,
              gruppe: `D2:${schl}:${heute.datum}`, payload: { status: 'PAUSED', gruppe_ids: e.ids },
              before: { status: o.status ?? null, effective_status: o.effective_status ?? null }, after: { status: 'PAUSED' },
              evidence: evBasis({ p_bad: rund(pBad2, 4), details: { ids: e.ids } }), nur_im_fenster: nurImFenster(D2), deckel: 1, prio: 12,
              pre_state: preStateText(o), grund: `${grund} Anzeigengruppe pausieren (nur Vorschlag).`,
            })
          }
        }
      }
    }
  }

  // ── 8. Freigabestufe, Aktionslimit, Ausgabe ─────────────────────────────
  if (sperrtAlles) {
    if (kandidaten.length) hin({ code: 'keine_vorschlaege_wegen_stopp', text: `${kandidaten.length} Regeltreffer verworfen, weil ein Stopp alle Vorschläge sperrt.` })
    return { vorschlaege, stopps, hinweise, info }
  }
  const stufeVon = (k: Kandidat): Stufe => {
    let v: number = effektiveStufe(k.rule.approval_level, k.rule.max_level, modus)
    v = Math.min(v, k.deckel)
    if (stopps.length || pausiert) v = Math.min(v, 1)
    if (k.aktion === 'budget_set' && v === 3 && !s.budget_autonomie_freigegeben_at) v = 2
    return Math.max(0, Math.min(3, v)) as Stufe
  }
  const mitStufe = kandidaten
    .filter(k => {
      const key = idempotenzSchluessel(k.rule.rule_key, k.entity_id, heute.datum, k.aktion)
      return !vorhandeneSchluessel.has(key)
    })
    .map(k => ({ k, stufe: stufeVon(k) }))
  // Aktionslimit: autonome Aktionen nach Priorität, Rest wird Vorschlag. Gruppen (Plan-B-Budget,
  // Kennung über A+B) bleiben unteilbar: passt eine Gruppe nicht mehr ganz, wird sie ganz Vorschlag.
  let frei = Math.max(0, info.max_aktionen - heuteAutonom)
  const reihenfolge = mitStufe.slice().sort((a, b) => a.k.prio - b.k.prio || (a.k.gruppe < b.k.gruppe ? -1 : a.k.gruppe > b.k.gruppe ? 1 : 0) || (a.k.entity_id < b.k.entity_id ? -1 : 1))
  let gedeckelt = 0
  const gruppenFertig = new Set<string>()
  for (const x of reihenfolge) {
    if (x.stufe !== 3 || gruppenFertig.has(x.k.gruppe)) continue
    gruppenFertig.add(x.k.gruppe)
    const mitglieder = reihenfolge.filter(y => y.k.gruppe === x.k.gruppe && y.stufe === 3)
    if (mitglieder.length <= frei) frei -= mitglieder.length
    else for (const y of mitglieder) { y.stufe = 1; gedeckelt++ }
  }
  if (gedeckelt) hin({ code: 'aktionslimit', text: `${gedeckelt} autonome Aktionen über dem Tageslimit von ${info.max_aktionen}: als Vorschlag eingestellt.` })

  const gesehen = new Set<string>()
  for (const { k, stufe } of reihenfolge) {
    const key = idempotenzSchluessel(k.rule.rule_key, k.entity_id, heute.datum, k.aktion)
    if (gesehen.has(key)) continue
    gesehen.add(key)
    vorschlaege.push({
      rule_key: k.rule.rule_key,
      rule_version: k.rule.version ?? 1,
      aktion: k.aktion,
      entity_level: k.entity_level,
      entity_id: k.entity_id,
      entity_name: k.entity_name,
      ad_id: k.ad_id,
      gruppe_schluessel: k.gruppe,
      payload: k.payload,
      before: k.before,
      after: k.after,
      evidence: k.evidence,
      nur_im_fenster: k.nur_im_fenster,
      stufe,
      freigabe: stufe === 0 ? 'schatten' : stufe === 3 ? 'autonom' : 'vorgeschlagen',
      window_date: heute.datum,
      idempotency_key: key,
      pre_state: k.pre_state,
      grund: k.grund,
    })
  }
  return { vorschlaege, stopps, hinweise, info }
}

/** budget_gruppen aus Regel-/Globalparametern: Liste von ID-Listen (Plan B: A und B immer gleich). */
function gruppenLesen(quellen: unknown[]): string[][] {
  const out: string[][] = []
  const seen = new Set<string>()
  for (const q of quellen) {
    if (!Array.isArray(q)) continue
    for (const g of q) {
      if (!Array.isArray(g)) continue
      const ids = g.map(x => String(x)).filter(Boolean)
      if (ids.length < 2) continue
      const key = ids.slice().sort().join('+')
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ids)
    }
  }
  return out
}
