import type { TFunction } from 'i18next'
import { supabase } from '../../../../lib/supabase'
import { fnErrorDetail, type FnErrorDetail } from '../../../../lib/fnError'
import { USD_PRO_EUR_FALLBACK } from '../felder'
import type {
  Aktivitaet, Aufschluesselung, BasisFeld, BerichtZeile, Ebene, Empfehlung, EmpfehlungenAntwort, InsightsAnfrage,
  InsightsAntwort, LiveStatus, Werte,
} from './typen'

// ── Aufrufe der Edge Function meta-berichte (nur lesen) ──────────────────────
// Modi insights, activities, status (SPEC2 §2). Alles auf Knopfdruck, einzeln
// nacheinander (Rate-Limit „Limited access"), der Server hält einen
// Zwischenspeicher. Die Antwortzeilen werden hier tolerant normalisiert: der
// Server liefert normalisierte Zahlen; rohe Meta-Felder (actions-Listen,
// Zahlen als Text) werden zur Sicherheit ebenfalls verstanden.

const FN = 'meta-berichte'
const NETZ_FEHLER = /Failed to send|Failed to fetch|NetworkError|Load failed/i
const warte = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export class BerichteFehler extends Error {
  code?: string
  hint?: string
  /** HTTP-Status der Antwort (404 = Funktion nicht deployt) */
  status?: number
  constructor(d: FnErrorDetail, status?: number) {
    super(d.message)
    this.name = 'BerichteFehler'
    this.code = d.code
    this.hint = d.hint
    this.status = status
  }
}

/** HTTP-Status aus einem Invoke-Fehler (FunctionsHttpError.context ist die Response) */
function httpStatus(error: unknown): number | undefined {
  const ctx = error && typeof error === 'object' ? (error as { context?: unknown }).context : undefined
  const st = ctx && typeof ctx === 'object' ? (ctx as { status?: unknown }).status : undefined
  return typeof st === 'number' ? st : undefined
}

async function aufruf(fn: string, body: Record<string, unknown>, retried = false): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke(fn, { body })
  if (error) {
    if (!retried && NETZ_FEHLER.test(error.message ?? '')) {
      await warte(1500)
      return aufruf(fn, body, true)
    }
    throw new BerichteFehler(await fnErrorDetail(error), httpStatus(error))
  }
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  if (typeof d.error === 'string' && d.error) {
    throw new BerichteFehler({
      message: d.error,
      ...(typeof d.hint === 'string' && d.hint ? { hint: d.hint } : {}),
      ...(typeof d.code === 'string' || typeof d.code === 'number' ? { code: String(d.code) } : {}),
    })
  }
  return d
}

/** Verständlicher deutscher Fehlertext für Toasts und Hinweise */
export function berichteFehlerText(e: unknown, t: TFunction): string {
  const code = e instanceof BerichteFehler ? e.code : undefined
  const status = e instanceof BerichteFehler ? e.status : undefined
  const msg = e instanceof Error ? e.message : String(e ?? '')
  if (code === 'forbidden') return t('crm.werbung.zentrale.fehler.recht', 'Dafür fehlt dir das Recht (Werbung).')
  if (code === 'rate_limited' || /rate.?limit|zu viele/i.test(msg)) {
    return t('crm.werbung.zentrale.fehler.rate', 'Meta bremst gerade (zu viele Abfragen). Bitte in ein paar Minuten noch einmal.')
  }
  // Funktion nicht deployt: das Gateway antwortet 404 mit {code:'NOT_FOUND', message}
  // (ohne eigenes error-Feld); meta-berichte selbst nutzt nur kleingeschriebene Codes
  if (code === 'NOT_FOUND' || (status === 404 && !code) || (/not.?found|404|Requested function/i.test(msg) && !code)) {
    return t('crm.werbung.zentrale.fehler.fehltFunktion', 'Die Berichte-Funktion ist noch nicht live. Die Zahlen aus der Datenbank stehen weiter zur Verfügung.')
  }
  if (NETZ_FEHLER.test(msg)) {
    return t('crm.werbung.zentrale.fehler.netz', 'Der Aufruf kam nicht am Server an. Internet prüfen und ggf. den Werbeblocker für diese Seite ausschalten.')
  }
  const hint = e instanceof BerichteFehler && e.hint ? ` ${e.hint}` : ''
  const text = (msg || t('crm.werbung.zentrale.fehler.allgemein', 'Das hat nicht geklappt.')) + hint
  return text.length > 300 ? `${text.slice(0, 297)}...` : text
}

// ── Zahlen lesen ─────────────────────────────────────────────────────────────

/** Zahl aus Meta-Werten: Zahl, Text oder Liste [{action_type, value}] (Summe) */
function zahlAus(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') { const x = Number(v); return Number.isFinite(x) ? x : undefined }
  if (Array.isArray(v)) {
    let s = 0, ok = false
    for (const it of v) {
      const x = zahlAus(it && typeof it === 'object' ? (it as Record<string, unknown>).value : it)
      if (x !== undefined) { s += x; ok = true }
    }
    return ok ? s : undefined
  }
  return undefined
}

/** Feldnamen, unter denen der Server (oder Meta roh) eine Kennzahl liefert */
const ALIAS: Array<[BasisFeld, string[]]> = [
  ['ausgaben', ['spend_eur']],
  ['impressionen', ['impressions', 'impressionen']],
  ['reichweite', ['reach', 'reichweite']],
  ['link_klicks', ['link_click', 'link_clicks', 'inline_link_clicks']],
  ['klicks_alle', ['clicks', 'clicks_all']],
  ['ausgehende_klicks', ['outbound_click', 'outbound_clicks']],
  ['lpv', ['landing_page_view', 'landing_page_views', 'lpv']],
  ['meta_leads', ['leads', 'platform_leads']],
  ['ergebnisse', ['results', 'ergebnisse']],
  ['termine_meta', ['schedule', 'schedules', 'platform_schedules']],
  ['video_3s', ['video_view', 'video_3s', 'video_views']],
  ['thruplays', ['thruplay', 'thruplays', 'video_thruplay_watched_actions']],
  ['video_25', ['video_p25', 'video_p25_watched_actions']],
  ['video_50', ['video_p50', 'video_p50_watched_actions']],
  ['video_75', ['video_p75', 'video_p75_watched_actions']],
  ['video_95', ['video_p95', 'video_p95_watched_actions']],
  ['video_100', ['video_p100', 'video_p100_watched_actions']],
  ['beitrags_interaktionen', ['post_engagement', 'post_engagements']],
  ['reaktionen', ['post_reactions', 'reactions']],
  ['kommentare', ['post_comments', 'comments']],
  ['geteilt', ['post_shares', 'shares']],
  ['gespeichert', ['post_saves', 'saves']],
]

/** actions (Server: Objekt action_type -> Zahl; Meta roh: Liste [{action_type, value}]) -> Kennzahl */
const AKTIONEN: Array<[BasisFeld, string[]]> = [
  ['meta_leads', ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']],
  ['lpv', ['landing_page_view']],
  ['link_klicks', ['link_click']],
  ['video_3s', ['video_view']],
  ['beitrags_interaktionen', ['post_engagement']],
  ['reaktionen', ['post_reaction']],
  ['kommentare', ['comment']],
  ['geteilt', ['post']],
  ['gespeichert', ['onsite_conversion.post_save']],
  ['termine_meta', ['schedule_total', 'schedule_website', 'offsite_conversion.fb_pixel_schedule']],
]

/** Kennzahlen einer Antwortzeile (kurs = USD je EUR, falls nur spend in USD kommt) */
export function werteAusZeile(r: Record<string, unknown>, kurs: number): Werte {
  const w: Werte = {}
  for (const [ziel, namen] of ALIAS) {
    for (const nm of namen) {
      const x = zahlAus(r[nm])
      if (x !== undefined) { w[ziel] = x; break }
    }
  }
  // Geld: spend_eur bevorzugt, sonst spend (USD) mit dem Kurs umrechnen
  if (w.ausgaben === undefined) {
    const usd = zahlAus(r.spend)
    if (usd !== undefined) w.ausgaben = usd / (kurs > 0 ? kurs : USD_PRO_EUR_FALLBACK)
  }
  // actions: Server liefert ein Objekt {action_type: Zahl}, Meta roh eine Liste
  const aktion = (typ: string): number | undefined => {
    const a = r.actions
    if (Array.isArray(a)) {
      const x = (a as Array<Record<string, unknown>>).find(y => y && y.action_type === typ)
      return x ? zahlAus(x.value) : undefined
    }
    if (a && typeof a === 'object') return zahlAus((a as Record<string, unknown>)[typ])
    return undefined
  }
  if (r.actions) {
    for (const [ziel, typen] of AKTIONEN) {
      if (w[ziel] !== undefined) continue
      // je Ziel nur den ersten vorhandenen Typ zählen (Meta liefert Leads mehrfach gruppiert)
      for (const typ of typen) {
        const v = aktion(typ)
        if (v !== undefined) { w[ziel] = v; break }
      }
    }
  }
  return w
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)

const objekt = (v: unknown): Record<string, unknown> | null =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)

/** Wert der Aufschlüsselung einer Zeile. Server: breakdown {age: '25-34', ...}
 *  und bei Varianten asset {text, name, url, thumbnail_url, id}. Meta roh: Feld
 *  direkt an der Zeile, Varianten als Objekt. */
export function schluesselAus(r: Record<string, unknown>, b: string | null): { schluessel: string | null; bild: string | null } {
  if (!b) return { schluessel: null, bild: null }
  const asset = objekt(r.asset)
  const roh = objekt(r.breakdown)?.[b] ?? objekt(r.breakdowns)?.[b] ?? r[b]
  const o = asset ?? objekt(roh)
  if (o) {
    const s = text(o.text) ?? text(o.name) ?? text(o.title) ?? text(o.video_name) ?? text(o.hash) ?? text(o.id) ?? text(roh)
    const bild = text(o.thumbnail_url) ?? text(o.url) ?? text(o.image_url)
    return { schluessel: s, bild }
  }
  return { schluessel: text(roh) ?? text(r.breakdown_label), bild: null }
}

function zeileAus(r: Record<string, unknown>, level: Ebene, kurs: number, b: string | null): BerichtZeile {
  const idFeld = level === 'campaign' ? 'campaign_id' : level === 'adset' ? 'adset_id' : 'ad_id'
  const nameFeld = level === 'campaign' ? 'campaign_name' : level === 'adset' ? 'adset_name' : 'ad_name'
  const { schluessel, bild } = schluesselAus(r, b)
  return {
    id: text(r[idFeld]) ?? text(r.id) ?? '',
    campaign_id: text(r.campaign_id),
    adset_id: text(r.adset_id),
    ad_id: text(r.ad_id),
    name: text(r[nameFeld]) ?? text(r.name),
    date_start: text(r.date_start),
    date_stop: text(r.date_stop),
    schluessel,
    plattform: text(objekt(r.breakdown)?.publisher_platform) ?? text(r.publisher_platform),
    beschriftung: text(r.breakdown_label),
    bild,
    werte: werteAusZeile(r, kurs),
  }
}

const liste = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []

/** insights: Zahlen je Kampagne/Anzeigengruppe/Anzeige, optional aufgeschlüsselt und mit Vergleich */
export async function ladeInsights(req: InsightsAnfrage, kurs: number): Promise<InsightsAntwort> {
  const d = await aufruf(FN, { mode: 'insights', ...req })
  const b = req.breakdowns?.[0] ?? null
  const rows = liste(d.rows).map(r => zeileAus(r, req.level, kurs, b))
  const cmp = d.compare_rows == null ? null : liste(d.compare_rows).map(r => zeileAus(r, req.level, kurs, b))
  return {
    rows,
    compare_rows: cmp,
    cached: d.cached === true,
    fetched_at: text(d.fetched_at),
    unvollstaendig: d.unvollstaendig === true,
    veraltet: d.veraltet === true,
    hinweise: Array.isArray(d.hinweise) ? (d.hinweise as unknown[]).map(x => text(x)).filter((x): x is string => !!x) : [],
  }
}

/** status: Auslieferung + Lernphase live von Meta (je Aufruf höchstens 50 IDs) */
export async function ladeStatus(ids: string[]): Promise<LiveStatus[]> {
  const out: LiveStatus[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const d = await aufruf(FN, { mode: 'status', ids: ids.slice(i, i + 50) })
    for (const r of liste(d.items)) {
      const id = text(r.id)
      if (!id) continue
      const l = r.learning && typeof r.learning === 'object' ? r.learning as Record<string, unknown> : null
      out.push({
        id,
        effective_status: text(r.effective_status),
        configured_status: text(r.configured_status),
        learning: l ? {
          status: text(l.status),
          conversions: zahlAus(l.conversions) ?? null,
          last_sig_edit_ts: text(l.last_sig_edit_ts),
        } : null,
        issues: r.issues ?? null,
        review_feedback: r.review_feedback ?? null,
      })
    }
  }
  return out
}

/** activities: Meta-Aktivitätenverlauf + eigenes Schreibprotokoll */
export async function ladeAktivitaeten(req: { since: string; until: string; object_id?: string; frisch?: boolean }): Promise<Aktivitaet[]> {
  const d = await aufruf(FN, { mode: 'activities', ...req })
  return liste(d.items).map(r => ({
    ts: text(r.ts) ?? '',
    actor: text(r.actor) ?? '',
    object_type: text(r.object_type) ?? '',
    object_id: text(r.object_id) ?? '',
    object_name: text(r.object_name) ?? '',
    event: text(r.event) ?? '',
    extra: r.extra ?? null,
    quelle: text(r.quelle) ?? text(r.source),
    event_type: text(r.event_type),
    kategorie: text(r.kategorie),
    geaendert_von: text(r.geaendert_von),
  })).sort((a, b) => b.ts.localeCompare(a.ts))
}

/** empfehlungen: Potenzialbewertung und Metas Empfehlungen (nur lesen, das CRM wendet nichts an) */
export async function ladeEmpfehlungen(frisch = false): Promise<EmpfehlungenAntwort> {
  const d = await aufruf(FN, { mode: 'empfehlungen', ...(frisch ? { frisch: true } : {}) })
  const score = zahlAus(d.opportunity_score)
  const items: Empfehlung[] = liste(d.items).map(r => {
    const url = text(r.url)
    return {
      signatur: text(r.signatur),
      typ: text(r.typ) ?? '',
      titel: text(r.titel) ?? text(r.typ) ?? '',
      kategorie: text(r.kategorie) ?? 'Sonstiges',
      object_ids: Array.isArray(r.object_ids) ? (r.object_ids as unknown[]).map(x => text(x)).filter((x): x is string => !!x) : [],
      lift_estimate: text(r.lift_estimate),
      text: text(r.text),
      punkte: zahlAus(r.punkte) ?? null,
      // Nur Links in den Werbeanzeigenmanager (der Server prüft das auch)
      url: url && /^https:\/\/([a-z0-9-]+\.)*(facebook|meta)\.com\//i.test(url) ? url : null,
      hp_hinweis: text(r.hp_hinweis),
    }
  })
  return {
    opportunity_score: score ?? null,
    items,
    cached: d.cached === true,
    fetched_at: text(d.fetched_at),
    veraltet: d.veraltet === true,
    hinweise: Array.isArray(d.hinweise) ? (d.hinweise as unknown[]).map(x => text(x)).filter((x): x is string => !!x) : [],
  }
}

/** Aufschlüsselungen, die eine Varianten-Auswertung („welche Variante gewinnt") erlauben */
export const VARIANTEN: Aufschluesselung[] = ['body_asset', 'title_asset', 'image_asset', 'video_asset']
