// meta-werkzeuge: benutzerdefinierte Conversions und Pixel-Diagnose.
//   custom_conversions_list   Liste mit Kategorie, Pixel, Regel in Deutsch, letzter Aktivität
//   custom_conversion_create  Pixel-Ereignis und/oder URL-Regel -> act_X/customconversions
//                             (höchstens 100 aktive je Konto; gleicher Name wird abgelehnt,
//                             damit ein Doppelklick keine Dublette erzeugt)
//   pixel_diagnose            letzter Empfang, Ereignisse 24 h, Datensatzqualität (EMQ),
//                             Ampel mit Hinweisen; jede Teilabfrage darf scheitern

import { graphAll, graphGet } from '../_shared/metaGraph.ts'
import {
  arr, auslastungHoch, cleanText, HP_PIXEL_ID, isoZeit, kontoPixel, metaId, metaPost, name200, num, obj, pruefePixel, softMsg,
  str, WerkzeugError, type Ctx, type Raw,
} from './common.ts'
import {
  CUSTOM_CONVERSIONS_MAX, CUSTOM_EVENT_TYPES,
  type CustomConversionCreateRequest, type CustomConversionCreateResponse, type CustomConversionsListRequest,
  type CustomConversionsListResponse, type CustomConversionZeile, type PixelDiagnoseRequest, type PixelDiagnoseResponse,
  type PixelEmq,
} from './typen.ts'
import { regelZusammenfassung } from './zielgruppen.ts'

const EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,49}$/

// ── custom_conversions_list ──────────────────────────────────────────────────

const CC_FELDER = [
  'id,name,custom_event_type,rule,pixel{id},last_fired_time,is_archived,is_unavailable,creation_time,description',
  'id,name,custom_event_type,rule,is_archived',
]

async function conversionsLaden(account: string, warnings: string[]): Promise<Raw[]> {
  let letzter: unknown = null
  for (const [i, fields] of CC_FELDER.entries()) {
    try {
      const list = await graphAll<Raw>(`act_${account}/customconversions`, { fields, limit: 100 }, { maxPages: 3 })
      if (i > 0) warnings.push('Conversions nur mit Grunddaten geladen.')
      return list
    } catch (e) {
      letzter = e
    }
  }
  throw letzter
}

function zeile(c: Raw): CustomConversionZeile {
  const regel = c.rule !== undefined && c.rule !== null && str(c.rule) !== '' ? regelZusammenfassung(c.rule).text : ''
  return {
    id: str(c.id),
    name: str(c.name),
    kategorie: str(c.custom_event_type) || null,
    pixel_id: str(obj(c.pixel).id) || null,
    regel_zusammenfassung: regel || 'Keine Regel lesbar',
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
  return {
    items: req.mit_archivierten === true ? list : aktiv,
    anzahl_aktiv: aktiv.length,
    max: CUSTOM_CONVERSIONS_MAX,
    warnings,
  }
}

// ── custom_conversion_create ─────────────────────────────────────────────────

export async function modeCustomConversionCreate(ctx: Ctx, req: CustomConversionCreateRequest): Promise<CustomConversionCreateResponse> {
  const name = name200(req.name)
  const st = await ctx.settings()
  const pixelId = metaId(req.pixel_id ?? st.default_pixel_id, 'pixel_id')
  const kategorie = str(req.kategorie)
  if ((CUSTOM_EVENT_TYPES as readonly string[]).indexOf(kategorie) < 0) {
    throw new WerkzeugError(400, 'invalid_request', 'kategorie fehlt oder ist unbekannt.', `Erlaubt: ${CUSTOM_EVENT_TYPES.join(', ')}`)
  }
  // event: Alias aus dem SPEC2-Vertrag
  const ereignis = (str(req.ereignis).trim() || str(req.event).trim())
  if (ereignis && !EVENT_RE.test(ereignis)) throw new WerkzeugError(400, 'invalid_request', 'Ereignisname nur aus Buchstaben, Ziffern und _ (z. B. Lead, QualifiedLead).')
  const urls = arr<{ art?: string; wert?: string }>(req.url_regeln)
  if (urls.length > 10) throw new WerkzeugError(400, 'invalid_request', 'Höchstens 10 URL-Regeln.')
  const urlTeile = urls.map((u, i) => {
    const wert = str(u?.wert).trim()
    if (!wert || wert.length > 300 || /\s/.test(wert)) throw new WerkzeugError(400, 'invalid_request', `URL-Regel ${i + 1}: Wert ohne Leerzeichen angeben (höchstens 300 Zeichen).`)
    if (u?.art === 'url_enthaelt') return { url: { i_contains: wert } }
    if (u?.art === 'url_gleich') {
      if (!/^https?:\/\/[^\s/?#]+\.[^\s]+$/i.test(wert)) throw new WerkzeugError(400, 'invalid_request', `URL-Regel ${i + 1}: vollständige Adresse mit https:// angeben.`)
      return { url: { eq: wert } }
    }
    throw new WerkzeugError(400, 'invalid_request', `URL-Regel ${i + 1}: art url_enthaelt oder url_gleich.`)
  })
  if (!ereignis && !urlTeile.length) throw new WerkzeugError(400, 'invalid_request', 'Ereignis oder mindestens eine URL-Regel angeben.')
  const rule: Raw = ereignis
    ? { and: [{ event: { eq: ereignis } }, ...(urlTeile.length ? [{ or: urlTeile }] : [])] }
    : { or: urlTeile }
  const wert = req.standardwert === undefined || req.standardwert === null ? null : num(req.standardwert)
  if (wert !== null && (wert < 0 || wert > 1_000_000)) throw new WerkzeugError(400, 'invalid_request', 'standardwert: 0 bis 1.000.000.')

  const body: Raw = {
    name,
    event_source_id: pixelId,
    rule: JSON.stringify(rule),
    custom_event_type: kategorie,
    description: cleanText(req.beschreibung, 400) || `HP-Werbemanager: ${regelZusammenfassung(rule).text}`.slice(0, 400),
    ...(wert !== null ? { default_conversion_value: wert } : {}),
  }
  const hinweise: string[] = []
  if (ereignis && !urlTeile.length) hinweise.push(`Zählt jedes Pixel-Ereignis „${ereignis}“. Kommt es auch per Conversions API, wird es über event_id entdoppelt.`)
  if (req.vorschau === true) return { vorschau: true, conversion_id: null, payload: body, hinweise }

  await pruefePixel(ctx, pixelId, hinweise)
  // Limit 100 und Doppelklick-Schutz (gleicher Name)
  try {
    const list = await graphAll<Raw>(`act_${ctx.env.account}/customconversions`, { fields: 'id,name,is_archived', limit: 100 }, { maxPages: 3 })
    const aktiv = list.filter(c => c.is_archived !== true)
    if (aktiv.length >= CUSTOM_CONVERSIONS_MAX) {
      throw new WerkzeugError(422, 'limit_reached', `Das Werbekonto hat schon ${CUSTOM_CONVERSIONS_MAX} benutzerdefinierte Conversions (Meta-Grenze).`,
        'Nicht mehr genutzte Conversions im Events Manager archivieren (bewusst nicht aus dem CRM).')
    }
    const gleich = aktiv.find(c => str(c.name).trim().toLowerCase() === name.toLowerCase())
    if (gleich) {
      throw new WerkzeugError(409, 'invalid_request', `Es gibt schon eine Conversion „${name}“ (ID ${str(gleich.id)}).`, 'Anderen Namen wählen oder die vorhandene nutzen.')
    }
  } catch (e) {
    if (e instanceof WerkzeugError) throw e
    hinweise.push(`Vorhandene Conversions nicht lesbar (${softMsg(e)}); Grenze und Dubletten nicht geprüft.`)
  }

  const res = await metaPost(ctx, `act_${ctx.env.account}/customconversions`, body, { level: 'custom_conversion' })
  const id = str(res.id)
  if (!id) throw new WerkzeugError(502, 'meta_error', 'Meta hat keine Conversion-ID zurückgegeben.')
  hinweise.push('Die Conversion erscheint als Optimierungs-Ereignis, sobald Meta sie einmal empfangen hat.')
  return { vorschau: false, conversion_id: id, payload: body, hinweise }
}

// ── pixel_diagnose ───────────────────────────────────────────────────────────

const PIXEL_FELDER = [
  'id,name,last_fired_time,is_unavailable,creation_time,automatic_matching_fields,enable_automatic_matching,first_party_cookie_status',
  'id,name,last_fired_time,is_unavailable',
]
const DQ_FELDER = [
  'web{event_name,event_match_quality{composite_score,match_key_feedback{identifier,coverage{percentage}},diagnostics{name,description,solution,percentage}}}',
  'web{event_name,event_match_quality}',
]
const MERKMAL_LABEL: Record<string, string> = {
  email: 'E-Mail', phone: 'Telefon', external_id: 'Externe ID', ip_address: 'IP-Adresse', user_agent: 'Browser',
  fbc: 'Klick-ID (fbc)', fbp: 'Browser-ID (fbp)', first_name: 'Vorname', last_name: 'Nachname', country: 'Land',
  city: 'Stadt', zip: 'PLZ', lead_id: 'Lead-ID',
}

export async function modePixelDiagnose(ctx: Ctx, req: PixelDiagnoseRequest): Promise<PixelDiagnoseResponse> {
  const st = await ctx.settings()
  const pixelId = metaId(req.pixel_id ?? st.default_pixel_id, 'pixel_id')
  const warnings: string[] = []
  const hinweise: string[] = []

  const konto = await kontoPixel(ctx.env.account)
  if (konto && !konto.has(pixelId)) throw new WerkzeugError(403, 'forbidden', `Pixel ${pixelId} gehört nicht zum Werbekonto.`)
  if (!konto) warnings.push('Pixel-Liste des Werbekontos nicht lesbar.')

  // 1. Grunddaten (Pflicht)
  let p: Raw | null = null
  let letzter: unknown = null
  for (const fields of PIXEL_FELDER) {
    try { p = await graphGet<Raw>(pixelId, { fields }); break } catch (e) { letzter = e }
  }
  if (!p) throw new WerkzeugError(502, 'meta_error', `Pixel nicht lesbar: ${softMsg(letzter)}`)
  const letzterEmpfang = isoZeit(p.last_fired_time)
  const stunden = letzterEmpfang ? Math.max(0, Math.round((Date.now() - Date.parse(letzterEmpfang)) / 3_600_000)) : null

  // 2. Ereignisse der letzten 24 Stunden
  const ereignisse = new Map<string, number>()
  if (!auslastungHoch()) {
    try {
      const j = await graphGet<Raw>(`${pixelId}/stats`, { aggregation: 'event', start_time: Math.floor(Date.now() / 1000) - 86_400 })
      for (const block of arr<Raw>(j.data)) {
        for (const d of arr<Raw>(obj(block).data)) {
          const name = str(obj(d).value)
          const n = num(obj(d).count) ?? 0
          if (name) ereignisse.set(name, (ereignisse.get(name) ?? 0) + n)
        }
      }
    } catch (e) { warnings.push(`Pixel-Statistik nicht lesbar: ${softMsg(e)}`) }
  } else warnings.push('Pixel-Statistik übersprungen (Meta-Auslastung hoch).')

  // 3. Datensatzqualität (Dataset Quality API)
  const emq: PixelEmq[] = []
  if (!auslastungHoch()) {
    let dq: Raw | null = null
    let fehler: unknown = null
    for (const fields of DQ_FELDER) {
      try { dq = await graphGet<Raw>('dataset_quality', { dataset_id: pixelId, fields }); break } catch (e) { fehler = e }
    }
    if (!dq) warnings.push(`Datensatzqualität nicht lesbar: ${softMsg(fehler)}`)
    for (const w of arr<Raw>(dq?.web)) {
      const q = obj(obj(w).event_match_quality)
      emq.push({
        ereignis: str(obj(w).event_name),
        score: num(q.composite_score),
        merkmale: arr<Raw>(q.match_key_feedback).map(m => ({
          merkmal: MERKMAL_LABEL[str(obj(m).identifier)] ?? str(obj(m).identifier),
          abdeckung_pct: num(obj(obj(m).coverage).percentage),
        })),
        diagnosen: arr<Raw>(q.diagnostics).map(d => ({
          name: str(obj(d).name),
          beschreibung: str(obj(d).description) || null,
          loesung: str(obj(d).solution) || null,
          anteil_pct: num(obj(d).percentage),
        })),
      })
    }
  }

  // Ampel
  let rot = false
  let gelb = false
  const nichtVerfuegbar = p.is_unavailable === true
  if (nichtVerfuegbar) { rot = true; hinweise.push('Meta markiert den Pixel als nicht verfügbar.') }
  if (stunden === null) { rot = true; hinweise.push('Der Pixel hat noch nie Daten empfangen.') }
  else if (stunden > 48) { rot = true; hinweise.push(`Seit ${stunden} Stunden kein Ereignis empfangen: Website-Code und Consent-Banner prüfen.`) }
  else if (stunden > 24) { gelb = true; hinweise.push(`Seit ${stunden} Stunden kein Ereignis empfangen.`) }
  for (const e of emq) {
    if (e.score !== null && e.score < 6) {
      gelb = true
      hinweise.push(`Event Match Quality „${e.ereignis}“ nur ${e.score.toLocaleString('de-DE')}/10: mehr Merkmale (E-Mail, Telefon, externe ID) per Conversions API senden.`)
    }
    if (e.diagnosen.length) {
      gelb = true
      for (const d of e.diagnosen.slice(0, 3)) hinweise.push(`${e.ereignis}: ${d.name}`)
    }
  }
  if (!rot && !gelb) hinweise.push('Pixel empfängt Daten, keine Auffälligkeiten.')

  return {
    id: pixelId,
    name: str(p.name) || (konto?.get(pixelId) ?? null),
    im_konto: konto ? true : null,
    ist_hp_pixel: pixelId === (st.default_pixel_id || HP_PIXEL_ID),
    letzter_empfang: letzterEmpfang,
    stunden_seit_empfang: stunden,
    nicht_verfuegbar: nichtVerfuegbar,
    ereignisse_24h: Array.from(ereignisse.entries()).map(([ereignis, anzahl]) => ({ ereignis, anzahl })).sort((a, b) => b.anzahl - a.anzahl),
    emq,
    ampel: rot ? 'rot' : gelb ? 'gelb' : 'gruen',
    hinweise,
    warnings,
  }
}
