// meta-werkzeuge: Sofortformulare (Instant Forms) lesen, anlegen, kopieren.
//   leadforms_list      Formulare der Seite (Name, Status, Sprache, Leads, Typ)
//   leadform_get        ein Formular, zurückübersetzt in LeadFormSpecErweitert (für den Editor)
//   leadform_create     neues Formular aus LeadFormSpecErweitert
//   leadform_duplicate  Kopie eines bestehenden Formulars mit neuem Namen (Meta kennt
//                       kein Kopieren per API: lesen + neu anlegen, Rohdaten der Fragen
//                       inkl. bedingter Antworten werden 1:1 übernommen)
// Kein Archivieren, kein Löschen (Svens Regel). Alles über den Seiten-Token
// (/me/accounts), der nur im Speicher bleibt.
//
// Regeln: Fragen nach Alter, Geschlecht, Familienstand und Standort sind unter der
// Sonderkategorie Wohnen gesperrt (wohnen: false hebt das auf). Kundensichtbare
// Texte laufen durch denselben Lint wie Anzeigen (Gedankenstriche, ae/oe/ue,
// Renditeversprechen, Projekt- und Bauträgernamen). Bedingte Logik („wenn A,
// dann Frage B“) gibt es per API nicht: nur im Werbeanzeigenmanager.

import { MetaApiError } from '../_shared/metaGraph.ts'
import { lintHasBlockers, lintText, type LintIssue } from '../_shared/metaLint.ts'
import {
  arr, cleanText, forbiddenNames, HTTPS_URL_RE, isoZeit, logWrite, metaId, num, obj, pageFetch, seitenToken, softMsg, str,
  WerkzeugError, type Ctx, type Raw,
} from './common.ts'
import {
  LEADFORM_MAX_EIGENE_FRAGEN, LEADFORM_MAX_EINWILLIGUNGEN, LEADFORM_VORDEFINIERT, LEADFORM_WOHNEN_GRUND, LEADFORM_WOHNEN_VERBOTEN,
  type LeadformCreateWerkzeugRequest, type LeadformCreateWerkzeugResponse, type LeadformDuplicateRequest,
  type LeadformDuplicateResponse, type LeadformGetRequest, type LeadformGetResponse, type LeadformsListRequest,
  type LeadformsListResponse, type LeadFormEinwilligung, type LeadFormFrage, type LeadFormFrageTyp, type LeadFormLocale,
  type LeadFormSpecErweitert, type LeadFormTyp, type LeadFormZeile,
} from './typen.ts'

const KONTAKT_FRAGEN: readonly string[] = ['EMAIL', 'PHONE', 'WHATSAPP_NUMBER', 'WORK_EMAIL', 'WORK_PHONE_NUMBER']
const KEY_RE = /[^A-Za-z0-9_]/g
const POST_TIMEOUT = 30_000
const GET_TIMEOUT = 25_000

async function seite(ctx: Ctx, pageId: unknown): Promise<string> {
  const st = await ctx.settings()
  return metaId(pageId ?? st.default_page_id ?? ctx.env.pageId, 'page_id')
}

function metaLocale(l: unknown): string {
  const s = str(l).toLowerCase()
  return s === 'en_us' ? 'EN_US' : s === 'en_gb' ? 'EN_GB' : 'DE_DE'
}

function specLocale(l: unknown): LeadFormLocale | null {
  const s = str(l).toLowerCase()
  return s === 'de_de' ? 'de_DE' : s === 'en_us' ? 'en_US' : s === 'en_gb' ? 'en_GB' : null
}

const typVon = (v: unknown): LeadFormTyp | null => (v === true ? 'HIGHER_INTENT' : v === false ? 'MORE_VOLUME' : null)

// ── Lint + Wohnen ────────────────────────────────────────────────────────────

interface Pruefer {
  lint: LintIssue[]
  check(text: string, field: string): void
}

async function pruefer(ctx: Ctx, locale: string): Promise<Pruefer> {
  const lctx = { forbiddenNames: await forbiddenNames(ctx.sb) }
  const en = locale.startsWith('EN')
  const lint: LintIssue[] = []
  return {
    lint,
    check(text: string, field: string) {
      if (!text) return
      // englische Formulare: ae/oe/ue-Regel passt nicht (z. B. „queue“)
      lint.push(...lintText(text, field, lctx, 'leadform').filter(i => !(en && i.rule === 'umlaut')))
    },
  }
}

function lintAbbruch(p: Pruefer): void {
  if (lintHasBlockers(p.lint)) {
    throw new WerkzeugError(422, 'lint_blocked', 'Das Formular verstößt gegen eine harte Text-Regel.',
      'Gedankenstriche, ae/oe/ue, Renditeversprechen und Projekt- oder Bauträgernamen entfernen.', p.lint.filter(x => x.severity === 'blocker'))
  }
}

function wohnenAbbruch(typen: string[], wohnen: boolean): void {
  if (!wohnen) return
  const verboten = typen.filter(t => (LEADFORM_WOHNEN_VERBOTEN as readonly string[]).indexOf(t) >= 0)
  if (verboten.length) {
    throw new WerkzeugError(422, 'housing_forbidden', LEADFORM_WOHNEN_GRUND,
      `Diese Fragen entfernen: ${verboten.join(', ')}. Nur für Formulare außerhalb von Wohnen-Kampagnen: wohnen: false.`, { fragen: verboten })
  }
}

// ── Formular-Body aus LeadFormSpecErweitert ─────────────────────────────────

export interface FormBody { body: Raw; hinweise: string[] }

export async function formBody(ctx: Ctx, spec: LeadFormSpecErweitert): Promise<FormBody> {
  const hinweise: string[] = []
  const name = cleanText(spec.name, 200)
  if (!name) throw new WerkzeugError(400, 'invalid_request', 'Das Formular braucht einen Namen.')
  const locale = metaLocale(spec.locale)
  const en = locale !== 'DE_DE'
  const privacy = str(spec.privacy_policy_url).trim()
  if (!HTTPS_URL_RE.test(privacy)) {
    throw new WerkzeugError(400, 'invalid_request', 'Datenschutz-Link fehlt oder ist kein https-Link.', 'Zum Beispiel https://happy-property.de/datenschutz')
  }
  const p = await pruefer(ctx, locale)

  // Fragen
  const fragen = arr<LeadFormFrage>(spec.questions)
  if (!fragen.length) throw new WerkzeugError(400, 'invalid_request', 'Das Formular braucht mindestens eine Frage.')
  if (fragen.length > 30) throw new WerkzeugError(400, 'invalid_request', 'Höchstens 30 Fragen je Formular.')
  const erlaubteTypen: readonly string[] = [...LEADFORM_VORDEFINIERT, 'CUSTOM', 'DATE_TIME']
  const typen = fragen.map(q => str(q?.type))
  wohnenAbbruch(typen, spec.wohnen !== false)
  const questions: Raw[] = []
  const keys = new Set<string>()
  const vordefiniert = new Set<string>()
  let eigene = 0
  for (const [i, q] of fragen.entries()) {
    const type = str(q?.type) as LeadFormFrageTyp
    const nr = `Frage ${i + 1}`
    if (erlaubteTypen.indexOf(type) < 0) throw new WerkzeugError(400, 'invalid_request', `${nr}: unbekannter Typ "${type.slice(0, 30)}".`)
    if (type !== 'CUSTOM' && type !== 'DATE_TIME') {
      if (vordefiniert.has(type)) throw new WerkzeugError(400, 'invalid_request', `${nr}: ${type} steht doppelt im Formular.`)
      vordefiniert.add(type)
      questions.push({ type })
      continue
    }
    eigene++
    const label = cleanText(q.label, 200)
    if (!label) throw new WerkzeugError(400, 'invalid_request', `${nr}: Fragetext fehlt.`)
    const key = cleanText(q.key, 60).replace(KEY_RE, '_') || `frage_${i + 1}`
    if (keys.has(key)) throw new WerkzeugError(400, 'invalid_request', `${nr}: Schlüssel "${key}" doppelt.`)
    keys.add(key)
    p.check(label, 'leadform.questions')
    const item: Raw = { type, key, label }
    const kontext = cleanText(q.inline_context, 200)
    if (kontext) { item.inline_context = kontext; p.check(kontext, 'leadform.questions') }
    if (type === 'CUSTOM') {
      const opts = arr<{ value?: string; key?: string }>(q.options)
      const art = q.custom_art ?? (opts.length ? 'MULTIPLE_CHOICE' : 'SHORT_ANSWER')
      if (art === 'MULTIPLE_CHOICE') {
        if (opts.length < 2) throw new WerkzeugError(400, 'invalid_request', `${nr}: Mehrfachauswahl braucht mindestens 2 Antworten.`)
        if (opts.length > 20) throw new WerkzeugError(400, 'invalid_request', `${nr}: höchstens 20 Antworten.`)
        const okeys = new Set<string>()
        item.options = opts.map((o, j) => {
          const value = cleanText(o?.value, 100)
          if (!value) throw new WerkzeugError(400, 'invalid_request', `${nr}, Antwort ${j + 1}: Text fehlt.`)
          const okey = cleanText(o?.key, 60).replace(KEY_RE, '_') || `a${j + 1}`
          if (okeys.has(okey)) throw new WerkzeugError(400, 'invalid_request', `${nr}, Antwort ${j + 1}: Schlüssel "${okey}" doppelt.`)
          okeys.add(okey)
          p.check(value, 'leadform.questions')
          return { value, key: okey }
        })
      } else if (art === 'SHORT_ANSWER') {
        if (opts.length) throw new WerkzeugError(400, 'invalid_request', `${nr}: Kurze Antwort hat keine Antwortmöglichkeiten.`)
      } else {
        throw new WerkzeugError(400, 'invalid_request', `${nr}: custom_art MULTIPLE_CHOICE oder SHORT_ANSWER.`)
      }
    }
    questions.push(item)
  }
  if (eigene > LEADFORM_MAX_EIGENE_FRAGEN) throw new WerkzeugError(400, 'invalid_request', `Höchstens ${LEADFORM_MAX_EIGENE_FRAGEN} eigene Fragen.`)
  if (!typen.some(t => KONTAKT_FRAGEN.indexOf(t) >= 0)) hinweise.push('Ohne E-Mail- oder Telefonfrage kann das CRM den Lead kaum zuordnen.')

  const typ: LeadFormTyp = spec.typ ?? (spec.higher_intent === false ? 'MORE_VOLUME' : 'HIGHER_INTENT')
  if (typ !== 'MORE_VOLUME' && typ !== 'HIGHER_INTENT') throw new WerkzeugError(400, 'invalid_request', 'typ: MORE_VOLUME oder HIGHER_INTENT.')
  const linkText = cleanText(spec.privacy_link_text, 70) || (en ? 'Privacy policy' : 'Datenschutzerklärung')
  p.check(linkText, 'leadform.privacy')

  const body: Raw = {
    name,
    locale,
    privacy_policy: { url: privacy, link_text: linkText },
    questions,
    is_optimized_for_quality: typ === 'HIGHER_INTENT',
    block_display_for_non_targeted_viewer: spec.nur_beworbene_leads !== false,
  }

  // Intro (context_card)
  const head = cleanText(spec.intro_headline, 60)
  const liste = spec.intro_stil === 'LIST'
  const punkte = arr<unknown>(spec.intro_punkte).map(x => cleanText(x, 80)).filter(Boolean)
  const text = cleanText(spec.intro_text, 600)
  if (liste && punkte.length > 5) throw new WerkzeugError(400, 'invalid_request', 'Intro: höchstens 5 Stichpunkte.')
  if (head || text || punkte.length) {
    const content = liste ? punkte : (text ? [text] : [])
    body.context_card = { title: head || name.slice(0, 60), style: liste ? 'LIST_STYLE' : 'PARAGRAPH_STYLE', content }
    p.check(head, 'leadform.intro')
    for (const c of content) p.check(c, 'leadform.intro')
  }
  const fu = cleanText(spec.fragen_ueberschrift, 60)
  if (fu) { body.question_page_custom_headline = fu; p.check(fu, 'leadform.questions') }

  // Einwilligungen (custom_disclaimer), nie vorausgewählt
  const ew = spec.einwilligungen
  if (ew) {
    const boxes = arr<LeadFormEinwilligung>(ew.checkboxen)
    if (boxes.length > LEADFORM_MAX_EINWILLIGUNGEN) throw new WerkzeugError(400, 'invalid_request', `Höchstens ${LEADFORM_MAX_EINWILLIGUNGEN} Einwilligungs-Kästchen.`)
    const titel = cleanText(ew.titel, 60) || (en ? 'Consent' : 'Einwilligung')
    const etext = cleanText(ew.text, 2000)
    if (!boxes.length && !etext) throw new WerkzeugError(400, 'invalid_request', 'Einwilligung: Text oder mindestens ein Kästchen angeben.')
    const bkeys = new Set<string>()
    body.custom_disclaimer = {
      title: titel,
      body: { text: etext },
      checkboxes: boxes.map((b, j) => {
        const btext = cleanText(b?.text, 300)
        if (!btext) throw new WerkzeugError(400, 'invalid_request', `Einwilligung ${j + 1}: Text fehlt.`)
        const bkey = cleanText(b?.key, 60).replace(KEY_RE, '_') || `einwilligung_${j + 1}`
        if (bkeys.has(bkey)) throw new WerkzeugError(400, 'invalid_request', `Einwilligung ${j + 1}: Schlüssel "${bkey}" doppelt.`)
        bkeys.add(bkey)
        p.check(btext, 'leadform.consent')
        return { key: bkey, text: btext, is_required: b?.pflicht !== false, is_checked_by_default: false }
      }),
    }
    p.check(titel, 'leadform.consent')
    p.check(etext, 'leadform.consent')
  }

  // Abschluss (thank_you_page)
  const tyTitle = cleanText(spec.thank_you_title, 60) || (en ? 'Thank you!' : 'Danke!')
  const tyBody = cleanText(spec.thank_you_body, 600)
  const tyUrl = str(spec.thank_you_url).trim()
  const button = spec.thank_you_button ?? (tyUrl ? 'VIEW_WEBSITE' : 'NONE')
  const ty: Raw = { title: tyTitle, ...(tyBody ? { body: tyBody } : {}), button_type: button }
  if (button === 'VIEW_WEBSITE') {
    if (!HTTPS_URL_RE.test(tyUrl)) throw new WerkzeugError(400, 'invalid_request', 'Der Link auf der Abschluss-Seite muss mit https:// beginnen.')
    const bt = cleanText(spec.thank_you_button_text, 30) || (en ? 'Visit website' : 'Zur Website')
    ty.website_url = tyUrl
    ty.button_text = bt
    body.follow_up_action_url = tyUrl
    p.check(bt, 'leadform.thank_you')
  } else if (button !== 'NONE') {
    throw new WerkzeugError(400, 'invalid_request', 'thank_you_button: VIEW_WEBSITE oder NONE.')
  }
  body.thank_you_page = ty
  p.check(tyTitle, 'leadform.thank_you')
  p.check(tyBody, 'leadform.thank_you')

  if (spec.sms_bestaetigung === true) {
    if (!vordefiniert.has('PHONE')) throw new WerkzeugError(400, 'invalid_request', 'SMS-Bestätigung braucht die Frage Telefonnummer (PHONE).')
    body.is_phone_sms_verify_enabled = true
  }
  const tp = obj(spec.tracking_parameter)
  const tracking: Record<string, string> = {}
  for (const [k, v] of Object.entries(tp).slice(0, 20)) {
    const kk = cleanText(k, 40).replace(KEY_RE, '_')
    const vv = cleanText(v, 100)
    if (kk && vv) tracking[kk] = vv
  }
  if (Object.keys(tracking).length) body.tracking_parameters = tracking

  lintAbbruch(p)
  const warn = p.lint.filter(x => x.severity !== 'blocker')
  if (warn.length) hinweise.push(`${warn.length} Text-Hinweis(e) aus der Prüfung, bitte ansehen.`)
  return { body, hinweise }
}

// ── leadforms_list ───────────────────────────────────────────────────────────

const LIST_FELDER = ['id,name,status,locale,leads_count,created_time,is_optimized_for_quality', 'id,name,status,locale,leads_count,created_time', 'id,name,status,locale']

export async function modeLeadformsList(ctx: Ctx, req: LeadformsListRequest): Promise<LeadformsListResponse> {
  const pageId = await seite(ctx, req.page_id)
  const warnings: string[] = []
  const token = await seitenToken(pageId)
  let daten: Raw[] = []
  let letzterFehler: unknown = null
  for (const [stufe, fields] of LIST_FELDER.entries()) {
    try {
      const out: Raw[] = []
      let after = ''
      for (let s = 0; s < 3; s++) {
        const j = await pageFetch<{ data?: Raw[]; paging?: { cursors?: { after?: string }; next?: string } }>(
          'GET', `${pageId}/leadgen_forms`, token, { fields, limit: 100, ...(after ? { after } : {}) }, GET_TIMEOUT)
        out.push(...arr<Raw>(j?.data))
        after = str(j?.paging?.cursors?.after)
        if (!j?.paging?.next || !after) break
      }
      daten = out
      letzterFehler = null
      if (stufe > 0) warnings.push('Formulare nur mit Grunddaten gelesen (Meta lieferte nicht alle Felder).')
      break
    } catch (e) {
      letzterFehler = e
      if (!(e instanceof MetaApiError) || e.kind !== 'validation') break
    }
  }
  if (letzterFehler) throw letzterFehler
  const items: LeadFormZeile[] = daten.filter(f => str(f.id)).map(f => ({
    id: str(f.id),
    name: str(f.name),
    status: str(f.status) || null,
    locale: str(f.locale) || null,
    leads_count: num(f.leads_count),
    erstellt: isoZeit(f.created_time),
    typ: typVon(f.is_optimized_for_quality),
  }))
  return { page_id: pageId, items, warnings }
}

// ── Formular lesen ───────────────────────────────────────────────────────────

const GET_FELDER = [
  'id,name,status,locale,leads_count,created_time,page{id},questions,privacy_policy_url,legal_content{privacy_policy{url,link_text},custom_disclaimer{title,body,checkboxes}},' +
  'thank_you_page{title,body,button_text,button_type,website_url},context_card{title,style,content,button_text},follow_up_action_url,' +
  'is_optimized_for_quality,block_display_for_non_targeted_viewer,question_page_custom_headline,tracking_parameters,is_phone_sms_verify_enabled',
  'id,name,status,locale,leads_count,created_time,questions,privacy_policy_url,thank_you_page{title,body,button_text,button_type,website_url},' +
  'context_card{title,style,content},follow_up_action_url,is_optimized_for_quality',
  'id,name,status,locale,questions,privacy_policy_url',
]

/** stufe = Index in GET_FELDER (0 = alle Felder; ab 1 fehlen u. a. legal_content und tracking_parameters) */
async function formLesen(pageId: string, token: string, formId: string, warnings: string[]): Promise<{ f: Raw; stufe: number }> {
  let letzter: unknown = null
  for (const [i, fields] of GET_FELDER.entries()) {
    try {
      const f = await pageFetch<Raw>('GET', formId, token, { fields }, GET_TIMEOUT)
      if (i > 0) warnings.push('Formular nur mit Grunddaten gelesen (Meta lieferte nicht alle Felder).')
      const besitzer = str(obj(f.page).id)
      if (besitzer && besitzer !== pageId) throw new WerkzeugError(403, 'forbidden', 'Das Formular gehört zu einer anderen Seite.')
      return { f, stufe: i }
    } catch (e) {
      letzter = e
      if (!(e instanceof MetaApiError) || e.kind !== 'validation') break
    }
  }
  if (letzter instanceof MetaApiError && (letzter.code === 100 || letzter.status === 404)) {
    throw new WerkzeugError(404, 'not_found', `Formular ${formId} nicht gefunden: ${softMsg(letzter)}`)
  }
  throw letzter
}

/** Was eine Rückfallstufe nicht liest (außer legal_content, das wird nachgeladen) */
function nichtGelesen(stufe: number): string[] {
  if (stufe === 0) return []
  const l = ['Tracking-Parameter', 'Fragen-Überschrift', 'SMS-Bestätigung', 'Intro-Button']
  if (stufe > 1) l.push('Intro', 'Abschluss-Seite', 'Formulartyp')
  return l
}

const LEGAL_FELD = 'legal_content{privacy_policy{url,link_text},custom_disclaimer{title,body,checkboxes}}'

/**
 * Die Rückfallstufen lesen kein legal_content (Einwilligungen, Linktext). Dann einzeln
 * nachladen, damit Einwilligungen nie stillschweigend verloren gehen. false = nicht lesbar.
 */
async function rechtstexteNachladen(token: string, formId: string, f: Raw): Promise<boolean> {
  try {
    const j = await pageFetch<Raw>('GET', formId, token, { fields: LEGAL_FELD }, GET_TIMEOUT)
    if (j.legal_content !== undefined && j.legal_content !== null) f.legal_content = j.legal_content
    return true
  } catch (e) {
    console.warn('[meta-werkzeuge] legal_content:', softMsg(e))
    return false
  }
}

function privacyVon(f: Raw): { url: string; link_text: string } {
  const pp = obj(obj(f.legal_content).privacy_policy)
  return { url: str(pp.url) || str(f.privacy_policy_url), link_text: str(pp.link_text) }
}

function trackingVon(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(v)) for (const t of v) { const o = obj(t); if (str(o.key)) out[str(o.key)] = str(o.value) }
  else for (const [k, val] of Object.entries(obj(v))) out[k] = str(val)
  return out
}

/** Meta-Formular -> LeadFormSpecErweitert (für den Editor) */
export function specAusForm(f: Raw): { spec: LeadFormSpecErweitert; nicht: string[] } {
  const nicht: string[] = []
  const erlaubt: readonly string[] = [...LEADFORM_VORDEFINIERT, 'CUSTOM', 'DATE_TIME']
  const questions: LeadFormFrage[] = []
  for (const [i, q0] of arr<Raw>(f.questions).entries()) {
    const q = obj(q0)
    const type = str(q.type)
    if (erlaubt.indexOf(type) < 0) { nicht.push(`Frage ${i + 1} (${type}) gibt es im CRM-Editor nicht.`); continue }
    if (q.conditional_questions_group_id || arr(q.dependent_conditional_questions).length) {
      nicht.push(`Frage ${i + 1}: bedingte Antworten (nur im Werbeanzeigenmanager; beim Kopieren bleiben sie erhalten).`)
    }
    if (type !== 'CUSTOM' && type !== 'DATE_TIME') { questions.push({ type: type as LeadFormFrageTyp }); continue }
    const options = arr<Raw>(q.options).map(o => ({ value: str(obj(o).value), key: str(obj(o).key) || undefined })).filter(o => o.value)
    questions.push({
      type: type as LeadFormFrageTyp,
      ...(str(q.key) ? { key: str(q.key) } : {}),
      label: str(q.label),
      ...(type === 'CUSTOM' ? { custom_art: options.length ? 'MULTIPLE_CHOICE' as const : 'SHORT_ANSWER' as const } : {}),
      ...(options.length ? { options } : {}),
      ...(str(q.inline_context) ? { inline_context: str(q.inline_context) } : {}),
    })
  }
  const cc = obj(f.context_card)
  const ccContent = arr<unknown>(cc.content).map(x => str(x)).filter(Boolean)
  const liste = str(cc.style) === 'LIST_STYLE'
  const ty = obj(f.thank_you_page)
  const bt = str(ty.button_type)
  if (bt && bt !== 'VIEW_WEBSITE' && bt !== 'NONE') nicht.push(`Abschluss-Button ${bt} gibt es im CRM-Editor nicht (wird zu „kein Button“).`)
  const disc = obj(obj(f.legal_content).custom_disclaimer)
  const priv = privacyVon(f)
  const loc = specLocale(f.locale)
  if (!loc && str(f.locale)) nicht.push(`Sprache ${str(f.locale)} gibt es im CRM-Editor nicht (wird Deutsch).`)
  const tracking = trackingVon(f.tracking_parameters)
  const typ = typVon(f.is_optimized_for_quality)
  const spec: LeadFormSpecErweitert = {
    name: str(f.name),
    locale: loc ?? 'de_DE',
    typ: typ ?? 'HIGHER_INTENT',
    privacy_policy_url: priv.url,
    ...(priv.link_text ? { privacy_link_text: priv.link_text } : {}),
    questions,
    ...(str(f.question_page_custom_headline) ? { fragen_ueberschrift: str(f.question_page_custom_headline) } : {}),
    ...(str(cc.title) ? { intro_headline: str(cc.title) } : {}),
    ...(ccContent.length ? (liste ? { intro_stil: 'LIST' as const, intro_punkte: ccContent } : { intro_stil: 'PARAGRAPH' as const, intro_text: ccContent.join('\n') }) : {}),
    ...(Object.keys(disc).length ? {
      einwilligungen: {
        ...(str(disc.title) ? { titel: str(disc.title) } : {}),
        ...(str(obj(disc.body).text) || str(disc.body) ? { text: str(obj(disc.body).text) || str(disc.body) } : {}),
        checkboxen: arr<Raw>(disc.checkboxes).map(b => ({
          ...(str(obj(b).key) ? { key: str(obj(b).key) } : {}),
          text: str(obj(b).text),
          pflicht: obj(b).is_required !== false,
        })),
      },
    } : {}),
    ...(str(ty.title) ? { thank_you_title: str(ty.title) } : {}),
    ...(str(ty.body) ? { thank_you_body: str(ty.body) } : {}),
    thank_you_button: bt === 'VIEW_WEBSITE' ? 'VIEW_WEBSITE' : 'NONE',
    ...(str(ty.button_text) ? { thank_you_button_text: str(ty.button_text) } : {}),
    ...(str(ty.website_url) || str(f.follow_up_action_url) ? { thank_you_url: str(ty.website_url) || str(f.follow_up_action_url) } : {}),
    ...(f.is_phone_sms_verify_enabled === true ? { sms_bestaetigung: true } : {}),
    nur_beworbene_leads: f.block_display_for_non_targeted_viewer !== false,
    ...(Object.keys(tracking).length ? { tracking_parameter: tracking } : {}),
    wohnen: true,
  }
  if (!priv.url) nicht.push('Datenschutz-Link nicht lesbar: vor dem Speichern eintragen.')
  return { spec, nicht }
}

export async function modeLeadformGet(ctx: Ctx, req: LeadformGetRequest): Promise<LeadformGetResponse> {
  const pageId = await seite(ctx, req.page_id)
  const formId = metaId(req.id, 'Formular-ID')
  const warnings: string[] = []
  const token = await seitenToken(pageId)
  const { f, stufe } = await formLesen(pageId, token, formId, warnings)
  const rechtOk = stufe === 0 || await rechtstexteNachladen(token, formId, f)
  const { spec, nicht } = specAusForm(f)
  if (!rechtOk) nicht.push('Einwilligungen und Text des Datenschutz-Links nicht lesbar: vor dem Speichern prüfen und neu eintragen.')
  if (stufe > 0) nicht.push(`Nicht lesbar: ${nichtGelesen(stufe).join(', ')}. Vor dem Speichern prüfen.`)
  return {
    form: {
      id: str(f.id) || formId, name: str(f.name), status: str(f.status) || null, locale: str(f.locale) || null,
      leads_count: num(f.leads_count), erstellt: isoZeit(f.created_time), typ: typVon(f.is_optimized_for_quality),
      page_id: str(obj(f.page).id) || pageId,
    },
    spec,
    nicht_uebernommen: nicht,
    warnings,
  }
}

// ── Anlegen ──────────────────────────────────────────────────────────────────

async function formAnlegen(ctx: Ctx, pageId: string, token: string, body: Raw): Promise<string> {
  const path = `${pageId}/leadgen_forms`
  try {
    const res = await pageFetch<Raw>('POST', path, token, body, POST_TIMEOUT)
    const formId = str(res.id)
    await logWrite(ctx, { level: 'leadform', path, entityId: formId || null, request: body, after: res })
    if (!formId) throw new WerkzeugError(502, 'meta_error', 'Meta hat keine Formular-ID zurückgegeben.')
    return formId
  } catch (err) {
    if (err instanceof MetaApiError) await logWrite(ctx, { level: 'leadform', path, request: body, err })
    throw err
  }
}

export async function modeLeadformCreate(ctx: Ctx, req: LeadformCreateWerkzeugRequest): Promise<LeadformCreateWerkzeugResponse> {
  const pageId = await seite(ctx, req.page_id)
  const spec = obj(req.spec) as unknown as LeadFormSpecErweitert
  const { body, hinweise } = await formBody(ctx, spec)
  if (req.vorschau === true) return { vorschau: true, form_id: null, page_id: pageId, payload: body, hinweise }
  const token = await seitenToken(pageId)
  const formId = await formAnlegen(ctx, pageId, token, body)
  hinweise.push('Formular angelegt. Es lässt sich bei Meta nicht mehr ändern, nur kopieren.')
  return { vorschau: false, form_id: formId, page_id: pageId, payload: body, hinweise }
}

// ── Kopieren ─────────────────────────────────────────────────────────────────

const FRAGE_FELDER = ['type', 'key', 'label', 'options', 'inline_context', 'conditional_questions_group_id', 'dependent_conditional_questions', 'context_provider_type']

function rohFrage(q: Raw): Raw {
  const out: Raw = {}
  for (const k of FRAGE_FELDER) if (q[k] !== undefined && q[k] !== null && q[k] !== '') out[k] = q[k]
  if (Array.isArray(out.options)) out.options = arr<Raw>(out.options).map(o => ({ value: str(obj(o).value), key: str(obj(o).key) }))
  return out
}

export async function modeLeadformDuplicate(ctx: Ctx, req: LeadformDuplicateRequest): Promise<LeadformDuplicateResponse> {
  const pageId = await seite(ctx, req.page_id)
  const quelleId = metaId(req.id, 'Formular-ID')
  const name = cleanText(req.name, 200)
  if (!name) throw new WerkzeugError(400, 'invalid_request', 'Die Kopie braucht einen Namen.')
  const hinweise: string[] = []
  const token = await seitenToken(pageId)
  const { f, stufe } = await formLesen(pageId, token, quelleId, hinweise)
  if (stufe > 0) {
    // Einwilligungen dürfen nie stillschweigend wegfallen: einzeln nachladen oder abbrechen
    if (!(await rechtstexteNachladen(token, quelleId, f))) {
      throw new WerkzeugError(422, 'unsupported', 'Die Einwilligungen des Formulars sind nicht lesbar. Kopie abgebrochen, damit keine Einwilligung verloren geht.',
        'Formular mit leadform_get laden, Einwilligungen prüfen und mit leadform_create neu anlegen.')
    }
    hinweise.push(`Meta lieferte nicht alle Felder; nicht kopiert: ${nichtGelesen(stufe).join(', ')}. Kopie vor dem Einsatz prüfen.`)
  }

  const priv = privacyVon(f)
  if (!HTTPS_URL_RE.test(priv.url)) {
    throw new WerkzeugError(422, 'unsupported', 'Der Datenschutz-Link des Formulars ist nicht lesbar.', 'Formular mit leadform_get laden, Link eintragen und mit leadform_create neu anlegen.')
  }
  const fragen = arr<Raw>(f.questions).map(q => rohFrage(obj(q)))
  if (!fragen.length) throw new WerkzeugError(422, 'unsupported', 'Die Fragen des Formulars sind nicht lesbar.')
  wohnenAbbruch(fragen.map(q => str(q.type)), req.wohnen !== false)

  const locale = metaLocale(f.locale)
  if (str(f.locale) && !specLocale(f.locale)) hinweise.push(`Sprache ${str(f.locale).slice(0, 10)} gibt es im CRM nicht: die Kopie wird als Deutsch angelegt.`)
  const p = await pruefer(ctx, locale)
  for (const q of fragen) {
    p.check(str(q.label), 'leadform.questions')
    p.check(str(q.inline_context), 'leadform.questions')
    for (const o of arr<Raw>(q.options)) p.check(str(o.value), 'leadform.questions')
  }

  const linkText = priv.link_text || (locale === 'DE_DE' ? 'Datenschutzerklärung' : 'Privacy policy')
  p.check(linkText, 'leadform.privacy')
  const body: Raw = {
    name,
    locale,
    privacy_policy: { url: priv.url, link_text: linkText },
    questions: fragen,
    is_optimized_for_quality: f.is_optimized_for_quality !== false,
    block_display_for_non_targeted_viewer: f.block_display_for_non_targeted_viewer !== false,
  }
  if (f.is_optimized_for_quality === undefined) hinweise.push('Formulartyp nicht lesbar: Kopie als „Höhere Absicht“.')
  const cc = obj(f.context_card)
  if (str(cc.title) || arr(cc.content).length) {
    const content = arr<unknown>(cc.content).map(x => str(x)).filter(Boolean)
    body.context_card = { title: str(cc.title) || name.slice(0, 60), style: str(cc.style) || 'PARAGRAPH_STYLE', content, ...(str(cc.button_text) ? { button_text: str(cc.button_text) } : {}) }
    p.check(str(cc.title), 'leadform.intro')
    for (const c of content) p.check(c, 'leadform.intro')
    p.check(str(cc.button_text), 'leadform.intro')
    hinweise.push('Ein Intro-Hintergrundbild wird nicht mitkopiert.')
  }
  if (str(f.question_page_custom_headline)) {
    body.question_page_custom_headline = str(f.question_page_custom_headline)
    p.check(str(f.question_page_custom_headline), 'leadform.questions')
  }
  const disc = obj(obj(f.legal_content).custom_disclaimer)
  if (Object.keys(disc).length) {
    const text = str(obj(disc.body).text) || str(disc.body)
    const checkboxes = arr<Raw>(disc.checkboxes).map((b, j) => ({
      key: str(obj(b).key) || `einwilligung_${j + 1}`, text: str(obj(b).text),
      is_required: obj(b).is_required !== false, is_checked_by_default: false,
    }))
    body.custom_disclaimer = { title: str(disc.title) || 'Einwilligung', body: { text }, checkboxes }
    p.check(str(disc.title), 'leadform.consent')
    p.check(text, 'leadform.consent')
    for (const b of checkboxes) p.check(b.text, 'leadform.consent')
  }
  // Abschluss-Seite: wie beim Anlegen nur Website-Button oder keiner (andere Buttons
  // brauchen Telefonnummer/Ländercode, deren Format nicht bestätigt ist)
  const ty = obj(f.thank_you_page)
  const tyOut: Raw = {}
  for (const k of ['title', 'body']) if (str(ty[k])) tyOut[k] = ty[k]
  if (!tyOut.title) tyOut.title = locale === 'DE_DE' ? 'Danke!' : 'Thank you!'
  const btIn = str(ty.button_type) || (str(ty.website_url) ? 'VIEW_WEBSITE' : 'NONE')
  const tyUrl = str(ty.website_url) || str(f.follow_up_action_url)
  if (btIn === 'VIEW_WEBSITE' && HTTPS_URL_RE.test(tyUrl)) {
    tyOut.button_type = 'VIEW_WEBSITE'
    tyOut.website_url = tyUrl
    tyOut.button_text = str(ty.button_text) || (locale === 'DE_DE' ? 'Zur Website' : 'Visit website')
    p.check(str(tyOut.button_text), 'leadform.thank_you')
  } else {
    if (btIn === 'VIEW_WEBSITE') hinweise.push('Der Link der Abschluss-Seite ist kein https-Link: Kopie ohne Button.')
    else if (btIn !== 'NONE') hinweise.push(`Abschluss-Button ${btIn.slice(0, 30)} wird nicht kopiert (nur „Zur Website“ oder kein Button).`)
    tyOut.button_type = 'NONE'
  }
  body.thank_you_page = tyOut
  p.check(str(tyOut.title), 'leadform.thank_you')
  p.check(str(tyOut.body), 'leadform.thank_you')
  if (str(f.follow_up_action_url)) body.follow_up_action_url = str(f.follow_up_action_url)
  if (f.is_phone_sms_verify_enabled === true) body.is_phone_sms_verify_enabled = true
  const tracking = trackingVon(f.tracking_parameters)
  if (Object.keys(tracking).length) body.tracking_parameters = tracking
  lintAbbruch(p)

  if (req.vorschau === true) return { vorschau: true, form_id: null, quelle_id: quelleId, page_id: pageId, payload: body, hinweise }
  const formId = await formAnlegen(ctx, pageId, token, body)
  hinweise.push('Kopie angelegt. Das Original bleibt unverändert.')
  return { vorschau: false, form_id: formId, quelle_id: quelleId, page_id: pageId, payload: body, hinweise }
}
