// meta-werkzeuge: audience_create_customer_list (Kundenliste aus dem CRM).
//
// Nur wenn Sven es freigegeben hat (ad_settings.kundenliste_freigegeben, nur Admin
// kann es einschalten) UND ein Admin aufruft UND confirm: true (DSGVO-Hinweis).
// vorschau: true zählt nur (Admin), ohne Freigabe und ohne Meta.
//
// Datenschutz:
//   - E-Mail und Telefon werden hier normalisiert und mit SHA-256 gehasht; Klartext
//     verlässt die Function nie, Hashes landen in keinem Log und keiner Antwort.
//   - Ausgeschlossen: interne Personen (Profile admin/verwalter/mitarbeiter, intern
//     markierte Einladungen), Kontakte mit Widerspruch (communication_optouts,
//     leads.newsletter_optout_at; je Person über E-Mail und Telefon, auch wenn der
//     Widerspruch an einem anderen Lead-Datensatz hängt), archivierte Leads (außer
//     ausdrücklich gewünscht). Ist eine Ausschluss-Liste nicht vollständig lesbar,
//     wird nichts hochgeladen. Alle Listen werden seitenweise gelesen (PostgREST
//     liefert höchstens 1000 Zeilen je Aufruf).
//   - Doppelklick-Schutz: gibt es schon eine Zielgruppe gleichen Namens, 409.
//   - meta_write_log bekommt nur Anzahlen, Schema und Session, keine Daten.
//
// Ablauf: leere Custom Audience (subtype CUSTOM, customer_file_source
// USER_PROVIDED_ONLY) -> POST /{audience_id}/users mit payload {schema:
// ['EMAIL','PHONE'] (Mehrfachschlüssel, beide SHA-256), data} und session.
// Höchstens 10.000 Kontakte (ein Stapel). Scheitert das Hochladen, bleibt die
// leere Liste bei Meta stehen (nie löschen) und die Antwort nennt den Fehler.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { MetaApiError } from '../_shared/metaGraph.ts'
import {
  arr, cleanText, kundenlisteFreigegeben, metaPost, name200, num, obj, sacEligibility, sha256Hex, softMsg, str,
  WerkzeugError, zielgruppeGleichenNamens, type Ctx, type Raw,
} from './common.ts'
import {
  KUNDENLISTE_DSGVO_HINWEIS, KUNDENLISTE_LABELS, KUNDENLISTE_MAX,
  type AudienceCreateCustomerListRequest, type AudienceCreateCustomerListResponse, type KundenlisteFilter,
} from './typen.ts'

const META_UTM = ['meta', 'facebook', 'fb', 'instagram', 'ig']
const INTERNE_ROLLEN = ['admin', 'verwalter', 'mitarbeiter']

// ── Normalisierung (Meta-Vorgaben für Kundenlisten) ──────────────────────────

/** E-Mail: trimmen, klein schreiben (Meta). null, wenn keine plausible Adresse. */
export function normEmail(v: unknown): string | null {
  const e = str(v).trim().toLowerCase()
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null
}

/** Vergleichsform für interne Kontakte (googlemail = gmail, wie internalContact.ts) */
function vergleichsEmail(v: unknown): string {
  const e = str(v).trim().toLowerCase()
  return e.replace(/@googlemail\.com$/, '@gmail.com')
}

const VORWAHL: Record<string, string> = {
  DE: '49', AT: '43', CH: '41', CY: '357', LU: '352', LI: '423', NL: '31', BE: '32', FR: '33', IT: '39', ES: '34',
  GB: '44', UK: '44', DK: '45', SE: '46', NO: '47', PL: '48', GR: '30', PT: '351', IE: '353', US: '1',
  DEUTSCHLAND: '49', GERMANY: '49', 'ÖSTERREICH': '43', OESTERREICH: '43', AUSTRIA: '43', SCHWEIZ: '41',
  SWITZERLAND: '41', ZYPERN: '357', CYPRUS: '357', LUXEMBURG: '352',
}
const BEKANNTE_VORWAHLEN = ['357', '352', '423', '351', '353', '49', '43', '41', '31', '32', '33', '39', '34', '44', '45', '46', '47', '48', '30']

/**
 * Telefon: nur Ziffern mit Ländervorwahl, ohne führende Nullen (Meta).
 * +49 170 ... / 0049 170 ... / 0170 ... (mit Land DE) -> 49170...
 * null, wenn die Ländervorwahl nicht bestimmbar ist.
 */
export function normTelefon(v: unknown, land: unknown): string | null {
  let raw = str(v).trim()
  if (!raw) return null
  raw = raw.replace(/\(0\)/g, '')
  const d = raw.replace(/[^0-9]/g, '')
  let out: string | null = null
  if (raw.startsWith('+')) out = d
  else if (d.startsWith('00')) out = d.slice(2)
  else if (d.startsWith('0')) {
    const code = VORWAHL[str(land).trim().toUpperCase()]
    out = code ? code + d.replace(/^0+/, '') : null
  } else if (BEKANNTE_VORWAHLEN.some(c => d.startsWith(c)) && d.length >= 11) {
    out = d
  } else {
    const code = VORWAHL[str(land).trim().toUpperCase()]
    out = code ? code + d : null
  }
  if (!out) return null
  out = out.replace(/^0+/, '')
  return out.length >= 8 && out.length <= 15 ? out : null
}

// ── Filter ───────────────────────────────────────────────────────────────────

const WORT_RE = /^[a-z_]{2,40}$/
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/

function liste(v: unknown, label: string): string[] {
  const l = arr<unknown>(v).map(x => str(x).trim()).filter(Boolean)
  for (const x of l) if (!WORT_RE.test(x)) throw new WerkzeugError(400, 'invalid_request', `Filter ${label}: unbekannter Wert "${x.slice(0, 30)}".`)
  return l
}

export function filterPruefen(v: unknown): KundenlisteFilter {
  const f = obj(v)
  const out: KundenlisteFilter = {}
  const status = liste(f.status, 'status')
  if (status.length) out.status = status
  const q = arr<unknown>(f.qualitaet).map(x => str(x))
  for (const x of q) if (x !== 'gut' && x !== 'schlecht') throw new WerkzeugError(400, 'invalid_request', 'Filter qualitaet: nur gut oder schlecht.')
  if (q.length) out.qualitaet = q as Array<'gut' | 'schlecht'>
  const phasen = liste(f.deal_phasen, 'deal_phasen')
  if (phasen.length) out.deal_phasen = phasen
  for (const k of ['seit', 'bis'] as const) {
    const d = str(f[k]).trim()
    if (!d) continue
    if (!DATUM_RE.test(d) || !Number.isFinite(Date.parse(`${d}T00:00:00Z`))) throw new WerkzeugError(400, 'invalid_request', `Filter ${k}: Datum als JJJJ-MM-TT.`)
    out[k] = d
  }
  if (f.nur_meta === true) out.nur_meta = true
  if (f.mit_archivierten === true) out.mit_archivierten = true
  return out
}

function filterText(f: KundenlisteFilter): string {
  const t: string[] = []
  if (f.status?.length) t.push(`Status ${f.status.join('/')}`)
  if (f.qualitaet?.length) t.push(`Bewertung ${f.qualitaet.join('/')}`)
  if (f.deal_phasen?.length) t.push(`Deal-Phase ${f.deal_phasen.join('/')}`)
  if (f.seit) t.push(`ab ${f.seit}`)
  if (f.bis) t.push(`bis ${f.bis}`)
  if (f.nur_meta) t.push('nur Meta-Leads')
  if (f.mit_archivierten) t.push('inkl. archiviert')
  return t.join(', ') || 'alle aktiven Leads'
}

// ── Kontakte laden (seriell, seitenweise, Micro-DB) ──────────────────────────

interface Zaehler { intern: number; widerspruch: number; ohne_kontakt: number; doppelt: number }
interface Kontakte { zeilen: string[][]; mitEmail: number; mitTelefon: number; aus: Zaehler; hinweise: string[] }

const dbFehler = (e: unknown): string => String(obj(e).message ?? e).slice(0, 200)
const tabelleFehlt = (e: unknown): boolean => str(obj(e).code) === '42P01'
const spalteFehlt = (e: unknown): boolean => str(obj(e).code) === '42703'

/** PostgREST liefert höchstens 1000 Zeilen je Aufruf */
const SEITE = 1000
/** Obergrenze der Hilfslisten (Widerspruch, intern, Deals); erreicht = Abbruch statt lautlos kürzen */
const MAX_LISTE = 200_000
/** IDs je .in()-Abfrage */
const STUECK = 150
const KONTAKT_SPALTEN = 'id, email, phone, whatsapp, country'

type Abfrage = (von: number, bis: number) => Promise<{ data: unknown; error: unknown }>
interface Seiten { rows: Raw[]; error: unknown; voll: boolean }

/**
 * Liest alle Zeilen seitenweise und seriell. Endet erst an einer leeren Seite, damit
 * auch eine kleinere Server-Grenze nichts abschneidet. voll = max erreicht (Ende unbekannt).
 */
async function seitenweise(abfrage: Abfrage, max: number): Promise<Seiten> {
  const rows: Raw[] = []
  while (rows.length < max) {
    const von = rows.length
    const bis = Math.min(von + SEITE, max) - 1
    const { data, error } = await abfrage(von, bis)
    if (error) return { rows, error, voll: false }
    const teil = arr<Raw>(data).slice(0, bis - von + 1)
    if (!teil.length) return { rows, error: null, voll: false }
    rows.push(...teil)
  }
  return { rows, error: null, voll: true }
}

/** Ausschluss-Listen müssen vollständig sein: Fehler oder Obergrenze bricht ab (503). */
function vollstaendig(r: Seiten, was: string, leerOhneTabelle = false): Raw[] {
  if (r.error) {
    if (leerOhneTabelle && tabelleFehlt(r.error)) return []
    console.warn(`[meta-werkzeuge] ${was}:`, dbFehler(r.error))
    throw new WerkzeugError(503, 'internal', `${was} nicht lesbar; Kundenliste aus Datenschutzgründen abgebrochen.`)
  }
  if (r.voll) {
    throw new WerkzeugError(503, 'internal', `${was}: mehr als ${MAX_LISTE.toLocaleString('de-DE')} Einträge, nicht vollständig lesbar; Kundenliste abgebrochen.`)
  }
  return r.rows
}

// Vergleichs-Schlüssel einer Person: E-Mail (googlemail = gmail) und Telefon
// (Rohziffern UND international normalisiert, +49 / 0049 / 0 mit Land gleich behandelt)
interface Schluessel { mails: Set<string>; tels: Set<string> }
const neueSchluessel = (): Schluessel => ({ mails: new Set<string>(), tels: new Set<string>() })

function telSchluessel(v: unknown, land: unknown): string[] {
  const out: string[] = []
  const d = str(v).replace(/[^0-9]/g, '')
  if (d.length >= 6) out.push(d)
  const n = normTelefon(v, land)
  if (n) out.push(n)
  return out
}

function schluesselAdd(s: Schluessel, email: unknown, tels: unknown[], land: unknown): void {
  const e = vergleichsEmail(email)
  if (e) s.mails.add(e)
  for (const t of tels) for (const k of telSchluessel(t, land)) s.tels.add(k)
}

function trifft(s: Schluessel, email: unknown, tels: unknown[], land: unknown): boolean {
  const e = vergleichsEmail(email)
  if (e && s.mails.has(e)) return true
  return tels.some(t => telSchluessel(t, land).some(k => s.tels.has(k)))
}

/** Interne Personen (Profile admin/verwalter/mitarbeiter, interne Einladungen). Nicht lesbar = Abbruch. */
async function interneKontakte(sb: SupabaseClient): Promise<Schluessel> {
  const s = neueSchluessel()
  const profile = (spalten: string): Abfrage => async (von, bis) =>
    await sb.from('profiles').select(spalten).in('role', INTERNE_ROLLEN).order('id').range(von, bis)
  let p = await seitenweise(profile('id, email, phone'), MAX_LISTE)
  // nur eine fehlende Telefon-Spalte ist ein erlaubter Rückfall
  if (p.error && spalteFehlt(p.error)) p = await seitenweise(profile('id, email'), MAX_LISTE)
  for (const r of vollstaendig(p, 'Interne Profile')) schluesselAdd(s, r.email, [r.phone], null)
  const b = await seitenweise(async (von, bis) =>
    await sb.from('booking_invites').select('id, guest_email, guest_phone').eq('internal', true).order('id').range(von, bis), MAX_LISTE)
  for (const r of vollstaendig(b, 'Interne Einladungen', true)) schluesselAdd(s, r.guest_email, [r.guest_phone], null)
  return s
}

/**
 * Widerspruch gilt je Person, nicht je Lead-Datensatz: alle Leads mit Eintrag in
 * communication_optouts oder newsletter_optout_at (egal welcher Status) liefern
 * E-Mail und Telefon; jeder Kandidat, der in einem Schlüssel passt, fliegt raus.
 */
async function widersprueche(sb: SupabaseClient): Promise<{ ids: Set<string>; s: Schluessel }> {
  const ids = new Set<string>()
  const s = neueSchluessel()
  const co = await seitenweise(async (von, bis) =>
    await sb.from('communication_optouts').select('lead_id').order('lead_id').range(von, bis), MAX_LISTE)
  const optoutIds = vollstaendig(co, 'Abmeldeliste (communication_optouts)', true).map(r => str(r.lead_id)).filter(Boolean)
  const nl = await seitenweise(async (von, bis) =>
    await sb.from('leads').select(KONTAKT_SPALTEN).not('newsletter_optout_at', 'is', null).order('id').range(von, bis), MAX_LISTE)
  for (const r of vollstaendig(nl, 'Newsletter-Abmeldungen (leads)')) {
    if (str(r.id)) ids.add(str(r.id))
    schluesselAdd(s, r.email, [r.phone, r.whatsapp], r.country)
  }
  const offen = optoutIds.filter(id => !ids.has(id))
  for (const id of optoutIds) ids.add(id)
  for (let i = 0; i < offen.length; i += STUECK) {
    const { data, error } = await sb.from('leads').select(KONTAKT_SPALTEN).in('id', offen.slice(i, i + STUECK))
    if (error) {
      console.warn('[meta-werkzeuge] Kontaktdaten der Abmeldungen:', dbFehler(error))
      throw new WerkzeugError(503, 'internal', 'Kontaktdaten der Abmeldungen nicht lesbar; Kundenliste aus Datenschutzgründen abgebrochen.')
    }
    for (const r of arr<Raw>(data)) schluesselAdd(s, r.email, [r.phone, r.whatsapp], r.country)
  }
  return { ids, s }
}

async function kontakteLaden(sb: SupabaseClient, f: KundenlisteFilter): Promise<Kontakte> {
  const hinweise: string[] = []
  const lr = await seitenweise(async (von, bis) => {
    let q = sb.from('leads').select('id, email, phone, whatsapp, country, status, source, utm_source, newsletter_optout_at')
    if (f.status?.length) q = q.in('status', f.mit_archivierten ? f.status : f.status.filter(s => s !== 'archived'))
    else if (!f.mit_archivierten) q = q.neq('status', 'archived')
    if (f.qualitaet?.length) q = q.in('quality_rating', f.qualitaet)
    if (f.seit) q = q.gte('created_at', `${f.seit}T00:00:00Z`)
    if (f.bis) q = q.lte('created_at', `${f.bis}T23:59:59Z`)
    return await q.order('created_at', { ascending: false }).order('id').range(von, bis)
  }, KUNDENLISTE_MAX + 1)
  if (lr.error) throw new WerkzeugError(500, 'internal', `Leads nicht lesbar: ${dbFehler(lr.error)}`)
  if (lr.voll) {
    throw new WerkzeugError(422, 'limit_reached', `Mehr als ${KUNDENLISTE_MAX.toLocaleString('de-DE')} Leads passen auf den Filter.`, 'Filter enger stellen (Zeitraum, Status, Bewertung).')
  }
  let leads = lr.rows

  if (f.deal_phasen?.length) {
    const phasen = f.deal_phasen
    const dr = await seitenweise(async (von, bis) =>
      await sb.from('deals').select('id, lead_id').in('phase', phasen).order('id').range(von, bis), MAX_LISTE)
    const mitDeal = new Set(vollstaendig(dr, 'Deals').map(r => str(r.lead_id)).filter(Boolean))
    leads = leads.filter(l => mitDeal.has(str(l.id)))
  }
  if (f.nur_meta) {
    leads = leads.filter(l => META_UTM.indexOf(str(l.utm_source).trim().toLowerCase()) >= 0 || ['meta', 'meta_lead_form'].indexOf(str(l.source)) >= 0)
  }

  // Widerspruch und interne Kontakte: ohne vollständige Listen wird NICHT hochgeladen
  const wid = await widersprueche(sb)
  const intern = await interneKontakte(sb)

  const aus: Zaehler = { intern: 0, widerspruch: 0, ohne_kontakt: 0, doppelt: 0 }
  const zeilen: string[][] = []
  const gesehen = new Set<string>()
  let mitEmail = 0
  let mitTelefon = 0
  for (const l of leads) {
    const tels = [l.phone, l.whatsapp]
    if (wid.ids.has(str(l.id)) || str(l.newsletter_optout_at) || trifft(wid.s, l.email, tels, l.country)) { aus.widerspruch++; continue }
    if (trifft(intern, l.email, tels, l.country)) { aus.intern++; continue }
    const em = normEmail(l.email)
    const ph = normTelefon(l.phone, l.country) ?? normTelefon(l.whatsapp, l.country)
    if (!em && !ph) { aus.ohne_kontakt++; continue }
    const emH = em ? await sha256Hex(em) : ''
    const phH = ph ? await sha256Hex(ph) : ''
    const key = `${emH}|${phH}`
    if (gesehen.has(key)) { aus.doppelt++; continue }
    gesehen.add(key)
    if (emH) mitEmail++
    if (phH) mitTelefon++
    zeilen.push([emH, phH])
  }
  return { zeilen, mitEmail, mitTelefon, aus, hinweise }
}

// ── Modus ────────────────────────────────────────────────────────────────────

export async function modeAudienceCreateCustomerList(ctx: Ctx, req: AudienceCreateCustomerListRequest): Promise<AudienceCreateCustomerListResponse> {
  if (ctx.caller.system || ctx.caller.role !== 'admin') {
    throw new WerkzeugError(403, 'forbidden', 'Kundenlisten darf nur ein Admin hochladen.')
  }
  if (str(req.quelle || 'crm') !== 'crm') throw new WerkzeugError(400, 'invalid_request', 'quelle: nur crm.')
  const name = name200(req.name)
  const filter = filterPruefen(req.filter)
  const vorschau = req.vorschau === true
  const label = str(req.label)
  if (label && (KUNDENLISTE_LABELS as readonly string[]).indexOf(label) < 0) {
    throw new WerkzeugError(400, 'invalid_request', `label: ${KUNDENLISTE_LABELS.join(', ')}.`)
  }

  if (!vorschau) {
    const frei = await kundenlisteFreigegeben(ctx.sb)
    if (frei === null) {
      throw new WerkzeugError(503, 'kundenliste_gesperrt', 'Kundenlisten sind noch nicht eingerichtet (Datenbank-Migration fehlt).',
        'Migration 20261004100000_werbe_paritaet_r1.sql einspielen, danach in den Werbe-Einstellungen freigeben.')
    }
    if (!frei) {
      throw new WerkzeugError(403, 'kundenliste_gesperrt', 'Kundenlisten sind gesperrt, bis Sven sie in den Werbe-Einstellungen freigibt.',
        'Einstellung „Kundenlisten an Meta erlaubt“ (nur Admin).')
    }
    if (req.confirm !== true) {
      throw new WerkzeugError(400, 'invalid_request', 'Bitte den Datenschutz-Hinweis bestätigen (confirm: true).', KUNDENLISTE_DSGVO_HINWEIS)
    }
  }

  if (!vorschau) {
    // Doppelklick-Schutz ist hier Pflicht: sonst gehen Personendaten zweimal an Meta
    let gleich: Raw | null
    try {
      gleich = await zielgruppeGleichenNamens(ctx.env.account, name)
    } catch (e) {
      throw new WerkzeugError(502, 'meta_error', `Vorhandene Zielgruppen nicht lesbar (${softMsg(e)}); Kundenliste nicht angelegt, damit nichts doppelt hochgeladen wird.`,
        'In ein paar Minuten erneut versuchen.')
    }
    if (gleich) {
      throw new WerkzeugError(409, 'invalid_request', `Es gibt schon eine Zielgruppe „${name}“ (ID ${str(gleich.id)}).`, 'Anderen Namen wählen oder die vorhandene Liste nutzen.')
    }
  }

  const k = await kontakteLaden(ctx.sb, filter)
  const anzahl = k.zeilen.length
  const hinweise = [...k.hinweise]
  if (anzahl > 0 && anzahl < 100) hinweise.push('Meta liefert Kundenlisten erst ab etwa 100 gefundenen Personen aus.')
  const description = cleanText(req.beschreibung, 300) || `CRM-Kundenliste (HP-Werbemanager), ${anzahl} Kontakte, ${filterText(filter)}`.slice(0, 400)
  const createBody: Raw = {
    name,
    subtype: 'CUSTOM',
    customer_file_source: 'USER_PROVIDED_ONLY',
    description,
    ...(label ? { audience_labels: JSON.stringify([label]) } : {}),
  }
  const basis = {
    name, kontakte: anzahl, mit_email: k.mitEmail, mit_telefon: k.mitTelefon, ausgeschlossen: k.aus,
    payload: { ...createBody, upload: { schema: ['EMAIL', 'PHONE'], anzahl, hash: 'SHA-256' } } as Record<string, unknown>,
  }
  console.log(`[meta-werkzeuge] kundenliste ${vorschau ? 'vorschau' : 'anlegen'}: ${anzahl} Kontakte, ausgeschlossen ${JSON.stringify(k.aus)}`)
  if (vorschau) {
    return { ...basis, vorschau: true, audience_id: null, hochgeladen: 0, ungueltig: null, sac_eligible: null, hinweise }
  }
  if (!anzahl) throw new WerkzeugError(422, 'invalid_request', 'Für diesen Filter gibt es keine hochladbaren Kontakte.')

  const created = await metaPost(ctx, `act_${ctx.env.account}/customaudiences`, createBody, { level: 'audience' })
  const audienceId = str(created.id)
  if (!audienceId) throw new WerkzeugError(502, 'meta_error', 'Meta hat keine Zielgruppen-ID zurückgegeben.')

  // Hochladen (ein Stapel, höchstens 10.000). session_id: eindeutig je Werbekonto.
  const sessionId = Date.now() * 1000 + Math.floor(Math.random() * 1000)
  let hochgeladen = 0
  let ungueltig: number | null = null
  let fehler: string | undefined
  const STAPEL = 10_000
  for (let i = 0, seq = 1; i < anzahl; i += STAPEL, seq++) {
    const teil = k.zeilen.slice(i, i + STAPEL)
    const letzter = i + STAPEL >= anzahl
    const session = { session_id: sessionId, batch_seq: seq, last_batch_flag: letzter, estimated_num_total: anzahl }
    try {
      const res = await metaPost(ctx, `${audienceId}/users`, {
        payload: JSON.stringify({ schema: ['EMAIL', 'PHONE'], data: teil }),
        session: JSON.stringify(session),
      }, {
        level: 'audience_users', entityId: audienceId, timeoutMs: 60_000,
        // nie die Hashes protokollieren, nur Anzahlen
        logRequest: { schema: ['EMAIL', 'PHONE'], anzahl: teil.length, session },
        logAfter: r => ({ num_received: r.num_received ?? null, num_invalid_entries: r.num_invalid_entries ?? null, session_id: r.session_id ?? null }),
      })
      hochgeladen += num(res.num_received) ?? teil.length
      const inv = num(res.num_invalid_entries)
      if (inv !== null) ungueltig = (ungueltig ?? 0) + inv
    } catch (e) {
      fehler = e instanceof MetaApiError ? `Hochladen gescheitert: ${softMsg(e)}` : `Hochladen gescheitert: ${e instanceof Error ? e.message.slice(0, 200) : 'unbekannt'}`
      hinweise.push('Die Liste ist bei Meta angelegt, aber leer oder unvollständig. Nicht verwenden; mit neuem Namen erneut anlegen.')
      break
    }
  }

  const sac = await sacEligibility(ctx.env.account, audienceId, 'DE')
  if (sac.eligible === false) hinweise.push('Meta lässt diese Kundenliste für Wohnen-Kampagnen (DE) nicht zu.')
  hinweise.push('Meta gleicht die Liste in bis zu 24 Stunden ab; danach erscheint die Größe.')
  return {
    ...basis, vorschau: false, audience_id: audienceId, hochgeladen, ungueltig, sac_eligible: sac.eligible, hinweise,
    ...(fehler ? { fehler } : {}),
  }
}
