// Robuste HTML → Plaintext-Konvertierung für die Text-Alternative von E-Mails.
// WICHTIG: HTML-Entities (&uuml;, &rarr;, &#128196; …) MÜSSEN dekodiert werden —
// sonst sieht ein Empfänger, dessen Client den Plaintext-Teil zeigt, rohen
// Entity-Müll ("f&uuml;r", "&#128196;"). Außerdem Block-Tags → Zeilenumbrüche,
// Links als "Label: URL" erhalten.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  uuml: 'ü', ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä', szlig: 'ß',
  euro: '€', pound: '£', cent: '¢', copy: '©', reg: '®', trade: '™', deg: '°',
  middot: '·', bull: '•', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚',
  rarr: '→', larr: '←', harr: '↔', uarr: '↑', darr: '↓',
  times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', hyphen: '-', shy: '',
  eacute: 'é', egrave: 'è', agrave: 'à', uacute: 'ú', oacute: 'ó', aacute: 'á', ntilde: 'ñ', ccedil: 'ç',
}

function cp(n: number): string {
  try {
    if (n === 0x9 || n === 0xa) return String.fromCodePoint(n)
    if (n >= 0x20 && n !== 0x7f && n <= 0x10ffff) return String.fromCodePoint(n)
    return ''
  } catch { return '' }
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => cp(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, n) => (n in NAMED ? NAMED[n] : m))
}

export function htmlToText(html: string): string {
  if (!html) return ''
  const stripped = html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // <a href="URL">Label</a> → "Label: URL" (mailto/tel ohne Doppelung)
    .replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, url, label) => {
      const text = String(label).replace(/<[^>]+>/g, '').trim()
      if (/^(mailto:|tel:)/i.test(url)) return text || url.replace(/^(mailto:|tel:)/i, '')
      // Label = URL (verlinkte Klartext-Adresse) → nicht doppeln
      if (!text || text === url) return url
      return `${text}: ${url}`
    })
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote)>/gi, '\n')
    .replace(/<\/td>/gi, '  ')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(stripped)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
