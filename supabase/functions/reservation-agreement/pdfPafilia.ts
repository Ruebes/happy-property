// Reservierungsvertrag im Aufbau des Pafilia-Vordrucks (Sven 23.10.2026, Vorlage
// „reservation Pafilia.pdf", Minthis Lofos B7-102): Kopf MINTHIS, Tabelle
// DATE / DEVELOPER / PROSPECTIVE PURCHASER(S) / PROJECT / PROPERTY / Preise / Fristen,
// danach die nummerierten TERMS & CONDITIONS (aus notes) und die Unterschriften
// THE DEVELOPER / THE PROSPECTIVE PURCHASER. Läuft über so viele Seiten wie nötig.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'npm:pdf-lib@1.17.1'
import { safe, wrap, hexColor, type AgreementFields, type PropertyKind, type SellerSignature, type TemplateRow } from './pdf.ts'

const W = 595.28, H = 841.89
const X0 = 62, X1 = W - 62
const LABEL_W = (X1 - X0) * 0.36
const PAD = 6
const BOTTOM = 72
const DARK = rgb(0.1, 0.1, 0.12)
const GREY = rgb(0.45, 0.45, 0.5)
const LINE = rgb(0.3, 0.3, 0.32)

/** „B7/102" → „APARTMENT BLOCK B7-102", „Villa 11" → „VILLA 11", „R15" → „RESIDENCE R15" (wie im Vordruck). */
export function pafiliaProperty(kind: PropertyKind, unit: string): string {
  const u = unit.replace(/\s+/g, ' ').trim().toUpperCase()
  if (/^(VILLA|RESIDENCE|APARTMENT|TOWNHOUSE)\b/.test(u)) return u
  if (kind === 'apartment') {
    const m = /^B\s*(\d+)\s*[/.\- ]\s*(\d+)$/.exec(u)
    return m ? `APARTMENT BLOCK B${m[1]}-${m[2]}` : `APARTMENT ${u}`
  }
  if (/^R\d+$/.test(u)) return `RESIDENCE ${u}`
  return `${kind === 'villa' ? 'VILLA' : 'TOWNHOUSE'} ${u}`
}

const idLabel = (type: string | undefined) => type === 'id_card' ? 'ID Card No:' : 'Passport No:'
// Breite ohne Unterschneidung: pdf-lib misst mit Kerning, zeichnet aber ohne (sonst überlappen Textteile)
const rawWidth = (font: PDFFont, s: string, size: number) => [...s].reduce((a, ch) => a + font.widthOfTextAtSize(ch, size), 0)

export async function renderPafilia(t: TemplateRow, f: AgreementFields, seller?: SellerSignature): Promise<Uint8Array> {
  const x: NonNullable<TemplateRow['extra']> = t.extra ?? {}
  const pdf = await PDFDocument.create()
  pdf.setTitle(`${t.title} ${f.property_name} ${f.unit_number}`)
  pdf.setProducer('Happy Property CRM')
  const reg = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const accent = hexColor(t.accent_color)
  const pages: PDFPage[] = []
  let page!: PDFPage
  let y = 0

  const text = (s: string, px: number, py: number, size: number, font: PDFFont = reg, color = DARK, maxW = 0) => {
    const v = safe(font, s)
    let sz = size
    while (maxW && sz > 6.5 && font.widthOfTextAtSize(v, sz) > maxW) sz -= 0.25
    page.drawText(v, { x: px, y: py, size: sz, font, color })
    return rawWidth(font, v, sz)
  }
  const centered = (s: string, py: number, size: number, font: PDFFont = reg) => {
    const v = safe(font, s)
    const w = font.widthOfTextAtSize(v, size)
    page.drawText(v, { x: (W - w) / 2, y: py, size, font, color: DARK })
    return { x: (W - w) / 2, w }
  }
  const newPage = () => {
    page = pdf.addPage([W, H])
    pages.push(page)
    // Wortmarke mit weitem Buchstabenabstand wie im Vordruck
    const logo = safe(reg, (t.logo_text ?? '').toUpperCase())
    if (logo) {
      const size = 27, gap = 7
      const total = [...logo].reduce((s, ch) => s + reg.widthOfTextAtSize(ch, size), 0) + gap * (logo.length - 1)
      let lx = (W - total) / 2
      for (const ch of logo) {
        page.drawText(ch, { x: lx, y: H - 66, size, font: reg, color: accent })
        lx += reg.widthOfTextAtSize(ch, size) + gap
      }
    }
    y = H - 100
  }
  newPage()

  // ── Titel ──
  y -= 12
  const ttl = centered(t.title.toUpperCase(), y, 10.5, bold)
  page.drawLine({ start: { x: ttl.x, y: y - 2 }, end: { x: ttl.x + ttl.w, y: y - 2 }, thickness: 0.7, color: DARK })
  y -= 14

  // ── Tabelle ──
  const LS = 9.6, LH = 14
  const valueW = X1 - X0 - LABEL_W - PAD * 2
  type Part = { s: string; bold?: boolean }
  const row = (label: string, lines: Array<string | Part[]>) => {
    const h = PAD * 2 + Math.max(1, lines.length) * LH - 3
    page.drawRectangle({ x: X0, y: y - h, width: LABEL_W, height: h, borderColor: LINE, borderWidth: 0.7 })
    page.drawRectangle({ x: X0 + LABEL_W, y: y - h, width: X1 - X0 - LABEL_W, height: h, borderColor: LINE, borderWidth: 0.7 })
    label.split('\n').forEach((l, i) => text(l, X0 + PAD, y - PAD - LS + 1 - i * LH, LS, bold))
    lines.forEach((ln, i) => {
      const yy = y - PAD - LS + 1 - i * LH
      const parts: Part[] = typeof ln === 'string' ? [{ s: ln }] : ln
      // Zu lange Zeile: gemeinsam kleiner setzen statt über den Rand zu laufen
      let sz = LS
      const width = (size: number) => parts.reduce((s, p) => s + rawWidth(p.bold ? bold : reg, safe(p.bold ? bold : reg, p.s), size), 0)
      while (sz > 6.5 && width(sz) > valueW) sz -= 0.25
      let px = X0 + LABEL_W + PAD
      for (const p of parts) px += text(p.s, px, yy, sz, p.bold ? bold : reg)
    })
    y -= h
  }

  row('DATE:', [f.date])
  row('DEVELOPER:', [
    [{ s: t.company_name, bold: true }, { s: x.registration_no ? `, Registration No.${x.registration_no}` : '' }],
    ...(t.company_address ? [`Address: ${t.company_address}`] : []),
  ])
  {
    const lines: string[] = []
    const names = f.purchasers.length ? f.purchasers : ['']
    names.forEach((n, i) => {
      if (i) lines.push('')
      lines.push(`Name : ${n}`, `${idLabel(f.id_types?.[i])} ${f.id_numbers[i] ?? ''}`)
    })
    row('PROSPECTIVE\nPURCHASER(S):', lines)
  }
  row('PROJECT:', [f.property_name])
  row('PROPERTY:', [pafiliaProperty(f.property_kind, f.unit_number)])
  row('AGREED PURCHASE PRICE:', [f.price_text, ...(x.price_note ? [`*${x.price_note}`] : [])])
  row('RESERVATION DEPOSIT:', [f.deposit_text])
  if (x.payment_term) row('PAYMENT TERM:', [x.payment_term])
  if (x.reservation_term) row('RESERVATION TERM:', [x.reservation_term])
  // Sondervereinbarung (Svens Eingabe bei der Reservierung, übersetzt): umbrechen statt verkleinern
  if (f.special_terms) row('SPECIAL AGREEMENTS:', wrap(reg, LS, safe(reg, f.special_terms), valueW))

  // ── Bedingungen: „1. …" je Absatz, hängender Einzug, Blocksatz ──
  y -= 24
  centered('TERMS & CONDITIONS', y, 10, bold)
  y -= 22
  const NS = 10, NL = 13.4, NUM_X = X0, TXT_X = X0 + 20
  const paras = (t.notes ?? '').split(/\n\s*\n|\n(?=\s*\d+\.\s)/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
  for (const p of paras) {
    const m = /^(\d+\.)\s*(.*)$/.exec(p)
    const num = m ? m[1] : ''
    const body = safe(reg, m ? m[2] : p)
    const lines = wrap(reg, NS, body, X1 - TXT_X)
    lines.forEach((l, i) => {
      if (y - NL < BOTTOM) newPage()
      if (i === 0 && num) text(num, NUM_X, y, NS)
      const words = l.split(' ')
      const last = i === lines.length - 1
      if (last || words.length < 2) text(l, TXT_X, y, NS)
      else {
        const sum = words.reduce((s, w) => s + rawWidth(reg, w, NS), 0)
        const gap = (X1 - TXT_X - sum) / (words.length - 1)
        let px = TXT_X
        for (const w of words) { page.drawText(w, { x: px, y, size: NS, font: reg, color: DARK }); px += rawWidth(reg, w, NS) + gap }
      }
      y -= NL
    })
    y -= 8
  }

  // ── Unterschriften ──
  const buyers = f.purchasers.length ? f.purchasers : ['']
  const leftH = 150
  const rightH = 62 + buyers.length * 48
  if (y - 24 - Math.max(leftH, rightH) < BOTTOM) newPage()
  y -= 24
  const LX = X0 + 14, RX = X0 + (X1 - X0) * 0.53
  const lineW = 190
  text('THE DEVELOPER', LX, y, 10, bold)
  text('THE PROSPECTIVE PURCHASER', RX, y, 10, bold)
  const dotted = (px: number, py: number) => text('.'.repeat(64), px, py, 9, reg, DARK, lineW)
  const sigLineY = y - 58
  if (seller) {
    const fit = (img: { width: number; height: number }, bx: number, by: number, bw: number, bh: number) => {
      const sc = Math.min(bw / img.width, bh / img.height)
      return { x: bx + (bw - img.width * sc) / 2, y: by + (bh - img.height * sc) / 2, width: img.width * sc, height: img.height * sc }
    }
    if (seller.seal) {
      const sealImg = await pdf.embedPng(seller.seal)
      page.drawImage(sealImg, fit(sealImg, LX + 120, sigLineY - 30, 80, 74))
    }
    const img = await pdf.embedPng(seller.png)
    page.drawImage(img, fit(img, LX, sigLineY + 3, 140, 44))
  }
  dotted(LX, sigLineY)
  text(t.company_name, LX, sigLineY - 16, 9.5, bold, DARK, lineW + 20)
  if (seller) {
    text(`Signed by: ${seller.name}`, LX, sigLineY - 32, 9, reg, DARK, lineW + 20)
    text(`Place, date: ${seller.place}, ${seller.date}`, LX, sigLineY - 45, 8.5, reg, DARK, lineW + 20)
    text(`Signed electronically ${seller.signedAtUtc} via Happy Property`, LX, sigLineY - 57, 6.5, reg, GREY, lineW + 20)
  }
  buyers.forEach((n, i) => {
    const ly = sigLineY - i * 48
    dotted(RX, ly)
    text(n, RX, ly - 16, 9.5, reg, DARK, X1 - RX)
  })

  // Seitenzahlen unten rechts wie im Vordruck
  pages.forEach((pg, i) => {
    const s = String(i + 1)
    pg.drawText(s, { x: X1 - reg.widthOfTextAtSize(s, 10), y: 40, size: 10, font: reg, color: DARK })
  })
  return await pdf.save()
}
