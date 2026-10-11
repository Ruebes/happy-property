// Datenblatt-PDF zur Wohnung (Sven 11.10.26): „Bei ‚die Wohnung zum Weiterleiten'
// sendest du das Deck, welches der Kunde schon hat. Grundriss, ein paar Bilder und
// die Spezifikation. Wichtig wäre auch der Zahlungsplan, also wann wird wie viel
// Geld fällig."
//
// Alle Inhalte kommen aus dem Deck (dieselben geprüften Zahlen und Texte, keine
// neuen Berechnungen): Eckdaten + Preis aus dem unit-Block, Grundriss (SVG,
// gerastert mit resvg wie im Social-Studio) mit Flächen aus dem floorplan-Block,
// Zahlungsplan aus dem payment-Block, Ausstattung aus den inventory-Blöcken und
// Renderings aus den gallery-Blöcken. Keine Projekt- oder Bauträgernamen.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'npm:pdf-lib@1.17.1'
import fontkit from 'npm:@pdf-lib/fontkit@1.1.1'
import { initWasm, Resvg } from 'https://esm.sh/@resvg/resvg-wasm@2.6.2'
import { Image } from '../_vendor/imagescript/ImageScript.js'

type Row = { label?: string; sub?: string; value?: string; strong?: boolean }
type Phase = { label?: string; title?: string; rows?: Row[]; sumLabel?: string; sumValue?: string }
export type DeckBlockLite = {
  type?: string; kicker?: string; headline?: string; title?: string; number?: string; intro?: string; note?: string; text?: string
  specs?: string[]; priceLines?: Row[]; image?: string
  stats?: { label?: string; value?: string; unit?: string }[]; bullets?: { strong?: string; text?: string }[]
  phase1?: Phase; phase2?: Phase; priceSummary?: { net?: string; vat?: string; gross?: string; vatRate?: string }
  groups?: { title?: string; items?: string[] }[]; items?: { image?: string; title?: string; caption?: string }[]
}

const NAVY = rgb(0x1a / 255, 0x23 / 255, 0x32 / 255)
const GOLD = rgb(0xc2 / 255, 0xa1 / 255, 0x5e / 255)
const INK = rgb(0x2a / 255, 0x2a / 255, 0x2a / 255)
const MUTE = rgb(0.45, 0.45, 0.48)
const LINE = rgb(0xe6 / 255, 0xdf / 255, 0xd0 / 255)
const CREAM = rgb(0xfa / 255, 0xf6 / 255, 0xec / 255)
const W = 595.28, H = 841.89, M = 42
const LOGO = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/1781605725998-7ngbgv0jmyv.jpeg'
const KONTAKT = 'Happy Property · Sven Rüprich · +357 95 09 64 09 · sven@happy-property.com'

const stripHtml = (s?: string) => (s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

async function holen(url: string, ms = 10000): Promise<Uint8Array | null> {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), ms)
  try { const r = await fetch(url, { signal: ctrl.signal }); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null }
  catch { return null } finally { clearTimeout(to) }
}
// CI-Schriften als statische TTF je Schnitt: Google liefert sie über die CSS-API,
// wenn man mit altem User-Agent fragt (wie loadCiFonts in _shared/brand.ts). Der
// frühere GitHub-Pfad .../montserrat/static/... ist seit 2026 weg (404).
async function schriften(): Promise<{ reg?: Uint8Array; semi?: Uint8Array; bold?: Uint8Array; head?: Uint8Array }> {
  try {
    const css = await fetch('https://fonts.googleapis.com/css?family=Montserrat:400,600,700|Playfair+Display:700', { headers: { 'User-Agent': 'Mozilla/4.0' } })
    if (!css.ok) return {}
    const url: Record<string, string> = {}
    for (const blk of (await css.text()).split('@font-face').slice(1)) {
      const fam = blk.match(/font-family:\s*'([^']+)'/)?.[1], wt = blk.match(/font-weight:\s*(\d+)/)?.[1], u = blk.match(/url\((https:[^)]+\.ttf)\)/)?.[1]
      if (fam && wt && u) url[`${fam}:${wt}`] = u
    }
    const [reg, semi, bold, head] = await Promise.all(['Montserrat:400', 'Montserrat:600', 'Montserrat:700', 'Playfair Display:700']
      .map(k => url[k] ? holen(url[k]) : Promise.resolve(null)))
    return reg && semi && head ? { reg, semi, bold: bold ?? undefined, head } : {}
  } catch { return {} }
}
// Öffentliche Storage-Bilder verkleinert holen (Render-Endpoint mit Breite UND Höhe,
// nur Breite liefert verzerrte Riesenbilder).
const klein = (url: string, w: number, h: number, mode: 'cover' | 'contain') => {
  const m = url.match(/^(https:\/\/[^/]+)\/storage\/v1\/object\/public\/(.+)$/)
  return m ? `${m[1]}/storage/v1/render/image/public/${m[2]}?width=${w}&height=${h}&resize=${mode}&quality=72&format=origin` : url
}
async function bild(pdf: PDFDocument, url: string, w: number, h: number): Promise<PDFImage | null> {
  const b = await holen(klein(url, w, h, 'cover'))
  if (!b || b.length < 100) return null
  try {
    if (b[0] === 0xff && b[1] === 0xd8) return await pdf.embedJpg(b)
    // PNG-Renderings als JPEG einbetten, sonst wird das PDF unnötig groß.
    const img = await Image.decode(b)
    return await pdf.embedJpg(await img.encodeJPEG(78))
  } catch { return null }
}
let _resvg: Promise<unknown> | null = null
async function grundrissPng(svgUrl: string, fonts: Uint8Array[]): Promise<Uint8Array | null> {
  const b = await holen(svgUrl)
  if (!b) return null
  try {
    _resvg ??= initWasm(fetch('https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm'))
    await _resvg
    const r = new Resvg(new TextDecoder().decode(b), { fitTo: { mode: 'width', value: 1600 }, font: { fontBuffers: fonts, defaultFontFamily: 'Montserrat', loadSystemFonts: false } })
    return r.render().asPng()
  } catch (e) { console.warn('[datenblatt] Grundriss:', e); return null }
}

// ── Wann wird was fällig (Sven 11.10.26) ────────────────────────────────────
// „Reservierung jetzt, 30 % Vertrag in ca. 2-4 Wochen, 20 % bei Übergabe
// (geplant Ende 2027) und dann der Rest in 2028." Die Zeitpunkte stehen nicht im
// Deck, sie werden aus der Zeilenbezeichnung und dem geplanten Übergabetermin
// (deck_context.completion, z.B. „11/2027") abgeleitet. Unbekannte Zeilen bekommen
// keinen Zeitpunkt statt eines geratenen.
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
type Uebergabe = { wann: string; monat: number; jahr: number }
export function uebergabeAus(s?: string | null): Uebergabe | null {
  const m = (s ?? '').match(/(\d{1,2})\s*\/\s*(\d{4})/) ?? (s ?? '').match(/(\d{4})-(\d{2})/)
  if (!m) return null
  const [monat, jahr] = m[0].includes('-') ? [Number(m[2]), Number(m[1])] : [Number(m[1]), Number(m[2])]
  if (!(monat >= 1 && monat <= 12) || jahr < 2020) return null
  return { wann: `${monat <= 4 ? 'Anfang' : monat <= 8 ? 'Mitte' : 'Ende'} ${jahr}`, monat, jahr }
}
export function faellig(label?: string, sub?: string, u?: Uebergabe | null): string | null {
  const l = (label ?? '').toLowerCase(), alles = `${l} ${(sub ?? '').toLowerCase()}`
  const geplant = u ? `, geplant ${u.wann}` : ''
  if (/reserv/.test(l)) return 'jetzt'
  if (/nach übergabe|after handover/.test(alles) && /rate|nach übergabe/.test(l)) {
    if (!u) return 'in den 12 Monaten nach Übergabe'
    return u.monat >= 9 ? `im Laufe von ${u.jahr + 1}, in Raten` : `in Raten bis ca. ${MONATE[u.monat - 1]} ${u.jahr + 1}`
  }
  if (/bis zur übergabe/.test(alles)) return `bis zur Übergabe${geplant}`
  if (/übergabe|schluss|letzte rate|handover|key/.test(l)) return `bei Übergabe${geplant}`
  if (/vertrag|contract|kaufvertrag/.test(l)) return 'in ca. 2 bis 4 Wochen (Kaufvertrag)'
  if (/bau|fortschritt|milestone|construction|rohbau|mauerwerk|fliesen|alumin/.test(alles)) return `nach Baufortschritt, bis zur Übergabe${geplant}`
  return null
}

// Für die Mail (Sven 11.10.26): „Es muss aus der Mail rauskommen, dass jetzt nur
// die 20k und die 30 % fällig werden." Jetzt = Reservierung + Kaufvertrag; alles
// andere ist „später" und wird nur als Summe mit Zeitpunkten genannt.
const betrag = (v?: string) => { const n = Number(String(v ?? '').replace(/[^\d,]/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0 }
export function zahlungsUebersicht(blocks: DeckBlockLite[], uebergabe?: string | null): {
  jetzt: { label: string; value: string; pct: string | null; wann: string }[]; spaeterSumme: number; spaeterWann: string[]
  spaeter: { value: string; wann: string | null }[]
} | null {
  const pay = blocks.find(b => b.type === 'payment')
  const rows = [...(pay?.phase1?.rows ?? []), ...(pay?.phase2?.rows ?? [])]
  if (!rows.length) return null
  const u = uebergabeAus(uebergabe)
  const jetzt: { label: string; value: string; pct: string | null; wann: string }[] = []
  let spaeterSumme = 0; const spaeterWann: string[] = []; const spaeter: { value: string; wann: string | null }[] = []
  for (const r of rows) {
    const wann = faellig(r.label, r.sub, u)
    if (wann === 'jetzt' || (wann ?? '').startsWith('in ca. 2 bis 4 Wochen')) {
      jetzt.push({ label: stripHtml(r.label), value: stripHtml(r.value), pct: (r.sub ?? '').match(/(\d+(?:,\d+)?)\s*%/)?.[1] ?? null, wann: wann! })
    } else {
      spaeterSumme += betrag(r.value)
      spaeter.push({ value: stripHtml(r.value), wann })
      if (wann && !spaeterWann.includes(wann)) spaeterWann.push(wann)
    }
  }
  return jetzt.length ? { jetzt, spaeterSumme, spaeterWann, spaeter } : null
}

export async function baueDatenblatt(o: {
  blocks: DeckBlockLite[]; lage: string; nr: string; stand: Date; uebergabe?: string | null
  /** Nur die Seite Zahlungsplan (eigenes PDF „Zahlungsplan" für die Mail). */
  nurZahlungsplan?: boolean
}): Promise<Uint8Array> {
  const ueb = uebergabeAus(o.uebergabe)
  const pdf = await PDFDocument.create()
  pdf.setTitle(o.nr ? `Wohnung ${o.nr} - Datenblatt` : 'Datenblatt')
  pdf.setAuthor('Happy Property')
  const f = await schriften()
  let reg: PDFFont, semi: PDFFont, head: PDFFont
  let standard = false
  if (f.reg && f.semi && f.head) {
    pdf.registerFontkit(fontkit)
    reg = await pdf.embedFont(f.reg, { subset: true }); semi = await pdf.embedFont(f.semi, { subset: true }); head = await pdf.embedFont(f.head, { subset: true })
  } else {
    standard = true
    reg = await pdf.embedFont(StandardFonts.Helvetica); semi = await pdf.embedFont(StandardFonts.HelveticaBold); head = await pdf.embedFont(StandardFonts.TimesRomanBold)
  }
  // Standardschriften kennen nur WinAnsi - alles andere fällt sonst als Fehler.
  const t = (s?: string) => {
    const x = stripHtml(s).replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/[–—]/g, '-').replace(/→/g, '->').replace(/≈/g, 'ca.').replace(/[„“]/g, '"')
    return standard ? x.replace(/[^\x20-\x7e\xa0-\xff€]/g, '') : x
  }
  const wrap = (s: string, font: PDFFont, size: number, max: number): string[] => {
    const out: string[] = []; let cur = ''
    for (const w of t(s).split(' ').filter(Boolean)) {
      const nxt = cur ? `${cur} ${w}` : w
      if (font.widthOfTextAtSize(nxt, size) > max && cur) { out.push(cur); cur = w } else cur = nxt
    }
    if (cur) out.push(cur)
    return out
  }

  const logoBytes = await holen(LOGO)
  const logo = logoBytes ? await pdf.embedJpg(logoBytes).catch(() => null) : null
  const seiten: PDFPage[] = []
  let page!: PDFPage
  let y = 0
  const neueSeite = (titel?: string) => {
    page = pdf.addPage([W, H]); seiten.push(page)
    page.drawRectangle({ x: 0, y: H - 64, width: W, height: 64, color: NAVY })
    if (logo) { const s = 40 / logo.height; page.drawImage(logo, { x: M, y: H - 52, width: logo.width * s, height: 40 }) }
    const art = o.nurZahlungsplan ? 'Zahlungsplan' : 'Datenblatt'
    const rechts = t(o.nr ? `Wohnung ${o.nr} · ${art}` : art)
    page.drawText(rechts, { x: W - M - semi.widthOfTextAtSize(rechts, 9), y: H - 37, size: 9, font: semi, color: GOLD })
    y = H - 64 - 34
    if (titel) { page.drawText(t(titel), { x: M, y, size: 20, font: head, color: NAVY }); y -= 10; page.drawRectangle({ x: M, y, width: 34, height: 2.5, color: GOLD }); y -= 22 }
  }
  const platz = (h: number, titel?: string) => { if (y - h < 70) neueSeite(titel) }
  const absatz = (s: string, size = 10, font = reg, color = INK, max = W - 2 * M, x = M, lh = 1.45) => {
    for (const z of wrap(s, font, size, max)) { platz(size * lh); page.drawText(z, { x, y, size, font, color }); y -= size * lh }
  }

  const unit = o.blocks.find(b => b.type === 'unit')
  const fp = o.blocks.find(b => b.type === 'floorplan')
  const pay = o.blocks.find(b => b.type === 'payment')
  const inv = o.blocks.filter(b => b.type === 'inventory')
  const gal = o.blocks.filter(b => b.type === 'gallery').flatMap(b => b.items ?? []).filter(i => i.image)
  const cover = o.blocks.find(b => b.type === 'cover')

  // ── Seite 1: Titel, Bild, Eckdaten, Preis ────────────────────────────────
  if (!o.nurZahlungsplan) {
  neueSeite()
  page.drawText(t(o.nr ? `Wohnung ${o.nr}` : 'Wohnung'), { x: M, y, size: 30, font: head, color: NAVY }); y -= 20
  page.drawText(t([o.lage, unit?.kicker?.split('·').slice(1).join('·').trim()].filter(Boolean).join(' · ')), { x: M, y, size: 11, font: reg, color: MUTE }); y -= 18
  const hero = gal[0]?.image ?? cover?.image
  if (hero) {
    const img = await bild(pdf, hero, 1200, 720)
    if (img) { const w = W - 2 * M, h = w * 0.6; page.drawImage(img, { x: M, y: y - h, width: w, height: h }); y -= h + 22 }
  }
  const colW = (W - 2 * M - 24) / 2
  const yStart = y
  page.drawText(t('Eckdaten'), { x: M, y, size: 13, font: head, color: NAVY }); y -= 18
  for (const s of unit?.specs ?? []) {
    for (const [i, z] of wrap(s, reg, 9.5, colW - 12).entries()) {
      if (i === 0) page.drawRectangle({ x: M, y: y + 2.5, width: 3, height: 3, color: GOLD })
      page.drawText(z, { x: M + 10, y, size: 9.5, font: reg, color: INK }); y -= 13.5
    }
  }
  const yLinks = y
  y = yStart
  const px = M + colW + 24
  page.drawText(t('Preis'), { x: px, y, size: 13, font: head, color: NAVY }); y -= 18
  for (const l of unit?.priceLines ?? []) {
    const f2 = l.strong ? semi : reg, sz = l.strong ? 11 : 9.5
    if (l.strong) { page.drawRectangle({ x: px, y: y + sz + 3, width: colW, height: 0.8, color: LINE }) }
    page.drawText(t(l.label), { x: px, y, size: sz, font: f2, color: l.strong ? NAVY : MUTE })
    const v = t(l.value); page.drawText(v, { x: px + colW - f2.widthOfTextAtSize(v, sz), y, size: sz, font: f2, color: INK })
    y -= sz + 8
  }
  y = Math.min(y, yLinks) - 10
  }

  // ── Grundriss ────────────────────────────────────────────────────────────
  if (fp && !o.nurZahlungsplan) {
    neueSeite('Grundriss')
    if (fp.image) {
      const fonts = [f.reg, f.semi, f.bold, f.head].filter((x): x is Uint8Array => !!x)
      const png = /\.svg(\?|$)/i.test(fp.image) ? await grundrissPng(fp.image, fonts) : null
      const gimg = png ? await pdf.embedPng(png).catch(() => null) : await bild(pdf, fp.image, 1600, 1200)
      if (gimg) {
        const w = W - 2 * M, h = Math.min(w * gimg.height / gimg.width, 430)
        const ww = h * gimg.width / gimg.height
        page.drawImage(gimg, { x: M + (w - ww) / 2, y: y - h, width: ww, height: h }); y -= h + 18
      }
    }
    const st = (fp.stats ?? []).slice(0, 4)
    if (st.length) {
      const bw = (W - 2 * M - (st.length - 1) * 8) / st.length
      st.forEach((s, i) => {
        const x = M + i * (bw + 8)
        page.drawRectangle({ x, y: y - 46, width: bw, height: 46, color: CREAM })
        page.drawRectangle({ x, y: y - 2, width: bw, height: 2, color: GOLD })
        page.drawText(t(`${s.value ?? ''} ${s.unit ?? ''}`.trim()), { x: x + 8, y: y - 22, size: 12, font: semi, color: NAVY })
        page.drawText(t(s.label), { x: x + 8, y: y - 37, size: 8, font: reg, color: MUTE })
      })
      y -= 64
    }
    for (const bl of fp.bullets ?? []) {
      const s = `${bl.strong ?? ''}${bl.text ?? ''}`
      const zeilen = wrap(s, reg, 10, W - 2 * M - 12)
      platz(zeilen.length * 14)
      page.drawRectangle({ x: M, y: y + 3, width: 3, height: 3, color: GOLD })
      for (const z of zeilen) { page.drawText(z, { x: M + 10, y, size: 10, font: reg, color: INK }); y -= 14 }
    }
  }

  // ── Zahlungsplan: wann wird wie viel fällig ─────────────────────────────
  if (pay && (pay.phase1 || pay.phase2)) {
    neueSeite('Zahlungsplan')
    if (o.nurZahlungsplan) {
      page.drawText(t([o.nr ? `Wohnung ${o.nr}` : '', o.lage].filter(Boolean).join(' · ')), { x: M, y, size: 11, font: semi, color: MUTE }); y -= 20
    }
    if (pay.intro) { absatz(pay.intro, 10.5); y -= 6 }
    page.drawText(t('Wann wird wie viel fällig'), { x: M, y, size: 9, font: semi, color: GOLD }); y -= 14
    // Zeitstrahl: je Zahlung ein Kasten mit Zeitpunkt, Betrag, Bezeichnung.
    const alle = [...(pay.phase1?.rows ?? []), ...(pay.phase2?.rows ?? [])]
    if (alle.length >= 2 && alle.length <= 5) {
      const gap = 8, bw = (W - 2 * M - gap * (alle.length - 1)) / alle.length, bh = 70
      page.drawRectangle({ x: M + bw / 2, y: y - 12, width: W - 2 * M - bw, height: 1.2, color: GOLD })
      alle.forEach((r, i) => {
        const x = M + i * (bw + gap)
        page.drawRectangle({ x, y: y - bh, width: bw, height: bh, color: CREAM, borderColor: LINE, borderWidth: 0.6 })
        page.drawCircle({ x: x + bw / 2, y: y - 12, size: 4, color: GOLD })
        const f0 = faellig(r.label, r.sub, ueb) ?? ''
        const wann = t(f0.charAt(0).toUpperCase() + f0.slice(1))
        const z1 = wrap(wann, semi, 8, bw - 12).slice(0, 2)
        z1.forEach((z, k) => page.drawText(z, { x: x + 6, y: y - 28 - k * 10, size: 8, font: semi, color: GOLD }))
        const v = t(r.value); const vs = Math.min(13, (bw - 12) / Math.max(1, semi.widthOfTextAtSize(v, 1)))
        page.drawText(v, { x: x + 6, y: y - 52, size: vs, font: semi, color: NAVY })
        const lab = wrap(r.label ?? '', reg, 7.5, bw - 12)[0] ?? ''
        page.drawText(lab, { x: x + 6, y: y - 64, size: 7.5, font: reg, color: MUTE })
      })
      y -= bh + 20
    } else { y -= 16 }
    const amountX = W - M
    for (const ph of [pay.phase1, pay.phase2]) {
      if (!ph) continue
      platz(40, 'Zahlungsplan')
      page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 22, color: NAVY })
      page.drawText(t([ph.label, ph.title].filter(Boolean).join(' · ')), { x: M + 10, y: y + 1, size: 10, font: semi, color: rgb(1, 1, 1) })
      y -= 26
      for (const r of ph.rows ?? []) {
        const sub = wrap(r.sub ?? '', reg, 8.5, W - 2 * M - 130)
        platz(18 + sub.length * 12, 'Zahlungsplan')
        page.drawText(t(r.label), { x: M + 10, y, size: 10.5, font: semi, color: INK })
        const v = t(r.value); page.drawText(v, { x: amountX - 10 - semi.widthOfTextAtSize(v, 11.5), y, size: 11.5, font: semi, color: NAVY })
        y -= 13
        const wann = faellig(r.label, r.sub, ueb)
        if (wann) { page.drawText(t(`Fällig: ${wann}`), { x: M + 10, y, size: 9, font: semi, color: GOLD }); y -= 12 }
        for (const z of sub) { page.drawText(z, { x: M + 10, y, size: 8.5, font: reg, color: MUTE }); y -= 12 }
        y -= 4; page.drawRectangle({ x: M, y: y + 4, width: W - 2 * M, height: 0.6, color: LINE }); y -= 6
      }
      if (ph.sumLabel || ph.sumValue) {
        page.drawText(t(ph.sumLabel), { x: M + 10, y, size: 9.5, font: semi, color: MUTE })
        const v = t(ph.sumValue); page.drawText(v, { x: amountX - 10 - semi.widthOfTextAtSize(v, 10), y, size: 10, font: semi, color: INK }); y -= 18
      }
      y -= 6
    }
    const ps = pay.priceSummary
    if (ps) {
      platz(80, 'Zahlungsplan')
      const bx = W - M - 230
      page.drawRectangle({ x: bx, y: y - 66, width: 230, height: 72, borderColor: GOLD, borderWidth: 1.2, color: rgb(1, 1, 1) })
      const zeile = (k: string, v: string | undefined, yy: number, fo: PDFFont, sz: number) => {
        page.drawText(t(k), { x: bx + 12, y: yy, size: sz, font: fo, color: INK })
        const vv = t(v); page.drawText(vv, { x: bx + 218 - fo.widthOfTextAtSize(vv, sz), y: yy, size: sz, font: fo, color: INK })
      }
      zeile('Nettopreis', ps.net, y - 10, reg, 9.5)
      zeile(`zzgl. MwSt (${ps.vatRate ?? '19 %'})`, ps.vat, y - 26, reg, 9.5)
      zeile('Bruttopreis gesamt', ps.gross, y - 50, semi, 11.5)
      y -= 86
    }
    if (pay.note) { absatz(pay.note, 8.5, reg, MUTE) }
  }

  // ── Ausstattung / Spezifikation ─────────────────────────────────────────
  const gruppen = inv.flatMap(b => b.groups ?? []).filter(g => (g.items ?? []).length)
  if (gruppen.length && !o.nurZahlungsplan) {
    neueSeite('Ausstattung')
    const cw = (W - 2 * M - 20) / 2
    let col = 0, yTop = y, yCol = [y, y]
    for (const g of gruppen) {
      const items = (g.items ?? []).map(i => wrap(i, reg, 9, cw - 12))
      const hoehe = 18 + items.reduce((a, z) => a + z.length * 12 + 2, 0) + 10
      col = yCol[0] >= yCol[1] ? 0 : 1
      if (yCol[col] - hoehe < 70) {
        const other = 1 - col
        if (yCol[other] - hoehe >= 70) col = other
        else { neueSeite('Ausstattung'); yTop = y; yCol = [y, y]; col = 0 }
      }
      let yy = yCol[col]; const x = M + col * (cw + 20)
      page.drawText(t(g.title), { x, y: yy, size: 10.5, font: semi, color: NAVY }); yy -= 16
      for (const z of items) {
        page.drawRectangle({ x, y: yy + 3, width: 3, height: 3, color: GOLD })
        for (const zz of z) { page.drawText(zz, { x: x + 10, y: yy, size: 9, font: reg, color: INK }); yy -= 12 }
        yy -= 2
      }
      yCol[col] = yy - 10
      void yTop
    }
    y = Math.min(...yCol)
  }

  // ── Bilder ───────────────────────────────────────────────────────────────
  const auswahl = gal.slice(1, 5)
  if (auswahl.length && !o.nurZahlungsplan) {
    neueSeite('Bilder')
    const bw = (W - 2 * M - 14) / 2, bh = bw * 0.66
    for (let i = 0; i < auswahl.length; i++) {
      const img = await bild(pdf, auswahl[i].image!, 900, 594)
      if (!img) continue
      const x = M + (i % 2) * (bw + 14), yy = y - Math.floor(i / 2) * (bh + 40)
      page.drawImage(img, { x, y: yy - bh, width: bw, height: bh })
      const cap = wrap(auswahl[i].title ?? '', reg, 8.5, bw)[0]
      if (cap) page.drawText(cap, { x, y: yy - bh - 13, size: 8.5, font: reg, color: MUTE })
    }
  }

  // ── Fußzeile auf jeder Seite ────────────────────────────────────────────
  const stand = o.stand.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  seiten.forEach((p, i) => {
    p.drawRectangle({ x: M, y: 44, width: W - 2 * M, height: 0.6, color: LINE })
    p.drawText(t(KONTAKT), { x: M, y: 32, size: 7.5, font: reg, color: MUTE })
    const s = `Seite ${i + 1} von ${seiten.length}`
    p.drawText(s, { x: W - M - reg.widthOfTextAtSize(s, 7.5), y: 32, size: 7.5, font: reg, color: MUTE })
    p.drawText(t(`Stand ${stand} · Angaben ohne Gewähr, Preise vorbehaltlich Final-Plans · Bilder zu Marketingzwecken`), { x: M, y: 21, size: 7, font: reg, color: MUTE })
  })
  return await pdf.save()
}
