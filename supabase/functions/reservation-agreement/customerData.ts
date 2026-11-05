// Angaben, die nicht im Ausweis stehen, trägt der Kunde selbst ein (Sven 5.11.2026, Flora Panorama):
// Seite /sign/a/:token, kein Login, nur Token. Der Link steht in der Nachricht, die bei Phase
// Reservierung rausgeht (schedule-message). Die Adresse landet im Vertrag und beim Kunden im CRM.
// Von Sven im CRM Eingetragenes hat Vorrang, der Kunde füllt nur Lücken.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { resolveLang } from '../_shared/recipientLang.ts'
import { clientIp } from './seal.ts'
import { norm, type AgreementRow, type Buyer, type Ctx } from './index.ts'
import { floraBuyers } from './twoParty.ts'

type Res = { status: number; body: Record<string, unknown> }
export interface CustomerPerson {
  salutation: string; street: string; postal_code: string; city: string
  country_code: string; country_other: string; phone: string; email: string
}
export interface CustomerSecond extends CustomerPerson { first_name: string; last_name: string; same_address: boolean }
export interface CustomerData extends CustomerPerson {
  second: CustomerSecond | null
  at: string; ip?: string | null; user_agent?: string | null
}

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
  const { data } = await sb.from('deals').select('phase').eq('id', row.deal_id).maybeSingle()
  return !!data && !DEAD.includes((data as { phase: string }).phase)
}

interface LeadRow {
  id: string; first_name: string | null; email: string | null; phone: string | null; whatsapp: string | null
  street: string | null; postal_code: string | null; city: string | null; country: string | null
  drive_folder_url: string | null; drive_folder_id: string | null
}
async function loadLead(sb: SupabaseClient, id: string): Promise<LeadRow | null> {
  const { data } = await sb.from('leads').select('id, first_name, email, phone, whatsapp, street, postal_code, city, country, drive_folder_url, drive_folder_id').eq('id', id).maybeSingle()
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
  const fromLead: CustomerPerson = {
    salutation: '', street: lead.street ?? '', postal_code: lead.postal_code ?? '', city: lead.city ?? '',
    country_code: countryCodeFrom(lead.country), country_other: '', phone, email: lead.email ?? '',
  }
  return {
    status: 200,
    body: {
      ok: true, closed: false, test: hit.test, lang, first_name: (lead.first_name ?? '').trim(), submitted: !!saved?.at,
      drive_link: lead.drive_folder_url ?? (lead.drive_folder_id ? `https://drive.google.com/drive/folders/${lead.drive_folder_id}` : null),
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
  let second: CustomerSecond | null = null
  if (body.second && typeof body.second === 'object') {
    const s = body.second as Record<string, unknown>
    const same = s.same_address !== false
    const person = cleanPerson(same ? { ...s, street: main.street, postal_code: main.postal_code, city: main.city, country_code: main.country_code, country_other: main.country_other } : s)
    second = { ...person, first_name: text(s.first_name, 60), last_name: text(s.last_name, 60), same_address: same }
    const se = personErrors(person)
    if (second.first_name.length < 2 || !LATIN.test(second.first_name)) se.first_name = second.first_name ? 'invalid' : 'required'
    if (second.last_name.length < 2 || !LATIN.test(second.last_name)) se.last_name = second.last_name ? 'invalid' : 'required'
    for (const [k, v] of Object.entries(se)) fields[`second_${k}`] = v
  }
  if (Object.keys(fields).length) return { status: 400, body: { error: 'invalid', fields } }

  const now = new Date().toISOString()
  const data: CustomerData = { ...main, second, at: now, ip: clientIp(req), user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null }
  if (hit.test) {
    await sb.from('reservation_agreements').update({ test_payload: { ...hit.row.test_payload, customer_data: data } }).eq('id', hit.row.id)
    return { status: 200, body: { ok: true, test: true } }
  }
  // Korrigiert der Kunde seine Angaben, ersetzen sie seine alten auch dort, wo sie schon gespeichert waren
  const old = hit.row.customer_data as CustomerData | null
  const oldValues = old ? [old, ...(old.second ? [old.second] : [])].flatMap(p => [addressLine(p), p.phone, p.email, p.salutation]) : []
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
  const patch: Record<string, string> = { street: main.street, postal_code: main.postal_code, city: main.city, country: countryDe(main) }
  if (lead && !lead.email?.trim()) patch.email = main.email
  if (lead && !lead.whatsapp?.trim() && !lead.phone?.trim()) patch.phone = main.phone
  const { error: leadErr } = await sb.from('leads').update(patch).eq('id', hit.row.lead_id)
  if (leadErr) console.error('[reservation-agreement] Adresse ins CRM', leadErr.message)
  await sb.from('activities').insert({
    lead_id: hit.row.lead_id, deal_id: hit.row.deal_id, type: 'note', direction: 'inbound', auto: true,
    subject: 'Reservierung: Adresse vom Kunden eingetragen', content: `Der Kunde hat seine Angaben für den Reservierungsvertrag eingetragen: ${addressLine(main)}${second ? `. Zweiter Käufer: ${second.first_name} ${second.last_name}` : ''}.`,
    completed_at: now,
  })
  return { status: 200, body: { ok: true } }
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
    const isSecond = !!d.second && sameName(b.full_name, d.second.first_name, d.second.last_name)
    const isLead = sameName(b.full_name, ctx.lead.first_name, ctx.lead.last_name)
    const src: CustomerPerson | null = isSecond ? d.second : (isLead || list.length === 1) ? d : null
    if (!src) return b
    return { ...b, salutation: b.salutation || src.salutation, address: b.address || addressLine(src), phone: b.phone || src.phone, email: b.email || src.email }
  })
}

/** Worauf der Vertrag noch wartet. Null = alles da, die Prüfung kann laufen. */
export function floraWaitingFor(list: Buyer[], row: Pick<AgreementRow, 'customer_data'>, ctx: Ctx): string | null {
  const d = row.customer_data as CustomerData | null
  if (d?.second && !list.some(b => sameName(b.full_name, d.second!.first_name, d.second!.last_name))) return `Ausweis von ${d.second.first_name} ${d.second.last_name} fehlt noch`
  if (d?.at) return null
  return floraBuyers(ctx, list).some(b => !b.salutation || !b.address || !b.telephone || !b.email) ? 'Adresse vom Kunden fehlt noch' : null
}
