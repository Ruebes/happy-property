// Adresse des Empfehlungsgebers für die Abrechnung beschaffen (Sven 23.10.2026).
//
//   findAddress   Profil → Rechnungskunde → Drive-Kundenordner (Kaufvertrag, Reservierung,
//                 Ausweis, Vollmacht ...). Übernommen wird eine Adresse NUR, wenn sie dort
//                 ausdrücklich zum Namen des Empfehlungsgebers steht. Kauft jemand für seine
//                 Kinder (Rainer Wallmeyer), stehen im Ordner die Kinder: Vorname passt nicht
//                 → keine Übernahme, Lotte fragt später per WhatsApp.
//   parseReply    WhatsApp-Antwort(en) auf Lottes Frage → Postanschrift (KI, strikt geprüft).
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { callAnthropic, toolInput } from '../_shared/anthropic.ts'
import { saToken, listTree, download, thumbnail, type DriveFile } from '../reservation-agreement/drive.ts'

export interface Addr { street: string; postal_code: string; city: string; country: string }
export interface Found extends Addr { source: 'profil' | 'rechnungskunde' | 'dokument'; note: string }

const MAX_FILES = 8                       // je Suche höchstens so viele Dateien an die KI
const PARALLEL = 3
const BUDGET_MS = 120_000
const MAX_PDF_BYTES = 15 * 1024 * 1024
const MAX_IMAGE_BYTES = 3_700_000         // darüber Google-Vorschaubild (wie reservation-agreement)
const AI_MIME = /^(application\/pdf|image\/(jpeg|png|webp|gif))$/
// Welche Dateien kommen in Frage? Verträge zuerst, dann Ausweise, dann sonstige Unterlagen mit Anschrift.
const PRIO: RegExp[] = [
  /kauf|purchase|sale|contract|vertrag|agreement|reserv/i,
  /ausweis|personal|\bid\b|passport|reisepass|\bpass\b|identity|melde/i,
  /vollmacht|power|attorney|\bpoa\b|bank|finanz|kredit|loan|steuer|\btax\b|anschrift|address|adresse/i,
]
const SKIP = /spec|grundriss|floor|plan|render|brochure|expos|preis|price|foto|photo|video|baustelle/i

export const hasAddress = (a: { street?: string | null; postal_code?: string | null; city?: string | null }) =>
  !!(a.street?.trim() && a.postal_code?.trim() && a.city?.trim())
/** Adresse inkl. Land: erst dann muss Lotte nicht (mehr) fragen. */
export const addressComplete = (a: { street?: string | null; postal_code?: string | null; city?: string | null; country?: string | null }) =>
  hasAddress(a) && !!a.country?.trim()

/** Svens Regel (23.10.2026): Provisionsabrechnung nur mit kompletten Stammdaten.
 *  Gibt zurück, was fehlt (leer = vollständig). */
export function missingData(a: {
  name?: string | null; email?: string | null; whatsapp?: string | null
  street?: string | null; postal_code?: string | null; city?: string | null; country?: string | null
  is_business?: boolean | null; vat_id?: string | null
}): string[] {
  const m: string[] = []
  if ((a.name ?? '').trim().length < 2) m.push('Name')
  if (!a.street?.trim()) m.push('Straße')
  if (!a.postal_code?.trim()) m.push('PLZ')
  if (!a.city?.trim()) m.push('Ort')
  if (!a.country?.trim()) m.push('Land')
  if (a.is_business && !a.vat_id?.trim()) m.push('USt-IdNr.')
  if (!a.email?.trim() && !a.whatsapp?.trim()) m.push('E-Mail oder WhatsApp')
  return m
}

// ── Namen vergleichen ─────────────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z\s-]/g, ' ').replace(/-/g, ' ')
const toks = (s: string) => norm(s).split(/\s+/).filter(t => t.length > 1)

export interface PersonName { first: string; last: string }

/** Gleiche Person? Nachname muss vollständig passen UND der erste Vorname. So wird
 *  aus „Rainer Wallmeyer“ nie „Tim Wallmeyer“ (gleicher Nachname, andere Person). */
export function samePerson(want: PersonName, given: string, surname: string): boolean {
  const last = toks(want.last), first = toks(want.first)[0]
  if (!last.length || !first) return false
  const theirs = new Set([...toks(given), ...toks(surname)])
  const theirGiven = new Set(toks(given))
  return last.every(t => theirs.has(t)) && theirGiven.has(first)
}

// ── Quellen ohne KI: Profil + Rechnungskunde ─────────────────────────────────
async function fromDb(sb: SupabaseClient, leadId: string | null, emails: string[], who: PersonName): Promise<Found | null> {
  if (leadId) {
    const { data: l } = await sb.from('leads').select('profile_id').eq('id', leadId).maybeSingle()
    const pid = (l as { profile_id: string | null } | null)?.profile_id
    if (pid) {
      const { data: p } = await sb.from('profiles').select('address_street, address_zip, address_city, address_country').eq('id', pid).maybeSingle()
      const pr = p as { address_street: string | null; address_zip: string | null; address_city: string | null; address_country: string | null } | null
      if (pr && hasAddress({ street: pr.address_street, postal_code: pr.address_zip, city: pr.address_city })) {
        return { street: pr.address_street!.trim(), postal_code: pr.address_zip!.trim(), city: pr.address_city!.trim(),
          country: pr.address_country?.trim() ?? '', source: 'profil', note: 'aus dem Eigentümer-Profil' }
      }
    }
  }
  // Rechnungskunde nur als Privatperson mit passendem Namen (Firmenadresse gehört nicht
  // auf eine private Provisionsabrechnung).
  for (const mail of emails) {
    const { data: ics } = await sb.from('invoice_customers')
      .select('company_name, contact_name, address_line1, postal_code, city, country').ilike('email', mail).limit(5)
    for (const ic of (ics ?? []) as Array<{ company_name: string | null; contact_name: string | null; address_line1: string | null; postal_code: string | null; city: string | null; country: string | null }>) {
      if (ic.company_name?.trim() || !ic.contact_name) continue
      const parts = ic.contact_name.trim().split(/\s+/)
      if (!samePerson(who, parts.slice(0, -1).join(' '), parts[parts.length - 1] ?? '')) continue
      if (!hasAddress({ street: ic.address_line1, postal_code: ic.postal_code, city: ic.city })) continue
      return { street: ic.address_line1!.trim(), postal_code: ic.postal_code!.trim(), city: ic.city!.trim(),
        country: ic.country?.trim() ?? '', source: 'rechnungskunde', note: 'aus den Rechnungskunden' }
    }
  }
  return null
}

// ── Drive-Unterlagen ─────────────────────────────────────────────────────────
interface DocPerson { given_names: string; surname: string; street: string; postal_code: string; city: string; country: string }
interface DocResult { document_kind: string; persons: DocPerson[]; note: string }

const DOC_TOOL = {
  name: 'record_addresses',
  description: 'Record every natural person in the document for whom a residential or postal address is printed.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['document_kind', 'persons', 'note'],
    properties: {
      document_kind: { type: 'string', description: 'Short German label, e.g. "Personalausweis (Rückseite)", "Reservierungsvertrag", "Kaufvertrag", "Vollmacht", "Sonstiges".' },
      persons: {
        type: 'array',
        description: 'One entry per natural person whose own address is explicitly printed in the document. Skip companies, developers, sellers\' company addresses, lawyers\' offices and the property address. Never guess or complete an address, never move one person\'s address to another person.',
        items: {
          type: 'object', additionalProperties: false,
          required: ['given_names', 'surname', 'street', 'postal_code', 'city', 'country'],
          properties: {
            given_names: { type: 'string', description: 'All given names as printed, Latin letters.' },
            surname: { type: 'string', description: 'Surname as printed, Latin letters.' },
            street: { type: 'string', description: 'Street and house number exactly as printed.' },
            postal_code: { type: 'string', description: 'Postal code as printed, empty string if none.' },
            city: { type: 'string', description: 'City as printed.' },
            country: { type: 'string', description: 'Country in German (e.g. Deutschland, Österreich, Schweiz, Zypern). Empty string if not printed and not obvious.' },
          },
        },
      },
      note: { type: 'string', description: 'Short remark, e.g. which part was hard to read.' },
    },
  },
}

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function readDoc(bytes: Uint8Array, mime: string, name: string): Promise<DocResult | null> {
  const block = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(bytes) } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: b64(bytes) } }
  const res = await callAnthropic(Deno.env.get('ANTHROPIC_API_KEY') ?? '', {
    model: 'claude-opus-5-5',
    fallbackModels: ['claude-sonnet-4-6'],
    max_tokens: 4000,
    label: 'tippgeber-adresse',
    system: 'You read documents from a real-estate buyer\'s folder (ID cards, passports, reservation agreements, purchase contracts, powers of attorney, bank letters). '
      + 'Extract the residential addresses of the natural persons named in them, exactly as printed. The address goes onto a commission statement, so accuracy matters more than completeness. '
      + 'Always answer by calling the tool record_addresses exactly once.',
    messages: [{ role: 'user', content: [block, { type: 'text', text: `File name: ${name}\nCall record_addresses with the result.` }] }],
    tools: [DOC_TOOL],
    tool_choice: { type: 'auto' },
  })
  if (!res.ok) { console.error('[affiliate-api] Adresse lesen', name, res.error); return null }
  const out = toolInput<DocResult>(res)
  return out && Array.isArray(out.persons) ? out : null
}

// Unbenannte Scans (IMG_1234.jpg, Scan.pdf) kommen zuletzt dran, Prospekte/Pläne/Fotos gar nicht.
function pickFiles(files: DriveFile[], newerThan: string | null): DriveFile[] {
  const rank = (f: DriveFile) => { const i = PRIO.findIndex(r => r.test(f.name)); return i < 0 ? PRIO.length : i }
  return files
    .filter(f => (f.mimeType.startsWith('image/') || f.mimeType === 'application/pdf' || f.mimeType === 'application/vnd.google-apps.document'))
    .filter(f => !newerThan || (f.createdTime ?? '') > newerThan)
    .filter(f => !(SKIP.test(f.name) && rank(f) > 1))
    .sort((a, b) => (rank(a) - rank(b)) || String(b.createdTime ?? '').localeCompare(String(a.createdTime ?? '')))
    .slice(0, MAX_FILES)
}

/** Was in welcher Datei stand (nur Namen + Ort, für die Diagnose) */
export interface Seen { file: string; kind: string; persons: string[] }

async function fromDrive(folderId: string, who: PersonName, newerThan: string | null)
  : Promise<{ found: Found | null; read: number; failed: number; note: string; seen: Seen[] }> {
  const token = await saToken()
  const files = pickFiles(await listTree(token, folderId), newerThan)
  if (!files.length) return { found: null, read: 0, failed: 0, seen: [], note: newerThan ? 'keine neuen Unterlagen im Drive' : 'keine passenden Unterlagen im Drive' }
  const started = Date.now()
  let next = 0, read = 0, failed = 0
  const seen: Seen[] = []
  let found: Found | null = null
  const worker = async () => {
    while (next < files.length && !found && Date.now() - started < BUDGET_MS) {
      const f = files[next++]
      try {
        const size = Number(f.size ?? 0)
        const raw = AI_MIME.test(f.mimeType) && size <= (f.mimeType === 'application/pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)
        const src = raw || f.mimeType === 'application/vnd.google-apps.document' ? await download(token, f) : await thumbnail(token, f)
        if (!src) { failed++; continue }
        const doc = await readDoc(src.bytes, src.mime, f.name)
        if (!doc) { failed++; continue }
        read++
        seen.push({ file: f.name, kind: doc.document_kind, persons: doc.persons.map(p => `${p.given_names} ${p.surname} (${p.city || 'ohne Ort'})`) })
        const hit = doc?.persons.find(p => samePerson(who, p.given_names, p.surname)
          && hasAddress({ street: p.street, postal_code: p.postal_code, city: p.city }))
        if (hit && !found) {
          found = { street: hit.street.trim(), postal_code: hit.postal_code.trim(), city: hit.city.trim(), country: hit.country.trim(),
            source: 'dokument', note: `aus „${f.name}“ im Drive-Ordner (${doc!.document_kind})` }
        }
      } catch (e) { failed++; console.warn('[affiliate-api] Drive-Datei', f.name, (e as Error).message) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker))
  // Nichts lesbar (KI/Drive gestört)? Dann ist „nicht gefunden“ keine Aussage: nächster Lauf versucht es wieder.
  if (!found && read === 0 && failed > 0) throw new Error(`${failed} Unterlagen nicht lesbar`)
  const note = `${read} ${read === 1 ? 'Unterlage' : 'Unterlagen'} im Drive geprüft${failed ? `, ${failed} nicht lesbar` : ''}`
  return { found, read, failed, note, seen }
}

/** Sucht die Adresse in allen Quellen. newerThan: nur Drive-Dateien, die danach dazukamen. */
export async function findAddress(sb: SupabaseClient, aff: { lead_id: string | null; name: string; email: string | null }, newerThan: string | null)
  : Promise<{ found: Found | null; note: string; seen?: Seen[] }> {
  let who: PersonName = { first: aff.name.trim().split(/\s+/).slice(0, -1).join(' '), last: aff.name.trim().split(/\s+/).slice(-1)[0] ?? '' }
  let folderId: string | null = null
  const emails = new Set<string>()
  if (aff.email) emails.add(aff.email.trim().toLowerCase())
  if (aff.lead_id) {
    const { data: l } = await sb.from('leads').select('first_name, last_name, email, drive_folder_id').eq('id', aff.lead_id).maybeSingle()
    const lr = l as { first_name: string | null; last_name: string | null; email: string | null; drive_folder_id: string | null } | null
    if (lr?.first_name?.trim() && lr.last_name?.trim()) who = { first: lr.first_name, last: lr.last_name }
    if (lr?.email) emails.add(lr.email.trim().toLowerCase())
    folderId = lr?.drive_folder_id ?? null
  }
  const db = await fromDb(sb, aff.lead_id, [...emails], who)
  if (db) return { found: db, note: db.note }
  if (!folderId) return { found: null, note: 'nicht im Profil, kein Drive-Ordner' }
  const dr = await fromDrive(folderId, who, newerThan)
  return { found: dr.found, note: dr.found ? dr.found.note : `nicht gefunden (${dr.note})`, seen: dr.seen }
}

// ── WhatsApp-Antwort lesen ───────────────────────────────────────────────────
export interface ReplyResult {
  kind: 'address' | 'partial' | 'not_address'
  for_other_person: boolean
  company_name: string
  street: string; postal_code: string; city: string; country: string
  note: string
}
const REPLY_TOOL = {
  name: 'record_postal_address',
  description: 'Record the postal address contained in the WhatsApp replies.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'for_other_person', 'company_name', 'street', 'postal_code', 'city', 'country', 'note'],
    properties: {
      kind: { type: 'string', enum: ['address', 'partial', 'not_address'], description: 'address: street with house number, postal code and city are all given. partial: only part of an address so far. not_address: the replies contain no address (questions, "later", thanks ...).' },
      for_other_person: { type: 'boolean', description: 'true if the sender says the statement should go to someone else (spouse, child, another person).' },
      company_name: { type: 'string', description: 'Company name if the sender wants the statement addressed to a company, else empty string.' },
      street: { type: 'string', description: 'Street and house number as written (fix obvious capitalisation only).' },
      postal_code: { type: 'string' },
      city: { type: 'string' },
      country: { type: 'string', description: 'Country in German. If not written, infer only when unambiguous (e.g. German city with 5-digit postal code → Deutschland), else empty string.' },
      note: { type: 'string', description: 'Short remark in German.' },
    },
  },
}

export async function parseReply(text: string, name: string): Promise<ReplyResult | null> {
  const res = await callAnthropic(Deno.env.get('ANTHROPIC_API_KEY') ?? '', {
    model: 'claude-opus-5-5',
    fallbackModels: ['claude-sonnet-4-6'],
    max_tokens: 1500,
    label: 'tippgeber-adresse-antwort',
    system: 'Lotte from Happy Property asked a referrer by WhatsApp for his or her postal address for a referral commission statement. '
      + 'You get the referrer\'s replies since that question. Extract the postal address only if the replies actually contain it. Never invent or complete missing parts. '
      + 'Always answer by calling the tool record_postal_address exactly once.',
    messages: [{ role: 'user', content: `Referrer: ${name}\n\nReplies (oldest first):\n${text}` }],
    tools: [REPLY_TOOL],
    tool_choice: { type: 'auto' },
  })
  if (!res.ok) { console.error('[affiliate-api] Antwort lesen', res.error); return null }
  const out = toolInput<ReplyResult>(res)
  return out && ['address', 'partial', 'not_address'].includes(out.kind) ? out : null
}
