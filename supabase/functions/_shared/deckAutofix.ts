// Deck-Autobereinigung v1: streicht oder korrigiert eng begrenzte Textbefunde,
// BEVOR ein Deck gespeichert wird. Deterministisch, ohne KI, ohne Netz, ohne DB.
//
// Leitsatz bleibt der des Gates: nichts passiert STILL. Jede Korrektur steht mit
// vorher/nachher im Pruefbericht (quality_report.autofix), und die unbereinigte
// KI-Fassung liegt in sales_decks.prev_content - ein Klick auf „Letzte Änderung
// rückgängig" im Deck-Chat stellt sie samt Ampel wieder her (refine-deck).
//
// Grenzen (Sven 12.10.26, „nichts verschlimmbessern"):
//   - nur Befunde aus AUTOFIX_RULES, nur in KI-Bloecken, nie in Systembloecken
//     (payment/gallery/marina/video/masterplan/amenity, Marina-Modellbild)
//   - nie deterministische Felder, nie Ueberschriften, Titel, Nummern, Schritte
//   - Behauptungen werden NUR gestrichen, nie umformuliert
//   - Ersatzwerte nur fuer Zimmer/Bad/Etage in Listenpunkten, aus festen Vorlagen
//   - jede Korrektur einzeln gegen das Gate geprueft (Ziel weg, nichts Neues),
//     sonst genau diese Korrektur zurueck
//   - Gesamtpruefung am Ende, sonst ALLES zurueck (Status rolled_back)
//   - Bloecke werden nie eingefuegt oder entfernt: alle Blockindizes bleiben gueltig
//
// Rechenkerne (deckVat, deckBlocks, deckNormalize) werden nur lesend importiert.
// ACHTUNG (CLAUDE.md Regel 8): Aenderung wirkt erst nach Redeploy jeder
// importierenden Function (generate-deck).

import { DETERMINISTIC_FIELDS, type Block } from './deckBlocks.ts'
import { unitKey } from './deckVat.ts'
import { MARINA_MODEL, type DeckContext, type DeckUnitCtx } from './deckContext.ts'
import { runDeckGate, type Finding, type Severity } from './deckGate.ts'

export type AutofixMode = 'off' | 'dry_run' | 'on'

export type AutofixAction = 'satz_entfernt' | 'punkt_entfernt' | 'karte_entfernt' | 'feld_geleert' | 'wert_gesetzt'

// Einzelne Saetze aus mehrsaetzigem Fliesstext herausschneiden ist AUS (v1, 12.10.26).
// Drei unabhaengige Pruefrunden fanden jedes Mal neue Faelle, in denen der Resttext
// danach nicht mehr stimmte (Kuerzel, Aufzaehlungen, Ankuendigungen, Zeilenlisten).
// Bereinigt werden nur ganze Einheiten: Listenpunkt, Karte (Titel getroffen oder Text
// nur aus der Aussage), Tagline, ein Feld, das nur aus der beanstandeten Aussage
// besteht, und Zaehlwerte. Satz im Fliesstext bleibt als Befund fuer Sven stehen
// (Grund 'fliesstext'). Ganze Absaetze im Anschreiben fallen nie weg (Runde 5).
const PROSA_CHIRURGIE = false
export type RollbackCode = 'blockzahl' | 'blockfolge' | 'systemblock' | 'festes_feld' | 'ohne_korrektur'
  | 'zu_viele' | 'textanteil' | 'rot_mehr' | 'nichts_behoben'
export type SkipReason = 'systemblock' | 'gesperrtes_feld' | 'html_feld' | 'nicht_lokalisierbar' | 'mehrdeutig'
  | 'pflichtfeld' | 'zu_wenige_karten' | 'neuer_befund' | 'ziel_nicht_behoben' | 'limit' | 'kontext' | 'fliesstext'

export interface AutofixChange {
  finding_key: string
  severity: Severity
  /** Befundtext, gekuerzt - fuer die Anzeige im Pruefbericht. */
  what: string
  block: number
  block_type: string
  field: string
  action: AutofixAction
  before: string
  after: string
  /** 'fakt_hinterlegen' bei gestrichenen Behauptungen. */
  hint?: string
}

export interface AutofixReport {
  version: 1
  mode: AutofixMode
  status: 'applied' | 'dry_run' | 'nothing_to_fix' | 'rolled_back' | 'error' | 'undone'
  rollback_reason?: string
  /** Fester Code zu rollback_reason, fuer die Uebersetzung im Pruefbericht. */
  rollback_code?: RollbackCode
  error?: string
  /** findings nur bei status 'applied': die Ruecknahme in refine-deck braucht sie,
   *  sonst stuenden alle Befunde doppelt im quality_report. */
  before: { status: 'green' | 'red'; red: number; findings?: Finding[] }
  after: { status: 'green' | 'red'; red: number }
  /** generate-deck hat die Behauptungen auf dem bereinigten Deck neu von der KI pruefen
   *  lassen (true) bzw. die Nachpruefung ist ausgefallen und die alten Befunde gelten (false). */
  claims_rechecked?: boolean
  changes: AutofixChange[]
  fixed_findings: Array<{ key: string; block?: number; what: string; via: 'korrektur' | 'mit_entfernt' }>
  skipped: Array<{ key: string; block?: number; what: string; reason: SkipReason }>
  applied_at: string
}

export interface AutofixResult {
  blocks: Block[]
  findings: Finding[]
  /** Zahl der uebernommenen Aenderungen (0 im Probelauf und bei Ruecknahme). */
  applied: number
  report: AutofixReport
}

/** Bereinigbare Befunde: Schwere -> erlaubt. Alles andere bleibt fuer Sven. */
export const AUTOFIX_RULES: Record<string, Severity[]> = {
  behauptung_unsupported: ['hoch'],
  behauptung_conflict: ['hoch'],
  renditeaussage: ['hoch'],
  betrag_fremd: ['hoch'],
  preis_im_fliesstext: ['mittel', 'hoch'],
  zimmer_abweichung: ['hoch'],
  bad_abweichung: ['mittel', 'hoch'],
  etage_abweichung: ['hoch'],
  flaeche_abweichung: ['hoch'],
}

/** Bloecke, die das System aus dem CRM bzw. kuratierten Daten setzt. Bewusst eine
 *  eigene Liste: SYSTEM_BLOCK_TYPES (deckBlocks.ts) kennt payment und gallery nicht. */
export const LOCKED_TYPES = new Set(['payment', 'gallery', 'marina', 'video', 'masterplan', 'amenity'])

/** Oberste Feldnamen, die die Bereinigung nie anfasst. */
const LOCKED_KEYS = new Set<string>([
  ...DETERMINISTIC_FIELDS, 'type', 'number', 'imageIntent', 'assetId', 'headline', 'title', 'kicker', 'forLine',
  'nickname', 'signoff', 'signName', 'steps', 'planNote', 'items', 'caption', 'link', 'linkLabel',
  'legend', 'features', 'phase1', 'phase2', 'planLabel', 'video',
])

/** Systemfelder, in denen gar nicht erst gesucht wird: deterministisch gesetzt
 *  (Preiszeilen, Karte, Bild) oder Verweise - wie SKIP_KEYS im Gate. Ein Preis in
 *  den Preiszeilen ist kein Treffer, der die Fliesstext-Stelle sperrt. */
const NIE_SUCHEN = new Set<string>([...DETERMINISTIC_FIELDS, 'assetId', 'link', 'linkLabel', 'planLabel', 'video'])

const MAX_CHANGES = 10
const MAX_ANTEIL_GESAMT = 0.15
const MAX_ANTEIL_BLOCK = 0.5
const ROT: Severity[] = ['kritisch', 'hoch']
const SEV_RANG: Record<Severity, number> = { kritisch: 0, hoch: 1, mittel: 2, niedrig: 3 }
const HTML = /<[a-z]/i
/** Formatierter Text: HTML, Zeichen-Codes (&nbsp;) oder Markdown-Fett. Solche Felder
 *  fasst die Bereinigung nicht an - die Satztrennung kennt diese Zeichen nicht. */
const MARKUP = (s: string) => HTML.test(s) || /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i.test(s) || s.includes('**')
/** Alle Texte eines Objekts (auch verschachtelt) - fuer Karten und Listenobjekte,
 *  die als Ganzes entfallen. */
const alleTexte = (x: unknown): string[] => typeof x === 'string' ? [x]
  : Array.isArray(x) ? x.flatMap(alleTexte)
  : x && typeof x === 'object' ? Object.values(x as Record<string, unknown>).flatMap(alleTexte) : []
const kurz = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// ── Normalisierung fuer die Suche ────────────────────────────────────────────
// Kleinschrift, Anfuehrungszeichen und Striche vereinheitlicht, Leerraum
// zusammengefasst. map[i] = Index im Original fuer jedes Zeichen von out.
function normMap(s: string): { out: string; map: number[] } {
  let out = ''
  const map: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s[i]
    if (/["„“”«»‚‘’'`´]/.test(c)) c = "'"
    else if (/[‐‑‒–—―−]/.test(c)) c = '-'
    else if (/\s/.test(c)) {
      if (!out.length || out.endsWith(' ')) continue
      c = ' '
    }
    for (const ch of c.toLowerCase()) { out += ch; map.push(i) }
  }
  while (out.endsWith(' ')) { out = out.slice(0, -1); map.pop() }
  return { out, map }
}
const norm = (s: string) => normMap(s).out

/** Aussage fuer die Suche saeubern: umschliessende Anfuehrungszeichen und
 *  Satzzeichen am Ende weg. */
function claimNorm(s: string): string {
  return norm(s).replace(/^['\s]+/, '').replace(/['\s.!?;:,]+$/, '')
}

const WORTZEICHEN = /[\p{L}\p{N}]/u
const ZIFFER = /\p{N}/u

/** Alle Fundstellen von needle (normalisiert) im Original-Text als [start, end).
 *  Nur an Wort- und Zahlgrenzen: „6 m²" trifft nicht „16 m²", „9.000 €" nicht
 *  „19.000 €", „ein Pool" nicht „kein Poolhaus". streng (Behauptungen): auch
 *  dahinter kein Buchstabe und keine Ziffer. Sonst (Gate-Treffer) dahinter nur
 *  keine Ziffer - das Gate meldet „4 Schlafzimmer" auch aus „4 Schlafzimmern". */
function spans(text: string, needle: string, streng: boolean): Array<[number, number]> {
  if (!needle) return []
  const { out, map } = normMap(text)
  const res: Array<[number, number]> = []
  const erstes = needle[0], letztes = needle[needle.length - 1]
  let from = 0
  for (;;) {
    const at = out.indexOf(needle, from)
    if (at < 0) break
    from = at + 1
    const end = at + needle.length
    const vor = out[at - 1] ?? '', vorvor = out[at - 2] ?? '', nach = out[end] ?? ''
    if (WORTZEICHEN.test(erstes) && WORTZEICHEN.test(vor)) continue
    // Tausender- oder Dezimaltrenner davor: „9.000" in „19.000", „5 m²" in „84,5 m²"
    if (ZIFFER.test(erstes) && /[.,]/.test(vor) && ZIFFER.test(vorvor)) continue
    if (WORTZEICHEN.test(letztes) && (streng ? WORTZEICHEN : ZIFFER).test(nach)) continue
    res.push([map[at], map[end - 1] + 1])
    from = end
  }
  return res
}

// ── Satztrennung (abkuerzungsfest) ───────────────────────────────────────────
// Eigene Trennung, die naive in deckNormalize.ts bleibt unberuehrt. Getrennt wird
// nur bei . ! ? + Leerraum + Grossbuchstabe/Ziffer/oeffnendes Zeichen - nicht nach
// Ordnungszahlen („2. Etage", „1. Oktober") und nicht nach Abkuerzungen.
// Monatskuerzel („Sept. 2028"), Anreden („Mr. Smith"), „Co. KG", „S. 4", „2 Std.
// Fahrt" trennen nie. Bewusst NICHT: usw./etc./Ltd. - davor klein weiter heisst
// ohnehin kein Schnitt, gross weiter ist dort fast immer ein echtes Satzende.
// Ausnahme Mass- und Mengenkuerzel direkt hinter einer Zahl („5 Min. Die Anlage",
// „12 Mio. Der Bau"): beginnt danach erkennbar ein Satz (SATZANFANG), wird getrennt.
// Monatskuerzel zaehlen nur vor Tag oder Jahr, max./min. nur neben einer Zahl -
// sonst ist es ein Vorname oder ein Satzende („Lieber Max. Die Anlage ...").
const MONAT_KUERZEL = ['jan', 'feb', 'mär', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'okt', 'oct', 'nov', 'dez', 'dec']
const ABK = new Set(['ca', 'nr', 'bzw', 'inkl', 'zzgl', 'ggf', 'evtl', 'vgl', 'max', 'min', 'dr', 'prof', 'st', 'str',
  'art', 'wfl', 'ave', 'apt', 'fr', 'hr', 'bj', 'zi',
  'tel', 'mio', 'mrd', 'bzgl', 'sog', 'ggü', 'z.b', 'u.a', 'd.h', 'e.g', 'i.e', 'incl', 'excl', 'approx', 'vs', 'no', 'nos', 'tsd',
  ...MONAT_KUERZEL,
  'mr', 'mrs', 'ms', 'co', 's', 'std',
  'lt', 'rd', 'gem', 'insb', 'insg', 'ehem', 'bspw', 'zzt', 'kap', 'abs', 'jh', 'lfd', 'ggfs',
  // Strassenkuerzel vor einem Namen („Leof. Poseidonos" = Leoforos, „Avda. del Mar")
  'leof', 'avda'])
/** Maklerkuerzel, die mitten im Satz UND am Satzende stehen koennen („1.500 € monatl.
 *  Die ...", „2 km nördl. Paphos"). Sie trennen nie (ABK). Steht hinter ihnen ein
 *  Grossbuchstabe oder eine Ziffer, ist offen, ob dort ein Satz endet: ein Abschnitt,
 *  der so eine Stelle enthaelt, wird nie gestrichen (nicht_lokalisierbar). Pruefbefund 12.10.26. */
const ABK_MEHRDEUTIG = new Set(['einschl', 'exkl', 'voraussichtl', 'monatl', 'jährl', 'tägl', 'wöchentl', 'durchschnittl',
  'zusätzl', 'nördl', 'südl', 'östl', 'westl', 'wohnfl', 'grundst', 'govt', 'dept', 'corp', 'intl',
  // Pruefbefund 12.10.26 (Runde 3): „im allg. Wohngebiet", „Gebr. Ioannou", „gehobene Ausst.",
  // „Erstbez.", „Wohnz.", „Schlafz."
  'allg', 'gebr', 'ausst', 'erstbez', 'wohnz', 'schlafz'])
for (const k of ABK_MEHRDEUTIG) ABK.add(k)
const ZAHL_KUERZEL = new Set(['min', 'max', 'std', 'mio', 'mrd', 'tsd'])
const MONAT = new Set(MONAT_KUERZEL)
// „gem." / „no." sind auch Woerter („a hidden gem.", „No. The ..."): Kuerzel nur vor einer Ziffer.
const NUR_VOR_ZIFFER = new Set(['gem', 'no'])
// Nach einer Ordnungszahl steht nie ein Artikel oder Pronomen: „im Bauabschnitt der
// 2. Die Anlage ..." ist ein Satzende, obwohl „der" davor steht.
const SATZANFANG = /^(die|der|das|den|dem|des|ein|eine|einen|einem|einer|sie|er|es|wir|ich|du|ihr|man|dies|diese|dieser|dieses|diesem|diesen|hier|dort|dazu|damit|danach|dann|außerdem|zudem|the|this|it|we|you|they)\b/i
const ORD_DAVOR = new Set(['der', 'die', 'das', 'dem', 'den', 'des', 'am', 'im', 'zum', 'zur', 'ab', 'bis', 'vom', 'ins', 'seit',
  'jede', 'jeder', 'jedem', 'jeden', 'ihr', 'ihre', 'ihrem', 'ihrer', 'sein', 'seine', 'seinem', 'unser', 'unsere',
  'unserem', 'dein', 'deine', 'deinem', 'deiner', 'euer', 'eure', 'eurem', 'einer', 'einem', 'ein', 'eine', 'jeweils'])
const ORD_DANACH = /^(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|etage|obergeschoss|og|stock|stockwerk|geschoss|quartal|halbjahr|bauabschnitt|rate|reihe|linie|platz)\b/i

export function splitSaetze(text: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = []
  let start = 0
  const n = text.length
  for (let i = 0; i < n; i++) {
    const c = text[i]
    if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue
    let j = i + 1
    while (j < n && /[)"'“”»’*_]/.test(text[j])) j++
    let k = j
    while (k < n && /\s/.test(text[k])) k++
    if (k === j || k >= n) continue                                  // kein Leerraum oder Textende
    // Emojis, * und _ vor dem naechsten Wort ueberspringen („Gäste. 🌊 Die Anlage");
    // sie gehoeren zum naechsten Satz.
    const deko = text.slice(k).match(/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\uFE0F\u200D*_]|\s)+/u)
    const m = k + (deko ? deko[0].length : 0)
    if (m >= n) continue
    if (!/[\p{Lu}\d„"'«‚(]/u.test(text[m])) continue                  // naechstes Wort klein
    if (c === '.') {
      let w = i - 1
      while (w >= 0 && !/\s/.test(text[w])) w--
      const token = text.slice(w + 1, i).replace(/^[("'„“‚(]+/, '')
      const t = token.toLowerCase()
      if (ABK.has(t)) {
        const zahlDavor = /\d$/.test(text.slice(0, w + 1).trimEnd().split(/\s+/).pop() ?? '')
        const zahlDanach = /^\d/.test(text.slice(m))
        const keinKuerzel = MONAT.has(t) || NUR_VOR_ZIFFER.has(t) ? !zahlDanach : (t === 'max' || t === 'min') ? !zahlDavor && !zahlDanach : false
        if (!keinKuerzel && !(ZAHL_KUERZEL.has(t) && zahlDavor && SATZANFANG.test(text.slice(m)))) continue
      }
      // Einzelner Kleinbuchstabe (z. / u. / d.) und das grosse B. aus „z. B."
      // Ausnahme: letztes Glied einer Kette („p. a.", „u. a.", „o. ä.") vor erkennbarem
      // Satzanfang trennt. „d. h." leitet nur einen Nebensatz ein und trennt nie.
      if (/^\p{Ll}$/u.test(token)) {
        const kette = text.slice(0, w + 1).trimEnd().match(/(?:^|\s)(\p{Ll})\.$/u)
        if (!(kette && kette[1] + token !== 'dh' && SATZANFANG.test(text.slice(m)))) continue
      }
      if (/^\p{Lu}$/u.test(token)) {
        const davor = text.slice(0, w + 1).trimEnd()
        if (/(^|\s)\p{Ll}\.$/u.test(davor)) continue
      }
      // Ordnungszahl: 1-2 Ziffern, danach Monat/Etage oder davor Artikel/Praeposition
      // (ausser danach beginnt erkennbar ein neuer Satz)
      if (/^\d{1,2}$/.test(token)) {
        const vorher = text.slice(0, w + 1).trimEnd().split(/\s+/).pop()?.toLowerCase() ?? ''
        const nachher = text.slice(m)
        if (ORD_DANACH.test(nachher)) continue
        if (ORD_DAVOR.has(vorher) && !SATZANFANG.test(nachher)) continue
      }
    }
    out.push({ start, end: k, text: text.slice(start, k) })
    start = k
    i = k - 1
  }
  if (start < n) out.push({ start, end: n, text: text.slice(start) })
  return out
}

/** Ist das Satzende sicher? Nur bei ! ? …, einem Wort mit mindestens 4 Buchstaben
 *  (mit Vokal), einer Zahl, einer Einheit hinter einer Zahl („5 Min.", „92 m².")
 *  oder einer schliessenden Klammer vor dem Punkt. Kuerzere Woerter („Art.", „Max.",
 *  „p. a.", „Gym.") und Kuerzel ohne Vokal („ff.", „GmbH.") koennten eine Abkuerzung
 *  sein: dort wird nicht geschnitten (Sven 12.10.26: lieber rot lassen als ein
 *  Satzbruchstueck im Kundentext). */
const EINHEIT = /^(m²|m2|qm|m|km|ha|€|eur|euro|%|min|std|h|mio|mrd|tsd)$/i
const VOKAL = /[aeiouyäöüàáâèéêìíîòóôùúû]/i
/** Deutsche Artikel und mit Artikel verschmolzene Praepositionen: danach folgt ein
 *  Substantiv. Ein kleingeschriebenes kurzes Wort am Satzende ist dort ein Kuerzel
 *  („im allg. Wohngebiet", „der gebr. Möbel"). Bewusst ohne englische Artikel, dort
 *  sind Substantive klein („on the beach."). */
const KUERZEL_DAVOR = new Set(['der', 'die', 'das', 'dem', 'den', 'des', 'ein', 'eine', 'einem', 'einen', 'einer', 'eines',
  'im', 'am', 'zum', 'zur', 'vom', 'beim', 'ins', 'ans'])
export function sichereGrenze(satz: string): boolean {
  const s = satz.trimEnd().replace(/[)"'“”»’*_]+$/u, '')
  const ende = s.slice(-1)
  if (ende === '!' || ende === '?' || ende === '…') return true
  if (ende !== '.') return false
  const vorPunkt = s.slice(0, -1)
  const roh = vorPunkt.split(/\s+/).pop() ?? ''
  if (/\)$/.test(roh)) return true
  const tok = roh.replace(/^[("'„“‚‘«*_]+/u, '').replace(/["'“”»’‘*_.]+$/u, '')
  if (/\d/.test(tok)) return true
  if (EINHEIT.test(tok)) {
    if (tok === '€' || tok === '%') return true
    const davor = vorPunkt.trimEnd().split(/\s+/).slice(-2, -1)[0] ?? ''
    return /\d$/.test(davor)
  }
  // Bekannte Kuerzel („Prof.", „Govt.", „Dept.", „Corp.") sind nie ein sicheres Satzende.
  if (ABK.has(tok.toLowerCase())) return false
  // Konsonant + l am Wortende ohne Vokal davor ist im Deutschen fast immer ein Kuerzel
  // („monatl.", „voraussichtl.", „einschl.", „nördl.", „Wohnfl.", „intl."). Nicht: „-ll"
  // („Modell.") und Vokal + hl („Wahl.", „kühl.").
  const l2 = tok.slice(-2).toLowerCase()
  if (l2.length === 2 && l2[1] === 'l' && l2[0] !== 'l' && /\p{L}/u.test(l2[0]) && !VOKAL.test(l2[0])
    && !(l2[0] === 'h' && VOKAL.test(tok.slice(-3, -2)))) return false
  const buchstaben = tok.match(/\p{L}/gu)?.length ?? 0
  if (!(/^[\p{L}-]+$/u.test(tok) && buchstaben >= 4 && VOKAL.test(tok))) return false
  // Unbekannte Kuerzel mit 4-5 Buchstaben (Pruefbefund 12.10.26, Runde 3):
  //  - Konsonant + r am Ende („Gebr.", „Hrsg"): so endet kein deutsches oder englisches Wort.
  //  - klein geschrieben direkt hinter Artikel oder Praeposition („im allg.", „der gebr."):
  //    dort steht sonst ein Substantiv.
  if (buchstaben <= 5) {
    if (/[bcdfgkpstvwz]r$/i.test(tok)) return false
    const davor = vorPunkt.trimEnd().split(/\s+/).slice(-2, -1)[0]?.toLowerCase().replace(/^[("'„“‚‘«*_]+/u, '') ?? ''
    if (/^\p{Ll}/u.test(tok) && KUERZEL_DAVOR.has(davor)) return false
  }
  return true
}

/** Enthaelt der Text ein mehrdeutiges Maklerkuerzel (ABK_MEHRDEUTIG), hinter dem ein
 *  Grossbuchstabe oder eine Ziffer folgt? Dort koennte ein Satz enden, den die
 *  Satztrennung nicht trennt. */
export function mehrdeutigesKuerzel(text: string): boolean {
  for (const m of text.matchAll(/(\p{L}+)\.[)"'“”»’*_]*\s+[„"'«‚(*_]*[\p{Lu}\d]/gu)) {
    if (ABK_MEHRDEUTIG.has(m[1].toLowerCase())) return true
  }
  return false
}

/** Klammern () und [] ausgeglichen und nie zu frueh geschlossen? */
export function klammernAusgeglichen(text: string): boolean {
  for (const [auf, zu] of [['(', ')'], ['[', ']']]) {
    let tiefe = 0
    for (const c of text) {
      if (c === auf) tiefe++
      else if (c === zu && --tiefe < 0) return false
    }
    if (tiefe !== 0) return false
  }
  return true
}

/** Anfuehrungszeichen ausgeglichen? („“ "" «» ‚‘ ' '). Apostrophe zwischen zwei
 *  Buchstaben („geht’s", „it's") zaehlen nicht. */
export function zitateAusgeglichen(text: string): boolean {
  const t = text.replace(/(?<=\p{L})['’](?=\p{L})/gu, '')
  const z = (re: RegExp) => (t.match(re) ?? []).length
  return z(/[„“”]/g) % 2 === 0 && z(/"/g) % 2 === 0 && z(/«/g) === z(/»/g) && z(/[‚‘’]/g) % 2 === 0 && z(/'/g) % 2 === 0
}

/** Satzanfaenge, die auf den Satz davor verweisen: faellt der weg, haengt der Folgesatz. */
const VERWEIS = new Set(['dadurch', 'deshalb', 'daher', 'damit', 'dazu', 'darum', 'dafuer', 'dafür', 'so', 'das', 'dies', 'diese',
  'dieser', 'dieses', 'und', 'aber', 'außerdem', 'zudem', 'auch', 'sie', 'er', 'es', 'hier', 'dort',
  'this', 'that', 'these', 'those', 'thus', 'and', 'but', 'also', 'it', 'they', 'here', 'there',
  // Pruefbefund 12.10.26: Anschluss- und Gegensatzwoerter, Possessiv- und Relativpronomen
  'deswegen', 'trotzdem', 'dennoch', 'denn', 'doch', 'jedoch', 'allerdings', 'zusätzlich', 'zusaetzlich', 'ebenso',
  'ebenfalls', 'gleichzeitig', 'somit', 'folglich', 'hinzu', 'dann', 'deren', 'dessen', 'ihr', 'ihre', 'ihren', 'ihrem',
  'ihrer', 'ihres', 'sein', 'seine', 'seinen', 'seinem', 'seiner', 'seines', 'welche', 'welcher', 'welches', 'welchen', 'welchem',
  'however', 'moreover', 'furthermore', 'additionally', 'its', 'their', 'theirs', 'his', 'her', 'which', 'whose', 'as',
  'therefore', 'hence', 'yet', 'nevertheless', 'nonetheless', 'plus', 'such', 'consequently', 'besides', 'likewise', 'similarly',
  'meanwhile', 'accordingly',
  // Pruefbefund 12.10.26 (Runde 4): „Eine solche Lage ...", „Solche Lagen ..."
  'solch', 'solche', 'solcher', 'solches', 'solchen', 'solchem'])
/** Pronominaladverbien („dabei", „davon", „darüber", „hierfür") verweisen immer zurueck. */
const PRONOMINAL = /^(?:da|dar|hier)(?:bei|durch|für|fuer|gegen|in|mit|nach|neben|über|ueber|um|unter|von|vor|zu|auf|aus|an|her|hinter|zwischen)$/i
/** Verstaerker vor dem Verweiswort: „Gerade deshalb", „Genau das", „Nicht zuletzt deshalb". */
const VERSTAERKER = /^(?:(?:gerade|genau|eben|nur|ganz|besonders|umso|erst|schon|nicht\s+zuletzt|vor\s+allem|exactly|precisely|just|especially|partly|mainly|only|not\s+least|above\s+all)\s+)+/i
const istVerweisWort = (w: string) => VERWEIS.has(w.toLowerCase()) || PRONOMINAL.test(w)
/** Mehrwortige Anschluesse, Aufzaehlungsglieder und Folgerungen am Satzanfang
 *  (Pruefbefund 12.10.26, Runde 3). Text kleingeschrieben, Apostroph vereinheitlicht. */
const VERWEIS_PHRASE = new RegExp('^(?:' + [
  'aus diesem grund', 'im gegensatz', 'im gegenzug', 'im vergleich', 'zum anderen', 'zum zweiten', 'zum dritten', 'zum schluss',
  'zweitens', 'drittens', 'viertens', 'fünftens', 'fuenftens', 'schließlich', 'schliesslich', 'zuletzt', 'letztens', 'nicht zuletzt',
  'ein weiterer', 'eine weitere', 'ein weiteres', 'einen weiteren', 'einem weiteren', 'weitere', 'weiterer', 'weiteres', 'weiteren',
  'noch dazu', 'noch besser', 'ferner', 'weiterhin', 'überdies', 'ueberdies', 'obendrein', 'darüber hinaus', 'kein wunder',
  'nicht nur das', 'stattdessen', 'umgekehrt', 'demnach', 'demzufolge', 'infolgedessen', 'insofern', 'insoweit', 'wobei', 'zumal',
  'weshalb', 'weswegen', 'wodurch', 'womit', 'wofür', 'wovon', 'wozu', 'worauf', 'worin', 'woran',
  'mehr(?: [\\p{L}-]+){1,2} geht', '(?:besser|schöner|näher|zentraler) geht',
  'for this reason', 'for that reason', 'because of this', 'because of that', 'in addition', 'on top of that', 'on the other hand',
  'in contrast', 'by contrast', "what's more", 'what is more', 'another', 'no wonder', 'not only that', 'better still', 'even better',
  'secondly', 'thirdly', 'second,', 'third,', 'finally', 'lastly', 'last but not least', 'all of this', 'all this', 'as such',
  'instead', 'otherwise',
].join('|') + ')(?![\\p{L}])', 'u')
/** Demonstrativ- und Verweiswoerter in den ersten vier Woertern („In diesem Fall ...",
 *  „Mieter lieben genau diese Lage", „Investors love that ..."). Im Zweifel Skip. */
const VERWEIS_FRUEH = new Set(['dies', 'diese', 'dieser', 'dieses', 'diesem', 'diesen', 'dazu', 'deshalb', 'deswegen', 'daher', 'darum',
  'solch', 'solche', 'solcher', 'solches', 'solchen', 'solchem',
  'this', 'that', 'these', 'those', 'such'])
/** Vorausweisung im Satz davor: rhetorische Frage oder Ankuendigung („Das Beste daran?",
 *  „Und das Beste kommt zum Schluss.", „The best part?"). Faellt die Aufloesung weg,
 *  steht die Frage allein im Kundentext. */
const VORAUS = /(?:^|[^\p{L}])(?:das beste|das wichtigste|das schönste|das highlight|das i-tüpfelchen|die krönung|zum schluss|vorweg|folgendes|folgende|noch eins|eins noch|hier kommt|the best part|the best thing|the highlight|the icing|here is why|here's why|here is the thing|here's the thing|last but not least|the following|as follows|one more thing)(?![\p{L}])/u
/** Angekuendigte Anzahl („Drei Dinge sprechen ...", „two reasons"): faellt ein Glied weg,
 *  stimmt die Zahl nicht mehr. */
const ANZAHL = /(?:^|[^\p{L}\d])(?:zwei|drei|vier|fünf|fuenf|sechs|sieben|two|three|four|five|six|seven|[2-7])\s+(?:[\p{L}-]+\s+){0,2}(?:dinge|gründe|gruende|vorteile|pluspunkte|punkte|argumente|highlights|fakten|aspekte|faktoren|stärken|merkmale|besonderheiten|things|reasons|advantages|benefits|points|factors|features|perks|strengths|highlights)(?![\p{L}])/iu
/** Aufzaehlungsglied am Anfang des gestrichenen Teils: das Gegenstueck bliebe allein
 *  („Zum einen ..." ohne „Zum anderen ..."). */
const AUFZAEHLUNG = /^(?:zum einen|zum anderen|einerseits|andererseits|erstens|zweitens|drittens|viertens|zum ersten|zum zweiten|zum dritten|zuletzt|schließlich|on the one hand|on the other hand|firstly|secondly|thirdly|first,|second,|third,|finally|lastly)(?![\p{L}])/u
/** Zeilenumbruch oder Aufzaehlungszeichen im gestrichenen Teil. Bindestrich und Stern
 *  nur am Zeilenanfang: „ - " steht in Kundentexten auch mitten im Satz. */
const LISTE = /\n|[•·▪►✓✔]|^[-*–]\s|^\d+[.)]\s/u
const vorausweisend = (s: string) => {
  const t = s.replace(/[\s"'“”»’*_)]+$/u, '')
  return /[?？]$/.test(t) || VORAUS.test(t.toLowerCase().replace(/[’‘`´]/g, "'"))
}
export const beginntMitVerweis = (s: string): boolean => {
  const t = s.replace(/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\uFE0F\u200D\s"'„“”‚‘’«»(*_-])+/u, '')
  const w = t.match(/^\p{L}+/u)?.[0]
  if (!w) return false
  if (istVerweisWort(w)) return true
  const klein = t.toLowerCase().replace(/[’‘`´]/g, "'").replace(/\s+/g, ' ')
  if (VERWEIS_PHRASE.test(klein)) return true
  if ((klein.match(/\p{L}+/gu) ?? []).slice(0, 4).some(x => VERWEIS_FRUEH.has(x))) return true
  // Erstes Wort ein Verstaerker: das naechste Wort entscheidet.
  const nach = t.replace(VERSTAERKER, '')
  if (nach === t) return false
  const w2 = nach.match(/^\p{L}+/u)?.[0]
  return !!w2 && istVerweisWort(w2)
}
const endetMitDoppelpunkt = (s: string) => /:\s*$/.test(s.replace(/[\s"'“”»’*_)]+$/u, ''))
/** Punkt + Leerraum + Grossbuchstabe oder Ziffer irgendwo im Inneren: dort koennte ein
 *  Satz enden, den die Satztrennung wegen eines Kuerzels nicht trennt („inkl. Der
 *  Gesamtpreis", „& Co. Die Anlage", „Poseidonos Ave. The complex"). Eine ganze Einheit
 *  (Absatz, Notiz, Intro, Zitat, Karte) mit so einer Stelle faellt nie weg - sie koennte
 *  einen unbeanstandeten Satz enthalten (Pruefbefund 12.10.26, Runde 4). */
export const innererSatzpunkt = (s: string): boolean => /\.[)"'“”»’*_]*\s+[„"'«‚(]*[\p{Lu}\d]/u.test(s.trim())

/** Absaetze, deren erster Satz die Anrede ist. */
export const ANREDE = /^\s*(?:Hallo|Hi|Liebe|Lieber|Sehr geehrte[rn]?|Dear|Hello)(?!\p{L})/u

type Streichung = { ok: true; text: string } | { ok: false; reason: SkipReason }
/** Entfernt alle Saetze, die einen der Bereiche [s, e) beruehren. Lehnt ab (nie still
 *  halb bereinigen), wenn
 *   - eine Grenze zwischen bleibendem und entferntem Satz unsicher ist (nicht_lokalisierbar),
 *   - die Anrede (erster Satz) wegfiele (pflichtfeld),
 *   - ein Zitat ueber die Streichung hinaus reicht oder danach offen bliebe (kontext),
 *   - der naechste verbleibende Satz auf den gestrichenen verweist („Dadurch ...",
 *     „Das ...") oder der vorige auf ':' endet (kontext).
 *  vorher/nachher: Nachbarabsatz, falls der gestrichene Teil am Feldanfang/-ende liegt.
 *  davor: ALLE Absaetze vor diesem (angekuendigte Anzahl oder Liste zwei Absaetze vorher). */
function satzEntfernen(text: string, bereiche: Array<[number, number]>,
  opt: { anrede?: boolean; vorher?: string; nachher?: string; davor?: string[] } = {}): Streichung {
  const saetze = splitSaetze(text)
  const weg = saetze.map(s => bereiche.some(([a, b]) => a < s.end && b > s.start))
  if (opt.anrede && weg[0]) return { ok: false, reason: 'pflichtfeld' }
  for (let i = 0; i + 1 < saetze.length; i++) {
    if (weg[i] !== weg[i + 1] && !sichereGrenze(saetze[i].text)) return { ok: false, reason: 'nicht_lokalisierbar' }
  }
  // Zusammenhaengende gestrichene Abschnitte einzeln pruefen
  for (let i = 0; i < saetze.length; i++) {
    if (!weg[i] || (i > 0 && weg[i - 1])) continue
    let e = i
    while (e + 1 < saetze.length && weg[e + 1]) e++
    const abschnitt = saetze.slice(i, e + 1).map(s => s.text).join('')
    // „1.500 € monatl. Die ...": ob dort ein Satz endet, ist offen - nie streichen.
    if (mehrdeutigesKuerzel(abschnitt)) return { ok: false, reason: 'nicht_lokalisierbar' }
    // Zeilenliste ohne Satzpunkt („Highlights:\n• Meerblick\n• direkt am Meer"): die
    // Satztrennung kennt keine Zeilen, es fiele die ganze Liste weg (Pruefbefund 12.10.26).
    if (LISTE.test(abschnitt.trim())) return { ok: false, reason: 'nicht_lokalisierbar' }
    if (!zitateAusgeglichen(abschnitt) || !klammernAusgeglichen(abschnitt)) return { ok: false, reason: 'kontext' }
    const vor = i > 0 ? saetze[i - 1].text : opt.vorher
    const nach = e + 1 < saetze.length ? saetze[e + 1].text : opt.nachher
    if (vor != null && endetMitDoppelpunkt(vor)) return { ok: false, reason: 'kontext' }
    if (nach != null && beginntMitVerweis(nach)) return { ok: false, reason: 'kontext' }
    // Der gestrichene Teil kuendigt selbst etwas an („... folgende Extras:"): die
    // Aufzaehlung danach stuende ohne Einleitung da (Pruefbefund 12.10.26, Runde 4).
    if (nach != null && (endetMitDoppelpunkt(abschnitt) || vorausweisend(abschnitt))) return { ok: false, reason: 'kontext' }
    // Vorausweisender Satz davor (Frage, „Das Beste ..."), Aufzaehlungsglied im
    // gestrichenen Teil oder davor angekuendigte Anzahl: der Rest wuerde haengen.
    const vorSatz = i > 0 ? saetze[i - 1].text : opt.vorher != null ? splitSaetze(opt.vorher).pop()?.text : undefined
    if (vorSatz != null && vorausweisend(vorSatz)) return { ok: false, reason: 'kontext' }
    if (/[?？][\s"'“”»’*_)]*$/u.test(abschnitt)) return { ok: false, reason: 'kontext' }
    if (AUFZAEHLUNG.test(abschnitt.replace(/^[\s"'„“‚‘«(*_-]+/u, '').toLowerCase())) return { ok: false, reason: 'kontext' }
    // Ankuendigung, Liste oder Anzahl in einem FRUEHEREN Absatz („Drei Dinge ..." zwei
    // Absaetze vorher): auch dort haengt der Rest (Pruefbefund 12.10.26, Runde 4).
    const frueher = opt.davor ?? (opt.vorher != null ? [opt.vorher] : [])
    if (i === 0 && frueher.some(a => endetMitDoppelpunkt(a) || vorausweisend(splitSaetze(a.trim()).pop()?.text ?? ''))) {
      return { ok: false, reason: 'kontext' }
    }
    const davor = [...frueher, ...saetze.slice(0, i).map(s => s.text)].join(' ')
    if (ANZAHL.test(davor)) return { ok: false, reason: 'kontext' }
  }
  const rest = saetze.filter((_, i) => !weg[i]).map(s => s.text).join('').trim()
  if (!zitateAusgeglichen(rest) || !klammernAusgeglichen(rest)) return { ok: false, reason: 'kontext' }
  return { ok: true, text: rest }
}

// ── Stabiler Vergleich (sortierte Schluessel, undefined = fehlt) ─────────────
export function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((x, i) => stableEqual(x, bb[i]))
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>
  const ka = Object.keys(ao).filter(k => ao[k] !== undefined).sort()
  const kb = Object.keys(bo).filter(k => bo[k] !== undefined).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && stableEqual(ao[k], bo[k]))
}

// ── Felder eines Blocks ──────────────────────────────────────────────────────
type Pfad = Array<string | number>
interface Blatt { path: Pfad; field: string; text: string }

const pfadText = (p: Pfad) => p.reduce<string>((acc, x) => typeof x === 'number' ? `${acc}[${x}]` : acc ? `${acc}.${x}` : x, '')

function blaetter(b: Block): Blatt[] {
  const out: Blatt[] = []
  const walk = (node: unknown, path: Pfad) => {
    if (typeof node === 'string') {
      if (!/^https?:\/\//i.test(node)) out.push({ path, field: pfadText(path), text: node })
      return
    }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, [...path, i])); return }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (path.length === 0 && k === 'type') continue
        walk(v, [...path, k])
      }
    }
  }
  walk(b, [])
  return out
}

type Art = 'satz' | 'karte' | 'punkt' | 'feld' | 'gesperrt'
/** Feldart nach Pfad. Alles, was hier nicht ausdruecklich steht, ist gesperrt. */
function feldArt(p: Pfad): Art {
  const top = String(p[0])
  if (LOCKED_KEYS.has(top)) return 'gesperrt'
  const s = pfadText(p)
  if (/^(text|intro|note|quote)$/.test(s)) return 'satz'
  if (/^paragraphs\[\d+\]$/.test(s)) return 'satz'
  if (/^cols\[\d+\]\.text$/.test(s)) return 'satz'
  if (/^cards\[\d+\]\.(title|text)$/.test(s)) return 'karte'
  if (/^tagline$/.test(s)) return 'feld'
  if (/^specs\[\d+\]$/.test(s)) return 'punkt'
  if (/^bullets\[\d+\]\.(text|strong)$/.test(s)) return 'punkt'
  if (/^groups\[\d+\]\.items\[\d+\]$/.test(s)) return 'punkt'
  if (/^stats\[\d+\]\.\w+$/.test(s)) return 'punkt'
  return 'gesperrt'
}

const textLaenge = (b: Block): number => blaetter(b)
  .filter(x => !(DETERMINISTIC_FIELDS as readonly string[]).includes(String(x.path[0])))
  .reduce((s, x) => s + x.text.length, 0)

const istGesperrterBlock = (b: Block) => LOCKED_TYPES.has(String(b?.type)) || (typeof b?.image === 'string' && b.image === MARINA_MODEL)

// ── Zaehlwerte: feste Vorlagen ───────────────────────────────────────────────
const WORTZAHL: Record<string, number> = { ein: 1, eine: 1, einem: 1, zwei: 2, drei: 3, vier: 4, fuenf: 5, 'fünf': 5, one: 1, two: 2, three: 3, four: 4, five: 5 }
const zahl = (s: string) => (/^\d+$/.test(s) ? Number(s) : (WORTZAHL[s.toLowerCase()] ?? NaN))
/** Englisches Nomen in der Schreibweise des Originals (Bedrooms / bedrooms). */
const wieOriginal = (orig: string, wort: string) => (/^\p{Lu}/u.test(orig) ? wort.charAt(0).toUpperCase() + wort.slice(1) : wort)
const ordinalEn = (n: number) => {
  const m = n % 100
  if (m >= 11 && m <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/** Zahlwert eines Zaehlwert-Treffers wie im Gate („drei Schlafzimmer" = 3, „Erdgeschoss" = 0). */
const zaehlwertVon = (key: string, match = ''): number => {
  const t = match.trim()
  if (key === 'etage_abweichung') return /^(erdgeschoss|ground)/i.test(t) ? 0 : Number(t.match(/^\d{1,2}/)?.[0] ?? NaN)
  return zahl(t.match(/^[\p{L}\d]+/u)?.[0] ?? '')
}

/** Ersatztext fuer einen Zaehlwert-Treffer, oder null wenn keine Vorlage passt. */
export function ersatzWert(key: string, treffer: string, soll: number): string | null {
  const t = treffer.trim()
  // Grenzwerte nie umschreiben, sondern streichen: Studio (0 Schlafzimmer), 0 Bäder,
  // Untergeschoss (negative Etage), halbe Werte.
  if (!Number.isInteger(soll)) return null
  if ((key === 'zimmer_abweichung' || key === 'bad_abweichung') && soll < 1) return null
  if (key === 'etage_abweichung' && soll < 0) return null
  if (key === 'zimmer_abweichung') {
    const m = t.match(/^(\d|ein|eine|einem|zwei|drei|vier|fünf|fuenf|one|two|three|four|five)([\s-]*)(schlafzimmer|sz|bedrooms?|bed)$/i)
    if (!m || !Number.isFinite(zahl(m[1]))) return null
    const wort = m[3]
    // Zusammengesetzt („2-bedroom", „2-Schlafzimmer"): Schreibweise behalten. Plural
    // („2-bedrooms") hat keine sichere Vorlage, der Punkt wird gestrichen.
    if (m[2].includes('-')) return /^bedrooms$/i.test(wort) ? null : `${soll}-${wort}`
    if (/^(schlafzimmer|sz)$/i.test(wort)) return `${soll} Schlafzimmer`
    return `${soll} ${wieOriginal(wort, soll === 1 ? 'bedroom' : 'bedrooms')}`
  }
  if (key === 'bad_abweichung') {
    const m = t.match(/^(\d|ein|zwei|drei|one|two|three)([\s-]*)(badezimmer|bäder|bad|bathrooms?)$/i)
    if (!m || !Number.isFinite(zahl(m[1]))) return null
    if (m[2].includes('-')) return /^(bäder|bathrooms)$/i.test(m[3]) ? null : `${soll}-${m[3]}`
    const wort = m[3].toLowerCase()
    if (wort === 'badezimmer') return `${soll} Badezimmer`
    if (wort === 'bäder' || wort === 'bad') return soll === 1 ? '1 Bad' : `${soll} Bäder`
    return `${soll} ${wieOriginal(m[3], soll === 1 ? 'bathroom' : 'bathrooms')}`
  }
  if (key === 'etage_abweichung') {
    let m = t.match(/^(\d{1,2})\.\s*(etage|obergeschoss|og|stock)$/i)
    if (m) return soll === 0 ? 'Erdgeschoss' : `${soll}. ${m[2]}`
    m = t.match(/^erdgeschoss$/i)
    if (m) return soll === 0 ? null : `${soll}. Etage`
    m = t.match(/^(\d{1,2})(?:st|nd|rd|th)\s+(floor)$/i)
    if (m) return soll === 0 ? `${wieOriginal(m[2], 'ground')} ${m[2]}` : `${ordinalEn(soll)} ${m[2]}`
    m = t.match(/^ground\s+(floor)$/i)
    if (m) return soll === 0 ? null : `${ordinalEn(soll)} ${m[1]}`
    return null
  }
  return null
}

/** Die Wohnung, die ein Block beschreibt - nur wenn eindeutig. */
function wohnungZumBlock(b: Block, ctx: DeckContext): DeckUnitCtx | null {
  if (b.type === 'unit') {
    const k = unitKey(b.number)
    return ctx.units.find(u => u.unitKey === k) ?? null
  }
  if (b.type === 'floorplan' && typeof b.image === 'string') {
    const treffer = ctx.units.filter(u => u.floorplanUrl === b.image)
    return treffer.length === 1 ? treffer[0] : null
  }
  return ctx.units.length === 1 ? ctx.units[0] : null
}
const sollWert = (key: string, u: DeckUnitCtx | null): number | null => {
  if (!u) return null
  const v = key === 'zimmer_abweichung' ? u.bedrooms : key === 'bad_abweichung' ? u.bathrooms : key === 'etage_abweichung' ? u.floor : null
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v)
}

// ── Zugriff auf Pfade ────────────────────────────────────────────────────────
function holen(b: Block, p: Pfad): unknown {
  let cur: unknown = b
  for (const x of p) cur = (cur as Record<string | number, unknown> | undefined)?.[x as string]
  return cur
}
function setzen(b: Block, p: Pfad, v: unknown) {
  const parent = holen(b, p.slice(0, -1)) as Record<string | number, unknown>
  parent[p[p.length - 1] as string] = v
}
function loeschen(b: Block, p: Pfad) {
  const parent = holen(b, p.slice(0, -1)) as Record<string, unknown>
  delete parent[String(p[p.length - 1])]
}

const istBehauptung = (f: Finding) => f.key.startsWith('behauptung_')
const istZaehlwert = (k: string) => k === 'zimmer_abweichung' || k === 'bad_abweichung' || k === 'etage_abweichung'
const suchText = (f: Finding): string => (istBehauptung(f) ? claimNorm(f.claim ?? f.loc?.match ?? '') : norm(f.loc?.match ?? ''))

/** Treffer einer Aussage in einem Block. Kurze Aussagen (< 2 Woerter) zaehlen nur
 *  als ganzes Feld. Gate-Befunde suchen NUR im gemeldeten Feld (loc.field), ohne
 *  Rueckfall auf den ganzen Block: dort stuenden auch Stellen, die das Gate bewusst
 *  nicht meldet (Etage der Tiefgarage, Flaeche der Gemeinschaftsanlage). Aus demselben
 *  Grund im Feld nur die gemeldete Stelle (loc.index); weitere echte Vorkommen meldet
 *  das Gate nach der Korrektur neu (Schleife „weiter" in autofixDeck). Pfad und
 *  Position liefert der frische Gate-Befund, Indexverschiebungen sind dort drin. */
function treffer(b: Block, f: Finding): Array<{ blatt: Blatt; bereiche: Array<[number, number]> }> {
  const needle = suchText(f)
  if (!needle) return []
  const behauptung = istBehauptung(f)
  const kurzeAussage = behauptung && needle.split(' ').length < 2
  const alle = blaetter(b).filter(bl => !NIE_SUCHEN.has(String(bl.path[0])))
  const suche = (liste: Blatt[]) => {
    const res: Array<{ blatt: Blatt; bereiche: Array<[number, number]> }> = []
    for (const bl of liste) {
      if (kurzeAussage) {
        if (claimNorm(bl.text) === needle) res.push({ blatt: bl, bereiche: [[0, bl.text.length]] })
        continue
      }
      const sp = spans(bl.text, needle, behauptung)
      if (sp.length) res.push({ blatt: bl, bereiche: sp })
    }
    return res
  }
  if (!behauptung && f.loc?.field) {
    const res = suche(alle.filter(bl => bl.field === f.loc!.field))
    const at = f.loc.index
    if (typeof at !== 'number') return res
    return res.map(h => ({ ...h, bereiche: h.bereiche.filter(([a]) => a === at) })).filter(h => h.bereiche.length)
  }
  return suche(alle)
}

// ── Eine Korrektur auf der Arbeitskopie ──────────────────────────────────────
/** weg: je Liste (Pfad wie 'paragraphs', 'cards', 'groups[0].items') die Originalindizes,
 *  die fruehere Korrekturen in diesem Block entfernt haben. entfernt: was dieser
 *  Versuch zusaetzlich entfernt (Originalindizes). */
type Weg = Map<string, number[]>
type Versuch = { ok: true; changes: AutofixChange[]; entfernt: Array<[string, number]> } | { ok: false; reason: SkipReason }

// Nennt eine Ueberschrift, ein Kicker, eine Einleitung oder das Anschreiben eine Anzahl
// („6 Gründe", „Five reasons", „die fünf wichtigsten Eckdaten", „in 5 Punkten"), darf
// keine Karte und kein Listenpunkt wegfallen - sonst stimmt die Zahl nicht mehr.
const ANZAHL_LISTE = /(?:\b(?:[2-9]|1[0-2])\b|\b(?:zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)[^.!?]{0,40}?(?:gr[üu]nde|vorteile|vorzüge|stärken|extras|highlights|besonderheiten|punkte|punkten|eckdaten|fakten|facts|argumente|dinge|merkmale|details|reasons|benefits|perks|things|points|features|advantages|highlights)/i
// In der EIGENEN Ueberschrift sperrt jede Zahl („Die Top 6", „Sechs Stärken", „ein
// halbes Dutzend"), im Anschreiben nur eine Zahl mit Aufzaehlungs-Nomen.
const ZAHL_IRGENDWO = /\b(?:[2-9]|1[0-2])\b|\b(?:zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|dutzend|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)\b/i
function zaehltListe(blocks: Block[], b: Block): boolean {
  const eigene = ['headline', 'kicker', 'intro', 'title'].map(k => b[k]).filter((x): x is string => typeof x === 'string')
  const brief = blocks.filter(x => x && x.type === 'letter').flatMap(x => Array.isArray(x.paragraphs) ? (x.paragraphs as unknown[]).filter((p): p is string => typeof p === 'string') : [])
  return eigene.some(t => ZAHL_IRGENDWO.test(klartext(t))) || brief.some(t => ANZAHL_LISTE.test(klartext(t)))
}

function korrigieren(blocks: Block[], bi: number, f: Finding, ctx: DeckContext, weg: Weg = new Map()): Versuch {
  const b = blocks[bi]
  const hits = treffer(b, f)
  if (!hits.length) return { ok: false, reason: 'nicht_lokalisierbar' }
  if (hits.some(h => feldArt(h.blatt.path) === 'gesperrt')) return { ok: false, reason: 'gesperrtes_feld' }
  if (hits.some(h => MARKUP(h.blatt.text))) return { ok: false, reason: 'html_feld' }
  // Kurze Aussagen (unter 4 Woertern, etwa „mit Pool") nur bei GENAU einer Fundstelle
  // im Block - sonst ist offen, welcher Satz gemeint war.
  if (istBehauptung(f) && suchText(f).split(' ').length < 4 && hits.reduce((s, h) => s + h.bereiche.length, 0) > 1) {
    return { ok: false, reason: 'mehrdeutig' }
  }
  // Im Bericht steht der Index des Originals, nicht der nach frueheren Entfernungen
  // verschobene (Absaetze, Karten, Listenpunkte).
  const origIdx = (liste: string, w: number) => {
    let o = w
    for (const r of [...(weg.get(liste) ?? [])].sort((x, y) => x - y)) if (r <= o) o++
    return o
  }
  const feldName = (p: Pfad) => pfadText(p.map((x, j) => {
    const liste = pfadText(p.slice(0, j))
    return typeof x === 'number' && weg.has(liste) ? origIdx(liste, x) : x
  }))

  const typ = String(b.type)
  const basis = { finding_key: f.key, severity: f.severity, what: kurz(f.what, 200), block: bi, block_type: typ }
  const hint = istBehauptung(f) ? 'fakt_hinterlegen' : undefined
  const changes: AutofixChange[] = []
  // Entfernen aus Listen erst am Ende, absteigend - sonst verrutschen Indizes.
  const entfernen: Array<{ liste: Pfad; index: number }> = []
  const karten = new Set<number>()

  for (const { blatt, bereiche } of hits) {
    const art = feldArt(blatt.path)
    const p = blatt.path
    if (art === 'feld') {
      changes.push({ ...basis, field: feldName(p), action: 'feld_geleert', before: kurz(blatt.text), after: '', hint })
      loeschen(b, p)
      continue
    }
    if (art === 'karte') {
      // Treffer im Kartentitel: ganze Karte. Im Kartentext gilt fuer Behauptungen dieselbe
      // Regel wie fuer Gate-Befunde: Die Karte faellt nur weg, wenn der Text aus genau der
      // beanstandeten Aussage besteht. Ein zweiter, korrekter Satz („Der Pool steht allen
      // Bewohnern offen.") haelt die Karte, der Befund bleibt fuer Sven (Pruefbefund
      // 12.10.26, Runde 5).
      if (p[2] === 'title') { karten.add(Number(p[1])); continue }
      const st = satzEntfernen(blatt.text, bereiche)
      if (!st.ok) return { ok: false, reason: st.reason }
      const neu = st.text
      if (!neu) {
        if (innererSatzpunkt(blatt.text)) return { ok: false, reason: 'fliesstext' }
        karten.add(Number(p[1])); continue
      }
      if (!PROSA_CHIRURGIE) return { ok: false, reason: 'fliesstext' }
      changes.push({ ...basis, field: feldName(p), action: 'satz_entfernt', before: kurz(blatt.text), after: kurz(neu), hint })
      setzen(b, p, neu)
      continue
    }
    if (art === 'punkt') {
      const soll = istZaehlwert(f.key) && typeof holen(b, p) === 'string' && !/^stats$/.test(String(p[0]))
        ? sollWert(f.key, wohnungZumBlock(b, ctx)) : null
      const match = f.loc?.match ?? ''
      const ersatz = soll != null ? ersatzWert(f.key, match, soll) : null
      // Ersetzt wird nur, wenn der Listenpunkt NUR aus dem Zaehlwert besteht. „1 Bad
      // en suite" oder „1 Schlafzimmer mit Meerblick" meinen eine Teilmenge - dort
      // wuerde der CRM-Wert eine neue, falsche Aussage erzeugen. Solche Punkte fallen weg.
      // Bei bullets {strong, text} zaehlt der ganze Punkt: „1 Badezimmer" + „en suite"
      // ist eine Teilmenge, auch wenn der Treffer allein im strong steht.
      const bullet = p[0] === 'bullets' ? (holen(b, p.slice(0, 2)) ?? {}) as Record<string, unknown> : null
      const punktText = bullet ? [bullet.strong, bullet.text].filter(x => typeof x === 'string' && x).join(' ') : blatt.text
      const ganzerPunkt = !!match && claimNorm(punktText) === claimNorm(match)
      if (ersatz && ganzerPunkt && blatt.text.includes(match)) {
        let neu = blatt.text.split(match).join(ersatz)
        // Am Anfang des Punkts gross schreiben („1st floor" -> „Ground floor")
        const lead = neu.length - neu.trimStart().length
        if (/^\p{Ll}/u.test(neu.slice(lead)) && !/^\p{Ll}/u.test(blatt.text.trimStart())) {
          neu = neu.slice(0, lead) + neu.charAt(lead).toUpperCase() + neu.slice(lead + 1)
        }
        changes.push({ ...basis, field: feldName(p), action: 'wert_gesetzt', before: kurz(blatt.text), after: kurz(neu) })
        setzen(b, p, neu)
        continue
      }
      // Listenpunkt entfernen: bei stats/bullets das ganze Objekt.
      const liste = p[0] === 'groups' ? p.slice(0, 3) : p.slice(0, 1)
      const index = Number(p[0] === 'groups' ? p[3] : p[1])
      const itemText = p[0] === 'groups' || p[0] === 'specs' ? blatt.text
        : Object.values((holen(b, [...liste, index]) ?? {}) as Record<string, unknown>).filter(v => typeof v === 'string').join(' ')
      // Faellt ein ganzes Objekt weg (bullets/stats), gilt die Formatierungssperre fuer
      // ALLE seine Texte, nicht nur fuer das Trefferfeld.
      if (alleTexte(holen(b, [...liste, index])).some(MARKUP)) return { ok: false, reason: 'html_feld' }
      if (zaehltListe(blocks, b)) return { ok: false, reason: 'kontext' }
      if (!entfernen.some(e => pfadText(e.liste) === pfadText(liste) && e.index === index)) {
        entfernen.push({ liste, index })
        changes.push({ ...basis, field: feldName([...liste, index]), action: 'punkt_entfernt', before: kurz(itemText), after: '', hint })
      }
      continue
    }
    // Satzfeld. Absaetze: Nachbarabsaetze fuer Verweis und Doppelpunkt; die Anrede
    // (erster Satz des ersten Absatzes im Anschreiben, jeder Absatz mit Gruss am
    // Anfang) faellt nie weg.
    const absatz = /^paragraphs\[\d+\]$/.test(pfadText(p))
    const absaetze = absatz && Array.isArray(b.paragraphs) ? b.paragraphs as unknown[] : []
    const ai = absatz ? Number(p[1]) : -1
    const nachbar = (x: unknown) => (typeof x === 'string' ? x : undefined)
    const st = satzEntfernen(blatt.text, bereiche, absatz ? {
      anrede: (typ === 'letter' && ai === 0) || ANREDE.test(blatt.text),
      vorher: nachbar(absaetze[ai - 1]), nachher: nachbar(absaetze[ai + 1]),
      davor: absaetze.slice(0, Math.max(0, ai)).filter((x): x is string => typeof x === 'string'),
    } : {})
    if (!st.ok) return { ok: false, reason: st.reason }
    const neu = st.text
    if (neu) {
      if (!PROSA_CHIRURGIE) return { ok: false, reason: 'fliesstext' }
      changes.push({ ...basis, field: feldName(p), action: 'satz_entfernt', before: kurz(blatt.text), after: kurz(neu), hint })
      setzen(b, p, neu)
      continue
    }
    // Feld oder Absatz faellt ganz weg: nur, wenn er aus genau EINEM Satz besteht, also
    // nur aus der beanstandeten Aussage. Mehrere Saetze, die alle getroffen sind, bleiben
    // Fliesstext fuer Sven.
    if (!PROSA_CHIRURGIE && splitSaetze(blatt.text.trim()).length > 1) return { ok: false, reason: 'fliesstext' }
    // Kuerzel am Satzende („inkl.", „& Co.", „Ave.") trennt die Satztrennung nicht: dann
    // ist offen, ob es nur ein Satz ist - nie die ganze Einheit streichen.
    if (innererSatzpunkt(blatt.text)) return { ok: false, reason: 'fliesstext' }
    const s = pfadText(p)
    if (/^paragraphs\[\d+\]$/.test(s)) {
      // Ganze Absaetze entfernt die Automatik nie (Pruefbefund 12.10.26, Runde 5): Der
      // Nachbarabsatz kann auf den Inhalt verweisen („Wie erwähnt", „Gleiches gilt",
      // „Apropos Meer"), ein Vorabsatz ihn ankuendigen („Hier die Eckdaten."), eine
      // Ueberschrift ihn zaehlen („Drei Gründe") oder er ist selbst der Schluss. Keine
      // Wortliste deckt das sicher ab - der Befund bleibt fuer Sven.
      return { ok: false, reason: 'fliesstext' }
    }
    if (/^(note|intro|quote)$/.test(s)) {
      // Mehrere Aussagen in einem „Satz" (; oder : oder Gedanken-/Bindestrich zwischen
      // Satzteilen): richtige Infos gingen mit verloren.
      if (/[;:]|\s[-–—]\s/.test(blatt.text)) return { ok: false, reason: 'fliesstext' }
      // Neben der beanstandeten Stelle hoechstens drei weitere Woerter (sonst geht richtige
      // Info mit verloren, etwa „..., die Einrichtung ist optional erhältlich").
      if (istBehauptung(f)) {
        let rest = blatt.text
        for (const [a, e] of [...bereiche].sort((x, y) => y[0] - x[0])) rest = rest.slice(0, a) + ' ' + rest.slice(e)
        if (rest.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length > 3) return { ok: false, reason: 'fliesstext' }
      }
      // Fussnote, auf die ein Zeichen im Block verweist, oder ein Zitat, auf das der Text zeigt.
      if (/^\s*[*¹²³†]/.test(blatt.text)) return { ok: false, reason: 'kontext' }
      if (s === 'quote' && alleTexte(b).some(t => /siehe\s+(?:zitat|unten)|see\s+(?:quote|below)/i.test(t))) return { ok: false, reason: 'kontext' }
      changes.push({ ...basis, field: s, action: 'satz_entfernt', before: kurz(blatt.text), after: '', hint })
      loeschen(b, p)
      continue
    }
    // text, cols[n].text: Pflichttext bliebe leer.
    return { ok: false, reason: 'pflichtfeld' }
  }

  if (karten.size) {
    if (zaehltListe(blocks, b)) return { ok: false, reason: 'kontext' }
    const cards = Array.isArray(b.cards) ? b.cards as Array<Record<string, unknown>> : []
    if (cards.length - karten.size < 3) return { ok: false, reason: 'zu_wenige_karten' }
    for (const ci of karten) {
      const c = cards[ci] ?? {}
      // Die ganze Karte faellt weg: Formatierungssperre fuer alle ihre Texte.
      if (alleTexte(c).some(MARKUP)) return { ok: false, reason: 'html_feld' }
      changes.push({ ...basis, field: feldName(['cards', ci]), action: 'karte_entfernt',
        before: kurz([c.title, c.text].filter(x => typeof x === 'string' && x).join(': ')), after: '', hint })
      entfernen.push({ liste: ['cards'], index: ci })
    }
  }

  // Listen absteigend kuerzen; leere Pflichtlisten verhindern.
  const proListe = new Map<string, { liste: Pfad; idx: number[] }>()
  for (const e of entfernen) {
    const k = pfadText(e.liste)
    const x = proListe.get(k) ?? { liste: e.liste, idx: [] }
    x.idx.push(e.index); proListe.set(k, x)
  }
  const entfernt: Array<[string, number]> = []
  for (const { liste, idx } of proListe.values()) {
    const arr = holen(b, liste)
    if (!Array.isArray(arr)) return { ok: false, reason: 'nicht_lokalisierbar' }
    if (arr.length - new Set(idx).size < 1) return { ok: false, reason: 'pflichtfeld' }
    for (const i of new Set(idx)) entfernt.push([pfadText(liste), origIdx(pfadText(liste), i)])
    for (const i of [...new Set(idx)].sort((x, y) => y - x)) arr.splice(i, 1)
  }
  return { ok: true, changes, entfernt }
}

// ── Hauptfunktion ────────────────────────────────────────────────────────────
const zaehleRot = (fs: Finding[]) => fs.filter(f => ROT.includes(f.severity)).length
const ampel = (fs: Finding[]): 'green' | 'red' => (zaehleRot(fs) ? 'red' : 'green')
const fKey = (f: Finding) => `${f.key}|${f.block ?? ''}`

/** Prueft je Block, ob eine Aussage (normalisiert) irgendwo in seinen Texten steht.
 *  Anders als treffer() (Auswahl dessen, was entfernt wird) gilt hier die Wortsuche
 *  fuer JEDE Laenge: auch eine Ein-Wort-Aussage („Meerblick") steht noch da, wenn sie
 *  in einem laengeren Text vorkommt - sonst falsches Gruen (Pruefbefund 12.10.26, Runde 4). */
// Formatierung fuer die Suche entfernen: HTML-Tags, Entities, Markdown-Fett, weiche
// Trennstriche. Absaetze und Notizen rendern als HTML - steht die Aussage dort fett oder
// mit &nbsp;, ist sie fuer den Kunden trotzdem da (Endpruefung 13.10.26: falsches Gruen).
const klartext = (s: string) => s.replace(/<[^>]+>/g, ' ')
  .replace(/&(?:nbsp|#160|#xa0);/gi, ' ').replace(/&amp;/gi, '&')
  .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, ' ')
  .replace(/\*\*/g, '').replace(/[\u00AD\u200B-\u200D\u2060]/g, '')
const stehtIm = (b: Block, f: Finding): boolean => {
  if (!istBehauptung(f)) return treffer(b, f).length > 0
  const needle = suchText(f)
  if (!needle) return false
  return blaetter(b).some(bl => {
    if (NIE_SUCHEN.has(String(bl.path[0]))) return false
    const k = klartext(bl.text)
    return spans(bl.text, needle, true).length > 0 || claimNorm(bl.text) === needle
      || spans(k, needle, true).length > 0 || claimNorm(k) === needle
  })
}
// Fuer die Entscheidung „behoben" reicht der exakte Wortlaut nicht: dieselbe Aussage
// steht oft gebeugt oder als Kompositum noch woanders („privaten Pool",
// „Meerblickterrasse"). Dann gilt sie als noch da (Endpruefung 13.10.26). Nur fuer
// diese Entscheidung - was entfernt wird, bestimmt weiter treffer().
const STOPP = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'und', 'oder', 'mit', 'ohne', 'fuer', 'für', 'von', 'vom', 'zum', 'zur', 'auf', 'aus', 'bei', 'nach', 'über', 'unter',
  'ist', 'sind', 'hat', 'haben', 'wird', 'werden', 'jede', 'jeder', 'jedes', 'alle', 'auch', 'noch', 'sehr', 'nur',
  'the', 'and', 'with', 'from', 'for', 'into', 'this', 'that', 'every', 'each', 'all', 'has', 'have', 'are', 'was', 'very', 'only',
  // allgemeine Verben ohne eigene Aussage („Wohnen mit Meerblick" -> es zaehlt „Meerblick")
  'wohnen', 'leben', 'liegt', 'liegen', 'bietet', 'bieten', 'gibt', 'genießen', 'genießt', 'erleben', 'entdecken',
  'living', 'live', 'lives', 'enjoy', 'enjoys', 'offers', 'offer', 'features'])
const woerter = (s: string) => klartext(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const stamm = (w: string) => (w.length > 5 ? w.replace(/(?:en|em|er|es|e|n|s)$/, '') : w)
const inhaltsStaemme = (s: string) => woerter(s).filter(w => !STOPP.has(w) && (w.length >= 4 || /\p{N}/u.test(w))).map(stamm)
const stehtImLocker = (b: Block, f: Finding): boolean => {
  if (stehtIm(b, f)) return true
  if (!istBehauptung(f)) return false
  const st = inhaltsStaemme(suchText(f))
  if (!st.length) return false
  return blaetter(b).some(bl => {
    if (NIE_SUCHEN.has(String(bl.path[0]))) return false
    const ws = woerter(bl.text)
    return st.every(x => ws.some(w => /\p{N}/u.test(x) ? w === x : (w.startsWith(x) || (x.length >= 6 && w.includes(x)))))
  })
}
/** Eine Behauptung gilt erst als behoben, wenn sie in KEINEM Block mehr steht -
 *  auch nicht in einem Systemblock oder einem anderen KI-Block (sonst falsches Gruen). */
const nirgends = (bs: Block[], f: Finding) => bs.every(b => !b || !stehtImLocker(b, f))
/** Ziel einer Behauptung erreicht: im eigenen Block weg, und in jedem anderen Block,
 *  in dem sie noch steht, haelt ein EIGENER roter Befund mit derselben Aussage die
 *  Ampel rot (je Block gemeldete Behauptungen, etwa Tagline + Anschreiben + Spalte).
 *  Ohne solchen Befund gilt weiter: nirgends mehr (kein falsches Gruen). */
const behauptungBehoben = (bs: Block[], bi: number, f: Finding, claims: Finding[]) => bs.every((b, i) => !b || !stehtImLocker(b, f)
  || (i !== bi && claims.some(c => c !== f && c.block === i && ROT.includes(c.severity) && suchText(c) === suchText(f) && stehtIm(b, c))))

export function autofixDeck(
  input: Block[],
  found: { gate: Finding[]; claims: Finding[]; other: Finding[] },
  ctx: DeckContext,
  mode: AutofixMode,
): AutofixResult {
  const vorher = [...found.gate, ...found.other, ...found.claims]
  const vorherRot = zaehleRot(vorher)
  const leer = (status: AutofixReport['status'], extra: Partial<AutofixReport> = {}): AutofixResult => ({
    blocks: input,
    findings: [...found.gate, ...found.other, ...found.claims],
    applied: 0,
    report: {
      version: 1, mode, status,
      before: { status: ampel(vorher), red: vorherRot },
      after: { status: ampel(vorher), red: vorherRot },
      changes: [], fixed_findings: [], skipped: [], applied_at: new Date().toISOString(),
      ...extra,
    },
  })
  if (mode === 'off') return leer('nothing_to_fix')

  try {
    const work: Block[] = structuredClone(input)
    const skipped: AutofixReport['skipped'] = []
    const skipVon = new Map<AutofixReport['skipped'][number], Finding>()
    const skip = (f: Finding, reason: SkipReason, block = f.block) => {
      const e = { key: f.key, block, what: kurz(f.what, 200), reason }
      skipped.push(e); skipVon.set(e, f)
    }

    // 1. Kandidaten
    const kandidaten = [...found.gate, ...found.claims]
      .filter(f => (AUTOFIX_RULES[f.key] ?? []).includes(f.severity))
      .sort((a, b) => SEV_RANG[a.severity] - SEV_RANG[b.severity])
    const changes: AutofixChange[] = []
    const fixed: AutofixReport['fixed_findings'] = []
    const fixedClaims = new Set<Finding>()
    // Je Block: oberster Feldschluessel -> Zahl der angenommenen Aenderungen (fuer die Gesamtpruefung)
    const beruehrt = new Map<number, Map<string, number>>()
    const weg = new Map<number, Weg>()
    const mitWeg = (alt: Weg | undefined, neu: Array<[string, number]>): Weg => {
      const m: Weg = new Map([...(alt ?? new Map<string, number[]>())].map(([k, v]) => [k, [...v]]))
      for (const [k, i] of neu) m.set(k, [...(m.get(k) ?? []), i])
      return m
    }
    let gateJetzt = runDeckGate(work, ctx).findings
    let versuche = 0

    for (const f of kandidaten) {
      // Blockzuordnung: Gate-Befunde tragen sie; Behauptungen ohne block_index
      // nur bei GENAU einem Treffer im ganzen Deck, und der nicht in einem
      // Systemblock (sonst bliebe die Aussage dort stehen).
      let bi = f.block
      if (bi == null) {
        if (!istBehauptung(f)) { skip(f, 'nicht_lokalisierbar'); continue }
        const kand = work.map((b, i) => ({ b, i })).filter(x => stehtIm(x.b, f))
        const gesperrt = kand.find(x => istGesperrterBlock(x.b))
        if (gesperrt) { skip(f, 'systemblock', gesperrt.i); continue }
        if (kand.length > 1) { skip(f, 'mehrdeutig'); continue }
        if (!kand.length) { skip(f, 'nicht_lokalisierbar'); continue }
        bi = kand[0].i
      }
      const blk = work[bi]
      if (!blk) { skip(f, 'nicht_lokalisierbar', bi); continue }
      if (istGesperrterBlock(blk)) { skip(f, 'systemblock', bi); continue }

      // Schon durch eine fruehere Korrektur mit erledigt?
      const nochDa = istBehauptung(f)
        ? stehtIm(blk, f)
        : gateJetzt.some(g => g.key === f.key && g.block === bi && g.loc?.match === f.loc?.match)
      if (!nochDa) {
        if (!f.loc?.match && !f.claim) { skip(f, 'nicht_lokalisierbar', bi); continue }
        // Nur als mit entfernt werten, wenn die Stelle im Original stand bzw. das Gate
        // im Block keinen Befund dieser Art mehr meldet (sonst nur der Ausschnitt anders).
        if (istBehauptung(f) ? stehtIm(input[bi], f) && nirgends(work, f) : !gateJetzt.some(g => g.key === f.key && g.block === bi)) {
          fixed.push({ key: f.key, block: bi, what: kurz(f.what, 200), via: 'mit_entfernt' })
          if (istBehauptung(f)) fixedClaims.add(f)
        } else skip(f, 'nicht_lokalisierbar', bi)
        continue
      }
      if (versuche >= MAX_CHANGES) { skip(f, 'limit', bi); continue }
      versuche++

      const sicherung = structuredClone(work[bi])
      // Gate-Befunde frisch aus dem aktuellen Gate-Lauf: Hat eine fruehere Korrektur
      // einen Absatz oder Listenpunkt entfernt, stimmt nur dessen loc.field noch.
      const frisch = istBehauptung(f) ? f
        : gateJetzt.find(g => g.key === f.key && g.block === bi && g.loc?.match === f.loc?.match) ?? f
      let v = korrigieren(work, bi, frisch, ctx, mitWeg(weg.get(bi), []))
      let gateNeu = v.ok ? runDeckGate(work, ctx).findings : gateJetzt
      // Das Gate meldet je Block und Wert nur die erste Fundstelle. Steht derselbe
      // Wert noch in einem weiteren Feld, nennt es nach der Korrektur genau dieses
      // Feld - nur dort wird mit korrigiert (nie in Feldern, die das Gate nicht nennt).
      // Preis im Fliesstext: ein Befund je Feld - ein weiterer Preis im SELBEN Feld
      // (anderer Wortlaut) wird ebenfalls mit bereinigt. Zaehlwerte: derselbe Wert in
      // anderem Wortlaut („3 Schlafzimmer" / „drei Schlafzimmer") meldet das Gate je
      // Block nur einmal - er gehoert zum selben Befund.
      const sollZahl = istZaehlwert(f.key) ? zaehlwertVon(f.key, f.loc?.match) : NaN
      const gleicherWert = (g: Finding) => g.loc?.match === f.loc?.match
        || (Number.isFinite(sollZahl) && zaehlwertVon(f.key, g.loc?.match) === sollZahl)
      for (let runde = 0; v.ok && !istBehauptung(f) && runde < 5; runde++) {
        const weiter = gateNeu.find(g => g.key === f.key && g.block === bi && g.loc?.field
          && (gleicherWert(g) || (f.key === 'preis_im_fliesstext' && g.loc.field === frisch.loc?.field)))
        if (!weiter) break
        const v2 = korrigieren(work, bi, weiter, ctx, mitWeg(weg.get(bi), v.entfernt))
        if (!v2.ok) { v = v2; break }
        v = { ok: true, changes: [...v.changes, ...v2.changes], entfernt: [...v.entfernt, ...v2.entfernt] }
        gateNeu = runDeckGate(work, ctx).findings
      }
      if (!v.ok) { work[bi] = sicherung; skip(f, v.reason, bi); continue }

      // 2. Einzelpruefung: Ziel weg, nichts Neues, Block nicht ueber die Haelfte.
      const zielWeg = istBehauptung(f)
        ? behauptungBehoben(work, bi, f, found.claims)
        : !gateNeu.some(g => g.key === f.key && g.block === bi && g.loc?.match === f.loc?.match)
      const rest = new Map<string, number>()
      for (const g of gateJetzt) rest.set(fKey(g), (rest.get(fKey(g)) ?? 0) + 1)
      if (!istBehauptung(f)) rest.set(fKey(f), (rest.get(fKey(f)) ?? 0) - 1)
      let neu = false
      for (const g of gateNeu) {
        const n = (rest.get(fKey(g)) ?? 0) - 1
        rest.set(fKey(g), n)
        if (n < 0) neu = true
      }
      const nurTagline = v.changes.every(c => c.action === 'feld_geleert')
      const zuViel = !nurTagline && textLaenge(input[bi]) > 0
        && (textLaenge(input[bi]) - textLaenge(work[bi])) / textLaenge(input[bi]) > MAX_ANTEIL_BLOCK
      if (!zielWeg || neu || zuViel) {
        work[bi] = sicherung
        skip(f, neu ? 'neuer_befund' : !zielWeg ? 'ziel_nicht_behoben' : 'limit', bi)
        continue
      }
      gateJetzt = gateNeu
      changes.push(...v.changes)
      weg.set(bi, mitWeg(weg.get(bi), v.entfernt))
      const zahl = beruehrt.get(bi) ?? new Map<string, number>()
      for (const c of v.changes) {
        const top = c.field.match(/^[^.[]+/)?.[0] ?? c.field
        zahl.set(top, (zahl.get(top) ?? 0) + 1)
      }
      beruehrt.set(bi, zahl)
      fixed.push({ key: f.key, block: bi, what: kurz(f.what, 200), via: 'korrektur' })
      if (istBehauptung(f)) fixedClaims.add(f)
    }

    // Behauptungen, deren Aussage durch eine Streichung mitverschwunden ist (auch
    // mittel/niedrig): nur wenn sie vorher nachweislich da stand.
    for (const c of found.claims) {
      if (fixedClaims.has(c) || !changes.length) continue
      const bloecke = c.block != null ? [c.block] : input.map((_, i) => i)
      const vorherDa = bloecke.some(i => input[i] && stehtIm(input[i], c))
      if (vorherDa && nirgends(work, c)) {
        fixedClaims.add(c)
        fixed.push({ key: c.key, block: c.block, what: kurz(c.what, 200), via: 'mit_entfernt' })
      }
    }

    // Was am Ende doch mit entfernt wurde, steht nicht mehr unter „nicht bereinigt".
    for (let i = skipped.length - 1; i >= 0; i--) {
      const sf = skipVon.get(skipped[i])
      if (sf && fixedClaims.has(sf)) skipped.splice(i, 1)
    }

    const nachher = [...gateJetzt, ...found.other, ...found.claims.filter(c => !fixedClaims.has(c))]
    const basis = {
      version: 1 as const, mode,
      before: { status: ampel(vorher), red: vorherRot },
      after: { status: ampel(nachher), red: zaehleRot(nachher) },
      changes, fixed_findings: fixed, skipped, applied_at: new Date().toISOString(),
    }
    if (!changes.length) return leer('nothing_to_fix', { fixed_findings: fixed, skipped })

    // 3. Gesamtpruefung - schlaegt etwas an, geht ALLES zurueck.
    const korrekturen = fixed.filter(x => x.via === 'korrektur').length
    const grund = gesamtPruefung(input, work, beruehrt, korrekturen, vorherRot, zaehleRot(nachher))
    if (grund) return leer('rolled_back', { rollback_reason: grund.grund, rollback_code: grund.code, changes, fixed_findings: [], skipped })

    if (mode === 'dry_run') {
      return { blocks: input, findings: [...found.gate, ...found.other, ...found.claims], applied: 0,
        report: { ...basis, status: 'dry_run' } }
    }
    return { blocks: work, findings: nachher, applied: changes.length,
      report: { ...basis, before: { ...basis.before, findings: vorher }, status: 'applied' } }
  } catch (e) {
    return leer('error', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** Laenge der laengsten gemeinsamen Teilfolge (stabiler Vergleich je Element). */
function gemeinsam(a: unknown[], b: unknown[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = stableEqual(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  return dp[0][0]
}

/** Invarianten nach allen Korrekturen. Liefert Grund und Code oder null.
 *  beruehrt: je Block oberster Feldschluessel -> Zahl der angenommenen Aenderungen.
 *  Listen werden elementweise verglichen: nur entfernte oder geaenderte Elemente,
 *  hoechstens so viele, wie Aenderungen diese Liste nennen, nie neue.
 *  Exportiert nur fuer scripts/verify-deck-autofix.mjs. */
export function gesamtPruefung(input: Block[], work: Block[], beruehrt: Map<number, Map<string, number>>, korrekturen: number,
  rotVorher: number, rotNachher: number): { code: RollbackCode; grund: string } | null {
  const r = (code: RollbackCode, grund: string) => ({ code, grund })
  if (input.length !== work.length) return r('blockzahl', 'Blockzahl verändert')
  if (input.some((b, i) => b?.type !== work[i]?.type)) return r('blockfolge', 'Blockfolge verändert')
  let gesamt = 0, entfernt = 0
  for (let i = 0; i < input.length; i++) {
    const a = input[i], b = work[i]
    if (istGesperrterBlock(a)) {
      if (!stableEqual(a, b)) return r('systemblock', `Systemblock ${i} verändert`)
      continue
    }
    for (const k of [...DETERMINISTIC_FIELDS, 'number', 'imageIntent', 'assetId']) {
      if (!stableEqual(a[k], b[k])) return r('festes_feld', `Feld ${k} in Block ${i} verändert`)
    }
    const erlaubt = beruehrt.get(i) ?? new Map<string, number>()
    const alle = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of alle) {
      if (stableEqual(a[k], b[k])) continue
      const n = erlaubt.get(k) ?? 0
      if (!n) return r('ohne_korrektur', `Feld ${k} in Block ${i} ohne Korrektur verändert`)
      if (Array.isArray(a[k]) || Array.isArray(b[k])) {
        if (!Array.isArray(a[k]) || !Array.isArray(b[k])) return r('ohne_korrektur', `Liste ${k} in Block ${i} ersetzt`)
        const la = a[k] as unknown[], lb = b[k] as unknown[]
        const gleich = gemeinsam(la, lb)
        if (lb.length - gleich > la.length - gleich || la.length - gleich > n) {
          return r('ohne_korrektur', `Liste ${k} in Block ${i} weiter verändert als die Korrekturen`)
        }
      }
    }
    const la = textLaenge(a), lb = textLaenge(b)
    gesamt += la
    entfernt += Math.max(0, la - lb)
  }
  if (korrekturen > MAX_CHANGES) return r('zu_viele', `mehr als ${MAX_CHANGES} Korrekturen`)
  if (gesamt > 0 && entfernt / gesamt > MAX_ANTEIL_GESAMT) return r('textanteil', `mehr als ${Math.round(MAX_ANTEIL_GESAMT * 100)} % des Textes entfernt`)
  if (rotNachher > rotVorher) return r('rot_mehr', 'mehr rote Befunde als vorher')
  if (korrekturen < 1) return r('nichts_behoben', 'kein Befund behoben')
  return null
}

// ── Ruecknahme im Deck-Chat (refine-deck, action 'undo') ─────────────────────
/** Entscheidung fuer das Undo, rein und ohne DB (getestet in verify-deck-autofix.mjs).
 *  Erste Ruecknahme nach einer Autobereinigung: prev_content ist dann sicher die
 *  unbereinigte KI-Fassung (nur generate-deck setzt es beim Anlegen, revision 0).
 *  Die Ampel springt mit zurueck, sonst stuende ein falsches Gruen am alten Text.
 *  'laeuft': ein Feinschliff wuerde die Ruecknahme gleich wieder ueberschreiben.
 *  'normal': gewoehnliches Undo, nur der Inhalt. */
export function undoNachAutofix(deck: Record<string, unknown>, jetzt: string):
  { art: 'normal' } | { art: 'laeuft' } | { art: 'autofix'; update: Record<string, unknown> } {
  type AfReport = { status?: string; before?: { status?: string; findings?: unknown[] } } & Record<string, unknown>
  const report = (deck.quality_report ?? null) as (Record<string, unknown> & { autofix?: AfReport | null }) | null
  const af = report?.autofix ?? null
  const vorher = af?.before
  const revision = Number(deck.revision ?? 0) || 0
  if (!deck.prev_content || revision !== 0 || af?.status !== 'applied' || !vorher?.status || !Array.isArray(vorher.findings)) return { art: 'normal' }
  if (deck.refining) return { art: 'laeuft' }
  return { art: 'autofix', update: {
    content: deck.prev_content, prev_content: null,
    quality_status: vorher.status,
    quality_report: { ...report, status: vorher.status, findings: vorher.findings, autofix: { ...af, status: 'undone', undone_at: jetzt } },
    quality_checked_at: jetzt,
  } }
}
