// Prüfung, bevor ein Flora-Vertrag ohne Sven zum Bauträger geht (Sven 5.11.2026: „Wenn du sicher bist,
// dass alles richtig ist, kann die Reservierung direkt weiter"). Sicher heißt hier: jeder Wert ist
// aus einer zweiten Quelle bestätigt. Fällt ein Punkt durch, geht der Vertrag nicht raus, sondern
// bleibt mit dem Grund auf „Bitte prüfen" stehen. Zweifel zählen immer als durchgefallen.
//
//   Ausweis   zweite Lesung ohne Kenntnis der ersten, Prüfziffern der maschinenlesbaren Zone
//   Adresse   Formularregeln, Kunde im CRM gegen die Eingabe, Vertrag gegen die Eingabe
//   Preis     Wohnung im CRM, Sonderpreise aus dem Deck des Kunden, Rechnung der Teilbeträge
//   PDF       der fertige Vertrag wird zurückgelesen: steht drin, was drinstehen soll?
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { getDocumentProxy } from 'npm:unpdf@0.12.1'
import { rereadId, type IdReread } from './ausweis.ts'
import { addressLine, countryDe, furtherBuyers, personErrors, sameName, type CustomerData, type CustomerPerson } from './customerData.ts'
import { saToken, listTree, download, thumbnail, type DriveFile } from './drive.ts'
import { parseMrz, type Mrz } from './mrz.ts'
import { euro, floraAmounts, type FloraFields } from './pdfFlora.ts'
import type { AgreementFields } from './pdf.ts'
import { norm, type AgreementRow, type Buyer, type Ctx } from './index.ts'
import { nationalityEn } from './twoParty.ts'
import { fetchAppendix } from './appendix.ts'

export interface CheckPoint { key: string; ok: boolean; text: string }
export interface AutoCheck { at: string; ok: boolean; points: CheckPoint[]; reasons: string[]; retry?: boolean; tries?: number }
type Checked = Record<string, { name: string; mime?: string; is_id?: boolean }>
export interface IdRead extends IdReread { file: string; mrz: Mrz | null }

const AI_MIME = /^(application\/pdf|image\/(jpeg|png|webp|gif))$/
const MAX_BYTES = 15 * 1024 * 1024
const MAX_IMAGE_BYTES = 3_700_000
const MAX_FILES = 6
const PARALLEL = 3
const DEAD = ['deal_verloren', 'archiviert']

// ── Rein rechnerisch, ohne Netz ──────────────────────────────────────────────
const tokens = (s: string) => norm(s).split(' ').filter(Boolean)
const sameTokens = (a: string, b: string) => {
  const x = new Set(tokens(a)), y = new Set(tokens(b))
  return x.size > 0 && x.size === y.size && [...x].every(t => y.has(t))
}

/** Gehört diese Lesung zu diesem Käufer? */
function readBelongsTo(r: IdRead, b: Buyer): boolean {
  const num = b.document_number
  if (num && (r.visual_document_number === num || r.mrz?.number === num)) return true
  const have = new Set(tokens(b.full_name))
  const sur = tokens(r.surname || r.mrz?.surname || '')
  return sur.length > 0 && sur.every(t => have.has(t)) && (tokens(r.given_names || r.mrz?.given || '')[0] ? have.has(tokens(r.given_names || r.mrz?.given || '')[0]) : false)
}

/** Vergleicht einen Käufer mit den Zweitlesungen. Leer = alles zweifach bestätigt. */
export function compareBuyer(b: Buyer, contractNationality: string, reads: IdRead[], now = new Date()): string[] {
  const out: string[] = []
  const who = b.full_name
  const mine = reads.filter(r => readBelongsTo(r, b))
  if (!mine.length) return [`${who}: zweite Lesung findet keinen passenden Ausweis`]
  const visual = [...new Set(mine.map(r => r.visual_document_number).filter(Boolean))]
  if (visual.some(n => n !== b.document_number)) out.push(`${who}: Ausweisnummer im Vertrag ${b.document_number}, zweite Lesung ${visual.join(' / ')}`)
  const mrz = mine.map(r => r.mrz).filter((m): m is Mrz => !!m)
  if (!mrz.length) out.push(`${who}: keine maschinenlesbare Zone lesbar, Nummer lässt sich nicht absichern (beim Personalausweis fehlt oft die Rückseite)`)
  for (const m of mrz) {
    if (!m.numberOk) out.push(`${who}: Prüfziffer der Ausweisnummer stimmt nicht (gelesen ${m.number})`)
    else if (m.number !== b.document_number) out.push(`${who}: Ausweisnummer im Vertrag ${b.document_number}, maschinenlesbare Zone ${m.number}`)
    if (m.expiryOk && m.expiry && Date.parse(m.expiry) < now.getTime()) out.push(`${who}: Ausweis ist abgelaufen (${m.expiry})`)
    if (m.dobOk && m.dob && b.date_of_birth && m.dob !== b.date_of_birth) out.push(`${who}: Geburtsdatum weicht ab (${b.date_of_birth} und ${m.dob})`)
    if (m.dobOk && m.dob && (now.getTime() - Date.parse(m.dob)) / (365.25 * 864e5) < 18) out.push(`${who}: laut Ausweis nicht volljährig`)
    const nat = nationalityEn(m.nationality)
    if (nat && contractNationality && nat !== contractNationality) out.push(`${who}: Staatsangehörigkeit im Vertrag ${contractNationality}, Ausweis ${nat}`)
  }
  const named = mine.find(r => r.surname || r.given_names)
  if (!named) out.push(`${who}: Name auf dem Ausweis nicht lesbar`)
  else if (!sameTokens(`${named.given_names} ${named.surname}`, who)) out.push(`${who}: Name im Vertrag weicht vom Ausweis ab (${named.given_names} ${named.surname})`)
  return [...new Set(out)]
}

/** Summen und Regeln des Zahlungsplans. */
export function amountProblems(net: number, titleDeed: number): string[] {
  const out: string[] = []
  const am = floraAmounts(net, titleDeed)
  const cents = (n: number) => Math.round(n * 100)
  if (cents(am.a) + cents(am.b) + cents(am.c) + cents(am.d) + cents(am.e) + cents(am.f) + cents(am.g) !== cents(net)) out.push('Die Teilbeträge ergeben nicht den Preis')
  if (cents(am.a) !== Math.round(cents(net) * 0.4)) out.push('Die Anzahlung ist nicht 40 %')
  if (am.f <= 0) out.push('Betrag (f) wäre null oder negativ, Betrag (g) ist zu hoch')
  return out
}

const pdfKey = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, '')

/** Text des fertigen PDFs, ohne Leerzeichen, damit Zeilenumbrüche keine Rolle spielen. */
export async function pdfTextKey(pdf: Uint8Array): Promise<string> {
  // pdf.js übernimmt den Puffer, das PDF wird danach noch verschickt: deshalb eine Kopie
  const proxy = await getDocumentProxy(pdf.slice())
  let all = ''
  for (let i = 1; i <= proxy.numPages; i++) {
    const page = await proxy.getPage(i) as { getTextContent(): Promise<{ items: Array<{ str?: string }> }> }
    const tc = await page.getTextContent()
    all += tc.items.map(x => x.str ?? '').join('')
  }
  return pdfKey(all)
}

/** Was im fertigen Vertrag stehen muss. */
export function missingInPdf(key: string, fl: FloraFields): string[] {
  const out: string[] = []
  const must = (label: string, value: string | null | undefined) => { if (value && !key.includes(pdfKey(value))) out.push(`${label} (${value})`) }
  for (const b of fl.buyers) {
    must('Name', b.name); must('Ausweisnummer', b.doc_number); must('Staatsangehörigkeit', b.nationality)
    must('Adresse', b.address); must('Telefon', b.telephone); must('E-Mail', b.email)
  }
  must('Wohnung', fl.unit); must('Wohnungstyp', fl.type_label)
  if (fl.net_price != null && fl.title_deed != null) {
    const am = floraAmounts(fl.net_price, fl.title_deed)
    must('Preis', euro(fl.net_price))
    for (const [k, v] of [['Anzahlung (a)', am.a], ['(b)', am.b], ['(c)', am.c], ['(d)', am.d], ['(e)', am.e], ['(f)', am.f], ['(g)', am.g]] as const) must(`Betrag ${k}`, euro(v))
  }
  return out
}

const parseEuro = (s: string) => { const n = Number(s.replace(/[^\d]/g, '')); return Number.isFinite(n) && n > 0 ? n : null }
interface DeckBlock { type?: string; number?: string; sold?: boolean; priceMain?: string; priceLines?: Array<{ label?: string; value?: string; strike?: boolean }> }
/** Nettopreis, den der Kunde im Deck für diese Wohnung gesehen hat (jüngstes Deck zuerst). */
export function deckNetPrice(decks: Array<{ content?: { blocks?: DeckBlock[] } | null }>, unit: string): number | null {
  const want = unit.toUpperCase()
  for (const d of decks) {
    for (const b of d.content?.blocks ?? []) {
      if (b.type !== 'unit' || b.sold) continue
      if (!(b.number ?? '').toUpperCase().split(/[^A-Z0-9]+/).includes(want)) continue
      const line = (b.priceLines ?? []).find(l => !l.strike && /netto/i.test(l.label ?? '') && !/m[öo]bel/i.test(l.label ?? '') && !/zzgl/i.test(l.label ?? ''))
      const price = parseEuro(line?.value ?? b.priceMain ?? '')
      if (price) return price
    }
  }
  return null
}

// ── Zweite Lesung über Drive und KI ──────────────────────────────────────────
/** null = eine Datei ließ sich gerade nicht lesen, also nichts entscheiden und später erneut versuchen. */
async function readIdFiles(ctx: Ctx, checked: Checked): Promise<IdRead[] | null> {
  if (!ctx.lead.drive_folder_id) return []
  const ids = Object.entries(checked).filter(([, c]) => c.is_id).map(([id]) => id).slice(0, MAX_FILES)
  const token = await saToken()
  const files = (await listTree(token, ctx.lead.drive_folder_id)).filter(f => ids.includes(f.id))
  const out: IdRead[] = []
  let failed = false, next = 0
  const one = async (f: DriveFile) => {
    const size = f.size ? Number(f.size) : 0
    const raw = AI_MIME.test(f.mimeType) && size <= (f.mimeType === 'application/pdf' ? MAX_BYTES : MAX_IMAGE_BYTES)
    const src = raw ? await download(token, f) : await thumbnail(token, f)
    if (!src) { failed = true; return }
    const reads = await rereadId(src.bytes, src.mime, f.name)
    if (!reads) { failed = true; return }
    for (const r of reads) out.push({ ...r, visual_document_number: r.visual_document_number.replace(/\s+/g, '').toUpperCase(), file: f.name, mrz: r.mrz_lines?.length ? parseMrz(r.mrz_lines) : null })
  }
  const worker = async () => { while (next < files.length) await one(files[next++]).catch(e => { console.error('[flora-check] Lesung', (e as Error).message); failed = true }) }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker))
  return failed ? null : out
}
// Austauschbar für den Probelauf ohne echte Ausweise
export const checkDeps = { readIdFiles }

// ── Gesamtprüfung ────────────────────────────────────────────────────────────
export async function floraAutoCheck(sb: SupabaseClient, row: AgreementRow, ctx: Ctx, fields: AgreementFields, buyers: Buyer[], pdf: Uint8Array, checked: Checked): Promise<AutoCheck> {
  const points: CheckPoint[] = []
  const add = (key: string, problems: string[], okText: string) => { points.push({ key, ok: !problems.length, text: problems.length ? problems.join(' · ') : okText }) }
  const fl = fields.flora!
  const d = row.customer_data as CustomerData | null
  const x = ctx.template.extra ?? {}
  const contractNet = Number(row.contract?.net_price ?? 0) || null
  const listNet = Number(ctx.unit.price_net ?? 0) || null
  const net = fl.net_price ?? 0
  const handPrice = !!contractNet && contractNet !== listNet

  // Vorlage und Zahlungsdaten: ohne Bankverbindung liefe die 5-Tage-Frist des Kunden ins Leere
  const bank = ctx.template.bank ?? {}
  add('vorlage', [
    ...(bank.iban || bank.account_number ? [] : ['In der Vorlage fehlen die Bankdaten, der Kunde wüsste nicht, wohin er die Anzahlung überweist']),
    ...(x.vendor_signers?.length ? [] : ['In der Vorlage fehlen die Unterzeichner des Bauträgers']),
  ], 'Vorlage vollständig, Bankdaten vorhanden')

  // Appendix: gehört zur Wohnung dieses Vertrags und liegt im Drive-Ordner
  const apx = await fetchAppendix(ctx)
  add('appendix', apx.problems, apx.configured ? `Appendix für ${ctx.unit.unit_number} gefunden: ${apx.files.join(', ')} (${apx.pages} Seiten)` : 'Kein Appendix-Ordner in der Vorlage hinterlegt')

  // Preis: Sonderpreise stehen nicht an der Wohnung, sondern im Deck des Kunden
  const pricing: string[] = []
  if ((x.manual_units ?? []).includes(ctx.unit.unit_number) && !handPrice) pricing.push(`${ctx.unit.unit_number} hat kundenbezogene Preise, bitte den Preis in der Karte eintragen`)
  const { data: decks } = await sb.from('sales_decks').select('content').eq('lead_id', ctx.lead.id).order('created_at', { ascending: false }).limit(10)
  const deckNet = deckNetPrice((decks ?? []) as Array<{ content?: { blocks?: DeckBlock[] } | null }>, ctx.unit.unit_number)
  if (deckNet && deckNet !== net) pricing.push(`Im Deck des Kunden steht für ${ctx.unit.unit_number} ${euro(deckNet)}, im Vertrag ${euro(net)}`)
  if (!handPrice && listNet !== net) pricing.push(`Preis im Vertrag ${euro(net)}, an der Wohnung ${listNet ? euro(listNet) : 'keiner'}`)
  add('preis', pricing, `Preis ${euro(net)} passt zu Wohnung${deckNet ? ' und Kunden-Deck' : ''}`)
  add('betraege', amountProblems(net, fl.title_deed ?? 0), 'Teilbeträge ergeben den Preis, Anzahlung 40 %')

  // Wohnung: niemand sonst darf dranhängen
  const unitProblems: string[] = []
  const { data: unitNow } = await sb.from('crm_project_units').select('status').eq('id', ctx.unit.id).maybeSingle()
  if ((unitNow as { status?: string } | null)?.status === 'sold') unitProblems.push(`${ctx.unit.unit_number} steht im CRM auf verkauft`)
  const { data: others } = await sb.from('deals').select('id, phase').eq('unit_id', ctx.unit.id).neq('id', ctx.deal.id).limit(10)
  const live = ((others ?? []) as Array<{ phase: string }>).filter(o => !DEAD.includes(o.phase))
  if (live.length) unitProblems.push(`An ${ctx.unit.unit_number} hängt noch ein anderer Kunde (${live.map(o => o.phase).join(', ')})`)
  add('wohnung', unitProblems, `${ctx.unit.unit_number} ist frei für diesen Kunden`)

  // Sondervereinbarung: frei formuliert und von der KI übersetzt, das soll ein Mensch sehen
  add('sonder', fields.special_terms ? ['Im Vertrag steht eine Sondervereinbarung, bitte die Übersetzung ansehen'] : [], 'Keine Sondervereinbarung')

  // Wer kauft: jeder Ausweis muss zum Kunden oder zum angegebenen zweiten Käufer gehören
  const people: string[] = []
  const isLead = (b: Buyer) => sameName(b.full_name, ctx.lead.first_name, ctx.lead.last_name)
  const further = furtherBuyers(d)
  const isSecond = (b: Buyer) => further.some(p => sameName(b.full_name, p.first_name, p.last_name))
  if (!buyers.some(isLead)) people.push(`Kein Ausweis lautet auf den Kunden ${ctx.lead.first_name ?? ''} ${ctx.lead.last_name ?? ''}`.trim())
  for (const b of buyers) if (!isLead(b) && !isSecond(b)) people.push(`Ausweis von ${b.full_name} passt zu keinem angegebenen Käufer`)
  add('kaeufer', people, buyers.length > 1 ? 'Alle Ausweise passen zu den angegebenen Käufern' : 'Ausweis lautet auf den Kunden')

  // Adresse: Regeln wie im Formular, im CRM angekommen, unverändert im Vertrag
  const addr: string[] = []
  if (d?.at) {
    const ppl: Array<[CustomerPerson, string, ((b: Buyer) => boolean)]> = [[d, 'Kunde', isLead], ...further.map(p => [p, `Käufer ${p.first_name} ${p.last_name}`, (b: Buyer) => sameName(b.full_name, p.first_name, p.last_name)] as [CustomerPerson, string, (b: Buyer) => boolean])]
    for (const [p, label, match] of ppl) {
      const bad = Object.keys(personErrors(p))
      if (bad.length) addr.push(`Angaben ${label} unvollständig oder ungültig (${bad.join(', ')})`)
      const b = buyers.find(match)
      if (b?.address && norm(b.address) !== norm(addressLine(p))) addr.push(`Adresse ${label} im Vertrag (${b.address}) weicht von der Eingabe ab (${addressLine(p)})`)
    }
    const { data: l } = await sb.from('leads').select('street, postal_code, city, country').eq('id', ctx.lead.id).maybeSingle()
    const lead = l as { street?: string | null; postal_code?: string | null; city?: string | null; country?: string | null } | null
    if (lead?.street !== d.street || lead?.postal_code !== d.postal_code || lead?.city !== d.city || lead?.country !== countryDe(d)) addr.push('Die Adresse ist beim Kunden im CRM nicht oder anders gespeichert')
  }
  add('adresse', addr, d?.at ? 'Adresse vom Kunden geprüft, im CRM und im Vertrag gleich' : 'Adresse von Hand eingetragen')

  // Zurücklesen: stimmt das fertige PDF mit den Werten überein?
  let pdfProblems: string[]
  try { pdfProblems = missingInPdf(await pdfTextKey(pdf), fl).map(m => `Fehlt im PDF: ${m}`) }
  catch (e) { pdfProblems = [`PDF ließ sich nicht zurücklesen: ${(e as Error).message}`] }
  add('pdf', pdfProblems, 'Fertiges PDF zurückgelesen, alle Werte stehen drin')

  const now = new Date().toISOString()
  const failing = () => points.filter(p => !p.ok).flatMap(p => p.text.split(' · '))
  // Teurer Schritt zuletzt: fällt schon etwas anderes durch, muss ohnehin ein Mensch ran
  if (failing().length) {
    points.push({ key: 'ausweis', ok: false, text: 'Zweite Ausweislesung übersprungen, weil schon ein anderer Punkt offen ist' })
    return { at: now, ok: false, points, reasons: failing().filter(t => !t.startsWith('Zweite Ausweislesung übersprungen')) }
  }

  const reads = await checkDeps.readIdFiles(ctx, checked)
  if (!reads) {
    points.push({ key: 'ausweis', ok: false, text: 'Zweite Ausweislesung gerade nicht möglich' })
    return { at: now, ok: false, retry: true, points, reasons: ['Zweite Ausweislesung war mehrfach nicht möglich'] }
  }
  const idProblems = buyers.flatMap((b, i) => compareBuyer(b, fl.buyers[i]?.nationality ?? '', reads))
  add('ausweis', idProblems, `Ausweis${buyers.length > 1 ? 'e' : ''} zweimal gelesen, Prüfziffern stimmen, Name, Nummer und Staatsangehörigkeit gleich`)
  return { at: now, ok: !failing().length, points, reasons: failing() }
}
