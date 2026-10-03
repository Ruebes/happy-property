// meta-werkzeuge: Zielgruppen (Custom Audiences) lesen und anlegen.
//   audiences_list               Liste mit Größe, Verweildauer, Regel in Deutsch, Housing-Eignung DE
//   audience_create_website      Pixel-Regeln (URL enthält / URL gleich / Ereignis), 1-180 Tage, Ausschlüsse
//   audience_create_engagement   Seite, Instagram, Sofortformular (Regel-Format) und Video (ENGAGEMENT-Format)
//   audience_create_lookalike    nur außerhalb der Sonderkategorie Wohnen; seit 1.9.2026 länderlos
// Alles wird nur ANGELEGT. Nichts wird bei Meta geändert oder gelöscht.

import { graphAll, graphGet } from '../_shared/metaGraph.ts'
import {
  arr, auslastungHoch, cleanText, digits, ganzzahl, isoZeit, mapPool, metaId, metaPost, name200, num, obj, pruefePixel,
  sacEligibility, laenderParam, softMsg, str, uniq, usageInfo, WerkzeugError, zielgruppeGleichenNamens, type Ctx, type Raw,
} from './common.ts'
import {
  INTERAKTION_ARTEN, INTERAKTION_MAX_TAGE, LOOKALIKE_RATIO_MAX, LOOKALIKE_RATIO_MIN, WEBSITE_MAX_REGELN, WEBSITE_MAX_TAGE,
  type AudienceCreateEngagementRequest, type AudienceCreateLookalikeRequest, type AudienceCreateResponse,
  type AudienceCreateWebsiteRequest, type AudiencesListRequest, type AudiencesListResponse, type InteraktionsQuelle,
  type WebsiteRegel, type Zielgruppe, type ZielgruppenArt,
} from './typen.ts'

const SAC_MAX = 25
const TAG_SEK = 86_400

// ── Regel in einfachem Deutsch ───────────────────────────────────────────────

const OP_LABEL: Record<string, string> = {
  i_contains: 'enthält', contains: 'enthält', i_not_contains: 'enthält nicht', not_contains: 'enthält nicht',
  eq: 'ist', '=': 'ist', neq: 'ist nicht', '!=': 'ist nicht', i_starts_with: 'beginnt mit', starts_with: 'beginnt mit',
  regex_match: 'passt zu', gt: '>', '>': '>', gte: '≥', '>=': '≥', lt: '<', '<': '<', lte: '≤', '<=': '≤',
  is_any: 'ist eins von', i_is_any: 'ist eins von', is_not_any: 'ist keins von', i_is_not_any: 'ist keins von',
}
const FIELD_LABEL: Record<string, string> = { url: 'URL', path: 'Pfad', domain: 'Domain', event: 'Ereignis', device_type: 'Gerät' }
const SOURCE_LABEL: Record<string, string> = {
  pixel: 'Website', page: 'Facebook-Seite', ig_business: 'Instagram', lead: 'Sofortformular',
  ig_lead_generation: 'Sofortformular (Instagram)', canvas: 'Instant Experience', app: 'App', offline_events: 'Offline',
}

const artLabel = (wert: string): string => INTERAKTION_ARTEN.find(a => a.wert === wert)?.label ?? wert
const zitat = (v: unknown): string => `„${str(Array.isArray(v) ? v.join(', ') : v).slice(0, 80)}“`

function filterText(f: Raw): string {
  if (Array.isArray(f.filters)) {
    const verb = str(f.operator) === 'and' ? ' und ' : ' oder '
    return arr<Raw>(f.filters).map(x => filterText(obj(x))).filter(Boolean).join(verb)
  }
  const field = str(f.field)
  const op = str(f.operator)
  if (field === 'event') return artLabel(str(f.value)) === str(f.value) ? `Ereignis ${zitat(f.value)}` : artLabel(str(f.value))
  return `${FIELD_LABEL[field] ?? field} ${OP_LABEL[op] ?? op} ${zitat(f.value)}`
}

/** Altes Format {"and":[{"url":{"i_contains":"x"}}]} */
function altText(v: unknown): string {
  const o = obj(v)
  for (const verb of ['and', 'or'] as const) {
    if (Array.isArray(o[verb])) return arr(o[verb]).map(altText).filter(Boolean).join(verb === 'and' ? ' und ' : ' oder ')
  }
  const teile: string[] = []
  for (const [k, cond] of Object.entries(o)) {
    const c = obj(cond)
    const op = Object.keys(c)[0]
    if (!op) continue
    teile.push(k === 'event' ? `Ereignis ${zitat(c[op])}` : `${FIELD_LABEL[k.toLowerCase()] ?? k} ${OP_LABEL[op] ?? op} ${zitat(c[op])}`)
  }
  return teile.join(' und ')
}

function ruleSetText(rs: Raw): { text: string; tage: number | null } {
  let tage: number | null = null
  const teile = arr<Raw>(rs.rules).map(r0 => {
    const r = obj(r0)
    const quellen = uniq(arr<Raw>(r.event_sources).map(s => SOURCE_LABEL[str(obj(s).type).toLowerCase()] ?? str(obj(s).type)))
    const sek = num(r.retention_seconds)
    if (sek !== null) tage = Math.max(tage ?? 0, Math.round(sek / TAG_SEK))
    const f = filterText(obj(r.filter))
    return `${quellen.join(', ') || 'Quelle'}: ${f || 'alle'}${sek !== null && sek > 0 ? ` (${Math.round(sek / TAG_SEK)} Tage)` : ''}`
  })
  return { text: teile.join(str(rs.operator) === 'and' ? ' und ' : ' oder '), tage }
}

/** Meta-Regel (String oder Objekt) -> Zusammenfassung + längste Verweildauer */
export function regelZusammenfassung(rule: unknown): { text: string; tage: number | null; video: boolean } {
  let r: unknown = rule
  if (typeof rule === 'string') {
    try { r = JSON.parse(rule) } catch { return { text: 'Regel nicht lesbar', tage: null, video: false } }
  }
  if (Array.isArray(r)) {
    // Video-Interaktion (ENGAGEMENT): [{object_id, event_name}]
    const teile = r.map(x => obj(x)).filter(x => str(x.event_name))
      .map(x => `${artLabel(str(x.event_name))} (Video ${str(x.object_id)})`)
    return { text: teile.join(' oder ') || 'Regel nicht lesbar', tage: null, video: teile.length > 0 }
  }
  const o = obj(r)
  if (o.inclusions) {
    const inc = ruleSetText(obj(o.inclusions))
    let text = inc.text
    if (o.exclusions && arr(obj(o.exclusions).rules).length) text += `; ausgenommen: ${ruleSetText(obj(o.exclusions)).text}`
    return { text: text || 'Regel ohne Bedingungen', tage: inc.tage, video: false }
  }
  const alt = altText(o)
  return { text: alt || 'Regel nicht lesbar', tage: null, video: false }
}

function zielgruppenArt(a: Raw, video: boolean): ZielgruppenArt {
  const sub = str(a.subtype).toUpperCase()
  const ds = obj(a.data_source)
  if (sub === 'LOOKALIKE') return 'lookalike'
  if (sub === 'WEBSITE') return 'website'
  if (sub === 'ENGAGEMENT' || sub === 'IG_BUSINESS') return video || /VIDEO/.test(str(ds.sub_type)) ? 'video' : 'interaktion'
  if (sub === 'CUSTOM' && (str(a.customer_file_source) || /FILE|COPY_PASTE/.test(str(ds.type)) || /HASHES/.test(str(ds.sub_type)))) return 'kundenliste'
  if (video) return 'video'
  const rule = str(a.rule)
  if (/"pixel"/.test(rule)) return 'website'
  if (/"(page|ig_business|lead|ig_lead_generation)"/.test(rule)) return 'interaktion'
  return 'sonstige'
}

const groesse = (v: unknown): number | null => {
  const n = num(v)
  return n !== null && n >= 0 ? n : null
}

const status = (v: unknown): { code: number | null; text: string | null } => {
  const o = obj(v)
  return { code: num(o.code), text: str(o.description) || null }
}

// ── audiences_list ───────────────────────────────────────────────────────────

const LIST_FIELDS = 'id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound,retention_days,rule,delivery_status,operation_status,time_created,time_updated,lookalike_spec,customer_file_source,data_source'
const LIST_FIELDS_MIN = 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound'

export async function modeAudiencesList(ctx: Ctx, req: AudiencesListRequest): Promise<AudiencesListResponse> {
  const warnings: string[] = []
  const land = laenderParam(req.sac_land ?? 'DE')
  let list: Raw[]
  try {
    list = await graphAll<Raw>(`act_${ctx.env.account}/customaudiences`, { fields: LIST_FIELDS, limit: 50 }, { maxPages: 8 })
  } catch (e) {
    // Rückfall: ein Feld wird von Meta nicht (mehr) geliefert
    warnings.push(`Zielgruppen nur mit Grunddaten geladen: ${softMsg(e)}`)
    list = await graphAll<Raw>(`act_${ctx.env.account}/customaudiences`, { fields: LIST_FIELDS_MIN, limit: 100 }, { maxPages: 5 })
  }

  const items: Zielgruppe[] = list.filter(a => str(a.id)).map(a => {
    const regel = a.rule !== undefined && a.rule !== null && str(a.rule) !== ''
      ? regelZusammenfassung(a.rule)
      : { text: '', tage: null, video: false }
    const art = zielgruppenArt(a, regel.video)
    const ls = obj(a.lookalike_spec)
    const origin = obj(arr<Raw>(ls.origin)[0])
    const ratio = num(ls.ratio)
    let text = regel.text
    if (art === 'lookalike') {
      text = `Lookalike ${ratio !== null ? `${Math.round(ratio * 100)} %` : ''} aus ${str(origin.name) ? zitat(origin.name) : 'Quell-Zielgruppe'}`.replace(/\s+/g, ' ')
    } else if (art === 'kundenliste' && !text) {
      text = 'Kundenliste (gehashte Kontaktdaten)'
    }
    const ret = num(a.retention_days)
    return {
      id: str(a.id),
      name: str(a.name),
      art,
      subtype: str(a.subtype) || null,
      beschreibung: str(a.description) || null,
      groesse_min: groesse(a.approximate_count_lower_bound),
      groesse_max: groesse(a.approximate_count_upper_bound),
      aufbewahrung_tage: ret !== null && ret > 0 ? ret : regel.tage,
      regel_zusammenfassung: text || 'Keine Regel lesbar',
      auslieferung: status(a.delivery_status),
      bearbeitung: status(a.operation_status),
      sac_eligible: art === 'lookalike' ? false : null,
      ...(art === 'lookalike' ? { sac_grund: 'Lookalike Audiences sind unter der Sonderkategorie Wohnen nicht erlaubt.' } : {}),
      gesperrt_fuer_wohnen: art === 'lookalike',
      ...(art === 'lookalike' ? {
        lookalike: {
          quelle_id: str(origin.id) || null,
          quelle_name: str(origin.name) || null,
          ratio,
          land: str(ls.country) || str(arr(ls.target_countries)[0]) || null,
        },
      } : {}),
      erstellt: isoZeit(a.time_created),
      aktualisiert: isoZeit(a.time_updated),
    }
  })
  items.sort((x, y) => (y.aktualisiert ?? '').localeCompare(x.aktualisiert ?? ''))

  // Housing-Eignung: höchstens SAC_MAX je Aufruf, Abbruch bei hoher Auslastung
  let geprueft = 0
  if (req.sac_pruefen !== false) {
    const kandidaten = items.filter(i => i.art !== 'lookalike').slice(0, SAC_MAX)
    let gestoppt = false
    await mapPool(kandidaten, 2, async it => {
      if (gestoppt || auslastungHoch()) {
        gestoppt = true
        it.sac_grund = 'Nicht geprüft (Meta-Auslastung hoch, später erneut laden).'
        return
      }
      const r = await sacEligibility(ctx.env.account, it.id, land)
      geprueft++
      it.sac_eligible = r.eligible
      if (r.reason) it.sac_grund = r.reason
      if (r.eligible === false) {
        it.gesperrt_fuer_wohnen = true
        it.sac_grund = it.sac_grund ?? `Meta lässt diese Zielgruppe für Wohnen (${land}) nicht zu.`
      }
    })
    if (gestoppt) warnings.push('Housing-Eignung nicht für alle Zielgruppen geprüft (Meta-Auslastung über 75 %).')
  }
  const offen = items.filter(i => i.art !== 'lookalike' && i.sac_eligible === null).length
  if (offen && req.sac_pruefen !== false && items.length > SAC_MAX) warnings.push(`Housing-Eignung je Aufruf nur für ${SAC_MAX} Zielgruppen geprüft.`)
  return { items, sac: { land, geprueft, offen }, warnings, usage: usageInfo() }
}

// ── gemeinsame Anlage ────────────────────────────────────────────────────────

async function anlegen(ctx: Ctx, name: string, body: Raw, vorschau: boolean, hinweise: string[], sacPruefen = true): Promise<AudienceCreateResponse> {
  if (vorschau) return { vorschau: true, audience_id: null, name, payload: body, sac_eligible: null, hinweise }
  // Doppelklick-Schutz (wie bei Conversions): gleicher Name -> 409
  try {
    const gleich = await zielgruppeGleichenNamens(ctx.env.account, name)
    if (gleich) {
      throw new WerkzeugError(409, 'invalid_request', `Es gibt schon eine Zielgruppe „${name}“ (ID ${str(gleich.id)}).`, 'Anderen Namen wählen oder die vorhandene nutzen.')
    }
  } catch (e) {
    if (e instanceof WerkzeugError) throw e
    hinweise.push(`Vorhandene Zielgruppen nicht lesbar (${softMsg(e)}); Dubletten nicht geprüft.`)
  }
  const res = await metaPost(ctx, `act_${ctx.env.account}/customaudiences`, body, { level: 'audience' })
  const id = str(res.id)
  if (!id) throw new WerkzeugError(502, 'meta_error', 'Meta hat keine Zielgruppen-ID zurückgegeben.')
  let sac: boolean | null = null
  if (sacPruefen && !auslastungHoch()) {
    const r = await sacEligibility(ctx.env.account, id, 'DE')
    sac = r.eligible
    if (r.eligible === false) hinweise.push('Meta lässt diese Zielgruppe für Wohnen-Kampagnen (DE) nicht zu.')
  }
  hinweise.push('Meta braucht bis zu einige Stunden, bis die Größe der Zielgruppe angezeigt wird.')
  return { vorschau: false, audience_id: id, name, payload: body, sac_eligible: sac, hinweise }
}

function beschreibung(v: unknown, fallback: string): string {
  return cleanText(v, 400) || fallback
}

// ── audience_create_website ──────────────────────────────────────────────────

const EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,49}$/

function websiteFilter(r: WebsiteRegel, i: number, label: string): Raw {
  const art = str(r?.art)
  const wert = str(r?.wert).trim()
  const nr = `${label} ${i + 1}`
  if (!wert || wert.length > 300 || /[\u0000-\u001f]/.test(wert)) throw new WerkzeugError(400, 'invalid_request', `${nr}: Wert fehlt oder ist zu lang (höchstens 300 Zeichen).`)
  if (art === 'url_enthaelt') {
    if (/\s/.test(wert)) throw new WerkzeugError(400, 'invalid_request', `${nr}: URL-Teil ohne Leerzeichen angeben (z. B. /termin).`)
    return { field: 'url', operator: 'i_contains', value: wert }
  }
  if (art === 'url_gleich') {
    if (!/^https?:\/\/[^\s/?#]+\.[^\s]+$/i.test(wert)) throw new WerkzeugError(400, 'invalid_request', `${nr}: vollständige Adresse mit https:// angeben.`)
    return { field: 'url', operator: 'eq', value: wert }
  }
  if (art === 'event') {
    if (!EVENT_RE.test(wert)) throw new WerkzeugError(400, 'invalid_request', `${nr}: Ereignisname nur aus Buchstaben, Ziffern und _ (z. B. Lead, Schedule).`)
    return { field: 'event', operator: 'eq', value: wert }
  }
  throw new WerkzeugError(400, 'invalid_request', `${nr}: unbekannte Art "${art.slice(0, 30)}" (url_enthaelt, url_gleich, event).`)
}

function websiteRuleSet(pixelId: string, regeln: WebsiteRegel[], tage: number, und: boolean, label: string): Raw {
  return {
    operator: 'or',
    rules: [{
      event_sources: [{ id: pixelId, type: 'pixel' }],
      retention_seconds: tage * TAG_SEK,
      filter: { operator: und ? 'and' : 'or', filters: regeln.map((r, i) => websiteFilter(r, i, label)) },
    }],
  }
}

export async function modeAudienceCreateWebsite(ctx: Ctx, req: AudienceCreateWebsiteRequest): Promise<AudienceCreateResponse> {
  const name = name200(req.name)
  const st = await ctx.settings()
  const pixelId = metaId(req.pixel_id ?? st.default_pixel_id, 'pixel_id')
  const regeln = arr<WebsiteRegel>(req.regeln)
  if (!regeln.length) throw new WerkzeugError(400, 'invalid_request', 'Mindestens eine Regel angeben (z. B. URL enthält /termin).')
  if (regeln.length > WEBSITE_MAX_REGELN) throw new WerkzeugError(400, 'invalid_request', `Höchstens ${WEBSITE_MAX_REGELN} Regeln je Zielgruppe.`)
  const tage = ganzzahl(req.tage, 1, WEBSITE_MAX_TAGE, 'Tage')
  const aus = arr<WebsiteRegel>(req.ausschluss_regeln)
  if (aus.length > WEBSITE_MAX_REGELN) throw new WerkzeugError(400, 'invalid_request', `Höchstens ${WEBSITE_MAX_REGELN} Ausschluss-Regeln.`)
  const ausTage = aus.length ? ganzzahl(req.ausschluss_tage ?? tage, 1, WEBSITE_MAX_TAGE, 'Tage (Ausschluss)') : tage

  const rule: Raw = { inclusions: websiteRuleSet(pixelId, regeln, tage, req.verknuepfung === 'und', 'Regel') }
  // Ausschlüsse: wer EINE der Regeln erfüllt, fliegt raus
  if (aus.length) rule.exclusions = websiteRuleSet(pixelId, aus, ausTage, false, 'Ausschluss-Regel')

  const vorschau = req.vorschau === true
  const hinweise: string[] = []
  if (!vorschau) await pruefePixel(ctx, pixelId, hinweise)
  const zusammenfassung = regelZusammenfassung(rule).text
  const body: Raw = {
    name,
    rule: JSON.stringify(rule),
    prefill: true,
    description: beschreibung(req.beschreibung, `HP-Werbemanager: ${zusammenfassung}`.slice(0, 400)),
  }
  hinweise.push(`Meta übernimmt Besuche der letzten ${tage} Tage sofort (Vorbefüllung).`)
  return await anlegen(ctx, name, body, vorschau, hinweise)
}

// ── audience_create_engagement ───────────────────────────────────────────────

const ART_ALIAS: Record<string, string> = {
  leadform_opened: 'lead_generation_opened', leadform_submitted: 'lead_generation_submitted', leadform_dropoff: 'lead_generation_dropoff',
  video_3s: 'video_watched', video_15s: 'video_view_15s', video_25: 'video_view_25_percent', video_50: 'video_view_50_percent',
  video_75: 'video_view_75_percent', video_95: 'video_completed',
}
const SOURCE_TYPE: Record<Exclude<InteraktionsQuelle, 'video'>, string> = { page: 'page', instagram: 'ig_business', leadform: 'lead' }

async function igKontoDerSeite(pageId: string): Promise<string | null> {
  try {
    const j = await graphGet<Raw>(pageId, { fields: 'instagram_business_account{id}' })
    return str(obj(j.instagram_business_account).id) || null
  } catch {
    return null
  }
}

export async function modeAudienceCreateEngagement(ctx: Ctx, req: AudienceCreateEngagementRequest): Promise<AudienceCreateResponse> {
  const name = name200(req.name)
  const quelle = str(req.quelle) as InteraktionsQuelle
  if (!(quelle in INTERAKTION_MAX_TAGE)) throw new WerkzeugError(400, 'invalid_request', 'quelle muss page, instagram, video oder leadform sein.')
  const artIn = str(req.art).trim()
  const art = ART_ALIAS[artIn] ?? artIn
  const erlaubt = INTERAKTION_ARTEN.filter(a => a.quelle === quelle).map(a => a.wert)
  if (erlaubt.indexOf(art) < 0) {
    throw new WerkzeugError(400, 'invalid_request', `Art "${artIn.slice(0, 40)}" passt nicht zur Quelle.`, `Erlaubt: ${erlaubt.join(', ')}`)
  }
  const maxTage = INTERAKTION_MAX_TAGE[quelle]
  const tage = ganzzahl(req.tage, 1, maxTage, `Tage (${quelle} höchstens ${maxTage})`)
  const st = await ctx.settings()
  const vorschau = req.vorschau === true
  const hinweise: string[] = []

  let ids = uniq(arr<unknown>(req.objekt_ids).map(x => str(x).trim()).filter(Boolean))
  if (ids.length > 10) throw new WerkzeugError(400, 'invalid_request', 'Höchstens 10 Objekte je Zielgruppe.')
  if (!ids.length) {
    if (quelle === 'page') ids = [st.default_page_id]
    else if (quelle === 'instagram') {
      const ig = st.default_ig_user_id ?? (vorschau ? null : await igKontoDerSeite(st.default_page_id))
      if (!ig) throw new WerkzeugError(400, 'invalid_request', 'Kein Instagram-Konto gefunden.', 'objekt_ids mit der Instagram-Konto-ID angeben oder in den Werbe-Einstellungen hinterlegen.')
      ids = [ig]
    } else {
      throw new WerkzeugError(400, 'invalid_request', quelle === 'video' ? 'Video-IDs fehlen (objekt_ids).' : 'Formular-IDs fehlen (objekt_ids).')
    }
  }
  ids = ids.map(id => metaId(id, 'Objekt-ID'))

  let body: Raw
  if (quelle === 'video') {
    // Video-Interaktion: altes ENGAGEMENT-Format mit Regel-Liste (Meta-Doku „Video remarketing“)
    body = {
      name,
      subtype: 'ENGAGEMENT',
      rule: JSON.stringify(ids.map(id => ({ object_id: id, event_name: art }))),
      retention_days: tage,
      prefill: true,
    }
  } else {
    const rule = {
      inclusions: {
        operator: 'or',
        rules: [{
          event_sources: ids.map(id => ({ id, type: SOURCE_TYPE[quelle] })),
          retention_seconds: tage * TAG_SEK,
          filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: art }] },
        }],
      },
    }
    body = { name, rule: JSON.stringify(rule), prefill: true }
  }
  body.description = beschreibung(req.beschreibung, `HP-Werbemanager: ${artLabel(art)} (${tage} Tage)`)
  if (quelle === 'leadform') hinweise.push('Sofortformular-Zielgruppen behalten Personen höchstens 90 Tage (Meta).')
  if (art === 'page_messaged' || art === 'ig_user_messaged_business') hinweise.push('Nachrichten-Zielgruppen liefert Meta in Europa eventuell nicht (Datenschutzregeln).')
  return await anlegen(ctx, name, body, vorschau, hinweise)
}

// ── audience_create_lookalike ────────────────────────────────────────────────

export async function modeAudienceCreateLookalike(ctx: Ctx, req: AudienceCreateLookalikeRequest): Promise<AudienceCreateResponse> {
  // Wohnen ist bei HP der Normalfall: ohne ausdrückliches 'standard' wird abgelehnt
  if (str(req.kontext || 'housing') !== 'standard') {
    throw new WerkzeugError(422, 'housing_forbidden',
      'Lookalike Audiences sind unter der Sonderkategorie Wohnen nicht erlaubt.',
      'Für Wohnen-Kampagnen stattdessen Website-, Interaktions- oder Kundenlisten-Zielgruppen nutzen. Lookalikes nur für Kampagnen ohne Sonderkategorie (kontext: standard).')
  }
  const name = name200(req.name)
  const sourceId = metaId(req.source_id, 'source_id (Quell-Zielgruppe)')
  const land = str(req.land).trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(land)) throw new WerkzeugError(400, 'invalid_request', 'land als Ländercode angeben (z. B. DE).')
  const ratioIn = num(req.ratio)
  const ratio = ratioIn === null ? NaN : Math.round(ratioIn * 100) / 100
  if (!Number.isFinite(ratio) || ratio < LOOKALIKE_RATIO_MIN || ratio > LOOKALIKE_RATIO_MAX || ratioIn === null || Math.abs(ratioIn - ratio) > 1e-9) {
    throw new WerkzeugError(400, 'invalid_request', 'ratio: 0,01 bis 0,10 in Schritten von 0,01 (1 % bis 10 %).')
  }
  const vorschau = req.vorschau === true
  const hinweise: string[] = []

  if (!vorschau) {
    // Quelle muss zum eigenen Konto gehören und darf selbst kein Lookalike sein
    let seed: Raw
    try {
      seed = await graphGet<Raw>(sourceId, { fields: 'id,name,account_id,subtype,approximate_count_lower_bound' })
    } catch (e) {
      throw new WerkzeugError(404, 'not_found', `Quell-Zielgruppe nicht lesbar: ${softMsg(e)}`)
    }
    if (digits(seed.account_id) && digits(seed.account_id) !== ctx.env.account) {
      throw new WerkzeugError(403, 'forbidden', 'Die Quell-Zielgruppe gehört nicht zum Werbekonto.')
    }
    if (str(seed.subtype).toUpperCase() === 'LOOKALIKE') throw new WerkzeugError(400, 'invalid_request', 'Ein Lookalike kann nicht Quelle eines weiteren Lookalikes sein.')
    const n = num(seed.approximate_count_lower_bound)
    if (n !== null && n >= 0 && n < 100) hinweise.push('Die Quelle hat weniger als 100 Personen; Meta baut das Lookalike erst ab 100.')
  }

  // Seit 1.9.2026 ignoriert Meta country/location_spec: Lookalikes sind länderlos,
  // das Land kommt aus der Anzeigengruppe. Deshalb kein country im lookalike_spec.
  const body: Raw = {
    name,
    subtype: 'LOOKALIKE',
    origin_audience_id: sourceId,
    lookalike_spec: JSON.stringify({ ratio }),
    description: beschreibung(req.beschreibung, `HP-Werbemanager: Lookalike ${Math.round(ratio * 100)} %, gedacht für ${land}`),
  }
  hinweise.push(`Meta legt Lookalikes seit September 2026 ohne Land an; ${land} in der Anzeigengruppe als Standort wählen.`)
  hinweise.push('Lookalikes brauchen 1 bis 6 Stunden, bis sie voll befüllt sind.')
  const out = await anlegen(ctx, name, body, vorschau, hinweise, false)
  // Lookalikes sind für Wohnen nie zulässig, egal was die Eignungsprüfung sagt
  return { ...out, sac_eligible: out.vorschau ? null : false }
}
