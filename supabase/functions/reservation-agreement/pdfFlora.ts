// Reservierungsvertrag Flora Panorama (Angebotsapartments), Aufbau und Wortlaut nach Aarons
// Vordruck vom 5.11.2026. Der Text steht in floraText.ts und wird hier nur gesetzt.
// Unterschriften: Kunde und zwei Direktoren getrennt (reservation_sign_parts), das Vertragsdatum
// kommt erst mit der letzten Unterschrift dazu.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'npm:pdf-lib@1.17.1'
import { safe, type AgreementFields, type TemplateRow } from './pdf.ts'
import { FLORA_PARAS, PURCHASER_EXEC, PURCHASER_IDENTITY, PURCHASER_TAIL, VENDOR_BLOCKS, type FloraRun } from './floraText.ts'

export interface FloraBuyer {
  key: string; salutation: string; name: string; nationality: string
  doc_label: string; doc_number: string; address: string; telephone: string; email: string
}
export interface FloraFields {
  buyers: FloraBuyer[]
  unit: string; type_label: string; fee_label: string; fee_amount: string; enclosed: string; covered: string
  net_price: number | null; title_deed: number | null
}
export interface FloraPart {
  side: 'buyer' | 'vendor'; key: string; name: string; png: Uint8Array; signedAtUtc: string
}
export interface FloraSignatures {
  parts: FloraPart[]
  seal?: Uint8Array | null
  /** Tag der letzten Unterschrift. Fehlt er, bleibt das Datum im Vertrag leer. */
  date?: Date | null
}
export interface VendorSigner { key: string; name: string }

const W = 595.28, H = 841.89
const X0 = 72, X1 = W - 72
const TOP = H - 76, BOTTOM = 72
const SIZE = 10, LEAD = 14.2, AFTER = 8
const DARK = rgb(0.13, 0.13, 0.15)
const ACCENT = rgb(0x40 / 255, 0x6e / 255, 0x7e / 255)
const RULE = rgb(0xbf / 255, 0xc9 / 255, 0xcc / 255)
const HEAD_GREY = rgb(0x70 / 255, 0x70 / 255, 0x70 / 255)
const FOOT_GREY = rgb(0x8a / 255, 0x8a / 255, 0x8a / 255)
const BLANK = '____________'

// ── Beträge ──────────────────────────────────────────────────────────────────
/** 60000 → €60.000,00 (Schreibweise des Vordrucks) */
export function euro(amount: number): string {
  const c = Math.round(amount * 100)
  const whole = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `€${whole},${String(c % 100).padStart(2, '0')}`
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
function under1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100
  const rest = r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? `-${ONES[r % 10]}` : '')
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' and ')
}
/** 150000 → „One Hundred and Fifty Thousand" (britisch, wie im Vordruck „Fifteen Thousand Euros") */
export function amountInWords(amount: number): string {
  const c = Math.round(amount * 100)
  const whole = Math.floor(c / 100), cents = c % 100
  const mio = Math.floor(whole / 1e6), th = Math.floor((whole % 1e6) / 1000), rest = whole % 1000
  const parts = [mio ? `${under1000(mio)} Million` : '', th ? `${under1000(th)} Thousand` : '']
  let out = parts.filter(Boolean).join(' ')
  if (rest) out += (out ? (rest < 100 ? ' and ' : ' ') : '') + under1000(rest)
  if (!out) out = 'Zero'
  return cents ? `${out} Euros and ${under1000(cents)} Cents` : `${out} Euros`
}

export interface FloraAmounts { a: number; b: number; c: number; d: number; e: number; f: number; g: number; delay: number }
/** Zahlungsplan laut Klausel 5, (f) ist der Rest, damit die Summe genau dem Preis entspricht. */
export function floraAmounts(net: number, titleDeed: number): FloraAmounts {
  const cents = Math.round(net * 100), gc = Math.round(titleDeed * 100)
  const pct = (p: number) => Math.round(cents * p / 100)
  const a = pct(40), b = pct(20), c = pct(20), d = pct(10), e = pct(5)
  const f = cents - a - b - c - d - e - gc
  return { a: a / 100, b: b / 100, c: c / 100, d: d / 100, e: e / 100, f: f / 100, g: gc / 100, delay: Math.round(net * 0.05 * 30 / 365 * 100) / 100 }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const ordinal = (d: number) => {
  const r = d % 100
  if (r >= 11 && r <= 13) return `${d}th`
  return `${d}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[d % 10] ?? 'th'}`
}
/** Kalendertag in Zypern: zählt für das Vertragsdatum */
export function cyprusDate(t: Date): { day: number; month: number; year: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Nicosia', day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(t).map(x => [x.type, x.value]))
  return { day: +p.day, month: +p.month, year: +p.year }
}

/** Werte der Platzhalter ohne Käuferdaten */
export function floraPlaceholders(fl: FloraFields, date?: Date | null): Record<string, string> {
  const amt = (v: number | null) => v == null ? `€${BLANK} plus VAT` : `${euro(v)} plus VAT`
  const am = fl.net_price != null && fl.title_deed != null ? floraAmounts(fl.net_price, fl.title_deed) : null
  const base = fl.net_price != null ? floraAmounts(fl.net_price, 0) : null
  const d = date ? cyprusDate(date) : null
  return {
    date_numeric: d ? `${String(d.day).padStart(2, '0')}/${String(d.month).padStart(2, '0')}/${d.year}` : BLANK,
    day_ordinal: d ? ordinal(d.day) : '_____',
    month_year: d ? `${MONTHS[d.month - 1]} ${d.year}` : BLANK,
    type: fl.type_label, unit: fl.unit, enclosed: fl.enclosed || '____', covered: fl.covered || '____', uncovered: '',
    amt_a: amt(base?.a ?? null), amt_b: amt(base?.b ?? null), amt_c: amt(base?.c ?? null), amt_d: amt(base?.d ?? null), amt_e: amt(base?.e ?? null),
    amt_f: amt(am?.f ?? null), amt_g: amt(am?.g ?? null),
    price_full: fl.net_price != null ? `${euro(fl.net_price)} plus VAT (${amountInWords(fl.net_price)}).` : `€${BLANK} plus VAT (${BLANK} Euros).`,
    delay: base ? euro(base.delay) : `€${BLANK}`,
    fee_amount: `€${fl.fee_amount}`, fee_label: fl.fee_label,
  }
}

function buyerValues(b: FloraBuyer): Record<string, string> {
  return {
    name: [b.salutation, b.name].filter(Boolean).join(' ') || BLANK,
    nationality: b.nationality || BLANK,
    doc: `${b.doc_label} No. ${b.doc_number || BLANK}`,
    address: b.address || BLANK, telephone: b.telephone || BLANK, email: b.email || BLANK,
  }
}

// ── Satz ─────────────────────────────────────────────────────────────────────
// Zeichen, die NFKD in safe() nicht auf den Grundbuchstaben zurückführt
const TRANSLIT: Record<string, string> = { 'ı': 'i', 'İ': 'I', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ø': 'o', 'Ø': 'O', 'æ': 'ae', 'Æ': 'AE', 'ħ': 'h', 'Ħ': 'H' }
const clean = (font: PDFFont, s: string) => safe(font, s.replace(/[ıİłŁđĐħĦ]/g, c => TRANSLIT[c] ?? c).replace(/\s+/g, ' '))
// Breite ohne Unterschneidung: pdf-lib misst mit Kerning, zeichnet aber ohne
const rawWidth = (font: PDFFont, s: string, size: number) => [...s].reduce((a, ch) => a + font.widthOfTextAtSize(ch, size), 0)

type Seg = { s: string; font: PDFFont; under?: boolean }
type Tok = Seg[]

export async function renderFlora(t: TemplateRow, f: AgreementFields, sign?: FloraSignatures): Promise<Uint8Array> {
  const fl = f.flora
  if (!fl) throw new Error('Flora-Daten fehlen')
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Reservation Agreement Flora Panorama ${fl.unit}`)
  pdf.setProducer('Happy Property CRM')
  const reg = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pages: PDFPage[] = []
  let page!: PDFPage
  let y = 0
  const newPage = () => { page = pdf.addPage([W, H]); pages.push(page); y = TOP }
  newPage()

  const fixed = floraPlaceholders(fl, sign?.date ?? null)
  const toTokens = (runs: FloraRun[], vals: Record<string, string>): Tok[] => {
    const out: Tok[] = []
    let cur: Tok = []
    for (const r of runs) {
      const font = r.b ? bold : reg
      const raw = r.ph ? (vals[r.ph] ?? '') : r.t
      for (const piece of raw.split(/(\s+)/)) {
        if (!piece) continue
        if (/^\s+$/.test(piece)) { if (cur.length) out.push(cur); cur = []; continue }
        cur.push({ s: clean(font, piece), font, under: !!r.u })
      }
    }
    if (cur.length) out.push(cur)
    return out
  }
  const tokW = (tok: Tok, size: number) => tok.reduce((a, s) => a + rawWidth(s.font, s.s, size), 0)
  const spaceW = (size: number) => rawWidth(reg, ' ', size)
  const breakLines = (toks: Tok[], width: number, size: number): Tok[][] => {
    const lines: Tok[][] = []
    let line: Tok[] = [], w = 0
    for (const tok of toks) {
      const tw = tokW(tok, size)
      if (line.length && w + spaceW(size) + tw > width) { lines.push(line); line = []; w = 0 }
      w += (line.length ? spaceW(size) : 0) + tw
      line.push(tok)
    }
    if (line.length) lines.push(line)
    return lines
  }
  const drawLine = (line: Tok[], x: number, width: number, size: number, justify: boolean, color: RGB) => {
    const sum = line.reduce((a, tok) => a + tokW(tok, size), 0)
    const gap = justify && line.length > 1 ? (width - sum) / (line.length - 1) : spaceW(size)
    let px = x
    for (const tok of line) {
      for (const seg of tok) {
        page.drawText(seg.s, { x: px, y, size, font: seg.font, color })
        const sw = rawWidth(seg.font, seg.s, size)
        if (seg.under) page.drawLine({ start: { x: px, y: y - 1.5 }, end: { x: px + sw, y: y - 1.5 }, thickness: 0.6, color })
        px += sw
      }
      px += gap
    }
  }
  /** Absatz setzen; Blocksatz außer in der letzten Zeile, zwei Zeilen bleiben zusammen (keine Waisen). */
  const para = (toks: Tok[], o: { left?: number; justify?: boolean; center?: boolean; lead?: number; after?: number; size?: number; color?: RGB; right?: number } = {}) => {
    const left = o.left ?? 0, size = o.size ?? SIZE, lead = o.lead ?? LEAD, color = o.color ?? DARK
    const x = X0 + left, width = X1 - (o.right ?? 0) - x
    const lines = breakLines(toks, width, size)
    if (y - lead * Math.min(2, lines.length) < BOTTOM) newPage()
    lines.forEach((line, i) => {
      if (y - lead < BOTTOM - 4) newPage()
      if (o.center) {
        const w = line.reduce((a, tok) => a + tokW(tok, size), 0) + spaceW(size) * (line.length - 1)
        drawLine(line, (W - w) / 2, w, size, false, color)
      } else drawLine(line, x, width, size, !!o.justify && i < lines.length - 1, color)
      y -= lead
    })
    y -= o.after ?? AFTER
  }
  const heading = (toks: Tok[]) => {
    if (y - 18 - 13 - 10 - LEAD * 3 < BOTTOM) newPage()
    y -= pages.length === 1 && y === TOP ? 0 : 10
    y -= 3
    for (const line of breakLines(toks, X1 - X0, 13)) { drawLine(line, X0, X1 - X0, 13, false, ACCENT); y -= 5 }
    page.drawLine({ start: { x: X0, y }, end: { x: X1, y }, thickness: 0.6, color: RULE })
    y -= 15
  }
  const label = (s: string, size: number, before: number, after: number) => {
    y -= before
    page.drawText(clean(bold, s), { x: X0, y, size, font: bold, color: ACCENT })
    y -= after
  }

  // ── Text ──
  for (const p of FLORA_PARAS) {
    switch (p.k) {
      case 'head': heading(toTokens(p.runs, fixed)); break
      case 'purchaser': {
        // Mehrere Käufer: Personenangaben je Käufer, die Schlussformel gilt für alle (Klausel 8.5)
        const list = fl.buyers.length ? fl.buyers : [{ key: 'b0', salutation: '', name: '', nationality: '', doc_label: 'Passport', doc_number: '', address: '', telephone: '', email: '' }]
        list.forEach((b, i) => {
          const last = i === list.length - 1
          const runs = last ? [...PURCHASER_IDENTITY, ...PURCHASER_TAIL] : [...PURCHASER_IDENTITY, { t: ', and' }]
          para(toTokens(runs, buyerValues(b)), { justify: true })
        })
        break
      }
      case 'alpha': {
        if (y - LEAD * 3 < BOTTOM) newPage()
        page.drawText('A.', { x: X0, y, size: SIZE, font: bold, color: DARK })
        para(toTokens(p.runs, fixed), { left: 21.3, justify: true, after: 4 })
        break
      }
      case 'plot': {
        if (y - LEAD < BOTTOM) newPage()
        page.drawText('•', { x: X0 + 21.3, y, size: SIZE, font: reg, color: DARK })
        para(toTokens(p.runs, fixed), { left: 36, justify: !!p.j, after: 2 })
        break
      }
      case 'bullet': {
        if (y - LEAD < BOTTOM) newPage()
        page.drawText('•', { x: X0, y, size: SIZE, font: reg, color: DARK })
        para(toTokens(p.runs, fixed), { left: 18, justify: !!p.j, after: 6, lead: 13.6 })
        break
      }
      case 'indent': y -= 4; para(toTokens(p.runs, fixed), { left: 21.3 }); break
      case 'sub': para(toTokens(p.runs, fixed), { left: 36, justify: !!p.j, after: 5, lead: 13.6 }); break
      case 'center': y -= 6; para(toTokens(p.runs, fixed), { center: true, after: 10 }); break
      default: {
        if (p.i === 2) y -= 2
        para(toTokens(p.runs, fixed), { justify: !!p.j, after: p.i === 1 ? 14 : AFTER })
      }
    }
  }
  // Sondervereinbarung aus dem CRM (Svens Eingabe, übersetzt): eigene Klausel, nichts wird umnummeriert
  if (f.special_terms) {
    para(toTokens([{ t: '8.10', b: 1 }, { t: ` ${f.special_terms}` }], fixed), { justify: true })
  }

  // ── Unterschriften ──
  const partOf = (side: FloraPart['side'], key: string) => sign?.parts.find(x => x.side === side && x.key === key)
  const fit = (img: { width: number; height: number }, bx: number, by: number, bw: number, bh: number) => {
    const sc = Math.min(bw / img.width, bh / img.height)
    return { x: bx, y: by + (bh - img.height * sc) / 2, width: img.width * sc, height: img.height * sc }
  }
  const lineW = X1 - 225 - X0
  const sigBlock = async (runs: FloraRun[], vals: Record<string, string>, part?: FloraPart, seal?: Uint8Array | null) => {
    const toks = toTokens(runs, vals)
    const lines = breakLines(toks, X1 - X0, SIZE)
    if (y - 46 - lines.length * 13.6 - 18 < BOTTOM) newPage()
    y -= 42
    if (part) {
      const img = await pdf.embedPng(part.png)
      page.drawImage(img, fit(img, X0, y + 2, lineW - 6, 40))
    }
    if (seal) {
      const img = await pdf.embedPng(seal)
      page.drawImage(img, fit(img, X0 + lineW + 28, y - 4, 118, 74))
    }
    page.drawLine({ start: { x: X0, y }, end: { x: X0 + lineW, y }, thickness: 0.6, color: DARK })
    y -= 15
    para(toks, { lead: 13.6, after: part ? 1 : 4 })
    if (part) {
      page.drawText(`Signed electronically ${part.signedAtUtc} via Happy Property`, { x: X0, y: y + 3, size: 6.5, font: reg, color: FOOT_GREY })
      y -= 9
    }
  }

  // Der ganze Unterschriftenteil (Überschriften, Direktoren, Käufer) steht auf EINER Seite.
  // Passt er nicht mehr unter den Text, beginnt er auf einer neuen Seite, die nur die Unterschriften trägt
  // (Sven 6.11.2026). Nur wenn er auch eine leere Seite sprengt, greift die alte Teilung je Block.
  const vendors = ((t.extra?.vendor_signers ?? []) as VendorSigner[])
  const finished = !!sign?.date
  const shownVendors = vendors.filter(v => !(finished && !partOf('vendor', v.key)))
  const sigHeight = (runs: FloraRun[], vals: Record<string, string>, part?: FloraPart) =>
    57 + breakLines(toTokens(runs, vals), X1 - X0, SIZE).length * 13.6 + (part ? 10 : 4) + 4
  const execNeed = 100
    + shownVendors.reduce((a, v) => a + sigHeight(VENDOR_BLOCKS[v.key] ?? [{ t: `${t.company_name} signed by ${v.name}` }], fixed, partOf('vendor', v.key)), 0)
    + 30 + fl.buyers.reduce((a, b) => a + sigHeight(PURCHASER_EXEC, buyerValues(b), partOf('buyer', b.key)), 0)
  const execOnOnePage = execNeed <= TOP - BOTTOM
  if (execOnOnePage ? y - execNeed < BOTTOM : y - 24 - 16 - 30 - 46 - 60 < BOTTOM) newPage()
  label('E X E C U T I O N', 12, 18, 18)
  label('THE PARTIES:', 12, 0, 18)
  label('THE VENDORS', 9, 0, 0)
  let sealLeft = sign?.seal ?? null
  for (const v of vendors) {
    const part = partOf('vendor', v.key)
    // Reicht laut Vorlage eine Direktoren-Unterschrift, fällt die leere Zeile im fertigen Vertrag weg
    if (finished && !part) continue
    await sigBlock(VENDOR_BLOCKS[v.key] ?? [{ t: `${t.company_name} signed by ${v.name}` }], fixed, part, part ? sealLeft : null)
    if (part) sealLeft = null
  }
  if (!execOnOnePage && y - 18 - 46 - 50 < BOTTOM) newPage()
  label('THE PROSPECTIVE PURCHASER', 9, 18, 0)
  for (const b of (fl.buyers.length ? fl.buyers : [])) await sigBlock(PURCHASER_EXEC, buyerValues(b), partOf('buyer', b.key))

  // ── Kopf und Fuß auf jeder Seite ──
  const spaced = (s: string) => [...s].join(' ')
  pages.forEach((pg, i) => {
    const size = 9
    const leftTxt = safe(reg, `${spaced('FLORA PANORAMA')}  ·  ${spaced('Apt.')}  ${fl.unit}`)
    pg.drawText(leftTxt, { x: X0, y: H - 46, size, font: reg, color: HEAD_GREY })
    const rt = 'Reservation Agreement'
    pg.drawText(rt, { x: X1 - rawWidth(reg, rt, size), y: H - 46, size, font: reg, color: HEAD_GREY })
    pg.drawLine({ start: { x: X0, y: H - 53 }, end: { x: X1, y: H - 53 }, thickness: 0.6, color: RULE })
    pg.drawLine({ start: { x: X0, y: 52 }, end: { x: X1, y: 52 }, thickness: 0.6, color: RULE })
    const ft = 'Compositiva Ltd  ·  HE 468914  ·  Paphos, Cyprus'
    pg.drawText(safe(reg, ft), { x: X0, y: 40, size, font: reg, color: FOOT_GREY })
    const pn = `Page ${i + 1} / ${pages.length}`
    pg.drawText(pn, { x: X1 - rawWidth(reg, pn, size), y: 40, size, font: reg, color: FOOT_GREY })
  })
  return await pdf.save()
}
