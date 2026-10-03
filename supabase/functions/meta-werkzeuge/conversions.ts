// meta-werkzeuge: benutzerdefinierte Conversions.
//   custom_conversions_list   Liste mit Kategorie, Pixel, Ereignis, Regel in Deutsch, Standardwert,
//                             letzter Aktivität + HP-Vorschläge (nur fehlende Ereignisse)
//   custom_conversion_create  Pixel-Ereignis und/oder URL-Regel -> act_X/customconversions
//                             (höchstens 100 aktive je Konto; gleicher Name wird abgelehnt,
//                             damit ein Doppelklick keine Dublette erzeugt; gleiche Regel = Hinweis)
// Die Pixel-Diagnose (pixel_diagnose) steht in ./diagnose.ts.
//
// Härtung (SPEC3 G2): Ereignisnamen auch als CRM-Stufe („Termin gebucht“), zu allgemeine
// URL-Regeln („/“, „https“) abgelehnt, doppelte URL-Regeln zusammengefasst, ungültiger
// Standardwert ist ein Fehler statt still ignoriert, Kategorie passt nicht zum Ereignis =
// Hinweis, Gedankenstriche im Namen werden zu Bindestrichen.

import { graphAll } from '../_shared/metaGraph.ts'
import {
  arr, cleanText, isoZeit, metaId, metaPost, name200, num, obj, pruefePixel, softMsg, str, uniq, WerkzeugError,
  type Ctx, type Raw,
} from './common.ts'
import {
  CRM_STUFEN, CUSTOM_CONVERSION_VORSCHLAEGE, CUSTOM_CONVERSIONS_MAX, CUSTOM_EVENT_TYPE_LABEL, CUSTOM_EVENT_TYPES,
  type CustomConversionCreateRequest, type CustomConversionCreateResponse, type CustomConversionsListRequest,
  type CustomConversionsListResponse, type CustomConversionZeile, type CustomEventType,
} from './typen.ts'
import { regelZusammenfassung } from './zielgruppen.ts'

const EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,49}$/
/** CRM-Stufen (Conversion-Leads) haben Leerzeichen und Umlaute im Namen; sie sind ausdrücklich erlaubt */
const CRM_EREIGNISSE: readonly string[] = CRM_STUFEN.map(s => s.ereignis)
const DASH_RE = /[\u2012-\u2015]/g
/** URL-Teile, die praktisch jede Seite treffen (Tippfehler-Schutz) */
const ZU_ALLGEMEIN = ['/', 'http', 'https', 'http://', 'https://', 'www', 'www.', '.de', '.com', 'html']

/** Welche Kategorie zu welchem Standard-Ereignis passt (nur für einen Hinweis) */
const KATEGORIE_ZU_EREIGNIS: Readonly<Record<string, CustomEventType>> = {
  Lead: 'LEAD', QualifiedLead: 'LEAD', Schedule: 'SCHEDULE', Purchase: 'PURCHASE', CompleteRegistration: 'COMPLETE_REGISTRATION',
  Contact: 'CONTACT', SubmitApplication: 'SUBMIT_APPLICATION', ViewContent: 'CONTENT_VIEW', Subscribe: 'SUBSCRIBE', Search: 'SEARCH',
}

// ── Regel lesen ──────────────────────────────────────────────────────────────

/** Ereignisname aus einer Conversion-Regel ({"and":[{"event":{"eq":"Lead"}}, ...]}), sonst null. */
export function ereignisAusRegel(rule: unknown): string | null {
  let r: unknown = rule
  if (typeof rule === 'string') {
    try { r = JSON.parse(rule) } catch { return null }
  }
  const suche = (v: unknown, tiefe: number): string | null => {
    if (tiefe > 6) return null
    if (Array.isArray(v)) {
      for (const x of v) { const t = suche(x, tiefe + 1); if (t) return t }
      return null
    }
    const o = obj(v)
    const ev = obj(o.event)
    const wert = str(ev.eq) || str(ev.i_eq) || str(ev['='])
    if (wert) return wert
    for (const k of ['and', 'or']) {
      if (Array.isArray(o[k])) { const t = suche(o[k], tiefe + 1); if (t) return t }
    }
    return null
  }
  return suche(r, 0)
}

/** Vergleichbare Form einer Regel (für den Hinweis „gleiche Regel gibt es schon“) */
function regelSchluessel(rule: unknown): string {
  let r: unknown = rule
  if (typeof rule === 'string') {
    try { r = JSON.parse(rule) } catch { return rule.replace(/\s+/g, '') }
  }
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm).map(x => JSON.stringify(x)).sort()
    if (v && typeof v === 'object') {
      const o = v as Raw
      return Object.keys(o).sort().reduce<Raw>((acc, k) => { acc[k] = norm(o[k]); return acc }, {})
    }
    return typeof v === 'string' ? v.trim().toLowerCase() : v
  }
  return JSON.stringify(norm(r))
}

// ── custom_conversions_list ──────────────────────────────────────────────────

const CC_FELDER = [
  'id,name,custom_event_type,rule,pixel{id},last_fired_time,is_archived,is_unavailable,creation_time,description,default_conversion_value',
  'id,name,custom_event_type,rule,pixel{id},last_fired_time,is_archived,is_unavailable,creation_time,description',
  'id,name,custom_event_type,rule,is_archived',
]

async function conversionsLaden(account: string, warnings: string[]): Promise<Raw[]> {
  let letzter: unknown = null
  for (const [i, fields] of CC_FELDER.entries()) {
    try {
      const list = await graphAll<Raw>(`act_${account}/customconversions`, { fields, limit: 100 }, { maxPages: 3 })
      if (i === CC_FELDER.length - 1) warnings.push('Conversions nur mit Grunddaten geladen.')
      return list
    } catch (e) {
      letzter = e
    }
  }
  throw letzter
}

function zeile(c: Raw): CustomConversionZeile {
  const regel = c.rule !== undefined && c.rule !== null && str(c.rule) !== '' ? regelZusammenfassung(c.rule).text : ''
  const wert = num(c.default_conversion_value)
  return {
    id: str(c.id),
    name: str(c.name),
    kategorie: str(c.custom_event_type) || null,
    pixel_id: str(obj(c.pixel).id) || null,
    regel_zusammenfassung: regel || 'Keine Regel lesbar',
    ereignis: c.rule !== undefined && c.rule !== null ? ereignisAusRegel(c.rule) : null,
    standardwert: wert !== null && wert > 0 ? wert : null,
    letzte_aktivitaet: isoZeit(c.last_fired_time),
    archiviert: c.is_archived === true,
    nicht_verfuegbar: c.is_unavailable === true,
    erstellt: isoZeit(c.creation_time),
  }
}

export async function modeCustomConversionsList(ctx: Ctx, req: CustomConversionsListRequest): Promise<CustomConversionsListResponse> {
  const warnings: string[] = []
  const list = (await conversionsLaden(ctx.env.account, warnings)).filter(c => str(c.id)).map(zeile)
  const aktiv = list.filter(c => !c.archiviert)
  const vorhanden = new Set(aktiv.map(c => (c.ereignis ?? '').toLowerCase()).filter(Boolean))
  return {
    items: req.mit_archivierten === true ? list : aktiv,
    anzahl_aktiv: aktiv.length,
    max: CUSTOM_CONVERSIONS_MAX,
    vorschlaege: CUSTOM_CONVERSION_VORSCHLAEGE.filter(v => !vorhanden.has(v.ereignis.toLowerCase())),
    warnings,
  }
}

// ── custom_conversion_create ─────────────────────────────────────────────────

export async function modeCustomConversionCreate(ctx: Ctx, req: CustomConversionCreateRequest): Promise<CustomConversionCreateResponse> {
  const name = name200(str(req.name).replace(DASH_RE, '-'))
  const st = await ctx.settings()
  const pixelId = metaId(req.pixel_id ?? st.default_pixel_id, 'pixel_id')
  const kategorie = str(req.kategorie)
  if ((CUSTOM_EVENT_TYPES as readonly string[]).indexOf(kategorie) < 0) {
    throw new WerkzeugError(400, 'invalid_request', 'kategorie fehlt oder ist unbekannt.', `Erlaubt: ${CUSTOM_EVENT_TYPES.join(', ')}`)
  }
  // event: Alias aus dem SPEC2-Vertrag
  const ereignis = (str(req.ereignis).trim() || str(req.event).trim())
  if (ereignis && !EVENT_RE.test(ereignis) && CRM_EREIGNISSE.indexOf(ereignis) < 0) {
    throw new WerkzeugError(400, 'invalid_request', 'Ereignisname nur aus Buchstaben, Ziffern und _ (z. B. Lead, QualifiedLead) oder eine CRM-Stufe.',
      `CRM-Stufen: ${CRM_EREIGNISSE.join(', ')}`)
  }
  const urls = arr<{ art?: string; wert?: string }>(req.url_regeln)
  if (urls.length > 10) throw new WerkzeugError(400, 'invalid_request', 'Höchstens 10 URL-Regeln.')
  const urlTeile = urls.map((u, i) => {
    const wert = str(u?.wert).trim()
    if (!wert || wert.length > 300 || /\s/.test(wert)) throw new WerkzeugError(400, 'invalid_request', `URL-Regel ${i + 1}: Wert ohne Leerzeichen angeben (höchstens 300 Zeichen).`)
    if (u?.art === 'url_enthaelt') {
      if (wert.length < 3 || ZU_ALLGEMEIN.indexOf(wert.toLowerCase()) >= 0) {
        throw new WerkzeugError(400, 'invalid_request', `URL-Regel ${i + 1}: „${wert}“ trifft fast jede Seite.`, 'Einen eindeutigen Teil der Adresse angeben, z. B. /termin/danke.')
      }
      return { url: { i_contains: wert } }
    }
    if (u?.art === 'url_gleich') {
      if (!/^https?:\/\/[^\s/?#]+\.[^\s]+$/i.test(wert)) throw new WerkzeugError(400, 'invalid_request', `URL-Regel ${i + 1}: vollständige Adresse mit https:// angeben.`)
      return { url: { eq: wert } }
    }
    throw new WerkzeugError(400, 'invalid_request', `URL-Regel ${i + 1}: art url_enthaelt oder url_gleich.`)
  })
  // doppelte URL-Regeln (Doppelklick im Formular) zusammenfassen
  const urlEindeutig = uniq(urlTeile.map(t => JSON.stringify(t))).map(t => JSON.parse(t) as Raw)
  if (!ereignis && !urlEindeutig.length) throw new WerkzeugError(400, 'invalid_request', 'Ereignis oder mindestens eine URL-Regel angeben.')
  const rule: Raw = ereignis
    ? { and: [{ event: { eq: ereignis } }, ...(urlEindeutig.length ? [{ or: urlEindeutig }] : [])] }
    : { or: urlEindeutig }
  let wert: number | null = null
  if (req.standardwert !== undefined && req.standardwert !== null && str(req.standardwert) !== '') {
    wert = num(req.standardwert)
    if (wert === null || wert < 0 || wert > 1_000_000) throw new WerkzeugError(400, 'invalid_request', 'standardwert: Zahl von 0 bis 1.000.000.')
    if (wert === 0) wert = null
  }

  const body: Raw = {
    name,
    event_source_id: pixelId,
    rule: JSON.stringify(rule),
    custom_event_type: kategorie,
    description: cleanText(str(req.beschreibung).replace(DASH_RE, '-'), 400) || `HP-Werbemanager: ${regelZusammenfassung(rule).text}`.slice(0, 400),
    ...(wert !== null ? { default_conversion_value: wert } : {}),
  }
  const hinweise: string[] = []
  if (ereignis && !urlEindeutig.length) hinweise.push(`Zählt jedes Pixel-Ereignis „${ereignis}“. Kommt es auch per Conversions API, wird es über event_id entdoppelt.`)
  if (urlEindeutig.length < urlTeile.length) hinweise.push('Doppelte URL-Regeln wurden zusammengefasst.')
  const passend = ereignis ? KATEGORIE_ZU_EREIGNIS[ereignis] : undefined
  if (passend && passend !== kategorie) {
    hinweise.push(`Kategorie „${CUSTOM_EVENT_TYPE_LABEL[kategorie as CustomEventType] ?? kategorie}“ passt nicht zum Ereignis „${ereignis}“ (üblich: „${CUSTOM_EVENT_TYPE_LABEL[passend]}“). Meta berichtet die Conversion unter der Kategorie.`)
  }
  if (ereignis && CRM_EREIGNISSE.indexOf(ereignis) >= 0) {
    hinweise.push('CRM-Stufen kommen nur über die Conversions API für CRM. Für Sofortformulare ist das Ziel „Anzahl qualifizierter Leads maximieren“ meist der bessere Weg als eine eigene Conversion.')
  }
  if (wert !== null) hinweise.push('Der Standardwert gilt in der Kontowährung des Werbekontos.')
  if (req.vorschau === true) return { vorschau: true, conversion_id: null, payload: body, hinweise }

  await pruefePixel(ctx, pixelId, hinweise)
  // Limit 100, Doppelklick-Schutz (gleicher Name) und Hinweis bei gleicher Regel
  try {
    const list = await graphAll<Raw>(`act_${ctx.env.account}/customconversions`, { fields: 'id,name,rule,is_archived', limit: 100 }, { maxPages: 3, strict: true })
    const aktiv = list.filter(c => c.is_archived !== true)
    if (aktiv.length >= CUSTOM_CONVERSIONS_MAX) {
      throw new WerkzeugError(422, 'limit_reached', `Das Werbekonto hat schon ${CUSTOM_CONVERSIONS_MAX} benutzerdefinierte Conversions (Meta-Grenze).`,
        'Nicht mehr genutzte Conversions im Events Manager archivieren (bewusst nicht aus dem CRM).')
    }
    const gleich = aktiv.find(c => str(c.name).trim().toLowerCase() === name.toLowerCase())
    if (gleich) {
      throw new WerkzeugError(409, 'invalid_request', `Es gibt schon eine Conversion „${name}“ (ID ${str(gleich.id)}).`, 'Anderen Namen wählen oder die vorhandene nutzen.')
    }
    const schluessel = regelSchluessel(rule)
    const gleicheRegel = aktiv.find(c => c.rule !== undefined && c.rule !== null && regelSchluessel(c.rule) === schluessel)
    if (gleicheRegel) hinweise.push(`Die gleiche Regel gibt es schon als „${str(gleicheRegel.name)}“ (ID ${str(gleicheRegel.id)}).`)
  } catch (e) {
    if (e instanceof WerkzeugError) throw e
    hinweise.push(`Vorhandene Conversions nicht vollständig lesbar (${softMsg(e)}); Grenze und Dubletten nicht geprüft.`)
  }

  const res = await metaPost(ctx, `act_${ctx.env.account}/customconversions`, body, { level: 'custom_conversion' })
  const id = str(res.id)
  if (!id) throw new WerkzeugError(502, 'meta_error', 'Meta hat keine Conversion-ID zurückgegeben.')
  hinweise.push('Die Conversion erscheint als Optimierungs-Ereignis, sobald Meta sie einmal empfangen hat.')
  return { vorschau: false, conversion_id: id, payload: body, hinweise }
}
