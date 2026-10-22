// Weitere Dokumente digital unterschreiben lassen, zuerst Spezifikationen (Sven 15.10.2026).
//
// Ablauf: Sven lädt im CRM das PDF hoch (doc_create) → Bauträger bekommt WhatsApp (mit Bild)
// + Mail mit Link /sign/d/<token> in seiner Sprache → unterschreibt am Handy (doc_view /
// doc_submit, öffentlich, nur mit Token) → stamp.ts setzt Unterschrift, Druckbuchstaben und
// Datum auf jede Seite und ins Unterschriftsfeld, optional den Firmenstempel → das PDF geht in
// den Drive-Kundenordner, an das Objekt im Eigentümerportal (crm_unit_documents) und per Mail
// an den Anwalt (crm_settings.sign_docs_lawyer), Sven bekommt eine WhatsApp.
// Test (test=true): alle Nachrichten nur an Sven, beim Unterschreiben wird nichts abgelegt.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1'
import { stampDocument } from './stamp.ts'
import { uploadToken, uploadFile } from './drive.ts'
import { loadSeal, saveSeal, sealDataUrl, pngFromInput, clientIp, LOCK_MINUTES, MAX_SEAL_BYTES } from './seal.ts'
import { cleanName, cleanSignature, sha256Hex, placeOf, langOf } from './sign.ts'
import { b64, esc, invoke, whatsappSven, whatsappPdf, markOwnUpload, notifyCustomerSigned, SVEN_MAIL, SVEN_PHONE, CRM_LEAD, todayCy } from './index.ts'

type Res = { status: number; body: Record<string, unknown> }
const SIGN_BASE = 'https://portal.happy-property.com/sign/d/'
const WA_IMAGE = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/Assets/wa/reservierung-unterlagen.jpg'
const TOKEN_RE = /^[0-9a-f]{36}$/
const MAX_PDF_BYTES = 15 * 1024 * 1024

interface DocRow {
  id: string; kind: string; title: string; deal_id: string | null; lead_id: string; unit_id: string | null; developer_id: string
  source_path: string; source_name: string | null; token: string; test: boolean; status: string; signer_lang: string
  signed_at: string | null; signer_name: string | null; sign_meta: Record<string, unknown> | null; signed_pdf_path: string | null
}
interface DocCtx {
  lead: { id: string; first_name: string | null; last_name: string | null; email: string | null; drive_folder_id: string | null; drive_folder_url: string | null }
  unit: { id: string; unit_number: string; project_id: string } | null
  project: { id: string; name: string } | null
  developer: { id: string; name: string }
  company: string
  place: string
  emails: string[]
  /** video = eigenes WhatsApp-Video des Kontakts (crm_developer_contacts.sign_wa_video), sonst Standardbild */
  wa: { name: string; phone: string; video: string | null } | null
  role: string | null
  lang: 'de' | 'en'
}

const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), x => x.toString(16).padStart(2, '0')).join('')
const leadLabel = (l: DocCtx['lead']) => [l.first_name, l.last_name].map(x => (x ?? '').trim()).filter(Boolean).join(' ') || l.email || 'Kunde'

/**
 * Ohne zugewiesene Wohnung (z. B. Bankbestätigung vor der Reservierung, Sven 22.10.2026) kommen
 * Projekt und Bauträger aus dem Auftrag selbst (project_id); abgelegt wird dann nur im Drive-Ordner.
 */
async function docCtx(sb: SupabaseClient, dealId: string, projectId?: string | null): Promise<DocCtx | { error: string }> {
  const { data: deal } = await sb.from('deals').select('id, lead_id, unit_id').eq('id', dealId).maybeSingle()
  const d = deal as { id: string; lead_id: string; unit_id: string | null } | null
  if (!d) return { error: 'Deal nicht gefunden' }
  if (!d.unit_id && !projectId) return { error: 'Am Deal ist keine Wohnung zugewiesen' }
  const { data: lead } = await sb.from('leads').select('id, first_name, last_name, email, drive_folder_id, drive_folder_url').eq('id', d.lead_id).maybeSingle()
  if (!lead) return { error: 'Kunde nicht gefunden' }
  let u: DocCtx['unit'] = null
  if (d.unit_id) {
    const { data: unit } = await sb.from('crm_project_units').select('id, unit_number, project_id').eq('id', d.unit_id).maybeSingle()
    u = unit as DocCtx['unit']
    if (!u) return { error: 'Wohnung nicht gefunden' }
  }
  const { data: proj } = await sb.from('crm_projects').select('id, name, developer').eq('id', u?.project_id ?? projectId!).maybeSingle()
  const p = proj as { id: string; name: string; developer: string | null } | null
  if (!p?.developer) return { error: 'Projekt ohne Bauträger' }
  const { data: dev } = await sb.from('crm_developers').select('id, name').ilike('name', p.developer).limit(1).maybeSingle()
  if (!dev) return { error: `Bauträger ${p.developer} nicht angelegt` }
  const developer = dev as { id: string; name: string }
  const { data: tpl } = await sb.from('reservation_templates').select('company_name, sign_place').eq('developer_id', developer.id).eq('is_active', true).maybeSingle()
  const t = tpl as { company_name?: string; sign_place?: string | null } | null
  const { data: contacts } = await sb.from('crm_developer_contacts')
    .select('name, email, phone, whatsapp, role, language, is_primary, drive_access, sign_wa_video').eq('developer_id', developer.id).order('is_primary', { ascending: false })
  const cs = (contacts ?? []) as Array<{ name: string | null; email: string | null; phone: string | null; whatsapp: string | null; role: string | null; language: string | null; is_primary: boolean; drive_access: boolean; sign_wa_video: string | null }>
  const withDrive = cs.filter(c => c.drive_access && c.email?.trim())
  const main = (withDrive.length ? withDrive : cs)[0]
  const waC = (withDrive.length ? withDrive : cs).find(c => (c.whatsapp || c.phone)?.trim())
  return {
    lead: lead as DocCtx['lead'], unit: u, project: { id: p.id, name: p.name }, developer,
    company: t?.company_name || developer.name.toUpperCase(),
    place: placeOf({ sign_place: t?.sign_place }),
    emails: (withDrive.length ? withDrive : cs.filter(c => c.email?.trim()).slice(0, 1)).map(c => c.email!.trim()),
    wa: waC ? { name: waC.name ?? developer.name, phone: (waC.whatsapp || waC.phone)!.trim(), video: waC.sign_wa_video?.trim() || null } : null,
    role: main?.role?.trim() || null,
    lang: langOf((waC ?? main)?.language),
  }
}

function pdfFromInput(raw: unknown): Uint8Array | null {
  const s = String(raw ?? '').replace(/^data:application\/pdf;base64,/, '')
  if (!s || s.length > MAX_PDF_BYTES * 1.4 || !/^[A-Za-z0-9+/=]+$/.test(s)) return null
  let bin: string
  try { bin = atob(s) } catch { return null }
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bin.startsWith('%PDF') ? bytes : null
}

/** Zusatzoptionen eines Auftrags (sign_meta), alle optional; ohne sie läuft alles wie bisher. */
interface DocOpts {
  note?: string                                    // eigener Absatz vor dem Link (Mail + WhatsApp)
  inputs?: DocInput[]                              // Felder, die der Unterzeichner am Handy ausfüllt
  notify_lawyer?: boolean                          // false = nicht an sign_docs_lawyer schicken
  cc_whatsapp?: Array<{ name: string; phone: string; lang?: 'de' | 'en' }>   // bekommen das signierte PDF
}
/** Eingabefeld: Beschriftung für die Seite, Position für den Eintrag im PDF (pdf-lib, Ursprung unten links). */
interface DocInput { key: string; label: string; hint?: string; required?: boolean; page: number; x: number; y: number; size?: number; max_width?: number }

const MAX_INPUTS = 8
const MAX_INPUT_LEN = 120

function cleanOpts(raw: unknown): DocOpts {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: DocOpts = {}
  if (typeof o.note === 'string' && o.note.trim()) out.note = o.note.trim().slice(0, 1500)
  if (o.notify_lawyer === false) out.notify_lawyer = false
  if (Array.isArray(o.inputs)) {
    out.inputs = (o.inputs as Array<Record<string, unknown>>).slice(0, MAX_INPUTS).map(i => ({
      key: String(i.key ?? '').replace(/[^a-z0-9_]/gi, '').slice(0, 40),
      label: String(i.label ?? '').trim().slice(0, 120),
      hint: typeof i.hint === 'string' ? i.hint.trim().slice(0, 200) : undefined,
      required: i.required === true,
      page: Math.max(0, Math.floor(Number(i.page) || 0)),
      x: Number(i.x), y: Number(i.y),
      size: Number(i.size) > 0 ? Math.min(Number(i.size), 16) : undefined,
      max_width: Number(i.max_width) > 0 ? Number(i.max_width) : undefined,
    })).filter(i => i.key && i.label && Number.isFinite(i.x) && Number.isFinite(i.y))
    if (!out.inputs.length) delete out.inputs
  }
  if (Array.isArray(o.cc_whatsapp)) {
    out.cc_whatsapp = (o.cc_whatsapp as Array<Record<string, unknown>>).slice(0, 3)
      .map(c => ({ name: String(c.name ?? '').trim().slice(0, 80), phone: String(c.phone ?? '').replace(/[^\d+]/g, ''), lang: c.lang === 'en' ? 'en' as const : 'de' as const }))
      .filter(c => c.name && /^\+\d{8,15}$/.test(c.phone))
    if (!out.cc_whatsapp.length) delete out.cc_whatsapp
  }
  return out
}

function requestTexts(lang: 'de' | 'en', c: DocCtx, title: string, link: string, firstName: string, opts: DocOpts = {}) {
  const unit = [c.project?.name, c.unit?.unit_number].filter(Boolean).join(' ')
  const buyer = leadLabel(c.lead)
  const ref = [unit, buyer].filter(Boolean).join(', ')
  const lawyer = opts.notify_lawyer !== false
  const fill = !!opts.inputs?.length
  const note = opts.note ?? ''
  if (lang === 'de') return {
    subject: `Bitte unterschreiben: ${title} (${ref})`,
    html: `<p>Hallo ${esc(c.developer.name)}-Team,</p>
<p>anbei <b>${esc(title)}</b> (${esc(ref)}) zur Unterschrift.</p>
${note ? `<p>${esc(note).replace(/\n/g, '<br>')}</p>` : ''}
<p><b>Kein Ausdrucken nötig:</b> bitte direkt am Handy ${fill ? 'die offenen Felder ausfüllen, ' : ''}prüfen und unterschreiben (Unterschrift mit dem Finger, Name in Druckbuchstaben). Datum und Unterschrift kommen automatisch auf jede Seite.</p>
<p><a href="${link}" style="display:inline-block;background:#1a2332;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Jetzt unterschreiben</a></p>
<p style="font-size:13px;color:#6b7280">${link}</p>
<p>Danach liegt das Dokument automatisch im gemeinsamen Google-Drive-Ordner ${lawyer ? 'für Kunde und Anwalt und geht an den Anwalt' : 'des Kunden'}.</p>
<p>Vielen Dank!<br>Sven &middot; Happy Property</p>`,
    wa: `Hallo ${firstName}, hier ist Lotte von Happy Property 🐾\n\n${title} (${ref}) ist bereit zur Unterschrift.${note ? `\n\n${note}` : ''}\n\nKein Ausdrucken nötig, einfach hier am Handy ${fill ? 'ausfüllen und ' : ''}unterschreiben:\n${link}\n\nDanach geht es automatisch in den Drive-Ordner ${lawyer ? 'für Kunde und Anwalt' : 'des Kunden'}. Danke!`,
  }
  return {
    subject: `Please sign: ${title} (${ref})`,
    html: `<p>Dear ${esc(c.developer.name)} team,</p>
<p>please find <b>${esc(title)}</b> (${esc(ref)}) for your signature.</p>
${note ? `<p>${esc(note).replace(/\n/g, '<br>')}</p>` : ''}
<p><b>No printing needed:</b> please ${fill ? 'fill in the open fields, ' : ''}check and sign it directly on your phone (finger signature, name in block letters). Date and signature are added to every page automatically.</p>
<p><a href="${link}" style="display:inline-block;background:#1a2332;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Sign now</a></p>
<p style="font-size:13px;color:#6b7280">${link}</p>
<p>The signed document is then stored automatically in the shared Google Drive folder ${lawyer ? 'for the client and the lawyer and sent to the lawyer' : 'of the client'}.</p>
<p>Thank you very much!<br>Sven &middot; Happy Property</p>`,
    wa: `Hi ${firstName}, Lotte from Happy Property here 🐾\n\n${title} (${ref}) is ready for your signature.${note ? `\n\n${note}` : ''}\n\nNo printing needed, just ${fill ? 'fill it in and ' : ''}sign it here on your phone:\n${link}\n\nIt then goes straight to the shared Drive folder ${lawyer ? 'for the client and the lawyer' : 'of the client'}. Thank you!`,
  }
}

/** Mail + WhatsApp mit dem Link an den Bauträger, Ergebnis am Auftrag und als Notiz am Kunden. */
async function dispatch(sb: SupabaseClient, c: DocCtx, row: { id: string; deal_id: string; title: string; token: string; test: boolean }, pdf: Uint8Array, opts: DocOpts): Promise<string[]> {
  const { title, test } = row
  const link = SIGN_BASE + row.token
  const tx = requestTexts(c.lang, c, title, link, (c.wa?.name ?? '').split(' ')[0], opts)
  const errors: string[] = []
  const attachment = { filename: `${title}.pdf`.replace(/[^A-Za-z0-9ÄÖÜäöüß._-]+/g, '_'), content_base64: b64(pdf), content_type: 'application/pdf' }
  for (const to of test ? [SVEN_MAIL] : c.emails) {
    const err = await invoke(sb, 'send-email', { to, subject: (test ? 'TEST · ' : '') + tx.subject, html: tx.html, attachment, auto: true, lang: c.lang, already_translated: true })
    if (err) errors.push(`Mail ${to}: ${err}`)
  }
  if (test || c.wa) {
    const err = await invoke(sb, 'send-whatsapp', {
      event_type: 'sign_document', override_text: (test ? 'TEST · ' : '') + tx.wa, auto: true, lang: c.lang, already_translated: true,
      ...(c.wa?.video ? { file_url: c.wa.video, file_name: 'document.mp4' } : { file_url: WA_IMAGE, file_name: 'document.jpg' }),
      lead_data: test ? { lead_name: 'Sven', lead_phone: SVEN_PHONE } : { lead_name: c.wa!.name, lead_phone: c.wa!.phone },
    })
    if (err) errors.push(`WhatsApp: ${err}`)
  }
  await sb.from('sign_documents').update({
    sent_at: new Date().toISOString(), sent_to: test ? [SVEN_MAIL] : c.emails,
    error: errors.length ? errors.join('; ') : null, updated_at: new Date().toISOString(),
  }).eq('id', row.id)
  if (!test) {
    await sb.from('activities').insert({
      lead_id: c.lead.id, deal_id: row.deal_id, type: 'note', direction: 'outbound', auto: true,
      subject: `${title} zur Unterschrift`,
      content: `${title} an ${c.emails.join(', ')} zur digitalen Unterschrift geschickt.${errors.length ? ` Probleme: ${errors.join('; ')}` : ''}`,
      completed_at: new Date().toISOString(),
    })
  }
  return errors
}

/** Admin: PDF hochladen und dem Bauträger zur Unterschrift schicken. */
export async function docCreate(sb: SupabaseClient, body: Record<string, unknown>): Promise<Res> {
  const dealId = String(body.deal_id ?? '')
  const c = await docCtx(sb, dealId, typeof body.project_id === 'string' ? body.project_id : null)
  if ('error' in c) return { status: 400, body: { error: c.error } }
  const opts = cleanOpts(body)
  const pdf = pdfFromInput(body.file_base64)
  if (!pdf) return { status: 400, body: { error: 'Bitte ein PDF bis 15 MB hochladen.' } }
  try {
    const probe = await PDFDocument.load(pdf, { ignoreEncryption: true })
    if (probe.isEncrypted) return { status: 400, body: { error: 'Das PDF ist geschützt (Passwort/Rechte). Bitte eine ungeschützte Fassung hochladen.' } }
  } catch { return { status: 400, body: { error: 'Das PDF lässt sich nicht öffnen.' } } }
  const test = body.test === true
  if (!test && !c.emails.length) return { status: 400, body: { error: `Beim Bauträger ${c.developer.name} ist keine E-Mail hinterlegt` } }
  const kind = body.kind === 'other' ? 'other' : 'specification'
  const title = String(body.title ?? '').trim().slice(0, 140)
    || `${c.lang === 'de' ? 'Spezifikation' : 'Specification'} ${c.project?.name ?? ''} ${c.unit?.unit_number ?? ''}`.trim()
  const path = `unit-documents/${c.unit?.id ?? `ohne-einheit/${c.lead.id}`}/${Date.now()}-sign-source.pdf`
  const { error: upErr } = await sb.storage.from('unit-documents').upload(path, pdf, { contentType: 'application/pdf', upsert: false })
  if (upErr) return { status: 500, body: { error: `Speichern: ${upErr.message}` } }
  // Neue Fassung ersetzt eine noch offene alte (gleicher Deal, gleiche Art): alter Link wird ungültig
  if (!test) {
    await sb.from('sign_documents').update({ status: 'abgebrochen', updated_at: new Date().toISOString() })
      .eq('deal_id', dealId).eq('kind', kind).eq('test', false).eq('status', 'offen')
  }
  const token = newToken()
  const { data: ins, error } = await sb.from('sign_documents').insert({
    kind, title, deal_id: dealId, lead_id: c.lead.id, unit_id: c.unit?.id ?? null, developer_id: c.developer.id,
    source_path: path, source_name: String(body.file_name ?? '').slice(0, 200) || null, token, test,
    signer_lang: c.lang, sign_meta: { role: c.role, company: c.company, ...opts },
  }).select('id').single()
  if (error) return { status: 500, body: { error: error.message } }
  const id = (ins as { id: string }).id
  const errors = await dispatch(sb, c, { id, deal_id: dealId, title, token, test }, pdf, opts)
  return { status: 200, body: { ok: !errors.some(e => e.startsWith('Mail ')), id, sign_link: SIGN_BASE + token, errors, test } }
}

/**
 * Warteschlange ohne Admin-Login (Sven 22.10.2026): eine Zeile in sign_documents mit status 'offen',
 * sent_at NULL und sign_meta.queued = true plus sign_meta.source_b64 (das PDF) und optional
 * sign_meta.project_id. Der Sweep (Cron alle 5 Minuten) legt das PDF ab und verschickt den Link wie doc_create.
 */
export async function docQueueSweep(sb: SupabaseClient): Promise<Array<Record<string, unknown>>> {
  const { data } = await sb.from('sign_documents').select('*').eq('status', 'offen').is('sent_at', null)
    .eq('sign_meta->>queued', 'true').order('created_at').limit(5)
  const out: Array<Record<string, unknown>> = []
  for (const row of (data ?? []) as DocRow[]) {
    const meta = { ...(row.sign_meta ?? {}) } as Record<string, unknown>
    const fail = async (msg: string) => {
      await sb.from('sign_documents').update({ status: 'fehler', error: msg.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', row.id)
      out.push({ doc: row.id, error: msg })
    }
    // Genau einmal: wer queued von true auf false setzt, verschickt
    const { data: lock } = await sb.from('sign_documents').update({ sign_meta: { ...meta, queued: false }, updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('sign_meta->>queued', 'true').is('sent_at', null).select('id')
    if (!lock?.length) continue
    if (!row.deal_id) { await fail('Warteschlange: deal_id fehlt'); continue }
    const c = await docCtx(sb, row.deal_id, typeof meta.project_id === 'string' ? meta.project_id : null)
    if ('error' in c) { await fail(`Warteschlange: ${c.error}`); continue }
    if (c.developer.id !== row.developer_id) { await fail('Warteschlange: Bauträger passt nicht zum Projekt'); continue }
    if (!row.test && !c.emails.length) { await fail(`Beim Bauträger ${c.developer.name} ist keine E-Mail hinterlegt`); continue }
    const pdf = pdfFromInput(meta.source_b64)
    if (!pdf) { await fail('Warteschlange: source_b64 ist kein PDF'); continue }
    try {
      const probe = await PDFDocument.load(pdf, { ignoreEncryption: true })
      if (probe.isEncrypted) { await fail('Warteschlange: PDF ist geschützt'); continue }
    } catch { await fail('Warteschlange: PDF lässt sich nicht öffnen'); continue }
    const path = `unit-documents/${c.unit?.id ?? `ohne-einheit/${c.lead.id}`}/${Date.now()}-sign-source.pdf`
    const { error: upErr } = await sb.storage.from('unit-documents').upload(path, pdf, { contentType: 'application/pdf', upsert: false })
    if (upErr) { await fail(`Speichern: ${upErr.message}`); continue }
    const opts = cleanOpts(meta)
    delete meta.source_b64
    await sb.from('sign_documents').update({
      source_path: path, unit_id: c.unit?.id ?? null, signer_lang: c.lang,
      sign_meta: { ...meta, queued: false, role: c.role, company: c.company, ...opts }, updated_at: new Date().toISOString(),
    }).eq('id', row.id)
    const errors = await dispatch(sb, c, { id: row.id, deal_id: row.deal_id, title: row.title, token: row.token, test: row.test }, pdf, opts)
    out.push({ doc: row.id, sent: true, errors })
  }
  return out
}

async function findDoc(sb: SupabaseClient, token: unknown): Promise<DocRow | null> {
  const t = String(token ?? '').trim().toLowerCase()
  if (!TOKEN_RE.test(t)) return null
  const { data } = await sb.from('sign_documents').select('*').eq('token', t).maybeSingle()
  return (data as DocRow | null) ?? null
}

async function storageBytes(sb: SupabaseClient, path: string): Promise<Uint8Array | null> {
  const { data, error } = await sb.storage.from('unit-documents').download(path)
  return error || !data ? null : new Uint8Array(await data.arrayBuffer())
}

/** Deal verloren oder andere Wohnung → Link ungültig (sonst landet das Dokument an der falschen Wohnung). */
async function dealGone(sb: SupabaseClient, row: DocRow): Promise<boolean> {
  if (!row.deal_id || row.test) return false
  const { data: deal } = await sb.from('deals').select('phase, unit_id').eq('id', row.deal_id).maybeSingle()
  const d = deal as { phase?: string; unit_id?: string | null } | null
  return !d || ['deal_verloren', 'archiviert'].includes(d.phase ?? '') || (!!row.unit_id && d.unit_id !== row.unit_id)
}

export async function docView(sb: SupabaseClient, body: Record<string, unknown>): Promise<Res> {
  const row = await findDoc(sb, body.token)
  if (!row || row.status === 'abgebrochen') return { status: 404, body: { error: 'not_found' } }
  if (row.status === 'offen' && await dealGone(sb, row)) return { status: 404, body: { error: 'not_found' } }
  const signed = !row.test && row.status === 'unterschrieben' && !!row.signed_pdf_path
  const pdf = await storageBytes(sb, signed ? row.signed_pdf_path! : row.source_path)
  if (!pdf) return { status: 500, body: { error: 'pdf_missing' } }
  const { data: tpl } = await sb.from('reservation_templates').select('sign_place').eq('developer_id', row.developer_id).eq('is_active', true).maybeSingle()
  const seal = signed ? null : await loadSeal(sb, row.developer_id)
  return {
    status: 200,
    body: {
      ok: true, kind: row.kind, test: row.test, signed, title: row.title,
      company_name: String(row.sign_meta?.company ?? ''),
      signer_name: signed ? row.signer_name : null, signed_at: signed ? row.signed_at : null,
      place: placeOf({ sign_place: (tpl as { sign_place?: string | null } | null)?.sign_place }),
      date: todayCy(), lang: langOf(row.signer_lang), seal: sealDataUrl(seal),
      inputs: signed ? [] : (cleanOpts(row.sign_meta).inputs ?? []).map(i => ({ key: i.key, label: i.label, hint: i.hint ?? null, required: !!i.required })),
      pdf_base64: b64(pdf),
    },
  }
}

/** Werte der Eingabefelder prüfen: nur bekannte Schlüssel, Länge begrenzt, Pflichtfelder gefüllt. */
function cleanInputValues(defs: DocInput[], raw: unknown): Record<string, string> | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const d of defs) {
    const v = String(o[d.key] ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_LEN)
    if (d.required && !v) return null
    if (v) out[d.key] = v
  }
  return out
}

/** Eingaben an ihre Positionen ins PDF schreiben (vor dem Unterschreiben). */
async function fillInputs(src: Uint8Array, defs: DocInput[], values: Record<string, string>): Promise<Uint8Array> {
  if (!defs.some(d => values[d.key])) return src
  const doc = await PDFDocument.load(src, { ignoreEncryption: true })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = doc.getPages()
  for (const d of defs) {
    const v = values[d.key]
    const page = pages[d.page]
    if (!v || !page) continue
    let size = d.size ?? 10
    let text = ''
    for (const ch of v) { try { font.encodeText(ch); text += ch } catch { text += ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '') || '?' } }
    if (d.max_width) while (size > 6 && font.widthOfTextAtSize(text, size) > d.max_width) size -= 0.5
    page.drawText(text, { x: d.x, y: d.y, size, font, color: rgb(0.1, 0.14, 0.2) })
  }
  return new Uint8Array(await doc.save())
}

export async function docSubmit(sb: SupabaseClient, body: Record<string, unknown>, req: Request): Promise<Res> {
  const row = await findDoc(sb, body.token)
  if (!row || row.status === 'abgebrochen') return { status: 404, body: { error: 'not_found' } }
  if (await dealGone(sb, row)) return { status: 404, body: { error: 'not_found' } }
  const name = cleanName(body.name)
  if (!name) return { status: 400, body: { error: 'invalid_name' } }
  const png = cleanSignature(body.signature)
  if (!png) return { status: 400, body: { error: 'invalid_signature' } }
  const newSeal = body.seal ? pngFromInput(body.seal, MAX_SEAL_BYTES) : null
  if (body.seal && !newSeal) return { status: 400, body: { error: 'invalid_seal' } }
  const useSeal = body.use_seal === true
  const opts = cleanOpts(row.sign_meta)
  const values = cleanInputValues(opts.inputs ?? [], body.inputs)
  if (!values) return { status: 400, body: { error: 'invalid_inputs' } }
  const now = new Date()

  if (!row.test) {
    // Genau einmal; die Sperre läuft nach LOCK_MINUTES ab, falls die Function mittendrin abbricht
    const stale = new Date(now.getTime() - LOCK_MINUTES * 60_000).toISOString()
    const { data: lock } = await sb.from('sign_documents').update({ signed_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('id', row.id).eq('status', 'offen').or(`signed_at.is.null,signed_at.lt.${stale}`).select('id')
    if (!lock?.length) return { status: 409, body: { error: 'already_signed' } }
  }
  try {
    const raw = await storageBytes(sb, row.source_path)
    if (!raw) throw new Error('Quell-PDF fehlt')
    const src = await fillInputs(raw, opts.inputs ?? [], values)
    if (newSeal && !row.test) await saveSeal(sb, row.developer_id, newSeal, `${name} (Unterschriftsseite)`)
    const seal = useSeal ? (newSeal ?? await loadSeal(sb, row.developer_id)) : null
    const { data: tpl } = await sb.from('reservation_templates').select('sign_place').eq('developer_id', row.developer_id).eq('is_active', true).maybeSingle()
    const place = placeOf({ sign_place: (tpl as { sign_place?: string | null } | null)?.sign_place })
    const company = String(row.sign_meta?.company ?? '')
    const role = (row.sign_meta?.role as string | null) ?? null
    const stamped = await stampDocument(src, { png, name, role, company, place, signedAtUtc: now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' }, seal)
    const pdf = stamped.pdf
    const fname = `${row.title} (signed).pdf`.replace(/[\\/:*?"<>|]+/g, ' ')
    const attachment = { filename: fname.replace(/[^A-Za-z0-9ÄÖÜäöüß._-]+/g, '_'), content_base64: b64(pdf), content_type: 'application/pdf' }
    const meta = {
      ...(row.sign_meta ?? {}), name, place, signed_at: now.toISOString(), pdf_sha256: await sha256Hex(pdf),
      placement: stamped.placement, with_seal: !!seal, new_seal: !!newSeal, input_values: values,
      ip: clientIp(req),
      user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
    }

    if (row.test) {
      const err = await invoke(sb, 'send-email', {
        to: SVEN_MAIL, subject: `TEST · ${row.title} digital unterschrieben`,
        html: `<p>Testlauf: So sieht das Dokument nach der Unterschrift aus (${stamped.placement === 'field' ? 'Unterschriftsfeld gefunden' : 'kein Feld gefunden, Unterschriftsseite angehängt'}). Es wurde nichts abgelegt und nichts an Anwalt, Kunde oder Bauträger geschickt.</p>`,
        attachment, auto: true, lang: 'de', already_translated: true,
      })
      // Test wie im echten Ablauf: Bestätigung + PDF per WhatsApp, aber nur an Sven
      await whatsappSven(sb, `TEST · ✅ ${name} hat ${row.title} digital unterschrieben.\n\nIm echten Ablauf läge es jetzt am Objekt im Eigentümerportal und im Drive-Ordner, und Timotheos hätte es per Mail. Das PDF ist in deinem Postfach.`)
      const tpath = `unit-documents/${row.unit_id ?? 'ohne-einheit'}/${Date.now()}-test-signed.pdf`
      const { error: tErr } = await sb.storage.from('unit-documents').upload(tpath, pdf, { contentType: 'application/pdf', upsert: false })
      if (!tErr) await whatsappPdf(sb, { name: 'Sven', phone: SVEN_PHONE }, `TEST · So bekommt der Bauträger das unterschriebene PDF per WhatsApp:\n\nThank you, ${name}! Here is your signed copy of ${row.title}.`, tpath, fname, 'de')
      return { status: 200, body: { ok: true, test: true, mail_error: err ?? null, pdf_base64: b64(pdf) } }
    }

    const { data: lead } = await sb.from('leads').select('id, first_name, last_name, email, drive_folder_id').eq('id', row.lead_id).maybeSingle()
    const l = lead as { id: string; first_name: string | null; last_name: string | null; email: string | null; drive_folder_id: string | null } | null
    const kunde = l ? [l.first_name, l.last_name].filter(Boolean).join(' ') : ''
    const problems: string[] = []

    // 1. Objekt im Eigentümerportal (crm_unit_documents → Reiter „Verträge")
    const path = `unit-documents/${row.unit_id ?? `ohne-einheit/${row.lead_id}`}/${Date.now()}-signed-document.pdf`
    const { error: upErr } = await sb.storage.from('unit-documents').upload(path, pdf, { contentType: 'application/pdf', upsert: false })
    if (upErr) throw new Error(`Speichern: ${upErr.message}`)
    // Sofort als unterschrieben markieren: bricht die Function danach ab, wird nicht doppelt unterschrieben
    await sb.from('sign_documents').update({ status: 'unterschrieben', signer_name: name, sign_meta: meta, signed_pdf_path: path, updated_at: new Date().toISOString() }).eq('id', row.id)
    let docId: string | null = null
    if (row.unit_id) {
      const { data: unit } = await sb.from('crm_project_units').select('project_id').eq('id', row.unit_id).maybeSingle()
      const { data: doc, error: docErr } = await sb.from('crm_unit_documents').insert({
        unit_id: row.unit_id, project_id: (unit as { project_id: string } | null)?.project_id,
        name: row.title, file_path: path, file_name: fname, file_size: pdf.byteLength, doc_type: 'sonstiges',
        notes: `Digital unterschrieben von ${name} (${company}) am ${now.toISOString().slice(0, 10)}`,
      }).select('id').single()
      if (docErr) problems.push(`Ablage am Objekt: ${docErr.message}`)
      else docId = (doc as { id: string }).id
    }

    // 2. Drive-Kundenordner
    let driveId: string | null = null
    if (l?.drive_folder_id) {
      try {
        const tok = await uploadToken(sb)
        if (!tok) throw new Error('Drive-Upload nicht verbunden')
        const up = await uploadFile(tok, l.drive_folder_id, fname, 'application/pdf', pdf)
        driveId = up.id
        await markOwnUpload(sb, row.lead_id, l.drive_folder_id, up, pdf.byteLength)
      } catch (e) { problems.push(`Drive: ${(e as Error).message}`) }
    } else problems.push('Kunde hat keinen Drive-Ordner')

    // 3. Anwalt (Partner-Kommunikation ohne lead_id)
    const { data: setting } = await sb.from('crm_settings').select('value').eq('key', 'sign_docs_lawyer').maybeSingle()
    const withLawyer = opts.notify_lawyer !== false
    const lawyerTok = String((setting as { value?: unknown } | null)?.value ?? '').replace(/"/g, '').trim()
    if (withLawyer && lawyerTok.startsWith('bc:')) {
      const { data: bc } = await sb.from('crm_business_contacts').select('first_name, email, language').eq('id', lawyerTok.slice(3)).maybeSingle()
      const law = bc as { first_name: string | null; email: string | null; language: string | null } | null
      if (law?.email) {
        const de = law.language === 'de'
        const err = await invoke(sb, 'send-email', {
          to: law.email,
          subject: de ? `Unterschrieben: ${row.title} (${kunde})` : `Signed: ${row.title} (${kunde})`,
          html: de
            ? `<p>Hallo ${esc(law.first_name ?? '')},</p><p>anbei <b>${esc(row.title)}</b> für ${esc(kunde)}, digital unterschrieben von ${esc(name)} (${esc(company)}).</p><p>Viele Grüße<br>Sven &middot; Happy Property</p>`
            : `<p>Hi ${esc(law.first_name ?? '')},</p><p>please find attached <b>${esc(row.title)}</b> for ${esc(kunde)}, signed digitally by ${esc(name)} (${esc(company)}).</p><p>Best regards<br>Sven &middot; Happy Property</p>`,
          attachment, auto: true, lang: de ? 'de' : 'en', already_translated: true,
        })
        if (err) problems.push(`Anwalt: ${err}`)
      } else problems.push('Anwalt ohne E-Mail')
    }

    // 4. Kopie an den Bauträger, Notiz am Kunden, WhatsApp an Sven
    const { data: contacts } = await sb.from('crm_developer_contacts').select('name, email, phone, whatsapp, drive_access, is_primary, language').eq('developer_id', row.developer_id).order('is_primary', { ascending: false })
    const cs = (contacts ?? []) as Array<{ name: string | null; email: string | null; phone: string | null; whatsapp: string | null; drive_access: boolean; is_primary: boolean; language: string | null }>
    const devMails = (cs.some(c => c.drive_access && c.email) ? cs.filter(c => c.drive_access && c.email) : cs.filter(c => c.email).slice(0, 1)).map(c => c.email!)
    for (const to of devMails) {
      const de = row.signer_lang === 'de'
      const err = await invoke(sb, 'send-email', {
        to, subject: de ? `Unterschrieben: ${row.title}` : `Signed: ${row.title}`,
        html: de ? `<p>Danke, ${esc(name)}! Anbei Ihre Kopie von <b>${esc(row.title)}</b>.${driveId ? ` Das Dokument liegt im gemeinsamen Drive-Ordner ${withLawyer ? 'für Kunde und Anwalt' : 'des Kunden'}.` : ''}</p><p>Viele Grüße<br>Sven &middot; Happy Property</p>`
          : `<p>Thank you, ${esc(name)}! Attached is your copy of <b>${esc(row.title)}</b>.${driveId ? ` It has been stored in the shared Drive folder ${withLawyer ? 'for the client and the lawyer' : 'of the client'}.` : ''}</p><p>Best regards<br>Sven &middot; Happy Property</p>`,
        attachment, auto: true, lang: de ? 'de' : 'en', already_translated: true,
      })
      if (err) problems.push(`Kopie ${to}: ${err}`)
    }
    // Unterschriebenes PDF auch per WhatsApp an den Unterzeichner (gleicher Kontakt wie die Anfrage)
    const waC = (cs.some(c => c.drive_access && c.email) ? cs.filter(c => c.drive_access && c.email) : cs).find(c => (c.whatsapp || c.phone)?.trim())
    if (waC) {
      const de = row.signer_lang === 'de'
      const waText = de
        ? `Danke, ${name}! Hier ist Ihre unterschriebene Fassung: ${row.title}.${driveId ? ` Sie liegt auch im gemeinsamen Drive-Ordner ${withLawyer ? 'für Kunde und Anwalt' : 'des Kunden'}.` : ''}`
        : `Thank you, ${name}! Here is your signed copy of ${row.title}.${driveId ? ` It is also stored in the shared Drive folder ${withLawyer ? 'for the client and the lawyer' : 'of the client'}.` : ''}`
      const err = await whatsappPdf(sb, { name: waC.name ?? 'Developer', phone: (waC.whatsapp || waC.phone)!.trim() }, waText, path, fname, de ? 'de' : 'en')
      if (err) problems.push(`WhatsApp-PDF: ${err}`)
    }
    // Weitere Empfänger des signierten PDFs aus dem Auftrag (z. B. der Finanzierungspartner)
    for (const cc of opts.cc_whatsapp ?? []) {
      const first = cc.name.split(' ')[0]
      const text = cc.lang === 'en'
        ? `Hi ${first}, Lotte from Happy Property here 🐾\n\nAttached is ${row.title}${kunde ? ` for ${kunde}` : ''}, signed by ${name} (${company}).\n\nBest, Lotte`
        : `Hallo ${first}, hier ist Lotte von Happy Property 🐾\n\nanbei ${row.title}${kunde ? ` für ${kunde}` : ''}, unterschrieben von ${name} (${company}).\n\nViele Grüße\nLotte`
      const err = await whatsappPdf(sb, { name: cc.name, phone: cc.phone }, text, path, fname, cc.lang ?? 'de')
      if (err) problems.push(`WhatsApp ${cc.name}: ${err}`)
    }
    await sb.from('sign_documents').update({
      status: 'unterschrieben', signer_name: name, sign_meta: meta, signed_pdf_path: path, unit_document_id: docId,
      drive_file_id: driveId, error: problems.length ? problems.join('; ') : null, updated_at: new Date().toISOString(),
    }).eq('id', row.id)
    await sb.from('activities').insert({
      lead_id: row.lead_id, deal_id: row.deal_id, type: 'note', direction: 'inbound', auto: true,
      subject: `${row.title} unterschrieben`,
      content: `${name} (${company}) hat ${row.title} digital unterschrieben. Abgelegt am Objekt${driveId ? ', im Drive-Ordner' : ''} und an den Anwalt geschickt.${problems.length ? ` Probleme: ${problems.join('; ')}` : ''}`,
      completed_at: new Date().toISOString(),
    })
    if (driveId) {
      const what = row.kind === 'specification'
        ? { de: 'Die Spezifikation für deine Wohnung', en: 'The specification for your property' }
        : { de: `Das Dokument „${row.title}"`, en: `The document "${row.title}"` }
      const err = await notifyCustomerSigned(sb, row.lead_id, what)
      if (err) problems.push(`Kunde WhatsApp: ${err}`)
    }
    await whatsappSven(sb, `✅ ${name} (${company}) hat ${row.title} für ${kunde} digital unterschrieben.\n\nLiegt am Objekt im Eigentümerportal${driveId ? ' und im Drive-Ordner' : ''}, Anwalt hat es per Mail.${problems.length ? `\n\nAchtung: ${problems.join('; ')}` : ''}\n\n${CRM_LEAD}${row.lead_id}`)
    return { status: 200, body: { ok: true, test: false, pdf_base64: b64(pdf) } }
  } catch (e) {
    if (!row.test) await sb.from('sign_documents').update({ signed_at: null, error: `Unterschrift: ${(e as Error).message}`.slice(0, 500) }).eq('id', row.id).eq('status', 'offen').is('signed_pdf_path', null)
    throw e
  }
}
