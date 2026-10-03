// Edge Function: meta-ads-sync
// Synct Meta-Ads-Daten (Graph API, direkt, kein Claude nötig) in die
// Werbemanager-Tabellen und führt manuell bestätigte Aktionen aus der
// Warteschlange ad_actions bei Meta aus (pause/activate). Läuft täglich per
// pg_cron und on-demand aus dem CRM („Aktualisieren"-Button, Sofort-Ausführung
// nach dem Vormerken einer Aktion).
//
// Body (alles optional):
//   { days?: number }              wie viele Tage rückwirkend (Default 7, max 90)
//   { mode?: 'actions_only' }      nur die Aktions-Queue ausführen (schnell)
//   { kette?: true }               nur System-Aufruf (pg_cron): nach erfolgreichem Sync
//                                  werbe-autopilot {aktion:'nacht'} anstoßen
//
// Schritte (Stand Oktober 2026, Graph-Version aus _shared/metaGraph.ts, Standard v25.0):
//   1  Insights je Anzeige und Tag -> ad_insights_daily (Pflicht). Seit 10/2026 auch
//      outbound_clicks, landing_page_views (actions), video_3s_true (actions video_view
//      = echte 3-Sek.-Aufrufe), thruplays, platform_schedules, campaign_id, adset_id.
//      video_3s bleibt aus Kompatibilität die 2-Sekunden-Metrik wie bisher.
//      Anzeigen -> ad_catalog (Pflicht), plus effective_status, configured_status,
//      issues_info, review_feedback, url_tags, created_time, updated_time.
//      Kampagnen/Anzeigengruppen -> Spiegel meta_campaigns / meta_adsets (optional).
//   1b Conversions API: Termin gebucht (Schedule), Termin stattgefunden
//      (AppointmentHeld), gute Bewertung (QualifiedLead), Sale (Purchase mit
//      Provisionswert). Nur Meta-Leads (_shared/werbeCapi.ts istMetaLead), Dedupe über
//      capi_log und capi_outbox (status gesendet), Fenster 7 Tage. Nachhol-Netz für
//      werbe-signal (Echtzeit), gleiche event_ids.
//   1c Tagesstand -> ad_entity_snapshot (optional, nur lesend bei Meta): Kampagnen,
//      Anzeigengruppen (Budget, Lernstatus, Status) und Anzeigen plus Insights
//      last_7d auf Anzeigen- und Gruppenebene (Reichweite, Frequenz, Rankings).
//   2  Manuell bestätigte Aktionen über _shared/werbeAusfuehren.ts (modus 'manuell').
//   Ledger ad_autopilot_runs (schritt 'sync') nur bei System-Aufrufen.
//
// Optionale Teile (neue Spalten/Tabellen aus den Migrationen 20261003*) dürfen den
// Sync nie scheitern lassen: fehlt eine Spalte oder Tabelle, wird gewarnt und ohne
// sie weitergemacht.
//
// ── Secrets (Supabase Dashboard → Settings → Edge Functions → Secrets) ──
//   META_ACCESS_TOKEN   = System-User-Token „Analytics Sync" (ads_read + ads_management, Ablauf: nie)
//   META_AD_ACCOUNT_ID  = 4065490590399677 (Sveru Marketing LLC, USD)
//   META_PIXEL_ID       = 1083578343946189 (Sveru Marketing LLC's Pixel, das aktive)
//   META_GRAPH_VERSION  = optional (Form vNN.0), sonst v25.0
//   META_WRITES_DISABLED = 1 sperrt CAPI und Aktionen (Lesen läuft weiter)
//
// ── Deployment ──
//   supabase functions deploy meta-ads-sync --no-verify-jwt

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { requireAdsAccess, AdsAuthError } from '../_shared/adsAuth.ts'
import {
  GRAPH_VERSION, graphAll, getLastUsage, logMetaWrite, metaEnv, metaErrorLogFelder, MetaApiError,
  type GraphParams,
} from '../_shared/metaGraph.ts'
import {
  buildCapiEvent, CAPI_LEAD_FIELDS, CAPI_LEAD_FIELDS_ALT, CAPI_MAX_EVENTS_JE_POST, istMetaLead,
  kandidatAusLead, sendCapiEvents, type CapiBasis, type CapiCandidate, type CapiEvent, type CapiLead,
} from '../_shared/werbeCapi.ts'
import { ausfuehren, berlinTag } from '../_shared/werbeAusfuehren.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const FN = 'meta-ads-sync'

type Sb = SupabaseClient
type Row = Record<string, unknown>
type Summary = Record<string, unknown>
interface MetaAktion { action_type: string; value: string }

interface InsightRow {
  ad_id: string
  ad_name?: string
  campaign_id?: string
  campaign_name?: string
  adset_id?: string
  adset_name?: string
  spend?: string
  impressions?: string
  reach?: string
  frequency?: string
  inline_link_clicks?: string
  actions?: MetaAktion[]
  outbound_clicks?: MetaAktion[]
  video_continuous_2_sec_watched_actions?: MetaAktion[]
  video_thruplay_watched_actions?: MetaAktion[]
  date_start: string
}

interface Insight7d {
  ad_id?: string
  adset_id?: string
  campaign_id?: string
  reach?: string
  impressions?: string
  frequency?: string
  spend?: string
  inline_link_clicks?: string
  actions?: MetaAktion[]
  quality_ranking?: string
  engagement_rate_ranking?: string
  conversion_rate_ranking?: string
}

// ── Graph-Feldlisten ─────────────────────────────────────────────────────────
// Jeweils eine volle Liste und die bisherige (v18) als Rückfall, falls Meta ein
// Feld in dieser Version nicht kennt (Fehler 100). Die Pflichtdaten kommen so immer.

const INSIGHT_FELDER_ALT =
  'ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,spend,impressions,reach,frequency,inline_link_clicks,actions,outbound_clicks,video_continuous_2_sec_watched_actions'
const INSIGHT_FELDER = `${INSIGHT_FELDER_ALT},video_thruplay_watched_actions`

const AD_FELDER_ALT = 'id,name,status,adset_id,campaign_id,creative{id,thumbnail_url}'
const AD_FELDER =
  'id,name,status,effective_status,configured_status,adset_id,campaign_id,created_time,updated_time,issues_info,ad_review_feedback,creative{id,thumbnail_url,url_tags}'

const KAMPAGNE_FELDER_ALT = 'id,name'
const KAMPAGNE_FELDER =
  'id,account_id,name,objective,status,effective_status,configured_status,buying_type,special_ad_categories,special_ad_category_country,daily_budget,lifetime_budget,spend_cap,budget_remaining,bid_strategy,is_adset_budget_sharing_enabled,start_time,stop_time,advantage_state_info,issues_info,created_time,updated_time'

const ADSET_FELDER_ALT = 'id,name'
const ADSET_FELDER =
  'id,account_id,campaign_id,name,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,bid_strategy,bid_amount,optimization_goal,billing_event,destination_type,promoted_object,attribution_spec,targeting,dsa_beneficiary,dsa_payor,learning_stage_info,start_time,end_time,issues_info,created_time,updated_time'

const SNAP_AD_FELDER_ALT = 'ad_id,adset_id,campaign_id,reach,impressions,frequency,spend,inline_link_clicks,actions'
const SNAP_AD_FELDER = `${SNAP_AD_FELDER_ALT},quality_ranking,engagement_rate_ranking,conversion_rate_ranking`
const SNAP_ADSET_FELDER = 'adset_id,campaign_id,reach,impressions,frequency,spend,inline_link_clicks,actions'

// Schedule-Conversions laut Meta. Welcher action_type bei unserem Pixel-Event
// „Schedule" erscheint, ist nicht abschließend belegt: schedule_total (alle Quellen)
// zuerst, sonst schedule_website, sonst offsite_conversion.fb_pixel_schedule.
// Nie summieren (die Typen überlappen). Nach dem ersten Lauf in den Rohdaten prüfen.
const SCHEDULE_TYPEN = ['schedule_total', 'schedule_website', 'offsite_conversion.fb_pixel_schedule']

// ── kleine Helfer ────────────────────────────────────────────────────────────

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? '0'))
  return Number.isFinite(n) ? n : 0
}
const int = (v: unknown): number => Math.trunc(num(v))
const intOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? Math.trunc(n) : null
}
/** Budget/Betrag in Cent wie werbeAusfuehren: 0 oder leer -> null. */
const centsOrNull = (v: unknown): number | null => {
  const n = intOrNull(v)
  return n !== null && n > 0 ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(x => String(x)).filter(Boolean) : [])
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const digits = (v: unknown): string => String(v ?? '').replace(/[^0-9]/g, '')
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const fehlerText = (e: unknown): string => String((e as { message?: string } | null)?.message ?? e).slice(0, 300)

const actionValue = (arr: MetaAktion[] | undefined, type: string): number =>
  num(arr?.find(a => a.action_type === type)?.value)
/** Wert des gesuchten action_type, sonst der erste Eintrag (Video-Felder liefern meist genau einen). */
const aktionOderErste = (arr: MetaAktion[] | undefined, type: string): number =>
  arr?.some(a => a.action_type === type) ? actionValue(arr, type) : num(arr?.[0]?.value)
/** Erster vorhandener action_type aus der Prioritätenliste. */
const ersteAktion = (arr: MetaAktion[] | undefined, types: string[]): number => {
  for (const t of types) if (arr?.some(a => a.action_type === t)) return actionValue(arr, t)
  return 0
}

/** Meta-Zeit (ISO mit +0000 oder Unix-Sekunden) -> ISO-String, sonst null. */
function isoZeit(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim()
    if (/^\d+$/.test(s)) return isoZeit(Number(s))
    const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
    return Number.isFinite(t) ? new Date(t).toISOString() : null
  }
  return null
}

function spalteFehlt(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === 'PGRST204' || e?.code === '42703' ||
    /column .* does not exist|could not find the .* column/i.test(String(e?.message ?? ''))
}
function tabelleFehlt(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === '42P01' || e?.code === 'PGRST205' ||
    /relation .* does not exist|could not find the table/i.test(String(e?.message ?? ''))
}

function ohneSpalten(rows: Row[], spalten: readonly string[]): Row[] {
  return rows.map(r => {
    const k = { ...r }
    for (const s of spalten) delete k[s]
    return k
  })
}

/**
 * Upsert in Blöcken. Fehlen die neuen Spalten (Migration noch nicht eingespielt),
 * wird gewarnt und ohne sie weitergeschrieben. Andere Fehler werfen (Pflichtdaten).
 */
async function upsertMitRueckfall(
  sb: Sb, table: string, rows: Row[], onConflict: string, neueSpalten: readonly string[],
): Promise<{ n: number; ohneNeue: boolean }> {
  let ohneNeue = false
  for (let i = 0; i < rows.length; i += 300) {
    const block = rows.slice(i, i + 300)
    let { error } = await sb.from(table).upsert(ohneNeue ? ohneSpalten(block, neueSpalten) : block, { onConflict })
    if (error && !ohneNeue && neueSpalten.length && spalteFehlt(error)) {
      ohneNeue = true
      console.warn(`[${FN}] ${table}: neue Spalten fehlen (Migration 20261003100000?), schreibe ohne sie:`, fehlerText(error))
      ;({ error } = await sb.from(table).upsert(ohneSpalten(block, neueSpalten), { onConflict }))
    }
    if (error) throw new Error(`${table}-Upsert: ${fehlerText(error)}`)
  }
  return { n: rows.length, ohneNeue }
}

/** Optionaler Upsert (Spiegel, Schnappschuss): wirft nie, gibt Fehlertext oder null zurück. */
async function upsertOptional(sb: Sb, table: string, rows: Row[], onConflict: string): Promise<string | null> {
  try {
    for (let i = 0; i < rows.length; i += 300) {
      const { error } = await sb.from(table).upsert(rows.slice(i, i + 300), { onConflict })
      if (error) {
        const msg = tabelleFehlt(error)
          ? `Tabelle ${table} fehlt (Migration noch nicht eingespielt)`
          : `${table}: ${fehlerText(error)}`
        console.warn(`[${FN}] ${msg}`)
        return msg
      }
    }
    return null
  } catch (err) {
    console.warn(`[${FN}] ${table}:`, errMsg(err))
    return `${table}: ${errMsg(err).slice(0, 300)}`
  }
}

/**
 * Graph-Liste mit voller Feldliste. Lehnt Meta sie ab (unbekanntes Feld = validation,
 * „zu viele Daten" = code 1/transient, sonstiges unknown), einmal mit der bisherigen
 * Feldliste, damit die Pflichtdaten trotzdem kommen. Token-, Rechte- und Limitfehler
 * werfen sofort (da hilft keine kleinere Liste). voll=false: nur Rückfall-Felder.
 */
async function listeMitRueckfall<T>(
  path: string, params: GraphParams, felder: string, rueckfall: string,
): Promise<{ rows: T[]; voll: boolean }> {
  try {
    return { rows: await graphAll<T>(path, { ...params, fields: felder }), voll: true }
  } catch (err) {
    if (!(err instanceof MetaApiError) || !['validation', 'transient', 'unknown'].includes(err.kind)) throw err
    console.warn(`[${FN}] ${path}: volle Feldliste abgelehnt (${err.kind}), nutze Rückfall:`, err.message.slice(0, 200))
    return { rows: await graphAll<T>(path, { ...params, fields: rueckfall }), voll: false }
  }
}

async function usdJeEur(): Promise<number> {
  let usdPerEur = 1.14
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD', { signal: ctrl.signal })
    const j = await r.json()
    if (j?.rates?.USD) usdPerEur = j.rates.USD
  } catch {
    console.warn(`[${FN}] Kurs-API nicht erreichbar, Fallback`, usdPerEur)
  } finally {
    clearTimeout(timer)
  }
  return usdPerEur
}

// ── Spiegel-Zeilen ───────────────────────────────────────────────────────────

function kampagnenZeile(c: Row, account: string, jetzt: string): Row {
  const asi = obj(c.advantage_state_info)
  return {
    campaign_id: String(c.id),
    account_id: digits(c.account_id) || account,
    name: str(c.name),
    objective: str(c.objective),
    status: str(c.status),
    effective_status: str(c.effective_status),
    buying_type: str(c.buying_type),
    special_ad_categories: strArr(c.special_ad_categories),
    special_ad_category_country: strArr(c.special_ad_category_country),
    daily_budget_cents: centsOrNull(c.daily_budget),
    lifetime_budget_cents: centsOrNull(c.lifetime_budget),
    spend_cap_cents: centsOrNull(c.spend_cap),
    bid_strategy: str(c.bid_strategy),
    is_adset_budget_sharing_enabled: typeof c.is_adset_budget_sharing_enabled === 'boolean' ? c.is_adset_budget_sharing_enabled : null,
    start_time: isoZeit(c.start_time),
    stop_time: isoZeit(c.stop_time),
    advantage_state: str(asi?.advantage_state),
    advantage_state_info: asi,
    issues: c.issues_info ?? null,
    created_time: isoZeit(c.created_time),
    updated_time: isoZeit(c.updated_time),
    raw: c,
    synced_at: jetzt,
  }
}

function adsetZeile(a: Row, account: string, jetzt: string): Row {
  const lsi = obj(a.learning_stage_info)
  return {
    adset_id: String(a.id),
    campaign_id: str(a.campaign_id),
    account_id: digits(a.account_id) || account,
    name: str(a.name),
    status: str(a.status),
    effective_status: str(a.effective_status),
    daily_budget_cents: centsOrNull(a.daily_budget),
    lifetime_budget_cents: centsOrNull(a.lifetime_budget),
    bid_strategy: str(a.bid_strategy),
    bid_amount_cents: centsOrNull(a.bid_amount),
    optimization_goal: str(a.optimization_goal),
    billing_event: str(a.billing_event),
    destination_type: str(a.destination_type),
    promoted_object: a.promoted_object ?? null,
    attribution_spec: a.attribution_spec ?? null,
    targeting: a.targeting ?? null,
    dsa_beneficiary: str(a.dsa_beneficiary),
    dsa_payor: str(a.dsa_payor),
    learning_status: str(lsi?.status),
    learning_conversions: intOrNull(lsi?.conversions),
    last_sig_edit_ts: isoZeit(lsi?.last_sig_edit_ts),
    learning_stage_info: lsi,
    start_time: isoZeit(a.start_time),
    end_time: isoZeit(a.end_time),
    issues: a.issues_info ?? null,
    created_time: isoZeit(a.created_time),
    updated_time: isoZeit(a.updated_time),
    raw: a,
    synced_at: jetzt,
  }
}

// ── Schritt 1c: Tagesstand ad_entity_snapshot ────────────────────────────────

interface SnapshotEingabe {
  kampagnen: Row[]
  adsets: Row[]
  ads: Row[]
  usdPerEur: number
  snapDate: string
  jetzt: string
}

function kennzahlen7d(r: Insight7d | undefined, mitReichweite: boolean): Row {
  if (!r) return {}
  return {
    reach_7d: mitReichweite ? int(r.reach) : null,
    impressions_7d: int(r.impressions),
    frequency_7d: mitReichweite ? num(r.frequency) : null,
    video_3s_7d: int(actionValue(r.actions, 'video_view')),
    link_clicks_7d: int(r.inline_link_clicks) || int(actionValue(r.actions, 'link_click')),
    spend_7d_usd: num(r.spend),
  }
}

async function snapshotSchreiben(sb: Sb, account: string, e: SnapshotEingabe, summary: Summary): Promise<void> {
  const basis = { level: 'ad', date_preset: 'last_7d', limit: 500 }
  const adIns = await listeMitRueckfall<Insight7d>(`act_${account}/insights`, basis, SNAP_AD_FELDER, SNAP_AD_FELDER_ALT)
  const adsetIns = await graphAll<Insight7d>(`act_${account}/insights`, {
    level: 'adset', date_preset: 'last_7d', limit: 500, fields: SNAP_ADSET_FELDER,
  })
  const jeAd = new Map(adIns.rows.filter(r => r.ad_id).map(r => [String(r.ad_id), r]))
  const jeAdset = new Map(adsetIns.filter(r => r.adset_id).map(r => [String(r.adset_id), r]))

  const gemeinsam = { snap_date: e.snapDate, usd_per_eur: e.usdPerEur, synced_at: e.jetzt }
  const zeilen: Row[] = []

  // Kampagnen: additive Kennzahlen aus den Anzeigengruppen summiert (Reichweite/Frequenz
  // sind nicht additiv und bleiben leer).
  const summeJeKampagne = new Map<string, { imp: number; vid: number; klick: number; spend: number }>()
  for (const r of adsetIns) {
    const k = String(r.campaign_id ?? '')
    if (!k) continue
    const s = summeJeKampagne.get(k) ?? { imp: 0, vid: 0, klick: 0, spend: 0 }
    s.imp += int(r.impressions)
    s.vid += int(actionValue(r.actions, 'video_view'))
    s.klick += int(r.inline_link_clicks) || int(actionValue(r.actions, 'link_click'))
    s.spend += num(r.spend)
    summeJeKampagne.set(k, s)
  }
  for (const c of e.kampagnen) {
    const id = String(c.id ?? '')
    if (!id) continue
    const s = summeJeKampagne.get(id)
    zeilen.push({
      ...gemeinsam,
      entity_level: 'campaign',
      entity_id: id,
      parent_id: null,
      campaign_id: id,
      name: str(c.name),
      status: str(c.status),
      effective_status: str(c.effective_status),
      daily_budget_cents: centsOrNull(c.daily_budget),
      lifetime_budget_cents: centsOrNull(c.lifetime_budget),
      spend_cap_cents: centsOrNull(c.spend_cap),
      special_ad_categories: strArr(c.special_ad_categories),
      issues_info: c.issues_info ?? null,
      updated_time: isoZeit(c.updated_time),
      ...(s ? {
        impressions_7d: s.imp, video_3s_7d: s.vid, link_clicks_7d: s.klick,
        spend_7d_usd: Math.round(s.spend * 100) / 100,
      } : {}),
    })
  }

  for (const a of e.adsets) {
    const id = String(a.id ?? '')
    if (!id) continue
    zeilen.push({
      ...gemeinsam,
      entity_level: 'adset',
      entity_id: id,
      parent_id: str(a.campaign_id),
      campaign_id: str(a.campaign_id),
      name: str(a.name),
      status: str(a.status),
      effective_status: str(a.effective_status),
      daily_budget_cents: centsOrNull(a.daily_budget),
      lifetime_budget_cents: centsOrNull(a.lifetime_budget),
      optimization_goal: str(a.optimization_goal),
      promoted_object: a.promoted_object ?? null,
      learning_stage_info: obj(a.learning_stage_info),
      issues_info: a.issues_info ?? null,
      updated_time: isoZeit(a.updated_time),
      ...kennzahlen7d(jeAdset.get(id), true),
    })
  }

  for (const a of e.ads) {
    const id = String(a.id ?? '')
    if (!id) continue
    const ins = jeAd.get(id)
    const creative = obj(a.creative)
    zeilen.push({
      ...gemeinsam,
      entity_level: 'ad',
      entity_id: id,
      parent_id: str(a.adset_id),
      campaign_id: str(a.campaign_id),
      name: str(a.name),
      status: str(a.status),
      effective_status: str(a.effective_status),
      issues_info: a.issues_info ?? null,
      ad_review_feedback: a.ad_review_feedback ?? null,
      creative_id: str(creative?.id),
      updated_time: isoZeit(a.updated_time),
      ...kennzahlen7d(ins, true),
      quality_ranking: str(ins?.quality_ranking),
      engagement_rate_ranking: str(ins?.engagement_rate_ranking),
      conversion_rate_ranking: str(ins?.conversion_rate_ranking),
    })
  }

  // Einheitlicher Spaltensatz je Zeile (Bulk-Upsert setzt fehlende Schlüssel auf NULL;
  // so steht das bewusst da und nicht zufällig).
  const SPALTEN = [
    'snap_date', 'entity_level', 'entity_id', 'parent_id', 'campaign_id', 'name', 'status', 'effective_status',
    'daily_budget_cents', 'lifetime_budget_cents', 'spend_cap_cents', 'optimization_goal', 'promoted_object',
    'special_ad_categories', 'learning_stage_info', 'issues_info', 'ad_review_feedback', 'creative_id', 'updated_time',
    'reach_7d', 'impressions_7d', 'frequency_7d', 'video_3s_7d', 'link_clicks_7d', 'spend_7d_usd',
    'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking', 'usd_per_eur', 'synced_at',
  ] as const
  const voll = zeilen.map(z => Object.fromEntries(SPALTEN.map(s => [s, z[s] ?? null])))

  const fehler = await upsertOptional(sb, 'ad_entity_snapshot', voll, 'snap_date,entity_level,entity_id')
  if (fehler) {
    summary.snapshot_error = fehler
    return
  }
  summary.snapshot_rows = voll.length
  if (!adIns.voll) summary.snapshot_ohne_rankings = true
}

// ── Schritt 1b: Conversions API ──────────────────────────────────────────────

/** Select-Liste für leads: mit meta_leadgen_id nur, wenn die Spalte schon existiert. */
async function capiLeadFelder(sb: Sb): Promise<string> {
  const { error } = await sb.from('leads').select('meta_leadgen_id').limit(1)
  if (error) {
    console.warn(`[${FN}] leads.meta_leadgen_id nicht lesbar (Migration 20261003101000?), CAPI ohne Formular-Lead-ID`)
    return CAPI_LEAD_FIELDS_ALT
  }
  return CAPI_LEAD_FIELDS
}

/** event_ids, die schon gesendet sind (capi_log, capi_outbox status gesendet). */
async function schonGesendet(sb: Sb, ids: string[]): Promise<Set<string>> {
  const sent = new Set<string>()
  let outboxDa = true
  for (let i = 0; i < ids.length; i += 200) {
    const block = ids.slice(i, i + 200)
    const { data: logRows, error } = await sb.from('capi_log').select('event_id').in('event_id', block)
    // Ohne lesbares capi_log lieber nichts senden als doppelt
    if (error) throw new Error(`capi_log lesen: ${fehlerText(error)}`)
    for (const r of (logRows ?? []) as { event_id: string }[]) sent.add(r.event_id)
    if (!outboxDa) continue
    const { data: ob, error: obErr } = await sb.from('capi_outbox')
      .select('event_id').eq('status', 'gesendet').in('event_id', block)
    if (obErr) {
      if (!tabelleFehlt(obErr)) throw new Error(`capi_outbox lesen: ${fehlerText(obErr)}`)
      outboxDa = false   // Tabelle kommt erst mit Migration 20261003112000
      continue
    }
    for (const r of (ob ?? []) as { event_id: string }[]) sent.add(r.event_id)
  }
  return sent
}

async function capiRueckspielen(sb: Sb, summary: Summary): Promise<void> {
  const { pixelId } = metaEnv()
  const winStart = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const sek = (iso: string | null | undefined) => Math.trunc(new Date(String(iso ?? '')).getTime() / 1000)
  const felder = await capiLeadFelder(sb)

  const kandidaten: CapiCandidate[] = []
  let keinMeta = 0
  const nimm = (lead: CapiLead | null | undefined, basis: CapiBasis) => {
    if (!lead) return
    // Nur Meta-Leads (fbp allein zählt nicht, siehe werbeCapi.istMetaLead)
    if (!istMetaLead(lead)) { keinMeta++; return }
    kandidaten.push(kandidatAusLead(lead, basis))
  }

  // Termin gebucht -> Schedule. internal raus: interne Termine als Conversion zu melden
  // verfälscht die Anzeigen-Optimierung. kind wie der capi_outbox-Trigger.
  const appts = await sb.from('crm_appointments')
    .select(`id, lead_id, created_at, lead:leads(${felder})`)
    .eq('internal', false)
    .eq('kind', 'appointment')
    .gte('created_at', winStart)
    .not('lead_id', 'is', null)
    .limit(1000)
  if (appts.error) throw new Error(`Termine lesen: ${fehlerText(appts.error)}`)
  for (const a of (appts.data ?? []) as Array<{ id: string; created_at: string; lead: CapiLead | null }>) {
    nimm(a.lead, { event_id: `appt-${a.id}`, event_name: 'Schedule', event_time: sek(a.created_at), from_website: true })
  }

  // Termin stattgefunden -> AppointmentHeld (Bewertungszeitpunkt = updated_at)
  const held = await sb.from('crm_appointments')
    .select(`id, lead_id, updated_at, lead:leads(${felder})`)
    .eq('outcome', 'completed')
    .eq('internal', false)
    .eq('kind', 'appointment')
    .gte('updated_at', winStart)
    .not('lead_id', 'is', null)
    .limit(1000)
  if (held.error) throw new Error(`Gehaltene Termine lesen: ${fehlerText(held.error)}`)
  for (const a of (held.data ?? []) as Array<{ id: string; updated_at: string; lead: CapiLead | null }>) {
    nimm(a.lead, { event_id: `held-${a.id}`, event_name: 'AppointmentHeld', event_time: sek(a.updated_at) })
  }

  // Gute Bewertung -> QualifiedLead
  const rated = await sb.from('leads')
    .select(`${felder}, quality_rated_at`)
    .eq('quality_rating', 'gut')
    .gte('quality_rated_at', winStart)
    .limit(1000)
  if (rated.error) throw new Error(`Bewertungen lesen: ${fehlerText(rated.error)}`)
  for (const l of (rated.data ?? []) as Array<CapiLead & { quality_rated_at: string }>) {
    nimm(l, { event_id: `goodlead-${l.id}`, event_name: 'QualifiedLead', event_time: sek(l.quality_rated_at) })
  }

  // Sale (Anzahlung/Provision) -> Purchase mit Provisionswert
  const sales = await sb.from('deals')
    .select(`id, lead_id, commission_amount, updated_at, lead:leads(${felder})`)
    .in('phase', ['anzahlung', 'provision_erhalten'])
    .gte('updated_at', winStart)
    .limit(1000)
  if (sales.error) throw new Error(`Deals lesen: ${fehlerText(sales.error)}`)
  for (const d of (sales.data ?? []) as Array<{ id: string; commission_amount: number | null; updated_at: string; lead: CapiLead | null }>) {
    nimm(d.lead, {
      event_id: `sale-${d.id}`, event_name: 'Purchase', event_time: sek(d.updated_at),
      value: Number(d.commission_amount ?? 0) || 0, currency: 'EUR',
    })
  }

  summary.capi_kein_meta = keinMeta

  // Bereits gesendete raus (Tageslauf und werbe-signal teilen sich die event_ids)
  const ids = [...new Set(kandidaten.map(c => c.event_id))]
  const sent = await schonGesendet(sb, ids)
  const gesehen = new Set<string>()
  const frisch = kandidaten.filter(c => {
    if (sent.has(c.event_id) || gesehen.has(c.event_id)) return false
    gesehen.add(c.event_id)
    return true
  })

  const events: CapiEvent[] = []
  const benutzt: CapiCandidate[] = []
  for (const c of frisch) {
    const ev = await buildCapiEvent(c)
    if (ev) { events.push(ev); benutzt.push(c) }
  }
  if (!events.length) {
    summary.capi_sent = 0
    return
  }

  let empfangen = 0
  const verworfen = new Set<string>()
  for (let i = 0; i < events.length; i += CAPI_MAX_EVENTS_JE_POST) {
    const block = events.slice(i, i + CAPI_MAX_EVENTS_JE_POST)
    const blockKandidaten = benutzt.slice(i, i + CAPI_MAX_EVENTS_JE_POST)
    const protokoll = {
      actor_kind: 'system' as const, fn: FN, mode: 'capi', entity_level: 'pixel', entity_id: pixelId,
      method: 'POST', path: `${pixelId}/events`,
      request: {
        anzahl: block.length,
        event_ids: blockKandidaten.slice(0, 100).map(c => c.event_id),
        namen: [...new Set(blockKandidaten.map(c => c.event_name))],
      },
    }
    try {
      const res = await sendCapiEvents(block, { pixelId })
      for (const id of res.verworfen) verworfen.add(id)
      empfangen += res.events_received
      await logMetaWrite(sb, { ...protokoll, ok: true, after: { events_received: res.events_received, fbtrace_id: res.fbtrace_id }, usage: getLastUsage() })
    } catch (err) {
      const gesperrt = err instanceof MetaApiError && err.userMsg === 'META_WRITES_DISABLED'
      if (!gesperrt) await logMetaWrite(sb, { ...protokoll, ok: false, ...metaErrorLogFelder(err), usage: getLastUsage() })
      throw err
    }
    // capi_log erst NACH erfolgreichem Versand (dann geht nichts verloren)
    const logZeilen = blockKandidaten
      .filter(c => !verworfen.has(c.event_id))
      .map(c => ({ event_id: c.event_id, event_name: c.event_name, lead_id: c.lead_id }))
    if (logZeilen.length) {
      const { error } = await sb.from('capi_log').insert(logZeilen)
      if (error) {
        console.warn(`[${FN}] capi_log schreiben:`, fehlerText(error))
        summary.capi_log_error = fehlerText(error)
      }
    }
  }
  summary.capi_sent = empfangen
  if (verworfen.size) summary.capi_verworfen = verworfen.size
  console.log(`[${FN}] CAPI: ${events.length - verworfen.size} Events gesendet (${[...new Set(benutzt.map(c => c.event_name))].join(', ')}), ${keinMeta} ohne Meta-Herkunft übersprungen`)
}

// ── Ledger ad_autopilot_runs (schritt 'sync') ────────────────────────────────

async function ledgerStart(sb: Sb, datum: string): Promise<boolean> {
  try {
    const { data, error } = await sb.from('ad_autopilot_runs')
      .select('id, status').eq('lauf_datum', datum).eq('schritt', 'sync').maybeSingle()
    if (error) {
      console.warn(`[${FN}] Ledger ad_autopilot_runs nicht lesbar${tabelleFehlt(error) ? ' (Tabelle fehlt)' : ''}:`, fehlerText(error))
      return false
    }
    const jetzt = new Date().toISOString()
    const vorhanden = data as { id: string; status: string } | null
    if (!vorhanden) {
      const { error: insErr } = await sb.from('ad_autopilot_runs')
        .insert({ lauf_datum: datum, schritt: 'sync', status: 'laeuft', started_at: jetzt })
      if (insErr && (insErr as { code?: string }).code !== '23505') {
        console.warn(`[${FN}] Ledger anlegen:`, fehlerText(insErr))
      }
    } else if (vorhanden.status !== 'fertig') {
      // Ein schon fertiger Tages-Sync bleibt fertig (ein zweiter Lauf überschreibt ihn nur bei Erfolg)
      const { error: upErr } = await sb.from('ad_autopilot_runs')
        .update({ status: 'laeuft', started_at: jetzt, finished_at: null, fehler: null }).eq('id', vorhanden.id)
      if (upErr) console.warn(`[${FN}] Ledger starten:`, fehlerText(upErr))
    }
    return true
  } catch (err) {
    console.warn(`[${FN}] Ledger:`, errMsg(err))
    return false
  }
}

async function ledgerEnde(sb: Sb, datum: string, ok: boolean, summary: Summary, fehler?: string): Promise<void> {
  try {
    const jetzt = new Date().toISOString()
    const { error } = ok
      ? await sb.from('ad_autopilot_runs').upsert({
          lauf_datum: datum, schritt: 'sync', status: 'fertig', finished_at: jetzt, summary, fehler: null,
        }, { onConflict: 'lauf_datum,schritt' })
      : await sb.from('ad_autopilot_runs')
          .update({ status: 'fehler', finished_at: jetzt, fehler: String(fehler ?? '').slice(0, 500), summary })
          .eq('lauf_datum', datum).eq('schritt', 'sync').neq('status', 'fertig')
    if (error) console.warn(`[${FN}] Ledger abschließen:`, fehlerText(error))
  } catch (err) {
    console.warn(`[${FN}] Ledger abschließen:`, errMsg(err))
  }
}

// ── Nachtkette: werbe-autopilot {aktion:'nacht'} ─────────────────────────────

async function ketteAnstossen(): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) {
    console.warn(`[${FN}] Kette: SUPABASE_URL oder Service-Key fehlt`)
    return
  }
  const job = (async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 140_000)
    try {
      const res = await fetch(`${url}/functions/v1/werbe-autopilot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ aktion: 'nacht' }),
        signal: ctrl.signal,
      })
      const text = await res.text().catch(() => '')
      if (!res.ok) console.warn(`[${FN}] Kette werbe-autopilot: HTTP ${res.status} ${text.slice(0, 200)}`)
      else console.log(`[${FN}] Kette werbe-autopilot gelaufen (HTTP ${res.status})`)
    } catch (err) {
      console.warn(`[${FN}] Kette werbe-autopilot nicht erreicht (werbe-nachholen holt nach):`, errMsg(err))
    } finally {
      clearTimeout(timer)
    }
  })()
  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
  if (er?.waitUntil) er.waitUntil(job)
  else await job
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  let ledger: { sb: Sb; datum: string } | null = null
  const summary: Summary = {}
  try {
    // Rechte-Guard: läuft mit --no-verify-jwt. pg_cron ruft mit dem
    // Service-Role-Key (gilt als System-Aufruf), Menschen brauchen 'werbung'.
    const caller = await requireAdsAccess(req)

    const { token, account } = metaEnv()
    if (!token) throw new Error('META_ACCESS_TOKEN fehlt (Supabase Secrets)')

    const body = await req.json().catch(() => ({})) as { days?: number; mode?: string; kette?: boolean }
    const days = Math.min(Math.max(Math.trunc(Number(body.days ?? 7)) || 7, 1), 90)
    const actionsOnly = body.mode === 'actions_only'
    // Die Kette stößt den Autopilot mit dem Service-Key an: nur System-Aufrufe dürfen das
    const kette = body.kette === true && caller.system && !actionsOnly
    if (body.kette === true && !kette) console.warn(`[${FN}] kette ignoriert (nur System-Aufruf, nicht mit actions_only)`)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    summary.graph_version = GRAPH_VERSION

    // Ledger nur für den Tages-Sync des Systems (Handläufe aus dem CRM zählen nicht)
    if (!actionsOnly && caller.system) {
      const datum = berlinTag().datum
      if (await ledgerStart(supabase, datum)) ledger = { sb: supabase, datum }
    }

    // ── 1. Insights der letzten N Tage (tagesgenau je Ad) + Katalog ─────────
    if (!actionsOnly) {
      const until = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)   // gestern
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
      const usdPerEur = await usdJeEur()
      const jetzt = new Date().toISOString()

      const ins = await listeMitRueckfall<InsightRow>(`act_${account}/insights`, {
        level: 'ad', time_increment: 1, time_range: { since, until }, limit: 500,
      }, INSIGHT_FELDER, INSIGHT_FELDER_ALT)
      const rows = ins.rows

      // Ad-Stammdaten (Status, Prüfhinweise, Creative fürs Thumbnail): eine Abfrage fürs ganze Konto
      const adsRes = await listeMitRueckfall<Row>(`act_${account}/ads`, { limit: 200 }, AD_FELDER, AD_FELDER_ALT)
      const adMeta = new Map(adsRes.rows.map(a => [String(a.id), a]))

      // Kampagnen/Anzeigengruppen: Namen fürs Katalog-Upsert (auch für Ads ohne Insights)
      // und volle Felder für Spiegel + Tagesstand
      const campRes = await listeMitRueckfall<Row>(`act_${account}/campaigns`, { limit: 100 }, KAMPAGNE_FELDER, KAMPAGNE_FELDER_ALT)
      const adsetRes = await listeMitRueckfall<Row>(`act_${account}/adsets`, { limit: 100 }, ADSET_FELDER, ADSET_FELDER_ALT)
      const campaignNames = new Map(campRes.rows.map(c => [String(c.id), String(c.name ?? '')]))
      const adsetNames = new Map(adsetRes.rows.map(a => [String(a.id), String(a.name ?? '')]))

      // Insights-Upsert
      const insightRows: Row[] = rows
        .filter(r => r.ad_id && r.date_start && (num(r.spend) > 0 || num(r.impressions) > 0))
        .map(r => {
          const spend = num(r.spend)
          return {
            day: r.date_start,
            ad_id: r.ad_id,
            platform: 'meta',
            spend,
            currency: 'USD',
            spend_eur: Math.round((spend / usdPerEur) * 100) / 100,
            impressions: int(r.impressions),
            reach: int(r.reach),
            frequency: num(r.frequency),
            link_clicks: Math.trunc(num(r.inline_link_clicks) || actionValue(r.actions, 'link_click')),
            // Klicks, die zur Zielseite führen sollten, gegen tatsächlich geladene
            // Seiten. Die Differenz sind Leute, die unterwegs abgesprungen sind,
            // meistens wegen zu langer Ladezeit.
            outbound_clicks: Math.trunc(actionValue(r.outbound_clicks, 'outbound_click')),
            landing_page_views: Math.trunc(actionValue(r.actions, 'landing_page_view')),
            platform_leads: Math.trunc(actionValue(r.actions, 'lead')),
            // Bedeutung unverändert (2-Sekunden-Dauerwiedergabe); echte 3-Sek.-Aufrufe in video_3s_true
            video_3s: Math.trunc(num(r.video_continuous_2_sec_watched_actions?.[0]?.value)),
            synced_at: jetzt,
            // ab Migration 20261003100000
            campaign_id: r.campaign_id ?? null,
            adset_id: r.adset_id ?? null,
            video_3s_true: Math.trunc(actionValue(r.actions, 'video_view')),
            thruplays: Math.trunc(aktionOderErste(r.video_thruplay_watched_actions, 'video_view')),
            platform_schedules: Math.trunc(ersteAktion(r.actions, SCHEDULE_TYPEN)),
          }
        })
      const insUp = await upsertMitRueckfall(supabase, 'ad_insights_daily', insightRows, 'day,ad_id',
        ['campaign_id', 'adset_id', 'video_3s_true', 'thruplays', 'platform_schedules'])
      if (insUp.ohneNeue) summary.insights_ohne_neue_spalten = true
      if (!ins.voll) summary.insights_ohne_thruplays = true

      // Katalog-Upsert (Namen aus Insights, Status + Thumbnail aus /ads).
      // Zwei Gruppen mit je einheitlichem Spaltensatz: Ads mit Stammdaten bekommen die
      // neuen Spalten, Ads nur aus den Insights (z. B. archiviert) wie bisher.
      const NEUE_KATALOG_SPALTEN = ['effective_status', 'configured_status', 'issues_info', 'review_feedback', 'url_tags', 'created_time', 'updated_time'] as const
      const neueKatalogFelder = (m: Row): Row => {
        const creative = obj(m.creative)
        return {
          effective_status: str(m.effective_status),
          configured_status: str(m.configured_status),
          issues_info: m.issues_info ?? null,
          review_feedback: m.ad_review_feedback ?? null,
          url_tags: str(creative?.url_tags),
          created_time: isoZeit(m.created_time),
          updated_time: isoZeit(m.updated_time),
        }
      }
      const seen = new Set<string>()
      const mitStamm: Row[] = []
      const ohneStamm: Row[] = []
      for (const r of rows) {
        if (!r.ad_id || seen.has(r.ad_id)) continue
        seen.add(r.ad_id)
        const meta = adMeta.get(r.ad_id)
        const creative = obj(meta?.creative)
        const zeile: Row = {
          ad_id: r.ad_id,
          platform: 'meta',
          account_id: account,
          campaign_id: r.campaign_id ?? '',
          campaign_name: r.campaign_name ?? null,
          adset_id: r.adset_id ?? null,
          adset_name: r.adset_name ?? null,
          ad_name: r.ad_name ?? str(meta?.name),
          status: str(meta?.status),
          creative_id: str(creative?.id),
          thumbnail_url: str(creative?.thumbnail_url),
          updated_at: jetzt,
        }
        if (meta && adsRes.voll) mitStamm.push({ ...zeile, ...neueKatalogFelder(meta) })
        else ohneStamm.push(zeile)
      }
      // Ads OHNE frische Insights (z. B. neu angelegte, pausierte) trotzdem in den
      // Katalog aufnehmen/aktualisieren, sonst fehlen sie im Werbemanager und
      // haben keinen Aktivieren-Button. Thumbnails immer auffrischen (CDN läuft ab).
      for (const [adId, meta] of adMeta) {
        if (seen.has(adId)) continue
        seen.add(adId)
        const creative = obj(meta.creative)
        const zeile: Row = {
          ad_id: adId,
          platform: 'meta',
          account_id: account,
          campaign_id: String(meta.campaign_id ?? ''),
          campaign_name: campaignNames.get(String(meta.campaign_id ?? '')) ?? null,
          adset_id: str(meta.adset_id),
          adset_name: adsetNames.get(String(meta.adset_id ?? '')) ?? null,
          ad_name: str(meta.name),
          status: str(meta.status),
          creative_id: str(creative?.id),
          thumbnail_url: str(creative?.thumbnail_url),
          updated_at: jetzt,
        }
        if (adsRes.voll) mitStamm.push({ ...zeile, ...neueKatalogFelder(meta) })
        else ohneStamm.push(zeile)
      }
      const katUp = await upsertMitRueckfall(supabase, 'ad_catalog', mitStamm, 'ad_id', NEUE_KATALOG_SPALTEN)
      if (katUp.ohneNeue) summary.catalog_ohne_neue_spalten = true
      await upsertMitRueckfall(supabase, 'ad_catalog', ohneStamm, 'ad_id', [])

      summary.insight_rows = insightRows.length
      summary.catalog_rows = mitStamm.length + ohneStamm.length
      summary.since = since
      summary.until = until
      console.log(`[${FN}] ${insightRows.length} Insight-Zeilen (${since} bis ${until}), ${mitStamm.length + ohneStamm.length} Katalog-Zeilen`)

      // ── 1a. Spiegel meta_campaigns / meta_adsets (optional) ───────────────
      if (campRes.voll && campRes.rows.length) {
        const f = await upsertOptional(supabase, 'meta_campaigns', campRes.rows.map(c => kampagnenZeile(c, account, jetzt)), 'campaign_id')
        if (f) summary.mirror_campaigns_error = f
        else summary.mirror_campaigns = campRes.rows.length
      }
      if (adsetRes.voll && adsetRes.rows.length) {
        const f = await upsertOptional(supabase, 'meta_adsets', adsetRes.rows.map(a => adsetZeile(a, account, jetzt)), 'adset_id')
        if (f) summary.mirror_adsets_error = f
        else summary.mirror_adsets = adsetRes.rows.length
      }

      // ── 1c. Tagesstand ad_entity_snapshot (optional, nur lesend bei Meta) ──
      if (campRes.voll && adsetRes.voll && adsRes.voll) {
        try {
          await snapshotSchreiben(supabase, account, {
            kampagnen: campRes.rows, adsets: adsetRes.rows, ads: adsRes.rows,
            usdPerEur, snapDate: berlinTag().datum, jetzt,
          }, summary)
        } catch (err) {
          const msg = errMsg(err).slice(0, 300)
          console.warn(`[${FN}] Tagesstand nicht geschrieben:`, msg)
          summary.snapshot_error = msg
        }
      } else {
        summary.snapshot_error = 'Stammdaten nur mit Rückfall-Feldern gelesen, Tagesstand ausgelassen'
      }
    }

    // ── 1b. Conversions API: CRM-Qualität an Meta zurückspielen ──────────────
    // Meta lernt daraus, WER bucht/erscheint/gut ist, und liefert die Anzeigen an
    // ähnliche Leute aus. Darf den Sync nie scheitern lassen.
    if (!actionsOnly) {
      try {
        await capiRueckspielen(supabase, summary)
      } catch (err) {
        const msg = errMsg(err)
        console.error(`[${FN}] CAPI-Fehler:`, msg)
        summary.capi_error = msg.slice(0, 300)
      }
    }

    // ── 2. Manuell bestätigte Aktionen ausführen (pause/activate, sonst NICHTS) ──
    // Gemeinsamer Ausführer (Claim, Kontoprüfung, Log). Autopilot-Zeilen führt nur
    // werbe-ausfuehren aus; hier werden sie übersprungen.
    try {
      const erg = await ausfuehren(supabase, { modus: 'manuell', fn: FN, akteur: caller.userId })
      summary.actions_executed = erg.ausgefuehrt
      summary.actions_failed = erg.fehlgeschlagen
      const relevant = erg.uebersprungen.filter(u => !u.grund.startsWith('nicht_im_modus_'))
      if (relevant.length) summary.actions_skipped = relevant.slice(0, 20)
      if (erg.abgebrochen) summary.actions_aborted = erg.abgebrochen
    } catch (err) {
      if (actionsOnly) throw err
      const msg = errMsg(err)
      console.error(`[${FN}] Aktionen:`, msg)
      summary.actions_error = msg.slice(0, 300)
    }

    if (ledger) await ledgerEnde(ledger.sb, ledger.datum, true, summary)
    if (kette) {
      summary.kette = 'angestossen'
      await ketteAnstossen()
    }

    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const msg = errMsg(err)
    const status = err instanceof AdsAuthError ? err.status : 500
    console.error(`[${FN}]`, status, msg)
    if (ledger) await ledgerEnde(ledger.sb, ledger.datum, false, summary, msg)
    const out: Record<string, unknown> = { error: msg }
    if (err instanceof MetaApiError) out.meta = err.detail()
    return new Response(JSON.stringify(out), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
