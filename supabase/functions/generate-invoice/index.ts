// Supabase Edge Function: generate-invoice
// Erzeugt eine zypern-konforme Rechnung (sveru ltd / Happy-Property-CI) als PDF,
// speichert sie + optional Mailversand an den Kunden (Burkhard / Reeaals).
//
// POST-Body:
//   { customer_id?, deal_id?, lead_id?,
//     items: [{ description, quantity, unit_price_net }],
//     vat_treatment?, issue_date?, supply_date?, due_days?, notes?,
//     send?: boolean, recipient_email? }
//
// MwSt-Behandlungen: standard_19 | reduced_9 | reduced_5 | reduced_3 | zero |
//                    reverse_charge_eu | third_country | exempt

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from 'npm:pdf-lib@1.17.1'
import fontkit from 'npm:@pdf-lib/fontkit@1.1.1'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PUBLIC_BASE   = Deno.env.get('PUBLIC_SITE_URL') ?? 'https://portal.happy-property.com'
const BUCKET        = 'invoice-documents'

// ── CI-Farben ─────────────────────────────────────────────────────────────────
const CORAL = rgb(1, 0x79 / 255, 0x5d / 255)     // #ff795d
const DARK  = rgb(0x1b / 255, 0x1b / 255, 0x22 / 255) // #1b1b22
const GOLD  = rgb(0xc2 / 255, 0xa1 / 255, 0x5e / 255) // #C2A15E
const GREY  = rgb(0.40, 0.43, 0.49)
const LINE  = rgb(0.86, 0.86, 0.88)
const WHITE = rgb(1, 1, 1)

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const eur = (n: number) => '€' + n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dDate = (d: string | Date) =>
  new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })

type Treatment = 'standard_19' | 'reduced_9' | 'reduced_5' | 'reduced_3' | 'zero' | 'reverse_charge_eu' | 'third_country' | 'exempt'

function vatInfo(t: Treatment): { rate: number; label: string; note: string } {
  switch (t) {
    case 'standard_19':       return { rate: 19, label: '19% MwSt (Zypern)', note: '' }
    case 'reduced_9':         return { rate: 9,  label: '9% MwSt (Zypern)',  note: '' }
    case 'reduced_5':         return { rate: 5,  label: '5% MwSt (Zypern)',  note: '' }
    case 'reduced_3':         return { rate: 3,  label: '3% MwSt (Zypern)',  note: '' }
    case 'zero':              return { rate: 0,  label: '0% (Nullsatz)',     note: 'Zero-rated supply (0% VAT).' }
    case 'reverse_charge_eu': return { rate: 0,  label: 'Reverse Charge (0%)', note: 'Reverse charge — VAT to be accounted for by the recipient (Art. 196 Directive 2006/112/EC). Steuerschuldnerschaft des Leistungsempfängers.' }
    case 'third_country':     return { rate: 0,  label: 'Drittland (0%)',    note: 'Supply of services outside the scope of EU VAT (place of supply outside the EU, Art. 44 Directive 2006/112/EC).' }
    case 'exempt':            return { rate: 0,  label: 'Steuerbefreit',     note: 'VAT exempt.' }
  }
}

function defaultTreatment(countryMode: string | null | undefined): Treatment {
  if (countryMode === 'eu')    return 'reverse_charge_eu'
  if (countryMode === 'third') return 'third_country'
  return 'standard_19'
}

// ── Schriften laden (CI: Montserrat + Playfair). Bei Netzfehler → Standard-Fonts. ─
let _fontCache: Uint8Array[] | null = null
async function loadFonts(): Promise<{ mont?: Uint8Array; montSemi?: Uint8Array; playfair?: Uint8Array }> {
  const urls = {
    mont:     'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Regular.ttf',
    montSemi: 'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-SemiBold.ttf',
    playfair: 'https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/static/PlayfairDisplay-Bold.ttf',
  }
  try {
    const [a, b, c] = await Promise.all(Object.values(urls).map(async (u) => {
      const ctrl = new AbortController()
      const to = setTimeout(() => ctrl.abort(), 8000)
      try {
        const r = await fetch(u, { signal: ctrl.signal })
        if (!r.ok) throw new Error(String(r.status))
        return new Uint8Array(await r.arrayBuffer())
      } finally { clearTimeout(to) }
    }))
    return { mont: a, montSemi: b, playfair: c }
  } catch {
    return {}  // Fallback auf StandardFonts
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
  try {
    const body = await req.json()
    const rawItems = Array.isArray(body.items) ? body.items : []
    if (!rawItems.length) return json({ error: 'items[] fehlt' }, 400)

    // ── Aussteller-Einstellungen ──────────────────────────────────────────────
    const { data: settings } = await supabase.from('invoice_settings').select('*').eq('id', true).maybeSingle()
    if (!settings) return json({ error: 'invoice_settings fehlt' }, 500)

    // ── Kunde auflösen (id ODER Standard) ─────────────────────────────────────
    let customer = null as Record<string, unknown> | null
    if (body.customer_id) {
      const { data } = await supabase.from('invoice_customers').select('*').eq('id', body.customer_id).maybeSingle()
      customer = data
    }
    if (!customer) {
      const { data } = await supabase.from('invoice_customers').select('*').eq('is_default', true).maybeSingle()
      customer = data
    }
    if (!customer) return json({ error: 'Kein Rechnungs-Empfänger gefunden' }, 400)

    // ── MwSt bestimmen ────────────────────────────────────────────────────────
    const treatment = (body.vat_treatment as Treatment) || defaultTreatment(customer.country_mode as string)
    const { rate, label: vatLabel, note: vatNote } = vatInfo(treatment)
    // „innerhalb Zyperns immer 19%": cyprus-Kunde erzwingt Standard, falls kein expliziter Override.
    const effTreatment: Treatment =
      (customer.country_mode === 'cyprus' && !body.vat_treatment) ? 'standard_19' : treatment
    const eff = vatInfo(effTreatment)

    // ── Posten + Summen ───────────────────────────────────────────────────────
    const items = rawItems.map((it: Record<string, unknown>, i: number) => {
      const quantity = Number(it.quantity ?? 1) || 1
      const unit_price_net = round2(Number(it.unit_price_net ?? 0) || 0)
      const line_net = round2(quantity * unit_price_net)
      return { description: String(it.description ?? '').trim() || 'Leistung', quantity, unit_price_net, line_net, sort: i }
    })
    const subtotal_net = round2(items.reduce((s, it) => s + it.line_net, 0))
    const vat_amount   = round2(subtotal_net * eff.rate / 100)
    const total_gross  = round2(subtotal_net + vat_amount)

    // ── Datümer ───────────────────────────────────────────────────────────────
    const issue = body.issue_date ? new Date(body.issue_date) : new Date()
    const issueStr = issue.toISOString().slice(0, 10)
    const supplyStr = body.supply_date ? new Date(body.supply_date).toISOString().slice(0, 10) : issueStr
    const dueDays = Number(body.due_days ?? settings.default_due_days ?? 7)
    const due = new Date(issue.getTime() + dueDays * 86400000)
    const dueStr = due.toISOString().slice(0, 10)

    // ── Rechnungsnummer atomar ziehen ─────────────────────────────────────────
    const { data: numData, error: numErr } = await supabase.rpc('claim_invoice_number')
    if (numErr || !numData) return json({ error: 'Nummernkreis: ' + (numErr?.message ?? 'leer') }, 500)
    const invoiceNumber = String(numData)

    const issuerSnap = {
      legal_name: settings.legal_name, brand_name: settings.brand_name,
      address_line1: settings.address_line1, postal_code: settings.postal_code, city: settings.city,
      country: settings.country, vat_number: settings.vat_number, reg_number: settings.reg_number,
      email: settings.email, bank_name: settings.bank_name, iban: settings.iban, bic: settings.bic,
      intermediary_bic: settings.intermediary_bic,
    }
    const customerSnap = {
      company_name: customer.company_name, contact_name: customer.contact_name,
      address_line1: customer.address_line1, address_line2: customer.address_line2,
      postal_code: customer.postal_code, city: customer.city, country: customer.country,
      vat_number: customer.vat_number, email: customer.email,
    }

    // ── Rechnung speichern ────────────────────────────────────────────────────
    const { data: inv, error: invErr } = await supabase.from('crm_invoices').insert({
      invoice_number: invoiceNumber,
      customer_id: customer.id,
      deal_id: body.deal_id ?? null,
      lead_id: body.lead_id ?? null,
      issuer_snapshot: issuerSnap,
      customer_snapshot: customerSnap,
      issue_date: issueStr, supply_date: supplyStr, due_date: dueStr,
      vat_treatment: effTreatment, vat_rate: eff.rate,
      subtotal_net, vat_amount, total_gross, currency: 'EUR',
      status: 'draft', vat_note: eff.note || null, notes: body.notes ?? null,
    }).select('*').single()
    if (invErr || !inv) return json({ error: 'Insert: ' + (invErr?.message ?? '') }, 500)

    await supabase.from('crm_invoice_items').insert(
      items.map(it => ({ invoice_id: inv.id, description: it.description, quantity: it.quantity, unit_price_net: it.unit_price_net, line_net: it.line_net, sort: it.sort }))
    )

    // ── PDF erzeugen ──────────────────────────────────────────────────────────
    const pdfBytes = await buildPdf({ settings, issuerSnap, customerSnap, inv, items, eff, invoiceNumber, issueStr, supplyStr, dueStr, subtotal_net, vat_amount, total_gross })

    // ── Upload (öffentlich per Token-Pfad) ────────────────────────────────────
    const path = `${inv.token}.pdf`
    await supabase.storage.from(BUCKET).upload(path, pdfBytes, { contentType: 'application/pdf', upsert: true })
    await supabase.from('crm_invoices').update({ pdf_path: path }).eq('id', inv.id)
    const pdfUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
    const publicUrl = `${PUBLIC_BASE}/re/${inv.token}`

    // ── Optional: Mailversand an Kunden ───────────────────────────────────────
    let sent = false
    if (body.send) {
      const to = String(body.recipient_email || customer.email || '').trim()
      if (to) {
        const b64 = base64FromBytes(pdfBytes)
        const greet = customerSnap.contact_name ? `Hallo ${customerSnap.contact_name},` : 'Guten Tag,'
        const html = `<div style="font-family:Montserrat,Arial,sans-serif;color:#1b1b22;font-size:14px;line-height:1.6">
          <p>${greet}</p>
          <p>anbei die Rechnung <strong>${invoiceNumber}</strong> über <strong>${eur(total_gross)}</strong>.</p>
          <p>Zahlbar bis <strong>${dDate(dueStr)}</strong> per Überweisung (Verwendungszweck: ${invoiceNumber}).</p>
          <p>Online ansehen: <a href="${publicUrl}" style="color:#ff795d">${publicUrl}</a></p>
          <p>Beste Grüße<br/>${settings.brand_name}</p>
        </div>`
        const r = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to, subject: `Rechnung ${invoiceNumber} — ${settings.brand_name}`, html,
            lead_id: body.lead_id ?? null, deal_id: body.deal_id ?? null,
            attachment: { filename: `${invoiceNumber}.pdf`, content_base64: b64, content_type: 'application/pdf' },
          }),
        })
        sent = r.ok
        if (r.ok) await supabase.from('crm_invoices').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', inv.id)
      }
    }

    return json({ ok: true, invoice_id: inv.id, invoice_number: invoiceNumber, token: inv.token, public_url: publicUrl, pdf_url: pdfUrl, subtotal_net, vat_amount, total_gross, vat_rate: eff.rate, sent })
  } catch (e) {
    console.error('[generate-invoice]', e)
    return json({ error: (e as Error).message }, 500)
  }
})

// ── PDF-Layout (A4) ─────────────────────────────────────────────────────────────
async function buildPdf(d: {
  settings: Record<string, unknown>; issuerSnap: Record<string, unknown>; customerSnap: Record<string, unknown>
  inv: Record<string, unknown>; items: Array<{ description: string; quantity: number; unit_price_net: number; line_net: number }>
  eff: { rate: number; label: string; note: string }
  invoiceNumber: string; issueStr: string; supplyStr: string; dueStr: string
  subtotal_net: number; vat_amount: number; total_gross: number
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)

  const fonts = await loadFonts()
  let body: PDFFont, bold: PDFFont, head: PDFFont
  if (fonts.mont && fonts.montSemi && fonts.playfair) {
    body = await pdf.embedFont(fonts.mont, { subset: true })
    bold = await pdf.embedFont(fonts.montSemi, { subset: true })
    head = await pdf.embedFont(fonts.playfair, { subset: true })
  } else {
    body = await pdf.embedFont(StandardFonts.Helvetica)
    bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    head = await pdf.embedFont(StandardFonts.TimesRomanBold)
  }

  const page = pdf.addPage([595.28, 841.89]) // A4
  const W = 595.28, M = 50
  const right = W - M
  let y = 841.89 - M

  const text = (s: string, x: number, yy: number, size: number, font: PDFFont, color = DARK, spacing = 0) => {
    page.drawText(s, { x, y: yy, size, font, color, ...(spacing ? { characterSpacing: spacing } : {}) })
  }
  const tRight = (s: string, xr: number, yy: number, size: number, font: PDFFont, color = DARK) => {
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: xr - w, y: yy, size, font, color })
  }
  const hr = (yy: number, color = LINE, thickness = 0.8, x0 = M, x1 = right) =>
    page.drawLine({ start: { x: x0, y: yy }, end: { x: x1, y: yy }, thickness, color })

  // ── Kopf: Logo + Titel ──────────────────────────────────────────────────────
  let logo: PDFImage | null = null
  try {
    const logoUrl = String(d.settings.logo_url ?? '')
    if (logoUrl) {
      const lr = await fetch(logoUrl)
      if (lr.ok) {
        const bytes = new Uint8Array(await lr.arrayBuffer())
        logo = logoUrl.toLowerCase().endsWith('.png') ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes)
      }
    }
  } catch { /* Logo optional */ }
  if (logo) {
    const lw = 132
    const lh = (logo.height / logo.width) * lw
    page.drawImage(logo, { x: M, y: y - lh + 6, width: lw, height: lh })
  } else {
    text(String(d.settings.brand_name ?? 'Happy Property'), M, y - 12, 20, head, DARK)
  }
  text('RECHNUNG', right - head.widthOfTextAtSize('RECHNUNG', 26), y - 8, 26, head, DARK)
  tRight('INVOICE', right, y - 24, 9, bold, GREY)
  y -= 56
  hr(y, CORAL, 2)
  y -= 26

  // ── Aussteller (links) + Meta (rechts) ──────────────────────────────────────
  const colR = 330
  let yL = y, yR = y
  const I = d.issuerSnap
  text(String(I.brand_name ?? ''), M, yL, 12, head, DARK); yL -= 15
  text(String(I.legal_name ?? ''), M, yL, 9.5, bold, DARK); yL -= 13
  for (const ln of [String(I.address_line1 ?? ''), `${I.postal_code ?? ''} ${I.city ?? ''}, ${I.country ?? ''}`.trim()]) {
    if (ln.trim()) { text(ln, M, yL, 9, body, GREY); yL -= 12 }
  }
  if (I.vat_number) { text(`VAT: ${I.vat_number}`, M, yL, 9, body, GREY); yL -= 12 }
  if (I.reg_number) { text(`Reg.-Nr.: ${I.reg_number}`, M, yL, 9, body, GREY); yL -= 12 }

  const meta: Array<[string, string]> = [
    ['Rechnungsnummer', d.invoiceNumber],
    ['Ausstellungsdatum', dDate(d.issueStr)],
    ['Leistungsdatum', dDate(d.supplyStr)],
    ['Fällig bis', dDate(d.dueStr)],
  ]
  for (const [k, v] of meta) {
    text(k, colR, yR, 9, body, GREY)
    tRight(v, right, yR, 9.5, bold, DARK)
    yR -= 15
  }
  y = Math.min(yL, yR) - 18

  // ── Rechnung an ─────────────────────────────────────────────────────────────
  text('RECHNUNG AN', M, y, 8.5, bold, GOLD, 1.5); y -= 16
  const C = d.customerSnap
  text(String(C.company_name ?? ''), M, y, 11, bold, DARK); y -= 14
  const cLines = [
    C.contact_name ? `z. Hd. ${C.contact_name}` : '',
    String(C.address_line1 ?? ''),
    String(C.address_line2 ?? ''),
    `${C.postal_code ?? ''} ${C.city ?? ''}, ${C.country ?? ''}`.trim(),
    C.vat_number ? `VAT: ${C.vat_number}` : '',
  ].filter(s => s && s.trim() && s.trim() !== ',')
  for (const ln of cLines) { text(ln, M, y, 9, body, GREY); y -= 12 }
  y -= 16

  // ── Postentabelle ───────────────────────────────────────────────────────────
  const cQty = 322, cPrice = 400, cAmount = right
  page.drawRectangle({ x: M, y: y - 6, width: right - M, height: 22, color: DARK })
  text('BESCHREIBUNG', M + 8, y, 8.5, bold, WHITE, 0.5)
  tRight('MENGE', cQty + 24, y, 8.5, bold, WHITE)
  tRight('EINZELPREIS', cPrice + 28, y, 8.5, bold, WHITE)
  tRight('BETRAG', cAmount - 8, y, 8.5, bold, WHITE)
  y -= 24

  for (const it of d.items) {
    const lines = wrap(it.description, body, 9.5, cQty - M - 16)
    for (let i = 0; i < lines.length; i++) {
      text(lines[i], M + 8, y, 9.5, body, DARK)
      if (i === 0) {
        tRight(String(it.quantity), cQty + 24, y, 9.5, body, DARK)
        tRight(eur(it.unit_price_net), cPrice + 28, y, 9.5, body, DARK)
        tRight(eur(it.line_net), cAmount - 8, y, 9.5, bold, DARK)
      }
      y -= 14
    }
    y -= 4
    hr(y + 6)
  }
  y -= 12

  // ── Summen ──────────────────────────────────────────────────────────────────
  const sumL = 360
  const sumRow = (k: string, v: string, strong = false) => {
    text(k, sumL, y, strong ? 10.5 : 9.5, strong ? bold : body, strong ? DARK : GREY)
    tRight(v, right, y, strong ? 10.5 : 9.5, strong ? bold : body, DARK)
    y -= 16
  }
  sumRow('Zwischensumme (netto)', eur(d.subtotal_net))
  sumRow(d.eff.rate > 0 ? `MwSt ${d.eff.rate}%` : d.eff.label, eur(d.vat_amount))
  hr(y + 8, DARK, 1, sumL, right)
  y -= 2
  page.drawRectangle({ x: sumL - 6, y: y - 6, width: right - sumL + 6, height: 24, color: rgb(1, 0.96, 0.94) })
  text('Gesamtbetrag', sumL, y, 11, bold, DARK)
  tRight(eur(d.total_gross), right, y, 12, bold, CORAL)
  y -= 30

  // ── MwSt-Hinweis (Reverse-Charge / Drittland) ───────────────────────────────
  if (d.eff.note) {
    y -= 4
    for (const ln of wrap(d.eff.note, body, 8.5, right - M)) { text(ln, M, y, 8.5, body, GREY); y -= 11 }
    y -= 8
  }

  // ── Zahlungsblock ───────────────────────────────────────────────────────────
  y -= 6
  const boxTop = y
  const payLines: Array<[string, string]> = [
    ['Bank', String(I.bank_name ?? '')],
    ['IBAN', String(I.iban ?? '')],
    ['BIC', String(I.bic ?? '')],
    ['Intermediary BIC', String(I.intermediary_bic ?? '')],
    ['Verwendungszweck', d.invoiceNumber],
    ['Fällig bis', dDate(d.dueStr)],
  ].filter(([, v]) => v && v.trim())
  const boxH = 22 + payLines.length * 14
  page.drawRectangle({ x: M, y: boxTop - boxH + 14, width: right - M, height: boxH, borderColor: LINE, borderWidth: 1, color: rgb(0.985, 0.985, 0.99) })
  text('ZAHLUNG PER ÜBERWEISUNG', M + 12, boxTop, 8.5, bold, GOLD, 1.2)
  let py = boxTop - 18
  for (const [k, v] of payLines) {
    text(k, M + 12, py, 9, body, GREY)
    text(v, M + 150, py, 9, bold, DARK)
    py -= 14
  }
  y = boxTop - boxH

  // ── Fußzeile ────────────────────────────────────────────────────────────────
  const footY = 54
  hr(footY + 16, LINE, 0.8)
  const footLine = [I.legal_name, I.address_line1, `${I.postal_code ?? ''} ${I.city ?? ''}`, I.vat_number ? `VAT ${I.vat_number}` : '', I.reg_number ? `Reg. ${I.reg_number}` : '']
    .filter(s => s && String(s).trim()).join('  ·  ')
  const fw = body.widthOfTextAtSize(footLine, 7.5)
  text(footLine, (W - fw) / 2, footY, 7.5, body, GREY)

  return await pdf.save()
}

// Wort-Umbruch auf Pixelbreite
function wrap(s: string, font: PDFFont, size: number, maxW: number): string[] {
  const words = s.split(/\s+/)
  const out: string[] = []
  let cur = ''
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w
    if (font.widthOfTextAtSize(test, size) > maxW && cur) { out.push(cur); cur = w }
    else cur = test
  }
  if (cur) out.push(cur)
  return out.length ? out : ['']
}

function base64FromBytes(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}
