// Eine Handlung je Beitrag (Sven 7.11.2026: „Jeder Beitrag bekommt nur noch eine
// Handlungsaufforderung statt drei"). Läuft beim Veröffentlichen, nur für Instagram und
// Facebook. LinkedIn und YouTube bekommen den Text unverändert.
//
// Vorrang:
//  - Bis zum Beginn der Live-Masterclass gewinnt ihre Zeile auf beiden Plattformen.
//    Danach fällt eine stehengebliebene Masterclass-Zeile weg.
//  - Instagram: Stichwort vor Termin, weil Links im Instagram-Text nicht klickbar sind
//    und das Stichwort die Automatik auslöst.
//  - Facebook: Termin vor Stichwort, weil der Link dort klickbar ist.
//  - Eine Frage an die Leser („Schreib's in die Kommentare") kommt zuletzt.

export const MASTERCLASS_ENDE_MS = Date.parse('2026-11-15T10:00:00Z')

type Art = 'masterclass' | 'termin' | 'stichwort' | 'frage'

const RE_MASTERCLASS = /s\/masterclass/i
const RE_TERMIN_LINK = /portal\.happy-property\.com\/termin/i
const RE_BIO = /(?<![\p{L}\p{N}_])(?:Bio[- ]?Link|[Bb]io)(?![\p{L}\p{N}_-])/u
const RE_FRAGE = /in die Kommentare/i
const SATZ = /(?<=[.!?…])\s+/
const NUR_ZEICHEN = /^[\s·•|,.:\-\p{Extended_Pictographic}️‍]*$/u

const istTermin = (s: string) => RE_TERMIN_LINK.test(s) || RE_BIO.test(s)

function artVon(zeile: string, plattform: 'instagram' | 'facebook', istStichwort: (z: string) => boolean): Art | null {
  if (RE_MASTERCLASS.test(zeile)) return 'masterclass'
  // Facebook hat keine Bio. fbCaption nimmt solche Sätze ohnehin heraus, also zählen sie dort nicht.
  if (plattform === 'facebook' ? RE_TERMIN_LINK.test(zeile) : istTermin(zeile)) return 'termin'
  if (istStichwort(zeile)) return 'stichwort'
  if (RE_FRAGE.test(zeile)) return 'frage'
  return null
}

function aufraeumen(rest: string): string {
  const t = rest.trim()
  return NUR_ZEICHEN.test(t) ? '' : t
}

// Nimmt den Aufruf und die Frage davor heraus. Der Rest der Zeile bleibt, zum Beispiel
// „Das ist eine kleine Auswahl aus gut 200 Objekten …" vor „Lieber Stadtnähe …? Schreib's …".
function ohneFrage(zeile: string): string {
  const saetze = zeile.split(SATZ)
  const i = saetze.findIndex(s => RE_FRAGE.test(s))
  if (i < 0) return zeile
  const von = i > 0 && /\?\s*$/.test(saetze[i - 1]) ? i - 1 : i
  saetze.splice(von, i - von + 1)
  return aufraeumen(saetze.join(' '))
}

const ohneSaetze = (zeile: string, trifft: (s: string) => boolean) =>
  aufraeumen(zeile.split(SATZ).filter(s => !trifft(s)).join(' '))

export function einCta(
  text: string,
  plattform: 'instagram' | 'facebook',
  istStichwort: (zeile: string) => boolean,
  jetztMs: number = Date.now(),
): string {
  const zeilen = String(text ?? '').split(/\r?\n/)
  const arten = zeilen.map(z => artVon(z, plattform, istStichwort))
  const vorhanden = new Set(arten.filter((a): a is Art => a != null))
  if (!vorhanden.size) return text

  const vorrang: Art[] = plattform === 'instagram'
    ? ['masterclass', 'stichwort', 'termin', 'frage']
    : ['masterclass', 'termin', 'stichwort', 'frage']
  const sieger = vorrang
    .filter(a => a !== 'masterclass' || jetztMs < MASTERCLASS_ENDE_MS)
    .find(a => vorhanden.has(a)) ?? null

  let siegerSteht = false
  let geaendert = false
  const neu: string[] = []
  zeilen.forEach((zeile, i) => {
    const art = arten[i]
    if (!art) { neu.push(zeile); return }
    if (art === sieger && !siegerSteht) { siegerSteht = true; neu.push(zeile); return }
    geaendert = true
    // Die Masterclass-Zeile steht immer für sich und fällt ganz weg. Bei den anderen bleibt
    // der übrige Text der Zeile stehen, nur der Aufruf geht raus.
    const rest = art === 'masterclass' ? ''
      : art === 'frage' ? ohneFrage(zeile)
      : ohneSaetze(zeile, art === 'termin' ? istTermin : istStichwort)
    if (rest) neu.push(rest)
  })
  if (!geaendert) return text
  return neu.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}
