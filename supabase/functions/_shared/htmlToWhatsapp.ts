// HTML → brauchbare WhatsApp-Version. Baut auf der Entity-Dekodierung von
// htmlToText auf, erzeugt aber WhatsApp-Formatierung: *fett*, _kursiv_, Listen
// mit „• ", Links als „Label: URL" (WhatsApp verlinkt URLs automatisch).
// Reine String-Operationen → läuft in Deno UND im Browser (Frontend hat eine
// identische Kopie in src/lib/htmlDerive.ts; beim Ändern BEIDE anpassen).
import { decodeEntities } from './htmlToText.ts'

const WA_MAX = 3800   // WhatsApp-Limit ~4096 Zeichen, Puffer lassen

export function htmlToWhatsapp(html: string): string {
  if (!html) return ''
  let s = html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `*${String(inner).replace(/<[^>]+>/g, '').trim()}*`)
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `_${String(inner).replace(/<[^>]+>/g, '').trim()}_`)
    // Links: „Label: URL" (mailto/tel ohne Doppelung, verlinkte Klartext-URL nicht doppeln)
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
