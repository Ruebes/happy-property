// Nackte Links in Mails als Buttons (Sven 31.10.26: „Wir wollen in den Mails keine
// Hyperlinks. Wir wollen schöne Buttons haben.").
//
// Läuft zentral in buildMimeContent, also für jede Mail aus send-email,
// process-scheduled-messages und den Portal-Zugängen. Umgewandelt werden nur
// Links, die als Text sichtbar wären:
//   • eine URL im Fließtext (Plain-Text-Vorlagen, WhatsApp-Ersatzmails)
//   • ein <a>, dessen sichtbarer Text selbst die URL ist
// Gestaltete Buttons und verlinkte Wörter in HTML-Vorlagen bleiben unverändert.
//
// Beschriftung: Steht vor der URL auf derselben Zeile ein kurzer Text mit
// Doppelpunkt („Termin buchen: https://…"), wird er zur Button-Beschriftung.
// Sonst ergibt sie sich aus dem Ziel (Zoom, Termin verwalten, Deck, …).

const URL_RE = /https?:\/\/[^\s<>"']+/g
const KURZ_MAX = 45

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// &amp; aus dem HTML-Text zurück in die echte URL
function unesc(s: string): string {
  return s.replace(/&amp;/g, '&')
}

export function buttonLabel(url: string): string {
  const u = url.toLowerCase()
  if (u.includes('zoom.us/')) return 'Zum Zoom-Meeting'
  if (u.includes('/termin/verwalten')) return 'Termin verschieben oder absagen'
  if (u.includes('/termin') || u.includes('/buchen/')) return 'Termin buchen'
  if (u.includes('/rechnung/')) return 'Berechnung ansehen'
  if (u.includes('/simulator/')) return 'Strategie ansehen'
  if (u.includes('/deck/') || u.includes('/d/')) return 'Unterlagen ansehen'
  if (u.includes('/bewertung/')) return 'Bewertung abgeben'
  if (u.includes('youtube.com') || u.includes('youtu.be') || u.includes('video')) return 'Video ansehen'
  if (u.includes('maps.app.goo.gl') || u.includes('google.com/maps') || u.includes('goo.gl/maps')) return 'Route öffnen'
  if (u.includes('/login') || u.includes('portal.happy-property.com/s/')) return 'Öffnen'
  return 'Jetzt ansehen'
}

export function buttonHtml(url: string, label: string): string {
  return `<a href="${esc(url)}" target="_blank" style="display:inline-block;background:#ff795d;color:#ffffff;`
    + 'text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;'
    + `line-height:1.3;padding:12px 24px;border-radius:10px;margin:6px 0;white-space:normal">${esc(label)} &rarr;</a>`
}

// Trennt Satzzeichen am Ende ab, die nicht zur URL gehören („…/termin.")
function splitTrailing(raw: string): [string, string] {
  const m = raw.match(/[.,;:!?)\]]+$/)
  return m ? [raw.slice(0, -m[0].length), m[0]] : [raw, '']
}

function textSegment(seg: string): string {
  if (!seg.includes('http')) return seg
  let out = ''
  let pos = 0
  for (const m of seg.matchAll(URL_RE)) {
    const start = m.index ?? 0
    const [rawUrl, trail] = splitTrailing(m[0])
    const url = unesc(rawUrl)
    let before = seg.slice(pos, start)
    // Zeilenanfang innerhalb des Segments
    const nl = before.lastIndexOf('\n')
    const lineHead = before.slice(nl + 1)
    const rest = seg.slice(start + m[0].length)
    const restLine = rest.split('\n')[0]
    const kopf = lineHead.replace(/\s*(→|&rarr;)?\s*:\s*$/, '').replace(/\s*(→|&rarr;)\s*$/, '').trim()
    let label = buttonLabel(url)
    // Kurzer Text mit Doppelpunkt direkt davor und nichts dahinter: wird zur Beschriftung
    if (/:\s*$/.test(lineHead) && kopf && kopf.length <= KURZ_MAX && !/[.!?]/.test(kopf) && !restLine.trim()) {
      const k = kopf.replace(/^[^\p{L}\p{N}]+/u, '')
      // „Zoom-Link:" / „Link:" sagt nichts, dann lieber die Beschriftung nach Ziel
      if (k && !/link$/i.test(k)) label = k
      before = before.slice(0, nl + 1)
    }
    // Satzzeichen hinter dem Link fallen weg, wenn die Zeile dort endet. Steht der
    // Link mitten in einem Satz, kommt der Button in eine eigene Zeile.
    const zeileEndet = !restLine.trim()
    const brauchtUmbruch = before.slice(before.lastIndexOf('\n') + 1).trim() !== ''
    out += before + (brauchtUmbruch ? '<br>' : '') + buttonHtml(url, label) + (zeileEndet || trail === ':' ? '' : trail)
    pos = start + m[0].length
  }
  return out + seg.slice(pos)
}

export function linksAlsButtons(html: string): string {
  if (!html || !html.includes('http')) return html
  // 1. <a href="X">X</a> (sichtbarer Text = URL) zurück auf die nackte URL
  let s = html.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>\s*(https?:\/\/[^<\s]+)\s*<\/a>/gi,
    (_all, href: string) => href.replace(/&(?!amp;)/g, '&amp;'))
  // 2. Nur Text außerhalb von Tags, <a>, <style> und <script> umwandeln
  const parts = s.split(/(<[^>]+>)/)
  let inA = 0, inRaw = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.startsWith('<')) {
      const tag = p.toLowerCase()
      if (/^<a[\s>]/.test(tag)) inA++
      else if (tag.startsWith('</a')) inA = Math.max(0, inA - 1)
      else if (/^<(style|script)[\s>]/.test(tag)) inRaw++
      else if (/^<\/(style|script)/.test(tag)) inRaw = Math.max(0, inRaw - 1)
      continue
    }
    if (!inA && !inRaw) parts[i] = textSegment(p)
  }
  s = parts.join('')
  return s
}
