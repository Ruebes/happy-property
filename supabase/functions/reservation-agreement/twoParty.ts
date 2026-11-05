// Reservierung mit zwei Seiten (Sven 5.11.2026, zuerst für die Flora-Panorama-Angebotsapartments,
// Vordruck von Aaron). Anders als bei Mito unterschreibt hier auch der Kunde, und zwar als Zweiter,
// weil die Anzahlung hoch ist:
//
//   1. Der Vertrag wird aus Ausweis und den Angaben des Kunden gefüllt (customerData.ts). Besteht er
//      die Prüfung (floraCheck.ts), geht er von selbst raus, sonst drückt Sven im CRM auf Senden.
//      Nur der Bauträger bekommt seinen Link /sign/r/<token>, die Direktoren unterschreiben einzeln.
//   2. Hat der Bauträger unterschrieben, geht der Link /sign/k/<token> an den Kunden. In der
//      Ruhezeit wartet die Nachricht bis zum Morgen. Vorher zeigt der Kundenlink nichts zum Unterschreiben.
//   3. Mit der Unterschrift des Kunden setzt das System Datum und alle Unterschriften in ein PDF,
//      legt es an der Wohnung und im Drive-Ordner ab und schickt es per Mail und WhatsApp an beide Seiten.
//
// Jede Unterschrift ist eine Zeile in reservation_sign_parts.
// Zustellung: Mails und WhatsApps stehen einzeln in link_delivery / final_delivery. Was nicht
// rausging (z. B. WhatsApp getrennt), holt der Sweep alle 30 Minuten nach, bis zu 48 Stunden, an
// Kunden nie in der Ruhezeit. Ausnahme: die Antwort auf eine eigene Aktion des Kunden.
//
// Testlauf (test_*-Tokens, test_payload, negative Runde): alles geht nur an Sven, nichts wird
// abgelegt und der echte Vertrag bleibt unberührt.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { lotteBild } from '../_shared/lotte.ts'
import { resolveLang } from '../_shared/recipientLang.ts'
import { inRuhezeit, zeitzoneFuer } from '../_shared/ruhezeit.ts'
import { renderAgreement, type AgreementFields } from './pdf.ts'
import { cyprusDate, euro, floraAmounts, type FloraBuyer, type FloraFields, type FloraPart, type VendorSigner } from './pdfFlora.ts'
import { uploadToken, uploadFile } from './drive.ts'
import type { AutoCheck } from './floraCheck.ts'
import { pngFromInput, clientIp, sealDataUrl, MAX_SEAL_BYTES } from './seal.ts'
import { cleanSignature, placeOf, sha256Hex } from './sign.ts'
import {
  b64, esc, invoke, loadCtx, leadName, fileNameFor, markOwnUpload, todayCy, newToken, storePdfDraft,
  SVEN_MAIL, SVEN_PHONE, CRM_LEAD, DEV_WA_IMAGE, type AgreementRow, type Buyer, type Ctx, type TemplateDb,
} from './index.ts'

type Res = { status: number; body: Record<string, unknown> }
type Side = 'buyer' | 'vendor'
type Lang = 'de' | 'en'
export interface PartRow {
  id: string; created_at: string; agreement_id: string; round: number; side: Side; signer_key: string; name: string; png_path: string
  meta: Record<string, unknown>
}
interface Payload { fields: AgreementFields; template: TemplateDb; lang: Lang; buyerLang: Lang; round: number }
interface Hit { row: AgreementRow; side: Side; test: boolean }
interface Slot { at?: string; tries?: number; next?: string; err?: string; gave_up?: boolean }
type Slots = Record<string, Slot>
interface Target { key: string; customer?: string | null; send(): Promise<string | null> }

const BUCKET = 'unit-documents'
const SEAL_BUCKET = 'developer-seals'
const SIGN_BUYER = 'https://portal.happy-property.com/sign/k/'
const SIGN_VENDOR = 'https://portal.happy-property.com/sign/r/'
const RETRY_MIN = 30
const MAX_TRIES = 96                 // 96 x 30 Minuten = 48 Stunden
const DEAD = ['deal_verloren', 'archiviert']
const TOKEN_RE = /^[0-9a-f]{36}$/
const NON_REFUNDABLE = '€15.000,00 plus VAT'
const VAT_PCT = 19                   // Sven 5.11.2026: 40 % Anzahlung plus 19 % MwSt
/** Für den Kunden, damit er den richtigen Betrag überweist. Der Vertrag selbst bleibt bei „plus VAT". */
function depositPay(net: number | null | undefined, lang: Lang): string {
  if (!net) return ''
  const a = floraAmounts(net, 0).a
  const gross = Math.round(a * (100 + VAT_PCT)) / 100
  return lang === 'de' ? `${euro(a)} plus ${VAT_PCT} % MwSt = ${euro(gross)}` : `${euro(a)} plus ${VAT_PCT}% VAT = ${euro(gross)}`
}
export const FEE: Record<number, { type: string; label: string; amount: string }> = {
  0: { type: 'Studio', label: 'studio', amount: '130,00' },
  1: { type: 'One-Bedroom', label: 'one-bedroom', amount: '150,00' },
  2: { type: 'Two-Bedroom', label: 'two-bedroom', amount: '180,00' },
}

// ── Staatsangehörigkeit ──────────────────────────────────────────────────────
// Im Pass steht DEUTSCH, GERMAN oder DEU, im Vertrag „German nationality".
const NATIONS: Array<[string, string[]]> = [
  ['German', ['deutsch', 'deutsche', 'deutscher', 'deu', 'd', 'germany', 'deutschland', 'bundesrepublik deutschland']],
  ['Austrian', ['oesterreichisch', 'osterreichisch', 'aut', 'austria', 'oesterreich', 'osterreich']],
  ['Swiss', ['schweizer', 'schweizerisch', 'che', 'switzerland', 'schweiz', 'suisse']],
  ['Cypriot', ['zyprisch', 'cyp', 'cyprus', 'zypern']], ['Greek', ['griechisch', 'grc', 'greece', 'griechenland', 'hellenic']],
  ['Italian', ['italienisch', 'ita', 'italy', 'italien', 'italiana']], ['French', ['franzoesisch', 'fra', 'france', 'frankreich', 'francaise']],
  ['Dutch', ['niederlaendisch', 'nld', 'netherlands', 'niederlande']], ['Belgian', ['belgisch', 'bel', 'belgium', 'belgien']],
  ['Spanish', ['spanisch', 'esp', 'spain', 'spanien']], ['Portuguese', ['portugiesisch', 'prt', 'portugal']],
  ['British', ['britisch', 'gbr', 'united kingdom', 'uk', 'grossbritannien']], ['Irish', ['irisch', 'irl', 'ireland', 'irland']],
  ['Polish', ['polnisch', 'pol', 'poland', 'polen']], ['Czech', ['tschechisch', 'cze', 'czech republic', 'tschechien']],
  ['Slovak', ['slowakisch', 'svk', 'slovakia', 'slowakei']], ['Hungarian', ['ungarisch', 'hun', 'hungary', 'ungarn']],
  ['Romanian', ['rumaenisch', 'rou', 'romania', 'rumaenien']], ['Bulgarian', ['bulgarisch', 'bgr', 'bulgaria', 'bulgarien']],
  ['Croatian', ['kroatisch', 'hrv', 'croatia', 'kroatien']], ['Serbian', ['serbisch', 'srb', 'serbia', 'serbien']],
  ['Slovenian', ['slowenisch', 'svn', 'slovenia', 'slowenien']], ['Bosnian', ['bosnisch', 'bih', 'bosnia']],
  ['Ukrainian', ['ukrainisch', 'ukr', 'ukraine']], ['Russian', ['russisch', 'rus', 'russia', 'russland']],
  ['Israeli', ['israelisch', 'isr', 'israel']], ['Turkish', ['tuerkisch', 'tur', 'turkey', 'tuerkei']],
  ['American', ['amerikanisch', 'usa', 'united states']], ['Canadian', ['kanadisch', 'can', 'canada', 'kanada']],
  ['Swedish', ['schwedisch', 'swe', 'sweden', 'schweden']], ['Norwegian', ['norwegisch', 'nor', 'norway', 'norwegen']],
  ['Danish', ['daenisch', 'dnk', 'denmark', 'daenemark']], ['Finnish', ['finnisch', 'fin', 'finland', 'finnland']],
  ['Luxembourgish', ['luxemburgisch', 'lux', 'luxembourg', 'luxemburg']], ['Liechtensteiner', ['liechtensteinisch', 'lie', 'liechtenstein']],
  ['Lithuanian', ['litauisch', 'ltu', 'lithuania']], ['Latvian', ['lettisch', 'lva', 'latvia']], ['Estonian', ['estnisch', 'est', 'estonia']],
  ['Maltese', ['maltesisch', 'mlt', 'malta']], ['Albanian', ['albanisch', 'alb', 'albania']],
]
const natKey = (s: string) => s.replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim()
/** Englisches Adjektiv für den Vertrag. Ein unbekanntes Länderkürzel aus dem Pass bleibt leer, Sven trägt es ein. */
export function nationalityEn(raw: string): string {
  const k = natKey(raw)
  if (!k) return ''
  for (const [en, keys] of NATIONS) if (natKey(en) === k || keys.includes(k)) return en
  if (k.length <= 3) return ''
  return k.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// ── Vertragswerte aufbauen ───────────────────────────────────────────────────
const num = (v: number | null | undefined) => v == null ? '' : String(Number(v)).replace('.', ',')

export function floraBuyers(ctx: Ctx, buyers: Buyer[]): FloraBuyer[] {
  return buyers.map((b, i) => ({
    key: `b${i}`,
    salutation: ['MR.', 'MRS.', 'MS.'].includes(b.salutation ?? '') ? b.salutation! : '',
    name: b.full_name.toUpperCase(),
    nationality: nationalityEn(b.nationality ?? ''),
    doc_label: b.document_type === 'id_card' ? 'Identity Card' : 'Passport',
    doc_number: b.document_number,
    address: (b.address ?? '').trim(),
    telephone: (b.phone ?? '').trim() || (i === 0 ? (ctx.lead.whatsapp || ctx.lead.phone || '').trim() : ''),
    email: (b.email ?? '').trim() || (i === 0 ? (ctx.lead.email ?? '').trim() : ''),
  }))
}

const MISSING_FIELDS = ['salutation', 'nationality', 'address', 'telephone', 'email'] as const
type DataField = typeof MISSING_FIELDS[number]
const missingOf = (b: FloraBuyer): DataField[] => MISSING_FIELDS.filter(k => !b[k])
const FIELD_LABEL: Record<DataField, string> = { salutation: 'Anrede', nationality: 'Staatsangehörigkeit', address: 'Adresse', telephone: 'Telefon', email: 'E-Mail' }
// Nur lateinische Schrift: die PDF-Schrift kann nichts anderes
const LATIN = /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{Sc}+]+$/u
/** Happy Property füllt den Vertrag aus: ohne vollständige Angaben geht er nicht raus. */
function buyerProblems(b: FloraBuyer): string[] {
  const out = missingOf(b).map(k => `${FIELD_LABEL[k]} fehlt bei ${b.name}`)
  if (b.address && !LATIN.test(b.address)) out.push(`Adresse von ${b.name} bitte in lateinischer Schrift`)
  if (b.telephone && !/^\+?[\d\s()./-]{7,24}$/.test(b.telephone)) out.push(`Telefon von ${b.name} prüfen`)
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(b.email)) out.push(`E-Mail von ${b.name} prüfen`)
  return out
}

export function floraFieldsFor(ctx: Ctx, buyers: Buyer[], terms: { en: string; problem: string | null }, row?: Pick<AgreementRow, 'contract'> | null): { fields: AgreementFields; problems: string[] } {
  const problems: string[] = terms.problem ? [terms.problem] : []
  const extra = ctx.template.extra ?? {}
  const net = Number(row?.contract?.net_price ?? ctx.unit.price_net ?? 0) || null
  const titleDeed = Number(row?.contract?.title_deed_amount ?? extra.title_deed_amount ?? 0) || null
  if (!net) problems.push('Nettopreis fehlt')
  if (!titleDeed) problems.push('Betrag (g) bei Eintragung der Besitzurkunde fehlt, bitte in der Karte eintragen')
  else if (net && titleDeed >= net * 0.05) problems.push(`Betrag (g) muss kleiner sein als 5 % des Preises (${euro(net * 0.05)})`)
  const fee = FEE[ctx.unit.bedrooms ?? -1]
  if (!fee) problems.push('An der Wohnung fehlt die Zahl der Schlafzimmer (0, 1 oder 2)')
  if (!ctx.unit.size_sqm) problems.push('An der Wohnung fehlt die Wohnfläche')
  if (ctx.unit.terrace_sqm == null) problems.push('An der Wohnung fehlt die überdachte Veranda')
  if (!ctx.lead.email?.trim() && !(ctx.lead.whatsapp || ctx.lead.phone)?.trim()) problems.push('Beim Kunden fehlen E-Mail und Telefon')
  const list = floraBuyers(ctx, buyers)
  for (const b of list) problems.push(...buyerProblems(b))
  const flora: FloraFields = {
    buyers: list,
    unit: ctx.unit.unit_number, type_label: fee?.type ?? '__________', fee_label: fee?.label ?? '__________', fee_amount: fee?.amount ?? '____',
    enclosed: num(ctx.unit.size_sqm), covered: num(ctx.unit.terrace_sqm), net_price: net, title_deed: titleDeed,
  }
  return {
    problems,
    fields: {
      date: todayCy(), property_name: 'FLORA PANORAMA', address: 'Chloraka, Melanos, Paphos', unit_number: ctx.unit.unit_number,
      purchasers: buyers.map(b => b.full_name.toUpperCase()), id_numbers: buyers.map(b => b.document_number), id_types: buyers.map(b => b.document_type),
      property_kind: 'apartment',
      price_text: net ? `${euro(net)} plus VAT` : '', deposit_text: net ? `${euro(floraAmounts(net, 0).a)} plus VAT` : '',
      flora, ...(terms.en ? { special_terms: terms.en } : {}),
    },
  }
}

/** Hinweise beim Vorschauen und Senden, kein Hindernis: Sven entscheidet. */
export function floraWarnings(ctx: Ctx): string[] {
  const b = ctx.template.bank ?? {}
  return b.iban || b.account_number ? [] : ['In der Vorlage fehlen die Bankdaten. Die Anzahlung ist 5 Tage nach Unterschrift fällig, bitte Bankverbindung separat schicken.']
}

export const FLORA_SAMPLE: AgreementFields = {
  date: '', property_name: 'FLORA PANORAMA', address: 'Chloraka, Melanos, Paphos', unit_number: 'B107', purchasers: ['MAX MUSTERMANN'], id_numbers: ['C01X00T47'],
  property_kind: 'apartment', price_text: '€150.000,00 plus VAT', deposit_text: '€60.000,00 plus VAT',
  flora: {
    buyers: [{ key: 'b0', salutation: 'MR.', name: 'MAX MUSTERMANN', nationality: 'German', doc_label: 'Passport', doc_number: 'C01X00T47', address: 'Musterstraße 12, 80331 München, Germany', telephone: '+49 171 1234567', email: 'max@example.com' }],
    unit: 'B107', type_label: 'One-Bedroom', fee_label: 'one-bedroom', fee_amount: '150,00', enclosed: '50', covered: '7', net_price: 150000, title_deed: 5000,
  },
}

// ── Lesen ────────────────────────────────────────────────────────────────────
function payloadOf(hit: Pick<Hit, 'row' | 'test'>): Payload | null {
  const { row, test } = hit
  if (test) {
    const t = row.test_payload
    if (!t?.fields || !t.template) return null
    return { fields: t.fields, template: t.template, lang: t.lang === 'de' ? 'de' : 'en', buyerLang: t.buyer_lang === 'en' ? 'en' : 'de', round: t.round ?? -1 }
  }
  if (!row.data || !row.template_snapshot) return null
  return {
    fields: row.data, template: row.template_snapshot, lang: row.signer_lang === 'de' ? 'de' : 'en', buyerLang: row.buyer_lang === 'en' ? 'en' : 'de',
    round: row.sign_round ?? 0,
  }
}

export async function findBuyerRow(sb: SupabaseClient, token: unknown): Promise<Hit | null> {
  const t = String(token ?? '').trim().toLowerCase()
  if (!TOKEN_RE.test(t)) return null
  const { data: real } = await sb.from('reservation_agreements').select('*').eq('buyer_sign_token', t).maybeSingle()
  if (real) return { row: real as AgreementRow, side: 'buyer', test: false }
  const { data: test } = await sb.from('reservation_agreements').select('*').eq('test_buyer_sign_token', t).maybeSingle()
  return test ? { row: test as AgreementRow, side: 'buyer', test: true } : null
}

/** Link gilt nur, solange der Vertrag läuft: neu gesendet, abgebrochen oder Wohnung gewechselt macht ihn ungültig. */
async function stillValid(sb: SupabaseClient, hit: Hit): Promise<boolean> {
  if (hit.test) return true
  if (!['gesendet', 'unterschrieben'].includes(hit.row.status)) return false
  const { data } = await sb.from('deals').select('phase, unit_id').eq('id', hit.row.deal_id).maybeSingle()
  const d = data as { phase?: string; unit_id?: string | null } | null
  return !!d && !DEAD.includes(d.phase ?? '') && d.unit_id === hit.row.unit_id
}

const signersOf = (p: Payload, side: Side): VendorSigner[] => side === 'buyer'
  ? (p.fields.flora?.buyers ?? []).map(b => ({ key: b.key, name: b.name }))
  : (p.template.extra?.vendor_signers ?? [])
const vendorMin = (p: Payload) => {
  const all = signersOf(p, 'vendor').length
  return Math.min(all, p.template.extra?.vendor_min_signers ?? all)
}
const sideDone = (p: Payload, parts: PartRow[], side: Side) => {
  const signed = parts.filter(x => x.side === side).length
  return side === 'buyer' ? signed >= signersOf(p, 'buyer').length && signed > 0 : signed >= vendorMin(p) && signed > 0
}

export async function loadParts(sb: SupabaseClient, agreementId: string, round: number): Promise<PartRow[]> {
  const { data, error } = await sb.from('reservation_sign_parts').select('*').eq('agreement_id', agreementId).eq('round', round).order('created_at')
  if (error) throw new Error(`Unterschriften lesen: ${error.message}`)
  return (data ?? []) as PartRow[]
}

async function storageBytes(sb: SupabaseClient, bucket: string, path: string): Promise<Uint8Array | null> {
  const { data, error } = await sb.storage.from(bucket).download(path)
  return error || !data ? null : new Uint8Array(await data.arrayBuffer())
}

const utcLabel = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
const lastSignature = (parts: PartRow[]) => new Date(Math.max(...parts.map(x => Date.parse(x.created_at))))

/** Vertrag mit allen bisherigen Unterschriften; Datum nur, wenn beide Seiten fertig sind. */
async function renderRound(sb: SupabaseClient, p: Payload, parts: PartRow[], complete: boolean): Promise<Uint8Array> {
  const flParts: FloraPart[] = []
  for (const x of parts) {
    const png = await storageBytes(sb, BUCKET, x.png_path)
    if (!png) throw new Error(`Unterschrift ${x.name} fehlt im Speicher`)
    flParts.push({ side: x.side, key: x.signer_key, name: x.name, png, signedAtUtc: utcLabel(x.created_at) })
  }
  const sealPath = parts.find(x => x.meta?.seal_path)?.meta.seal_path as string | undefined
  const seal = sealPath ? await storageBytes(sb, BUCKET, sealPath) : null
  return await renderAgreement(p.template, p.fields, undefined, { parts: flParts, seal, date: complete && parts.length ? lastSignature(parts) : null })
}

// Stempel der Vertragspartei (COMPOSITIVA), getrennt vom CRM-Bauträger EMMETRE: andere EMMETRE-
// Dokumente sollen ihn nicht bekommen. Er liegt deshalb an der Vorlage, nicht am Bauträger.
async function loadVendorSeal(sb: SupabaseClient, templateId: string): Promise<Uint8Array | null> {
  const { data } = await sb.from('reservation_templates').select('extra').eq('id', templateId).maybeSingle()
  const path = (data as { extra?: { seal_path?: string } } | null)?.extra?.seal_path
  return path ? await storageBytes(sb, SEAL_BUCKET, path) : null
}
async function saveVendorSeal(sb: SupabaseClient, templateId: string, png: Uint8Array): Promise<void> {
  const path = `template-${templateId}/${Date.now()}.png`
  const { error } = await sb.storage.from(SEAL_BUCKET).upload(path, png, { contentType: 'image/png', upsert: false })
  if (error) throw new Error(`Stempel speichern: ${error.message}`)
  const { data } = await sb.from('reservation_templates').select('extra').eq('id', templateId).maybeSingle()
  const extra = (data as { extra?: Record<string, unknown> } | null)?.extra ?? {}
  await sb.from('reservation_templates').update({ extra: { ...extra, seal_path: path }, updated_at: new Date().toISOString() }).eq('id', templateId)
}

// ── Öffentliche Seite ────────────────────────────────────────────────────────
export async function tpView(sb: SupabaseClient, hit: Hit): Promise<Res> {
  const p = payloadOf(hit)
  if (!p || !p.fields.flora || !await stillValid(sb, hit)) return { status: 404, body: { error: 'not_found' } }
  const { row, side, test } = hit
  const parts = await loadParts(sb, row.id, p.round)
  const complete = sideDone(p, parts, 'buyer') && sideDone(p, parts, 'vendor')
  const fl = p.fields.flora
  const finalPdf = complete && !test && row.signed_pdf_path ? await storageBytes(sb, BUCKET, row.signed_pdf_path) : null
  const pdf = finalPdf ?? await renderRound(sb, p, parts, complete)
  const signed = (key: string, s: Side) => parts.find(x => x.side === s && x.signer_key === key)
  let bank: unknown = null
  if (complete && side === 'buyer') {
    const { data } = await sb.from('reservation_templates').select('bank').eq('id', p.template.id).maybeSingle()
    const b = (data as { bank?: Record<string, string> } | null)?.bank ?? {}
    bank = b.iban || b.account_number ? b : null
  }
  const seal = side === 'vendor' && !complete && p.template.id ? await loadVendorSeal(sb, p.template.id).catch(() => null) : null
  const am = fl.net_price != null ? floraAmounts(fl.net_price, fl.title_deed ?? 0) : null
  return {
    status: 200,
    body: {
      ok: true, two_party: true, side, test, signed: complete,
      lang: side === 'buyer' ? p.buyerLang : p.lang,
      company_name: p.template.company_name, title: p.template.title,
      property_name: 'Flora Panorama', unit_number: fl.unit, type_label: fl.type_label,
      price_text: p.fields.price_text, deposit_text: p.fields.deposit_text, non_refundable_text: NON_REFUNDABLE,
      deposit: am ? euro(am.a) : null, deposit_pay_text: depositPay(fl.net_price, side === 'buyer' ? p.buyerLang : p.lang), special_terms: p.fields.special_terms ?? null,
      // Kundenlink vor der Unterschrift des Bauträgers: noch nichts zu tun
      waiting_vendor: side === 'buyer' && !sideDone(p, parts, 'vendor'),
      signers: signersOf(p, side).map(s => ({ key: s.key, name: s.name, signed: !!signed(s.key, side), signed_at: signed(s.key, side)?.created_at ?? null })),
      min_signers: side === 'vendor' ? vendorMin(p) : signersOf(p, 'buyer').length,
      own_done: sideDone(p, parts, side), other_done: sideDone(p, parts, side === 'buyer' ? 'vendor' : 'buyer'),
      complete, seal: sealDataUrl(seal), place: placeOf(p.template), date: todayCy(), bank,
      pdf_base64: b64(pdf),
    },
  }
}

export async function buyerView(sb: SupabaseClient, body: Record<string, unknown>): Promise<Res> {
  const hit = await findBuyerRow(sb, body.token)
  return hit ? await tpView(sb, hit) : { status: 404, body: { error: 'not_found' } }
}

/** Eine Person unterschreibt. Bauträger fertig: Link an den Kunden. Kunde fertig: Dokument zusammenführen. */
export async function tpSubmit(sb: SupabaseClient, hit: Hit, body: Record<string, unknown>, req: Request): Promise<Res> {
  if (!await stillValid(sb, hit)) return { status: 404, body: { error: 'not_found' } }
  const { row, side, test } = hit
  const p = payloadOf(hit)
  if (!p?.fields.flora) return { status: 404, body: { error: 'not_found' } }
  if (side === 'buyer' && !sideDone(p, await loadParts(sb, row.id, p.round), 'vendor')) return { status: 409, body: { error: 'vendor_first' } }
  const key = String(body.signer_key ?? '')
  const signer = signersOf(p, side).find(s => s.key === key)
  if (!signer) return { status: 400, body: { error: 'invalid_signer' } }
  const png = cleanSignature(body.signature)
  if (!png) return { status: 400, body: { error: 'invalid_signature' } }
  const newSeal = side === 'vendor' && body.seal ? pngFromInput(body.seal, MAX_SEAL_BYTES) : null
  if (side === 'vendor' && body.seal && !newSeal) return { status: 400, body: { error: 'invalid_seal' } }
  const useSeal = side === 'vendor' && body.use_seal === true

  const base = `reservation-sign/${row.id}/${p.round}`
  const stamp = Date.now()
  const pngPath = `${base}/${side}-${key}-${stamp}.png`
  const { error: upErr } = await sb.storage.from(BUCKET).upload(pngPath, png, { contentType: 'image/png', upsert: false })
  if (upErr) throw new Error(`Unterschrift speichern: ${upErr.message}`)
  let sealPath: string | null = null
  if (useSeal) {
    const seal = newSeal ?? (p.template.id ? await loadVendorSeal(sb, p.template.id) : null)
    if (seal) {
      sealPath = `${base}/seal-${key}-${stamp}.png`
      const { error } = await sb.storage.from(BUCKET).upload(sealPath, seal, { contentType: 'image/png', upsert: false })
      if (error) sealPath = null
    }
  }
  const meta = {
    ip: clientIp(req), user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
    place: placeOf(p.template), contract_sha256: await sha256Hex(new TextEncoder().encode(JSON.stringify(p.fields))),
    ...(sealPath ? { seal_path: sealPath } : {}),
  }
  // Genau einmal je Person: die Eindeutigkeit in der DB fängt Doppelklick und zwei offene Tabs ab
  const { error: insErr } = await sb.from('reservation_sign_parts').insert({
    agreement_id: row.id, round: p.round, side, signer_key: key, name: signer.name, png_path: pngPath, meta,
  })
  if (insErr) {
    await sb.storage.from(BUCKET).remove([pngPath, ...(sealPath ? [sealPath] : [])])
    if (insErr.code === '23505') return { status: 409, body: { error: 'already_signed' } }
    throw new Error(`Unterschrift speichern: ${insErr.message}`)
  }
  // Der neue Stempel gilt für die weiteren Verträge dieser Vorlage. Ein Fehler hier kostet keine Unterschrift.
  if (newSeal && !test && p.template.id) await saveVendorSeal(sb, p.template.id, newSeal).catch(e => console.error('[two-party] Stempel', (e as Error).message))

  const parts = await loadParts(sb, row.id, p.round)
  const buyerDone = sideDone(p, parts, 'buyer'), vendorDone = sideDone(p, parts, 'vendor')
  const now = new Date().toISOString()
  if (!test) {
    const who = parts.filter(x => x.side === 'vendor').map(x => x.name).join(' & ')
    await sb.from('reservation_agreements').update({
      ...(buyerDone && !row.buyer_signed_at ? { buyer_signed_at: now } : {}),
      ...(vendorDone && !row.seller_signed_at ? { seller_signed_at: now, seller_signer_name: who } : {}),
      updated_at: now,
    }).eq('id', row.id).eq('sign_round', p.round)
    await sb.from('activities').insert({
      lead_id: row.lead_id, deal_id: row.deal_id, type: 'note', direction: 'inbound', auto: true,
      subject: `Reservierung unterschrieben: ${signer.name}`,
      content: `${signer.name} hat den Reservierungsvertrag ${p.fields.property_name} ${p.fields.unit_number} digital unterschrieben (${side === 'buyer' ? 'Kunde' : p.template.company_name}).`,
      completed_at: now,
    })
  }
  const reload = async () => (await sb.from('reservation_agreements').select('*').eq('id', row.id).single()).data as AgreementRow
  // Bauträger ist durch: jetzt erst bekommt der Kunde seinen Link (automatisch, also nie in der Ruhezeit)
  if (side === 'vendor' && vendorDone && !buyerDone) {
    try {
      const errors = await deliverLinks(sb, await reload(), test, test)
      if (!test && !row.seller_signed_at) {
        await invoke(sb, 'send-email', {
          to: SVEN_MAIL, subject: `Reservierung ${p.fields.unit_number}: Bauträger hat unterschrieben`,
          html: `<p>${esc(p.template.company_name)} hat den Reservierungsvertrag ${esc(p.fields.property_name)} ${esc(p.fields.unit_number)} (${esc(p.fields.purchasers.join(', '))}) unterschrieben. Der Link geht jetzt an den Kunden, in der Ruhezeit ab 8 Uhr.</p>${errors.length ? `<p>Noch nicht zugestellt, wird automatisch wiederholt: ${esc(errors.join('; '))}</p>` : ''}${button(`${CRM_LEAD}${row.lead_id}`, 'Kunde im CRM')}`,
          auto: true, lang: 'de', already_translated: true,
        })
      }
    } catch (e) { console.error('[two-party] Link Kunde', (e as Error).message) }
  }
  if (buyerDone && vendorDone) {
    // Scheitert das Zusammenführen hier, bleibt die Unterschrift gültig und der Sweep holt es nach
    try {
      if (test) await finalizeTest(sb, { row: await reload(), side, test }, p, parts)
      else await finalize(sb, row.id, side === 'buyer')
    } catch (e) {
      console.error('[two-party] Zusammenführen', (e as Error).message)
      if (!test) await sb.from('reservation_agreements').update({ error: `Zusammenführen: ${(e as Error).message}`.slice(0, 500), finalizing_at: null }).eq('id', row.id)
    }
  }
  return await tpView(sb, { row: await reload(), side, test })
}

// ── Zustellung ───────────────────────────────────────────────────────────────
const button = (href: string, label: string) => `<p><a href="${href}" style="display:inline-block;background:#1a2332;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">${esc(label)}</a></p>`
const attach = (name: string, pdf: Uint8Array) => ({ filename: name.replace(/[()]/g, '').replace(/\s*-\s*/g, '_').replace(/\s+/g, '_'), content_base64: b64(pdf), content_type: 'application/pdf' })
const customerPhone = (ctx: Ctx) => (ctx.lead.whatsapp || ctx.lead.phone || '').trim()
const firstName = (ctx: Ctx) => (ctx.lead.first_name ?? '').trim()

async function runTargets(prev: Slots | null, targets: Target[], immediate: boolean): Promise<{ slots: Slots; open: number; errors: string[]; gaveUp: string[] }> {
  const slots: Slots = { ...(prev ?? {}) }
  const now = new Date()
  let open = 0
  const errors: string[] = [], gaveUp: string[] = []
  for (const t of targets) {
    const s = slots[t.key] ?? {}
    if (s.at || s.gave_up) continue
    if (s.next && Date.parse(s.next) > now.getTime()) { open++; continue }
    if (t.customer !== undefined && !immediate && inRuhezeit(now, zeitzoneFuer(t.customer))) { open++; continue }
    let err: string | null
    try { err = await t.send() } catch (e) { err = (e as Error).message }
    const tries = (s.tries ?? 0) + 1
    if (!err) { slots[t.key] = { at: new Date().toISOString(), tries }; continue }
    errors.push(`${t.key}: ${err}`)
    const gave_up = tries >= MAX_TRIES
    slots[t.key] = { tries, err: err.slice(0, 200), next: new Date(now.getTime() + RETRY_MIN * 60_000).toISOString(), ...(gave_up ? { gave_up } : {}) }
    if (gave_up) gaveUp.push(t.key); else open++
  }
  return { slots, open, errors, gaveUp }
}

/** Sperre, damit Sweep und Unterschrift nicht gleichzeitig zustellen (läuft nach 10 Minuten ab). */
async function claimSending(sb: SupabaseClient, id: string): Promise<boolean> {
  const stale = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data } = await sb.from('reservation_agreements').update({ sending_at: new Date().toISOString() }).eq('id', id).or(`sending_at.is.null,sending_at.lt.${stale}`).select('id')
  return !!data?.length
}
const releaseSending = (sb: SupabaseClient, id: string) => sb.from('reservation_agreements').update({ sending_at: null }).eq('id', id)

function linkTargets(sb: SupabaseClient, row: AgreementRow, ctx: Ctx, p: Payload, test: boolean, vendorDone: boolean, buyerDone: boolean, draft: () => Promise<Uint8Array>): Target[] {
  const fl = p.fields.flora!
  const out: Target[] = []
  const prefix = test ? 'TEST · ' : ''
  const buyerToken = test ? row.test_buyer_sign_token : row.buyer_sign_token
  const vendorToken = test ? row.test_sign_token : row.sign_token
  const unit = fl.unit
  const names = fl.buyers.map(b => b.name).join(', ')

  // Erst der Bauträger
  if (vendorToken && !vendorDone) {
    const link = SIGN_VENDOR + vendorToken
    const signers = signersOf(p, 'vendor').map(s => s.name).join(' & ')
    const devMails = test ? [SVEN_MAIL] : ctx.devEmails
    for (const to of devMails) {
      const ML: Lang = test ? p.lang : (ctx.devMailLang[to] ?? p.lang)
      out.push({
        key: `mail:vendor:${to}`,
        send: async () => invoke(sb, 'send-email', {
          to, subject: `${prefix}${ML === 'de' ? 'Reservierungsvertrag' : 'Reservation agreement'} Flora Panorama ${unit} - ${names}`,
          html: ML === 'de'
            ? `<p>Hallo ${esc(ctx.developerName)}-Team,</p><p>anbei der ausgefüllte Reservierungsvertrag für <b>Flora Panorama, Apartment ${esc(unit)}</b> (${esc(names)}). Bitte prüfen und direkt am Handy unterschreiben. Es unterschreiben ${esc(signers)}, das geht auch nacheinander über denselben Link.</p><p>Kaufpreis: ${esc(p.fields.price_text)}<br>Anzahlung: ${esc(p.fields.deposit_text)}</p>${p.fields.special_terms ? `<p><b>Special agreement:</b> ${esc(p.fields.special_terms)}</p>` : ''}${button(link, 'Vertrag unterschreiben')}<p>Danach geht der Vertrag an den Kunden zur Unterschrift. Wenn beide Seiten unterschrieben haben, bekommen beide das fertige PDF per E-Mail und WhatsApp.</p><p>Vielen Dank!<br>Sven &middot; Happy Property</p>`
            : `<p>Dear ${esc(ctx.developerName)} team,</p><p>please find attached the filled-in reservation agreement for <b>Flora Panorama, apartment ${esc(unit)}</b> (${esc(names)}). Please check it and sign it right on your phone. ${esc(signers)} sign, which also works one after the other through the same link.</p><p>Purchase price: ${esc(p.fields.price_text)}<br>Deposit: ${esc(p.fields.deposit_text)}</p>${p.fields.special_terms ? `<p><b>Special agreement:</b> ${esc(p.fields.special_terms)}</p>` : ''}${button(link, 'Sign the agreement')}<p>The agreement then goes to the client for signature. Once both sides have signed, both receive the final PDF by email and WhatsApp.</p><p>Thank you very much!<br>Sven &middot; Happy Property</p>`,
          attachment: attach(fileNameFor(ctx), await draft()), auto: true, lang: ML, already_translated: true,
        }),
      })
    }
    if (test || ctx.devPhone) {
      const contact = ctx.devPhone
      const WL = p.lang
      const hi = contact?.name.split(' ')[0] ?? ''
      out.push({
        key: 'wa:vendor',
        send: () => invoke(sb, 'send-whatsapp', {
          event_type: 'reservation_agreement', auto: true, lang: WL, already_translated: true,
          override_text: prefix + (WL === 'de'
            ? `Hallo ${hi}, hier ist Lotte von Happy Property 🐾\n\nDer Reservierungsvertrag für Flora Panorama, Apartment ${unit} (${names}) ist ausgefüllt. Kein Ausdrucken nötig, ${signers} können hier am Handy prüfen und unterschreiben, auch nacheinander:\n${link}\n\nDanach geht er an den Kunden. Danke!`
            : `Hi ${hi}, Lotte from Happy Property here 🐾\n\nThe reservation agreement for Flora Panorama, apartment ${unit} (${names}) is filled in. No printing needed, ${signers} can check and sign it right here on the phone, also one after the other:\n${link}\n\nIt then goes to the client. Thank you!`),
          ...(contact?.video ? { file_url: contact.video, file_name: 'reservation.mp4' } : { file_url: DEV_WA_IMAGE, file_name: 'reservation.jpg' }),
          lead_data: test ? { lead_name: 'Sven', lead_phone: SVEN_PHONE } : { lead_name: contact!.name, lead_phone: contact!.phone },
        }),
      })
    }
  }

  // Dann der Kunde: sein Link geht erst raus, wenn der Bauträger unterschrieben hat
  if (buyerToken && vendorDone && !buyerDone) {
    const link = SIGN_BUYER + buyerToken
    const L = p.buyerLang
    const first = firstName(ctx)
    const mail = test ? SVEN_MAIL : (ctx.lead.email ?? '').trim()
    if (mail) out.push({
      key: 'mail:buyer', customer: test ? undefined : customerPhone(ctx),
      send: () => invoke(sb, 'send-email', {
        to: mail, subject: `${prefix}${L === 'de' ? `Dein Reservierungsvertrag Flora Panorama ${unit}` : `Your reservation agreement Flora Panorama ${unit}`}`,
        html: L === 'de'
          ? `<p>Hallo ${esc(first)},</p><p>dein Reservierungsvertrag für <b>Flora Panorama, Apartment ${esc(unit)}</b> ist fertig, der Bauträger hat bereits unterschrieben. Du kannst ihn jetzt direkt am Handy prüfen und mit dem Finger unterschreiben, drucken ist nicht nötig.</p><p>Kaufpreis: ${esc(p.fields.price_text)}<br>Anzahlung (40 %): ${esc(depositPay(fl.net_price, 'de'))}, fällig innerhalb von 5 Tagen nach der Unterschrift</p>${button(link, 'Vertrag prüfen und unterschreiben')}<p>Sobald du unterschrieben hast, bekommst du den fertigen Vertrag per E-Mail und WhatsApp.</p><p>Viele Grüße<br>Sven &middot; Happy Property</p>`
          : `<p>Hi ${esc(first)},</p><p>your reservation agreement for <b>Flora Panorama, apartment ${esc(unit)}</b> is ready and the developer has already signed. You can now check it and sign it with your finger right on your phone, no printing needed.</p><p>Purchase price: ${esc(p.fields.price_text)}<br>Deposit (40%): ${esc(depositPay(fl.net_price, 'en'))}, due within 5 days of signing</p>${button(link, 'Check and sign the agreement')}<p>As soon as you have signed, you will receive the final agreement by email and WhatsApp.</p><p>Best regards<br>Sven &middot; Happy Property</p>`,
        auto: true, lang: L, already_translated: true, ...(test ? {} : { lead_id: ctx.lead.id }),
      }),
    })
    const phone = test ? SVEN_PHONE : customerPhone(ctx)
    if (phone) out.push({
      key: 'wa:buyer', customer: test ? undefined : phone,
      send: () => invoke(sb, 'send-whatsapp', {
        event_type: 'reservation_agreement', auto: true, lang: L, already_translated: true,
        override_text: prefix + (L === 'de'
          ? `Hallo ${first} 🐾\n\nhier ist Lotte von Happy Property. Dein Reservierungsvertrag für Flora Panorama, Apartment ${unit} ist fertig, der Bauträger hat bereits unterschrieben. Du kannst ihn jetzt direkt am Handy prüfen und unterschreiben:\n${link}\n\nLiebe Grüße, Lotte`
          : `Hi ${first} 🐾\n\nLotte from Happy Property here. Your reservation agreement for Flora Panorama, apartment ${unit} is ready and the developer has already signed. You can now check and sign it right on your phone:\n${link}\n\nBest, Lotte`),
        persona_image: lotteBild(), ...(test ? {} : { lead_id: ctx.lead.id }),
        lead_data: test ? { lead_name: 'Sven', lead_phone: SVEN_PHONE } : { lead_name: first || 'Kunde', lead_phone: phone },
      }),
    })
  }
  return out
}

/** Offene Links zustellen, Stand speichern. Im Test genau ein Durchlauf ohne Stand. */
export async function deliverLinks(sb: SupabaseClient, row: AgreementRow, test: boolean, immediate: boolean, claimed = false): Promise<string[]> {
  const p = payloadOf({ row, test })
  if (!p) return []
  const ctx = await loadCtx(sb, row.deal_id, p.template)
  if ('error' in ctx) return [ctx.error]
  let pdf: Uint8Array | null = null
  const parts = await loadParts(sb, row.id, p.round)
  const vendorDone = sideDone(p, parts, 'vendor'), buyerDone = sideDone(p, parts, 'buyer')
  const draft = async () => pdf ??= await renderRound(sb, p, [], false)
  const targets = linkTargets(sb, row, ctx, p, test, vendorDone, buyerDone, draft)
  if (test) {
    const r = await runTargets(row.test_payload?.link_delivery ?? null, targets, true)
    await sb.from('reservation_agreements').update({ test_payload: { ...row.test_payload, link_delivery: r.slots } }).eq('id', row.id)
    return r.errors
  }
  if (!claimed && !await claimSending(sb, row.id)) return []
  try {
    const r = await runTargets(row.link_delivery, targets, immediate)
    const allSent = targets.every(t => r.slots[t.key]?.at || r.slots[t.key]?.gave_up)
    await sb.from('reservation_agreements').update({
      // Fertig erst, wenn auch der Kundenlink raus ist; bis dahin schaut der Sweep weiter nach
      link_delivery: { ...r.slots, ...(vendorDone && allSent ? { done: { at: new Date().toISOString() } } : {}) }, updated_at: new Date().toISOString(),
    }).eq('id', row.id)
    if (r.gaveUp.length) await giveUpNotice(sb, row, ctx, r.gaveUp, 'Unterschriftslink')
    return r.errors
  } finally { if (!claimed) await releaseSending(sb, row.id) }
}

async function giveUpNotice(sb: SupabaseClient, row: AgreementRow, ctx: Ctx, keys: string[], what: string) {
  await invoke(sb, 'send-email', {
    to: SVEN_MAIL, subject: `Reservierung ${ctx.unit.unit_number}: Zustellung aufgegeben`,
    html: `<p>${esc(what)} für ${esc(leadName(ctx.lead))} (Flora Panorama ${esc(ctx.unit.unit_number)}) ging nach 48 Stunden nicht raus: ${esc(keys.join(', '))}. Bitte von Hand nachschicken.</p>${button(`${CRM_LEAD}${row.lead_id}`, 'Kunde im CRM')}`,
    auto: true, lang: 'de', already_translated: true,
  }).catch(() => null)
}

/** Sven drückt „Senden": neue Runde, neue Links, zuerst an den Bauträger. Alte Unterschriften gelten für den neuen Stand nicht. */
export async function floraSend(sb: SupabaseClient, row: AgreementRow, ctx: Ctx, pdf: Uint8Array, fields: AgreementFields, buyers: Buyer[], test: boolean, report?: AutoCheck | null): Promise<Record<string, unknown>> {
  const buyerLang: Lang = await resolveLang(sb, { email: ctx.lead.email, phone: customerPhone(ctx), lead_id: ctx.lead.id })
  const now = new Date().toISOString()
  if (test) {
    const round = -Math.floor(Date.now() / 1000)
    await sb.from('reservation_sign_parts').delete().eq('agreement_id', row.id).lt('round', 0)
    const patch = {
      test_sign_token: row.test_sign_token || newToken(), test_buyer_sign_token: row.test_buyer_sign_token || newToken(),
      test_payload: { fields, template: ctx.template, lang: ctx.devLang, buyer_lang: buyerLang, round },
      updated_at: now,
    }
    const { data, error } = await sb.from('reservation_agreements').update(patch).eq('id', row.id).select('*').single()
    if (error) throw new Error(`Test: ${error.message}`)
    const errors = await deliverLinks(sb, data as AgreementRow, true, true, true)
    return { ok: true, test: true, sent_to: [SVEN_MAIL], errors, sign_link: SIGN_VENDOR + patch.test_sign_token }
  }
  const draftPath = await storePdfDraft(sb, row, ctx, pdf)
  const { data, error } = await sb.from('reservation_agreements').update({
    status: 'gesendet', unit_id: ctx.unit.id, template_id: ctx.template.id, data: fields, template_snapshot: ctx.template, buyers,
    sign_round: (row.sign_round ?? 0) + 1, sign_token: newToken(), buyer_sign_token: newToken(),
    signer_lang: ctx.devLang, buyer_lang: buyerLang,
    buyer_signed_at: null, seller_signed_at: null, seller_signer_name: null, seller_sign_meta: null, completed_at: null, finalizing_at: null,
    signed_pdf_path: null, signed_file_id: null, unit_document_id: null, link_delivery: null, final_delivery: null, final_sent_at: null,
    pdf_path: draftPath, sent_at: now, sent_to: ctx.devEmails, review_reason: null, error: null, updated_at: now,
  }).eq('id', row.id).eq('sign_round', row.sign_round ?? 0).select('*').maybeSingle()
  if (error) throw new Error(`Versand vorbereiten: ${error.message}`)
  // Die Runde hat sich inzwischen geändert: jemand anderes hat schon gesendet, also nicht ein zweites Mal
  if (!data) return { ok: false, test: false, sent_to: [], errors: ['Der Vertrag wurde gerade schon gesendet. Bitte neu laden.'], sign_link: null }
  const fresh = data as AgreementRow
  const errors = await deliverLinks(sb, fresh, false, true, true)
  const unitLabel = `Flora Panorama ${ctx.unit.unit_number}`
  await invoke(sb, 'send-email', {
    to: SVEN_MAIL, subject: `Reservierung ${unitLabel}: an ${ctx.developerName} geschickt`,
    html: `<p>Der Reservierungsvertrag ${esc(unitLabel)} (${esc(leadName(ctx.lead))}) ist ${report ? 'automatisch ' : ''}zur Unterschrift an ${esc(ctx.devEmails.join(', '))} gegangen. Der Kunde bekommt seinen Link, sobald der Bauträger unterschrieben hat.</p>${report ? `<p><b>Vor dem Versand geprüft:</b><br>${report.points.map(x => `✓ ${esc(x.text)}`).join('<br>')}</p>` : ''}${errors.length ? `<p>Noch nicht zugestellt, wird automatisch wiederholt: ${esc(errors.join('; '))}</p>` : ''}${button(`${CRM_LEAD}${ctx.lead.id}`, 'Kunde im CRM')}`,
    attachment: attach(fileNameFor(ctx), pdf), auto: true, lang: 'de', already_translated: true,
  })
  await sb.from('activities').insert({
    lead_id: ctx.lead.id, deal_id: ctx.deal.id, type: 'note', direction: 'outbound', auto: true,
    subject: 'Reservierungsvertrag an Bauträger', content: `Reservierungsvertrag ${unitLabel} an ${ctx.devEmails.join(', ')} geschickt (Runde ${fresh.sign_round}). Der Kunde bekommt seinen Link nach der Unterschrift des Bauträgers.${errors.length ? ` Offen: ${errors.join('; ')}` : ''}`,
    completed_at: now,
  })
  return { ok: true, test: false, sent_to: ctx.devEmails, errors, sign_link: SIGN_VENDOR + fresh.sign_token }
}

// ── Zusammenführen ───────────────────────────────────────────────────────────
function depositDue(date: Date): string {
  const d = cyprusDate(new Date(date.getTime() + 5 * 864e5))
  return `${String(d.day).padStart(2, '0')}.${String(d.month).padStart(2, '0')}.${d.year}`
}

function bankHtml(bank: Record<string, string | undefined> | null | undefined, lang: Lang): string {
  const b = bank ?? {}
  if (!b.iban && !b.account_number) return lang === 'de' ? '<p>Die Bankverbindung für die Anzahlung bekommst du separat von uns.</p>' : '<p>You will receive the bank details for the deposit from us separately.</p>'
  const rows = [['Account name', b.account_name], ['Bank', b.bank_name], ['IBAN', b.iban], ['Account number', b.iban ? '' : b.account_number], ['SWIFT', b.swift]].filter(([, v]) => v)
  return `<p>${rows.map(([k, v]) => `${k}: <b>${esc(String(v))}</b>`).join('<br>')}</p>`
}

/** PDF bauen, ablegen, Status setzen, dann an beide Seiten schicken. Wiederholbar (Sweep). */
export async function finalize(sb: SupabaseClient, id: string, customerSignedLast: boolean): Promise<void> {
  const stale = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data: claim } = await sb.from('reservation_agreements').update({ finalizing_at: new Date().toISOString() })
    .eq('id', id).is('completed_at', null).or(`finalizing_at.is.null,finalizing_at.lt.${stale}`).select('*')
  const row = (claim ?? [])[0] as AgreementRow | undefined
  if (!row) return
  const p = payloadOf({ row, test: false })
  if (!p) throw new Error('Vertragsdaten fehlen')
  const ctx = await loadCtx(sb, row.deal_id, p.template)
  if ('error' in ctx) throw new Error(ctx.error)
  const parts = await loadParts(sb, row.id, p.round)
  const pdf = await renderRound(sb, p, parts, true)
  const hash = await sha256Hex(pdf)
  const fname = fileNameFor(ctx).replace(/\.pdf$/, ' (signed).pdf')
  const buyerNames = parts.filter(x => x.side === 'buyer').map(x => x.name).join(' & ')
  const vendorNames = parts.filter(x => x.side === 'vendor').map(x => x.name).join(' & ')
  const dateStr = todayCyOf(lastSignature(parts))

  let path = row.signed_pdf_path
  if (!path) {
    path = `unit-documents/${ctx.unit.id}/${Date.now()}-reservation-signed.pdf`
    const { error } = await sb.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: false })
    if (error) throw new Error(`Speichern: ${error.message}`)
    await sb.from('reservation_agreements').update({ signed_pdf_path: path }).eq('id', row.id)
  }
  let docId = row.unit_document_id
  if (!docId) {
    const { data: doc, error } = await sb.from('crm_unit_documents').insert({
      unit_id: ctx.unit.id, project_id: ctx.project.id, name: `Reservation ${ctx.project.name} ${ctx.unit.unit_number}`,
      file_path: path, file_name: fname, file_size: pdf.byteLength, doc_type: 'sonstiges',
      notes: `Reservierungsvereinbarung, digital unterschrieben von ${buyerNames} und ${vendorNames} (${p.template.company_name}) am ${dateStr}`,
    }).select('id').single()
    if (error) throw new Error(`Ablage an der Wohnung: ${error.message}`)
    docId = (doc as { id: string }).id
    await sb.from('reservation_agreements').update({ unit_document_id: docId }).eq('id', row.id)
  }
  const problems: string[] = []
  let driveId: string | null = row.signed_file_id
  if (!driveId && ctx.lead.drive_folder_id) {
    try {
      const tok = await uploadToken(sb)
      if (!tok) throw new Error('Drive-Upload nicht verbunden')
      const up = await uploadFile(tok, ctx.lead.drive_folder_id, fname, 'application/pdf', pdf)
      driveId = up.id
      await markOwnUpload(sb, ctx.lead.id, ctx.lead.drive_folder_id, up, pdf.byteLength)
    } catch (e) { problems.push(`Drive: ${(e as Error).message}`) }
  } else if (!ctx.lead.drive_folder_id) problems.push('Kunde hat keinen Drive-Ordner')

  const checked = { ...(row.checked_files ?? {}) }
  if (driveId) checked[driveId] = { name: fname, at: new Date().toISOString(), created: new Date().toISOString(), skipped: 'eigene Datei' }
  const now = new Date().toISOString()
  const { data: done, error: doneErr } = await sb.from('reservation_agreements').update({
    status: 'unterschrieben', completed_at: now, finalizing_at: null, signed_file_id: driveId, checked_files: checked,
    own_file_ids: driveId ? [...(row.own_file_ids ?? []), driveId] : (row.own_file_ids ?? []),
    seller_signer_name: vendorNames, seller_sign_meta: { date: dateStr, pdf_sha256: hash, place: placeOf(p.template), parts: parts.map(x => ({ side: x.side, name: x.name, at: x.created_at, ...x.meta })) },
    final_delivery: {}, error: problems.length ? problems.join('; ') : null, review_reason: null, updated_at: now,
  }).eq('id', row.id).select('*').single()
  if (doneErr) throw new Error(doneErr.message)
  await sb.from('activities').insert({
    lead_id: ctx.lead.id, deal_id: ctx.deal.id, type: 'note', direction: 'inbound', auto: true,
    subject: 'Reservierungsvertrag von beiden Seiten unterschrieben',
    content: `Reservierungsvertrag ${ctx.project.name} ${ctx.unit.unit_number} ist von ${buyerNames} und ${vendorNames} (${p.template.company_name}) unterschrieben, Vertragsdatum ${dateStr}. Abgelegt an der Wohnung unter Verträge${driveId ? ' und im Drive-Ordner' : ''}.${problems.length ? ` Probleme: ${problems.join('; ')}` : ''}`,
    completed_at: now,
  })
  await deliverFinal(sb, done as AgreementRow, customerSignedLast)
}

const todayCyOf = (t: Date) => { const d = cyprusDate(t); return `${String(d.day).padStart(2, '0')}/${String(d.month).padStart(2, '0')}/${d.year}` }

/** Alle, die das fertige PDF bekommen. test: dieselben Nachrichten, aber nur an Sven. */
function finalTargets(sb: SupabaseClient, row: AgreementRow, ctx: Ctx, p: Payload, pdf: () => Promise<Uint8Array>, storagePath: string, signedOn: Date, test: boolean, driveFiled: boolean): Target[] {
  const fl = p.fields.flora!
  const out: Target[] = []
  const unit = fl.unit
  const prefix = test ? 'TEST · ' : ''
  const L = p.buyerLang
  const first = firstName(ctx)
  const fname = fileNameFor(ctx).replace(/\.pdf$/, ' (signed).pdf')
  const due = depositDue(signedOn)
  const names = fl.buyers.map(b => b.name).join(', ')
  const waPdf = async (to: { name: string; phone: string }, text: string, lang: Lang, leadId?: string) => {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(storagePath, 30 * 86400)
    if (error || !data?.signedUrl) return `PDF-Link: ${error?.message ?? 'fehlt'}`
    return await invoke(sb, 'send-whatsapp', {
      event_type: 'signed_document', override_text: text, auto: true, lang, already_translated: true,
      file_url: data.signedUrl, file_name: fname.replace(/[^A-Za-z0-9._-]+/g, '_'), ...(leadId ? { lead_id: leadId } : {}),
      lead_data: { lead_name: to.name, lead_phone: to.phone },
    })
  }

  // Kunde und ggf. zweiter Käufer, jede Adresse und Nummer einmal
  const mails = test ? [SVEN_MAIL] : [...new Set([ctx.lead.email, ...fl.buyers.map(b => b.email)].map(x => (x ?? '').trim().toLowerCase()).filter(Boolean))]
  const phoneTail = (s: string) => s.replace(/\D/g, '').slice(-9)
  const phones = test ? [SVEN_PHONE] : [customerPhone(ctx), ...fl.buyers.map(b => b.telephone)].map(x => (x ?? '').trim()).filter(Boolean).filter((x, i, a) => a.findIndex(y => phoneTail(y) === phoneTail(x)) === i)
  const quiet = test ? undefined : (customerPhone(ctx) || phones[0] || '')
  // Ein zweiter Käufer wird mit seinem eigenen Vornamen angesprochen
  const buyerFirst = (b?: FloraBuyer) => { const w = (b?.name ?? '').split(/\s+/)[0] ?? ''; return w ? w.charAt(0) + w.slice(1).toLowerCase() : '' }
  const firstForMail = (to: string) => test || to === (ctx.lead.email ?? '').trim().toLowerCase() ? first : buyerFirst(fl.buyers.find(b => b.email.trim().toLowerCase() === to)) || first
  const firstForPhone = (ph: string) => test || phoneTail(ph) === phoneTail(customerPhone(ctx)) ? first : buyerFirst(fl.buyers.find(b => phoneTail(b.telephone) === phoneTail(ph))) || first
  for (const to of mails) {
    out.push({
      key: `mail:buyer:${to}`, customer: quiet,
      send: async () => invoke(sb, 'send-email', {
        to, subject: `${prefix}${L === 'de' ? `Von beiden Seiten unterschrieben: Reservierungsvertrag Flora Panorama ${unit}` : `Signed by both sides: reservation agreement Flora Panorama ${unit}`}`,
        html: L === 'de'
          ? `<p>Hallo ${esc(firstForMail(to))},</p><p>dein Reservierungsvertrag für <b>Flora Panorama, Apartment ${esc(unit)}</b> ist jetzt von beiden Seiten unterschrieben. Du findest ihn im Anhang${driveFiled ? ' und in deinem Google-Drive-Ordner' : ''}.</p><p><b>Nächster Schritt:</b> die Anzahlung von ${esc(depositPay(fl.net_price, 'de'))} ist bis spätestens ${due} zu überweisen. Geht sie nicht rechtzeitig ein, endet der Vertrag automatisch (Klausel 3.1).</p>${bankHtml(ctx.template.bank, 'de')}<p>Viele Grüße<br>Sven &middot; Happy Property</p>`
          : `<p>Hi ${esc(firstForMail(to))},</p><p>your reservation agreement for <b>Flora Panorama, apartment ${esc(unit)}</b> has now been signed by both sides. You will find it attached${driveFiled ? ' and in your Google Drive folder' : ''}.</p><p><b>Next step:</b> the deposit of ${esc(depositPay(fl.net_price, 'en'))} has to be transferred by ${due} at the latest. If it is not received in time, the agreement ends automatically (clause 3.1).</p>${bankHtml(ctx.template.bank, 'en')}<p>Best regards<br>Sven &middot; Happy Property</p>`,
        attachment: attach(fname, await pdf()), auto: true, lang: L, already_translated: true, ...(test ? {} : { lead_id: ctx.lead.id }),
      }),
    })
  }
  phones.forEach((phone, i) => out.push({
    key: `wa:buyer:${phoneTail(phone)}`, customer: test ? undefined : phone,
    send: () => waPdf({ name: i === 0 ? (test ? 'Sven' : first || 'Kunde') : (firstForPhone(phone) || 'Kunde'), phone }, prefix + (L === 'de'
      ? `Hallo ${firstForPhone(phone)} 🐾\n\nhier ist Lotte von Happy Property. Dein Reservierungsvertrag für Flora Panorama, Apartment ${unit} ist jetzt von beiden Seiten unterschrieben, hier ist das PDF.\n\nDie Anzahlung von ${depositPay(fl.net_price, 'de')} ist bis spätestens ${due} fällig. Details stehen in deiner E-Mail.\n\nLiebe Grüße, Lotte`
      : `Hi ${firstForPhone(phone)} 🐾\n\nLotte from Happy Property here. Your reservation agreement for Flora Panorama, apartment ${unit} has now been signed by both sides, here is the PDF.\n\nThe deposit of ${depositPay(fl.net_price, 'en')} is due by ${due} at the latest. You will find the details in your email.\n\nBest, Lotte`), L, test ? undefined : ctx.lead.id),
  }))

  // Bauträger
  const devMails = test ? [SVEN_MAIL] : ctx.devEmails
  for (const to of devMails) {
    const ML: Lang = test ? p.lang : (ctx.devMailLang[to] ?? p.lang)
    out.push({
      key: `mail:vendor:${to}`,
      send: async () => invoke(sb, 'send-email', {
        to, subject: `${prefix}${ML === 'de' ? 'Von beiden Seiten unterschrieben' : 'Signed by both sides'}: Flora Panorama ${unit} - ${names}`,
        html: ML === 'de'
          ? `<p>Hallo ${esc(ctx.developerName)}-Team,</p><p>der Reservierungsvertrag für <b>Flora Panorama, Apartment ${esc(unit)}</b> (${esc(names)}) ist jetzt von beiden Seiten unterschrieben. Das PDF ist im Anhang. Die Anzahlung von ${esc(p.fields.deposit_text)} ist bis spätestens ${due} fällig.</p><p>Viele Grüße<br>Sven &middot; Happy Property</p>`
          : `<p>Dear ${esc(ctx.developerName)} team,</p><p>the reservation agreement for <b>Flora Panorama, apartment ${esc(unit)}</b> (${esc(names)}) has now been signed by both sides. The PDF is attached. The deposit of ${esc(p.fields.deposit_text)} is due by ${due} at the latest.</p><p>Best regards<br>Sven &middot; Happy Property</p>`,
        attachment: attach(fname, await pdf()), auto: true, lang: ML, already_translated: true,
      }),
    })
  }
  if (test || ctx.devPhone) {
    const c = ctx.devPhone
    out.push({
      key: 'wa:vendor',
      send: () => waPdf(test ? { name: 'Sven', phone: SVEN_PHONE } : { name: c!.name, phone: c!.phone }, prefix + (p.lang === 'de'
        ? `Hallo ${c?.name.split(' ')[0] ?? ''}, hier ist Lotte von Happy Property 🐾\n\nDer Reservierungsvertrag für Flora Panorama, Apartment ${unit} (${names}) ist von beiden Seiten unterschrieben, hier ist das PDF. Die Anzahlung ist bis spätestens ${due} fällig.`
        : `Hi ${c?.name.split(' ')[0] ?? ''}, Lotte from Happy Property here 🐾\n\nThe reservation agreement for Flora Panorama, apartment ${unit} (${names}) has been signed by both sides, here is the PDF. The deposit is due by ${due} at the latest.`), p.lang),
    })
  }
  // Sven
  if (!test) out.push({
    key: 'mail:sven',
    send: async () => invoke(sb, 'send-email', {
      to: SVEN_MAIL, subject: `Reservierung fertig: ${leadName(ctx.lead)} (Flora Panorama ${unit})`,
      html: `<p>Der Reservierungsvertrag ist von beiden Seiten unterschrieben und an Kunde und Bauträger gegangen. Abgelegt an der Wohnung unter Verträge${driveFiled ? ' und im Drive-Ordner' : ''}. Vertragsdatum ${todayCyOf(signedOn)}, Anzahlung fällig bis ${due}.</p><p>Noch von Hand: Verkaufsliste Flora.</p>${button(`${CRM_LEAD}${ctx.lead.id}`, 'Kunde im CRM')}`,
      attachment: attach(fname, await pdf()), auto: true, lang: 'de', already_translated: true,
    }),
  })
  return out
}

export async function deliverFinal(sb: SupabaseClient, row: AgreementRow, customerSignedLast: boolean): Promise<string[]> {
  const p = payloadOf({ row, test: false })
  if (!p || !row.signed_pdf_path) return []
  const ctx = await loadCtx(sb, row.deal_id, p.template)
  if ('error' in ctx) return [ctx.error]
  if (!await claimSending(sb, row.id)) return []
  try {
    const parts = await loadParts(sb, row.id, p.round)
    let bytes: Uint8Array | null = null
    const pdf = async () => {
      if (bytes) return bytes
      bytes = await storageBytes(sb, BUCKET, row.signed_pdf_path!)
      if (!bytes) throw new Error('PDF fehlt im Speicher')
      return bytes
    }
    const targets = finalTargets(sb, row, ctx, p, pdf, row.signed_pdf_path, lastSignature(parts), false, !!row.signed_file_id)
    const r = await runTargets(row.final_delivery, targets, customerSignedLast)
    const finished = targets.every(t => r.slots[t.key]?.at || r.slots[t.key]?.gave_up)
    await sb.from('reservation_agreements').update({ final_delivery: r.slots, ...(finished ? { final_sent_at: new Date().toISOString() } : {}), updated_at: new Date().toISOString() }).eq('id', row.id)
    if (r.gaveUp.length) await giveUpNotice(sb, row, ctx, r.gaveUp, 'Der fertige Vertrag')
    return r.errors
  } finally { await releaseSending(sb, row.id) }
}

/** Testlauf: dieselben Nachrichten an Sven, nichts wird abgelegt. */
async function finalizeTest(sb: SupabaseClient, hit: Hit, p: Payload, parts: PartRow[]): Promise<void> {
  const { row } = hit
  if (row.test_payload?.final_sent) return
  const ctx = await loadCtx(sb, row.deal_id, p.template)
  if ('error' in ctx) throw new Error(ctx.error)
  const bytes = await renderRound(sb, p, parts, true)
  const path = `reservation-sign/${row.id}/${p.round}/test-final-${Date.now()}.pdf`
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: false })
  if (error) throw new Error(error.message)
  const targets = finalTargets(sb, row, ctx, p, async () => bytes, path, lastSignature(parts), true, false)
  const r = await runTargets(null, targets, true)
  await sb.from('reservation_agreements').update({ test_payload: { ...row.test_payload, final_sent: true, final_delivery: r.slots } }).eq('id', row.id)
}

// ── Sweep ────────────────────────────────────────────────────────────────────
export async function twoPartySweep(sb: SupabaseClient): Promise<Array<Record<string, unknown>>> {
  const since = new Date(Date.now() - 30 * 864e5).toISOString()
  const { data, error } = await sb.from('reservation_agreements').select('*')
    .eq('template_snapshot->>layout', 'flora').in('status', ['gesendet', 'unterschrieben']).is('final_sent_at', null).gte('sent_at', since).limit(50)
  if (error) return [{ two_party_error: error.message }]
  const out: Array<Record<string, unknown>> = []
  for (const row of (data ?? []) as AgreementRow[]) {
    try {
      if (row.completed_at) { out.push({ deal: row.deal_id, final: await deliverFinal(sb, row, false) }); continue }
      if (row.buyer_signed_at && row.seller_signed_at) { await finalize(sb, row.id, false); out.push({ deal: row.deal_id, zusammengefuehrt: true }); continue }
      if (row.link_delivery && 'done' in row.link_delivery) continue
      out.push({ deal: row.deal_id, links: await deliverLinks(sb, row, false, false) })
    } catch (e) {
      console.error('[two-party] sweep', row.deal_id, (e as Error).message)
      await sb.from('reservation_agreements').update({ error: (e as Error).message.slice(0, 500), finalizing_at: null, updated_at: new Date().toISOString() }).eq('id', row.id)
      out.push({ deal: row.deal_id, error: (e as Error).message })
    }
  }
  return out
}

export const isFlora = (t: { layout?: string | null } | null | undefined) => t?.layout === 'flora'
