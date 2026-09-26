// News-Karussell (Instagram/Facebook, 1080×1350 = 4:5): gestaltete Slides mit
// scharfem Text statt Einzelbild-News (Svens Freigabe 26.9.2026, Karussells werden
// laut Metricool 9x öfter gespeichert als Einzelbilder).
//
// Reine Gestaltung: baut SVGs und setzt das Titelfoto ein. Die PNG-Umwandlung
// (resvg, CI-Schriften) kommt von außen (svgToPng aus index.ts), damit resvg nur
// einmal pro Worker initialisiert wird.
import { Image } from '../_vendor/imagescript/ImageScript.js'
import { CI, CI_FONT } from '../_shared/brand.ts'

export const CAR_W = 1080, CAR_H = 1350

export type CarSlide =
  | { type: 'cover'; kicker?: string; title: string; subtitle?: string }
  | { type: 'fact'; value: string; label: string; text?: string; source?: string }
  | { type: 'point'; title: string; body: string }
  | { type: 'list'; title: string; items: string[] }
  | { type: 'cta'; title: string; body?: string; button?: string }

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// Umbruch nach Zeichen (die Schriftbreite ist nicht messbar); zu lange Texte
// werden nach maxLines mit … gekürzt, damit nichts über den Rand läuft.
export function wrap(s: string, maxChars: number, maxLines = 99): string[] {
  const words = String(s ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if ((`${cur} ${w}`).trim().length > maxChars && cur) { lines.push(cur); cur = w } else cur = (`${cur} ${w}`).trim()
  }
  if (cur) lines.push(cur)
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[\s,.;:!?-]+$/, '')}…`
    return kept
  }
  return lines.length ? lines : ['']
}
const tspans = (lines: string[], x: number, y: number, lh: number, anchor = 'start') =>
  lines.map((l, i) => `<tspan x="${x}" y="${y + i * lh}" text-anchor="${anchor}">${esc(l)}</tspan>`).join('')

const F = `font-family="${CI_FONT.body}"`
const FH = `font-family="${CI_FONT.heading}"`
const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="${CAR_W}" height="${CAR_H}" viewBox="0 0 ${CAR_W} ${CAR_H}">`

// „Wischen" + Pfeil als Linie (das Zeichen → fehlt in den eingebetteten Schriften)
function swipe(col: string, size: number, bold = false): string {
  const y = 1282, xEnd = 990, xText = xEnd - 34
  return `<text ${F} x="${xText}" y="${y}" font-size="${size}" fill="${col}" text-anchor="end"${bold ? ' font-weight="600"' : ''}>Wischen</text>
    <path d="M ${xEnd - 26} ${y - 9} H ${xEnd - 2} M ${xEnd - 11} ${y - 18} L ${xEnd - 2} ${y - 9} L ${xEnd - 11} ${y}" stroke="${col}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
}

function frame(i: number, n: number, dark: boolean): string {
  const col = dark ? CI.line : CI.mute
  return `<text ${F} x="90" y="110" font-size="24" fill="${dark ? CI.coral : CI.coral}" font-weight="700" letter-spacing="5">IMMOBILIEN AUF ZYPERN · EU</text>
    <text ${F} x="990" y="110" font-size="26" fill="${col}" text-anchor="end" font-weight="600">${i + 1}/${n}</text>
    <line x1="90" y1="1232" x2="990" y2="1232" stroke="${dark ? CI.navySoft : CI.line}" stroke-width="2"/>
    <text ${F} x="90" y="1282" font-size="26" fill="${col}" font-weight="600" letter-spacing="1">Happy Property Cyprus</text>
    ${i < n - 1 ? swipe(col, 26) : `<text ${F} x="990" y="1282" font-size="26" fill="${col}" text-anchor="end">happy-property.de</text>`}`
}

// Titel-Slide: nur das Overlay (Verlauf + Text) – das Foto kommt darunter.
export function coverOverlaySvg(s: Extract<CarSlide, { type: 'cover' }>, n: number): string {
  const title = wrap(s.title, 17, 5)
  const sub = wrap(s.subtitle ?? '', 36, 3)
  const titleLh = 96
  const subLh = 48
  const blockH = title.length * titleLh + (s.subtitle ? 40 + sub.length * subLh : 0)
  const yTitle = 1150 - blockH
  return `${svgOpen}
    <defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${CI.navyDeep}" stop-opacity="0"/>
      <stop offset="0.38" stop-color="${CI.navyDeep}" stop-opacity="0.15"/>
      <stop offset="0.7" stop-color="${CI.navyDeep}" stop-opacity="0.82"/>
      <stop offset="1" stop-color="${CI.navyDeep}" stop-opacity="0.96"/>
    </linearGradient>
    <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${CI.navyDeep}" stop-opacity="0.55"/><stop offset="1" stop-color="${CI.navyDeep}" stop-opacity="0"/>
    </linearGradient></defs>
    <rect width="${CAR_W}" height="${CAR_H}" fill="url(#fade)"/>
    <rect width="${CAR_W}" height="220" fill="url(#top)"/>
    <text ${F} x="90" y="110" font-size="24" fill="${CI.cream}" font-weight="700" letter-spacing="5">${esc((s.kicker ?? 'IMMOBILIEN AUF ZYPERN · EU').toUpperCase())}</text>
    <text ${F} x="990" y="110" font-size="26" fill="${CI.cream}" text-anchor="end" font-weight="600">1/${n}</text>
    <rect x="90" y="${yTitle - 115}" width="90" height="8" rx="4" fill="${CI.coral}"/>
    <text ${FH} font-size="84" fill="${CI.cream}" font-weight="700">${tspans(title, 90, yTitle, titleLh)}</text>
    ${s.subtitle ? `<text ${F} font-size="36" fill="${CI.line}">${tspans(sub, 90, yTitle + title.length * titleLh + 30, subLh)}</text>` : ''}
    ${swipe(CI.cream, 28, true)}
  </svg>`
}

// Titel-Slide ohne Foto (Rückfall): Navy-Fläche.
export function coverPlainSvg(s: Extract<CarSlide, { type: 'cover' }>, n: number): string {
  return coverOverlaySvg(s, n).replace(svgOpen, `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.navy}"/>`)
}

export function slideSvg(s: CarSlide, i: number, n: number): string {
  if (s.type === 'cover') return coverPlainSvg(s, n)
  if (s.type === 'cta') {
    const title = wrap(s.title, 20, 4)
    const body = wrap(s.body ?? '', 38, 5)
    const yT = 470
    const yB = yT + title.length * 92 + 50
    const btn = s.button ? wrap(s.button, 30, 1)[0] : ''
    const btnW = Math.min(900, Math.max(460, btn.length * 23 + 120))
    const yBtn = Math.max(yB + body.length * 50 + 60, 900)
    return `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.navy}"/>
      ${frame(i, n, true)}
      <rect x="90" y="${yT - 110}" width="90" height="8" rx="4" fill="${CI.coral}"/>
      <text ${FH} font-size="78" fill="${CI.cream}" font-weight="700">${tspans(title, 90, yT, 92)}</text>
      ${s.body ? `<text ${F} font-size="36" fill="${CI.line}">${tspans(body, 90, yB, 50)}</text>` : ''}
      ${btn ? `<rect x="90" y="${yBtn}" width="${btnW}" height="110" rx="55" fill="${CI.coral}"/>
      <text ${F} x="${90 + btnW / 2}" y="${yBtn + 70}" font-size="38" fill="${CI.white}" font-weight="700" text-anchor="middle">${esc(btn)}</text>` : ''}
    </svg>`
  }
  if (s.type === 'fact') {
    const val = wrap(s.value, 9, 2)
    const label = wrap(s.label, 30, 3)
    const text = wrap(s.text ?? '', 42, 7)
    const yV = 470
    const yL = yV + (val.length - 1) * 160 + 110
    const yX = yL + label.length * 58 + 60
    return `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.cream}"/>
      ${frame(i, n, false)}
      <text ${FH} font-size="170" fill="${CI.navy}" font-weight="700">${tspans(val, 84, yV, 160)}</text>
      <rect x="90" y="${yL - 62}" width="90" height="8" rx="4" fill="${CI.coral}"/>
      <text ${F} font-size="44" fill="${CI.navy}" font-weight="700">${tspans(label, 90, yL, 58)}</text>
      ${s.text ? `<text ${F} font-size="34" fill="${CI.ink}">${tspans(text, 90, yX, 48)}</text>` : ''}
      ${s.source ? `<text ${F} x="90" y="1190" font-size="24" fill="${CI.mute}">Quelle: ${esc(wrap(s.source, 60, 1)[0])}</text>` : ''}
    </svg>`
  }
  if (s.type === 'list') {
    const title = wrap(s.title, 24, 3)
    const items = (s.items ?? []).slice(0, 5)
    let y = 300 + title.length * 76 + 70
    const rows = items.map(it => {
      const lines = wrap(it, 36, 3)
      const out = `<circle cx="112" cy="${y - 13}" r="11" fill="${CI.coral}"/>
        <text ${F} font-size="36" fill="${CI.ink}">${tspans(lines, 150, y, 50)}</text>`
      y += lines.length * 50 + 44
      return out
    }).join('')
    return `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.cream}"/>
      ${frame(i, n, false)}
      <text ${FH} font-size="66" fill="${CI.navy}" font-weight="700">${tspans(title, 90, 300, 76)}</text>
      ${rows}
    </svg>`
  }
  // point
  const title = wrap(s.title, 24, 4)
  const body = wrap(s.body, 40, 10)
  const yT = 360
  const yB = yT + title.length * 78 + 60
  return `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.cream}"/>
    ${frame(i, n, false)}
    <rect x="90" y="${yT - 110}" width="90" height="8" rx="4" fill="${CI.coral}"/>
    <text ${FH} font-size="66" fill="${CI.navy}" font-weight="700">${tspans(title, 90, yT, 78)}</text>
    <text ${F} font-size="36" fill="${CI.ink}">${tspans(body, 90, yB, 52)}</text>
  </svg>`
}

// Foto auf 1080×1350 zuschneiden (mittig, „cover") und das Overlay darüberlegen.
export async function composeCover(photo: Uint8Array, overlayPng: Uint8Array): Promise<Uint8Array> {
  const img = await Image.decode(photo)
  const scale = Math.max(CAR_W / img.width, CAR_H / img.height)
  img.resize(Math.round(img.width * scale), Math.round(img.height * scale))
  const x = Math.max(0, Math.round((img.width - CAR_W) / 2))
  const y = Math.max(0, Math.round((img.height - CAR_H) / 2))
  img.crop(x, y, CAR_W, CAR_H)
  img.composite(await Image.decode(overlayPng), 0, 0)
  return await img.encodeJPEG(90)
}

// Plausibilität der KI-Slides: Reihenfolge Titel … CTA, 5 bis 8 Slides.
export function normalizeSlides(raw: unknown): CarSlide[] {
  const list = (Array.isArray(raw) ? raw : []).filter(x => x && typeof x === 'object') as Array<Record<string, unknown>>
  const str = (v: unknown) => String(v ?? '').trim()
  const out: CarSlide[] = []
  for (const r of list) {
    const t = str(r.type)
    if (t === 'cover' && str(r.title)) out.push({ type: 'cover', kicker: str(r.kicker) || undefined, title: str(r.title), subtitle: str(r.subtitle) || undefined })
    else if (t === 'fact' && str(r.value) && str(r.label)) out.push({ type: 'fact', value: str(r.value), label: str(r.label), text: str(r.text) || undefined, source: str(r.source) || undefined })
    else if (t === 'list' && str(r.title) && Array.isArray(r.items)) out.push({ type: 'list', title: str(r.title), items: (r.items as unknown[]).map(str).filter(Boolean) })
    else if (t === 'point' && str(r.title) && str(r.body)) out.push({ type: 'point', title: str(r.title), body: str(r.body) })
    else if (t === 'cta' && str(r.title)) out.push({ type: 'cta', title: str(r.title), body: str(r.body) || undefined, button: str(r.button) || undefined })
  }
  const cover = out.find(s => s.type === 'cover')
  const cta = [...out].reverse().find(s => s.type === 'cta')
  const middle = out.filter(s => s.type !== 'cover' && s.type !== 'cta').slice(0, 6)
  if (!cover || middle.length < 3) throw new Error('Karussell: zu wenige verwertbare Slides.')
  return [cover, ...middle, ...(cta ? [cta] : [])]
}
