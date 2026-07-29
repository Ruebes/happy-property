// HTML → Text / WhatsApp für die Live-Vorschau im Newsletter-Editor.
// IDENTISCH zu supabase/functions/_shared/htmlToText.ts + htmlToWhatsapp.ts,
// damit die Vorschau exakt dem entspricht, was versendet wird. Beim Ändern
// BEIDE Seiten anpassen. Reine String-Operationen (kein DOM nötig).

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
    .replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, url, label) => {
      const text = String(label).replace(/<[^>]+>/g, '').trim()
      if (/^(mailto:|tel:)/i.test(url)) return text || url.replace(/^(mailto:|tel:)/i, '')
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

const WA_MAX = 3800
export function htmlToWhatsapp(html: string): string {
  if (!html) return ''
  let s = html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `*${String(inner).replace(/<[^>]+>/g, '').trim()}*`)
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `_${String(inner).replace(/<[^>]+>/g, '').trim()}_`)
    .replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, url, label) => {
      const text = String(label).replace(/<[^>]+>/g, '').trim()
      if (/^(mailto:|tel:)/i.test(url)) return text || url.replace(/^(mailto:|tel:)/i, '')
      if (!text || text === url) return url
      return `${text}: ${url}`
    })
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|ul|ol|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (s.length > WA_MAX) s = s.slice(0, WA_MAX).replace(/\s+\S*$/, '') + ' …'
  return s
}
