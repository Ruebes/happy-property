// meta-berichte: reine Umrechnungen (kein Netz, keine DB, nur ./types.ts).
//
// - Meta-Insights-Zeilen: Zahlen kommen als Strings, Ereignisse als actions-Liste.
//   Hier werden daraus Zahlen und benannte Felder (leads, schedule, landing_page_view,
//   video_view, thruplay, link_click, outbound_click) plus CTR, CPM, Frequenz und
//   Kosten pro Ergebnis (USD und EUR).
// - Aufschlüsselungen prüfen und lesbar machen (deutsche Bezeichnungen).
// - Auslieferungsstatus, Lernphase, Prüfhinweise, Aktivitäten und Empfehlungen
//   in die Begriffe des deutschen Werbeanzeigenmanagers übersetzen.
//
// Überlappende action_types werden nie summiert (z. B. lead und
// offsite_conversion.fb_pixel_lead): es zählt der erste vorhandene der Liste.

import {
  BREAKDOWN_LABELS, BREAKDOWNS,
  type AktivitaetKategorie, type AktivitaetObjekt, type AssetInfo, type Auslieferung, type BerichtKennzahlen,
  type BerichtLevel, type BerichtSumme, type BerichtZeile, type Breakdown, type BreakdownGruppe,
  type EmpfehlungKategorie, type ErgebnisArt, type FelderPreset, type GeaendertVon, type LernphaseInfo,
  type MetaIssue, type VergleichWert,
} from './types.ts'

type Raw = Record<string, unknown>

// ── Zahlen ───────────────────────────────────────────────────────────────────

export const zahl = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}
export const zahlOderNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : null)
const r2 = (n: number): number => Math.round(n * 100) / 100
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000
/** a / b * faktor, gerundet; null wenn b <= 0 */
const quote = (a: number, b: number, faktor = 1, runden: (n: number) => number = r2): number | null =>
  b > 0 && Number.isFinite(a) ? runden((a / b) * faktor) : null

// ── actions ──────────────────────────────────────────────────────────────────

/** actions-Liste von Meta -> { action_type: Wert } */
export function aktionenMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!Array.isArray(v)) return out
  for (const a of v) {
    const o = obj(a)
    const t = o && typeof o.action_type === 'string' ? o.action_type : ''
    if (!t) continue
    out[t] = zahl(o!.value)
  }
  return out
}

/** Erster vorhandener action_type der Prioritätenliste (nie summieren, die Typen überlappen). */
export function ersteAktion(m: Record<string, number>, typen: readonly string[]): number {
  for (const t of typen) if (Object.prototype.hasOwnProperty.call(m, t)) return m[t]
  return 0
}

/** Wert aus einer Video-Liste (meist genau ein Eintrag video_view). */
function videoWert(v: unknown): number | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const m = aktionenMap(v)
  if (Object.prototype.hasOwnProperty.call(m, 'video_view')) return m.video_view
  const erster = obj(v[0])
  return erster ? zahl(erster.value) : null
}

/** Alle Leads (Formular + Pixel); „lead“ ist bei Meta bereits die Summe. */
export const LEAD_TYPEN = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead'] as const
/** Termin gebucht: welcher Typ beim Pixel-Ereignis Schedule erscheint, ist nicht abschließend belegt (wie meta-ads-sync). */
export const SCHEDULE_TYPEN = ['schedule_total', 'schedule_website', 'offsite_conversion.fb_pixel_schedule'] as const
export const LPV_TYPEN = ['landing_page_view', 'omni_landing_page_view'] as const

// ── Kennzahlen ───────────────────────────────────────────────────────────────

/** Additive Rohwerte einer Zeile (bzw. Summe). */
export interface Basiswerte {
  spend: number
  impressions: number
  reach: number | null
  frequency: number | null
  clicks: number
  link_click: number
  outbound_click: number
  landing_page_view: number
  leads: number
  schedule: number
  video_view: number
  thruplay: number
  video_p25: number | null
  video_p50: number | null
  video_p75: number | null
  video_p95: number | null
  video_p100: number | null
  video_play: number | null
  video_avg_time_s: number | null
  unique_clicks: number | null
  unique_link_clicks: number | null
}

export interface KennzahlOptionen {
  ergebnis: ErgebnisArt
  /** USD je EUR (> 0) */
  usdPerEur: number
}

export function kennzahlen(b: Basiswerte, opt: KennzahlOptionen): BerichtKennzahlen {
  const kurs = opt.usdPerEur > 0 ? opt.usdPerEur : 1.14
  const spendEur = b.spend / kurs
  const results =
    opt.ergebnis === 'schedule' ? b.schedule
      : opt.ergebnis === 'landing_page_view' ? b.landing_page_view
        : opt.ergebnis === 'link_click' ? b.link_click
          : opt.ergebnis === 'thruplay' ? b.thruplay
            : b.leads
  const frequency = b.frequency !== null && b.frequency > 0
    ? r4(b.frequency)
    : b.reach !== null && b.reach > 0 ? r4(b.impressions / b.reach) : null
  const videoDa = b.video_view > 0 || b.thruplay > 0
  return {
    spend: r2(b.spend),
    spend_eur: r2(spendEur),
    impressions: b.impressions,
    reach: b.reach,
    frequency,
    clicks: b.clicks,
    link_click: b.link_click,
    outbound_click: b.outbound_click,
    landing_page_view: b.landing_page_view,
    leads: b.leads,
    schedule: b.schedule,
    video_view: b.video_view,
    thruplay: b.thruplay,
    video_p25: b.video_p25,
    video_p50: b.video_p50,
    video_p75: b.video_p75,
    video_p95: b.video_p95,
    video_p100: b.video_p100,
    video_play: b.video_play,
    video_avg_time_s: b.video_avg_time_s,
    unique_clicks: b.unique_clicks,
    unique_link_clicks: b.unique_link_clicks,
    ctr: quote(b.clicks, b.impressions, 100, r4),
    ctr_link: quote(b.link_click, b.impressions, 100, r4),
    cpm: quote(b.spend, b.impressions, 1000),
    cpm_eur: quote(spendEur, b.impressions, 1000),
    cpc_link: quote(b.spend, b.link_click),
    cpc_link_eur: quote(spendEur, b.link_click),
    ergebnis_art: opt.ergebnis,
    results,
    cost_per_result: quote(b.spend, results),
    cost_per_result_eur: quote(spendEur, results),
    cost_per_lead: quote(b.spend, b.leads),
    cost_per_lead_eur: quote(spendEur, b.leads),
    cost_per_schedule: quote(b.spend, b.schedule),
    cost_per_schedule_eur: quote(spendEur, b.schedule),
    cost_per_landing_page_view: quote(b.spend, b.landing_page_view),
    cost_per_landing_page_view_eur: quote(spendEur, b.landing_page_view),
    hook_rate: videoDa ? quote(b.video_view, b.impressions, 100, r4) : null,
    lpv_rate: quote(b.landing_page_view, b.link_click, 100, r4),
    lead_rate: quote(b.leads, b.link_click, 100, r4),
  }
}

export interface ZeilenOptionen extends KennzahlOptionen {
  breakdowns: Breakdown[]
  felder: FelderPreset
  currency: string
}

/** Eine Insights-Zeile von Meta -> BerichtZeile (Zahlen, benannte Ereignisse, Kennzahlen). */
export function normalisiereZeile(raw: Raw, opt: ZeilenOptionen): BerichtZeile {
  const akt = aktionenMap(raw.actions)
  const outbound = aktionenMap(raw.outbound_clicks)
  const linkFeld = zahlOderNull(raw.inline_link_clicks)
  const video = opt.felder === 'video'
  const gebote = opt.felder === 'gebote'
  const thru = videoWert(raw.video_thruplay_watched_actions)
  const basis: Basiswerte = {
    spend: zahl(raw.spend),
    impressions: Math.trunc(zahl(raw.impressions)),
    reach: zahlOderNull(raw.reach),
    frequency: zahlOderNull(raw.frequency),
    clicks: Math.trunc(zahl(raw.clicks)),
    link_click: Math.trunc(linkFeld ?? ersteAktion(akt, ['link_click'])),
    outbound_click: Math.trunc(
      Object.prototype.hasOwnProperty.call(outbound, 'outbound_click') ? outbound.outbound_click : ersteAktion(akt, ['outbound_click']),
    ),
    landing_page_view: Math.trunc(ersteAktion(akt, LPV_TYPEN)),
    leads: Math.trunc(ersteAktion(akt, LEAD_TYPEN)),
    schedule: Math.trunc(ersteAktion(akt, SCHEDULE_TYPEN)),
    video_view: Math.trunc(ersteAktion(akt, ['video_view'])),
    thruplay: Math.trunc(thru ?? 0),
    video_p25: video ? videoWert(raw.video_p25_watched_actions) ?? 0 : null,
    video_p50: video ? videoWert(raw.video_p50_watched_actions) ?? 0 : null,
    video_p75: video ? videoWert(raw.video_p75_watched_actions) ?? 0 : null,
    video_p95: video ? videoWert(raw.video_p95_watched_actions) ?? 0 : null,
    video_p100: video ? videoWert(raw.video_p100_watched_actions) ?? 0 : null,
    video_play: video ? videoWert(raw.video_play_actions) ?? 0 : null,
    video_avg_time_s: video ? videoWert(raw.video_avg_time_watched_actions) : null,
    unique_clicks: gebote ? zahlOderNull(raw.unique_clicks) : null,
    unique_link_clicks: gebote ? zahlOderNull(raw.unique_inline_link_clicks) : null,
  }
  if (basis.reach !== null) basis.reach = Math.trunc(basis.reach)

  const bd = aufschluesselung(raw, opt.breakdowns)
  return {
    ...bd.oben,
    date_start: text(raw.date_start),
    date_stop: text(raw.date_stop),
    account_id: text(raw.account_id),
    campaign_id: text(raw.campaign_id),
    campaign_name: text(raw.campaign_name),
    adset_id: text(raw.adset_id),
    adset_name: text(raw.adset_name),
    ad_id: text(raw.ad_id),
    ad_name: text(raw.ad_name),
    breakdown: bd.werte,
    breakdown_label: bd.label,
    asset: bd.asset,
    currency: opt.currency,
    attribution_setting: gebote ? text(raw.attribution_setting) : null,
    actions: akt,
    ...kennzahlen(basis, opt),
  }
}

const SUMMEN_FELDER = [
  'spend', 'impressions', 'clicks', 'link_click', 'outbound_click', 'landing_page_view', 'leads', 'schedule',
  'video_view', 'thruplay',
] as const
const VIDEO_SUMMEN = ['video_p25', 'video_p50', 'video_p75', 'video_p95', 'video_p100', 'video_play'] as const

/**
 * Summe über Zeilen. Reichweite, Frequenz, Durchschnitts-Wiedergabezeit und
 * Unique-Werte sind nicht additiv: nur bei genau einer Zeile übernommen, sonst null.
 */
export function summiere(rows: BerichtZeile[], opt: KennzahlOptionen): BerichtSumme {
  const b: Basiswerte = {
    spend: 0, impressions: 0, reach: null, frequency: null, clicks: 0, link_click: 0, outbound_click: 0,
    landing_page_view: 0, leads: 0, schedule: 0, video_view: 0, thruplay: 0,
    video_p25: null, video_p50: null, video_p75: null, video_p95: null, video_p100: null, video_play: null,
    video_avg_time_s: null, unique_clicks: null, unique_link_clicks: null,
  }
  for (const r of rows) {
    for (const k of SUMMEN_FELDER) b[k] += zahl(r[k])
    for (const k of VIDEO_SUMMEN) {
      const v = r[k]
      if (v !== null && v !== undefined) b[k] = (b[k] ?? 0) + zahl(v)
    }
  }
  if (rows.length === 1) {
    const r = rows[0]
    b.reach = r.reach
    b.frequency = r.frequency
    b.video_avg_time_s = r.video_avg_time_s
    b.unique_clicks = r.unique_clicks
    b.unique_link_clicks = r.unique_link_clicks
  }
  return { ...kennzahlen(b, opt), zeilen: rows.length }
}

export const VERGLEICH_FELDER = [
  'spend', 'spend_eur', 'impressions', 'reach', 'frequency', 'clicks', 'link_click', 'outbound_click',
  'landing_page_view', 'leads', 'schedule', 'video_view', 'thruplay', 'results', 'ctr', 'ctr_link', 'cpm', 'cpm_eur',
  'cpc_link', 'cpc_link_eur', 'cost_per_result', 'cost_per_result_eur', 'cost_per_lead', 'cost_per_lead_eur',
  'cost_per_schedule', 'cost_per_schedule_eur', 'hook_rate', 'lpv_rate', 'lead_rate',
] as const

/** Veränderung je Kennzahl: absolut und in Prozent (wie „Datumsbereich vergleichen“). */
export function vergleiche(aktuell: BerichtSumme, vorher: BerichtSumme): Record<string, VergleichWert> {
  const out: Record<string, VergleichWert> = {}
  for (const k of VERGLEICH_FELDER) {
    const a = zahlOderNull(aktuell[k])
    const v = zahlOderNull(vorher[k])
    const absolut = a !== null && v !== null ? r4(a - v) : null
    const prozent = a !== null && v !== null && v !== 0 ? r2(((a - v) / Math.abs(v)) * 100) : null
    out[k] = { aktuell: a, vorher: v, absolut, prozent }
  }
  return out
}

// ── Aufschlüsselungen ────────────────────────────────────────────────────────

const ASSET_BD: readonly Breakdown[] = ['body_asset', 'title_asset', 'image_asset', 'video_asset']
const DEMO_BD: readonly Breakdown[] = ['age', 'gender']
const GEO_BD: readonly Breakdown[] = ['country', 'region']
const PLATT_BD: readonly Breakdown[] = ['publisher_platform', 'platform_position', 'impression_device']
const ZEIT_BD: Breakdown = 'hourly_stats_aggregated_by_advertiser_time_zone'

export type BreakdownPruefung =
  | { ok: true; breakdowns: Breakdown[]; gruppe: BreakdownGruppe | null }
  | { ok: false; fehler: string }

const bdListe = (l: readonly Breakdown[]): string => l.map(b => BREAKDOWN_LABELS[b]).join(', ')

/** Prüft die gewünschten Aufschlüsselungen gegen Metas Kombinationsregeln (siehe types.ts). */
export function pruefeBreakdowns(eingabe: unknown, level: BerichtLevel): BreakdownPruefung {
  if (eingabe === undefined || eingabe === null) return { ok: true, breakdowns: [], gruppe: null }
  if (!Array.isArray(eingabe)) return { ok: false, fehler: 'breakdowns muss eine Liste sein.' }
  const roh = eingabe.map(x => String(x ?? '').trim()).filter(Boolean)
  const unbekannt = roh.filter(x => (BREAKDOWNS as readonly string[]).indexOf(x) < 0)
  if (unbekannt.length) return { ok: false, fehler: `Unbekannte Aufschlüsselung: ${unbekannt.slice(0, 3).join(', ')}.` }
  const set = new Set(roh as Breakdown[])
  if (set.size === 0) return { ok: true, breakdowns: [], gruppe: null }
  const has = (l: readonly Breakdown[]) => l.filter(b => set.has(b))

  if (set.has(ZEIT_BD)) {
    if (set.size > 1) return { ok: false, fehler: 'Die Tageszeit lässt sich nicht mit anderen Aufschlüsselungen kombinieren.' }
    return { ok: true, breakdowns: [ZEIT_BD], gruppe: 'zeit' }
  }
  const assets = has(ASSET_BD)
  const demo = has(DEMO_BD)
  const geo = has(GEO_BD)
  const platt = has(PLATT_BD)
  const ordnen = (l: Breakdown[]) => (BREAKDOWNS as readonly Breakdown[]).filter(b => l.indexOf(b) >= 0)

  if (assets.length) {
    if (assets.length > 1) return { ok: false, fehler: `Nur ein Anzeigen-Element gleichzeitig (${bdListe(assets)}).` }
    if (geo.length || platt.length) {
      return { ok: false, fehler: `${BREAKDOWN_LABELS[assets[0]]} lässt sich nur mit Alter und Geschlecht kombinieren.` }
    }
    if (level !== 'adset' && level !== 'ad') {
      return { ok: false, fehler: 'Die Aufschlüsselung nach Text, Überschrift, Bild oder Video gibt es nur für Anzeigengruppen und Werbeanzeigen.' }
    }
    return { ok: true, breakdowns: ordnen([...demo, assets[0]]), gruppe: 'element' }
  }
  const gruppen = [demo, geo, platt].filter(g => g.length > 0)
  if (gruppen.length > 1) {
    return { ok: false, fehler: `Diese Aufschlüsselungen lassen sich bei Meta nicht kombinieren: ${bdListe(ordnen([...demo, ...geo, ...platt]))}.` }
  }
  if (geo.length > 1) return { ok: false, fehler: 'Bitte Land oder Region wählen, nicht beides.' }
  if (geo.length) return { ok: true, breakdowns: geo, gruppe: 'geo' }
  if (platt.length) {
    const l = [...platt]
    // Meta verlangt platform_position immer zusammen mit publisher_platform
    if (set.has('platform_position') && !set.has('publisher_platform')) l.push('publisher_platform')
    return { ok: true, breakdowns: ordnen(l), gruppe: 'plattform' }
  }
  return { ok: true, breakdowns: ordnen(demo), gruppe: 'demografie' }
}

const GESCHLECHT: Record<string, string> = { male: 'Männlich', female: 'Weiblich', unknown: 'Unbekannt' }
const PLATTFORM: Record<string, string> = {
  facebook: 'Facebook', instagram: 'Instagram', audience_network: 'Audience Network', messenger: 'Messenger',
  threads: 'Threads', whatsapp: 'WhatsApp', oculus: 'Meta Quest', unknown: 'Unbekannt',
}
const PLATZIERUNG: Record<string, string> = {
  feed: 'Feed', right_hand_column: 'Spalte rechts', marketplace: 'Marketplace', video_feeds: 'Video-Feeds',
  story: 'Stories', facebook_stories: 'Facebook Stories', instagram_stories: 'Instagram Stories',
  instream_video: 'In-Stream-Videos', search: 'Suchergebnisse', facebook_reels: 'Facebook Reels',
  facebook_reels_overlay: 'Anzeigen in Reels', instagram_reels: 'Instagram Reels', reels: 'Reels',
  instagram_explore: 'Instagram Entdecken', instagram_explore_grid_home: 'Instagram Entdecken (Startseite)',
  instagram_profile_feed: 'Instagram-Profil-Feed', instagram_profile_reels: 'Instagram-Profil-Reels',
  instagram_search: 'Instagram-Suchergebnisse', profile_feed: 'Profil-Feed', biz_disco_feed: 'Unternehmen entdecken',
  messenger_inbox: 'Messenger-Postfach', messenger_stories: 'Messenger Stories', sponsored_messages: 'Gesponserte Nachrichten',
  an_classic: 'Native, Banner und Interstitial', rewarded_video: 'Videos mit Prämie', threads_feed: 'Threads-Feed',
  notification: 'Benachrichtigungen', unknown: 'Unbekannt',
}
const GERAET: Record<string, string> = {
  desktop: 'Computer', iphone: 'iPhone', ipad: 'iPad', ipod: 'iPod', android_smartphone: 'Android-Smartphone',
  android_tablet: 'Android-Tablet', other: 'Sonstige', unknown: 'Unbekannt',
}
const REGION: Record<string, string> = {
  Bavaria: 'Bayern', Hesse: 'Hessen', 'Lower Saxony': 'Niedersachsen', 'North Rhine-Westphalia': 'Nordrhein-Westfalen',
  'Rhineland-Palatinate': 'Rheinland-Pfalz', Saxony: 'Sachsen', 'Saxony-Anhalt': 'Sachsen-Anhalt', Thuringia: 'Thüringen',
  'Baden-Wurttemberg': 'Baden-Württemberg', 'Baden-Württemberg': 'Baden-Württemberg', Vienna: 'Wien',
  'Lower Austria': 'Niederösterreich', 'Upper Austria': 'Oberösterreich', Styria: 'Steiermark', Tyrol: 'Tirol',
  Carinthia: 'Kärnten', Zurich: 'Zürich', Geneva: 'Genf', Lucerne: 'Luzern', Grisons: 'Graubünden',
  'Canton of Zurich': 'Kanton Zürich', 'Canton of Bern': 'Kanton Bern', Unknown: 'Unbekannt',
}

/** snake_case -> „Wort wort“ (Rückfall für unbekannte Meta-Werte) */
export function menschlich(v: string): string {
  const s = v.replace(/_/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : v
}

let laenderNamen: { of(code: string): string | undefined } | null | undefined
function landName(code: string): string {
  if (laenderNamen === undefined) {
    try {
      laenderNamen = new Intl.DisplayNames(['de'], { type: 'region' })
    } catch {
      laenderNamen = null
    }
  }
  if (!/^[A-Z]{2}$/.test(code)) return code === 'unknown' ? 'Unbekannt' : code
  try {
    return laenderNamen?.of(code) ?? code
  } catch {
    return code
  }
}

function stunde(v: string): string {
  // "00:00:00 - 00:59:59" -> "00:00-00:59"
  const m = /^(\d{2}:\d{2}):\d{2}\s*-\s*(\d{2}:\d{2}):\d{2}$/.exec(v.trim())
  return m ? `${m[1]}-${m[2]}` : v
}

function assetInfo(b: Breakdown, v: unknown): AssetInfo | null {
  const o = obj(v)
  if (!o) return null
  const art = b === 'body_asset' ? 'body' : b === 'title_asset' ? 'title' : b === 'image_asset' ? 'image' : 'video'
  return {
    art,
    id: text(o.id),
    text: text(o.text),
    url: text(o.url),
    hash: text(o.hash),
    video_id: text(o.video_id),
    thumbnail_url: text(o.thumbnail_url),
    name: text(o.name) ?? text(o.image_name) ?? text(o.video_name),
  }
}

function assetLabel(a: AssetInfo): string {
  const kurz = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s)
  if (a.text) return kurz(a.text.replace(/\s+/g, ' ').trim())
  if (a.name) return kurz(a.name)
  if (a.art === 'video' && a.video_id) return `Video ${a.video_id}`
  if (a.hash) return `Bild ${a.hash.slice(0, 10)}`
  return a.id ? `Element ${a.id}` : 'Element'
}

/** Lesbarer Wert einer Aufschlüsselung. */
export function breakdownWertLabel(b: Breakdown, v: string): string {
  switch (b) {
    case 'age': return v === 'Unknown' || v === 'unknown' ? 'Unbekannt' : v
    case 'gender': return GESCHLECHT[v] ?? menschlich(v)
    case 'country': return landName(v)
    case 'region': return REGION[v] ?? v
    case 'publisher_platform': return PLATTFORM[v] ?? menschlich(v)
    case 'platform_position': return PLATZIERUNG[v] ?? menschlich(v)
    case 'impression_device': return GERAET[v] ?? menschlich(v)
    case 'hourly_stats_aggregated_by_advertiser_time_zone': return stunde(v)
    default: return v
  }
}

function aufschluesselung(raw: Raw, breakdowns: Breakdown[]): {
  werte: Partial<Record<Breakdown, string | null>>; oben: Partial<Record<Breakdown, string | AssetInfo | null>>
  label: string | null; asset: AssetInfo | null
} {
  const werte: Partial<Record<Breakdown, string | null>> = {}
  const oben: Partial<Record<Breakdown, string | AssetInfo | null>> = {}
  const labels: string[] = []
  let asset: AssetInfo | null = null
  for (const b of breakdowns) {
    if (ASSET_BD.indexOf(b) >= 0) {
      const a = assetInfo(b, raw[b])
      werte[b] = a?.id ?? null
      oben[b] = a
      if (a) {
        asset = a
        labels.push(assetLabel(a))
      }
      continue
    }
    const v = text(raw[b])
    werte[b] = v
    oben[b] = v
    if (v !== null) labels.push(breakdownWertLabel(b, v))
  }
  return { werte, oben, label: labels.length ? labels.join(', ') : null, asset }
}

// ── Zeit ─────────────────────────────────────────────────────────────────────

/** Meta-Zeit (ISO mit +0000 oder Unix-Sekunden) -> ISO-String, sonst null. */
export function isoZeit(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim()
    if (/^\d+$/.test(s)) return isoZeit(Number(s))
    const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
    return Number.isFinite(t) ? new Date(t).toISOString() : null
  }
  return null
}

// ── Status, Lernphase, Prüfhinweise ──────────────────────────────────────────

const LERN_LABEL: Record<string, string> = {
  LEARNING: 'Lernphase', SUCCESS: 'Lernphase abgeschlossen', FAIL: 'Lernphase beeinträchtigt',
}

/** learning_stage_info von Meta (oder Spiegel-Spalten) -> LernphaseInfo */
export function lernphase(v: unknown): LernphaseInfo | null {
  const o = obj(v)
  if (!o) return null
  const status = text(o.status)
  return {
    status,
    status_label: status ? LERN_LABEL[status] ?? menschlich(status.toLowerCase()) : null,
    conversions: zahlOderNull(o.conversions),
    last_sig_edit_ts: isoZeit(o.last_sig_edit_ts),
  }
}

/** Spalte „Auslieferung“ wie im Werbeanzeigenmanager. */
export function auslieferung(
  effective: string | null, lernStatus: string | null, start: string | null = null, ende: string | null = null,
  jetzt: number = Date.now(),
): Auslieferung {
  const e = (effective ?? '').toUpperCase()
  const t = (iso: string | null) => (iso ? Date.parse(iso) : NaN)
  switch (e) {
    case 'ACTIVE': {
      if (Number.isFinite(t(ende)) && t(ende) < jetzt) return { key: 'abgeschlossen', label: 'Abgeschlossen', symbol: 'inaktiv' }
      if (Number.isFinite(t(start)) && t(start) > jetzt) return { key: 'geplant', label: 'Geplant', symbol: 'ausstehend' }
      if (lernStatus === 'FAIL') return { key: 'lernphase_beeintraechtigt', label: 'Lernphase beeinträchtigt', symbol: 'warnung' }
      if (lernStatus === 'LEARNING') return { key: 'lernphase', label: 'Lernphase', symbol: 'aktiv' }
      return { key: 'aktiv', label: 'Aktiv', symbol: 'aktiv' }
    }
    case 'PAUSED': return { key: 'aus', label: 'Aus', symbol: 'inaktiv' }
    case 'CAMPAIGN_PAUSED': return { key: 'kampagne_aus', label: 'Kampagne aus', symbol: 'inaktiv' }
    case 'ADSET_PAUSED': return { key: 'anzeigengruppe_aus', label: 'Anzeigengruppe aus', symbol: 'inaktiv' }
    case 'PENDING_REVIEW': return { key: 'wird_ueberprueft', label: 'Wird überprüft', symbol: 'ausstehend' }
    case 'IN_PROCESS': return { key: 'in_bearbeitung', label: 'In Bearbeitung', symbol: 'ausstehend' }
    case 'PREAPPROVED': return { key: 'wird_vorbereitet', label: 'Wird vorbereitet', symbol: 'ausstehend' }
    case 'DISAPPROVED': return { key: 'abgelehnt', label: 'Abgelehnt', symbol: 'fehler' }
    case 'WITH_ISSUES': return { key: 'fehler', label: 'Mit Fehlern', symbol: 'fehler' }
    case 'PENDING_BILLING_INFO': return { key: 'zahlung_fehlt', label: 'Zahlungsinformationen fehlen', symbol: 'fehler' }
    case 'ARCHIVED': return { key: 'archiviert', label: 'Archiviert', symbol: 'inaktiv' }
    case 'DELETED': return { key: 'geloescht', label: 'Gelöscht', symbol: 'inaktiv' }
    case '': return { key: 'unbekannt', label: 'Unbekannt', symbol: 'warnung' }
    default: return { key: e.toLowerCase(), label: menschlich(e.toLowerCase()), symbol: 'warnung' }
  }
}

/** issues_info (Liste) -> MetaIssue[] */
export function issues(v: unknown): MetaIssue[] {
  if (!Array.isArray(v)) return []
  return v.map(x => obj(x)).filter((x): x is Raw => !!x).slice(0, 20).map(o => ({
    code: text(o.error_code),
    summary: text(o.error_summary),
    message: text(o.error_message),
    level: text(o.level),
    type: text(o.error_type),
  }))
}

/** ad_review_feedback ({global:{..}, placement_specific:{..}}) bzw. review_feedback (Text) -> Liste */
export function reviewFeedback(v: unknown): Array<{ bereich: string; text: string }> {
  const out: Array<{ bereich: string; text: string }> = []
  if (typeof v === 'string') {
    if (v.trim()) out.push({ bereich: 'Prüfung', text: v.trim().slice(0, 1000) })
    return out
  }
  const o = obj(v)
  if (!o) return out
  const flach = (bereich: string, w: unknown) => {
    const wo = obj(w)
    if (wo) {
      for (const [k, val] of Object.entries(wo)) {
        const t = text(val) ?? (obj(val) ? JSON.stringify(val) : null)
        if (t) out.push({ bereich, text: `${k}: ${t}`.slice(0, 1000) })
      }
    } else {
      const t = text(w)
      if (t) out.push({ bereich, text: t.slice(0, 1000) })
    }
  }
  for (const [k, w] of Object.entries(o)) {
    if (k === 'global') flach('Allgemein', w)
    else if (k === 'placement_specific' && obj(w)) {
      for (const [p, pw] of Object.entries(obj(w)!)) flach(PLATTFORM[p] ?? menschlich(p), pw)
    } else flach(menschlich(k), w)
  }
  return out.slice(0, 30)
}

// ── Aktivitätenverlauf ───────────────────────────────────────────────────────

/** Meta event_type -> deutsche Bezeichnung (ebenenneutral, die Ebene steht daneben). */
export const EREIGNIS_LABELS: Record<string, string> = {
  ad_account_update_spend_limit: 'Ausgabenlimit des Kontos geändert',
  ad_account_reset_spend_limit: 'Ausgabenlimit des Kontos zurückgesetzt',
  ad_account_remove_spend_limit: 'Ausgabenlimit des Kontos entfernt',
  ad_account_set_business_information: 'Unternehmensangaben geändert',
  ad_account_update_status: 'Kontostatus geändert',
  ad_account_add_user_to_role: 'Person zum Werbekonto hinzugefügt',
  ad_account_remove_user_from_role: 'Person aus dem Werbekonto entfernt',
  ad_account_billing_charge: 'Zahlung belastet',
  ad_account_billing_charge_failed: 'Zahlung fehlgeschlagen',
  ad_account_billing_decline: 'Zahlung abgelehnt',
  ad_account_billing_refund: 'Rückerstattung',
  add_funding_source: 'Zahlungsmethode hinzugefügt',
  remove_funding_source: 'Zahlungsmethode entfernt',
  add_images: 'Bilder hinzugefügt',
  edit_images: 'Bilder bearbeitet',
  create_campaign_group: 'Kampagne erstellt',
  update_campaign_group_spend_cap: 'Ausgabenlimit der Kampagne geändert',
  create_campaign_legacy: 'Erstellt',
  update_campaign_name: 'Name geändert',
  update_campaign_run_status: 'Status geändert',
  update_campaign_budget: 'Budget geändert',
  update_campaign_duration: 'Laufzeit geändert',
  campaign_ended: 'Beendet',
  create_ad_set: 'Anzeigengruppe erstellt',
  update_ad_set_bidding: 'Gebot geändert',
  update_ad_set_bid_strategy: 'Gebotsstrategie geändert',
  update_ad_set_bid_adjustments: 'Gebotsanpassungen geändert',
  update_ad_set_budget: 'Budget geändert',
  update_ad_set_duration: 'Laufzeit geändert',
  update_ad_set_run_status: 'Status geändert',
  update_ad_set_name: 'Name geändert',
  update_ad_set_optimization_goal: 'Optimierungsziel geändert',
  update_ad_set_target_spec: 'Targeting geändert',
  update_ad_set_learning_stage_status: 'Lernphase geändert',
  create_ad: 'Werbeanzeige erstellt',
  ad_review_approved: 'Werbeanzeige genehmigt',
  ad_review_declined: 'Werbeanzeige abgelehnt',
  update_ad_creative: 'Anzeigengestaltung geändert',
  edit_and_update_ad_creative: 'Anzeigengestaltung bearbeitet',
  update_ad_bid_info: 'Gebot geändert',
  update_ad_bid_type: 'Gebotsart geändert',
  update_ad_run_status: 'Status geändert',
  update_ad_run_status_to_be_set_after_review: 'Status nach der Prüfung vorgemerkt',
  update_ad_friendly_name: 'Name geändert',
  update_ad_targets_spec: 'Targeting geändert',
  update_adgroup_stop_delivery: 'Auslieferung gestoppt',
  first_delivery_event: 'Erste Auslieferung',
  create_audience: 'Zielgruppe erstellt',
  update_audience: 'Zielgruppe geändert',
  share_audience: 'Zielgruppe geteilt',
  receive_audience: 'Zielgruppe erhalten',
  unshare_audience: 'Zielgruppe nicht mehr geteilt',
  remove_shared_audience: 'Geteilte Zielgruppe entfernt',
  account_spending_limit_reached: 'Ausgabenlimit des Kontos erreicht',
  campaign_spending_limit_reached: 'Ausgabenlimit der Kampagne erreicht',
  lifetime_budget_spent: 'Laufzeitbudget aufgebraucht',
  update_ad_labels: 'Labels geändert',
}

export function ereignisLabel(eventType: string, uebersetzt: string | null): string {
  return EREIGNIS_LABELS[eventType] ?? uebersetzt ?? menschlich(eventType)
}

export const OBJEKT_LABELS: Record<AktivitaetObjekt, string> = {
  account: 'Werbekonto', campaign: 'Kampagne', adset: 'Anzeigengruppe', ad: 'Werbeanzeige',
  audience: 'Zielgruppe', sonstiges: 'Sonstiges',
}

/**
 * Benennung der object_type-Werte in einer Meta-Antwort: true = Altnamen
 * (CAMPAIGN_GROUP = Kampagne, CAMPAIGN = Anzeigengruppe, ADGROUP = Anzeige),
 * false = neue Namen (AD_SET/ADSET kommt vor), null = nicht erkennbar.
 */
export function altNamenErkennen(objectTypes: Array<string | null>): boolean | null {
  const l = objectTypes.map(t => (t ?? '').toUpperCase())
  if (l.some(t => t === 'CAMPAIGN_GROUP' || t === 'ADGROUP')) return true
  if (l.some(t => t === 'AD_SET' || t === 'ADSET')) return false
  return null
}

/**
 * Objektart aus Meta-Angaben. Achtung Altnamen der API: CAMPAIGN_GROUP = Kampagne,
 * CAMPAIGN = Anzeigengruppe; Ereignisse mit ad_set = Anzeigengruppe. Der Aufrufer
 * löst bekannte IDs vorher über den CRM-Spiegel auf; das hier ist nur der Rückfall.
 * object_type CAMPAIGN ist nur mit erkannter Benennung (altNamen) eindeutig, sonst
 * „sonstiges“ statt zu raten.
 */
export function objektArt(objectType: string | null, eventType: string, altNamen: boolean | null = null): AktivitaetObjekt {
  const ot = (objectType ?? '').toUpperCase()
  const et = eventType.toLowerCase()
  if (ot === 'CAMPAIGN_GROUP' || et.includes('campaign_group')) return 'campaign'
  if (ot === 'AD_SET' || ot === 'ADSET' || et.includes('ad_set')) return 'adset'
  if (ot === 'AD' || ot === 'ADGROUP' || /(^|_)ad_(run|creative|bid|friendly|targets|labels)/.test(et) || et === 'create_ad' || et.startsWith('ad_review')) return 'ad'
  if (ot === 'ACCOUNT' || ot === 'AD_ACCOUNT' || et.startsWith('ad_account') || et.includes('funding') || et.startsWith('account_')) return 'account'
  if (ot.includes('AUDIENCE') || et.includes('audience')) return 'audience'
  if (ot === 'CAMPAIGN') return altNamen === true ? 'adset' : altNamen === false ? 'campaign' : 'sonstiges'
  if (et.includes('campaign')) return 'campaign'
  return 'sonstiges'
}

export function ereignisKategorie(eventType: string, objekt: AktivitaetObjekt): AktivitaetKategorie {
  const et = eventType.toLowerCase()
  if (/budget|spend_cap|spend_limit|spending_limit|budget_spent/.test(et)) return 'Budget'
  if (et.includes('bid')) return 'Gebot'
  if (/run_status|review|stop_delivery|update_status|learning_stage/.test(et)) return 'Status'
  if (/duration|ended|schedule/.test(et)) return 'Zeitplan'
  if (et.includes('target')) return 'Targeting'
  if (et.includes('audience')) return 'Zielgruppe'
  if (et.startsWith('ad_account') || et.includes('funding') || et.includes('billing') || et.startsWith('account_')) return 'Konto'
  switch (objekt) {
    case 'campaign': return 'Kampagnen'
    case 'adset': return 'Anzeigengruppen'
    case 'ad': return 'Werbeanzeigen'
    case 'account': return 'Konto'
    case 'audience': return 'Zielgruppe'
    default: return 'Sonstiges'
  }
}

/** Kategorie für Einträge aus dem eigenen Schreibprotokoll (meta_write_log). */
export function crmKategorie(mode: string, level: AktivitaetObjekt, request: unknown): AktivitaetKategorie {
  const m = mode.toLowerCase()
  const r = obj(request) ?? {}
  if (/budget/.test(m) || 'daily_budget' in r || 'lifetime_budget' in r || 'spend_cap' in r) return 'Budget'
  if ('bid_amount' in r || 'bid_strategy' in r) return 'Gebot'
  if (/pause|activate|aktiv|status/.test(m) || 'status' in r) return 'Status'
  if ('targeting' in r) return 'Targeting'
  if ('end_time' in r || 'start_time' in r || 'stop_time' in r) return 'Zeitplan'
  if (/audience/.test(m)) return 'Zielgruppe'
  return ereignisKategorie('', level)
}

/** Modus aus meta_write_log -> deutsche Bezeichnung */
export const CRM_MODUS_LABELS: Record<string, string> = {
  create: 'Im CRM angelegt', resume: 'Im CRM angelegt (fortgesetzt)', activate_draft: 'Im CRM aktiviert',
  duplicate: 'Im CRM dupliziert', leadform_create: 'Sofortformular angelegt', media_upload: 'Medium hochgeladen',
  edit_apply: 'Im CRM bearbeitet', bulk: 'Massenbearbeitung im CRM', pause: 'Im CRM pausiert',
  activate: 'Im CRM aktiviert', budget_set: 'Budget im CRM geändert', freigabe: 'Autopilot-Vorschlag ausgeführt',
  fenster: 'Autopilot im Änderungsfenster', manuell: 'Vorgemerkte Aktion ausgeführt', capi: 'Conversions API gesendet',
  validate: 'Prüfung bei Meta', preview: 'Vorschau erzeugt',
  // meta-werkzeuge (SPEC2 Vertrag 3)
  audience_create_website: 'Website-Zielgruppe angelegt', audience_create_engagement: 'Interaktions-Zielgruppe angelegt',
  audience_create_lookalike: 'Lookalike-Zielgruppe angelegt', audience_create_customer_list: 'Kundenliste angelegt',
  leadform_duplicate: 'Sofortformular kopiert', custom_conversion_create: 'Eigene Conversion angelegt',
}

export function geaendertVonMeta(actorId: string | null, actorName: string | null, appId: string | null, appName: string | null): GeaendertVon {
  const n = `${actorName ?? ''} ${appName ?? ''}`.toLowerCase()
  if (/automated rule|automatisierte regel|ads rules|rules engine/.test(n)) return 'Automatisierte Regel'
  if (!actorId && !actorName && !appId) return 'Meta'
  if (/^(meta|facebook)$/.test((actorName ?? '').trim().toLowerCase())) return 'Meta'
  if (appId || appName) return 'Business-Identität'
  return 'Person'
}

// ── Empfehlungen (Potenzialbewertung) ────────────────────────────────────────

const KI_HINWEIS = 'Happy-Property-Regel: Advantage+-KI-Funktionen bleiben standardmäßig aus. Nur nach bewusster Entscheidung einschalten.'
const NICHT_RELEVANT = 'Für Happy Property nicht relevant (kein Produktkatalog oder Shop).'
const LEITPLANKE = 'Budget nur innerhalb der Leitplanke (Tageslimit des Kontos) erhöhen; Lernphase beachten.'

export interface EmpfehlungInfo { titel: string; kategorie: EmpfehlungKategorie; hp: string | null }

export const EMPFEHLUNG_INFO: Record<string, EmpfehlungInfo> = {
  ADVANTAGE_PLUS_AUDIENCE: { titel: 'Advantage+ Zielgruppe nutzen', kategorie: 'Zielgruppe', hp: 'Unter der Sonderkategorie Wohnen nur eingeschränkt möglich. Vor Übernahme prüfen.' },
  ADVANTAGE_PLUS_CATALOG_ADS: { titel: 'Advantage+ Katalog-Anzeigen nutzen', kategorie: 'Automatisierte Kampagnen', hp: NICHT_RELEVANT },
  APLUSC_ADD_OVERLAYS: { titel: 'Advantage+ Overlays einschalten', kategorie: 'Anzeigengestaltung und Platzierungen', hp: KI_HINWEIS },
  APLUSC_STANDARD_ENHANCEMENTS_BUNDLE: { titel: 'Advantage+ Standard-Optimierungen einschalten', kategorie: 'Anzeigengestaltung und Platzierungen', hp: KI_HINWEIS },
  APLUSC_TEXT_IMPROVEMENTS: { titel: 'Textoptimierungen einschalten', kategorie: 'Anzeigengestaltung und Platzierungen', hp: KI_HINWEIS },
  APLUSC_VISUAL_TOUCHUPS: { titel: 'Visuelle Optimierungen einschalten', kategorie: 'Anzeigengestaltung und Platzierungen', hp: KI_HINWEIS },
  AUTOFLOW_OPT_IN: { titel: 'Standard-Optimierungen einschalten', kategorie: 'Anzeigengestaltung und Platzierungen', hp: KI_HINWEIS },
  AUTOMATIC_PLACEMENTS: { titel: 'Advantage+ Platzierungen nutzen', kategorie: 'Anzeigengestaltung und Platzierungen', hp: null },
  BACKGROUND_GENERATION: { titel: 'KI-Hintergründe erzeugen', kategorie: 'Anzeigengestaltung und Platzierungen', hp: KI_HINWEIS },
  BUDGET_LIMITED: { titel: 'Budget begrenzt die Ergebnisse', kategorie: 'Budget und Gebote', hp: LEITPLANKE },
  CAPI_CRM_SETUP: { titel: 'CRM über die Conversions API anbinden', kategorie: 'Signale', hp: null },
  CONVERSION_LEADS_OPTIMIZATION: { titel: 'Auf Conversion-Leads optimieren', kategorie: 'Zielsetzung und Ziele', hp: null },
  CREATIVE_FATIGUE: { titel: 'Werbemittel abgenutzt', kategorie: 'Anzeigengestaltung und Platzierungen', hp: 'Ersatz lieber aus dem eigenen Vorrat als KI-Varianten von Meta.' },
  CREATIVE_LIMITED: { titel: 'Zu wenige Werbemittel', kategorie: 'Anzeigengestaltung und Platzierungen', hp: 'Ersatz lieber aus dem eigenen Vorrat als KI-Varianten von Meta.' },
  CTX_CREATION_PACKAGE: { titel: 'Click-to-Messenger-Paket', kategorie: 'Sonstiges', hp: null },
  GEN_AI_MVP: { titel: 'KI-generierte Varianten', kategorie: 'Anzeigengestaltung und Platzierungen', hp: KI_HINWEIS },
  LANDING_PAGE_VIEW_OPTIMIZATION_GOAL: { titel: 'Auf Zielseitenaufrufe optimieren', kategorie: 'Zielsetzung und Ziele', hp: null },
  MESSAGING_EVENTS: { titel: 'Nachrichten-Ereignisse nutzen', kategorie: 'Sonstiges', hp: null },
  MESSAGING_PARTNERS: { titel: 'Messaging-Partner nutzen', kategorie: 'Sonstiges', hp: null },
  MULTI_TEXT: { titel: 'Mehrere Textoptionen hinterlegen', kategorie: 'Anzeigengestaltung und Platzierungen', hp: null },
  MUSIC: { titel: 'Automatisch Musik hinzufügen', kategorie: 'Anzeigengestaltung und Platzierungen', hp: KI_HINWEIS },
  OFFSITE_CONVERSION: { titel: 'Auf Conversions optimieren', kategorie: 'Zielsetzung und Ziele', hp: null },
  PARTNERSHIP_ADS: { titel: 'Partnerschaftsanzeige ergänzen', kategorie: 'Anzeigengestaltung und Platzierungen', hp: null },
  PERFORMANT_CREATIVE_REELS_OPT_IN: { titel: 'Reels-Platzierungen ergänzen', kategorie: 'Anzeigengestaltung und Platzierungen', hp: null },
  PIXEL_OPTIMIZATION_HIE: { titel: 'Pixel: Ereignisse mit hoher Absicht senden', kategorie: 'Signale', hp: null },
  PIXEL_UPSELL: { titel: 'Meta-Pixel verbinden', kategorie: 'Signale', hp: null },
  PRODUCT_SET_BOOSTING: { titel: 'Produktset erweitern', kategorie: 'Automatisierte Kampagnen', hp: NICHT_RELEVANT },
  SCALE_GOOD_CAMPAIGN: { titel: 'Erfolgreiche Kampagne skalieren', kategorie: 'Budget und Gebote', hp: LEITPLANKE },
  SHOPS_ADS_SAOFF: { titel: 'Website und Shop als Conversion-Ort', kategorie: 'Sonstiges', hp: NICHT_RELEVANT },
  UNCROP_IMAGE: { titel: 'Bilder automatisch erweitern', kategorie: 'Anzeigengestaltung und Platzierungen', hp: KI_HINWEIS },
  UNIFIED_INBOX: { titel: 'Nachrichten schneller beantworten', kategorie: 'Sonstiges', hp: null },
  VALUE_OPTIMIZATION_GOAL: { titel: 'Auf Conversion-Wert optimieren', kategorie: 'Zielsetzung und Ziele', hp: null },
  WA_MESSAGING_PARTNERS: { titel: 'WhatsApp-Partner nutzen', kategorie: 'Sonstiges', hp: null },
  FRAGMENTATION: { titel: 'Zielgruppen-Fragmentierung', kategorie: 'Zielgruppe', hp: 'Lernphase beachten: Zusammenlegen startet die Lernphase neu.' },
}

export function empfehlungInfo(typ: string): EmpfehlungInfo {
  const k = typ.trim().toUpperCase()
  const info = EMPFEHLUNG_INFO[k]
  if (info) return info
  if (/RECOMMENDATION$/.test(k) && /REELS|PC_/.test(k)) return { titel: 'Reels-Formate nutzen', kategorie: 'Anzeigengestaltung und Platzierungen', hp: null }
  if (/AUDIENCE|FRAGMENT|OVERLAP/.test(k)) return { titel: menschlich(typ.toLowerCase()), kategorie: 'Zielgruppe', hp: null }
  if (/BUDGET|BID|SCALE/.test(k)) return { titel: menschlich(typ.toLowerCase()), kategorie: 'Budget und Gebote', hp: LEITPLANKE }
  if (/PIXEL|CAPI|SIGNAL/.test(k)) return { titel: menschlich(typ.toLowerCase()), kategorie: 'Signale', hp: null }
  if (/CREATIVE|MUSIC|IMAGE|VIDEO|TEXT|APLUSC|GEN_AI/.test(k)) return { titel: menschlich(typ.toLowerCase()), kategorie: 'Anzeigengestaltung und Platzierungen', hp: null }
  return { titel: menschlich(typ.toLowerCase()), kategorie: 'Sonstiges', hp: null }
}
