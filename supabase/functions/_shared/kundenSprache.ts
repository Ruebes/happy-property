// In welcher Sprache Lotte einem Kunden antwortet (Sven 30.10.2026): immer in der
// Sprache, in der der Kunde schreibt. Anlass: Fulya Savgu schreibt seit dem 29.10.
// nur Englisch, Lottes Fakten-Antwort am 30.10. kam trotzdem auf Deutsch.
//
// Lotte formuliert weiter deutsch. Übersetzt wird erst beim Versand in
// send-whatsapp (translateOutbound), derselbe Weg wie bei Drip und Reaktivierung.
// So greifen alle Sperren (Rendite, Namen, Geld, Gedankenstrich) am deutschen Text,
// bevor er übersetzt wird. Erkannt werden deshalb nur Deutsch und Englisch: in
// andere Sprachen übersetzt send-whatsapp nicht.
//
// Reine Funktionen ohne DB, offline geprüft in scripts/verify-lotte-regeln.mjs.

export type Sprache = 'de' | 'en'

// Nur Wörter, die es in der anderen Sprache nicht (oder kaum) gibt. Bewusst NICHT
// dabei: in, an, am, was, will, also, so, man, kind, im ("im interested"), ok,
// super, info, information, apartment, hi, hey, meeting, nice. Die kommen in
// beiden Sprachen vor und würden kippen.
const DE = new Set([
  'ich', 'du', 'dich', 'dir', 'mich', 'mir', 'wir', 'uns', 'euch', 'ihr', 'ihnen', 'ihm', 'sie', 'er', 'es',
  'und', 'oder', 'aber', 'nicht', 'kein', 'keine', 'keinen', 'ist', 'sind', 'bin', 'bist', 'seid', 'war', 'waren',
  'hat', 'habe', 'haben', 'hast', 'hatte', 'wird', 'werde', 'werden', 'wurde', 'kann', 'kannst', 'könnte',
  'möchte', 'möchten', 'würde', 'würden', 'soll', 'sollte', 'muss', 'gern', 'gerne', 'bitte', 'danke', 'dank',
  'vielen', 'hallo', 'moin', 'servus', 'guten', 'morgen', 'abend', 'tag', 'mit', 'für', 'von', 'vom', 'zum', 'zur',
  'auf', 'aus', 'bei', 'nach', 'über', 'wie', 'wo', 'wann', 'warum', 'welche', 'welcher', 'welches', 'wer',
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'noch', 'schon',
  'auch', 'nur', 'sehr', 'mal', 'doch', 'ja', 'nein', 'mein', 'meine', 'meinen', 'dein', 'deine', 'unser',
  'unsere', 'sich', 'dass', 'weil', 'wenn', 'ob', 'damit', 'dann', 'jetzt', 'heute', 'zu', 'ins', 'um', 'bis',
  'seit', 'ohne', 'gegen', 'durch', 'unter', 'zwischen', 'immer', 'wieder', 'gleich', 'bald', 'vielleicht',
  'eigentlich', 'leider', 'wirklich', 'ganz', 'mehr', 'viel', 'viele', 'gut', 'alles', 'etwas', 'nichts', 'hier',
  'dort', 'wohnung', 'wohnungen', 'haus', 'preis', 'frage', 'fragen', 'liebe', 'lg', 'vg', 'mfg', 'passt',
  'genau', 'gibt', 'geht', 'suche', 'suchen', 'kaufen', 'mieten', 'wohnen', 'termin', 'uhr', 'woche',
])
const EN = new Set([
  'i', "i'm", "i've", "i'd", "i'll", 'you', "you're", 'your', 'we', "we're", 'our', 'they', 'them', 'their',
  'he', 'she', 'him', 'her', 'his', 'it', "it's", 'its', 'is', 'are', 'were', 'be', 'been', 'the', 'a', 'and',
  'or', 'but', 'not', 'yes', 'yeah', 'do', 'does', 'did', "don't", "doesn't", "didn't", 'have', 'has', 'had',
  'can', "can't", 'could', 'would', 'should', 'shall', 'may', 'might', 'please', 'thanks', 'thank', 'hello',
  'good', 'morning', 'afternoon', 'evening', 'with', 'for', 'from', 'to', 'of', 'on', 'at', 'by', 'about',
  'what', "what's", 'when', 'where', 'why', 'which', 'who', 'how', 'this', 'that', "that's", 'these', 'those',
  'there', 'here', 'my', 'me', 'any', 'some', 'more', 'very', 'much', 'many', 'just', 'only', 'still', 'already',
  'if', 'because', 'than', 'then', 'now', 'today', 'tomorrow', 'like', 'looking', 'interested', 'know', 'want',
  'need', 'get', 'see', "let's", 'regards', 'dear', 'cheers', 'available', 'possible', 'price',
  'property', 'properties', 'house', 'flat', 'buy', 'rent', 'stay', 'visit', 'construction', 'planning',
  'building', 'sea', 'beach', 'far', 'near', 'again', 'all', 'great', 'sure', 'send',
])

function woerter(text: string): string[] {
  return text.toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/<[^>]*>/g, ' ')   // geteilte Standorte kommen als <a href=...>
    .replace(/https?:\/\/\S+|\S+@\S+|\b[\w-]+\.(com|de|cy|eu|net|org|at|ch)\b\S*/g, ' ')
    .match(/[a-zäöüß]+(?:'[a-z]+)?/g) ?? []
}

/** Sprache EINER Nachricht, oder null, wenn sie zu kurz oder nicht eindeutig ist. */
export function spracheErkennen(text: string): Sprache | null {
  let de = 0, en = 0
  for (const w of woerter(text)) {
    if (DE.has(w) || /[äöüß]/.test(w)) de++
    else if (EN.has(w)) en++
  }
  if (de >= 2 && de >= 2 * en + 1) return 'de'
  if (en >= 2 && en >= 2 * de + 1) return 'en'
  return null
}

/** Antwortsprache: die letzte Nachricht; ist sie zu kurz ("ok", "Thanks!"), die
 *  jüngste eindeutige davor (neueste zuerst); dann die Sprache im Kontakt;
 *  sonst Deutsch. */
export function antwortSprache(letzte: string, frueher: string[], kontakt: string | null | undefined): Sprache {
  const jetzt = spracheErkennen(letzte)
  if (jetzt) return jetzt
  for (const t of frueher) {
    const s = spracheErkennen(t)
    if (s) return s
  }
  return kontakt === 'en' ? 'en' : 'de'
}

const LAENGER = 6   // Wörter, ab denen eine Nachricht als längere Nachricht zählt

/** Schreibt der Kunde erkennbar dauerhaft Englisch? Unter seinen letzten sechs
 *  Nachrichten (neueste zuerst) mindestens zwei längere englische und keine
 *  deutsche. Doppelte Nachrichten zählen einmal. */
export function dauerhaftEnglisch(nachrichten: string[]): boolean {
  const letzte = [...new Set(nachrichten.map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 6)
  if (letzte.some(t => spracheErkennen(t) === 'de')) return false
  return letzte.filter(t => woerter(t).length >= LAENGER && spracheErkennen(t) === 'en').length >= 2
}

export const SPRACH_BETREFF = '🌐 Lotte: Sprache auf Englisch gestellt'

/** Notiz für Sven, wenn Lotte die Sprache im Kontakt umstellt. */
export function sprachNotiz(vorname: string | null, nachrichten: string[]): string {
  const wer = vorname?.trim() || 'Der Kunde'
  const belege = nachrichten.filter(t => spracheErkennen(t) === 'en').slice(0, 3)
    .map(t => `„${t.replace(/\s+/g, ' ').trim().slice(0, 160)}“`)
  return [
    `${wer} schreibt dauerhaft Englisch. Lotte hat die Sprache im Kontakt deshalb auf Englisch gestellt: Lottes Antworten, die automatischen Nachrichten und deine Nachrichten aus dem CRM gehen ab jetzt übersetzt auf Englisch raus.`,
    '',
    'Die letzten Nachrichten:',
    ...belege,
    '',
    'Falsch erkannt? Im Kontakt auf Bearbeiten klicken und die Sprache wieder auf Deutsch stellen. Lotte stellt sie danach nicht noch einmal um.',
  ].join('\n')
}
