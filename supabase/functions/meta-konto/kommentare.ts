// meta-konto: Kommentare unter Anzeigen-Beiträgen lesen, beantworten, ausblenden.
//
// Facebook: Beitrag = creative.effective_object_story_id („<seite>_<beitrag>“),
//   Kommentare GET /{story}/comments, Antwort POST /{comment}/comments,
//   Ausblenden POST /{comment} {is_hidden}. Immer mit dem Seiten-Token.
// Instagram: Beitrag = creative.effective_instagram_media_id, Konto = das mit der
//   Seite verbundene instagram_business_account. Kommentare GET /{media}/comments,
//   Antwort POST /{comment}/replies, Ausblenden POST /{comment} {hide}.
//   [unverifiziert] Seiten-Token reicht für die Instagram-Endpunkte, solange der
//   System-User instagram_basic + instagram_manage_comments hat (Test mit echtem Konto offen).
// Nur die Standard-Seite (ad_settings.default_page_id) und ihr Instagram-Konto:
// Beiträge anderer Seiten werden übersprungen.
// Von Kommentierenden geben wir nur den Namen aus, nie IDs; Texte und Namen
// erscheinen nie in Logs (meta_write_log bekommt nur Länge und SHA-256 der Antwort).

import { lintText } from '../_shared/metaLint.ts'
import { graphAll, graphGet, MetaApiError } from '../_shared/metaGraph.ts'
import {
  arr, auslastungHoch, cleanText, COMMENT_ID_RE, forbiddenNames, isoZeit, KontoError, logWrite, mapPool, metaId, num,
  obj, pageFetch, reservieren, RESERVIERUNG_FREI, type Ctx, type Raw, seitenToken, sha256Hex, softMsg, STORY_ID_RE, str,
  uniq, usageInfo,
} from './common.ts'
import {
  KOMMENTAR_LINT_BLOCKER, KOMMENTAR_PLATTFORMEN, KOMMENTAR_TEXT_MAX,
  type Kommentar, type KommentarAntwort, type KommentarAntwortenRequest, type KommentarAntwortenResponse,
  type KommentarAnzeigeRef, type KommentarAusblendenRequest, type KommentarAusblendenResponse, type KommentarBeitrag,
  type KommentareListRequest, type KommentareListResponse, type KommentarLintTreffer, type KommentarPlattform,
} from './typen.ts'

const AD_FELDER = 'id,name,effective_status,account_id,creative{id,effective_object_story_id,effective_instagram_media_id,instagram_permalink_url}'
const AD_STATUS = [
  'ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW',
  'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO',
]
// Antworten neueste zuerst: sonst fehlt unsere Antwort, wenn vor ihr schon viele andere stehen
const FB_FELDER = 'id,message,created_time,from{id,name},is_hidden,can_hide,can_comment,comment_count,like_count,permalink_url,comments.order(reverse_chronological).limit(25){id,message,created_time,from{id,name}}'
const FB_FELDER_MIN = 'id,message,created_time,from{id,name},is_hidden,can_hide,comment_count,permalink_url'
const IG_FELDER = 'id,text,timestamp,username,hidden,like_count,from{id,username},replies{id,text,timestamp,username,from{id}}'
const IG_FELDER_MIN = 'id,text,timestamp,username,hidden,like_count,replies{id,text,timestamp,username}'
const KOMMENTARE_JE_BEITRAG = 50
const MAX_AD_IDS = 25
const DOPPELKLICK_MS = 120_000

// ── Eingaben ────────────────────────────────────────────────────────────────

function plattformParam(v: unknown): KommentarPlattform {
  const p = str(v).trim().toLowerCase()
  if ((KOMMENTAR_PLATTFORMEN as readonly string[]).indexOf(p) < 0) {
    throw new KontoError(400, 'invalid_request', 'Plattform fehlt: „facebook“ oder „instagram“.')
  }
  return p as KommentarPlattform
}

function kommentarId(v: unknown): string {
  const s = str(v).trim()
  if (!COMMENT_ID_RE.test(s)) throw new KontoError(400, 'invalid_request', 'Kommentar-ID fehlt oder ist ungültig.')
  return s
}

const istFeldFehler = (e: unknown): boolean => e instanceof MetaApiError && e.kind === 'validation'

// ── Anzeigen und Beiträge ───────────────────────────────────────────────────

interface AnzeigeInfo { id: string; name: string; status: string | null; story: string; igMedia: string; igLink: string }

function anzeigeAus(r: Raw): AnzeigeInfo {
  const c = obj(r.creative)
  return {
    id: str(r.id), name: str(r.name) || str(r.id), status: str(r.effective_status) || null,
    story: str(c.effective_object_story_id), igMedia: str(c.effective_instagram_media_id), igLink: str(c.instagram_permalink_url),
  }
}

async function ladeAnzeigen(ctx: Ctx, req: KommentareListRequest, hinweise: string[]): Promise<AnzeigeInfo[]> {
  const account = ctx.env.account
  if (req.ad_ids !== undefined && req.ad_ids !== null) {
    if (!Array.isArray(req.ad_ids)) throw new KontoError(400, 'invalid_request', 'ad_ids muss eine Liste sein.')
    const ids = uniq(req.ad_ids.map((v, i) => metaId(v, `Anzeigen-ID ${i + 1}`)))
    if (!ids.length) throw new KontoError(400, 'invalid_request', 'ad_ids ist leer.')
    if (ids.length > MAX_AD_IDS) throw new KontoError(400, 'invalid_request', `Höchstens ${MAX_AD_IDS} Anzeigen je Abruf.`)
    let fremd = 0
    let fehler = 0
    const rows = await mapPool(ids, 3, async id => {
      try {
        const r = await graphGet<Raw>(id, { fields: AD_FELDER })
        if (str(r.account_id) && str(r.account_id) !== account) { fremd++; return null }
        return anzeigeAus(r)
      } catch (e) {
        fehler++
        console.warn(`[meta-konto] Anzeige ${id}: ${softMsg(e)}`)
        return null
      }
    })
    if (fremd) hinweise.push(`${fremd} Anzeige(n) gehören nicht zum Werbekonto und wurden übersprungen.`)
    if (fehler) hinweise.push(`${fehler} Anzeige(n) nicht lesbar.`)
    return rows.filter((r): r is AnzeigeInfo => r !== null)
  }
  const list = await graphAll<Raw>(`act_${account}/ads`, { fields: AD_FELDER, effective_status: AD_STATUS, limit: 50 }, { maxPages: 2 })
  const ads = list.map(anzeigeAus).filter(a => a.id)
  // aktive zuerst, sonst Metas Reihenfolge (neueste zuerst)
  return ads.filter(a => a.status === 'ACTIVE').concat(ads.filter(a => a.status !== 'ACTIVE'))
}

interface Beitrag {
  plattform: KommentarPlattform
  id: string
  link: string | null
  anzeigen: KommentarAnzeigeRef[]
}

function beitraegeBilden(ads: AnzeigeInfo[], pageId: string, plattform: KommentarPlattform | null, hinweise: string[]): { beitraege: Beitrag[]; ohne: number } {
  const map = new Map<string, Beitrag>()
  let ohne = 0
  let fremdeSeite = 0
  for (const a of ads) {
    const ref: KommentarAnzeigeRef = { id: a.id, name: a.name, status: a.status }
    let hat = false
    const m = STORY_ID_RE.exec(a.story)
    if (m) {
      hat = true
      if (m[1] !== pageId) fremdeSeite++
      else if (plattform !== 'instagram') {
        const key = `facebook:${a.story}`
        const b = map.get(key) ?? { plattform: 'facebook' as const, id: a.story, link: `https://www.facebook.com/${a.story}`, anzeigen: [] }
        b.anzeigen.push(ref)
        map.set(key, b)
      }
    }
    if (/^[0-9]{6,25}$/.test(a.igMedia)) {
      hat = true
      if (plattform !== 'facebook') {
        const key = `instagram:${a.igMedia}`
        const link = /^https:\/\/(www\.)?instagram\.com\//.test(a.igLink) ? a.igLink : null
        const b = map.get(key) ?? { plattform: 'instagram' as const, id: a.igMedia, link, anzeigen: [] }
        if (!b.link && link) b.link = link
        b.anzeigen.push(ref)
        map.set(key, b)
      }
    }
    if (!hat) ohne++
  }
  if (fremdeSeite) hinweise.push(`${fremdeSeite} Anzeige(n) laufen über eine andere Facebook-Seite: deren Kommentare werden nicht geladen.`)
  return { beitraege: Array.from(map.values()), ohne }
}

// ── Instagram-Konto der Seite ───────────────────────────────────────────────

interface IgKonto { id: string; name: string | null }

async function igKonto(ctx: Ctx, token: string, pageId: string): Promise<IgKonto | null> {
  try {
    const p = await pageFetch<Raw>('GET', pageId, token, { fields: 'instagram_business_account{id,username}' })
    const ig = obj(p.instagram_business_account)
    if (/^[0-9]{6,25}$/.test(str(ig.id))) return { id: str(ig.id), name: str(ig.username) || null }
  } catch (e) {
    console.warn(`[meta-konto] Instagram-Konto der Seite: ${softMsg(e)}`)
  }
  const st = await ctx.settings()
  return st.default_ig_user_id ? { id: st.default_ig_user_id, name: null } : null
}

// ── Kommentare je Beitrag ───────────────────────────────────────────────────

interface Roh {
  id: string
  text: string
  zeit: string | null
  autor: string | null
  vonUns: boolean
  ausgeblendet: boolean
  antworten: KommentarAntwort[]
  /** alle Antworten geladen (sonst ist „beantwortet“ ohne eigene Antwort unbekannt) */
  antwortenVollstaendig: boolean
  antwortenAnzahl: number
  likes: number | null
  kannAusblenden: boolean | null
  kannAntworten: boolean | null
  link: string | null
}

async function facebookKommentare(story: string, token: string, pageId: string): Promise<{ liste: Roh[]; gekuerzt: boolean }> {
  const params = { filter: 'toplevel', order: 'reverse_chronological', limit: KOMMENTARE_JE_BEITRAG }
  let res: Raw
  let mitAntworten = true
  try {
    res = await pageFetch<Raw>('GET', `${story}/comments`, token, { ...params, fields: FB_FELDER })
  } catch (e) {
    if (!istFeldFehler(e)) throw e
    res = await pageFetch<Raw>('GET', `${story}/comments`, token, { ...params, fields: FB_FELDER_MIN })
    mitAntworten = false
  }
  const liste = arr<Raw>(res.data).map((c): Roh => {
    const from = obj(c.from)
    const antworten = arr<Raw>(obj(c.comments).data).map((a): KommentarAntwort => {
      const af = obj(a.from)
      return { id: str(a.id), text: str(a.message), zeit: isoZeit(a.created_time), von_uns: str(af.id) === pageId, autor: str(af.name) || null }
    }).sort((a, b) => (a.zeit ?? '').localeCompare(b.zeit ?? ''))
    // Ohne Antwort-Felder ist nur „keine Antworten“ (comment_count 0) sicher
    const vollstaendig = mitAntworten ? !str(obj(obj(c.comments).paging).next) : num(c.comment_count) === 0
    return {
      id: str(c.id), text: str(c.message), zeit: isoZeit(c.created_time), autor: str(from.name) || null,
      vonUns: str(from.id) === pageId, ausgeblendet: c.is_hidden === true, antworten, antwortenVollstaendig: vollstaendig,
      antwortenAnzahl: num(c.comment_count) ?? antworten.length, likes: num(c.like_count),
      kannAusblenden: typeof c.can_hide === 'boolean' ? c.can_hide : null,
      kannAntworten: typeof c.can_comment === 'boolean' ? c.can_comment : null,
      link: /^https:\/\//.test(str(c.permalink_url)) ? str(c.permalink_url) : null,
    }
  })
  return { liste, gekuerzt: Boolean(str(obj(res.paging).next)) }
}

async function instagramKommentare(media: string, token: string, ig: IgKonto | null, link: string | null): Promise<{ liste: Roh[]; gekuerzt: boolean }> {
  let res: Raw
  try {
    res = await pageFetch<Raw>('GET', `${media}/comments`, token, { fields: IG_FELDER, limit: KOMMENTARE_JE_BEITRAG })
  } catch (e) {
    if (!istFeldFehler(e)) throw e
    res = await pageFetch<Raw>('GET', `${media}/comments`, token, { fields: IG_FELDER_MIN, limit: KOMMENTARE_JE_BEITRAG })
  }
  const unser = (r: Raw): boolean => {
    if (!ig) return false
    const fid = str(obj(r.from).id)
    if (fid) return fid === ig.id
    return Boolean(ig.name) && str(r.username).toLowerCase() === String(ig.name).toLowerCase()
  }
  const liste = arr<Raw>(res.data).map((c): Roh => {
    const antworten = arr<Raw>(obj(c.replies).data).map((a): KommentarAntwort => ({
      id: str(a.id), text: str(a.text), zeit: isoZeit(a.timestamp), von_uns: unser(a), autor: str(a.username) || null,
    }))
    const eigen = unser(c)
    return {
      id: str(c.id), text: str(c.text), zeit: isoZeit(c.timestamp), autor: str(c.username) || null,
      vonUns: eigen, ausgeblendet: c.hidden === true, antworten,
      antwortenVollstaendig: !str(obj(obj(c.replies).paging).next), antwortenAnzahl: antworten.length,
      likes: num(c.like_count), kannAusblenden: !eigen, kannAntworten: true, link,
    }
  })
  return { liste, gekuerzt: Boolean(str(obj(res.paging).next)) }
}

// ── kommentare_list ─────────────────────────────────────────────────────────

export async function modeKommentareList(ctx: Ctx, req: KommentareListRequest): Promise<KommentareListResponse> {
  const hinweise: string[] = []
  const plattform = req.plattform === undefined || req.plattform === null ? null : plattformParam(req.plattform)
  let sinceMs: number | null = null
  if (req.since !== undefined && req.since !== null && str(req.since).trim()) {
    const t = Date.parse(str(req.since))
    if (!Number.isFinite(t)) throw new KontoError(400, 'invalid_request', 'since ist kein gültiges Datum (ISO, z. B. 2026-10-01).')
    sinceMs = t
  }
  const maxRoh = req.max_beitraege === undefined || req.max_beitraege === null ? 30 : num(req.max_beitraege)
  if (maxRoh === null || !Number.isInteger(maxRoh) || maxRoh < 1 || maxRoh > 60) {
    throw new KontoError(400, 'invalid_request', 'max_beitraege: bitte eine ganze Zahl von 1 bis 60.')
  }
  const nurOffen = req.nur_unbeantwortet === true

  const st = await ctx.settings()
  const pageId = st.default_page_id
  const ads = await ladeAnzeigen(ctx, req, hinweise)
  const { beitraege: alle, ohne } = beitraegeBilden(ads, pageId, plattform, hinweise)
  let gekuerzt = alle.length > maxRoh
  const beitraege = alle.slice(0, maxRoh)
  if (gekuerzt) hinweise.push(`Nur die ersten ${maxRoh} von ${alle.length} Beiträgen abgefragt (aktive Anzeigen zuerst).`)

  const leer = (ig: IgKonto | null): KommentareListResponse => ({
    kommentare: [], beitraege: [], anzahl: 0, offen: 0, anzeigen_geprueft: ads.length, anzeigen_ohne_beitrag: ohne,
    gekuerzt, instagram_konto: ig, hinweise, geladen: new Date().toISOString(), usage: usageInfo(),
  })
  if (!beitraege.length) return leer(null)

  const token = await seitenToken(pageId)
  const ig = beitraege.some(b => b.plattform === 'instagram') ? await igKonto(ctx, token, pageId) : null
  if (beitraege.some(b => b.plattform === 'instagram') && !ig) {
    hinweise.push('Kein Instagram-Konto mit der Facebook-Seite verbunden: „beantwortet“ bei Instagram nicht erkennbar.')
  }

  const kommentare: Kommentar[] = []
  let unbekannt = 0
  const ergebnis: KommentarBeitrag[] = await mapPool(beitraege, 3, async (b): Promise<KommentarBeitrag> => {
    const basis = { beitrag_id: b.id, plattform: b.plattform, link: b.link, anzeigen: b.anzeigen }
    if (auslastungHoch()) {
      gekuerzt = true
      return { ...basis, anzahl: 0, offen: 0, gekuerzt: true, fehler: 'Meta-Auslastung hoch: übersprungen.' }
    }
    try {
      const { liste, gekuerzt: mehr } = b.plattform === 'facebook'
        ? await facebookKommentare(b.id, token, pageId)
        : await instagramKommentare(b.id, token, ig, b.link)
      let anzahl = 0
      let offen = 0
      for (const k of liste) {
        if (k.vonUns || !k.id) continue
        const zeitMs = k.zeit ? Date.parse(k.zeit) : NaN
        if (sinceMs !== null && !(zeitMs >= sinceMs)) continue
        // null = unbekannt: Meta lieferte nicht alle Antworten und keine davon ist von uns
        const beantwortet = k.antworten.some(a => a.von_uns) ? true : k.antwortenVollstaendig ? false : null
        if (nurOffen && beantwortet === true) continue
        anzahl++
        if (beantwortet === null) unbekannt++
        if (beantwortet === false && !k.ausgeblendet) offen++
        kommentare.push({
          id: k.id, plattform: b.plattform, ad_id: b.anzeigen[0].id, ad_name: b.anzeigen[0].name,
          weitere_anzeigen: b.anzeigen.slice(1), beitrag_id: b.id, beitrag_link: b.link, link: k.link ?? b.link,
          autor: k.autor, text: k.text, zeit: k.zeit, ausgeblendet: k.ausgeblendet, beantwortet,
          antworten: k.antworten, antworten_anzahl: k.antwortenAnzahl, likes: k.likes,
          kann_ausblenden: k.kannAusblenden, kann_antworten: k.kannAntworten,
        })
      }
      return { ...basis, anzahl, offen, gekuerzt: mehr, fehler: null }
    } catch (e) {
      console.warn(`[meta-konto] Kommentare ${b.plattform} ${b.id}: ${softMsg(e)}`)
      return { ...basis, anzahl: 0, offen: 0, gekuerzt: false, fehler: `Nicht lesbar: ${softMsg(e)}` }
    }
  })
  const fehler = ergebnis.filter(b => b.fehler && !b.fehler.startsWith('Meta-Auslastung')).length
  if (fehler) hinweise.push(`${fehler} Beitrag/Beiträge nicht lesbar (Rechte der Seite bzw. des Instagram-Kontos prüfen).`)
  if (ergebnis.some(b => b.fehler?.startsWith('Meta-Auslastung'))) hinweise.push('Meta-Auslastung hoch: nicht alle Beiträge abgefragt.')
  if (unbekannt) {
    hinweise.push(`Bei ${unbekannt} Kommentar(en) ist nicht erkennbar, ob wir schon geantwortet haben (Meta lieferte nicht alle Antworten). Diese zählen nicht als offen.`)
  }

  kommentare.sort((a, b) => (b.zeit ?? '').localeCompare(a.zeit ?? ''))
  console.log(`[meta-konto] kommentare_list: ${ads.length} Anzeigen, ${beitraege.length} Beiträge, ${kommentare.length} Kommentare`)
  return {
    kommentare,
    beitraege: ergebnis,
    anzahl: kommentare.length,
    offen: kommentare.filter(k => k.beantwortet === false && !k.ausgeblendet).length,
    anzeigen_geprueft: ads.length,
    anzeigen_ohne_beitrag: ohne,
    gekuerzt,
    instagram_konto: ig,
    hinweise,
    geladen: new Date().toISOString(),
    usage: usageInfo(),
  }
}

// ── Kommentar gehört zu uns? ────────────────────────────────────────────────

interface KommentarStand { ausgeblendet: boolean | null }

async function pruefeKommentar(
  ctx: Ctx, plattform: KommentarPlattform, commentId: string, token: string, pageId: string,
  beitragId: unknown, zweck: 'antworten' | 'ausblenden',
): Promise<KommentarStand> {
  const fremd = () => new KontoError(403, 'forbidden', 'Der Kommentar steht nicht unter einem Beitrag unserer Seite bzw. unseres Instagram-Kontos.')
  const nichtGefunden = (e: unknown) => {
    console.warn(`[meta-konto] Kommentar prüfen: ${softMsg(e)}`)
    return new KontoError(404, 'not_found', 'Kommentar nicht gefunden (gelöscht oder nicht unter unseren Beiträgen).', 'Liste neu laden.')
  }
  const eigen = () => new KontoError(400, 'invalid_request', zweck === 'antworten'
    ? 'Das ist ein Kommentar von uns selbst.' : 'Eigene Kommentare kann man nicht ausblenden.')
  const beitrag = str(beitragId).trim()

  if (plattform === 'facebook') {
    if (beitrag) {
      const m = STORY_ID_RE.exec(beitrag)
      if (!m || m[1] !== pageId) throw fremd()
    }
    let c: Raw
    try {
      c = await pageFetch<Raw>('GET', commentId, token, { fields: 'id,is_hidden,can_hide,can_comment,from{id}' })
    } catch (e) {
      throw nichtGefunden(e)
    }
    if (str(obj(c.from).id) === pageId) throw eigen()
    // can_hide ist nur true, wenn der Kommentar unter einem Beitrag unserer Seite steht
    if (c.can_hide !== true) throw fremd()
    if (zweck === 'antworten' && c.can_comment === false) {
      throw new KontoError(409, 'invalid_request', 'Meta erlaubt auf diesen Kommentar keine Antwort.')
    }
    return { ausgeblendet: typeof c.is_hidden === 'boolean' ? c.is_hidden : null }
  }

  const ig = await igKonto(ctx, token, pageId)
  if (!ig) {
    throw new KontoError(403, 'forbidden', 'Mit der Facebook-Seite ist kein Instagram-Konto verbunden.',
      'Instagram-Konto in der Meta Business Suite mit der Seite verbinden und dem System-User zuweisen.')
  }
  let c: Raw
  try {
    c = await pageFetch<Raw>('GET', commentId, token, { fields: 'id,hidden,username,from{id},media{id}' })
  } catch (e) {
    if (!istFeldFehler(e)) throw nichtGefunden(e)
    try {
      c = await pageFetch<Raw>('GET', commentId, token, { fields: 'id,hidden,username,media{id}' })
    } catch (e2) {
      throw nichtGefunden(e2)
    }
  }
  const mediaId = str(obj(c.media).id)
  if (!/^[0-9]{6,25}$/.test(mediaId)) throw fremd()
  if (beitrag && beitrag !== mediaId) throw fremd()
  let m: Raw
  try {
    m = await pageFetch<Raw>('GET', mediaId, token, { fields: 'id,owner,username' })
  } catch (e) {
    throw nichtGefunden(e)
  }
  // [unverifiziert] owner kommt nur zurück, wenn das abfragende Konto den Beitrag besitzt; sonst username
  const ownerId = str(obj(m.owner).id) || str(m.owner)
  const gehoertUns = ownerId ? ownerId === ig.id : Boolean(ig.name) && str(m.username).toLowerCase() === String(ig.name).toLowerCase()
  if (!gehoertUns) throw fremd()
  const fromId = str(obj(c.from).id)
  if ((fromId && fromId === ig.id) || (!fromId && ig.name && str(c.username).toLowerCase() === ig.name.toLowerCase())) throw eigen()
  return { ausgeblendet: typeof c.hidden === 'boolean' ? c.hidden : null }
}

// ── kommentar_antworten ─────────────────────────────────────────────────────

const REGEL_TEXT: Record<string, string> = {
  gedankenstrich: 'Gedankenstrich durch normalen Bindestrich ersetzen',
  umlaut: 'echte Umlaute (ä, ö, ü, ß) statt ae, oe, ue schreiben',
  projektname: 'keine Projekt- oder Bauträgernamen nennen',
  rendite_prozent: 'keine Renditen oder Erträge mit Prozentzahlen nennen',
  finanzierung: 'keine Finanzierung zusagen (z. B. „ohne Eigenkapital“)',
  garantie: 'nichts garantieren und keine Sicherheit versprechen',
}

export async function modeKommentarAntworten(ctx: Ctx, req: KommentarAntwortenRequest): Promise<KommentarAntwortenResponse> {
  if (ctx.caller.system) {
    throw new KontoError(403, 'forbidden', 'Antworten auf Kommentare gehen nur per Klick im CRM, nicht automatisch.')
  }
  if (req.confirm !== true) throw new KontoError(400, 'invalid_request', 'Bitte die Antwort ausdrücklich bestätigen (confirm: true).')
  const plattform = plattformParam(req.plattform)
  const commentId = kommentarId(req.comment_id)
  const text = cleanText(req.text, KOMMENTAR_TEXT_MAX + 1)
  if (!text) throw new KontoError(400, 'invalid_request', 'Der Antworttext fehlt.')
  if (text.length > KOMMENTAR_TEXT_MAX) throw new KontoError(400, 'invalid_request', `Die Antwort ist zu lang (höchstens ${KOMMENTAR_TEXT_MAX} Zeichen).`)

  const issues = lintText(text, 'kommentar', { forbiddenNames: await forbiddenNames(ctx.sb) })
  const treffer: KommentarLintTreffer[] = issues.map(i => ({ regel: i.rule, schwere: i.severity, fundstelle: i.match ?? null, meldung_key: i.messageKey }))
  const blocker = treffer.filter(t => KOMMENTAR_LINT_BLOCKER.indexOf(t.regel) >= 0)
  if (blocker.length) {
    const was = uniq(blocker.map(t => REGEL_TEXT[t.regel] ?? t.regel)).join('; ')
    throw new KontoError(422, 'lint_blocked', `Antwort nicht gesendet: ${was}.`, 'Text anpassen und erneut senden.', { treffer: blocker })
  }

  const st = await ctx.settings()
  const pageId = st.default_page_id
  const token = await seitenToken(pageId)
  await pruefeKommentar(ctx, plattform, commentId, token, pageId, req.beitrag_id, 'antworten')

  const path = plattform === 'facebook' ? `${commentId}/comments` : `${commentId}/replies`
  // Protokoll ohne Antworttext (meta_write_log ist dauerhaft): nur Länge und Prüfsumme
  const request = {
    comment_id: commentId, plattform, text_len: text.length, text_sha256: await sha256Hex(text),
    ...(str(req.beitrag_id) ? { beitrag_id: str(req.beitrag_id) } : {}),
  }
  // Doppelklick-Schutz: vor dem Senden reservieren, damit zwei schnelle Klicks nicht beide senden
  const reservierung = await reservieren(ctx, { level: 'kommentar', path, entityId: commentId, request }, DOPPELKLICK_MS)
  if (reservierung === 'belegt') {
    throw new KontoError(409, 'doppelt', 'Auf diesen Kommentar wurde gerade eben schon geantwortet (oder die Antwort wird noch gesendet).',
      'Liste neu laden, bevor du noch einmal antwortest.')
  }
  let res: Raw
  try {
    res = await pageFetch<Raw>('POST', path, token, { message: text }, 30_000)
  } catch (err) {
    // Reservierung nur freigeben, wenn Meta sicher nichts übernommen hat (Fehlerantwort 4xx, kein Netz-/Zeitfehler)
    const sicherNichtGesendet = err instanceof MetaApiError && err.status >= 400 && err.status < 500
      && err.kind !== 'transient' && err.kind !== 'unknown'
    const after = sicherNichtGesendet && reservierung ? { [RESERVIERUNG_FREI]: reservierung.id } : undefined
    await logWrite(ctx, { level: 'kommentar', path, entityId: commentId, request, after, err })
    throw err
  }
  const antwortId = str(res.id)
  await logWrite(ctx, { level: 'kommentar', path, entityId: commentId, request, after: { antwort_id: antwortId || null } })
  return {
    ok: true, comment_id: commentId, plattform, antwort_id: antwortId, text,
    hinweise: treffer.filter(t => KOMMENTAR_LINT_BLOCKER.indexOf(t.regel) < 0),
  }
}

// ── kommentar_ausblenden ────────────────────────────────────────────────────

export async function modeKommentarAusblenden(ctx: Ctx, req: KommentarAusblendenRequest): Promise<KommentarAusblendenResponse> {
  const plattform = plattformParam(req.plattform)
  const commentId = kommentarId(req.comment_id)
  if (typeof req.hide !== 'boolean') throw new KontoError(400, 'invalid_request', 'hide fehlt (true = ausblenden, false = einblenden).')
  const hide = req.hide

  const st = await ctx.settings()
  const pageId = st.default_page_id
  const token = await seitenToken(pageId)
  const stand = await pruefeKommentar(ctx, plattform, commentId, token, pageId, req.beitrag_id, 'ausblenden')
  if (stand.ausgeblendet === hide) {
    return { ok: true, comment_id: commentId, plattform, ausgeblendet: hide, geprueft: true }
  }

  const body = plattform === 'facebook' ? { is_hidden: hide } : { hide }
  const request = { comment_id: commentId, plattform, hide }
  try {
    await pageFetch<Raw>('POST', commentId, token, body, 30_000)
  } catch (err) {
    await logWrite(ctx, { level: 'kommentar', path: commentId, entityId: commentId, request, before: stand, err })
    throw err
  }
  let jetzt: boolean | null = null
  try {
    const r = await pageFetch<Raw>('GET', commentId, token, { fields: plattform === 'facebook' ? 'id,is_hidden' : 'id,hidden' })
    const v = plattform === 'facebook' ? r.is_hidden : r.hidden
    jetzt = typeof v === 'boolean' ? v : null
  } catch (e) {
    console.warn(`[meta-konto] Ausblenden nachlesen: ${softMsg(e)}`)
  }
  await logWrite(ctx, { level: 'kommentar', path: commentId, entityId: commentId, request, before: stand, after: { ausgeblendet: jetzt } })
  return { ok: true, comment_id: commentId, plattform, ausgeblendet: jetzt ?? hide, geprueft: jetzt !== null }
}
