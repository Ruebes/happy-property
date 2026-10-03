// Baut den RegelKontext für _shared/werbeRegeln.ts aus der Datenbank (nur lesend).
//
// Micro-DB: jede Abfrage seriell, mit Zeitfilter und Obergrenze, nur benötigte
// Spalten. Fehlende Eingaben bleiben leer bzw. null, die Engine reagiert darauf
// sicher (z.B. freie_slots_7d null -> S1 gesperrt, kein Sync -> Stopp).
//
// Quellen je Feld (CONTRACTS.md, werbeRegeln):
//   settings          ad_settings (id 'default')
//   rules/parameter   ad_autopilot_rules; Parameter der Startwerte (deutsche Namen)
//                     werden zusätzlich unter den Engine-Namen abgelegt (PARAM_ALIAS),
//                     SCHUTZ/STOPP wirken global (ctx.parameter)
//   qualitaet         ad_quality_daily, jüngster Stichtag, alle Fenster/Ebenen
//   snapshots         ad_entity_snapshot heute + 3 Tage zurück, created_time/start_time
//                     aus meta_campaigns, meta_adsets, ad_catalog
//   insights          ad_insights_daily der eingeschalteten Anzeigen, 100 Tage
//   fruehphase        ad_quality_daily (Anzeige, Fenster 14) am Lebenstag 14
//   aktionen          ad_actions der letzten 14 Tage
//   log               ad_autopilot_log 14 Tage: manuell_erkannt sowie eigene
//                     Ausführungen (ergebnis 'ok', akteur_art 'system')
//   eigene_writes     meta_write_log actor_kind 'autopilot', ok, ohne validate_only
//   meta_fehler       meta_write_log ok = false (26 h; auth/rate_limit von allen, permission/dev_mode
//                     nur aus Autopilot-Schreibzugriffen) + strukturierte Fehler aus dem Sync-Ledger
//   capi_laeufe       Sync-Ledger summary.capi_error / capi_sent
//   konto, fx         ad_insights_daily (Meta) Monat + 7 Tage, Kurs = spend / spend_eur
//   freie_slots_7d    funnel-api {action:'slots'} (Google-Kalender + CRM-Sperren), sonst null
//   sync              ad_autopilot_runs schritt 'sync' status 'fertig'

import {
  type AktionZeile, type AutopilotModus, type InsightTag, type LogZeile, type PoolEintrag, type QualitaetZeile,
  type RegelDef, type RegelKontext, type RegelSettings, type SnapshotZeile,
} from '../_shared/werbeRegeln.ts'
import { datumPlus } from '../_shared/werbeMathe.ts'
import {
  type Sb, alleZeilen, berlinHeute, dbFehler, funktionAufrufen, spalteFehlt, stuecke, tabelleFehlt, toNum, toStr,
} from './gemeinsam.ts'

const MODI: AutopilotModus[] = ['aus', 'schatten', 'vorschlag', 'ein_klick', 'autonom']

/** Bekanntes Plan-B-Paar (Kalt · Kurz / Kalt · Lang): Budgets immer gleich (HP-Regel 4). */
export const PLAN_B_GRUPPE = ['120249505116660314', '120248678452700314']

/**
 * Startwerte in ad_autopilot_rules.params nutzen deutsche Namen, die Engine liest
 * REGEL_STANDARD-Namen. Hier wird je Regel der Engine-Name ergänzt (nur wenn er
 * nicht schon gesetzt ist), damit Svens Änderungen im Regel-Editor wirken.
 */
const PARAM_ALIAS: Record<string, Record<string, string>> = {
  SCHUTZ: {
    neue_anzeigen_ab_kampagnentag: 'neue_anzeigen_ab_tag',
    manuell_sperre_stunden: 'manuell_sperre_h',
    eur_je_aktiver_anzeige: 'eur_pro_aktive_anzeige',
  },
  STOPP: {
    sync_max_stunden: 'sync_max_hours',
    capi_fehler_laeufe: 'capi_fail_runs',
    woche_faktor: 'spend_week_factor',
    tag_faktor: 'spend_day_factor',
    kurs_abweichung_max: 'fx_max_deviation',
  },
  K1: { spend_eur: 'k1_spend' },
  K2: { spend_eur: 'k2_spend' },
  K3: { min_spend_faktor: 'k3_min_spend_factor' },
  K4: { min_alter_tage: 'k4_min_age_days', min_spend_faktor: 'k4_spend_factor', rel_faktor: 'k4_rel_factor', p_kill: 'k4_p' },
  F5: { min_te: 'f5_min_te' },
  R1b: { min_ersatz_aktiv_stunden: 'r1b_min_hours_active' },
  S1: { schritt: 's1_step', min_booked_14d: 's1_min_booked', freq_max_7d: 's1_freq_max' },
  D1: { schritt: 'd1_step', min_spend_faktor: 'd1_spend_factor', faktor: 'd1_factor', p: 'd1_p' },
  D2: { min_spend_faktor: 'd2_spend_factor', faktor: 'd2_factor', p: 'd2_p' },
}
/** Schrittweiten sind in der Engine positiv (D1 -20 % = d1_step 0.2). */
const BETRAG_PARAM = new Set(['d1_step', 's1_step'])

export interface EinstellungenRoh {
  [k: string]: unknown
}

export interface KontextMeta {
  heute: string
  gestern: string
  modus: AutopilotModus
  settingsRoh: EinstellungenRoh
  stichtag: string | null
  /** level|id -> jüngster Schnappschuss (für pre_state_hash) */
  snapAktuell: Map<string, SnapshotZeile>
  kampagnenNamen: Map<string, string>
  regeln: RegelDef[]
  zaehler: Record<string, number>
  warnungen: string[]
  slots_quelle: string
}

// ── Einzel-Lader (auch vom Replay genutzt) ──────────────────────────────────

export async function ladeEinstellungen(sb: Sb): Promise<{ settings: RegelSettings; roh: EinstellungenRoh; modus: AutopilotModus }> {
  const { data, error } = await sb.from('ad_settings').select('*').eq('id', 'default').maybeSingle()
  if (error) throw new Error(`ad_settings: ${dbFehler(error)}`)
  const r = (data ?? {}) as EinstellungenRoh
  const modusRoh = String(r.autopilot_mode ?? '')
  // Vor der Migration gibt es die Spalte nicht: dann ist der Autopilot aus.
  const modus: AutopilotModus = (MODI as string[]).includes(modusRoh) ? (modusRoh as AutopilotModus) : 'aus'
  const dows = Array.isArray(r.change_window_dows)
    ? (r.change_window_dows as unknown[]).map(Number).filter(Number.isFinite)
    : [1, 4]
  const settings: RegelSettings = {
    autopilot_mode: modus,
    autopilot_paused_until: toStr(r.autopilot_paused_until),
    target_cpte_eur: toNum(r.target_cpte_eur) ?? 145,
    max_account_daily_budget: toNum(r.max_account_daily_budget) ?? 250,
    monthly_cap_eur: toNum(r.monthly_cap_eur) ?? 7500,
    max_auto_actions_per_day: toNum(r.max_auto_actions_per_day) ?? 5,
    kap_floor: toNum(r.kap_floor) ?? 0.4,
    change_window_dows: dows,
    budget_autonomie_freigegeben_at: toStr(r.budget_autonomie_freigegeben_at),
  }
  return { settings, roh: r, modus }
}

function paramsMitAlias(ruleKey: string, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params }
  const alias = PARAM_ALIAS[ruleKey] ?? {}
  for (const [von, nach] of Object.entries(alias)) {
    if (out[nach] !== undefined || params[von] === undefined) continue
    const n = toNum(params[von])
    if (n === null) continue
    out[nach] = BETRAG_PARAM.has(nach) ? Math.abs(n) : n
  }
  return out
}

export async function ladeRegeln(sb: Sb): Promise<{
  regeln: RegelDef[]; parameter: Record<string, unknown>; verwaltet: string[] | null
}> {
  const { data, error } = await sb.from('ad_autopilot_rules')
    .select('rule_key, aktion, enabled, approval_level, max_level, params, version')
    .limit(200)
  if (error) throw new Error(`ad_autopilot_rules: ${dbFehler(error)}`)
  const regeln: RegelDef[] = []
  const parameter: Record<string, unknown> = {}
  let verwaltet: string[] | null = null
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const key = String(r.rule_key ?? '')
    if (!key) continue
    const rohParams = (r.params && typeof r.params === 'object' && !Array.isArray(r.params)) ? r.params as Record<string, unknown> : {}
    const params = paramsMitAlias(key, rohParams)
    regeln.push({
      rule_key: key,
      aktion: String(r.aktion ?? 'meldung') as RegelDef['aktion'],
      enabled: r.enabled === true,
      approval_level: toNum(r.approval_level) ?? 0,
      max_level: toNum(r.max_level) ?? 0,
      params,
      version: toNum(r.version) ?? 1,
    })
    if (key === 'SCHUTZ' || key === 'STOPP') {
      for (const [k, v] of Object.entries(params)) {
        if (k === 'verwaltete_kampagnen') continue
        if (typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v)) parameter[k] = v
      }
      const vk = params.verwaltete_kampagnen
      if (Array.isArray(vk) && vk.length) verwaltet = vk.map(x => String(x)).filter(Boolean)
    }
  }
  // Plan-B-Paar als Budget-Gruppe, solange in S1/D1 keine Gruppen gepflegt sind
  const hatGruppen = regeln.some(r => (r.rule_key === 'S1' || r.rule_key === 'D1') &&
    Array.isArray(r.params?.budget_gruppen) && (r.params?.budget_gruppen as unknown[]).length > 0)
  if (!hatGruppen) parameter.budget_gruppen = [PLAN_B_GRUPPE]
  return { regeln, parameter, verwaltet }
}

const QUAL_SPALTEN = 'stichtag, fenster, entity_level, entity_id, parent_id, campaign_id, name, spend_eur, impressions, link_clicks, ' +
  'leads, leads_kap_ja, booked, booked_kap_ja, held, te_capped, prior_cpte, alpha, beta, cpte_hat, p_bad, p_good, ' +
  'kap_ja_share_booked, attribution_coverage'

function qualitaetAus(r: Record<string, unknown>): QualitaetZeile {
  const n = (k: string) => toNum(r[k])
  return {
    stichtag: String(r.stichtag ?? '').slice(0, 10),
    fenster: n('fenster') ?? 0,
    entity_level: String(r.entity_level ?? 'ad') as QualitaetZeile['entity_level'],
    entity_id: String(r.entity_id ?? ''),
    parent_id: toStr(r.parent_id),
    campaign_id: toStr(r.campaign_id),
    name: toStr(r.name),
    spend_eur: n('spend_eur') ?? 0,
    impressions: n('impressions'),
    link_clicks: n('link_clicks'),
    leads: n('leads'),
    leads_kap_ja: n('leads_kap_ja'),
    booked: n('booked'),
    booked_kap_ja: n('booked_kap_ja'),
    held: n('held'),
    te_capped: n('te_capped'),
    prior_cpte: n('prior_cpte'),
    alpha: n('alpha'),
    beta: n('beta'),
    cpte_hat: n('cpte_hat'),
    p_bad: n('p_bad'),
    p_good: n('p_good'),
    kap_ja_share_booked: n('kap_ja_share_booked'),
    attribution_coverage: n('attribution_coverage'),
  }
}

/** Qualitätszeilen eines Stichtags (Standard: jüngster vorhandener bis `bisStichtag`). */
export async function ladeQualitaet(sb: Sb, bisStichtag: string, genau = false): Promise<{ zeilen: QualitaetZeile[]; stichtag: string | null }> {
  let stichtag: string | null = bisStichtag
  if (!genau) {
    const { data, error } = await sb.from('ad_quality_daily').select('stichtag')
      .lte('stichtag', bisStichtag).order('stichtag', { ascending: false }).limit(1)
    if (error) throw new Error(`ad_quality_daily: ${dbFehler(error)}`)
    const row = (Array.isArray(data) ? data[0] : null) as { stichtag?: string } | null
    stichtag = row?.stichtag ? String(row.stichtag).slice(0, 10) : null
  }
  if (!stichtag) return { zeilen: [], stichtag: null }
  const tag = stichtag
  const rows = await alleZeilen<Record<string, unknown>>(
    async (von, bis) => await sb.from('ad_quality_daily').select(QUAL_SPALTEN).eq('stichtag', tag)
      .order('entity_level').order('entity_id').order('fenster').range(von, bis),
    'ad_quality_daily', 8000)
  return { zeilen: rows.map(qualitaetAus), stichtag }
}

const SNAP_SPALTEN = 'snap_date, entity_level, entity_id, parent_id, campaign_id, name, status, effective_status, ' +
  'daily_budget_cents, lifetime_budget_cents, special_ad_categories, learning_stage_info, issues_info, ad_review_feedback, ' +
  'creative_id, updated_time, reach_7d, impressions_7d, frequency_7d, video_3s_7d, link_clicks_7d, spend_7d_usd, usd_per_eur, synced_at'

/** Schnappschüsse zwischen zwei Kalendertagen, ergänzt um created_time/start_time. */
export async function ladeSnapshots(sb: Sb, von: string, bis: string): Promise<{ zeilen: SnapshotZeile[]; namen: Map<string, string> }> {
  const rows = await alleZeilen<Record<string, unknown>>(
    async (a, b) => await sb.from('ad_entity_snapshot').select(SNAP_SPALTEN)
      .gte('snap_date', von).lte('snap_date', bis)
      .order('snap_date').order('entity_level').order('entity_id').range(a, b),
    'ad_entity_snapshot', 8000)
  const zeilen: SnapshotZeile[] = rows.map(r => ({
    snap_date: String(r.snap_date ?? '').slice(0, 10),
    entity_level: String(r.entity_level ?? 'ad') as SnapshotZeile['entity_level'],
    entity_id: String(r.entity_id ?? ''),
    parent_id: toStr(r.parent_id),
    campaign_id: toStr(r.campaign_id),
    name: toStr(r.name),
    status: toStr(r.status),
    effective_status: toStr(r.effective_status),
    daily_budget_cents: toNum(r.daily_budget_cents),
    lifetime_budget_cents: toNum(r.lifetime_budget_cents),
    special_ad_categories: Array.isArray(r.special_ad_categories) ? (r.special_ad_categories as unknown[]).map(String) : null,
    learning_stage_info: (r.learning_stage_info && typeof r.learning_stage_info === 'object') ? r.learning_stage_info as SnapshotZeile['learning_stage_info'] : null,
    issues_info: r.issues_info ?? null,
    ad_review_feedback: r.ad_review_feedback ?? null,
    creative_id: toStr(r.creative_id),
    updated_time: toStr(r.updated_time),
    reach_7d: toNum(r.reach_7d),
    impressions_7d: toNum(r.impressions_7d),
    frequency_7d: toNum(r.frequency_7d),
    video_3s_7d: toNum(r.video_3s_7d),
    link_clicks_7d: toNum(r.link_clicks_7d),
    spend_7d_usd: toNum(r.spend_7d_usd),
    usd_per_eur: toNum(r.usd_per_eur),
    synced_at: toStr(r.synced_at),
  }))

  // Anlage-/Startzeitpunkte (Lernschutz L3, Handänderung bei Neuanlage)
  const namen = new Map<string, string>()
  const kampagnen = [...new Set(zeilen.filter(z => z.entity_level === 'campaign').map(z => z.entity_id))]
  const adsets = [...new Set(zeilen.filter(z => z.entity_level === 'adset').map(z => z.entity_id))]
  const ads = [...new Set(zeilen.filter(z => z.entity_level === 'ad').map(z => z.entity_id))]
  const zeiten = new Map<string, { created: string | null; start: string | null }>()
  for (const teil of stuecke(kampagnen)) {
    const { data, error } = await sb.from('meta_campaigns').select('campaign_id, name, created_time, start_time').in('campaign_id', teil)
    if (error) { if (!tabelleFehlt(error)) console.warn('[werbe-autopilot] meta_campaigns:', dbFehler(error)); break }
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      zeiten.set(`campaign|${r.campaign_id}`, { created: toStr(r.created_time), start: toStr(r.start_time) })
      if (toStr(r.name)) namen.set(String(r.campaign_id), String(r.name))
    }
  }
  for (const teil of stuecke(adsets)) {
    const { data, error } = await sb.from('meta_adsets').select('adset_id, created_time, start_time').in('adset_id', teil)
    if (error) { if (!tabelleFehlt(error)) console.warn('[werbe-autopilot] meta_adsets:', dbFehler(error)); break }
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      zeiten.set(`adset|${r.adset_id}`, { created: toStr(r.created_time), start: toStr(r.start_time) })
    }
  }
  for (const teil of stuecke(ads)) {
    const { data, error } = await sb.from('ad_catalog').select('ad_id, created_time, campaign_name, campaign_id').in('ad_id', teil)
    if (error) {
      if (!spalteFehlt(error)) console.warn('[werbe-autopilot] ad_catalog:', dbFehler(error))
      break
    }
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      zeiten.set(`ad|${r.ad_id}`, { created: toStr(r.created_time), start: null })
      if (toStr(r.campaign_id) && toStr(r.campaign_name) && !namen.has(String(r.campaign_id))) namen.set(String(r.campaign_id), String(r.campaign_name))
    }
  }
  for (const z of zeilen) {
    const t = zeiten.get(`${z.entity_level}|${z.entity_id}`)
    if (t) {
      z.created_time = t.created
      z.start_time = t.start
    }
    if (z.entity_level === 'campaign' && z.name && !namen.has(z.entity_id)) namen.set(z.entity_id, z.name)
  }
  return { zeilen, namen }
}

/** Jüngster Schnappschuss je Ebene+ID. */
export function aktuelleSnapshots(zeilen: SnapshotZeile[]): Map<string, SnapshotZeile> {
  const m = new Map<string, SnapshotZeile>()
  for (const z of zeilen) {
    const key = `${z.entity_level}|${z.entity_id}`
    const alt = m.get(key)
    if (!alt || z.snap_date > alt.snap_date || (z.snap_date === alt.snap_date && (z.synced_at ?? '') >= (alt.synced_at ?? ''))) m.set(key, z)
  }
  return m
}

/** Tageswerte der genannten Anzeigen zwischen zwei Tagen (video_3s_true tolerant). */
export async function ladeInsights(sb: Sb, adIds: string[], von: string, bis: string): Promise<InsightTag[]> {
  const out: InsightTag[] = []
  let spalten = 'day, ad_id, spend_eur, impressions, link_clicks, video_3s_true'
  for (const teil of stuecke(adIds, 60)) {
    let rows: Array<Record<string, unknown>>
    try {
      rows = await alleZeilen<Record<string, unknown>>(
        async (a, b) => await sb.from('ad_insights_daily').select(spalten).eq('platform', 'meta').in('ad_id', teil)
          .gte('day', von).lte('day', bis).order('day').order('ad_id').range(a, b),
        'ad_insights_daily', 8000)
    } catch (err) {
      if (!spalteFehlt((err as { db?: unknown }).db) || !spalten.includes('video_3s_true')) throw err
      spalten = 'day, ad_id, spend_eur, impressions, link_clicks'
      rows = await alleZeilen<Record<string, unknown>>(
        async (a, b) => await sb.from('ad_insights_daily').select(spalten).eq('platform', 'meta').in('ad_id', teil)
          .gte('day', von).lte('day', bis).order('day').order('ad_id').range(a, b),
        'ad_insights_daily', 8000)
    }
    for (const r of rows) {
      out.push({
        day: String(r.day ?? '').slice(0, 10),
        ad_id: String(r.ad_id ?? ''),
        spend_eur: toNum(r.spend_eur) ?? 0,
        impressions: toNum(r.impressions) ?? 0,
        link_clicks: toNum(r.link_clicks),
        video_3s_true: toNum(r.video_3s_true),
      })
    }
  }
  return out
}

/** Frühester Tag in ad_insights_daily (Meta): ab dann sind die Tageswerte vollständig. */
export async function ersterInsightTag(sb: Sb): Promise<string | null> {
  const { data, error } = await sb.from('ad_insights_daily').select('day').eq('platform', 'meta').order('day', { ascending: true }).limit(1)
  if (error) return null
  const r = (Array.isArray(data) ? data[0] : null) as { day?: string } | null
  return r?.day ? String(r.day).slice(0, 10) : null
}

/**
 * F5: Kosten/TE der ersten 14 Lebenstage aus der historischen Qualitätszeile
 * (Anzeige, Fenster 14) am 14. Lebenstag. Nur Anzeigen mit sicherem Lebensbeginn.
 */
export async function ladeFruehphase(
  sb: Sb,
  starts: Map<string, string>,
  letzterStichtag: string,
): Promise<Record<string, { spend_eur: number; te: number }>> {
  const out: Record<string, { spend_eur: number; te: number }> = {}
  const ziel = new Map<string, string>() // ad_id -> stichtag
  for (const [adId, start] of starts) {
    const t = datumPlus(start, 13)
    if (t <= letzterStichtag) ziel.set(adId, t)
  }
  const ids = [...ziel.keys()]
  for (const teil of stuecke(ids, 100)) {
    const tage = [...new Set(teil.map(id => ziel.get(id) as string))]
    const { data, error } = await sb.from('ad_quality_daily').select('stichtag, entity_id, spend_eur, te_capped')
      .eq('entity_level', 'ad').eq('fenster', 14).in('entity_id', teil).in('stichtag', tage).limit(2000)
    if (error) { console.warn('[werbe-autopilot] Frühphase:', dbFehler(error)); break }
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const id = String(r.entity_id ?? '')
      if (ziel.get(id) !== String(r.stichtag ?? '').slice(0, 10)) continue
      out[id] = { spend_eur: toNum(r.spend_eur) ?? 0, te: toNum(r.te_capped) ?? 0 }
    }
  }
  return out
}

export async function ladeAktionen(sb: Sb, abIso: string, bisIso?: string): Promise<AktionZeile[]> {
  const rows = await alleZeilen<Record<string, unknown>>(
    async (a, b) => {
      let q = sb.from('ad_actions')
        .select('id, ad_id, entity_id, entity_level, action, status, origin, freigabe, rule_key, created_at, executed_at, window_date, idempotency_key, payload')
        .gte('created_at', abIso)
      if (bisIso) q = q.lt('created_at', bisIso)
      return await q.order('created_at').order('id').range(a, b)
    },
    'ad_actions', 4000)
  return rows.map(r => ({
    id: toStr(r.id),
    ad_id: toStr(r.ad_id),
    entity_id: toStr(r.entity_id),
    entity_level: toStr(r.entity_level),
    action: String(r.action ?? ''),
    status: toStr(r.status),
    origin: toStr(r.origin),
    freigabe: toStr(r.freigabe),
    rule_key: toStr(r.rule_key),
    created_at: toStr(r.created_at),
    executed_at: toStr(r.executed_at),
    window_date: r.window_date ? String(r.window_date).slice(0, 10) : null,
    idempotency_key: toStr(r.idempotency_key),
    payload: (r.payload && typeof r.payload === 'object') ? r.payload as Record<string, unknown> : null,
  }))
}

export async function ladeLog(sb: Sb, abIso: string, bisIso?: string): Promise<LogZeile[]> {
  const rows = await alleZeilen<Record<string, unknown>>(
    async (a, b) => {
      let q = sb.from('ad_autopilot_log')
        .select('id, ts, art, rule_key, entity_level, entity_id, aktion, ergebnis, evidence')
        .gte('ts', abIso)
        .or('art.eq.manuell_erkannt,and(art.in.(ausfuehrung,ruecklesen),ergebnis.eq.ok,akteur_art.eq.system)')
      if (bisIso) q = q.lt('ts', bisIso)
      return await q.order('ts').order('id').range(a, b)
    },
    'ad_autopilot_log', 4000)
  return rows.map(r => ({
    id: toNum(r.id),
    ts: String(r.ts ?? ''),
    art: String(r.art ?? ''),
    rule_key: toStr(r.rule_key),
    entity_level: toStr(r.entity_level),
    entity_id: toStr(r.entity_id),
    aktion: toStr(r.aktion),
    ergebnis: toStr(r.ergebnis),
    evidence: (r.evidence && typeof r.evidence === 'object') ? r.evidence as Record<string, unknown> : null,
  }))
}

/** Eigene Schreibzugriffe (Autopilot) und Meta-Fehler aus meta_write_log. */
export async function ladeWriteLog(sb: Sb, abIso: string, fehlerAbIso: string, bisIso?: string): Promise<{
  eigene: { entity_id: string; ts: string }[]
  fehler: { kind: string; code?: number | null; ts: string }[]
}> {
  const eigene: { entity_id: string; ts: string }[] = []
  const fehler: { kind: string; code?: number | null; ts: string }[] = []
  try {
    const rows = await alleZeilen<Record<string, unknown>>(
      async (a, b) => {
        let q = sb.from('meta_write_log').select('id, entity_id, ts')
          .eq('actor_kind', 'autopilot').eq('ok', true).eq('validate_only', false).gte('ts', abIso)
          .not('entity_id', 'is', null)
        if (bisIso) q = q.lt('ts', bisIso)
        return await q.order('ts').order('id').range(a, b)
      },
      'meta_write_log', 3000)
    for (const r of rows) if (toStr(r.entity_id) && toStr(r.ts)) eigene.push({ entity_id: String(r.entity_id), ts: String(r.ts) })
  } catch (err) {
    if (!tabelleFehlt((err as { db?: unknown }).db)) console.warn('[werbe-autopilot] meta_write_log (eigene):', (err as Error).message)
  }
  try {
    let q = sb.from('meta_write_log').select('ts, actor_kind, meta_error, http_status')
      .eq('ok', false).eq('validate_only', false).gte('ts', fehlerAbIso)
    if (bisIso) q = q.lt('ts', bisIso)
    const { data, error } = await q.order('ts', { ascending: false }).limit(200)
    if (error) throw Object.assign(new Error(dbFehler(error)), { db: error })
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const e = (r.meta_error && typeof r.meta_error === 'object') ? r.meta_error as Record<string, unknown> : {}
      const kind = toStr(e.kind)
      if (!kind) continue
      // Globaler Not-Aus (META_WRITES_DISABLED) ist gewollt, kein Zugriffsfehler
      if (/META_WRITES_DISABLED/.test(String(e.user_msg ?? e.userMsg ?? e.message ?? ''))) continue
      // Token/Ratenlimit betreffen das ganze Konto; Rechte-/App-Fehler zählen nur aus
      // Autopilot-Schreibzugriffen (ein Rechtefehler im Assistenten stoppt nichts)
      if ((kind === 'permission' || kind === 'dev_mode') && r.actor_kind !== 'autopilot') continue
      fehler.push({ kind, code: toNum(e.code), ts: String(r.ts ?? '') })
    }
  } catch (err) {
    if (!tabelleFehlt((err as { db?: unknown }).db)) console.warn('[werbe-autopilot] meta_write_log (Fehler):', (err as Error).message)
  }
  return { eigene, fehler }
}

export async function ladeVorrat(sb: Sb): Promise<PoolEintrag[]> {
  const rows = await alleZeilen<Record<string, unknown>>(
    async (a, b) => await sb.from('ad_creative_pool')
      .select('id, kennung, status, winkel, hook_typ, format, released_at, ziel_adset_ids, meta_ad_ids, ersetzt_kennung, aktiv_seit, fakten_pruefung, prognose')
      .neq('status', 'verworfen').order('created_at').order('id').range(a, b),
    'ad_creative_pool', 2000)
  return rows.map(r => ({
    id: String(r.id ?? ''),
    kennung: String(r.kennung ?? ''),
    status: String(r.status ?? ''),
    winkel: toStr(r.winkel),
    hook_typ: toStr(r.hook_typ),
    format: toStr(r.format),
    released_at: toStr(r.released_at),
    ziel_adset_ids: Array.isArray(r.ziel_adset_ids) ? (r.ziel_adset_ids as unknown[]).map(String) : null,
    meta_ad_ids: (r.meta_ad_ids && typeof r.meta_ad_ids === 'object' && !Array.isArray(r.meta_ad_ids))
      ? Object.fromEntries(Object.entries(r.meta_ad_ids as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : null,
    ersetzt_kennung: toStr(r.ersetzt_kennung),
    aktiv_seit: toStr(r.aktiv_seit),
    fakten_pruefung: r.fakten_pruefung === true,
    prognose: toNum(r.prognose),
  }))
}

/** Konto-Spend (EUR) und Kurs aus ad_insights_daily (Meta). Kurs plausibel 0,9-1,6 wie metaGraph.wechselkurs. */
export async function ladeKonto(sb: Sb, heute: string, abDatum?: string): Promise<{
  konto: NonNullable<RegelKontext['konto']>
  fx: RegelKontext['fx']
  tage: Map<string, { usd: number; eur: number }>
}> {
  const gestern = datumPlus(heute, -1)
  const monatsStart = `${heute.slice(0, 7)}-01`
  const von = [monatsStart, datumPlus(heute, -8), ...(abDatum ? [abDatum] : [])].sort()[0]
  const rows = await alleZeilen<Record<string, unknown>>(
    async (a, b) => await sb.from('ad_insights_daily').select('day, spend, spend_eur').eq('platform', 'meta')
      .gte('day', von).lte('day', gestern).order('day').order('ad_id').range(a, b),
    'ad_insights_daily (Konto)', 10000)
  const tage = new Map<string, { usd: number; eur: number }>()
  for (const r of rows) {
    const d = String(r.day ?? '').slice(0, 10)
    const t = tage.get(d) ?? { usd: 0, eur: 0 }
    t.usd += toNum(r.spend) ?? 0
    t.eur += toNum(r.spend_eur) ?? 0
    tage.set(d, t)
  }
  return { ...kontoAusTagen(tage, heute), tage }
}

/** Konto-Kennzahlen + Kurs für einen Lauftag aus vorab aggregierten Tageswerten (auch Replay). */
export function kontoAusTagen(tage: Map<string, { usd: number; eur: number }>, heute: string): {
  konto: NonNullable<RegelKontext['konto']>; fx: RegelKontext['fx']
} {
  const gestern = datumPlus(heute, -1)
  const monatsStart = `${heute.slice(0, 7)}-01`
  const w7 = datumPlus(gestern, -6)
  let gEur = 0, wEur = 0, mEur = 0, wUsd = 0, wEurK = 0
  let letzter: { usd: number; eur: number } | null = null
  let letzterTag = ''
  for (const [d, t] of tage) {
    if (d > gestern) continue
    if (d === gestern) gEur += t.eur
    if (d >= w7) {
      wEur += t.eur
      if (t.usd > 0 && t.eur > 0) { wUsd += t.usd; wEurK += t.eur }
    }
    if (d >= monatsStart) mEur += t.eur
    if (d >= w7 && t.usd > 0 && t.eur > 0 && d > letzterTag) { letzterTag = d; letzter = t }
  }
  const plausibel = (k: number) => (Number.isFinite(k) && k >= 0.9 && k <= 1.6 ? k : null)
  const mittel = wEurK > 1 ? plausibel(wUsd / wEurK) : null
  const aktuell = letzter && letzter.eur > 0.5 ? plausibel(letzter.usd / letzter.eur) : null
  return {
    konto: {
      spend_gestern_eur: Math.round(gEur * 100) / 100,
      spend_7d_eur: Math.round(wEur * 100) / 100,
      spend_monat_eur: Math.round(mEur * 100) / 100,
    },
    fx: { usd_per_eur: aktuell, mittel_7d: mittel },
  }
}

/** Sync-Ledger: letzter Erfolg, CAPI-Läufe, strukturierte Meta-Fehler. */
export async function ladeSyncLedger(sb: Sb, abDatum: string, bisIso?: string): Promise<{
  letzter_erfolg: string | null
  capi: { ts: string; ok: boolean }[]
  fehler: { kind: string; code?: number | null; ts: string }[]
}> {
  const out = { letzter_erfolg: null as string | null, capi: [] as { ts: string; ok: boolean }[], fehler: [] as { kind: string; code?: number | null; ts: string }[] }
  let q = sb.from('ad_autopilot_runs').select('lauf_datum, status, started_at, finished_at, summary, fehler')
    .eq('schritt', 'sync').gte('lauf_datum', abDatum)
  if (bisIso) q = q.lt('started_at', bisIso)
  const { data, error } = await q.order('started_at', { ascending: false }).limit(10)
  if (error) { console.warn('[werbe-autopilot] Sync-Ledger:', dbFehler(error)); return out }
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const ts = toStr(r.finished_at) ?? toStr(r.started_at) ?? ''
    if (r.status === 'fertig' && !out.letzter_erfolg) out.letzter_erfolg = ts || null
    const s = (r.summary && typeof r.summary === 'object') ? r.summary as Record<string, unknown> : {}
    if (s.capi_error != null && s.capi_error !== '') out.capi.push({ ts, ok: false })
    else if (s.capi_sent != null) out.capi.push({ ts, ok: true })
    const mf = Array.isArray(s.meta_fehler) ? s.meta_fehler : s.meta_error ? [s.meta_error] : []
    for (const f of mf as Array<Record<string, unknown>>) {
      const kind = toStr(f?.kind)
      if (kind) out.fehler.push({ kind, code: toNum(f?.code), ts })
    }
  }
  return out
}

/** Freie Termin-Slots der nächsten 7 Tage über funnel-api (gleiche Logik wie der Funnel). */
export async function ladeFreieSlots(now: Date): Promise<{ anzahl: number | null; quelle: string }> {
  const r = await funktionAufrufen('funnel-api', { action: 'slots' }, 25_000)
  if (!r.ok) return { anzahl: null, quelle: `funnel-api nicht erreichbar (${r.status || r.fehler || 'Fehler'})` }
  const slots = (r.json as { slots?: unknown } | null)?.slots
  if (!Array.isArray(slots)) return { anzahl: null, quelle: 'funnel-api ohne slots' }
  const grenze = now.getTime() + 7 * 86400000
  const anzahl = slots.filter(s => {
    const t = Date.parse(String(s))
    return Number.isFinite(t) && t >= now.getTime() && t < grenze
  }).length
  return { anzahl, quelle: 'funnel-api' }
}

// ── Gesamt ──────────────────────────────────────────────────────────────────

/** Lebensbeginn je Anzeige aus den Tageswerten (erster Tag mit Impressionen nach Datenbeginn). */
export function sichereStarts(insights: InsightTag[], insightsAb: string): Map<string, string> {
  const erst = new Map<string, string>()
  for (const r of insights) {
    if (!(r.impressions > 0)) continue
    const alt = erst.get(r.ad_id)
    if (!alt || r.day < alt) erst.set(r.ad_id, r.day)
  }
  const out = new Map<string, string>()
  for (const [id, d] of erst) if (d > insightsAb) out.set(id, d)
  return out
}

export const INSIGHT_TAGE = 100

export async function ladeKontext(sb: Sb, now: Date): Promise<{ ctx: RegelKontext; meta: KontextMeta }> {
  const { heute, gestern } = berlinHeute(now)
  const warnungen: string[] = []
  const zaehler: Record<string, number> = {}
  const vor = (tage: number) => new Date(now.getTime() - tage * 86400000).toISOString()

  const { settings, roh, modus } = await ladeEinstellungen(sb)
  const { regeln, parameter, verwaltet } = await ladeRegeln(sb)
  const qual = await ladeQualitaet(sb, gestern)
  zaehler.qualitaet = qual.zeilen.length
  if (!qual.stichtag) warnungen.push('Keine Qualitätszeilen vorhanden.')
  else if (qual.stichtag < gestern) warnungen.push(`Qualitätszeilen sind vom ${qual.stichtag}, nicht von gestern.`)

  const snaps = await ladeSnapshots(sb, datumPlus(heute, -3), heute)
  zaehler.snapshots = snaps.zeilen.length
  if (!snaps.zeilen.length) warnungen.push('Keine Schnappschüsse der letzten 3 Tage (meta-ads-sync Schritt 1c).')
  const snapAktuell = aktuelleSnapshots(snaps.zeilen)

  const aktiveAds = [...snapAktuell.values()].filter(z => z.entity_level === 'ad' && z.status === 'ACTIVE').map(z => z.entity_id)
  const ladeAb = datumPlus(heute, -INSIGHT_TAGE)
  const datenBeginn = await ersterInsightTag(sb)
  const insightsAb = datenBeginn && datenBeginn > ladeAb ? datenBeginn : ladeAb
  const insights = aktiveAds.length ? await ladeInsights(sb, aktiveAds, ladeAb, gestern) : []
  zaehler.insights = insights.length

  const fruehphase = qual.stichtag ? await ladeFruehphase(sb, sichereStarts(insights, insightsAb), qual.stichtag) : {}
  zaehler.fruehphase = Object.keys(fruehphase).length

  const aktionen = await ladeAktionen(sb, vor(14))
  zaehler.aktionen = aktionen.length
  const log = await ladeLog(sb, vor(14))
  zaehler.log = log.length
  const wl = await ladeWriteLog(sb, vor(14), vor(26 / 24))
  zaehler.eigene_writes = wl.eigene.length
  const vorrat = await ladeVorrat(sb)
  zaehler.vorrat = vorrat.length
  const kt = await ladeKonto(sb, heute)
  const sync = await ladeSyncLedger(sb, datumPlus(heute, -5))
  if (!sync.letzter_erfolg) warnungen.push('Kein erfolgreicher Sync im Ledger (ad_autopilot_runs schritt sync).')
  const slots = await ladeFreieSlots(now)
  if (slots.anzahl === null) warnungen.push(`Freie Slots unbekannt: ${slots.quelle}. S1 bleibt gesperrt.`)

  const ctx: RegelKontext = {
    now: now.getTime(),
    settings,
    rules: regeln,
    qualitaet: qual.zeilen,
    snapshots: snaps.zeilen,
    insights,
    insights_ab: insightsAb,
    fruehphase,
    aktionen,
    log,
    eigene_writes: wl.eigene,
    vorrat,
    freie_slots_7d: slots.anzahl,
    fx: kt.fx,
    konto: kt.konto,
    sync: { letzter_erfolg: sync.letzter_erfolg },
    meta_fehler: [...wl.fehler, ...sync.fehler],
    capi_laeufe: sync.capi,
    verwaltete_kampagnen: verwaltet,
    parameter,
  }
  const meta: KontextMeta = {
    heute, gestern, modus, settingsRoh: roh, stichtag: qual.stichtag, snapAktuell,
    kampagnenNamen: snaps.namen, regeln, zaehler, warnungen, slots_quelle: slots.quelle,
  }
  return { ctx, meta }
}
