// Reservierungsvertrag als PDF, Aufbau wie der Papier-Vordruck des Bauträgers
// (Vorlage: Mito-Vordruck „Reservation agreement"). Unterschriften und Stempel
// bleiben leer, die setzt der Bauträger bzw. der Käufer.
// Bauträger mit eigenem Vordruck: reservation_templates.layout (z. B. 'pafilia' → pdfPafilia.ts).
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'npm:pdf-lib@1.17.1'
import { renderPafilia } from './pdfPafilia.ts'

export interface TemplateRow {
  logo_text: string | null
  company_name: string
  title: string
  accent_color: string
  company_address: string | null
  company_tel: string | null
  bank: { account_name?: string; account_number?: string; iban?: string; swift?: string; bank_name?: string }
  notes: string | null
  /** Vordruck: leer/'mito' = Mito-Aufbau, 'pafilia' = Pafilia/Minthis-Aufbau */
  layout?: string | null
  /** Zusatzfelder einzelner Vordrucke (Pafilia: Registernummer, Zahlungs- und Reservierungsfrist) */
  extra?: { registration_no?: string; payment_term?: string; reservation_term?: string; price_note?: string } | null
}

export type PropertyKind = 'villa' | 'townhouse' | 'apartment'

/** Digitale Unterschrift des Bauträgers (Touch-Unterschrift + Name in Druckbuchstaben). */
export interface SellerSignature {
  png: Uint8Array          // Unterschrift vom Handy (transparentes PNG)
  name: string             // Druckbuchstaben
  place: string            // vom System gesetzt
  date: string             // vom System gesetzt, dd/mm/yyyy
  signedAtUtc: string      // für den Prüfvermerk
  seal?: Uint8Array | null // Firmenstempel (transparentes PNG), wenn der Bauträger „mit Stempel" wählt
}

export interface AgreementFields {
  date: string              // 15/10/2026
  property_name: string     // MITO MAMBA
  address: string
  unit_number: string
  purchasers: string[]      // ANDREAS ILIC
  id_numbers: string[]      // gleiche Reihenfolge wie purchasers
  property_kind: PropertyKind
  price_text: string        // EUR 634,800 + VAT
  deposit_text: string      // EUR 20,000 + 19% VAT = EUR 23,800
  id_types?: string[]       // passport | id_card | other, gleiche Reihenfolge wie purchasers
}

const W = 595.28, H = 841.89
const X0 = 45, X1 = W - 45
const MID = X0 + (X1 - X0) * 0.465
const PAD = 7
const DARK = rgb(0.2, 0.2, 0.22)
const LINE = rgb(0.25, 0.25, 0.28)

export function hexColor(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0xe3874a
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/** Nur Zeichen, die die Standardschrift kann (Namen aus dem Pass sind ohnehin lateinisch). */
export function safe(font: PDFFont, s: string): string {
  let out = ''
  for (const ch of s) {
    try { font.encodeText(ch); out += ch; continue } catch { /* weiter */ }
    // NFKD zerlegt auch Ligaturen (ﬁ → fi), dann Akzente weg
    const base = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    try { font.encodeText(base); out += base } catch { out += '?' }
  }
  return out
}

export function wrap(font: PDFFont, size: number, text: string, width: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) { lines.push(''); continue }
    let cur = ''
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w
      if (font.widthOfTextAtSize(next, size) <= width) cur = next
      else { if (cur) lines.push(cur); cur = w }
    }
    if (cur) lines.push(cur)
  }
  return lines
}

/**
 * Eine A4-Seite. Passt der Inhalt nicht (z. B. 3+ Käufer), wird kompakter gesetzt; passt es
 * dann immer noch nicht, wirft die Funktion, statt Zeilen über den Seitenrand zu schreiben.
 */
export async function renderAgreement(t: TemplateRow, f: AgreementFields, seller?: SellerSignature): Promise<Uint8Array> {
  if (t.layout === 'pafilia') return await renderPafilia(t, f, seller)
  const normal = await renderOnce(t, f, seller, false)
  if (normal.bottom >= 24) return normal.bytes
  const compact = await renderOnce(t, f, seller, true)
  if (compact.bottom >= 12) return compact.bytes
  throw new Error('Zu viele Käufer für eine Vertragsseite, bitte von Hand anlegen')
}

async function renderOnce(t: TemplateRow, f: AgreementFields, seller: SellerSignature | undefined, compact: boolean): Promise<{ bytes: Uint8Array; bottom: number }> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`${t.title} ${f.property_name} ${f.unit_number}`)
  pdf.setProducer('Happy Property CRM')
  const page: PDFPage = pdf.addPage([W, H])
  const reg = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const accent = hexColor(t.accent_color)

  // maxW: zu lange Werte (Adresse, Bankname) werden kleiner gesetzt statt über den Rand zu laufen
  const text = (s: string, x: number, y: number, size: number, font = reg, color = DARK, maxW = 0) => {
    const v = safe(font, s)
    let sz = size
    while (maxW && sz > 6.5 && font.widthOfTextAtSize(v, sz) > maxW) sz -= 0.25
    page.drawText(v, { x, y, size: sz, font, color })
  }
  const centered = (s: string, y: number, size: number, font = reg, color = DARK) => {
    const v = safe(font, s)
    page.drawText(v, { x: (W - font.widthOfTextAtSize(v, size)) / 2, y, size, font, color })
  }
  const rect = (x: number, yTop: number, w: number, h: number) =>
    page.drawRectangle({ x, y: yTop - h, width: w, height: h, borderColor: LINE, borderWidth: 0.8 })

  // ── Kopf ──
  let y = H - 62
  if (t.logo_text) text(t.logo_text.split('').join(' '), X0 + 6, y + 2, 17, reg, accent)
  centered(t.company_name, y, 24, bold, accent)
  y -= 34
  centered(t.title, y, 15)
  y -= 30
  text('Date:', X0 + 2, y, 9)
  text(f.date, X0 + 34, y, 9)
  y -= 12

  // ── Tabelle ──
  const LS = compact ? 8.8 : 9.5, LH = compact ? 12.5 : 15
  const row = (label: string, values: string[], minH = compact ? 24 : 30) => {
    const h = Math.max(minH, PAD * 2 + values.length * LH)
    rect(X0, y, MID - X0, h)
    rect(MID, y, X1 - MID, h)
    text(label, X0 + PAD, y - PAD - LS + 1, LS)
    values.forEach((v, i) => text(v, MID + PAD, y - PAD - LS + 1 - i * LH, LS, reg, DARK, X1 - MID - PAD * 2))
    y -= h
  }
  row('Property Name:', [f.property_name])
  row('Address:', [f.address])
  row('Property UNIT Number:', [f.unit_number])
  row('Purchaser’s Name:', f.purchasers.length ? f.purchasers : [''])
  row('Purchaser’s ID Number/Passport No:', f.id_numbers.length ? f.id_numbers : [''])

  // Objektart (Ankreuzfelder über die ganze Breite)
  {
    const h = 26
    rect(X0, y, X1 - X0, h)
    const boxes: Array<[PropertyKind, string, number]> = [
      ['villa', 'Villa and Land', X0 + PAD],
      ['townhouse', 'Townhouse and land', X0 + 170],
      ['apartment', 'Apartment', X0 + 325],
    ]
    for (const [kind, label, x] of boxes) {
      const by = y - 17
      page.drawRectangle({ x, y: by, width: 8, height: 8, borderColor: LINE, borderWidth: 0.8 })
      if (kind === f.property_kind) {
        page.drawLine({ start: { x: x + 1.5, y: by + 1.5 }, end: { x: x + 6.5, y: by + 6.5 }, thickness: 1, color: DARK })
        page.drawLine({ start: { x: x + 1.5, y: by + 6.5 }, end: { x: x + 6.5, y: by + 1.5 }, thickness: 1, color: DARK })
      }
      text(label, x + 13, by + 0.5, LS)
    }
    y -= h
  }
  row('Purchasing price:', [f.price_text], compact ? 22 : 26)
  row('Holding Deposit:', [f.deposit_text], compact ? 22 : 26)

  // Bedingungen
  {
    const NS = compact ? 7.6 : 8.6, NL = compact ? 10.6 : 12.6
    // safe() vor dem Messen: Ligaturen wie „ﬁ" aus kopierten Texten würden sonst werfen
    const notes = (t.notes ?? '').replace(/\n\s*\n/g, '\n').split('\n').map(l => safe(reg, l)).join('\n')
    const lines = wrap(reg, NS, notes, X1 - X0 - PAD * 2)
    const h = Math.max(compact ? 90 : 150, PAD * 2 + LH + lines.length * NL + 10)
    rect(X0, y, X1 - X0, h)
    text('Notes:', X0 + PAD, y - PAD - LS + 1, LS)
    lines.forEach((l, i) => text(l, X0 + PAD, y - PAD - LS - LH - i * NL + 1, NS))
    y -= h
  }

  // Bankverbindung
  {
    const b = t.bank ?? {}
    const lines: Array<[string, string]> = [
      ['Account Name:', b.account_name ?? ''], ['Account Number:', b.account_number ?? ''],
      ['IBAN:', b.iban ?? ''], ['SWIFT:', b.swift ?? ''], ['Bank Name:', b.bank_name ?? ''],
    ]
    const h = PAD * 2 + lines.length * LH + 2
    rect(X0, y, MID - X0, h)
    rect(MID, y, X1 - MID, h)
    text('Euro Deposit account:', X0 + PAD, y - PAD - LS + 1, LS)
    lines.forEach(([k, v], i) => {
      const yy = y - PAD - LS + 1 - i * LH
      text(k, MID + PAD, yy, LS)
      text(v, MID + PAD + 80, yy, LS, reg, DARK, X1 - MID - PAD * 2 - 80)
    })
    y -= h
  }

  // Stempel + Unterschriften
  {
    const h = compact ? 112 : 125
    rect(X0, y, MID - X0, h)
    rect(MID, y, X1 - MID, h)
    text('Seal:', X0 + PAD, y - PAD - LS + 1, LS)
    text('Buyer Signed BY:', MID + PAD, y - PAD - LS + 1, LS)
    if (seller) {
      // Verkäufer-Zelle: links der Stempel (optional), rechts daneben die Unterschrift,
      // darunter Name, Ort/Datum und Prüfvermerk
      const fit = (img: { width: number; height: number }, bx: number, by: number, bw: number, bh: number) => {
        const sc = Math.min(bw / img.width, bh / img.height)
        return { x: bx + (bw - img.width * sc) / 2, y: by + (bh - img.height * sc) / 2, width: img.width * sc, height: img.height * sc }
      }
      const boxY = y - h + PAD + 44, boxH = 58
      let sigX = X0 + PAD + 60
      if (seller.seal) {
        const sealImg = await pdf.embedPng(seller.seal)
        page.drawImage(sealImg, fit(sealImg, X0 + PAD + 22, boxY, 70, boxH))
        sigX = X0 + PAD + 100
      }
      const img = await pdf.embedPng(seller.png)
      page.drawImage(img, fit(img, sigX, boxY, MID - PAD - sigX, 52))
      const cellW = MID - X0 - PAD * 2
      text(`Sales Signed BY: ${seller.name}`, X0 + PAD, y - h + PAD + 30, LS, bold, DARK, cellW)
      text(`Place, date: ${seller.place}, ${seller.date}`, X0 + PAD, y - h + PAD + 17, 8.5, reg, DARK, cellW)
      text(`Signed electronically ${seller.signedAtUtc} via Happy Property`, X0 + PAD, y - h + PAD + 4, 6.5, reg, rgb(0.45, 0.45, 0.5), cellW)
    } else {
      text('Sales Signed BY:', X0 + PAD, y - h + PAD + 2, LS)
    }
    y -= h
  }

  const fullRow = (label: string, value: string) => {
    const h = 22
    rect(X0, y, X1 - X0, h)
    text(label, X0 + PAD, y - PAD - LS + 2, LS)
    text(value, X0 + 150, y - PAD - LS + 2, LS, reg, DARK, X1 - X0 - 150 - PAD)
    y -= h
  }
  fullRow('Company Address:', t.company_address ?? '')
  fullRow('Company TEL:', t.company_tel ?? '')

  y -= compact ? 16 : 22
  centered(t.company_name, y, 11, bold, accent)

  return { bytes: await pdf.save(), bottom: y }
}
