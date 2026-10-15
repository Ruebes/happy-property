// Mehrseitige Dokumente (zuerst Spezifikationen) digital unterschreiben (Sven 15.10.2026):
// Unterschrift, Name in Druckbuchstaben und Datum auf JEDER Seite (Fußband unten rechts) und
// im Unterschriftsfeld des Bauträgers, optional der Firmenstempel im Stempelkasten.
//
// Das Unterschriftsfeld wird über die Beschriftungen im PDF gefunden (unpdf = pdf.js ohne
// Worker). Unsere Spezifikationen haben zwei Layouts:
//   englisch  „SIGNATURE · PLACE, DATE" UNTER der Linie, Kasten „COMPANY STAMP"
//   deutsch   „ORT, DATUM" + „UNTERSCHRIFT & POSITION" ÜBER der Linie, Kasten „FIRMEN-STEMPEL"
// Die Beschriftungen sind gesperrt gesetzt („C O M PA N Y"), deshalb wird zeilenweise ohne
// Leerzeichen verglichen. Findet sich kein Feld, kommt eine Unterschriftsseite ans Ende.
import { getDocumentProxy } from 'npm:unpdf@0.12.1'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'npm:pdf-lib@1.17.1'

export interface DocSigner {
  png: Uint8Array        // Finger-Unterschrift (transparentes PNG)
  name: string           // Druckbuchstaben
  role: string | null    // z. B. Sales
  company: string
  place: string
  signedAtUtc: string    // Prüfvermerk
}

interface Line { y: number; x0: number; x1: number; h: number; text: string; norm: string }

const DARK = rgb(0.16, 0.17, 0.2)
const GREY = rgb(0.45, 0.45, 0.5)

function safe(font: PDFFont, s: string): string {
  let out = ''
  for (const ch of s) {
    try { font.encodeText(ch); out += ch; continue } catch { /* weiter */ }
    // NFKD zerlegt auch Ligaturen (ﬁ → fi), dann Akzente weg
    const base = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    try { font.encodeText(base); out += base } catch { out += '?' }
  }
  return out
}

/** Textzeilen einer Seite (pdf.js-Koordinaten, Ursprung unten links). */
async function pageLines(proxy: { getPage(n: number): Promise<unknown> }, pageNo: number): Promise<Line[]> {
  const page = await proxy.getPage(pageNo) as { getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }> }> }
  const tc = await page.getTextContent()
  const items = tc.items
    .filter(it => it.str && it.str.trim() && it.transform)
    .map(it => ({ s: it.str!, x: it.transform![4], y: it.transform![5], w: it.width ?? 0, h: it.height ?? 0 }))
    .sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Array<{ y: number; x0: number; x1: number; h: number; parts: typeof items }> = []
  for (const it of items) {
    const l = lines.find(l => Math.abs(l.y - it.y) < 1.5 && it.x - l.x1 < 30 && it.x >= l.x0 - 1)
    if (l) { l.parts.push(it); l.x1 = Math.max(l.x1, it.x + it.w); l.h = Math.max(l.h, it.h) }
    else lines.push({ y: it.y, x0: it.x, x1: it.x + it.w, h: it.h, parts: [it] })
  }
  return lines.map(l => {
    const text = l.parts.sort((a, b) => a.x - b.x).map(p => p.s).join('')
    return { y: l.y, x0: l.x0, x1: l.x1, h: l.h, text, norm: text.toUpperCase().replace(/\s+/g, '') }
  })
}

interface Field {
  page: number                                     // 0-basiert
  sig: Line                                        // Unterschriftsbeschriftung
  date: Line | null                                // eigene Datumsbeschriftung (deutsches Layout)
  combined: boolean                                // „SIGNATURE · PLACE, DATE" (Beschriftung unter der Linie)
  stamp: { x: number; y: number } | null           // Mitte des Stempelkastens
  lang: 'de' | 'en'
}

const isSig = (l: Line) => l.norm.length <= 40 && /SIGNATURE|UNTERSCHRIFT/.test(l.norm)
const isStampWord = (l: Line) => l.norm.length <= 16 && /^(COMPANY|STAMP|FIRMEN-?|STEMPEL|SEAL|COMPANYSTAMP|FIRMENSTEMPEL)$/.test(l.norm)

async function findField(bytes: Uint8Array): Promise<Field | null> {
  const proxy = await getDocumentProxy(bytes.slice())
  const n = (proxy as unknown as { numPages: number }).numPages
  for (let p = n; p >= Math.max(1, n - 2); p--) {
    const lines = await pageLines(proxy as unknown as { getPage(n: number): Promise<unknown> }, p)
    const sigs = lines.filter(isSig)
    if (!sigs.length) continue
    const stampWords = lines.filter(isStampWord)
    let stamp: Field['stamp'] = null
    if (stampWords.length) {
      const first = stampWords[0]
      const cluster = stampWords.filter(l => Math.abs(l.y - first.y) < 40 && Math.abs(l.x0 - first.x0) < 40)
      stamp = {
        x: cluster.reduce((s, l) => s + (l.x0 + l.x1) / 2, 0) / cluster.length,
        y: cluster.reduce((s, l) => s + l.y + l.h / 2, 0) / cluster.length - 4,
      }
    }
    // mehrere Unterschriftsfelder: das nächste am Stempelkasten (= Bauträger), sonst das unterste
    const sig = stamp
      ? sigs.slice().sort((a, b) => Math.hypot(a.x0 - stamp!.x, a.y - stamp!.y) - Math.hypot(b.x0 - stamp!.x, b.y - stamp!.y))[0]
      : sigs.slice().sort((a, b) => a.y - b.y)[0]
    const combined = /PLACE,DATE|ORT,DATUM/.test(sig.norm)
    const date = combined ? null : lines
      .filter(l => l !== sig && l.norm.length <= 30 && /ORT,DATUM|PLACE,DATE|^DATUM$|^DATE$/.test(l.norm) && Math.abs(l.y - sig.y) < 6)
      .sort((a, b) => Math.abs(a.x0 - sig.x0) - Math.abs(b.x0 - sig.x0))[0] ?? null
    const lang = /UNTERSCHRIFT|ORT,DATUM|STEMPEL/.test(sig.norm + (date?.norm ?? '') + stampWords.map(l => l.norm).join('')) ? 'de' : 'en'
    return { page: p - 1, sig, date, combined, stamp, lang }
  }
  return null
}

function dateFor(lang: 'de' | 'en'): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Nicosia', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date())
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return lang === 'de' ? `${g('day')}.${g('month')}.${g('year')}` : `${g('day')}/${g('month')}/${g('year')}`
}

function drawFit(page: PDFPage, img: PDFImage, x: number, y: number, w: number, h: number, align: 'left' | 'center' = 'left') {
  const sc = Math.min(w / img.width, h / img.height)
  const dw = img.width * sc, dh = img.height * sc
  page.drawImage(img, { x: align === 'center' ? x + (w - dw) / 2 : x, y: y + (h - dh) / 2, width: dw, height: dh })
}

export async function stampDocument(src: Uint8Array, s: DocSigner, seal: Uint8Array | null): Promise<{ pdf: Uint8Array; placement: 'field' | 'appended'; lang: 'de' | 'en' }> {
  const field = await findField(src).catch(e => { console.warn('[stamp] Feldsuche', (e as Error).message); return null })
  const lang = field?.lang ?? 'en'
  const date = dateFor(lang)
  const doc = await PDFDocument.load(src, { ignoreEncryption: true })
  if (doc.isEncrypted) throw new Error('PDF ist geschützt und kann nicht unterschrieben werden')
  const reg = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const sig = await doc.embedPng(s.png)
  const sealImg = seal ? await doc.embedPng(seal) : null
  const who = s.role ? `${s.name} (${s.role})` : s.name
  const place = lang === 'de' ? s.place.replace(/\bCyprus\b/g, 'Zypern') : s.place.replace(/\bZypern\b/g, 'Cyprus')
  const placeDate = `${place}, ${date}`
  const note = lang === 'de' ? `Elektronisch unterschrieben ${s.signedAtUtc} über Happy Property` : `Signed electronically ${s.signedAtUtc} via Happy Property`

  // 1. Fußband auf jeder Seite: kleine Unterschrift + Name + Ort/Datum, unten rechts
  for (const page of doc.getPages()) {
    // Gedrehte Seiten (Querformat-Scans) bekommen kein Band, es stünde sonst seitlich
    if (page.getRotation().angle % 360 !== 0) continue
    const box = page.getCropBox()
    const t1 = safe(bold, `${s.name} · ${s.company}`), t2 = safe(reg, placeDate)
    const tw = Math.max(bold.widthOfTextAtSize(t1, 6.5), reg.widthOfTextAtSize(t2, 6))
    const right = box.x + box.width - 45, base = box.y
    // heller Untergrund, damit das Band auch auf dunklen Seiten (Titelblatt) lesbar ist
    page.drawRectangle({ x: right - tw - 82, y: base + 3, width: tw + 88, height: 30, color: rgb(1, 1, 1), opacity: 0.9 })
    page.drawText(t1, { x: right - bold.widthOfTextAtSize(t1, 6.5), y: base + 19, size: 6.5, font: bold, color: DARK })
    page.drawText(t2, { x: right - reg.widthOfTextAtSize(t2, 6), y: base + 10, size: 6, font: reg, color: GREY })
    drawFit(page, sig, right - tw - 76, base + 6, 70, 24)
  }

  // 2. Unterschriftsfeld des Bauträgers
  if (field) {
    const page = doc.getPage(field.page)
    const L = field.sig
    if (field.combined) {
      // Beschriftung UNTER der Linie: Unterschrift über die Linie, Name + Ort/Datum darunter
      const maxW = field.stamp ? Math.max(90, field.stamp.x - 42 - L.x0) : 150
      drawFit(page, sig, L.x0, L.y + 14, Math.min(maxW, 160), 34)
      page.drawText(safe(bold, who), { x: L.x0, y: L.y - 10, size: 7.5, font: bold, color: DARK })
      page.drawText(safe(reg, placeDate), { x: L.x0, y: L.y - 19, size: 7, font: reg, color: DARK })
      page.drawText(safe(reg, note), { x: L.x0, y: L.y - 27, size: 5.5, font: reg, color: GREY })
    } else {
      // Beschriftung ÜBER der Linie: Unterschrift auf die Linie, Name + Position darunter
      drawFit(page, sig, L.x0 + 2, L.y - 26, 140, 30)
      page.drawText(safe(bold, who), { x: L.x0, y: L.y - 34, size: 7.5, font: bold, color: DARK })
      page.drawText(safe(reg, note), { x: L.x0, y: L.y - 42, size: 5.5, font: reg, color: GREY })
      if (field.date) page.drawText(safe(reg, placeDate), { x: field.date.x0, y: L.y - 34, size: 8, font: reg, color: DARK })
      else page.drawText(safe(reg, placeDate), { x: L.x0, y: L.y - 50, size: 7, font: reg, color: DARK })
    }
    if (sealImg) {
      const c = field.stamp ?? { x: L.x0 + 200, y: L.y + 30 }
      drawFit(page, sealImg, c.x - 34, c.y - 34, 68, 68, 'center')
    }
    return { pdf: await doc.save(), placement: 'field', lang }
  }

  // 3. Kein Feld gefunden: Unterschriftsseite anhängen
  const first = doc.getPage(0)
  const page = doc.addPage([first.getWidth(), first.getHeight()])
  const H = page.getHeight()
  page.drawText(lang === 'de' ? 'Unterschrift' : 'Signature', { x: 60, y: H - 90, size: 18, font: bold, color: DARK })
  page.drawText(safe(reg, s.company), { x: 60, y: H - 120, size: 11, font: reg, color: DARK })
  drawFit(page, sig, 60, H - 230, 220, 80)
  page.drawLine({ start: { x: 60, y: H - 235 }, end: { x: 300, y: H - 235 }, thickness: 0.6, color: GREY })
  page.drawText(safe(bold, who), { x: 60, y: H - 250, size: 10, font: bold, color: DARK })
  page.drawText(safe(reg, placeDate), { x: 60, y: H - 264, size: 9, font: reg, color: DARK })
  page.drawText(safe(reg, note), { x: 60, y: H - 278, size: 7, font: reg, color: GREY })
  if (sealImg) drawFit(page, sealImg, 340, H - 250, 110, 110, 'center')
  return { pdf: await doc.save(), placement: 'appended', lang }
}
