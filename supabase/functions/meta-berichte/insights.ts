// meta-berichte, Modus insights: Kennzahlen mit Aufschlüsselung, Zeitraster,
// Feld-Voreinstellung und optionalem Vergleichszeitraum.
//
// Ein Abruf = GET act_<konto>/insights (level, time_range, time_increment,
// breakdowns, filtering nach IDs), Seite für Seite bis höchstens MAX_SEITEN (10),
// Abbruch über 75 % Auslastung. Ergebnis normalisiert (normalize.ts) und je
// Zeitraum im Zwischenspeicher (cache.ts). Lehnt Meta einzelne Felder ab und nennt
// sie (z. B. Reichweite bei stündlicher Aufschlüsselung), einmal ohne sie.

import { MetaApiError, wechselkurs, type GraphParams, type Wechselkurs } from '../_shared/metaGraph.ts'
import {
  BerichtError, FN, graphSeiten, heuteBerlin, MAX_RUECKBLICK_13_MONATE, MAX_RUECKBLICK_TAGE, monatePlus, obj, pruefeId,
  pruefeIds, pruefeZeitraum, uniq, usageJetzt, enthaeltHeute, type Ctx, type Raw, type Seiten,
} from './common.ts'
import {
  auslastungMerken, cacheLesen, cacheSchluessel, cacheSchreiben, drosselText, drosselungLesen, drosselungMerken,
  TTL_HEUTE_S, TTL_KURZ_S, TTL_VERGANGEN_S,
} from './cache.ts'
import { normalisiereZeile, pruefeBreakdowns, summiere, vergleiche } from './normalize.ts'
import {
  BERICHT_LEVELS, ERGEBNIS_ARTEN, FELDER_PRESETS,
  type BerichtLevel, type BerichtZeile, type Breakdown, type ErgebnisArt, type FelderPreset, type InsightsResponse,
  type TimeIncrement, type Zeitraum,
} from './types.ts'

/** 500 Zeilen je Seite, höchstens 10 Seiten (5.000 Zeilen) je Zeitraum */
const SEITE = 500
const MAX_SEITEN = 10
const WAEHRUNG = 'USD'

const ID_FELDER: Record<BerichtLevel, string[]> = {
  account: ['account_id'],
  campaign: ['campaign_id', 'campaign_name'],
  adset: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name'],
  ad: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name'],
}
const BASIS_FELDER = [
  'spend', 'impressions', 'reach', 'frequency', 'clicks', 'inline_link_clicks', 'actions', 'outbound_clicks',
  'video_thruplay_watched_actions',
]
const VIDEO_FELDER = [
  'video_play_actions', 'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions',
  'video_p95_watched_actions', 'video_p100_watched_actions', 'video_avg_time_watched_actions',
]
const GEBOTE_FELDER = ['unique_clicks', 'unique_inline_link_clicks', 'attribution_setting']
/** Felder, die Meta je nach Version oder Aufschlüsselung ablehnen kann: Rückfall ohne sie */
const HEIKEL = new Set(['reach', 'frequency', 'attribution_setting', 'unique_clicks', 'unique_inline_link_clicks', 'video_thruplay_watched_actions'])
/** Nur wenn Metas Fehlermeldung eines dieser Felder nennt, lohnt der Rückfall ohne HEIKEL */
const HEIKEL_RE = /reach|frequency|attribution|unique|thruplay/i
const STUENDLICH: Breakdown = 'hourly_stats_aggregated_by_advertiser_time_zone'
/** Seit 6.8.2026 nur nach Freischaltung je Werbekonto; ohne sie liefert Meta still keine Zeilen */
const GERAET: Breakdown = 'impression_device'
const GERAET_HINWEIS = 'Meta liefert keine Zeilen für „Gerät der Impression“. Seit 6.8.2026 gibt Meta diese Aufschlüsselung nur nach ' +
  'Freischaltung im Werbeanzeigenmanager heraus (Berichte, weitere Aufschlüsselungen). Liefen im Zeitraum Anzeigen, bitte dort freischalten.'

export function feldliste(level: BerichtLevel, felder: FelderPreset, ohneReichweite: boolean): string[] {
  const l = [...ID_FELDER[level], ...BASIS_FELDER]
  if (felder === 'video') l.push(...VIDEO_FELDER)
  if (felder === 'gebote') l.push(...GEBOTE_FELDER)
  return ohneReichweite ? l.filter(f => f !== 'reach' && f !== 'frequency' && f !== 'unique_clicks' && f !== 'unique_inline_link_clicks') : l
}

export interface InsightsAnfrage {
  level: BerichtLevel
  ids: string[]
  campaign_id: string | null
  breakdowns: Breakdown[]
  time_increment: TimeIncrement
  felder: FelderPreset
  ergebnis: ErgebnisArt
  frisch: boolean
  haupt: Zeitraum
  compare: Zeitraum | null
}

function timeIncrement(v: unknown): TimeIncrement {
  if (v === undefined || v === null || v === '') return 'all_days'
  if (v === 1 || v === '1') return 1
  if (v === 7 || v === '7') return 7
  if (v === 'monthly' || v === 'all_days') return v
  throw new BerichtError(400, 'invalid_request', 'time_increment muss 1, 7, monthly oder all_days sein.')
}

function auswahl<T extends string>(v: unknown, erlaubt: readonly T[], standard: T, label: string): T {
  if (v === undefined || v === null || v === '') return standard
  if (typeof v === 'string' && (erlaubt as readonly string[]).indexOf(v) >= 0) return v as T
  throw new BerichtError(400, 'invalid_request', `${label} muss eins von ${erlaubt.join(', ')} sein.`)
}

export function pruefeInsightsAnfrage(body: Raw, hinweise: string[]): InsightsAnfrage {
  if (body.level === undefined || body.level === null || body.level === '') {
    throw new BerichtError(400, 'invalid_request', 'level fehlt (account, campaign, adset oder ad).')
  }
  const level = auswahl<BerichtLevel>(body.level, BERICHT_LEVELS, 'ad', 'level')
  const ids = pruefeIds(body.ids, 'ids', 50, false)
  if (level === 'account' && ids.length) {
    throw new BerichtError(400, 'invalid_request', 'Auf Konto-Ebene gibt es keine ids, bitte campaign, adset oder ad wählen.')
  }
  const campaign_id = pruefeId(body.campaign_id, 'campaign_id')
  const bd = pruefeBreakdowns(body.breakdowns, level)
  if (!bd.ok) throw new BerichtError(400, 'invalid_request', bd.fehler)
  const time_increment = timeIncrement(body.time_increment)
  const felder = auswahl<FelderPreset>(body.felder, FELDER_PRESETS, 'standard', 'felder')
  const ergebnis = auswahl<ErgebnisArt>(body.ergebnis, ERGEBNIS_ARTEN, 'leads', 'ergebnis')
  // Grenzen schonen das Meta-Limit (Konto auf „Limited access“)
  const maxTage = bd.gruppe === 'zeit' ? 92
    : time_increment === 1 && bd.breakdowns.length ? 186
      : time_increment === 1 ? 400
        : MAX_RUECKBLICK_TAGE
  const haupt = pruefeZeitraum(body.since, body.until, 'Zeitraum', maxTage, hinweise)
  let compare: Zeitraum | null = null
  if (body.compare !== undefined && body.compare !== null) {
    const c = obj(body.compare)
    if (!c) throw new BerichtError(400, 'invalid_request', 'compare muss { since, until } sein.')
    compare = pruefeZeitraum(c.since, c.until, 'Vergleichszeitraum', maxTage, hinweise)
  }
  // Tageszeit, Reichweite mit Aufschlüsselung und eindeutige Klicks nur 13 Monate rückwirkend
  const grenze = monatePlus(heuteBerlin(), -MAX_RUECKBLICK_13_MONATE)
  for (const [z, label] of [[haupt, 'Zeitraum'], [compare, 'Vergleichszeitraum']] as Array<[Zeitraum | null, string]>) {
    if (!z || z.since >= grenze) continue
    if (bd.gruppe === 'zeit') {
      throw new BerichtError(400, 'invalid_request', `${label}: Die Tageszeit liefert Meta nur für die letzten 13 Monate (ab ${grenze}).`,
        'Späteres Von-Datum wählen.')
    }
    if (bd.breakdowns.length) {
      hinweise.push(`${label}: Reichweite und Frequenz fehlen bei Aufschlüsselungen vor dem ${grenze} (Meta liefert sie nur 13 Monate rückwirkend).`)
    }
    if (felder === 'gebote') {
      hinweise.push(`${label}: Eindeutige Klicks liefert Meta nur für die letzten 13 Monate (ab ${grenze}).`)
    }
  }
  return { level, ids, campaign_id, breakdowns: bd.breakdowns, time_increment, felder, ergebnis, frisch: body.frisch === true, haupt, compare }
}

/** Parameter für act_<konto>/insights (ohne fields). */
export function insightsParams(a: InsightsAnfrage, z: Zeitraum): GraphParams {
  const p: GraphParams = {
    level: a.level,
    time_range: { since: z.since, until: z.until },
    time_increment: a.time_increment,
    limit: SEITE,
  }
  if (a.breakdowns.length) p.breakdowns = a.breakdowns.join(',')
  const filtering: Array<Record<string, unknown>> = []
  if (a.ids.length) filtering.push({ field: `${a.level}.id`, operator: 'IN', value: a.ids })
  if (a.campaign_id) filtering.push({ field: 'campaign.id', operator: 'IN', value: [a.campaign_id] })
  if (filtering.length) p.filtering = filtering
  return p
}

/** true, wenn Metas Fehlermeldung ein Feld aus HEIKEL nennt (sonst hilft der Rückfall nicht). */
function nenntHeikelFeld(err: MetaApiError): boolean {
  const text = [err.message, err.userMsg ?? '', err.userTitle ?? '', ...err.blame.map(b => `${b.field ?? ''} ${b.message ?? ''}`)].join(' ')
  return HEIKEL_RE.test(text)
}

async function metaAbfrage(ctx: Ctx, a: InsightsAnfrage, z: Zeitraum): Promise<Seiten<Raw>> {
  const pfad = `act_${ctx.account}/insights`
  const params = insightsParams(a, z)
  const felder = feldliste(a.level, a.felder, a.breakdowns.indexOf(STUENDLICH) >= 0)
  try {
    return await graphSeiten<Raw>(pfad, { ...params, fields: felder.join(',') }, MAX_SEITEN)
  } catch (err) {
    if (!(err instanceof MetaApiError) || err.kind !== 'validation' || !nenntHeikelFeld(err)) throw err
    const rest = felder.filter(f => !HEIKEL.has(f))
    if (rest.length === felder.length) throw err
    console.warn(`[${FN}] insights: Feldliste abgelehnt, Rückfall ohne ${felder.filter(f => HEIKEL.has(f)).join(',')}:`, err.message.slice(0, 200))
    ctx.hinweise.push('Meta hat einzelne Kennzahlen für diese Auswahl abgelehnt (z. B. Reichweite oder ThruPlays); Bericht ohne sie.')
    return await graphSeiten<Raw>(pfad, { ...params, fields: rest.join(',') }, MAX_SEITEN)
  }
}

interface TeilPayload {
  rows: BerichtZeile[]
  fetched_at: string
  usd_per_eur: number
  kurs_quelle: 'insights_7d' | 'fallback'
  unvollstaendig: boolean
}
interface Teil extends TeilPayload { cached: boolean; veraltet: boolean }

function sortiere(rows: BerichtZeile[]): BerichtZeile[] {
  return rows.sort((x, y) =>
    String(x.date_start ?? '').localeCompare(String(y.date_start ?? '')) ||
    y.spend - x.spend ||
    String(x.breakdown_label ?? '').localeCompare(String(y.breakdown_label ?? '')))
}

async function teilLaden(ctx: Ctx, a: InsightsAnfrage, z: Zeitraum, kurs: () => Promise<Wechselkurs>, label: string): Promise<Teil> {
  const key = await cacheSchluessel({
    mode: 'insights', account: ctx.account, level: a.level, ids: [...a.ids].sort(), campaign_id: a.campaign_id,
    breakdowns: a.breakdowns, time_increment: a.time_increment, felder: a.felder, ergebnis: a.ergebnis,
    since: z.since, until: z.until,
  })
  const treffer = await cacheLesen<TeilPayload>(ctx.sb, key)
  const gueltig = treffer && Array.isArray(treffer.payload?.rows) ? treffer : null
  if (gueltig && gueltig.frisch && !a.frisch) return { ...gueltig.payload, cached: true, veraltet: false }

  const veraltet = (grund: string): Teil | null => {
    if (!gueltig) return null
    ctx.hinweise.push(`${label}: ${grund} Angezeigt wird der Stand von ${gueltig.fetched_at.slice(0, 16).replace('T', ' ')} (UTC).`)
    return { ...gueltig.payload, cached: true, veraltet: true }
  }

  const drossel = await drosselungLesen(ctx.sb, ctx.account)
  if (drossel) {
    const alt = veraltet(drosselText(drossel))
    if (alt) return alt
    throw new BerichtError(429, 'rate_limited', drosselText(drossel),
      'Das Werbekonto steht bei Meta auf „Limited access“. Kürzere Zeiträume und wenige Aufschlüsselungen schonen das Limit.')
  }

  try {
    const seiten = await metaAbfrage(ctx, a, z)
    const k = await kurs()
    const rows = sortiere(seiten.rows.map(r => normalisiereZeile(r, {
      breakdowns: a.breakdowns, felder: a.felder, ergebnis: a.ergebnis, usdPerEur: k.usdPerEur, currency: WAEHRUNG,
    })))
    if (seiten.grund) ctx.hinweise.push(`${label}: ${seiten.grund}`)
    const payload: TeilPayload = {
      rows, fetched_at: new Date().toISOString(), usd_per_eur: k.usdPerEur, kurs_quelle: k.quelle, unvollstaendig: seiten.unvollstaendig,
    }
    // Leer mit „Gerät der Impression“: evtl. nur fehlende Freischaltung, daher kurz speichern
    const leerGeraet = rows.length === 0 && a.breakdowns.indexOf(GERAET) >= 0
    const ttl = seiten.unvollstaendig || leerGeraet ? TTL_KURZ_S : enthaeltHeute(z) ? TTL_HEUTE_S : TTL_VERGANGEN_S
    await cacheSchreiben(ctx.sb, key, payload, ttl)
    await auslastungMerken(ctx.sb, ctx.account)
    return { ...payload, cached: false, veraltet: false }
  } catch (err) {
    if (err instanceof MetaApiError && err.kind === 'rate_limit') {
      await drosselungMerken(ctx.sb, ctx.account, err)
      const alt = veraltet('Meta drosselt gerade die Abfragen.')
      if (alt) return alt
    } else if (err instanceof MetaApiError && err.kind === 'transient') {
      const alt = veraltet('Meta war nicht erreichbar.')
      if (alt) return alt
    }
    throw err
  }
}

export async function modeInsights(ctx: Ctx, body: Raw): Promise<InsightsResponse> {
  const a = pruefeInsightsAnfrage(body, ctx.hinweise)
  let kursP: Promise<Wechselkurs> | null = null
  const kurs = () => (kursP ??= wechselkurs(ctx.sb))

  const haupt = await teilLaden(ctx, a, a.haupt, kurs, 'Zeitraum')
  let vor: Teil | null = null
  if (a.compare) {
    try {
      vor = await teilLaden(ctx, a, a.compare, kurs, 'Vergleichszeitraum')
    } catch (err) {
      // Der Hauptbericht ist da; der Vergleich fehlt nur (z. B. Meta gedrosselt)
      const msg = err instanceof Error ? err.message : String(err)
      if (err instanceof BerichtError && err.status !== 429) throw err
      ctx.hinweise.push(`Vergleichszeitraum nicht geladen: ${msg.slice(0, 200)}`)
    }
  }

  if (haupt.rows.length === 0 && a.breakdowns.indexOf(GERAET) >= 0) ctx.hinweise.push(GERAET_HINWEIS)

  const totals = summiere(haupt.rows, { ergebnis: a.ergebnis, usdPerEur: haupt.usd_per_eur })
  const out: InsightsResponse = {
    rows: haupt.rows,
    totals,
    cached: haupt.cached && (!a.compare || (vor !== null && vor.cached)),
    fetched_at: haupt.fetched_at,
    currency: WAEHRUNG,
    usd_per_eur: haupt.usd_per_eur,
    kurs_quelle: haupt.kurs_quelle,
    unvollstaendig: haupt.unvollstaendig || (vor?.unvollstaendig ?? false),
    veraltet: haupt.veraltet || (vor?.veraltet ?? false),
    hinweise: uniq(ctx.hinweise),
    // nur wenn in diesem Aufruf bei Meta abgerufen wurde (getLastUsage gilt je Isolate)
    usage: haupt.cached && (vor?.cached ?? true) ? null : usageJetzt(),
  }
  if (vor) {
    const compareTotals = summiere(vor.rows, { ergebnis: a.ergebnis, usdPerEur: vor.usd_per_eur })
    out.compare_rows = vor.rows
    out.compare_totals = compareTotals
    out.compare_fetched_at = vor.fetched_at
    out.vergleich = vergleiche(totals, compareTotals)
  }
  return out
}
