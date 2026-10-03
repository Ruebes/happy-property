// Edge Function: meta-ads-tools
// Werkzeuge für den CRM-Werbemanager (Meta Graph API, Token server-seitig):
//   { mode: 'preview', ad_id }            → FB/IG-Vorschau-iframes + Caption
//   { mode: 'settings', campaign_id }     → ALLE Einstellungen einer Kampagne
//       (Kampagne inkl. Sonderkategorien + Länder, Anzeigengruppen inkl. komplettem
//       Targeting, promoted_object, destination_type, attribution_spec und
//       DSA-Begünstigter/-Zahler, dazu die Anzeigen; Listen mit Paging)
//   { mode: 'update_entity', entity_id, entity_type, patch: {...} }
//       → ändert ALLE bei Meta änderbaren Felder von Kampagne/Adset/Ad.
//       Guard: Entität muss zu unserem Werbekonto gehören; je Ebene gilt eine
//       Feld-Allowlist (siehe EDITABLE_FIELDS unten).
//       Ausgabenlimit (spend_cap): 10.000 bis 10.000.000 Cent; Metas Wert
//       922337203685478 entfernt das Limit. ROAS-Ziel: bid_strategy
//       LOWEST_COST_WITH_MIN_ROAS mit bid_constraints.roas_average_floor (x10000,
//       100 bis 10.000.000) und Performance-Ziel VALUE, ohne bid_amount.
//       Leitplanke: vor status ACTIVE und vor jeder Budget-Erhöhung prüft
//       budgetHeadroom die Summe aktiver Tagesbudgets gegen
//       ad_settings.max_account_daily_budget; darüber Antwort 409
//       { error, code: 'guardrail_exceeded', data }.
//       targeting im patch wird wie bei targeting_apply zusammengeführt.
//   { mode: 'targeting_apply', adset_id, targeting }
//       → schreibt Targeting auf EINE Anzeigengruppe (Guard: unser Konto).
//       ZUSAMMENFÜHREN statt Überschreiben: fehlen im Entwurf Platzierungen,
//       custom_audiences, excluded_custom_audiences, targeting_automation,
//       geo_locations.location_types oder der Radius einer Stadt, bleiben die
//       aktuellen Werte bei Meta stehen. Bewusst entfernen: Feld mit null senden.
//       Kampagne mit Sonderkategorie Wohnen (HOUSING, auch EMPLOYMENT/FINANCIAL):
//       Metas Regeln werden vorher angewendet (applyHousing aus _shared/metaSpec.ts:
//       Alter 18-65+, kein Geschlecht, keine PLZ/Ortsausschlüsse, kein Verhalten/
//       keine Jobtitel/keine Ausschlüsse, Radius >= 15 km, advantage_audience
//       explizit) statt an Meta zu scheitern. Antwort: { success, adset_id, kept, housing }
//   { mode: 'targeting_search', kind, q }
//       → Autocomplete für den Zielgruppen-Editor (Interessen, Jobtitel,
//       Verhalten, Orte) — proxyt Metas /search
//   { mode: 'custom_audiences' } → Custom Audiences unseres Kontos (für Auswahl)
//   { mode: 'audience_suggest', description, feedback?, previous_draft? }
//       → Freitext → Claude (mit GELERNTEN Regeln + Beispielen aus ads_ai_rules/
//       ads_ai_examples) → Graph-Suche löst echte Targeting-IDs auf → Vorschlag.
//       Mit feedback: Korrektur wird als dauerhafte Regel gespeichert (Lernen!)
//   { mode: 'audience_apply', targeting_draft, description? } → wendet Vorschlag
//       auf die Anzeigengruppe der SYSTEM-Kampagne an (Guard!) und speichert
//       Beschreibung→Targeting als Lern-Beispiel. Führt mit dem bestehenden
//       Targeting zusammen (Platzierungen, Custom Audiences, Advantage+ Zielgruppe,
//       Ortstyp bleiben), Interessen und Jobtitel stehen ODER-verknüpft in EINER
//       flexible_spec-Gruppe, Wohnen-Regeln wie bei targeting_apply.
//
// Jeder Schreibzugriff an Meta landet in meta_write_log (logMetaWrite, mit
// Akteur aus requireAdsAccess). Graph-Version, Token, Timeouts und der Not-Aus
// META_WRITES_DISABLED kommen aus _shared/metaGraph.ts.
//
// ── Secrets (Supabase Dashboard → Settings → Edge Functions → Secrets) ──
//   META_ACCESS_TOKEN   = System-User-Token „Analytics Sync"
//   META_AD_ACCOUNT_ID  = 4065490590399677
//   META_GRAPH_VERSION  = optional, Form vNN.0 (Standard v25.0)
//   META_WRITES_DISABLED = optional, '1' sperrt alle Schreibzugriffe an Meta
//   ANTHROPIC_API_KEY   = für die Zielgruppen-Extraktion (bestehendes Secret)
//
// ── Deployment ──
//   supabase functions deploy meta-ads-tools --no-verify-jwt

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { requireAdsAccess, AdsAuthError, type AdsCaller } from '../_shared/adsAuth.ts'
import {
  graphGet, graphAll, graphPost, metaEnv, MetaApiError, logMetaWrite, metaErrorLogFelder,
  getLastUsage, budgetHeadroom, type BudgetHeadroom,
} from '../_shared/metaGraph.ts'
import {
  applyHousing, isHec, LIMITS, META_UNBEGRENZT, SPECIAL_AD_CATEGORIES,
  type DraftSpec, type SpecialCat, type TargetingSpec,
} from '../_shared/metaSpec.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const FN = 'meta-ads-tools'

type Row = Record<string, unknown>

const digits = (v: unknown): string => String(v ?? '').replace(/[^0-9]/g, '')
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

interface AudienceCriteria {
  age_min?: number
  age_max?: number
  genders?: 'alle' | 'maenner' | 'frauen'
  countries?: string[]           // ISO-Codes, z.B. ["DE","AT","CH"]
  interest_keywords?: string[]   // Suchbegriffe für Meta-Interessen
  job_keywords?: string[]        // Suchbegriffe für Jobtitel
  summary?: string
}

// ── Welche Felder dürfen auf welcher Ebene geschrieben werden ────────────────
// Bewusst als Allowlist: alles, was Meta zwar zurückliefert, aber nach dem
// Anlegen NICHT mehr ändert (objective, buying_type, billing_event,
// special_ad_categories), bleibt draußen — sonst quittiert Meta die Änderung
// scheinbar erfolgreich und das Feld bleibt trotzdem stehen.
const EDITABLE_FIELDS: Record<string, string[]> = {
  campaign: ['name', 'status', 'daily_budget', 'lifetime_budget', 'spend_cap', 'bid_strategy', 'start_time', 'stop_time'],
  adset:    ['name', 'status', 'daily_budget', 'lifetime_budget', 'bid_amount', 'bid_strategy', 'bid_constraints', 'optimization_goal', 'start_time', 'end_time', 'targeting'],
  ad:       ['name', 'status'],
}

// Vorher-Zustand je Ebene: Konto-Guard, Leitplanke (Budgets, Laufzeit) und das
// Protokoll (before) aus EINEM Aufruf.
const ENTITY_FIELDS: Record<string, string> = {
  campaign: 'account_id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,spend_cap,bid_strategy,start_time,stop_time,special_ad_categories',
  adset: 'account_id,campaign_id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,bid_amount,bid_strategy,bid_constraints,optimization_goal,start_time,end_time,targeting,campaign{special_ad_categories}',
  ad: 'account_id,campaign_id,adset_id,name,status,effective_status',
}
const TARGETING_FIELDS = 'account_id,campaign_id,name,targeting,campaign{special_ad_categories}'

const BID_STRATEGIES = new Set(['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS'])
const OPTIMIZATION_GOALS = new Set([
  'OFFSITE_CONVERSIONS', 'LINK_CLICKS', 'LEAD_GENERATION', 'REACH', 'IMPRESSIONS',
  'LANDING_PAGE_VIEWS', 'THRUPLAY', 'QUALITY_LEAD', 'QUALITY_CALL', 'VALUE', 'APP_INSTALLS',
])
// Geldbeträge kommen in Cent der Konto-Währung (USD). 1 $ … 5.000 $ ist der
// plausible Rahmen für dieses Konto — schützt vor Tippfehlern wie 5000 statt 50.
const MONEY_MIN = 100
const MONEY_MAX = 500_000

function money(value: unknown, label: string): number {
  const cents = Math.round(Number(value))
  if (!Number.isFinite(cents) || cents < MONEY_MIN || cents > MONEY_MAX) {
    throw new Error(`${label} unplausibel (Cent, ${MONEY_MIN}-${MONEY_MAX})`)
  }
  return cents
}

/**
 * Kampagnen-Ausgabenlimit: Meta verlangt mindestens ca. 100 USD; bis 100.000 USD
 * (10.000.000 Cent) plausibel. 922337203685478 (Metas „unbegrenzt“) entfernt das Limit.
 */
function spendCap(value: unknown): number {
  const cents = Math.round(Number(value))
  if (cents === META_UNBEGRENZT) return META_UNBEGRENZT
  if (!Number.isFinite(cents) || cents < LIMITS.spendCapMinCents || cents > LIMITS.spendCapMaxCents) {
    throw new Error(`Ausgabenlimit unplausibel (Cent, ${LIMITS.spendCapMinCents}-${LIMITS.spendCapMaxCents}; Limit entfernen mit ${META_UNBEGRENZT})`)
  }
  return cents
}

/** ROAS-Ziel: bid_constraints.roas_average_floor (x10000, z. B. 15000 = ROAS 1,5). */
function bidConstraints(value: unknown): Record<string, unknown> {
  if (!isObj(value)) throw new Error('bid_constraints muss ein Objekt sein')
  const floor = Math.round(Number(value.roas_average_floor))
  if (!Number.isFinite(floor) || floor < LIMITS.roasFloorMin || floor > LIMITS.roasFloorMax) {
    throw new Error(`ROAS-Ziel unplausibel (roas_average_floor x10000, ${LIMITS.roasFloorMin}-${LIMITS.roasFloorMax}, z. B. 15000 = 1,5)`)
  }
  return { roas_average_floor: floor }
}

/** Ungültige Eingabe: Antwort 400 statt 500. */
class EingabeFehler extends Error {}

/**
 * ROAS-Ziel nur mit Performance-Ziel VALUE, mit Mindest-ROAS und ohne Gebot (Meta-Regel).
 * Nur bei Gebots-Änderungen (Pausieren, Umbenennen, Budget bleiben ungeprüft). Ein bestehendes
 * ROAS-Ziel lässt sich nach dem Anlegen nicht wechseln (wie editDiff in metaSpec).
 */
function roasPruefen(before: Row, patch: Row): void {
  if (['bid_strategy', 'bid_constraints', 'bid_amount', 'optimization_goal'].every(k => patch[k] === undefined)) return
  const vorher = String(before.bid_strategy ?? '')
  if (vorher === 'LOWEST_COST_WITH_MIN_ROAS' && patch.bid_strategy !== undefined && patch.bid_strategy !== vorher) {
    throw new EingabeFehler('Die Gebotsstrategie ROAS-Ziel lässt sich nach dem Anlegen nicht wechseln (Meta-Regel)')
  }
  const strat = String(patch.bid_strategy ?? before.bid_strategy ?? '')
  if (strat !== 'LOWEST_COST_WITH_MIN_ROAS') {
    if (patch.bid_constraints !== undefined) throw new EingabeFehler('bid_constraints nur mit Gebotsstrategie ROAS-Ziel (LOWEST_COST_WITH_MIN_ROAS)')
    return
  }
  const goal = String(patch.optimization_goal ?? before.optimization_goal ?? '')
  if (goal !== 'VALUE') throw new EingabeFehler('Gebotsstrategie ROAS-Ziel geht nur mit dem Performance-Ziel Wert (VALUE)')
  const floor = isObj(patch.bid_constraints) ? patch.bid_constraints.roas_average_floor
    : isObj(before.bid_constraints) ? before.bid_constraints.roas_average_floor : undefined
  if (!floor) throw new EingabeFehler('ROAS-Ziel fehlt (bid_constraints.roas_average_floor)')
  if (patch.bid_amount !== undefined) throw new EingabeFehler('Mit ROAS-Ziel gibt es kein Gebot (bid_amount)')
}

function isoTime(value: unknown, label: string): string {
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) throw new Error(`${label} ist kein gültiges Datum`)
  return d.toISOString()
}

/** Baut aus dem Roh-Patch das validierte Graph-Patch für die jeweilige Ebene. */
function buildPatch(entityType: string, raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = EDITABLE_FIELDS[entityType]
  if (!allowed) throw new Error(`Unbekannter entity_type "${entityType}"`)

  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value == null || value === '') continue
    if (!allowed.includes(key)) {
      throw new Error(`Feld "${key}" ist auf Ebene "${entityType}" nicht änderbar`)
    }
    switch (key) {
      case 'name': {
        const n = String(value).trim()
        if (!n) throw new Error('Name darf nicht leer sein')
        patch.name = n.slice(0, 400)
        break
      }
      case 'status': {
        const s = String(value)
        if (s !== 'ACTIVE' && s !== 'PAUSED') throw new Error('status muss ACTIVE oder PAUSED sein')
        patch.status = s
        break
      }
      case 'daily_budget':    patch.daily_budget    = money(value, 'Tagesbudget');    break
      case 'lifetime_budget': patch.lifetime_budget = money(value, 'Laufzeitbudget'); break
      case 'spend_cap':       patch.spend_cap       = spendCap(value);                break
      case 'bid_constraints': patch.bid_constraints = bidConstraints(value);          break
      case 'bid_amount':      patch.bid_amount      = money(value, 'Gebot');          break
      case 'bid_strategy': {
        const s = String(value)
        if (!BID_STRATEGIES.has(s)) throw new Error(`Unbekannte Gebotsstrategie "${s}"`)
        patch.bid_strategy = s
        break
      }
      case 'optimization_goal': {
        const s = String(value)
        if (!OPTIMIZATION_GOALS.has(s)) throw new Error(`Unbekanntes Optimierungsziel "${s}"`)
        patch.optimization_goal = s
        break
      }
      case 'start_time': patch.start_time = isoTime(value, 'Startzeit'); break
      case 'stop_time':  patch.stop_time  = isoTime(value, 'Endzeit');   break
      case 'end_time':   patch.end_time   = isoTime(value, 'Endzeit');   break
      case 'targeting': {
        if (typeof value !== 'object' || Array.isArray(value)) throw new Error('targeting muss ein Objekt sein')
        const tg = value as Record<string, unknown>
        const geo = tg.geo_locations as Record<string, unknown> | undefined
        const hasGeo = geo && Object.values(geo).some(v => Array.isArray(v) && v.length)
        // Ohne Ort liefert Meta einen unverständlichen Fehler — hier klar abfangen.
        if (!hasGeo) throw new Error('Zielgruppe braucht mindestens ein Land, eine Region oder eine Stadt')
        patch.targeting = tg
        break
      }
    }
  }
  if (!Object.keys(patch).length) throw new Error('Nichts zu ändern übergeben')
  // daily_budget und lifetime_budget schließen sich bei Meta gegenseitig aus.
  if (patch.daily_budget && patch.lifetime_budget) {
    throw new Error('Tagesbudget und Laufzeitbudget können nicht gleichzeitig gesetzt werden')
  }
  return patch
}

// ── Kontext je Aufruf (für Protokoll + Leitplanke) ───────────────────────────
interface Ctx { sb: SupabaseClient; caller: AdsCaller; account: string; mode: string }

/** Liest eine Entität und prüft, dass sie zu unserem Werbekonto gehört. */
async function ownEntity(ctx: Ctx, id: string, fields: string, fehlertext: string): Promise<Row> {
  const row = await graphGet<Row>(id, { fields })
  if (digits(row?.account_id) !== ctx.account) throw new Error(fehlertext)
  return row
}

/**
 * POST an Meta + Zeile in meta_write_log (Erfolg UND Fehler). Status, Budget und
 * Targeting setzen ist wiederholbar, deshalb idempotent (eine Wiederholung bei
 * transientem Fehler).
 */
async function schreiben(ctx: Ctx, w: { level: string; id: string; body: Row; before?: unknown }): Promise<void> {
  const base = {
    actor: ctx.caller.userId,
    actor_kind: ctx.caller.system ? 'system' as const : 'user' as const,
    fn: FN, mode: ctx.mode, entity_level: w.level, entity_id: w.id,
    method: 'POST', path: w.id, request: w.body, before: w.before ?? null,
  }
  try {
    await graphPost(w.id, w.body, { idempotent: true })
  } catch (err) {
    await logMetaWrite(ctx.sb, { ...base, ok: false, ...metaErrorLogFelder(err), usage: getLastUsage() })
    throw err
  }
  await logMetaWrite(ctx.sb, { ...base, after: w.body, ok: true, http_status: 200, usage: getLastUsage() })
}

// ── Targeting zusammenführen + Wohnen-Regeln ─────────────────────────────────
const PLACEMENT_KEYS = [
  'publisher_platforms', 'facebook_positions', 'instagram_positions', 'threads_positions',
  'messenger_positions', 'audience_network_positions', 'whatsapp_positions', 'device_platforms',
]
const KEEP_KEYS = ['custom_audiences', 'excluded_custom_audiences']

/**
 * Entwurf gewinnt; was im Entwurf FEHLT, bleibt wie aktuell bei Meta:
 * Platzierungen (als Gruppe: sobald der Entwurf irgendein Platzierungsfeld setzt,
 * gilt nur seine Platzierung), custom/excluded_custom_audiences,
 * targeting_automation (je Unterfeld), geo_locations.location_types und der
 * Radius gleicher Städte. Ein Feld mit null wird bewusst entfernt.
 */
function mergeTargeting(current: Row, incoming: Row): { targeting: Row; kept: string[] } {
  const out = clone(incoming)
  const kept: string[] = []
  const removed = new Set(Object.keys(incoming).filter(k => incoming[k] === null))
  for (const k of removed) delete out[k]
  const has = (k: string) => Object.prototype.hasOwnProperty.call(incoming, k)

  if (!PLACEMENT_KEYS.some(has)) {
    for (const k of PLACEMENT_KEYS) {
      if (current[k] !== undefined && current[k] !== null) { out[k] = clone(current[k]); kept.push(k) }
    }
  }
  for (const k of KEEP_KEYS) {
    if (!has(k) && current[k] !== undefined && current[k] !== null) { out[k] = clone(current[k]); kept.push(k) }
  }
  if (!removed.has('targeting_automation')) {
    const curTa = isObj(current.targeting_automation) ? current.targeting_automation : null
    const inTa = isObj(incoming.targeting_automation) ? incoming.targeting_automation : null
    if (curTa || inTa) {
      out.targeting_automation = { ...clone(curTa ?? {}), ...clone(inTa ?? {}) }
      if (curTa && !inTa) kept.push('targeting_automation')
    }
  }
  const curGeo = isObj(current.geo_locations) ? current.geo_locations : null
  const outGeo = isObj(out.geo_locations) ? out.geo_locations : null
  if (curGeo && outGeo) {
    const lt = curGeo.location_types
    if (!Object.prototype.hasOwnProperty.call(outGeo, 'location_types') && Array.isArray(lt) && lt.length) {
      outGeo.location_types = clone(lt)
      kept.push('geo_locations.location_types')
    }
    if (Array.isArray(outGeo.cities) && Array.isArray(curGeo.cities)) {
      const alt = new Map<string, Row>()
      for (const c of curGeo.cities) if (isObj(c) && c.key !== undefined) alt.set(String(c.key), c)
      for (const c of outGeo.cities) {
        if (!isObj(c) || c.radius !== undefined) continue
        const old = alt.get(String(c.key))
        if (old && old.radius !== undefined) {
          c.radius = old.radius
          if (old.distance_unit !== undefined) c.distance_unit = old.distance_unit
          kept.push('geo_locations.cities.radius')
        }
      }
    }
  }
  return { targeting: out, kept: [...new Set(kept)] }
}

interface HousingInfo { aktiv: boolean; changes: string[] }

/**
 * Metas Wohnen-/Beschäftigung-/Finanz-Regeln auf ein BESTEHENDES Targeting
 * anwenden. Einzige Wahrheit ist applyHousing aus _shared/metaSpec.ts; dafür
 * wird das Targeting in einen Mini-Entwurf (eine Anzeigengruppe) gesteckt.
 * Fehlt advantage_audience, wird 0 gesetzt (bestehende Gruppe: Verhalten wie
 * bisher), nicht der Builder-Standard 1.
 */
function housingAnwenden(t: Row, cats: string[], countries: string[]): { targeting: Row; info: HousingInfo } {
  const sac: SpecialCat[] = SPECIAL_AD_CATEGORIES.filter(c => cats.indexOf(c) >= 0)
  if (!isHec(sac)) return { targeting: t, info: { aktiv: false, changes: [] } }
  const vorher = clone(t)
  const ta: Row = isObj(vorher.targeting_automation) ? vorher.targeting_automation : {}
  if (ta.advantage_audience !== 0 && ta.advantage_audience !== 1) {
    ta.advantage_audience = ta.advantage_audience === true || ta.advantage_audience === '1' ? 1 : 0
  }
  vorher.targeting_automation = ta
  const draft: DraftSpec = {
    v: 1,
    campaign: {
      existing_id: 'bestand', name: 'bestand', objective: 'OUTCOME_LEADS', buying_type: 'AUCTION',
      special_ad_categories: sac, special_ad_category_country: countries, budget_level: 'adset',
    },
    adsets: [{
      key: 'gruppe', name: 'gruppe', destination: 'WEBSITE', optimization_goal: 'OFFSITE_CONVERSIONS',
      billing_event: 'IMPRESSIONS', promoted_object: {}, attribution: 'click_7d_view_1d',
      targeting: vorher as TargetingSpec, placements: { mode: 'advantage' }, dsa_beneficiary: '', dsa_payor: '',
    }],
    ads: [],
  }
  const res = applyHousing(draft, { forceCategory: false })
  const after: Row = res.spec.adsets[0]?.targeting ?? vorher
  // nur Änderungen am Targeting melden (Kampagnen-Hinweise betreffen den Hilfsentwurf)
  const changes = res.changes.filter(c => c.node !== 'campaign').map(c => c.code)
  return { targeting: after, info: { aktiv: true, changes: [...new Set(changes)] } }
}

/** Zusammenführen + Wohnen-Regeln für eine Anzeigengruppe (before = GET mit TARGETING_FIELDS/ENTITY_FIELDS.adset). */
function prepareTargeting(before: Row, incoming: Row): { targeting: Row; kept: string[]; housing: HousingInfo } {
  const current = isObj(before.targeting) ? before.targeting : {}
  const merged = mergeTargeting(current, incoming)
  const camp = isObj(before.campaign) ? before.campaign : {}
  const h = housingAnwenden(merged.targeting, strList(camp.special_ad_categories), strList(camp.special_ad_category_country))
  return { targeting: h.targeting, kept: merged.kept, housing: h.info }
}

// ── Budget-Leitplanke ────────────────────────────────────────────────────────
class GuardrailError extends Error {
  data: BudgetHeadroom
  constructor(message: string, data: BudgetHeadroom) {
    super(message)
    this.name = 'GuardrailError'
    this.data = data
  }
}

const cents = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}
const eur = (n: number): string => n.toFixed(2).replace('.', ',')

/** USD-Cent je Tag aus eigenem Budget (Laufzeitbudget: Rest / Resttage), optional nach dem Patch. */
function centsJeTag(o: Row, endKey: 'stop_time' | 'end_time', patch: Row = {}): number {
  const hasDaily = patch.daily_budget !== undefined
  const hasLifetime = patch.lifetime_budget !== undefined
  const daily = hasDaily ? cents(patch.daily_budget) : hasLifetime ? 0 : cents(o.daily_budget)
  if (daily) return daily
  const lifetimeAlt = cents(o.lifetime_budget)
  const lifetime = hasLifetime ? cents(patch.lifetime_budget) : lifetimeAlt
  if (!lifetime) return 0
  const ausgegeben = lifetimeAlt ? Math.max(0, lifetimeAlt - cents(o.budget_remaining)) : 0
  const rest = Math.max(0, lifetime - ausgegeben)
  const ende = patch[endKey] !== undefined ? patch[endKey] : o[endKey]
  const endMs = typeof ende === 'string' ? Date.parse(ende) : NaN
  const tage = Number.isFinite(endMs) ? Math.max(1, Math.ceil((endMs - Date.now()) / 86_400_000)) : 1
  return Math.round(rest / tage)
}

/**
 * Prüft vor status ACTIVE und vor jeder Budget-Erhöhung (Tages-/Laufzeitbudget,
 * kürzere Laufzeit) die Summe aktiver Tagesbudgets. null = keine Prüfung nötig.
 * Kampagne ohne eigenes Budget: zählt die eingeschalteten Anzeigengruppen.
 * Ist das Objekt weder aktiv noch wird es eingeschaltet, ändert die Erhöhung
 * die aktive Summe nicht (Prüfung läuft trotzdem, Ergebnis = heutiger Stand).
 * Wirft, wenn Meta nicht vollständig lesbar ist (lieber nichts tun als falsch rechnen).
 */
async function leitplanke(sb: SupabaseClient, level: string, id: string, before: Row, patch: Row): Promise<BudgetHeadroom | null> {
  // Pausieren senkt die aktive Summe immer, auch wenn im selben Patch ein Budget steigt
  if (patch.status === 'PAUSED') return null
  const aktivieren = patch.status === 'ACTIVE'
  const budgetFeld = ['daily_budget', 'lifetime_budget', 'stop_time', 'end_time'].some(k => patch[k] !== undefined)
  if (!aktivieren && !budgetFeld) return null
  const endKey = level === 'campaign' ? 'stop_time' : 'end_time'
  let alt = level === 'ad' ? 0 : centsJeTag(before, endKey)
  let neu = level === 'ad' ? 0 : centsJeTag(before, endKey, patch)
  const ersetzt = [id]
  if (level === 'campaign' && !alt && !neu) {
    const gruppen = await graphAll<Row>(`${id}/adsets`, {
      fields: 'id,status,daily_budget,lifetime_budget,budget_remaining,end_time', limit: 100,
    }, { strict: true })
    for (const g of gruppen) {
      if (String(g.status ?? '') !== 'ACTIVE') continue
      const c = centsJeTag(g, 'end_time')
      if (c > 0) { alt += c; neu += c; ersetzt.push(digits(g.id)) }
    }
  }
  if (!aktivieren && neu <= alt) return null
  const h = await budgetHeadroom(sb, { addDailyUsdCents: neu, replaceEntityIds: ersetzt })
  const gezaehlt = h.eintraege.some(e => ersetzt.indexOf(e.id) >= 0)
  if (aktivieren || gezaehlt) return h
  return { ...h, afterEur: h.activeEur, deltaEur: 0, ok: h.activeEur <= h.limitEur + 0.005 }
}

function leitplankenText(h: BudgetHeadroom): string {
  return `Budget-Leitplanke: Nach dieser Änderung wären ${eur(h.afterEur)} € Tagesbudget aktiv, erlaubt sind ${eur(h.limitEur)} € (heute aktiv: ${eur(h.activeEur)} €). Bitte erst andere Budgets senken oder das Tageslimit in den Einstellungen anpassen.`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    // Rechte-Guard: die Function läuft mit --no-verify-jwt, deshalb hier prüfen.
    const caller = await requireAdsAccess(req)

    const { account } = metaEnv()
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const mode = String(body.mode ?? '')
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const ctx: Ctx = { sb: supabase, caller, account, mode }

    // ── Vorschau: FB Feed / IG Feed / IG Story + Caption ─────────────────────
    if (mode === 'preview') {
      const adId = digits(body.ad_id)
      if (!adId) throw new Error('ad_id fehlt')
      const formats: Record<string, string> = {
        facebook: 'MOBILE_FEED_STANDARD',
        instagram: 'INSTAGRAM_STANDARD',
        story: 'INSTAGRAM_STORY',
      }
      const previews: Record<string, string> = {}
      for (const [key, fmt] of Object.entries(formats)) {
        try {
          const j = await graphGet<{ data?: Array<{ body?: string }> }>(`${adId}/previews`, { ad_format: fmt })
          previews[key] = j?.data?.[0]?.body ?? ''
        } catch (err) {
          console.warn(`[meta-ads-tools] Vorschau ${fmt}:`, err instanceof Error ? err.message : err)
          previews[key] = ''
        }
      }
      const ad = await graphGet<Row>(adId, { fields: 'name,status,creative{body,title,thumbnail_url,object_story_spec}' })
      const creative = (ad.creative ?? {}) as { body?: string; title?: string; object_story_spec?: { link_data?: { message?: string; name?: string } } }
      const caption = {
        message: creative.object_story_spec?.link_data?.message ?? creative.body ?? '',
        headline: creative.object_story_spec?.link_data?.name ?? creative.title ?? '',
      }
      return json({ success: true, previews, caption, ad_name: ad.name, status: ad.status })
    }

    // ── Voll-Einstellungen einer Kampagne (lesen) ────────────────────────────
    if (mode === 'settings') {
      const campaignId = digits(body.campaign_id)
      if (!campaignId) throw new Error('campaign_id fehlt')
      const campaign = await graphGet<Row>(campaignId, {
        fields: 'name,objective,status,effective_status,special_ad_categories,special_ad_category_country,bid_strategy,daily_budget,lifetime_budget,spend_cap,start_time,stop_time,created_time,buying_type,account_id',
      })
      if (digits(campaign.account_id) !== account) throw new Error('Kampagne gehört nicht zu unserem Werbekonto')
      const adsets = await graphAll<Row>(`${campaignId}/adsets`, {
        fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount,optimization_goal,billing_event,promoted_object,destination_type,attribution_spec,dsa_beneficiary,dsa_payor,start_time,end_time,targeting',
        limit: 50,
      }, { maxPages: 4 })
      const ads = await graphAll<Row>(`${campaignId}/ads`, {
        fields: 'id,name,status,effective_status,adset_id,creative{id,url_tags,object_story_spec{link_data{link,name,call_to_action},page_id}}',
        limit: 50,
      }, { maxPages: 10 })
      return json({ success: true, campaign, adsets, ads })
    }

    // ── Einstellungen ändern (Kampagne, Adset oder Ad) ──────────────────────
    if (mode === 'update_entity') {
      const entityId = digits(body.entity_id)
      if (!entityId) throw new Error('entity_id fehlt')
      const entityType = String(body.entity_type ?? '')
      const raw = (body.patch ?? {}) as Record<string, unknown>
      // Ebene + Felder prüfen, bevor irgendetwas bei Meta gelesen wird
      const patch = buildPatch(entityType, raw)
      // Guard: Entität muss zu unserem Konto gehören (liest gleich den Vorher-Zustand)
      const before = await ownEntity(ctx, entityId, ENTITY_FIELDS[entityType], 'Entität gehört nicht zu unserem Werbekonto')
      if (entityType === 'adset') roasPruefen(before, patch)

      let targetingInfo: { kept: string[]; housing: HousingInfo } | null = null
      if (entityType === 'adset' && isObj(patch.targeting)) {
        const prep = prepareTargeting(before, patch.targeting)
        patch.targeting = buildPatch('adset', { targeting: prep.targeting }).targeting
        targetingInfo = { kept: prep.kept, housing: prep.housing }
      }

      const guard = await leitplanke(supabase, entityType, entityId, before, patch)
      if (guard && !guard.ok) throw new GuardrailError(leitplankenText(guard), guard)

      await schreiben(ctx, { level: entityType, id: entityId, body: patch, before })
      console.log(`[meta-ads-tools] update_entity ${entityType} ${entityId}:`, Object.keys(patch).join(','))

      // Spiegel mitziehen: sonst zeigt die Tabelle bis zum nächsten Sync den
      // alten Status/Namen, obwohl bei Meta längst geändert wurde.
      if (entityType === 'ad' && (patch.status || patch.name)) {
        const mirror: Record<string, unknown> = { updated_at: new Date().toISOString() }
        if (patch.status) mirror.status = patch.status
        if (patch.name)   mirror.ad_name = patch.name
        const { error } = await supabase.from('ad_catalog').update(mirror).eq('ad_id', entityId)
        if (error) console.warn('[meta-ads-tools] ad_catalog-Spiegel:', error.message)
      }
      return json({
        success: true, entity_id: entityId, applied: patch,
        ...(guard ? { guardrail: guard } : {}),
        ...(targetingInfo ? targetingInfo : {}),
      })
    }

    // ── Targeting auf EINE Anzeigengruppe schreiben (zusammengeführt) ───────
    // Anders als audience_apply (nur System-Kampagne, KI-Entwurf) schreibt das
    // hier den handgebauten Entwurf aus dem Zielgruppen-Editor auf ein
    // beliebiges Adset unseres Kontos.
    if (mode === 'targeting_apply') {
      const adsetId = digits(body.adset_id)
      if (!adsetId) throw new Error('adset_id fehlt')
      // Eingabe prüfen (Objekt + mindestens ein Ort), bevor Meta gelesen wird
      buildPatch('adset', { targeting: body.targeting })
      const before = await ownEntity(ctx, adsetId, TARGETING_FIELDS, 'Anzeigengruppe gehört nicht zu unserem Werbekonto')

      const prep = prepareTargeting(before, body.targeting as Row)
      const patch = buildPatch('adset', { targeting: prep.targeting })
      await schreiben(ctx, { level: 'adset', id: adsetId, body: patch, before: { targeting: before.targeting ?? null } })
      console.log(`[meta-ads-tools] targeting_apply ${adsetId}`)
      return json({ success: true, adset_id: adsetId, kept: prep.kept, housing: prep.housing })
    }

    // ── Autocomplete für den Zielgruppen-Editor ─────────────────────────────
    if (mode === 'targeting_search') {
      const kind = String(body.kind ?? '')
      const q = String(body.q ?? '').trim().slice(0, 100)
      // Verhalten ist bei Meta KEINE Freitextsuche, sondern eine feste Kategorie-
      // Liste (type=adTargetingCategory&class=behaviors). Wir holen die ganze
      // Liste und filtern serverseitig nach dem Suchbegriff.
      let params: Record<string, string | number>
      if (kind === 'behavior') {
        params = { type: 'adTargetingCategory', class: 'behaviors', limit: 400 }
      } else {
        const kinds: Record<string, string> = {
          interest: 'adinterest',
          job:      'adworkposition',
          employer: 'adworkemployer',
          geo:      'adgeolocation',
        }
        const type = kinds[kind]
        if (!type) throw new Error(`Unbekannte Suchart "${kind}"`)
        if (!q) throw new Error('Suchbegriff fehlt')
        params = { type, q, limit: 25 }
      }
      const res = await graphGet<{ data?: Array<Record<string, unknown>> }>('search', params)
      let rows = res?.data ?? []
      // Verhalten kommt als Gesamtliste — hier nach dem Suchbegriff filtern
      if (kind === 'behavior' && q) {
        const needle = q.toLowerCase()
        rows = rows.filter(r => String(r.name ?? '').toLowerCase().includes(needle)).slice(0, 25)
      }
      const results = rows.map(r => ({
        id: String(r.id ?? r.key ?? ''),
        name: String(r.name ?? ''),
        // Ortssuche liefert Typ (country/region/city) + Land zur Unterscheidung
        type: r.type ? String(r.type) : undefined,
        country_code: r.country_code ? String(r.country_code) : undefined,
        region: r.region ? String(r.region) : undefined,
        path: Array.isArray(r.path) ? (r.path as string[]).join(' › ') : undefined,
        audience: typeof r.audience_size_upper_bound === 'number' ? r.audience_size_upper_bound : undefined,
      })).filter(r => r.id && r.name)
      return json({ success: true, results })
    }

    // ── Custom Audiences unseres Kontos (Auswahlliste im Editor) ────────────
    if (mode === 'custom_audiences') {
      const res = await graphGet<{ data?: Array<Record<string, unknown>> }>(`act_${account}/customaudiences`, {
        fields: 'id,name,approximate_count_lower_bound,subtype', limit: 200,
      })
      const rows = res?.data ?? []
      return json({
        success: true,
        audiences: rows.map(r => ({
          id: String(r.id), name: String(r.name ?? ''),
          size: typeof r.approximate_count_lower_bound === 'number' ? r.approximate_count_lower_bound : undefined,
          subtype: r.subtype ? String(r.subtype) : undefined,
        })),
      })
    }

    // ── Zielgruppen-Vorschlag aus Freitext ───────────────────────────────────
    if (mode === 'audience_suggest') {
      const description = String(body.description ?? '').trim().slice(0, 2000)
      if (!description) throw new Error('description fehlt')
      const feedback = String(body.feedback ?? '').trim().slice(0, 500)

      // Lernen Teil 1: Feedback wird dauerhafte Regel für ALLE künftigen Vorschläge
      if (feedback) {
        const { error } = await supabase.from('ads_ai_rules').insert({ kind: 'audience', rule: feedback })
        if (error) console.warn('[meta-ads-tools] Regel speichern:', error.message)
        else console.log('[meta-ads-tools] Neue Regel gelernt:', feedback)
      }

      // Lernen Teil 2: gespeicherte Regeln + die letzten bestätigten Beispiele in den Prompt
      const { data: ruleRows } = await supabase.from('ads_ai_rules')
        .select('rule').eq('kind', 'audience').eq('active', true)
        .order('created_at', { ascending: false }).limit(20)
      const rules = ((ruleRows ?? []) as { rule: string }[]).map(r => `- ${r.rule}`).join('\n')
      const { data: exampleRows } = await supabase.from('ads_ai_examples')
        .select('description, applied_draft')
        .order('created_at', { ascending: false }).limit(5)
      const examples = ((exampleRows ?? []) as { description: string; applied_draft: unknown }[])
        .map(e => `Beschreibung: "${e.description}"\nÜbernommenes Targeting: ${JSON.stringify(e.applied_draft)}`)
        .join('\n\n')

      // 1) Claude: Freitext → strukturierte Kriterien (mit Gelerntem)
      const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 700,
          messages: [{
            role: 'user',
            content: `Du übersetzt eine Zielgruppen-Beschreibung in Meta-Ads-Targeting-Kriterien für einen deutschen Immobilien-Investment-Anbieter (Neubau Zypern, Kunden = deutschsprachige Kapitalanleger).
${rules ? `\nVom Werbetreibenden GELERNTE REGELN (immer beachten, überstimmen Defaults):\n${rules}\n` : ''}${examples ? `\nFrühere BESTÄTIGTE Beispiele (so versteht der Werbetreibende seine Beschreibungen):\n${examples}\n` : ''}${body.previous_draft ? `\nVorheriger Vorschlag (der Werbetreibende will ihn korrigiert haben):\n${JSON.stringify(body.previous_draft)}\n` : ''}${feedback ? `\nAKTUELLE KORREKTUR des Werbetreibenden (unbedingt umsetzen):\n"${feedback}"\n` : ''}
Beschreibung des Werbetreibenden:
"""${description}"""

Antworte NUR mit einem JSON-Objekt (kein Markdown, keine Erklärung):
{
  "age_min": Zahl (18-65, Default 25),
  "age_max": Zahl (18-65, Default 65),
  "genders": "alle" | "maenner" | "frauen",
  "countries": ["DE", ...] (ISO-Codes; Default ["DE"]; DACH = DE,AT,CH),
  "interest_keywords": [3-8 deutsche Suchbegriffe für Meta-Interessen, konkret und einzeln, z.B. "Immobilienanlagen", "Vermögensverwaltung", "Auswandern"],
  "job_keywords": [0-5 englische Jobtitel-Suchbegriffe falls die Beschreibung Berufe/Positionen nennt, z.B. "CEO", "Business Owner"],
  "summary": "1 Satz auf Deutsch, wen das Targeting erreicht"
}`,
          }],
        }),
      })
      const aiJson = await aiRes.json()
      if (!aiRes.ok) throw new Error(`Claude ${aiRes.status}: ${JSON.stringify(aiJson).slice(0, 200)}`)
      const text = (aiJson.content?.[0]?.text ?? '{}') as string
      const criteria = JSON.parse(text.replace(/^```json?\s*|```\s*$/g, '')) as AudienceCriteria

      // 2) Graph-Suche: Begriffe → echte IDs (Top-Treffer je Begriff)
      const interests: Array<{ id: string; name: string; audience?: number }> = []
      for (const kw of (criteria.interest_keywords ?? []).slice(0, 8)) {
        try {
          const j = await graphGet<{ data?: Array<{ id: string; name: string; audience_size_upper_bound?: number }> }>('search', { type: 'adinterest', q: kw, limit: 2 })
          for (const hit of (j?.data ?? []).slice(0, 1)) {
            if (!interests.some(x => x.id === hit.id)) interests.push({ id: hit.id, name: hit.name, audience: hit.audience_size_upper_bound })
          }
        } catch { /* einzelner Begriff darf scheitern */ }
      }
      const jobs: Array<{ id: string; name: string }> = []
      for (const kw of (criteria.job_keywords ?? []).slice(0, 5)) {
        try {
          const j = await graphGet<{ data?: Array<{ id: string; name: string }> }>('search', { type: 'adworkposition', q: kw, limit: 2 })
          for (const hit of (j?.data ?? []).slice(0, 1)) {
            if (!jobs.some(x => x.id === hit.id)) jobs.push({ id: hit.id, name: hit.name })
          }
        } catch { /* einzelner Begriff darf scheitern */ }
      }

      return json({
        success: true,
        draft: {
          age_min: Math.min(Math.max(criteria.age_min ?? 25, 18), 65),
          age_max: Math.min(Math.max(criteria.age_max ?? 65, 18), 65),
          genders: criteria.genders ?? 'alle',
          countries: (criteria.countries?.length ? criteria.countries : ['DE']).map(c => c.toUpperCase()).slice(0, 5),
          interests,
          jobs,
          summary: criteria.summary ?? '',
        },
      })
    }

    // ── Vorschlag anwenden (NUR System-Kampagne) ─────────────────────────────
    if (mode === 'audience_apply') {
      const { data: st } = await supabase.from('ad_settings').select('system_campaign_id').eq('id', 'default').maybeSingle()
      const sysCampaign = digits((st as { system_campaign_id?: string } | null)?.system_campaign_id)
      if (!sysCampaign) throw new Error('Keine System-Kampagne konfiguriert')

      const d = body.targeting_draft as {
        age_min: number; age_max: number; genders: string; countries: string[]
        interests: Array<{ id: string; name: string }>
        jobs: Array<{ id: string; name: string }>
      } | undefined
      if (!d || !Array.isArray(d.interests)) throw new Error('targeting_draft fehlt')
      const countries = [...new Set(strList(d.countries).map(c => c.trim().toUpperCase()).filter(c => /^[A-Z]{2}$/.test(c)))].slice(0, 25)
      if (!countries.length) throw new Error('Zielgruppe braucht mindestens ein Land')
      const alter = (v: unknown, fallback: number) => {
        const n = Math.round(Number(v))
        return Number.isFinite(n) ? Math.min(Math.max(n, 18), 65) : fallback
      }

      // Erste Anzeigengruppe der System-Kampagne; ownEntity prüft das Konto
      const adsets = await graphGet<{ data?: Array<{ id: string }> }>(`${sysCampaign}/adsets`, { fields: 'id,name', limit: 10 })
      const adsetId = digits(adsets?.data?.[0]?.id)
      if (!adsetId) throw new Error('Kein Adset in der System-Kampagne gefunden')
      const before = await ownEntity(ctx, adsetId, TARGETING_FIELDS, 'Anzeigengruppe gehört nicht zu unserem Werbekonto')

      // Zusammenführen: aktuelles Targeting bleibt (Platzierungen, Custom
      // Audiences, Ausschlüsse, Advantage+ Zielgruppe, Ortstyp ...), der Vorschlag
      // setzt Alter, Geschlecht, Länder und das Detail-Targeting.
      const current: Row = isObj(before.targeting) ? clone(before.targeting) : {}
      const next: Row = { ...current }
      const ageMin = alter(d.age_min, 18)
      next.age_min = ageMin
      next.age_max = Math.max(alter(d.age_max, 65), ageMin)
      if (d.genders === 'maenner') next.genders = [1]
      else if (d.genders === 'frauen') next.genders = [2]
      else delete next.genders
      const geoAlt = isObj(current.geo_locations) ? current.geo_locations : {}
      const lt = geoAlt.location_types
      next.geo_locations = { countries, ...(Array.isArray(lt) && lt.length ? { location_types: lt } : {}) }
      // Interessen und Jobtitel ODER-verknüpft: EINE flexible_spec-Gruppe
      // (mehrere Gruppen wären UND und würden die Zielgruppe zur Schnittmenge machen).
      const gruppe: Record<string, Array<{ id: string; name: string }>> = {}
      const interests = d.interests.filter(x => x && x.id).map(x => ({ id: String(x.id), name: String(x.name ?? '') }))
      const jobs = (Array.isArray(d.jobs) ? d.jobs : []).filter(x => x && x.id).map(x => ({ id: String(x.id), name: String(x.name ?? '') }))
      if (interests.length) gruppe.interests = interests
      if (jobs.length) gruppe.work_positions = jobs
      if (Object.keys(gruppe).length) next.flexible_spec = [gruppe]
      else delete next.flexible_spec

      const camp = isObj(before.campaign) ? before.campaign : {}
      const h = housingAnwenden(next, strList(camp.special_ad_categories), strList(camp.special_ad_category_country))
      const patch = buildPatch('adset', { targeting: h.targeting })
      await schreiben(ctx, { level: 'adset', id: adsetId, body: patch, before: { targeting: before.targeting ?? null } })
      console.log(`[meta-ads-tools] Targeting angewendet auf Adset ${adsetId} (Kampagne ${sysCampaign})`)

      // Lernen: bestätigte Beschreibung→Targeting-Paare sind die besten Beispiele
      const description = String(body.description ?? '').trim().slice(0, 2000)
      if (description) {
        const { error } = await supabase.from('ads_ai_examples').insert({ description, applied_draft: d })
        if (error) console.warn('[meta-ads-tools] Beispiel speichern:', error.message)
      }
      return json({ success: true, adset_id: adsetId, housing: h.info })
    }

    throw new Error(`Unbekannter mode "${mode}"`)
  } catch (err) {
    if (err instanceof GuardrailError) {
      console.warn('[meta-ads-tools] 409', err.message)
      return new Response(JSON.stringify({ error: err.message, code: 'guardrail_exceeded', data: err.data }), {
        status: 409, headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }
    let msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AdsAuthError ? err.status : err instanceof EingabeFehler ? 400 : 500
    const extra: Record<string, unknown> = {}
    if (err instanceof MetaApiError) {
      if (err.userMsg === 'META_WRITES_DISABLED') {
        msg = 'Schreibzugriffe an Meta sind gerade per Not-Aus gesperrt (META_WRITES_DISABLED).'
        extra.code = 'writes_disabled'
      } else {
        msg = String(err.userMsg || err.message).slice(0, 300)
        extra.code = err.kind
        extra.meta = err.detail()
      }
    }
    console.error('[meta-ads-tools]', status, msg)
    return new Response(JSON.stringify({ error: msg, ...extra }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  function json(obj: Record<string, unknown>) {
    return new Response(JSON.stringify(obj), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
