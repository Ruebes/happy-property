// reservation-agreement — Reservierungsvertrag des Bauträgers automatisch ausfüllen
// und an den Bauträger schicken (Sven 15.10.2026).
//
// Ablauf:
//   1. Deal steht auf „reservierung", die Wohnung gehört zu einem Bauträger mit
//      aktiver Vorlage (reservation_templates, z. B. „Reservierung Mito")
//      → Zeile in reservation_agreements (status wartet_ausweis).
//   2. Kunde lädt seinen Ausweis in den Drive-Kundenordner. Jede neue Datei läuft
//      einmal durch die KI (ausweis.ts): Ausweis / Reservierungsvertrag / sonstiges,
//      bei Ausweisen Name + Passnummer.
//   3. 30 Minuten nach dem letzten Ausweis (Paare laden oft nacheinander hoch)
//      wird der Vertrag ausgefüllt (pdf.ts) und geprüft (Name passt zum Kunden,
//      Nummer lesbar, nicht abgelaufen, Preis da). Alles gut → PDF per Mail an den
//      Bauträger + WhatsApp-Hinweis, Kopie an Sven. Sonst → status pruefen +
//      WhatsApp an Sven.
//   4. Der Bauträger unterschreibt und lädt den Vertrag in den Drive-Ordner (dort
//      sehen ihn Kunde und Anwalt, Sven 15.10.: NICHT direkt an den Kunden). Sobald
//      die unterschriebene Fassung dort liegt, wird sie an der Wohnung abgelegt
//      (crm_unit_documents, im Portal unter „Verträge") → status unterschrieben.
//      Bis dahin (max. 30 Tage) achtet das System auch auf nachgereichte Ausweise.
//
// Schalter crm_settings.reservation_agreement_mode: on | test (alles nur an Sven) | off.
//
// Aktionen:
//   { action:'sweep' }                                   Cron alle 5 Min (Service-Role)
//   { action:'status',  deal_id }                         Zeile lesen
//   { action:'preview', deal_id }                         PDF bauen, nichts senden (base64)
//   { action:'preview_template', template, sample? }      Vorlage mit Beispieldaten (base64)
//   { action:'send',    deal_id, buyers?, test? }         jetzt bauen + senden (Svens Knopf);
//                                                         test=true → nur an Sven
//   { action:'check_file', base64, mime, name }           Diagnose: eine Datei durch die KI-Prüfung
//
// Öffentlich (nur mit Unterschrifts-Token, Seite /sign/r/:token, siehe sign.ts):
//   { action:'sign_view',   token }                       Vertragsdaten + PDF zum Unterschreiben
//   { action:'sign_submit', token, signature, name, use_seal?, seal? }  Unterschrift (+ Stempel) einsetzen
//   { action:'doc_view' | 'doc_submit', token, ... }      dasselbe für Spezifikationen (/sign/d/:token, docsign.ts)
//
// Admin weitere: doc_create {deal_id, file_base64, file_name, title?, test?} (docsign.ts),
//                seal_get | seal_set {png} | seal_delete  {developer_id} (seal.ts)
//
// Deploy: supabase functions deploy reservation-agreement --no-verify-jwt
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { gateCaller } from '../_shared/callerGate.ts'
import { saToken, listTree, download, thumbnail, uploadToken, uploadFile, type DriveFile } from './drive.ts'
import { checkFile, type FileCheck, type IdPerson } from './ausweis.ts'
import { renderAgreement, type AgreementFields, type PropertyKind, type TemplateRow } from './pdf.ts'
import { signView, signSubmit } from './sign.ts'
import { docCreate, docView, docSubmit } from './docsign.ts'
import { loadSeal, saveSeal, removeSeal, sealDataUrl, pngFromInput, MAX_SEAL_BYTES } from './seal.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

export const SVEN_PHONE = '+35795096409'
export const SVEN_MAIL = 'sven@happy-property.com'
export const CRM_LEAD = 'https://portal.happy-property.com/admin/crm/leads/'
const SIGN_BASE = 'https://portal.happy-property.com/sign/r/'
// Nur Deals, die NACH dem Start auf Reservierung gingen (kein Rückwirken auf alte Deals).
const FLOW_START = '2026-10-15T00:00:00Z'
const QUIET_MIN = 30                 // Wartezeit nach dem letzten Ausweis
const WAIT_DAYS = 45                 // so lange auf einen Ausweis warten
const WATCH_AFTER_SEND_DAYS = 30     // nach dem Versand auf den unterschriebenen Vertrag + weitere Ausweise achten
const SCAN_PARALLEL = 3              // KI-Prüfungen gleichzeitig
const SCAN_BUDGET_MS = 100_000       // danach keine neue Prüfung mehr starten (Rest im nächsten Lauf)
const INTERACTIVE_SCAN_MS = 70_000   // Knopf im CRM: Antwort muss vor dem Function-Limit kommen
const MAX_BYTES = 15 * 1024 * 1024          // PDFs gehen bis hierhin roh an die KI
const MAX_IMAGE_BYTES = 3_700_000           // Bilder darüber (Base64 > 5 MB) lehnt die API ab → Google-Vorschaubild
const SWEEP_BUDGET_MS = 300_000             // ein Sweep-Lauf bearbeitet nur so lange Verträge
const SEND_PHASES = ['reservierung']        // nur in dieser Phase geht ein Vertrag AUTOMATISCH raus
const MAX_ATTEMPTS = 3
const AI_MIME = /^(application\/pdf|image\/(jpeg|png|webp|gif))$/
const DEAD_PHASES = ['deal_verloren', 'archiviert']
// Bild zur WhatsApp an den Bauträger (Higgsfield, Unterlagen auf dem Schreibtisch). Ohne Bild
// zeigt WhatsApp zum Drive-Link nur die Google-Anmeldeseite als Vorschau (Sven 15.10.).
const DEV_WA_IMAGE = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/reservierung-unterlagen.jpg'

type Client = SupabaseClient
type Mode = 'on' | 'test' | 'off'

export interface TemplateDb extends TemplateRow {
  id: string; name: string; developer_id: string; is_active: boolean; auto_send: boolean
  property_prefix: string | null; project_addresses: Record<string, string>; sign_place: string | null
}
interface Buyer {
  full_name: string; document_number: string; document_type: string; nationality: string
  date_of_birth: string; expiry_date: string; file_id: string; file_name: string
}
interface CheckedFile {
  name: string; at: string; created?: string | null
  mime?: string
  is_id?: boolean; persons?: IdPerson[]; note?: string
  kind?: FileCheck['kind']; signed?: boolean; unit?: string
  failed?: number; skipped?: string
}
export interface AgreementRow {
  id: string; deal_id: string; lead_id: string; unit_id: string | null; template_id: string | null
  status: string; buyers: Buyer[]; checked_files: Record<string, CheckedFile>
  last_id_at: string | null; review_reason: string | null; pdf_path: string | null
  unit_document_id: string | null; drive_file_id: string | null; sent_at: string | null
  sven_notified_at: string | null; created_at: string; signed_file_id: string | null
  data: AgreementFields | null; template_snapshot: TemplateDb | null
  sign_token: string | null; test_sign_token: string | null; test_payload: { fields: AgreementFields; template: TemplateDb } | null
  seller_signed_at: string | null; seller_signer_name: string | null; signed_pdf_path: string | null; signer_lang: string | null
  own_file_ids: string[] | null; updated_at: string; sending_at: string | null
}
export interface Ctx {
  deal: { id: string; lead_id: string; unit_id: string | null; phase: string }
  lead: { id: string; first_name: string | null; last_name: string | null; email: string | null; drive_folder_id: string | null; drive_folder_url: string | null }
  unit: { id: string; unit_number: string; type: string | null; price_net: number | null; project_id: string }
  /** Teil-Wohnungen (Doppelapartment, z. B. A1 = A1a + A1b) */
  subUnits: string[]
  project: { id: string; name: string; developer: string | null; location: string | null; payment_schedule: { reservation?: number; reservationVat?: boolean } | null }
  developerName: string
  template: TemplateDb
  devEmails: string[]
  devPhone: { name: string; phone: string } | null
  /** Sprache des WhatsApp-Empfängers = Sprache der Unterschriftsseite (crm_developer_contacts.language) */
  devLang: 'de' | 'en'
  /** Sprache je Mail-Empfänger */
  devMailLang: Record<string, 'de' | 'en'>
}

export const leadName = (l: Ctx['lead']) => [l.first_name, l.last_name].map(x => (x ?? '').trim()).filter(Boolean).join(' ') || l.email || 'Kunde'
// Umlaute wie in der maschinenlesbaren Zone des Passes falten (MÜLLER = MUELLER), dann Akzente weg
export const norm = (s: string) => s
  .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const eurEn = (n: number) => `EUR ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
export const todayCy = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Nicosia', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date())

async function mode(sb: Client): Promise<Mode> {
  const { data } = await sb.from('crm_settings').select('value').eq('key', 'reservation_agreement_mode').maybeSingle()
  const v = String((data as { value?: unknown } | null)?.value ?? 'off').replace(/"/g, '').trim()
  return v === 'on' || v === 'test' ? v : 'off'
}

// ── Kontext eines Deals laden ─────────────────────────────────────────────────
export async function loadCtx(sb: Client, dealId: string, fallbackTemplate?: TemplateDb | null): Promise<Ctx | { error: string }> {
  const { data: deal } = await sb.from('deals').select('id, lead_id, unit_id, phase').eq('id', dealId).maybeSingle()
  if (!deal) return { error: 'Deal nicht gefunden' }
  const d = deal as Ctx['deal']
  if (!d.unit_id) return { error: 'Am Deal ist keine Wohnung zugewiesen' }
  const { data: lead } = await sb.from('leads').select('id, first_name, last_name, email, drive_folder_id, drive_folder_url').eq('id', d.lead_id).maybeSingle()
  if (!lead) return { error: 'Kunde nicht gefunden' }
  const { data: unit } = await sb.from('crm_project_units').select('id, unit_number, type, price_net, project_id').eq('id', d.unit_id).maybeSingle()
  if (!unit) return { error: 'Wohnung nicht gefunden' }
  const u = unit as Ctx['unit']
  const { data: subs } = await sb.from('crm_project_units').select('unit_number').eq('parent_unit_id', u.id).order('unit_number')
  const subUnits = ((subs ?? []) as Array<{ unit_number: string }>).map(x => x.unit_number).filter(Boolean)
  const { data: proj } = await sb.from('crm_projects').select('id, name, developer, location, payment_schedule').eq('id', u.project_id).maybeSingle()
  if (!proj) return { error: 'Projekt nicht gefunden' }
  const p = proj as Ctx['project']
  if (!p.developer) return { error: 'Projekt ohne Bauträger' }
  const { data: dev } = await sb.from('crm_developers').select('id, name').ilike('name', p.developer).limit(1).maybeSingle()
  const devId = (dev as { id?: string } | null)?.id
  if (!devId) return { error: `Bauträger ${p.developer} nicht angelegt` }
  const { data: active } = await sb.from('reservation_templates').select('*').eq('developer_id', devId).eq('is_active', true).maybeSingle()
  const tpl = active ?? fallbackTemplate ?? null
  if (!tpl) return { error: `Keine Reservierungsvorlage für ${p.developer}` }
  const { data: contacts } = await sb.from('crm_developer_contacts')
    .select('name, email, phone, whatsapp, is_primary, drive_access, language').eq('developer_id', devId).order('is_primary', { ascending: false })
  const cs = (contacts ?? []) as Array<{ name: string | null; email: string | null; phone: string | null; whatsapp: string | null; is_primary: boolean; drive_access: boolean; language: string | null }>
  // Mail an alle mit Haken „Drive-Zugang nach Reservierung", sonst an den Hauptkontakt
  // (gleiche Regel wie die Drive-Freigabe in schedule-message).
  const withDrive = cs.filter(c => c.drive_access && c.email?.trim())
  const devEmails = (withDrive.length ? withDrive : cs.filter(c => c.email?.trim()).slice(0, 1)).map(c => c.email!.trim())
  const waContact = (withDrive.length ? withDrive : cs).find(c => (c.whatsapp || c.phone)?.trim())
  return {
    deal: d, lead: lead as Ctx['lead'], unit: u, subUnits, project: p, developerName: (dev as { name: string }).name,
    template: tpl as TemplateDb, devEmails,
    devPhone: waContact ? { name: waContact.name ?? p.developer, phone: (waContact.whatsapp || waContact.phone)!.trim() } : null,
    devLang: (waContact ?? (withDrive.length ? withDrive : cs)[0])?.language === 'de' ? 'de' : 'en',
    devMailLang: Object.fromEntries(cs.filter(c => c.email?.trim()).map(c => [c.email!.trim(), c.language === 'de' ? 'de' : 'en'])),
  }
}

// ── Ausweise im Ordner prüfen ─────────────────────────────────────────────────
/**
 * Neue Dateien im Kundenordner durch die KI-Prüfung schicken. Läuft 3 Dateien parallel mit
 * Zeitbudget (eine Prüfung dauert 20-40 s, die Function darf nicht ewig laufen) und speichert
 * nach JEDER Datei, damit ein Abbruch keine fertigen Prüfungen verliert. Was nicht mehr ins
 * Budget passt, zählt als pending und kommt im nächsten Lauf dran.
 */
async function scanFolder(sb: Client, row: Pick<AgreementRow, 'id' | 'checked_files' | 'drive_file_id' | 'own_file_ids'>, ctx: Ctx, budgetMs = SCAN_BUDGET_MS): Promise<{ checked: Record<string, CheckedFile>; changed: boolean; pending: number }> {
  const started = Date.now()
  const checked: Record<string, CheckedFile> = { ...(row.checked_files ?? {}) }
  if (!ctx.lead.drive_folder_id) return { checked, changed: false, pending: 0 }
  const token = await saToken()
  const files = (await listTree(token, ctx.lead.drive_folder_id))
    .sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''))
  let changed = false
  const todo: DriveFile[] = []
  for (const f of files) {
    const prev = checked[f.id]
    if (prev && (prev.is_id !== undefined || prev.skipped || (prev.failed ?? 0) >= MAX_ATTEMPTS)) continue
    if (f.id === row.drive_file_id || (row.own_file_ids ?? []).includes(f.id)) {
      checked[f.id] = { name: f.name, at: new Date().toISOString(), created: f.createdTime ?? null, skipped: 'eigene Datei' }
      changed = true; continue
    }
    if (!f.mimeType.startsWith('image/') && f.mimeType !== 'application/pdf') {
      checked[f.id] = { name: f.name, at: new Date().toISOString(), created: f.createdTime ?? null, skipped: f.mimeType }
      changed = true; continue
    }
    todo.push(f)
  }
  // Speichern nacheinander (nie zwei Schreibvorgänge mit unterschiedlichem Stand gleichzeitig)
  let saving: Promise<unknown> = Promise.resolve()
  const persist = () => {
    const snapshot = { ...checked }
    saving = saving.then(async () => {
      const { error } = await sb.from('reservation_agreements').update({ checked_files: snapshot, updated_at: new Date().toISOString() }).eq('id', row.id)
      if (error) console.warn('[reservation-agreement] Zwischenstand:', error.message)
    })
    return saving
  }
  if (changed) await persist()

  let next = 0, pending = 0
  const checkOne = async (f: DriveFile) => {
    const prev = checked[f.id]
    const base = { name: f.name, at: new Date().toISOString(), created: f.createdTime ?? null, mime: f.mimeType }
    try {
      const size = f.size ? Number(f.size) : 0
      const raw = AI_MIME.test(f.mimeType) && size <= (f.mimeType === 'application/pdf' ? MAX_BYTES : MAX_IMAGE_BYTES)
      const src = raw ? await download(token, f) : await thumbnail(token, f)   // HEIC, große Fotos
      // Kein Vorschaubild (Google erzeugt es oft erst nach Minuten): später erneut versuchen
      if (!src) { checked[f.id] = { ...base, failed: (prev?.failed ?? 0) + 1, note: `kein lesbares Bild (${f.mimeType}, ${Math.round(size / 1e6)} MB)` }; return }
      const res: FileCheck | null = await checkFile(src.bytes, src.mime, f.name)
      if (!res) { checked[f.id] = { ...base, failed: (prev?.failed ?? 0) + 1 }; return }
      const isId = res.kind === 'identity_document'
      checked[f.id] = {
        ...base, is_id: isId, kind: res.kind, persons: isId ? res.persons : [], note: res.note,
        ...(res.kind === 'reservation_agreement' ? { signed: res.seller_signed, unit: res.unit_number } : {}),
      }
    } catch (e) {
      console.error('[reservation-agreement] Prüfung', f.name, (e as Error).message)
      checked[f.id] = { ...base, failed: (prev?.failed ?? 0) + 1, note: (e as Error).message.slice(0, 200) }
    }
  }
  const worker = async () => {
    while (next < todo.length) {
      if (Date.now() - started > budgetMs) { pending += todo.length - next; next = todo.length; return }
      const f = todo[next++]
      await checkOne(f)
      changed = true
      await persist()
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_PARALLEL, todo.length) }, worker))
  await saving
  return { checked, changed, pending }
}

function ageYears(dob: string): number | null {
  const t = Date.parse(dob)
  if (!Number.isFinite(t)) return null
  return (Date.now() - t) / (365.25 * 864e5)
}

/** Käufer aus allen erkannten Ausweisen, je Person einmal, in Upload-Reihenfolge. Kinder fallen raus. */
function buyersFrom(checked: Record<string, CheckedFile>): { buyers: Buyer[]; minors: string[]; lastIdAt: string | null } {
  const out: Buyer[] = []
  const minors: string[] = []
  let lastIdAt: string | null = null
  const entries = Object.entries(checked).filter(([, c]) => c.is_id).sort(([, a], [, b]) => (a.created ?? '').localeCompare(b.created ?? ''))
  for (const [fileId, c] of entries) {
    if (c.created && (!lastIdAt || c.created > lastIdAt)) lastIdAt = c.created
    for (const p of c.persons ?? []) {
      const full = `${p.given_names} ${p.surname}`.replace(/\s+/g, ' ').trim()
      if (!full) continue
      const age = ageYears(p.date_of_birth)
      if (age !== null && age < 18) { if (!minors.includes(full)) minors.push(full); continue }
      const num = p.document_number.replace(/\s+/g, '').toUpperCase()
      const dup = out.find(b => (num && b.document_number === num) || (!num && norm(b.full_name) === norm(full)))
      if (dup) { if (!dup.document_number && num) dup.document_number = num; continue }
      // Gleiche Person mit zweitem Dokument (Pass + Personalausweis): Name schon da → den Pass bevorzugen
      const samePerson = out.find(b => norm(b.full_name) === norm(full))
      if (samePerson) {
        const expired = (e: string) => !!e && Date.parse(e) < Date.now()
        const better = (num && !samePerson.document_number)
          || (num && expired(samePerson.expiry_date) && !expired(p.expiry_date))
          || (num && samePerson.document_type !== 'passport' && p.document_type === 'passport')
        if (better) Object.assign(samePerson, { document_number: num, document_type: p.document_type, expiry_date: p.expiry_date, file_id: fileId, file_name: c.name })
        continue
      }
      out.push({ full_name: full, document_number: num, document_type: p.document_type, nationality: p.nationality, date_of_birth: p.date_of_birth, expiry_date: p.expiry_date, file_id: fileId, file_name: c.name })
    }
  }
  return { buyers: out, minors, lastIdAt }
}

function kindOf(type: string | null): PropertyKind {
  const t = (type ?? '').toLowerCase()
  if (t === 'villa') return 'villa'
  if (t === 'townhouse' || t === 'house' || t === 'maisonette') return 'townhouse'
  return 'apartment'
}

function fieldsFor(ctx: Ctx, buyers: Buyer[]): { fields: AgreementFields; problems: string[] } {
  const problems: string[] = []
  const t = ctx.template
  const net = ctx.unit.price_net != null ? Number(ctx.unit.price_net) : null
  if (!net) problems.push('An der Wohnung fehlt der Nettopreis')
  const ps = ctx.project.payment_schedule ?? {}
  const dep = typeof ps.reservation === 'number' ? ps.reservation : null
  if (!dep) problems.push('Im Projekt fehlt die Reservierungsgebühr (Zahlungsplan)')
  const depositText = dep
    ? (ps.reservationVat !== false ? `${eurEn(dep)} + 19% VAT = ${eurEn(Math.round(dep * 119) / 100)}` : eurEn(dep))
    : ''
  const address = t.project_addresses?.[ctx.project.id] || (ctx.project.location ?? '').replace(/Zypern/g, 'Cyprus')
  return {
    fields: {
      date: todayCy(),
      property_name: [t.property_prefix, ctx.project.name].filter(Boolean).join(' ').toUpperCase(),
      address,
      // Doppelapartment: beide Teil-Wohnungen nennen (Sven 15.10.: „A1 ist A1a und A1b")
      unit_number: ctx.subUnits.length ? `${ctx.unit.unit_number} (${ctx.subUnits.join(' + ')})` : ctx.unit.unit_number,
      purchasers: buyers.map(b => b.full_name.toUpperCase()),
      id_numbers: buyers.map(b => b.document_number),
      property_kind: kindOf(ctx.unit.type),
      price_text: net ? `${eurEn(net)} + VAT` : '',
      deposit_text: depositText,
    },
    problems,
  }
}

/** Gründe, warum der Vertrag NICHT automatisch rausgeht (leer = alles gut). */
function gate(ctx: Ctx, buyers: Buyer[], fieldProblems: string[], checked: Record<string, CheckedFile>, minors: string[]): string[] {
  const r = [...fieldProblems]
  if (!buyers.length) r.push('Kein Ausweis im Drive-Ordner erkannt')
  for (const b of buyers) {
    if (!b.document_number) r.push(`Ausweisnummer von ${b.full_name} nicht sicher lesbar`)
    if (b.expiry_date && Date.parse(b.expiry_date) < Date.now()) r.push(`Ausweis von ${b.full_name} ist abgelaufen (${b.expiry_date})`)
  }
  const nameSrc = (ctx.lead.last_name ?? '').trim() || [ctx.lead.first_name, ctx.lead.last_name].filter(Boolean).join(' ')
  const leadTokens = norm(nameSrc).split(' ').filter(x => x.length > 1)
  if (buyers.length && !leadTokens.length) r.push('Beim Kunden ist kein Name hinterlegt, Abgleich mit dem Ausweis nicht möglich')
  else if (buyers.length && !buyers.some(b => leadTokens.some(t => norm(b.full_name).split(' ').includes(t)))) {
    r.push(`Kein Ausweis passt zum Kundennamen ${leadName(ctx.lead)} (erkannt: ${buyers.map(b => b.full_name).join(', ')})`)
  }
  const unread = Object.values(checked).filter(c => (c.failed ?? 0) >= MAX_ATTEMPTS || (c.skipped ?? '').startsWith('nicht lesbar'))
  if (unread.length) r.push(`Datei nicht lesbar, könnte ein Ausweis sein: ${unread.map(c => c.name).join(', ')}`)
  if (minors.length) r.push(`Ausweis eines Kindes erkannt und weggelassen: ${minors.join(', ')}`)
  if (!ctx.template.auto_send) r.push('Vorlage steht auf „erst prüfen"')
  if (!ctx.devEmails.length) r.push(`Beim Bauträger ${ctx.developerName} ist keine E-Mail hinterlegt`)
  return r
}

// ── Versand ───────────────────────────────────────────────────────────────────
export function b64(bytes: Uint8Array): string {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(bin)
}
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function invoke(sb: Client, fn: string, body: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await sb.functions.invoke(fn, { body })
  const d = data as { error?: string; success?: boolean } | null
  return error?.message || d?.error || (d?.success === false ? 'success=false' : null)
}

/**
 * Unterschriebenes PDF per WhatsApp an den Unterzeichner (Sven 15.10.: „alles, was unterschrieben
 * wird, auch direkt als WhatsApp-PDF"). Datei über einen 30 Tage gültigen Storage-Link; über
 * ~2 MB hängt send-whatsapp automatisch den Download-Link an statt der Datei.
 */
export async function whatsappPdf(sb: Client, to: { name: string; phone: string }, text: string, storagePath: string, fileName: string, lang: 'de' | 'en'): Promise<string | null> {
  const { data, error } = await sb.storage.from('unit-documents').createSignedUrl(storagePath, 30 * 86400)
  if (error || !data?.signedUrl) return `PDF-Link: ${error?.message ?? 'fehlt'}`
  return await invoke(sb, 'send-whatsapp', {
    event_type: 'signed_document', override_text: text, auto: true, lang, already_translated: true,
    file_url: data.signedUrl, file_name: fileName.replace(/[^A-Za-z0-9._-]+/g, '_'),
    lead_data: { lead_name: to.name, lead_phone: to.phone },
  })
}

export async function whatsappSven(sb: Client, text: string): Promise<string | null> {
  return await invoke(sb, 'send-whatsapp', {
    event_type: 'reservation_agreement', override_text: text, auto: true, lang: 'de', already_translated: true,
    lead_data: { lead_name: 'Sven', lead_phone: SVEN_PHONE },
  })
}

export function fileNameFor(ctx: Ctx): string {
  return `${ctx.template.title} ${ctx.project.name} ${ctx.unit.unit_number} - ${leadName(ctx.lead)}.pdf`.replace(/[\\/:*?"<>|]+/g, ' ')
}

/** Unterschriebene Fassung aus dem Drive-Ordner an der Wohnung ablegen (Portal: „Verträge"). */
async function fileSigned(sb: Client, row: AgreementRow, ctx: Ctx, fileId: string, c: CheckedFile): Promise<Record<string, unknown>> {
  const token = await saToken()
  const src = await download(token, { id: fileId, name: c.name, mimeType: c.mime ?? 'application/pdf' })
  const ext = src.mime === 'application/pdf' ? 'pdf' : (src.mime.split('/')[1] ?? 'bin').replace('jpeg', 'jpg')
  const path = `unit-documents/${ctx.unit.id}/${Date.now()}-reservation-signed.${ext}`
  const { error: upErr } = await sb.storage.from('unit-documents').upload(path, src.bytes, { contentType: src.mime, upsert: false })
  if (upErr) throw new Error(`Speichern fehlgeschlagen: ${upErr.message}`)
  const { data: ins, error } = await sb.from('crm_unit_documents').insert({
    unit_id: ctx.unit.id, project_id: ctx.project.id,
    name: `Reservation ${ctx.project.name} ${ctx.unit.unit_number}`,
    file_path: path, file_name: c.name, file_size: src.bytes.byteLength, doc_type: 'sonstiges',
    notes: 'Reservierungsvereinbarung, unterschrieben (aus dem Google-Drive-Ordner)',
  }).select('id').single()
  if (error) {
    await sb.storage.from('unit-documents').remove([path])
    throw new Error(`Ablage an der Wohnung fehlgeschlagen: ${error.message}`)
  }
  const docId = (ins as { id: string }).id
  await sb.from('reservation_agreements').update({
    status: 'unterschrieben', signed_file_id: fileId, unit_document_id: docId, sign_token: null, review_reason: null, error: null, updated_at: new Date().toISOString(),
  }).eq('id', row.id)
  await sb.from('activities').insert({
    lead_id: ctx.lead.id, deal_id: ctx.deal.id, type: 'note', direction: 'inbound', auto: true,
    subject: 'Reservierungsvertrag unterschrieben',
    content: `Unterschriebener Reservierungsvertrag ${ctx.project.name} ${ctx.unit.unit_number} liegt im Drive-Ordner („${c.name}") und ist an der Wohnung unter Verträge abgelegt.`,
    completed_at: new Date().toISOString(),
  })
  return { deal: row.deal_id, unterschrieben: c.name }
}

/** Vom Bauträger unterschriebener Reservierungsvertrag für DIESE Wohnung im Ordner? (jüngster) */
function signedAgreementOf(checked: Record<string, CheckedFile>, ctx: Ctx, row: AgreementRow): [string, CheckedFile] | null {
  // Vertrag nennt die Wohnung z. B. „A1", „A1 (A1a + A1b)", „A1a / A1b" oder „Block B, B305".
  // Verglichen wird je Wort (nie als Teilstring: „A10" darf nicht als „A1" zählen).
  const key = (u: string) => u.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const wanted = new Set([ctx.unit.unit_number, ...ctx.subUnits].map(key).filter(Boolean))
  // „A-202" bleibt ein Wort; getrennt wird nur an Leerzeichen, Komma, Schrägstrich, Plus, Klammern
  const matches = (written: string) => [written, ...written.split(/[\s,/+()&;]+/)].map(key).filter(Boolean).some(t => wanted.has(t))
  const own = new Set([row.drive_file_id, row.signed_file_id, ...(row.own_file_ids ?? [])].filter(Boolean))
  // Nur was nach dem Versand kam; ohne Versand: was höchstens 14 Tage vor der Reservierung lag
  const after = row.sent_at ?? new Date(Date.parse(row.created_at) - 14 * 864e5).toISOString()
  const hits = Object.entries(checked)
    .filter(([id, c]) => c.kind === 'reservation_agreement' && c.signed && !own.has(id)
      && (c.created ?? '') > after && !!c.unit && matches(c.unit))
    .sort(([, a], [, b]) => (b.created ?? '').localeCompare(a.created ?? ''))
  return hits[0] ?? null
}

async function sendOut(sb: Client, row: AgreementRow, ctx: Ctx, pdf: Uint8Array, fields: AgreementFields, buyers: Buyer[], test: boolean): Promise<Record<string, unknown>> {
  // Versand-Sperre: Sweep und Knopf im CRM dürfen nie gleichzeitig senden (läuft nach 10 Min ab)
  if (!test) {
    const stale = new Date(Date.now() - 10 * 60_000).toISOString()
    const { data: claim } = await sb.from('reservation_agreements').update({ sending_at: new Date().toISOString() })
      .eq('id', row.id).or(`sending_at.is.null,sending_at.lt.${stale}`).select('id')
    if (!claim?.length) throw new Error('Der Vertrag wird gerade schon gesendet. Bitte in ein paar Minuten nachsehen.')
  }
  try { return await sendOutLocked(sb, row, ctx, pdf, fields, buyers, test) }
  finally { if (!test) await sb.from('reservation_agreements').update({ sending_at: null }).eq('id', row.id) }
}

async function sendOutLocked(sb: Client, row: AgreementRow, ctx: Ctx, pdf: Uint8Array, fields: AgreementFields, buyers: Buyer[], test: boolean): Promise<Record<string, unknown>> {
  const fname = fileNameFor(ctx)
  // Mail-Anhang ohne Leerzeichen: denomailer kürzt Namen mit Leerzeichen sonst auf das erste Wort.
  const attachment = { filename: fname.replace(/\s*-\s*/g, '_').replace(/\s+/g, '_'), content_base64: b64(pdf), content_type: 'application/pdf' }
  const folderLink = ctx.lead.drive_folder_url ?? (ctx.lead.drive_folder_id ? `https://drive.google.com/drive/folders/${ctx.lead.drive_folder_id}` : '')
  const unitLabel = `${ctx.project.name} ${ctx.unit.unit_number}`
  const names = fields.purchasers.join(', ')
  const errors: string[] = []

  // 1. Der unsignierte Entwurf geht NICHT in den Drive-Ordner (Kunde und Anwalt sollen
  //    dort nur die unterschriebene Fassung sehen) und nicht an die Wohnung. Er liegt
  //    nur im Storage, damit das CRM ihn zeigen kann.
  const draftPath = test ? row.pdf_path : await storePdfDraft(sb, row, ctx, pdf)

  // 2. Unterschriftslink (/sign/r/<token>). Der Test bekommt einen eigenen Token und eigene
  //    Daten (test_payload), damit er den echten Vertrag nie überschreibt.
  const tokenCol = test ? 'test_sign_token' : 'sign_token'
  // Erneut senden, nachdem schon unterschrieben wurde: neuer Link, die alte Unterschrift gilt
  // nicht für den neuen Stand (der unterschriebene alte Vertrag bleibt an der Wohnung liegen).
  // Jeder echte Versand bekommt einen NEUEN Link: ein alter, noch offener Link kann so nie
  // einen anderen Stand unterschreiben als den, den der Bauträger gesehen hat.
  const signToken = test ? (row.test_sign_token || newToken()) : newToken()
  const signPatch: Record<string, unknown> = { [tokenCol]: signToken, updated_at: new Date().toISOString() }
  if (test) signPatch.test_payload = { fields, template: ctx.template, lang: ctx.devLang }
  else Object.assign(signPatch, {
    unit_id: ctx.unit.id, template_id: ctx.template.id,
    data: fields, template_snapshot: ctx.template, signer_lang: ctx.devLang,
    seller_signed_at: null, seller_signer_name: null, seller_sign_meta: null, signed_pdf_path: null, signed_file_id: null,
  })
  const { error: tokErr } = await sb.from('reservation_agreements').update(signPatch).eq('id', row.id)
  if (tokErr) throw new Error(`Unterschriftslink: ${tokErr.message}`)
  const signLink = SIGN_BASE + signToken

  // 2. Mail an den Bauträger (englisch, PDF im Anhang). Partner-Kommunikation läuft
  //    bewusst OHNE lead_id, damit sie nicht wie eine Kundenmail in der Akte steht.
  const L = ctx.devLang
  const htmlFor = (lang: 'de' | 'en') => lang === 'de' ? devHtmlDe : devHtmlEn
  const lines = fields.purchasers.map((p, i) => `${esc(p)} &middot; ${esc(fields.id_numbers[i] ?? '')}`).join('<br>')
  const btn = (label: string) => `<p><a href="${signLink}" style="display:inline-block;background:#1a2332;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">${label}</a></p>
<p style="font-size:13px;color:#6b7280">${signLink}</p>`
  const devHtmlDe = `<p>Hallo ${esc(ctx.developerName)}-Team,</p>
<p>anbei der Reservierungsvertrag für <b>${esc(fields.property_name)}, Einheit ${esc(fields.unit_number)}</b>, bereits ausgefüllt mit den Käuferdaten aus ${buyers.length > 1 ? 'den Pässen' : 'dem Pass'}:</p>
<p>${lines}</p>
<p>Kaufpreis: ${esc(fields.price_text)}<br>Anzahlung: ${esc(fields.deposit_text)}</p>
<p><b>Kein Ausdrucken nötig:</b> bitte den Vertrag prüfen und direkt am Handy unterschreiben (Unterschrift mit dem Finger + Name). Ort und Datum werden automatisch eingesetzt:</p>
${btn('Reservierungsvertrag unterschreiben')}
<p>Der unterschriebene Vertrag liegt danach automatisch im gemeinsamen Google-Drive-Ordner, auf den Kunde und Anwalt Zugriff haben. Bitte nicht separat an den Kunden schicken.${folderLink ? ` Passkopien: <a href="${folderLink}">${folderLink}</a>` : ''}</p>
<p>Vielen Dank!<br>Sven &middot; Happy Property</p>`
  const devHtmlEn = `<p>Dear ${esc(ctx.developerName)} team,</p>
<p>please find attached the reservation agreement for <b>${esc(fields.property_name)}, unit ${esc(fields.unit_number)}</b>, already filled in with the buyer details from the passport${buyers.length > 1 ? 's' : ''}:</p>
<p>${lines}</p>
<p>Purchasing price: ${esc(fields.price_text)}<br>Holding deposit: ${esc(fields.deposit_text)}</p>
<p><b>No printing needed:</b> please check the agreement and sign it directly on your phone (finger signature + your name). Place and date are filled in automatically:</p>
${btn('Sign the reservation agreement')}
<p>The signed agreement is then stored automatically in the shared Google Drive folder, where the client and the lawyer have access, so there is no need to send it to the client.${folderLink ? ` Passport copies: <a href="${folderLink}">${folderLink}</a>` : ''}</p>
<p>Thank you very much!<br>Sven &middot; Happy Property</p>`
  const devTargets = test ? [SVEN_MAIL] : ctx.devEmails
  for (const to of devTargets) {
    const ML = test ? L : (ctx.devMailLang[to] ?? L)
    const err = await invoke(sb, 'send-email', {
      to, subject: `${test ? 'TEST · ' : ''}${ML === 'de' ? 'Reservierungsvertrag' : 'Reservation agreement'} - ${names} (${unitLabel})`, html: htmlFor(ML),
      attachment, auto: true, lang: ML, already_translated: true,
    })
    if (err) errors.push(`Mail ${to}: ${err}`)
  }

  // 3. WhatsApp-Hinweis an den Bauträger
  const first = ctx.devPhone?.name.split(' ')[0] ?? ''
  const devWa = L === 'de'
    ? `Hallo ${first}, hier ist Lotte von Happy Property 🐾\n\nDer Reservierungsvertrag für ${fields.property_name}, Einheit ${fields.unit_number} (${names}) ist ausgefüllt.\n\nKein Ausdrucken nötig, einfach hier am Handy prüfen und unterschreiben (Ort und Datum kommen automatisch):\n${signLink}\n\nDie unterschriebene Fassung geht direkt in den Drive-Ordner für Kunde und Anwalt. Danke!`
    : `Hi ${first}, Lotte from Happy Property here 🐾\n\nThe reservation agreement for ${fields.property_name}, unit ${fields.unit_number} (${names}) is filled in.\n\nNo printing needed, you can check and sign it right here on your phone (place and date are filled in automatically):\n${signLink}\n\nThe signed version goes straight to the shared Drive folder for the client and the lawyer. Thank you!`
  if (test || ctx.devPhone) {
    const err = await invoke(sb, 'send-whatsapp', {
      event_type: 'reservation_agreement', override_text: (test ? 'TEST · ' : '') + devWa, auto: true, lang: L, already_translated: true,
      file_url: DEV_WA_IMAGE, file_name: 'reservation.jpg',
      lead_data: test ? { lead_name: 'Sven', lead_phone: SVEN_PHONE } : { lead_name: ctx.devPhone!.name, lead_phone: ctx.devPhone!.phone },
    })
    if (err) errors.push(`WhatsApp: ${err}`)
  }

  // 4. Kopie an Sven
  if (!test) {
    const err = await invoke(sb, 'send-email', {
      to: SVEN_MAIL, subject: `Reservierungsvertrag an ${ctx.developerName}: ${leadName(ctx.lead)} (${unitLabel})`,
      html: `<p>Der Reservierungsvertrag ist automatisch ausgefüllt und an ${esc(ctx.devEmails.join(', '))} gegangen. ${esc(ctx.developerName)} unterschreibt am Handy über den Link; danach liegt der Vertrag automatisch im Drive-Ordner und an der Wohnung unter Verträge.</p>
<p>Unterschriftslink (falls du ihn weiterleiten musst): <a href="${signLink}">${signLink}</a></p>
<p>${fields.purchasers.map((p, i) => `${esc(p)} &middot; ${esc(fields.id_numbers[i] ?? '')}`).join('<br>')}</p>
<p><a href="${CRM_LEAD}${ctx.lead.id}">Kunde im CRM</a></p>`,
      attachment, auto: true, lang: 'de', already_translated: true,
    })
    if (err) errors.push(`Kopie Sven: ${err}`)
  }

  const mailOk = !errors.some(e => e.startsWith('Mail '))
  if (!test) {
    await sb.from('activities').insert({
      lead_id: ctx.lead.id, deal_id: ctx.deal.id, type: 'note', direction: 'outbound', auto: true,
      subject: 'Reservierungsvertrag an Bauträger',
      content: `Reservierungsvertrag ${unitLabel} automatisch ausgefüllt (${fields.purchasers.map((p, i) => `${p} ${fields.id_numbers[i] ?? ''}`).join(', ')}) und an ${ctx.devEmails.join(', ')} geschickt.${errors.length ? ` Probleme: ${errors.join('; ')}` : ''}`,
      completed_at: new Date().toISOString(),
    })
    await sb.from('reservation_agreements').update({
      status: mailOk ? 'gesendet' : 'fehler', sent_at: mailOk ? new Date().toISOString() : null, sent_to: ctx.devEmails,
      buyers, data: fields, pdf_path: draftPath, error: errors.length ? errors.join('; ') : null, review_reason: null, updated_at: new Date().toISOString(),
    }).eq('id', row.id)
    if (!mailOk) {
      await whatsappSven(sb, `⚠️ Reservierungsvertrag ${leadName(ctx.lead)} (${unitLabel}) konnte NICHT an ${ctx.developerName} geschickt werden.\n\n${errors.join('\n')}\n\nIm CRM erneut senden:\n${CRM_LEAD}${ctx.lead.id}`)
    }
  }
  return { ok: mailOk, test, sent_to: devTargets, errors, sign_link: signLink }
}

function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(18))
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

// ── Ein Vertrag: prüfen, bauen, senden ───────────────────────────────────────
/**
 * Gespeicherte Käufer (ggf. von Sven korrigiert) + KI-Funde zusammenführen:
 * - eine neue Aufnahme derselben Person ersetzt eine leere oder abgelaufene Nummer
 * - neue Personen kommen nur dazu, wenn ihre Datei NACH dem letzten Versand kam
 *   (sonst würde eine von Sven gelöschte Person, z. B. der erwachsene Sohn, zurückkehren)
 */
function mergeBuyers(row: AgreementRow, found: Buyer[], checked: Record<string, CheckedFile>): Buyer[] {
  const saved = (row.buyers ?? []).map(b => ({ ...b }))
  if (!saved.length) return found
  const expired = (e: string) => !!e && Date.parse(e) < Date.now()
  for (const f of found) {
    const same = saved.find(k => norm(k.full_name) === norm(f.full_name))
    if (same && f.document_number && !expired(f.expiry_date) && (!same.document_number || expired(same.expiry_date))) {
      Object.assign(same, { document_number: f.document_number, document_type: f.document_type, expiry_date: f.expiry_date, file_id: f.file_id, file_name: f.file_name })
    }
  }
  const since = row.sent_at ?? ''
  const extra = found.filter(f => !knownBuyer(saved, f) && (checked[f.file_id]?.created ?? '') > since)
  return [...saved, ...extra]
}

/** Ist ein KI-erkannter Käufer schon bekannt (gleiche Nummer ODER gleicher Name)? */
function knownBuyer(list: Buyer[], b: Buyer): boolean {
  return list.some(k => (!!b.document_number && k.document_number === b.document_number) || norm(k.full_name) === norm(b.full_name))
}

async function processRow(sb: Client, initial: AgreementRow, m: Mode): Promise<Record<string, unknown>> {
  // Frischer Stand: Sven kann zwischen Sweep-Start und jetzt im CRM gesendet haben
  const { data: fresh } = await sb.from('reservation_agreements').select('*').eq('id', initial.id).maybeSingle()
  const row = fresh as AgreementRow | null
  if (!row || row.status !== initial.status) return { deal: initial.deal_id, skipped: 'Stand geändert' }
  if (row.seller_signed_at) return { deal: row.deal_id, skipped: 'Unterschrift läuft' }
  const ctx = await loadCtx(sb, row.deal_id, row.template_snapshot)
  if ('error' in ctx) {
    await sb.from('reservation_agreements').update({ error: ctx.error, updated_at: new Date().toISOString() }).eq('id', row.id)
    return { deal: row.deal_id, skipped: ctx.error }
  }
  if (DEAD_PHASES.includes(ctx.deal.phase)) {
    await sb.from('reservation_agreements').update({ status: 'abgebrochen', sign_token: null, updated_at: new Date().toISOString() }).eq('id', row.id)
    return { deal: row.deal_id, abgebrochen: ctx.deal.phase }
  }
  if (ctx.unit.id !== row.unit_id) {
    await sb.from('reservation_agreements').update({ status: 'abgebrochen', sign_token: null, error: 'Am Deal hängt inzwischen eine andere Wohnung', updated_at: new Date().toISOString() }).eq('id', row.id)
    return { deal: row.deal_id, abgebrochen: 'andere Wohnung' }
  }
  const scan = await scanFolder(sb, row, ctx)
  const { buyers, minors, lastIdAt } = buyersFrom(scan.checked)
  if (scan.changed) {
    await sb.from('reservation_agreements').update({ last_id_at: lastIdAt, updated_at: new Date().toISOString() }).eq('id', row.id)
  }
  const kunde = `${leadName(ctx.lead)} (${ctx.project.name} ${ctx.unit.unit_number})`

  // Unterschriebene Fassung vom Bauträger im Ordner? → an der Wohnung ablegen, fertig.
  // Greift auch, wenn der Bauträger den Vertrag selbst gemacht hat (status wartet/pruefen).
  const signed = signedAgreementOf(scan.checked, ctx, row)
  if (signed) return await fileSigned(sb, row, ctx, signed[0], signed[1])
  if (row.status === 'pruefen') return { deal: row.deal_id, beobachtet: true }

  // Nach dem Versand: Ausweis aus einer NEUEN Datei (nach dem Versand hochgeladen), der zu
  // keinem Käufer im Vertrag passt? Von Hand korrigierte Nummern lösen so keinen Alarm aus.
  if (row.status === 'gesendet') {
    const sentAt = row.sent_at ?? ''
    const extra = buyers.filter(b => (scan.checked[b.file_id]?.created ?? '') > sentAt && !knownBuyer(row.buyers ?? [], b))
    if (!extra.length) return { deal: row.deal_id, beobachtet: true }
    const reason = `Nach dem Versand kam noch ein Ausweis dazu: ${extra.map(b => b.full_name).join(', ')}. Vertrag neu senden?`
    // Alter Link wird ungültig, damit niemand die veraltete Käuferliste unterschreibt
    await sb.from('reservation_agreements').update({ status: 'pruefen', review_reason: reason, sign_token: null, sven_notified_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', row.id)
    await whatsappSven(sb, `🐾 Reservierungsvertrag ${kunde}\n\n${reason}\n\nDer bisherige Unterschriftslink ist gesperrt. Im CRM beim Kunden prüfen und neu senden:\n${CRM_LEAD}${ctx.lead.id}`)
    return { deal: row.deal_id, nachtrag: extra.length }
  }

  // Automatisch nur in der Phase Reservierung (Deal zurückgeschoben = nichts senden)
  if (!SEND_PHASES.includes(ctx.deal.phase)) return { deal: row.deal_id, wartet: `Phase ${ctx.deal.phase}` }
  const retrying = Object.values(scan.checked).some(c => (c.failed ?? 0) > 0 && (c.failed ?? 0) < MAX_ATTEMPTS)
  if (!buyers.length || scan.pending || retrying) return { deal: row.deal_id, wartet: scan.pending || retrying ? 'weitere Dateien in Prüfung' : 'kein Ausweis' }
  if (lastIdAt && Date.now() - Date.parse(lastIdAt) < QUIET_MIN * 60_000) return { deal: row.deal_id, wartet: 'weitere Ausweise abwarten' }

  // Stand kurz vor dem Bauen noch einmal prüfen (Sven kann inzwischen im CRM gesendet haben);
  // gegen gleichzeitiges Senden schützt die Versand-Sperre in sendOut
  const { data: cur } = await sb.from('reservation_agreements').select('status, sending_at').eq('id', row.id).maybeSingle()
  const c = cur as { status: string; sending_at: string | null } | null
  if (!c || c.status !== row.status || c.sending_at) return { deal: row.deal_id, skipped: 'Stand geändert' }

  const { fields, problems } = fieldsFor(ctx, buyers)
  const reasons = gate(ctx, buyers, problems, scan.checked, minors)
  let pdf: Uint8Array
  try { pdf = await renderAgreement(ctx.template, fields) }
  catch (e) { reasons.push(`PDF: ${(e as Error).message}`); pdf = new Uint8Array() }

  if (reasons.length || m === 'test') {
    const reason = m === 'test' && !reasons.length ? 'Testmodus: Vertrag ist fertig, ging nur an Sven' : reasons.join(' · ')
    const stored = pdf.length ? await storePdfDraft(sb, row, ctx, pdf) : row.pdf_path
    await sb.from('reservation_agreements').update({
      status: 'pruefen', review_reason: reason, buyers, pdf_path: stored, updated_at: new Date().toISOString(),
    }).eq('id', row.id)
    if (m === 'test' && !reasons.length) {
      const res = await sendOut(sb, row, ctx, pdf, fields, buyers, true)
      await sb.from('reservation_agreements').update({ sven_notified_at: new Date().toISOString() }).eq('id', row.id)
      return { deal: row.deal_id, test: res }
    }
    await whatsappSven(sb, `🐾 Reservierungsvertrag ${kunde} ist ausgefüllt, aber noch NICHT an ${ctx.developerName} gegangen.\n\nBitte prüfen: ${reason}\n\nIm CRM beim Kunden kannst du die Daten korrigieren und den Vertrag senden:\n${CRM_LEAD}${ctx.lead.id}`)
    await sb.from('reservation_agreements').update({ sven_notified_at: new Date().toISOString() }).eq('id', row.id)
    return { deal: row.deal_id, pruefen: reason }
  }
  return { deal: row.deal_id, ...(await sendOut(sb, row, ctx, pdf, fields, buyers, false)) }
}

/** Digital unterschrieben, aber der Drive-Upload ging schief: erneut versuchen (bis 7 Tage). */
async function retryDrive(sb: Client, row: AgreementRow): Promise<Record<string, unknown>> {
  const { data: lead } = await sb.from('leads').select('drive_folder_id, first_name, last_name').eq('id', row.lead_id).maybeSingle()
  const folder = (lead as { drive_folder_id?: string | null } | null)?.drive_folder_id
  if (!folder || !row.signed_pdf_path) return { deal: row.deal_id, drive: 'kein Ordner' }
  const { data: file } = await sb.storage.from('unit-documents').download(row.signed_pdf_path)
  if (!file) return { deal: row.deal_id, drive: 'PDF fehlt' }
  const tok = await uploadToken(sb)
  if (!tok) return { deal: row.deal_id, drive: 'Upload nicht verbunden' }
  const name = `${row.template_snapshot?.title ?? 'Reservation agreement'} ${row.data?.property_name ?? ''} ${row.data?.unit_number ?? ''} (signed).pdf`.replace(/[\\/:*?"<>|]+/g, ' ')
  const up = await uploadFile(tok, folder, name, 'application/pdf', new Uint8Array(await file.arrayBuffer()))
  await sb.from('reservation_agreements').update({
    signed_file_id: up.id, own_file_ids: [...(row.own_file_ids ?? []), up.id], error: null, updated_at: new Date().toISOString(),
  }).eq('id', row.id)
  return { deal: row.deal_id, drive: 'nachgeholt' }
}

/** Entwurf ablegen (nur Storage, für die Vorschau im CRM). */
async function storePdfDraft(sb: Client, row: AgreementRow, ctx: Ctx, pdf: Uint8Array): Promise<string | null> {
  const path = `unit-documents/${ctx.unit.id}/${Date.now()}-reservation-draft.pdf`
  const { error } = await sb.storage.from('unit-documents').upload(path, pdf, { contentType: 'application/pdf', upsert: false })
  if (error) { console.warn('[reservation-agreement] Entwurf:', error.message); return row.pdf_path }
  return path
}

// ── Sweep ─────────────────────────────────────────────────────────────────────
async function sweep(sb: Client): Promise<Record<string, unknown>> {
  const m = await mode(sb)
  if (m === 'off') return { ok: true, mode: m }
  // 1. Neue Reservierungen aufnehmen
  const { data: deals } = await sb.from('deals').select('id, lead_id, unit_id, phase_changed_at')
    .eq('phase', 'reservierung').not('unit_id', 'is', null).gte('phase_changed_at', FLOW_START)
  const created: string[] = []
  for (const d of (deals ?? []) as Array<{ id: string; lead_id: string; unit_id: string }>) {
    const { data: ex } = await sb.from('reservation_agreements').select('id').eq('deal_id', d.id).maybeSingle()
    if (ex) continue
    const ctx = await loadCtx(sb, d.id)
    if ('error' in ctx) continue                    // z. B. Bauträger ohne Vorlage → wie bisher, nichts tun
    const { error } = await sb.from('reservation_agreements').insert({ deal_id: d.id, lead_id: d.lead_id, unit_id: d.unit_id, template_id: ctx.template.id })
    if (!error) created.push(d.id)
  }
  // 2. Offene abarbeiten
  const since = new Date(Date.now() - WAIT_DAYS * 864e5).toISOString()
  const watchSince = new Date(Date.now() - WATCH_AFTER_SEND_DAYS * 864e5).toISOString()
  const { data: rows } = await sb.from('reservation_agreements').select('*')
    .or(`and(status.eq.wartet_ausweis,created_at.gte.${since}),and(status.eq.pruefen,created_at.gte.${since}),and(status.eq.gesendet,sent_at.gte.${watchSince})`)
  const results: Array<Record<string, unknown>> = []
  const started = Date.now()
  for (const r of (rows ?? []) as AgreementRow[]) {
    if (Date.now() - started > SWEEP_BUDGET_MS) { results.push({ deal: r.deal_id, verschoben: 'Zeitbudget' }); continue }
    try { results.push(await processRow(sb, r, m)) }
    catch (e) {
      console.error('[reservation-agreement] sweep', r.deal_id, (e as Error).message)
      await sb.from('reservation_agreements').update({ error: (e as Error).message.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', r.id)
      results.push({ deal: r.deal_id, error: (e as Error).message })
    }
  }
  // 3. Digital unterschrieben, Drive-Upload fehlgeschlagen → nachholen
  const { data: pendingDrive } = await sb.from('reservation_agreements').select('*')
    .eq('status', 'unterschrieben').is('signed_file_id', null).not('signed_pdf_path', 'is', null)
    .gte('seller_signed_at', new Date(Date.now() - 7 * 864e5).toISOString())
  for (const r of (pendingDrive ?? []) as AgreementRow[]) {
    try { results.push(await retryDrive(sb, r)) } catch (e) { results.push({ deal: r.deal_id, drive_error: (e as Error).message }) }
  }
  return { ok: true, mode: m, created, results }
}

// ── Manuelle Aktionen (Sven im CRM) ──────────────────────────────────────────
async function rowFor(sb: Client, dealId: string, ctx: Ctx): Promise<AgreementRow> {
  const { data } = await sb.from('reservation_agreements').select('*').eq('deal_id', dealId).maybeSingle()
  const existing = data as AgreementRow | null
  if (existing && existing.unit_id !== ctx.unit.id) {
    // Kunde hat die Wohnung gewechselt: alter Vertrag ist erledigt, neu aufsetzen (Dateiprüfungen bleiben)
    const { data: reset, error } = await sb.from('reservation_agreements').update({
      unit_id: ctx.unit.id, template_id: ctx.template.id, status: 'wartet_ausweis', buyers: [], sign_token: null,
      data: null, template_snapshot: null, review_reason: null, error: null, sent_at: null, sent_to: null,
      seller_signed_at: null, seller_signer_name: null, seller_sign_meta: null, signed_pdf_path: null, signed_file_id: null,
      updated_at: new Date().toISOString(),
    }).eq('id', existing.id).select('*').single()
    if (error) throw new Error(error.message)
    return reset as AgreementRow
  }
  if (existing) return existing
  const { data: ins, error } = await sb.from('reservation_agreements')
    .insert({ deal_id: dealId, lead_id: ctx.lead.id, unit_id: ctx.unit.id, template_id: ctx.template.id })
    .select('*').single()
  if (error) throw new Error(error.message)
  return ins as AgreementRow
}

function cleanBuyers(input: unknown): Buyer[] | null {
  if (!Array.isArray(input)) return null
  return input.map((b: Record<string, unknown>) => ({
    full_name: String(b.full_name ?? '').replace(/\s+/g, ' ').trim(),
    document_number: String(b.document_number ?? '').replace(/\s+/g, '').toUpperCase(),
    document_type: String(b.document_type ?? 'passport'), nationality: String(b.nationality ?? ''),
    date_of_birth: String(b.date_of_birth ?? ''), expiry_date: String(b.expiry_date ?? ''),
    file_id: String(b.file_id ?? ''), file_name: String(b.file_name ?? 'von Hand'),
  })).filter(b => b.full_name)
}

const SAMPLE: AgreementFields = {
  date: todayCy(), property_name: 'MITO MAMBA', address: 'Chloraka, Paphos, 8220, Cyprus', unit_number: 'A1',
  purchasers: ['MAX MUSTERMANN', 'ERIKA MUSTERMANN'], id_numbers: ['C01X00T47', 'C01X00T48'], property_kind: 'apartment',
  price_text: 'EUR 634,800 + VAT', deposit_text: 'EUR 20,000 + 19% VAT = EUR 23,800',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  // Öffentliche Unterschriftsseite: nur mit gültigem Token, kein Login (sign.ts prüft alles)
  if (req.method === 'POST') {
    const peek = await req.clone().json().catch(() => ({})) as Record<string, unknown>
    if (['sign_view', 'sign_submit', 'doc_view', 'doc_submit'].includes(String(peek.action))) {
      const sbPub = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      try {
        const res = peek.action === 'sign_view' ? await signView(sbPub, peek)
          : peek.action === 'sign_submit' ? await signSubmit(sbPub, peek, req)
          : peek.action === 'doc_view' ? await docView(sbPub, peek)
          : await docSubmit(sbPub, peek, req)
        return json(res.body, res.status)
      } catch (e) {
        console.error('[reservation-agreement] sign', (e as Error).message)
        return json({ error: 'Something went wrong. Please try again in a minute.' }, 500)
      }
    }
  }
  const denied = await gateCaller(req, 'reservation-agreement', { service: true, roles: ['admin'] }, CORS)
  if (denied) return denied
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const action = String(body.action ?? '')

    if (action === 'sweep') {
      // pg_net bricht nach 5 s ab → Antwort sofort, Arbeit im Hintergrund.
      const job = sweep(sb).then(r => console.log('[reservation-agreement] sweep', JSON.stringify(r).slice(0, 2000)))
        .catch(e => console.error('[reservation-agreement] sweep', (e as Error).message))
      const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime
      if (rt && !body.wait) { rt.waitUntil(job); return json({ ok: true, started: true }) }
      await job
      return json({ ok: true, done: true })
    }

    if (action === 'preview_template') {
      const t = body.template as TemplateRow | undefined
      if (!t?.company_name) return json({ error: 'Vorlage fehlt' }, 400)
      const pdf = await renderAgreement(t, { ...SAMPLE, ...(body.sample as Partial<AgreementFields> ?? {}) })
      return json({ ok: true, pdf_base64: b64(pdf) })
    }

    if (action === 'check_file') {
      // Diagnose: eine Datei so prüfen, wie es der Sweep tut (nichts wird gespeichert)
      const data = String(body.base64 ?? '')
      if (!data) return json({ error: 'base64 fehlt' }, 400)
      const bin = atob(data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return json({ ok: true, result: await checkFile(bytes, String(body.mime ?? 'application/pdf'), String(body.name ?? 'datei')) })
    }

    // Firmenstempel des Bauträgers (CRM: Vorlage → Firmenstempel)
    if (action === 'seal_get' || action === 'seal_set' || action === 'seal_delete') {
      const devId = String(body.developer_id ?? '')
      if (!/^[0-9a-f-]{36}$/.test(devId)) return json({ error: 'developer_id fehlt' }, 400)
      if (action === 'seal_set') {
        const png = pngFromInput(body.png, MAX_SEAL_BYTES)
        if (!png) return json({ error: 'Ungültiges Stempelbild (PNG bis 1,5 MB)' }, 400)
        await saveSeal(sb, devId, png, 'Sven (CRM)')
      }
      if (action === 'seal_delete') await removeSeal(sb, devId)
      return json({ ok: true, seal: sealDataUrl(await loadSeal(sb, devId)) })
    }

    if (action === 'doc_create') {
      const r = await docCreate(sb, body)
      return json(r.body, r.status)
    }
    if (action === 'doc_list') {
      const leadId = String(body.lead_id ?? '')
      if (!/^[0-9a-f-]{36}$/.test(leadId)) return json({ error: 'lead_id fehlt' }, 400)
      const { data } = await sb.from('sign_documents')
        .select('id, kind, title, deal_id, unit_id, token, test, status, signer_lang, sent_at, sent_to, signed_at, signer_name, signed_pdf_path, error, created_at')
        .eq('lead_id', leadId).order('created_at', { ascending: false }).limit(30)
      return json({ ok: true, docs: data ?? [] })
    }
    if (action === 'doc_cancel') {
      const id = String(body.id ?? '')
      const { data } = await sb.from('sign_documents').update({ status: 'abgebrochen', updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'offen').select('id')
      return json({ ok: !!data?.length })
    }

    const dealId = String(body.deal_id ?? '')
    if (!dealId) return json({ error: 'deal_id fehlt' }, 400)

    if (action === 'status') {
      const { data } = await sb.from('reservation_agreements').select('*').eq('deal_id', dealId).maybeSingle()
      const ctx = await loadCtx(sb, dealId, (data as AgreementRow | null)?.template_snapshot)
      return json({ ok: true, row: data ?? null, template: 'error' in ctx ? null : { id: ctx.template.id, name: ctx.template.name }, reason: 'error' in ctx ? ctx.error : null, mode: await mode(sb) })
    }

    const ctx = await loadCtx(sb, dealId)
    if ('error' in ctx) return json({ error: ctx.error }, 400)

    if (action === 'preview' || action === 'send') {
      const row = await rowFor(sb, dealId, ctx)
      let buyers = cleanBuyers(body.buyers)
      let minors: string[] = []
      let checked = row.checked_files ?? {}
      if (!buyers) {
        const scan = await scanFolder(sb, row, ctx, INTERACTIVE_SCAN_MS)
        checked = scan.checked
        if (scan.pending) return json({ error: `Die KI prüft noch ${scan.pending} Datei(en) im Drive-Ordner. Bitte in einer Minute noch einmal klicken.` }, 409)
        const found = buyersFrom(checked)
        buyers = mergeBuyers(row, found.buyers, checked)
        minors = found.minors
      }
      const { fields, problems } = fieldsFor(ctx, buyers)
      const reasons = gate(ctx, buyers, problems, checked, minors)
      const pdf = await renderAgreement(ctx.template, fields)
      // Vorschau ändert den Vertrag NICHT: row.data ist das, was der Bauträger unterschreibt.
      if (action === 'preview') return json({ ok: true, pdf_base64: b64(pdf), fields, buyers, reasons })
      // send: Sven hat geprüft. Harte Hindernisse bleiben harte Hindernisse.
      const hard = [...problems, ...(buyers.length ? [] : ['Keine Käufer']), ...buyers.filter(b => !b.document_number).map(b => `Nummer fehlt bei ${b.full_name}`), ...(ctx.devEmails.length ? [] : ['Keine E-Mail beim Bauträger'])]
      if (hard.length) return json({ error: hard.join(' · ') }, 400)
      const res = await sendOut(sb, row, ctx, pdf, fields, buyers, body.test === true)
      return json({ ok: true, ...res, reasons })
    }

    return json({ error: 'Unbekannte Aktion' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[reservation-agreement]', msg)
    return json({ error: msg }, 500)
  }
})
