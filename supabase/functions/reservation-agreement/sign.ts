// Digitale Unterschrift des Bauträgers (Sven 15.10.2026): Valery öffnet /sign/r/<token>
// am Handy, unterschreibt mit dem Finger und tippt seinen Namen in Druckbuchstaben.
// Ort und Datum setzt das System. Das unterschriebene PDF landet im Drive-Kundenordner
// (Kunde + Anwalt haben Zugriff) und an der Wohnung (Portal: „Verträge").
//
// Öffentlich erreichbar, deshalb: nur der Token berechtigt (36 Hex-Zeichen, zufällig),
// jede Eingabe wird geprüft, unterschrieben wird genau einmal (Sperre in der DB).
// Ein Test-Token (test_sign_token) verschickt das Ergebnis nur an Sven und ändert nichts.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { renderAgreement, type AgreementFields } from './pdf.ts'
import { uploadToken, uploadFile } from './drive.ts'
import { loadSeal, saveSeal, sealDataUrl, pngFromInput, clientIp, LOCK_MINUTES, MAX_SEAL_BYTES } from './seal.ts'
import {
  loadCtx, leadName, todayCy, b64, esc, invoke, whatsappSven, fileNameFor,
  SVEN_MAIL, CRM_LEAD, type AgreementRow, type TemplateDb,
} from './index.ts'

const DEAD = ['deal_verloren', 'archiviert']

type Res = { status: number; body: Record<string, unknown> }
const TOKEN_RE = /^[0-9a-f]{36}$/
const MAX_SIG_BYTES = 400_000
const MIN_SIG_BYTES = 400                 // leeres Feld ergibt ein winziges PNG

async function findRow(sb: SupabaseClient, token: unknown): Promise<{ row: AgreementRow; test: boolean } | null> {
  const t = String(token ?? '').trim().toLowerCase()
  if (!TOKEN_RE.test(t)) return null
  const { data: real } = await sb.from('reservation_agreements').select('*').eq('sign_token', t).maybeSingle()
  if (real) return { row: real as AgreementRow, test: false }
  const { data: test } = await sb.from('reservation_agreements').select('*').eq('test_sign_token', t).maybeSingle()
  if (test) return { row: test as AgreementRow, test: true }
  return null
}

function payloadOf(row: AgreementRow, test: boolean): { fields: AgreementFields; template: TemplateDb } | null {
  if (test) return row.test_payload ?? null
  return row.data && row.template_snapshot ? { fields: row.data, template: row.template_snapshot } : null
}

export const placeOf = (t: { sign_place?: string | null }) => (t.sign_place ?? '').trim() || 'Cyprus'
export const langOf = (v: unknown): 'de' | 'en' => (v === 'de' ? 'de' : 'en')

export async function signView(sb: SupabaseClient, body: Record<string, unknown>): Promise<Res> {
  const hit = await findRow(sb, body.token)
  if (!hit) return { status: 404, body: { error: 'not_found' } }
  const { row, test } = hit
  const p = payloadOf(row, test)
  if (!p || row.status === 'abgebrochen') return { status: 404, body: { error: 'not_found' } }
  if (!test) {
    const { data: deal } = await sb.from('deals').select('phase, unit_id').eq('id', row.deal_id).maybeSingle()
    const d = deal as { phase?: string; unit_id?: string | null } | null
    if (!d || DEAD.includes(d.phase ?? '') || d.unit_id !== row.unit_id) return { status: 404, body: { error: 'not_found' } }
  }
  const signed = !test && !!row.seller_signed_at && !!row.signed_pdf_path
  const seal = signed ? null : await loadSeal(sb, p.template.developer_id)
  let pdf: Uint8Array
  if (signed) {
    const { data, error } = await sb.storage.from('unit-documents').download(row.signed_pdf_path!)
    if (error || !data) return { status: 500, body: { error: 'pdf_missing' } }
    pdf = new Uint8Array(await data.arrayBuffer())
  } else {
    pdf = await renderAgreement(p.template, p.fields)
  }
  return {
    status: 200,
    body: {
      ok: true, test, signed,
      signer_name: signed ? row.seller_signer_name : null,
      signed_at: signed ? row.seller_signed_at : null,
      company_name: p.template.company_name,
      title: p.template.title,
      fields: p.fields,
      place: placeOf(p.template),
      date: todayCy(),
      lang: langOf(test ? (row.test_payload as { lang?: string } | null)?.lang : row.signer_lang),
      seal: sealDataUrl(seal),
      pdf_base64: b64(pdf),
    },
  }
}

/** Druckbuchstaben: Großbuchstaben (auch mit Akzent), Leerzeichen, Punkt, Bindestrich, Apostroph. */
// Nur lateinische Buchstaben (inkl. Umlaute/Akzente): die PDF-Schrift kann kein Kyrillisch/Griechisch.
export const NAME_RE = /^[A-ZÀ-ÖØ-ÞĀ-ſ][A-ZÀ-ÖØ-ÞĀ-ſ .'-]*[A-ZÀ-ÖØ-ÞĀ-ſ.]$/
export function cleanName(raw: unknown): string | null {
  const n = String(raw ?? '').normalize('NFC').replace(/[’‘ʼ´`]/g, "'").replace(/\s+/g, ' ').trim().toUpperCase()
  if (n.length < 3 || n.length > 80) return null
  if (!NAME_RE.test(n)) return null
  if (!/[A-ZÀ-ÖØ-ÞĀ-ſ]{2,}/.test(n)) return null
  return n
}

export function cleanSignature(raw: unknown): Uint8Array | null {
  return pngFromInput(raw, MAX_SIG_BYTES, MIN_SIG_BYTES)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', bytes.slice())
  return Array.from(new Uint8Array(h), x => x.toString(16).padStart(2, '0')).join('')
}

export async function signSubmit(sb: SupabaseClient, body: Record<string, unknown>, req: Request): Promise<Res> {
  const hit = await findRow(sb, body.token)
  if (!hit) return { status: 404, body: { error: 'not_found' } }
  const { row, test } = hit
  const p = payloadOf(row, test)
  if (!p || row.status === 'abgebrochen') return { status: 404, body: { error: 'not_found' } }
  const name = cleanName(body.name)
  if (!name) return { status: 400, body: { error: 'invalid_name' } }
  const png = cleanSignature(body.signature)
  if (!png) return { status: 400, body: { error: 'invalid_signature' } }
  // Stempel: neues Foto (bereits freigestellt im Browser) oder der gespeicherte
  const newSeal = body.seal ? pngFromInput(body.seal, MAX_SEAL_BYTES) : null
  if (body.seal && !newSeal) return { status: 400, body: { error: 'invalid_seal' } }
  const useSeal = body.use_seal === true

  const now = new Date()
  const signedAtUtc = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const place = placeOf(p.template)
  const date = todayCy()

  const ctx = await loadCtx(sb, row.deal_id, p.template)
  if ('error' in ctx) return { status: 404, body: { error: 'not_found' } }
  if (!test && (DEAD.includes(ctx.deal.phase) || ctx.unit.id !== row.unit_id)) return { status: 404, body: { error: 'not_found' } }

  // Genau einmal unterschreiben: Sperre setzen, bevor gearbeitet wird (Doppelklick, zwei Tabs).
  // Die Sperre läuft nach LOCK_MINUTES ab, falls die Function mittendrin abbricht.
  if (!test) {
    const stale = new Date(now.getTime() - LOCK_MINUTES * 60_000).toISOString()
    const { data: lock } = await sb.from('reservation_agreements')
      .update({ seller_signed_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('id', row.id).eq('sign_token', row.sign_token!)
      .or(`seller_signed_at.is.null,and(signed_pdf_path.is.null,seller_signed_at.lt.${stale})`).select('id')
    if (!lock?.length) return { status: 409, body: { error: 'already_signed' } }
  }

  try {
    // Neuer Stempel gilt ab jetzt für alle Dokumente dieses Bauträgers (im Test nur für dieses PDF)
    if (newSeal && !test) await saveSeal(sb, p.template.developer_id, newSeal, `${name} (Unterschriftsseite)`)
    const seal = useSeal ? (newSeal ?? await loadSeal(sb, p.template.developer_id)) : null
    const pdf = await renderAgreement(p.template, p.fields, { png, name, place, date, signedAtUtc, seal })
    const hash = await sha256Hex(pdf)
    const meta = {
      name, place, date, signed_at: now.toISOString(), pdf_sha256: hash, with_seal: !!seal, new_seal: !!newSeal,
      ip: clientIp(req),
      user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
    }
    const unitLabel = `${ctx.project.name} ${ctx.unit.unit_number}`
    const fname = fileNameFor(ctx).replace(/\.pdf$/, ` (signed ${p.template.company_name}).pdf`)
    const attachment = { filename: fname.replace(/[()]/g, '').replace(/\s*-\s*/g, '_').replace(/\s+/g, '_'), content_base64: b64(pdf), content_type: 'application/pdf' }

    if (test) {
      const err = await invoke(sb, 'send-email', {
        to: SVEN_MAIL, subject: `TEST · Reservierungsvertrag digital unterschrieben: ${leadName(ctx.lead)} (${unitLabel})`,
        html: `<p>Testlauf: So sieht der Vertrag nach der Unterschrift aus. Es wurde nichts abgelegt und nichts an Kunden oder Bauträger geschickt.</p><p>Unterschrieben von ${esc(name)}, ${esc(place)}, ${esc(date)}</p>`,
        attachment, auto: true, lang: 'de', already_translated: true,
      })
      // Test wie im echten Ablauf: Bestätigung auch per WhatsApp, aber nur an Sven
      await whatsappSven(sb, `TEST · ✅ ${name} hat den Reservierungsvertrag ${leadName(ctx.lead)} (${unitLabel}) digital unterschrieben.\n\nIm echten Ablauf läge er jetzt an der Wohnung unter Verträge und im Drive-Ordner. Das PDF ist in deinem Postfach.`)
      return { status: 200, body: { ok: true, test: true, mail_error: err ?? null, pdf_base64: b64(pdf) } }
    }

    // 1. Storage + an der Wohnung ablegen (Portal-Reiter „Verträge")
    const path = `unit-documents/${ctx.unit.id}/${Date.now()}-reservation-signed.pdf`
    const { error: upErr } = await sb.storage.from('unit-documents').upload(path, pdf, { contentType: 'application/pdf', upsert: false })
    if (upErr) throw new Error(`Speichern: ${upErr.message}`)
    const { data: doc, error: docErr } = await sb.from('crm_unit_documents').insert({
      unit_id: ctx.unit.id, project_id: ctx.project.id, name: `Reservation ${ctx.project.name} ${ctx.unit.unit_number}`,
      file_path: path, file_name: fname, file_size: pdf.byteLength, doc_type: 'sonstiges',
      notes: `Reservierungsvereinbarung, digital unterschrieben von ${name} (${p.template.company_name}) am ${date}`,
    }).select('id').single()
    if (docErr) throw new Error(`Ablage an der Wohnung: ${docErr.message}`)

    // 2. In den Drive-Kundenordner (Kunde + Anwalt sehen ihn dort; owner-drive meldet die neue Datei)
    const problems: string[] = []
    let driveId: string | null = null
    if (ctx.lead.drive_folder_id) {
      try {
        const tok = await uploadToken(sb)
        if (!tok) throw new Error('Drive-Upload nicht verbunden')
        driveId = (await uploadFile(tok, ctx.lead.drive_folder_id, fname, 'application/pdf', pdf)).id
      } catch (e) { problems.push(`Drive: ${(e as Error).message}`) }
    } else problems.push('Kunde hat keinen Drive-Ordner')

    const checked = { ...(row.checked_files ?? {}) }
    if (driveId) checked[driveId] = { name: fname, at: new Date().toISOString(), created: new Date().toISOString(), skipped: 'eigene Datei' }
    await sb.from('reservation_agreements').update({
      status: 'unterschrieben', seller_signer_name: name, seller_sign_meta: meta, signed_pdf_path: path,
      unit_document_id: (doc as { id: string }).id, signed_file_id: driveId, checked_files: checked,
      own_file_ids: driveId ? [...(row.own_file_ids ?? []), driveId] : (row.own_file_ids ?? []),
      error: problems.length ? problems.join('; ') : null, review_reason: null, updated_at: new Date().toISOString(),
    }).eq('id', row.id)
    await sb.from('activities').insert({
      lead_id: ctx.lead.id, deal_id: ctx.deal.id, type: 'note', direction: 'inbound', auto: true,
      subject: 'Reservierungsvertrag unterschrieben',
      content: `${name} (${p.template.company_name}) hat den Reservierungsvertrag ${unitLabel} digital unterschrieben (${place}, ${date}). Abgelegt an der Wohnung unter Verträge${driveId ? ' und im Drive-Ordner' : ''}.${problems.length ? ` Probleme: ${problems.join('; ')}` : ''}`,
      completed_at: new Date().toISOString(),
    })

    // 3. Kopie an den Unterzeichner (Bauträger-Kontakte) und Meldung an Sven
    const de = langOf(row.signer_lang) === 'de'
    const unitTxt = `${esc(p.fields.property_name)}, ${de ? 'Einheit' : 'unit'} ${esc(p.fields.unit_number)}`
    const where = driveId
      ? (de ? '<p>Er liegt im gemeinsamen Google-Drive-Ordner für Kunde und Anwalt.</p>' : '<p>It has been stored in the shared Google Drive folder for the client and the lawyer.</p>')
      : ''
    for (const to of ctx.devEmails) {
      const err = await invoke(sb, 'send-email', {
        to, subject: de ? `Unterschrieben: Reservierungsvertrag ${p.fields.property_name} ${p.fields.unit_number}` : `Signed: reservation agreement ${p.fields.property_name} ${p.fields.unit_number}`,
        html: de
          ? `<p>Danke, ${esc(name)}! Anbei Ihre Kopie des unterschriebenen Reservierungsvertrags für <b>${unitTxt}</b> (${esc(p.fields.purchasers.join(', '))}).</p>${where}<p>Viele Grüße<br>Sven &middot; Happy Property</p>`
          : `<p>Thank you, ${esc(name)}! Attached is your copy of the signed reservation agreement for <b>${unitTxt}</b> (${esc(p.fields.purchasers.join(', '))}).</p>${where}<p>Best regards<br>Sven &middot; Happy Property</p>`,
        attachment, auto: true, lang: de ? 'de' : 'en', already_translated: true,
      })
      if (err) problems.push(`Kopie ${to}: ${err}`)
    }
    await whatsappSven(sb, `✅ ${name} (${p.template.company_name}) hat den Reservierungsvertrag ${leadName(ctx.lead)} (${unitLabel}) digital unterschrieben.\n\nLiegt an der Wohnung unter Verträge${driveId ? ' und im Drive-Ordner' : ''}.${problems.length ? `\n\nAchtung: ${problems.join('; ')}` : ''}\n\n${CRM_LEAD}${ctx.lead.id}`)
    return { status: 200, body: { ok: true, test: false, pdf_base64: b64(pdf) } }
  } catch (e) {
    // Sperre wieder lösen, damit erneut unterschrieben werden kann
    if (!test) await sb.from('reservation_agreements').update({ seller_signed_at: null, error: `Unterschrift: ${(e as Error).message}`.slice(0, 500) }).eq('id', row.id).is('signed_pdf_path', null)
    throw e
  }
}
