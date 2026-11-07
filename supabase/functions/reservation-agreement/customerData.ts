// Angaben, die nicht im Ausweis stehen, trägt der Kunde selbst ein (Sven 5.11.2026, Flora Panorama):
// Seite /sign/a/:token, kein Login, nur Token. Der Link steht in der Nachricht, die bei Phase
// Reservierung rausgeht (schedule-message). Die Adresse landet im Vertrag und beim Kunden im CRM.
// Von Sven im CRM Eingetragenes hat Vorrang, der Kunde füllt nur Lücken.
// Den Ausweis lädt der Kunde auf derselben Seite hoch (Sven 6.11.2026): Er braucht kein Google-Konto,
// jede Mail-Adresse geht. Die Datei landet in seinem Drive-Ordner, der Sweep liest sie wie jede andere.
// Gilt für jeden Bauträger und beliebig viele Käufer (Sven 7.11.2026). Ohne Vertragsvorlage hat die Zeile
// keine template_id: Die Seite läuft, die Vertragsautomatik lässt sie in Ruhe.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { resolveLang } from '../_shared/recipientLang.ts'
import { ladeGesperrte, leadGesperrt } from '../_shared/kontoSperre.ts'
import { uploadLinkHolen } from '../_shared/uploadLink.ts'
import { clientIp } from './seal.ts'
import { buyersFrom, norm, whatsappSven, type AgreementRow, type Buyer, type Ctx } from './index.ts'
import { checkFile } from './ausweis.ts'
import { uploadFile, uploadToken } from './drive.ts'
import { floraBuyers } from './twoParty.ts'

type Res = { status: number; body: Record<string, unknown> }
export interface CustomerPerson {
  salutation: string; street: string; postal_code: string; city: string
  country_code: string; country_other: string; phone: string; email: string
}
export interface CustomerSecond extends CustomerPerson { first_name: string; last_name: string; same_address: boolean }
export interface CustomerData extends CustomerPerson {
  second: CustomerSecond | null
  /** Dritter Käufer und weitere */
  more?: CustomerSecond[]
  at: string; ip?: string | null; user_agent?: string | null
}

/** Alle Käufer außer dem Kunden selbst. */
export const furtherBuyers = (d: Pick<CustomerData, 'second' | 'more'> | null | undefined): CustomerSecond[] =>
  d ? [...(d.second ? [d.second] : []), ...(d.more ?? [])] : []
const MAX_FURTHER = 5
const LINK_DAYS = 30
// So heißt der weitere Käufer auf der Seite und in den gespeicherten Uploads: second, more0, more1, ...
const furtherKey = (i: number) => i === 0 ? 'second' : `more${i - 1}`

const TOKEN_RE = /^[0-9a-f]{36}$/
const DEAD = ['deal_verloren', 'archiviert']
// Nur lateinische Schrift: die PDF-Schrift kann nichts anderes
const LATIN = /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{M}+]+$/u
const COUNTRIES: Array<[string, string, string]> = [
  ['DE', 'Germany', 'Deutschland'], ['AT', 'Austria', 'Österreich'], ['CH', 'Switzerland', 'Schweiz'], ['LI', 'Liechtenstein', 'Liechtenstein'],
  ['LU', 'Luxembourg', 'Luxemburg'], ['NL', 'Netherlands', 'Niederlande'], ['BE', 'Belgium', 'Belgien'], ['FR', 'France', 'Frankreich'],
  ['IT', 'Italy', 'Italien'], ['ES', 'Spain', 'Spanien'], ['PT', 'Portugal', 'Portugal'], ['GB', 'United Kingdom', 'Großbritannien'],
  ['IE', 'Ireland', 'Irland'], ['DK', 'Denmark', 'Dänemark'], ['SE', 'Sweden', 'Schweden'], ['NO', 'Norway', 'Norwegen'],
  ['FI', 'Finland', 'Finnland'], ['PL', 'Poland', 'Polen'], ['CZ', 'Czech Republic', 'Tschechien'], ['SK', 'Slovakia', 'Slowakei'],
  ['HU', 'Hungary', 'Ungarn'], ['RO', 'Romania', 'Rumänien'], ['BG', 'Bulgaria', 'Bulgarien'], ['HR', 'Croatia', 'Kroatien'],
  ['SI', 'Slovenia', 'Slowenien'], ['RS', 'Serbia', 'Serbien'], ['GR', 'Greece', 'Griechenland'], ['CY', 'Cyprus', 'Zypern'],
  ['MT', 'Malta', 'Malta'], ['EE', 'Estonia', 'Estland'], ['LV', 'Latvia', 'Lettland'], ['LT', 'Lithuania', 'Litauen'],
  ['UA', 'Ukraine', 'Ukraine'], ['TR', 'Turkey', 'Türkei'], ['IL', 'Israel', 'Israel'], ['AE', 'United Arab Emirates', 'Vereinigte Arabische Emirate'],
  ['US', 'United States', 'USA'], ['CA', 'Canada', 'Kanada'],
]
const POSTAL: Record<string, RegExp> = {
  DE: /^\d{5}$/, AT: /^\d{4}$/, CH: /^\d{4}$/, LI: /^\d{4}$/, LU: /^\d{4}$/, BE: /^\d{4}$/, DK: /^\d{4}$/, NO: /^\d{4}$/, CY: /^\d{4}$/,
  NL: /^\d{4}\s?[A-Za-z]{2}$/, FR: /^\d{5}$/, IT: /^\d{5}$/, ES: /^\d{5}$/,
}
const NEEDS_HOUSE_NO = ['DE', 'AT', 'CH']

const countryOf = (code: string) => COUNTRIES.find(c => c[0] === code)
export const countryEn = (p: Pick<CustomerPerson, 'country_code' | 'country_other'>) => countryOf(p.country_code)?.[1] ?? p.country_other.trim()
export const countryDe = (p: Pick<CustomerPerson, 'country_code' | 'country_other'>) => countryOf(p.country_code)?.[2] ?? p.country_other.trim()
/** So steht die Adresse im Vertrag: englischer Ländername, wie der Vordruck */
export const addressLine = (p: CustomerPerson) => `${p.street}, ${p.postal_code} ${p.city}, ${countryEn(p)}`

const text = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
function cleanPerson(v: Record<string, unknown>): CustomerPerson {
  return {
    salutation: ['MR.', 'MRS.'].includes(String(v.salutation)) ? String(v.salutation) : '',
    street: text(v.street, 120), postal_code: text(v.postal_code, 12), city: text(v.city, 80),
    country_code: text(v.country_code, 5).toUpperCase(), country_other: text(v.country_other, 60),
    phone: text(v.phone, 24), email: text(v.email, 120).toLowerCase(),
  }
}

/** Fehlercodes je Feld; leer = in Ordnung. Dieselbe Regel gilt im Formular und in der Prüfung vor dem Versand. */
export function personErrors(p: CustomerPerson): Record<string, string> {
  const e: Record<string, string> = {}
  if (!p.salutation) e.salutation = 'required'
  if (!p.street) e.street = 'required'
  else if (p.street.length < 4 || !/\p{L}{2}/u.test(p.street) || !LATIN.test(p.street)) e.street = 'invalid'
  else if (NEEDS_HOUSE_NO.includes(p.country_code) && !/\d/.test(p.street)) e.street = 'house_number'
  if (!p.postal_code) e.postal_code = 'required'
  else if (!(POSTAL[p.country_code] ?? /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/).test(p.postal_code)) e.postal_code = 'invalid'
  if (!p.city) e.city = 'required'
  else if (p.city.length < 2 || /\d/.test(p.city) || !LATIN.test(p.city)) e.city = 'invalid'
  if (!countryOf(p.country_code) && !p.country_other) e.country = 'required'
  else if (!countryOf(p.country_code) && !LATIN.test(p.country_other)) e.country = 'invalid'
  if (!p.phone) e.phone = 'required'
  else if (!/^\+?[\d\s()./-]{7,24}$/.test(p.phone)) e.phone = 'invalid'
  if (!p.email) e.email = 'required'
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p.email)) e.email = 'invalid'
  return e
}

// ── Seite ────────────────────────────────────────────────────────────────────
async function findRow(sb: SupabaseClient, token: unknown): Promise<{ row: AgreementRow; test: boolean } | null> {
  const t = String(token ?? '').trim().toLowerCase()
  if (!TOKEN_RE.test(t)) return null
  const { data: real } = await sb.from('reservation_agreements').select('*').eq('address_token', t).maybeSingle()
  if (real) return { row: real as AgreementRow, test: false }
  const { data: test } = await sb.from('reservation_agreements').select('*').eq('test_payload->>address_token', t).limit(1).maybeSingle()
  return test ? { row: test as AgreementRow, test: true } : null
}

async function isOpen(sb: SupabaseClient, row: AgreementRow): Promise<boolean> {
  if (['gesendet', 'unterschrieben'].includes(row.status)) return false
  // Wie beim Upload-Link: läuft ab, jede neue Nachricht an den Kunden verlängert ihn
  if (Date.now() - Date.parse(row.updated_at) > LINK_DAYS * 86_400_000) return false
  const { data } = await sb.from('deals').select('phase').eq('id', row.deal_id).maybeSingle()
  if (!data || DEAD.includes((data as { phase: string }).phase)) return false
  const lead = await loadLead(sb, row.lead_id)
  // Wirft bei einem Lesefehler: Die Seite bleibt dann zu
  return !!lead && !leadGesperrt(await ladeGesperrte(sb), lead)
}

interface LeadRow {
  id: string; first_name: string | null; last_name: string | null; email: string | null; alt_emails: string[] | null; phone: string | null; whatsapp: string | null
  street: string | null; postal_code: string | null; city: string | null; country: string | null
  drive_folder_url: string | null; drive_folder_id: string | null
}
// ── Ausweis ──────────────────────────────────────────────────────────────────
type UploadDoc = 'id_card' | 'passport'
type UploadSide = 'front' | 'back' | 'page'
const SIDES: Record<UploadDoc, UploadSide[]> = { id_card: ['front', 'back'], passport: ['page'] }
const DOC_LABEL: Record<UploadDoc, string> = { id_card: 'Personalausweis', passport: 'Reisepass' }
const SIDE_LABEL: Record<UploadSide, string> = { front: 'Vorderseite', back: 'Rückseite', page: '' }
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const MAX_UPLOADS_PER_LEAD = 30
const UPLOAD_SOURCE = 'ausweis_seite'
// Bis hierhin geht die Datei direkt an die KI (index.ts MAX_IMAGE_BYTES, MAX_BYTES)
const AI_IMAGE_BYTES = 3_700_000, AI_PDF_BYTES = 15 * 1024 * 1024

/** Dateityp aus den ersten Bytes, nie aus den Angaben des Browsers. */
function sniff(b: Uint8Array): { mime: string; ext: string } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' }
  if (ascii(0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' }
  if (ascii(4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'heif', 'mif1', 'msf1'].includes(ascii(8, 12))) return { mime: 'image/heic', ext: 'heic' }
  return null
}

/** Welche Ausweise schon erkannt sind. Jeder erkannte Ausweis zählt, auch aus einem früheren Kauf (Sven 6.11.2026). */
function idState(row: Pick<AgreementRow, 'checked_files'>, further: CustomerSecond[]) {
  const { buyers } = buyersFrom(row.checked_files ?? {})
  const isOf = (b: Buyer, p: CustomerSecond) => sameName(b.full_name, p.first_name, p.last_name)
  return { have_main: buyers.some(b => !further.some(p => isOf(b, p))), have_further: further.map(p => buyers.some(b => isOf(b, p))) }
}

// Dokument und Seite stehen in path: Die Seite zeigt damit auch nach dem Neuladen, was schon da ist.
// Die Person kommt aus dem Namen, nicht aus der Nummer: Streicht der Kunde jemanden, rücken die anderen auf.
async function pageUploads(sb: SupabaseClient, leadId: string, further: CustomerSecond[]): Promise<Array<{ person: string; doc: string; side: string }>> {
  const { data } = await sb.from('drive_folder_files').select('path, uploader_name').eq('lead_id', leadId).eq('source', UPLOAD_SOURCE).limit(MAX_UPLOADS_PER_LEAD)
  return ((data ?? []) as Array<{ path: string | null; uploader_name: string | null }>).flatMap(r => {
    const [saved, doc, side] = (r.path ?? '').split(':')
    if (!saved || !doc || !side) return []
    const i = further.findIndex(p => norm(`${p.first_name} ${p.last_name}`) === norm(r.uploader_name ?? ''))
    if (i >= 0) return [{ person: furtherKey(i), doc, side }]
    return saved === 'main' ? [{ person: 'main', doc, side }] : []
  })
}

export async function addressUpload(sb: SupabaseClient, body: Record<string, unknown>, _req: Request): Promise<Res> {
  const hit = await findRow(sb, body.token)
  if (!hit) return { status: 404, body: { error: 'not_found' } }
  if (!hit.test && !await isOpen(sb, hit.row)) return { status: 409, body: { error: 'closed' } }
  const person = String(body.person), doc = String(body.doc) as UploadDoc, side = String(body.side) as UploadSide
  if (!SIDES[doc]?.includes(side)) return { status: 400, body: { error: 'invalid' } }
  const saved = (hit.test ? (hit.row.test_payload as { customer_data?: CustomerData } | null)?.customer_data : hit.row.customer_data) ?? null
  const further = furtherBuyers(saved), buyerIdx = further.findIndex((_, i) => furtherKey(i) === person)
  if (person !== 'main' && buyerIdx < 0) return { status: 400, body: { error: 'invalid' } }

  const raw = String(body.base64 ?? '')
  if (!raw) return { status: 400, body: { error: 'invalid' } }
  if (raw.length > Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 4) return { status: 413, body: { error: 'too_big' } }
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0)) } catch { return { status: 400, body: { error: 'invalid' } } }
  const type = sniff(bytes)
  if (!type) return { status: 415, body: { error: 'bad_type' } }

  const lead = await loadLead(sb, hit.row.lead_id)
  if (!lead) return { status: 404, body: { error: 'not_found' } }
  const mainName = [lead.first_name, lead.last_name].map(x => (x ?? '').trim()).filter(Boolean).join(' ') || 'Kunde'
  const who = buyerIdx >= 0 ? `${further[buyerIdx].first_name} ${further[buyerIdx].last_name}` : mainName
  const fileName = [DOC_LABEL[doc], who, SIDE_LABEL[side]].filter(Boolean).join(' ').replace(/[\/:*?"<>|]+/g, ' ') + `.${type.ext}`

  // Offensichtlich kein Ausweis: gleich sagen, nicht erst nach Stunden. Die KI kann irren, deshalb darf der Kunde übergehen (force).
  const aiCan = type.mime === 'application/pdf' ? bytes.byteLength <= AI_PDF_BYTES : type.mime !== 'image/heic' && bytes.byteLength <= AI_IMAGE_BYTES
  if (!body.force && aiCan) {
    const res = await checkFile(bytes, type.mime, fileName).catch(e => { console.error('[reservation-agreement] Ausweis-Vorprüfung', (e as Error).message); return null })
    if (res && res.kind !== 'identity_document') return { status: 422, body: { error: 'not_id' } }
  }
  if (hit.test) return { status: 200, body: { ok: true, test: true } }

  const { count } = await sb.from('drive_folder_files').select('file_id', { count: 'exact', head: true }).eq('lead_id', lead.id).eq('source', UPLOAD_SOURCE)
  if ((count ?? 0) >= MAX_UPLOADS_PER_LEAD) return { status: 429, body: { error: 'too_many' } }

  try {
    let folderId = lead.drive_folder_id
    if (!folderId) {
      const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      await sb.functions.invoke('create-client-drive-folder', { body: { lead_id: lead.id, extra_emails: [] }, headers: { Authorization: `Bearer ${key}`, apikey: key } })
      folderId = (await loadLead(sb, lead.id))?.drive_folder_id ?? null
    }
    if (!folderId) throw new Error('Kundenordner fehlt')
    const token = await uploadToken(sb)
    if (!token) throw new Error('Drive-Upload nicht verbunden')
    const up = await uploadFile(token, folderId, fileName, type.mime, bytes)
    const now = new Date().toISOString()
    // Meldung wie bei der Upload-Seite: Der Sweep von owner-drive sammelt sie über den Link und nennt den Kunden.
    // Ohne Link keine Meldung, das Hochladen hängt nicht daran.
    const linkId = await uploadLinkHolen(sb, { lead_id: lead.id, empfaenger: 'kunde', name: mainName, email: lead.email, phone: lead.whatsapp || lead.phone })
      .then(l => l.id).catch(e => { console.error('[reservation-agreement] Upload-Link', (e as Error).message); return null })
    // Eingetragen, damit die Drive-Meldung nicht „hochgeladen von Sven" sagt (die Datei gehört technisch Svens Konto)
    const { error } = await sb.from('drive_folder_files').upsert({
      file_id: up.id, lead_id: lead.id, folder_id: folderId, name: up.name, mime_type: up.mimeType, size_bytes: bytes.byteLength,
      web_view_link: up.webViewLink ?? null, path: `${person}:${doc}:${side}`, uploader_name: who, uploader_email: lead.email, source: UPLOAD_SOURCE,
      created_time: up.createdTime ?? now, seen_at: now, upload_link_id: linkId, notified_at: linkId ? null : now,
    }, { onConflict: 'file_id' })
    if (error) console.error('[reservation-agreement] drive_folder_files', error.message)
    return { status: 200, body: { ok: true } }
  } catch (e) {
    const why = (e as Error).message
    console.error('[reservation-agreement] Ausweis-Upload', why)
    await whatsappSven(sb, `Reservierung: Ausweis-Upload von ${mainName} ging nicht in den Drive-Ordner. Grund: ${why.slice(0, 160)}`).catch(() => null)
    return { status: 503, body: { error: 'upload_failed' } }
  }
}

async function loadLead(sb: SupabaseClient, id: string): Promise<LeadRow | null> {
  const { data } = await sb.from('leads').select('id, first_name, last_name, email, alt_emails, phone, whatsapp, street, postal_code, city, country, drive_folder_url, drive_folder_id').eq('id', id).maybeSingle()
  return data as LeadRow | null
}
function countryCodeFrom(raw: string | null): string {
  const k = (raw ?? '').trim().toLowerCase()
  return k ? COUNTRIES.find(c => c.some(x => x.toLowerCase() === k))?.[0] ?? '' : ''
}

export async function addressView(sb: SupabaseClient, body: Record<string, unknown>): Promise<Res> {
  const hit = await findRow(sb, body.token)
  if (!hit) return { status: 404, body: { error: 'not_found' } }
  const lead = await loadLead(sb, hit.row.lead_id)
  if (!lead) return { status: 404, body: { error: 'not_found' } }
  const phone = (lead.whatsapp || lead.phone || '').trim()
  const lang = await resolveLang(sb, { email: lead.email, phone, lead_id: lead.id })
  if (!hit.test && !await isOpen(sb, hit.row)) return { status: 200, body: { ok: true, closed: true, lang } }
  const saved = (hit.test ? (hit.row.test_payload as { customer_data?: CustomerData } | null)?.customer_data : hit.row.customer_data) ?? null
  // Zeitpunkt und Verbindungsdaten bleiben intern, die Seite bekommt nur die Angaben selbst
  const { at: _at, ip: _ip, user_agent: _ua, ...savedPublic } = saved ?? ({} as CustomerData)
  const further = furtherBuyers(saved)
  // Nur Flora bekommt die Adresse in den Vertrag und unterschreibt zuerst beim Bauträger, die Seite sagt es nur dort
  const { data: tpl } = hit.row.template_id ? await sb.from('reservation_templates').select('layout').eq('id', hit.row.template_id).maybeSingle() : { data: null }
  const fromLead: CustomerPerson = {
    salutation: '', street: lead.street ?? '', postal_code: lead.postal_code ?? '', city: lead.city ?? '',
    country_code: countryCodeFrom(lead.country), country_other: '', phone, email: lead.email ?? '',
  }
  return {
    status: 200,
    body: {
      ok: true, closed: false, test: hit.test, lang, first_name: (lead.first_name ?? '').trim(), submitted: !!saved?.at,
      flora: (tpl as { layout?: string } | null)?.layout === 'flora', max_further: MAX_FURTHER,
      ...idState(hit.row, further), uploads: hit.test ? [] : await pageUploads(sb, lead.id, further),
      prefill: saved ? savedPublic : fromLead,
      countries: COUNTRIES.map(c => ({ code: c[0], name: lang === 'de' ? c[2] : c[1] })),
    },
  }
}

export async function addressSubmit(sb: SupabaseClient, body: Record<string, unknown>, req: Request): Promise<Res> {
  const hit = await findRow(sb, body.token)
  if (!hit) return { status: 404, body: { error: 'not_found' } }
  if (!hit.test && !await isOpen(sb, hit.row)) return { status: 409, body: { error: 'closed' } }
  const main = cleanPerson(body)
  const fields: Record<string, string> = personErrors(main)
  // body.second: Seite aus einem noch offenen Tab, die die neue Liste nicht kennt
  const further = (Array.isArray(body.further) ? body.further : body.second ? [body.second] : []).slice(0, MAX_FURTHER).filter(s => s && typeof s === 'object').map((raw, i) => {
    const s = raw as Record<string, unknown>
    const same = s.same_address !== false
    const person = cleanPerson(same ? { ...s, street: main.street, postal_code: main.postal_code, city: main.city, country_code: main.country_code, country_other: main.country_other } : s)
    const p: CustomerSecond = { ...person, first_name: text(s.first_name, 60), last_name: text(s.last_name, 60), same_address: same }
    const se = personErrors(person)
    if (p.first_name.length < 2 || !LATIN.test(p.first_name)) se.first_name = p.first_name ? 'invalid' : 'required'
    if (p.last_name.length < 2 || !LATIN.test(p.last_name)) se.last_name = p.last_name ? 'invalid' : 'required'
    for (const [k, v] of Object.entries(se)) fields[`${furtherKey(i)}_${k}`] = v
    return p
  })
  if (Object.keys(fields).length) return { status: 400, body: { error: 'invalid', fields } }

  const now = new Date().toISOString()
  const data: CustomerData = { ...main, second: further[0] ?? null, more: further.slice(1), at: now, ip: clientIp(req), user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null }
  if (hit.test) {
    await sb.from('reservation_agreements').update({ test_payload: { ...hit.row.test_payload, customer_data: data } }).eq('id', hit.row.id)
    return { status: 200, body: { ok: true, test: true, ...idState(hit.row, further), uploads: [] } }
  }
  // Korrigiert der Kunde seine Angaben, ersetzen sie seine alten auch dort, wo sie schon gespeichert waren
  const old = hit.row.customer_data as CustomerData | null
  const oldValues = old ? [old, ...furtherBuyers(old)].flatMap(p => [addressLine(p), p.phone, p.email, p.salutation]) : []
  const buyers = (hit.row.buyers ?? []).map(b => {
    const out = { ...b }
    for (const k of ['address', 'phone', 'email', 'salutation'] as const) if (out[k] && oldValues.includes(out[k]!)) delete out[k]
    return out
  })
  const { error } = await sb.from('reservation_agreements').update({ customer_data: data, buyers, updated_at: now }).eq('id', hit.row.id)
  if (error) throw new Error(`Angaben speichern: ${error.message}`)
  // Ins CRM: Adresse immer (kommt frisch vom Kunden), Telefon und E-Mail nur, wenn dort nichts steht,
  // denn über diese beiden läuft die ganze Kommunikation und die Zuordnung des Kunden.
  const lead = await loadLead(sb, hit.row.lead_id)
  const patch: Record<string, string | string[]> = { street: main.street, postal_code: main.postal_code, city: main.city, country: countryDe(main) }
  if (lead && !lead.email?.trim()) patch.email = main.email
  if (lead && !lead.whatsapp?.trim() && !lead.phone?.trim()) patch.phone = main.phone
  // Andere Adresse als im CRM: Das Hauptfeld bleibt, sie kommt zu den Zweit-Adressen. Der Drive-Ordner soll
  // auch mit ihr aufgehen (Frank Roeding 6.11.2026: Firmenmail im CRM ohne Google-Konto, hier sein Google-Konto).
  const bekannt = [lead?.email, ...(lead?.alt_emails ?? [])].map(m => (m ?? '').trim().toLowerCase())
  if (lead?.email?.trim() && !bekannt.includes(main.email)) patch.alt_emails = [...(lead.alt_emails ?? []), main.email]
  const { error: leadErr } = await sb.from('leads').update(patch).eq('id', hit.row.lead_id)
  if (leadErr) console.error('[reservation-agreement] Adresse ins CRM', leadErr.message)
  else if (lead?.drive_folder_id && (patch.email || patch.alt_emails)) {
    // Nur die Freigabe, die Antwort an den Kunden hängt nicht davon ab
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    await sb.functions.invoke('create-client-drive-folder', {
      body: { lead_id: hit.row.lead_id, extra_emails: [] },
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    }).catch(e => console.error('[reservation-agreement] Drive-Freigabe', (e as Error).message))
  }
  await sb.from('activities').insert({
    lead_id: hit.row.lead_id, deal_id: hit.row.deal_id, type: 'note', direction: 'inbound', auto: true,
    subject: 'Reservierung: Adresse vom Kunden eingetragen', content: `Der Kunde hat seine Angaben für den Reservierungsvertrag eingetragen: ${addressLine(main)}${further.length ? `. Weitere Käufer: ${further.map(p => `${p.first_name} ${p.last_name}`).join(', ')}` : ''}.`,
    completed_at: now,
  })
  return { status: 200, body: { ok: true, ...idState(hit.row, further), uploads: await pageUploads(sb, hit.row.lead_id, further) } }
}

// ── Vertrag ──────────────────────────────────────────────────────────────────
const tokens = (s: string) => norm(s).split(' ').filter(x => x.length > 1)
/** Ganzer Nachname und erster Vorname müssen auf dem Ausweis stehen. */
export function sameName(fullName: string, first: string | null | undefined, last: string | null | undefined): boolean {
  const have = new Set(tokens(fullName)), f = tokens(first ?? '')[0], l = tokens(last ?? '')
  return !!f && l.length > 0 && have.has(f) && l.every(x => have.has(x))
}

/** Käuferliste mit den Angaben des Kunden ergänzen. Nur leere Felder, Svens Eingaben bleiben. */
export function withCustomerData(list: Buyer[], row: Pick<AgreementRow, 'customer_data'>, ctx: Ctx): Buyer[] {
  const d = row.customer_data as CustomerData | null
  if (!d?.at) return list
  return list.map(b => {
    const other = furtherBuyers(d).find(p => sameName(b.full_name, p.first_name, p.last_name))
    const isLead = sameName(b.full_name, ctx.lead.first_name, ctx.lead.last_name)
    const src: CustomerPerson | null = other ?? ((isLead || list.length === 1) ? d : null)
    if (!src) return b
    return { ...b, salutation: b.salutation || src.salutation, address: b.address || addressLine(src), phone: b.phone || src.phone, email: b.email || src.email }
  })
}

/** Der Kunde hat weitere Käufer angegeben: Ohne ihre Ausweise geht bei keinem Bauträger ein Vertrag raus. */
export function furtherIdMissing(list: Buyer[], row: Pick<AgreementRow, 'customer_data'>): string | null {
  const missing = furtherBuyers(row.customer_data as CustomerData | null).filter(p => !list.some(b => sameName(b.full_name, p.first_name, p.last_name)))
  return missing.length ? `Ausweis von ${missing.map(p => `${p.first_name} ${p.last_name}`).join(', ')} fehlt noch` : null
}

/** Worauf der Vertrag noch wartet. Null = alles da, die Prüfung kann laufen. */
export function floraWaitingFor(list: Buyer[], row: Pick<AgreementRow, 'customer_data'>, ctx: Ctx): string | null {
  const d = row.customer_data as CustomerData | null
  const idMissing = furtherIdMissing(list, row)
  if (idMissing) return idMissing
  if (d?.at) return null
  return floraBuyers(ctx, list).some(b => !b.salutation || !b.address || !b.telephone || !b.email) ? 'Adresse vom Kunden fehlt noch' : null
}
