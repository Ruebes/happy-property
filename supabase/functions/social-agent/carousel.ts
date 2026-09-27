// News-Karussell (Instagram/Facebook, 1080×1350 = 4:5): gestaltete Slides mit
// scharfem Text statt Einzelbild-News (Svens Freigabe 26.9.2026, Karussells werden
// laut Metricool 9x öfter gespeichert als Einzelbilder).
//
// Aufbau nach der Recherche vom 27.9.2026 (Skill ig-carousel, Socialinsider,
// Carouselli): cover (der Hook, kurz und groß) → stake (zweites Cover, ein Satz,
// warum es zählt) → 3 bis 5 Slides fact/point/list → recap (der Slide, den man
// weiterschickt, Sends sind das stärkste Signal) → cta.
// Alle Texte halten PAD = 120 px Rand auf jeder Seite, damit der Zuschnitt im
// Profil-Raster nichts abschneidet, egal wie Instagram das Verhältnis gerade legt.
//
// Reine Gestaltung: baut SVGs und setzt das Titelfoto ein. Die PNG-Umwandlung
// (resvg, CI-Schriften) kommt von außen (svgToPng aus index.ts), damit resvg nur
// einmal pro Worker initialisiert wird.
import { Image } from '../_vendor/imagescript/ImageScript.js'
import { CI, CI_FONT } from '../_shared/brand.ts'

export const CAR_W = 1080, CAR_H = 1350
// Sicherer Rand: das Profil-Raster schneidet außen zu, 120 px halten alles drin.
const PAD = 120
const PAD_R = CAR_W - PAD

export type CarSlide =
  | { type: 'cover'; kicker?: string; title: string; subtitle?: string }
  | { type: 'stake'; text: string }
  | { type: 'fact'; value: string; label: string; text?: string; source?: string }
  | { type: 'point'; title: string; body: string }
  | { type: 'list'; title: string; items: string[] }
  | { type: 'recap'; title: string; items: string[] }
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
  const y = 1272, xEnd = PAD_R, xText = xEnd - 34
  return `<text ${F} x="${xText}" y="${y}" font-size="${size}" fill="${col}" text-anchor="end"${bold ? ' font-weight="600"' : ''}>Wischen</text>
    <path d="M ${xEnd - 26} ${y - 9} H ${xEnd - 2} M ${xEnd - 11} ${y - 18} L ${xEnd - 2} ${y - 9} L ${xEnd - 11} ${y}" stroke="${col}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
}

function frame(i: number, n: number, dark: boolean): string {
  const col = dark ? CI.line : CI.mute
  return `<text ${F} x="${PAD}" y="130" font-size="24" fill="${CI.coral}" font-weight="700" letter-spacing="5">IMMOBILIEN AUF ZYPERN · EU</text>
    <text ${F} x="${PAD_R}" y="130" font-size="26" fill="${col}" text-anchor="end" font-weight="600">${i + 1}/${n}</text>
    <line x1="${PAD}" y1="1222" x2="${PAD_R}" y2="1222" stroke="${dark ? CI.navySoft : CI.line}" stroke-width="2"/>
    <text ${F} x="${PAD}" y="1272" font-size="26" fill="${col}" font-weight="600" letter-spacing="1">Happy Property Cyprus</text>
    ${i < n - 1 ? swipe(col, 26) : `<text ${F} x="${PAD_R}" y="1272" font-size="26" fill="${col}" text-anchor="end">happy-property.de</text>`}`
}

// Titel-Slide: nur das Overlay (Verlauf + Text) – das Foto kommt darunter.
// Der Titel ist der Hook: kurz und groß, höchstens 3 Zeilen (ig-carousel:
// „Das Cover ist 80 % des Ergebnisses. Sechs Wörter. Groß.").
export function coverOverlaySvg(s: Extract<CarSlide, { type: 'cover' }>, n: number): string {
  const title = wrap(s.title, 16, 3)
  const sub = wrap(s.subtitle ?? '', 37, 2)
  const titleLh = 104
  const subLh = 48
  const blockH = title.length * titleLh + (s.subtitle ? 40 + sub.length * subLh : 0)
  const yTitle = 1130 - blockH
  return `${svgOpen}
    <defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${CI.navyDeep}" stop-opacity="0"/>
      <stop offset="0.3" stop-color="${CI.navyDeep}" stop-opacity="0.2"/>
      <stop offset="0.55" stop-color="${CI.navyDeep}" stop-opacity="0.72"/>
      <stop offset="0.8" stop-color="${CI.navyDeep}" stop-opacity="0.92"/>
      <stop offset="1" stop-color="${CI.navyDeep}" stop-opacity="0.97"/>
    </linearGradient>
    <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${CI.navyDeep}" stop-opacity="0.55"/><stop offset="1" stop-color="${CI.navyDeep}" stop-opacity="0"/>
    </linearGradient></defs>
    <rect width="${CAR_W}" height="${CAR_H}" fill="url(#fade)"/>
    <rect width="${CAR_W}" height="240" fill="url(#top)"/>
    <text ${F} x="${PAD}" y="130" font-size="24" fill="${CI.cream}" font-weight="700" letter-spacing="5">${esc((s.kicker ?? 'IMMOBILIEN AUF ZYPERN · EU').toUpperCase())}</text>
    <text ${F} x="${PAD_R}" y="130" font-size="26" fill="${CI.cream}" text-anchor="end" font-weight="600">1/${n}</text>
    <rect x="${PAD}" y="${yTitle - 120}" width="90" height="8" rx="4" fill="${CI.coral}"/>
    <text ${FH} font-size="92" fill="${CI.cream}" font-weight="700">${tspans(title, PAD, yTitle, titleLh)}</text>
    ${s.subtitle ? `<text ${F} font-size="36" fill="${CI.line}">${tspans(sub, PAD, yTitle + title.length * titleLh + 30, subLh)}</text>` : ''}
    ${swipe(CI.cream, 28, true)}
  </svg>`
}

// Titel-Slide ohne Foto (Rückfall): Navy-Fläche.
export function coverPlainSvg(s: Extract<CarSlide, { type: 'cover' }>, n: number): string {
  return coverOverlaySvg(s, n).replace(svgOpen, `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.navy}"/>`)
}

// Punkte-Slides (list, recap) muessen in den Platz zwischen Titel und Fusszeile
// passen. Statt zu hoffen, dass die KI kurz schreibt, wird hier die naechstbeste
// Stufe gewaehlt, die wirklich hineinpasst; die letzte Stufe kuerzt notfalls mit …
const ROW_STEPS = [
  { f: 36, lh: 50, gap: 44, ml: 3, cw: 33 },
  { f: 34, lh: 46, gap: 38, ml: 3, cw: 35 },
  { f: 32, lh: 44, gap: 32, ml: 2, cw: 37 },
  { f: 30, lh: 40, gap: 26, ml: 2, cw: 40 },
]
const ROWS_BOTTOM = 1180
function fitRows(items: string[], yStart: number): { step: typeof ROW_STEPS[number]; rows: string[][] } {
  for (const step of ROW_STEPS) {
    const rows = items.map(it => wrap(it, step.cw, step.ml))
    const h = rows.reduce((a, r) => a + r.length * step.lh + step.gap, 0)
    if (yStart + h <= ROWS_BOTTOM) return { step, rows }
  }
  const step = ROW_STEPS[ROW_STEPS.length - 1]
  // Letzte Stufe reicht nicht: jeden Punkt auf eine Zeile zwingen.
  return { step, rows: items.map(it => wrap(it, step.cw, 1)) }
}

export function slideSvg(s: CarSlide, i: number, n: number): string {
  if (s.type === 'cover') return coverPlainSvg(s, n)
  // Einsatz-Slide: das zweite Cover. Im Raster sieht man auch diesen Slide, also
  // steht hier keine Hinführung, sondern der Satz, der die Sache scharf macht.
  if (s.type === 'stake') {
    const text = wrap(s.text, 20, 6)
    // Mitte zwischen Kopfzeile (150) und Fusslinie (1222) ist 686. y ist die
    // Grundlinie der ERSTEN Zeile, deshalb die halbe Blockhöhe gegenrechnen.
    const yT = Math.round(723 - (text.length - 1) * 44)
    return `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.navyDeep}"/>
      ${frame(i, n, true)}
      <rect x="${PAD}" y="${yT - 120}" width="90" height="8" rx="4" fill="${CI.coral}"/>
      <text ${FH} font-size="74" fill="${CI.cream}" font-weight="700">${tspans(text, PAD, yT, 88)}</text>
    </svg>`
  }
  if (s.type === 'cta') {
    const title = wrap(s.title, 19, 4)
    const body = wrap(s.body ?? '', 36, 5)
    const yT = 470
    const yB = yT + title.length * 92 + 50
    const btn = s.button ? wrap(s.button, 30, 1)[0] : ''
    const btnW = Math.min(840, Math.max(460, btn.length * 23 + 120))
    const yBtn = Math.max(yB + body.length * 50 + 60, 880)
    return `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.navy}"/>
      ${frame(i, n, true)}
      <rect x="${PAD}" y="${yT - 110}" width="90" height="8" rx="4" fill="${CI.coral}"/>
      <text ${FH} font-size="78" fill="${CI.cream}" font-weight="700">${tspans(title, PAD, yT, 92)}</text>
      ${s.body ? `<text ${F} font-size="36" fill="${CI.line}">${tspans(body, PAD, yB, 50)}</text>` : ''}
      ${btn ? `<rect x="${PAD}" y="${yBtn}" width="${btnW}" height="110" rx="55" fill="${CI.coral}"/>
      <text ${F} x="${PAD + btnW / 2}" y="${yBtn + 70}" font-size="38" fill="${CI.white}" font-weight="700" text-anchor="middle">${esc(btn)}</text>` : ''}
    </svg>`
  }
  if (s.type === 'fact') {
    const val = wrap(s.value, 9, 2)
    const label = wrap(s.label, 28, 3)
    const text = wrap(s.text ?? '', 40, 7)
    const yV = 470
    const yL = yV + (val.length - 1) * 160 + 110
    const yX = yL + label.length * 58 + 60
    return `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.cream}"/>
      ${frame(i, n, false)}
      <text ${FH} font-size="170" fill="${CI.navy}" font-weight="700">${tspans(val, PAD, yV, 160)}</text>
      <rect x="${PAD}" y="${yL - 62}" width="90" height="8" rx="4" fill="${CI.coral}"/>
      <text ${F} font-size="44" fill="${CI.navy}" font-weight="700">${tspans(label, PAD, yL, 58)}</text>
      ${s.text ? `<text ${F} font-size="34" fill="${CI.ink}">${tspans(text, PAD, yX, 48)}</text>` : ''}
      ${s.source ? `<text ${F} x="${PAD}" y="1180" font-size="24" fill="${CI.mute}">Quelle: ${esc(wrap(s.source, 56, 1)[0])}</text>` : ''}
    </svg>`
  }
  // Merk-Slide: die ganze Sache als Liste, ohne Zusammenhang lesbar. Das ist der
  // Slide, den Leute in die DM schicken, deshalb Nummern und keine Verweise.
  if (s.type === 'recap') {
    const title = wrap(s.title, 22, 2)
    const items = (s.items ?? []).slice(0, 6)
    const yStart = 320 + title.length * 76 + 80
    const { step, rows } = fitRows(items, yStart)
    const r = Math.min(24, Math.round(step.f * 0.68))
    let y = yStart
    const body = rows.map((lines, k) => {
      const out = `<circle cx="${PAD + r}" cy="${y - 14}" r="${r}" fill="${CI.navy}"/>
        <text ${F} x="${PAD + r}" y="${y - 4}" font-size="${Math.round(step.f * 0.74)}" fill="${CI.cream}" font-weight="700" text-anchor="middle">${k + 1}</text>
        <text ${F} font-size="${step.f}" fill="${CI.ink}">${tspans(lines, PAD + r * 2 + 22, y, step.lh)}</text>`
      y += lines.length * step.lh + step.gap
      return out
    }).join('')
    return `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.cream}"/>
      ${frame(i, n, false)}
      <rect x="${PAD}" y="210" width="90" height="8" rx="4" fill="${CI.coral}"/>
      <text ${FH} font-size="66" fill="${CI.navy}" font-weight="700">${tspans(title, PAD, 320, 76)}</text>
      ${body}
    </svg>`
  }
  if (s.type === 'list') {
    const title = wrap(s.title, 22, 2)
    const items = (s.items ?? []).slice(0, 5)
    const yStart = 320 + title.length * 76 + 70
    const { step, rows } = fitRows(items, yStart)
    let y = yStart
    const body = rows.map(lines => {
      const out = `<circle cx="${PAD + 22}" cy="${y - 13}" r="11" fill="${CI.coral}"/>
        <text ${F} font-size="${step.f}" fill="${CI.ink}">${tspans(lines, PAD + 60, y, step.lh)}</text>`
      y += lines.length * step.lh + step.gap
      return out
    }).join('')
    return `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.cream}"/>
      ${frame(i, n, false)}
      <text ${FH} font-size="66" fill="${CI.navy}" font-weight="700">${tspans(title, PAD, 320, 76)}</text>
      ${body}
    </svg>`
  }
  // point
  const title = wrap(s.title, 22, 4)
  const body = wrap(s.body, 38, 10)
  const yT = 380
  const yB = yT + title.length * 78 + 60
  return `${svgOpen}<rect width="${CAR_W}" height="${CAR_H}" fill="${CI.cream}"/>
    ${frame(i, n, false)}
    <rect x="${PAD}" y="${yT - 110}" width="90" height="8" rx="4" fill="${CI.coral}"/>
    <text ${FH} font-size="66" fill="${CI.navy}" font-weight="700">${tspans(title, PAD, yT, 78)}</text>
    <text ${F} font-size="36" fill="${CI.ink}">${tspans(body, PAD, yB, 52)}</text>
  </svg>`
}

// Hook-Overlay für Einzelbild-Posts: unterer Navy-Verlauf mit 1 bis 3 Zeilen
// Text, deutlich dezenter als das Karussell-Cover. Format „Native Text Overlay"
// (Skill visual-formats): das beiläufige Foto bleibt beiläufig, der Text liefert
// den Hook für alle, die die Caption nie aufklappen. Die Studienlage ist
// widersprüchlich (Fanpage Karma +38 % Reichweite, Agorapulse das Gegenteil),
// deshalb ist das ein Schalter und keine Umstellung.
export function hookOverlaySvg(hook: string, sub?: string): string {
  const lines = wrap(hook, 20, 3)
  const subLines = wrap(sub ?? '', 38, 2)
  const lh = 86
  const blockH = lines.length * lh + (sub ? 34 + subLines.length * 46 : 0)
  const yHook = 1180 - blockH
  return `${svgOpen}
    <defs><linearGradient id="hfade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${CI.navyDeep}" stop-opacity="0"/>
      <stop offset="0.45" stop-color="${CI.navyDeep}" stop-opacity="0.22"/>
      <stop offset="0.78" stop-color="${CI.navyDeep}" stop-opacity="0.8"/>
      <stop offset="1" stop-color="${CI.navyDeep}" stop-opacity="0.94"/>
    </linearGradient></defs>
    <rect width="${CAR_W}" height="${CAR_H}" fill="url(#hfade)"/>
    <rect x="${PAD}" y="${yHook - 116}" width="90" height="8" rx="4" fill="${CI.coral}"/>
    <text ${FH} font-size="76" fill="${CI.cream}" font-weight="700">${tspans(lines, PAD, yHook, lh)}</text>
    ${sub ? `<text ${F} font-size="34" fill="${CI.line}">${tspans(subLines, PAD, yHook + lines.length * lh + 26, 46)}</text>` : ''}
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

// Plausibilität der KI-Slides. Reihenfolge ist fest: cover, stake, 3 bis 5 aus
// fact/point/list, recap, cta. stake und recap fordert der Prompt; fehlen sie
// trotzdem, werden sie hier aus dem vorhandenen Material gebaut, statt den
// ganzen Post abzubrechen (die Automatik hat nur begrenzt Versuche).
export function normalizeSlides(raw: unknown): CarSlide[] {
  const list = (Array.isArray(raw) ? raw : []).filter(x => x && typeof x === 'object') as Array<Record<string, unknown>>
  const str = (v: unknown) => String(v ?? '').trim()
  const out: CarSlide[] = []
  for (const r of list) {
    const t = str(r.type)
    if (t === 'cover' && str(r.title)) out.push({ type: 'cover', kicker: str(r.kicker) || undefined, title: str(r.title), subtitle: str(r.subtitle) || undefined })
    else if (t === 'stake' && str(r.text)) out.push({ type: 'stake', text: str(r.text) })
    else if (t === 'fact' && str(r.value) && str(r.label)) out.push({ type: 'fact', value: str(r.value), label: str(r.label), text: str(r.text) || undefined, source: str(r.source) || undefined })
    else if (t === 'recap' && str(r.title) && Array.isArray(r.items)) out.push({ type: 'recap', title: str(r.title), items: (r.items as unknown[]).map(str).filter(Boolean) })
    else if (t === 'list' && str(r.title) && Array.isArray(r.items)) out.push({ type: 'list', title: str(r.title), items: (r.items as unknown[]).map(str).filter(Boolean) })
    else if (t === 'point' && str(r.title) && str(r.body)) out.push({ type: 'point', title: str(r.title), body: str(r.body) })
    else if (t === 'cta' && str(r.title)) out.push({ type: 'cta', title: str(r.title), body: str(r.body) || undefined, button: str(r.button) || undefined })
  }
  const cover = out.find(s => s.type === 'cover')
  const cta = [...out].reverse().find(s => s.type === 'cta')
  const middle = out.filter(s => s.type === 'fact' || s.type === 'point' || s.type === 'list').slice(0, 5)
  if (!cover) throw new Error('Karussell: kein Titel-Slide.')
  if (middle.length < 3) throw new Error('Karussell: zu wenige verwertbare Slides.')

  // Einsatz-Slide: vom Modell, sonst aus dem Untertitel des Covers, sonst aus
  // dem ersten Inhalts-Slide. Nie aus dem Titel selbst, sonst steht es doppelt.
  let stake = out.find(s => s.type === 'stake') as Extract<CarSlide, { type: 'stake' }> | undefined
  if (!stake) {
    const m0 = middle[0]
    const borrowed = cover.subtitle
      || (m0.type === 'fact' ? [m0.label, m0.text].filter(Boolean).join(': ') : m0.type === 'point' ? m0.body : m0.items[0])
    if (borrowed) stake = { type: 'stake', text: wrap(borrowed, 100, 1)[0] }
  }

  // Merk-Slide: vom Modell, sonst aus den Kernaussagen der Inhalts-Slides.
  let recap = [...out].reverse().find(s => s.type === 'recap' && s.items.length >= 3) as Extract<CarSlide, { type: 'recap' }> | undefined
  if (!recap) {
    const pts: string[] = []
    for (const m of middle) {
      if (m.type === 'fact') pts.push(wrap(`${m.value}: ${m.label}`, 58, 1)[0])
      else if (m.type === 'point') pts.push(wrap(m.title, 58, 1)[0])
      else for (const it of m.items) pts.push(wrap(it, 58, 1)[0])
    }
    const uniq = [...new Set(pts.filter(Boolean))].slice(0, 6)
    if (uniq.length >= 3) recap = { type: 'recap', title: 'Zum Mitnehmen', items: uniq }
  }

  return [cover, ...(stake ? [stake] : []), ...middle, ...(recap ? [recap] : []), ...(cta ? [cta] : [])]
}
