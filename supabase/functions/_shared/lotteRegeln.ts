// Feste Antwortregeln für Lotte (Sven, 30.10.2026).
//
// 1. angebot: Angebots- oder Exposé-Anfrage (Markus Schink, 28.10.: "bitte stellen
//    Sie uns eine Liste der Investitionsmöglichkeiten zu"). Nicht einfach Exposés
//    schicken, sondern verkaufen: Lotte fragt, ob die bisherigen Angebote angekommen
//    sind (ungeöffnet mit Spam-Hinweis), sagt, dass wir über 200 Einheiten betreuen
//    und nur taggenau anbieten können, und fragt nach Suchprofil und Budget. Neue
//    Projekte wählt Sven. Er bekommt eine Notiz mit dem schon Verschickten und 2 bis
//    3 freien Projekten, die der Kunde noch nicht hat.
// 2. bautraeger: Projekt- und Bauträgernamen erst, wenn die Registrierung beim
//    Bauträger raus ist (lead_registrations), sonst Lage plus Objekttyp. Bei EMMETRE
//    (Flora Panorama) Aaron als deutschen Ansprechpartner nennen und einen Zoom mit
//    ihm anbieten (Helen, 29.10.: "Wer ist der Bauträger?"). Gilt auch für Lottes
//    Fakten-Antworten (booking-bot faktenAntwort).
// 3. region: Der Kunde sucht lieber woanders (Arne, 29.10.: "Ich werde doch eher in
//    der Region Protaras suchen"). Nie verabschieden: Preisvorteil anerkennen, belegte
//    Vorteile von Paphos, offene Frage. Die Zahlen stehen in crm_settings
//    lotte_region_fakten, damit sie monatlich nachgezogen werden können.
// 4. geld: Provision, Tippgeber-Vergütung und Nachlass übernimmt Sven. Lotte nennt
//    keine Beträge.
//
// Hier liegen nur reine Funktionen (kein DB-Zugriff), damit
// scripts/verify-lotte-regeln.mjs sie ohne Deno testen kann.

export type LotteRegel = 'angebot' | 'bautraeger' | 'region' | 'geld'

// Vorfilter vor dem KI-Aufruf. Großzügig: er soll nur "danke" und "ok" fernhalten,
// entscheiden tut die KI (im Zweifel keine Regel, dann läuft alles wie bisher).
// Mit englischen Stichwörtern, weil Lotte auch englischen Kunden antwortet.
const VORFILTER: Record<LotteRegel, RegExp> = {
  angebot: /angebot|expos[eé]|\bliste\b|übersicht|portfolio|investition|möglichkeit|unterlagen|vorschl[äa]g|objekte|projekte|immobilien|wohnungen|villen|\blink|was (habt|haben|hast) (ihr|sie|du)|\b(habt|haben|hast) (ihr|sie|du)\b[^.?!\n]{0,30}\b(was|etwas|noch)\b|weitere|noch mehr|alternativ|zuschicken|zukommen|schick|offers?\b|listings?\b|properties|\blist\b|investment|opportunit|brochure|options\b|anything else|what else|do you have|send (me|us)/i,
  bautraeger: /bautr[äa]ger|entwickler|developer|bauherr|baufirma|bauunternehm|\bfirma\b|wer baut|wer steckt|gebaut|projektname|\bname\b|wie hei(ß|ss)t|welches projekt|welche anlage|seri[öo]s|builder|who (is|are) (the|behind)|who builds|construction company|name of the|reliable|trustworthy/i,
  region: /protaras|ayia napa|agia napa|\bnapa\b|larnaca|larnaka|limassol|lemesos|nikosia|nicosia|famagusta|paralimni|kyrenia|nordzypern|troodos|\bregion\b|gegend|woanders|\bnorden\b|\bosten\b|andere[nmrs]? (ort|stadt|region|gegend|insel|land)|spanien|portugal|griechenland|kreta|t[üu]rkei|dubai|mallorca|malta|italien|kroatien|bulgarien|thailand|florida|elsewhere|another (area|region|country)|\barea\b|somewhere else|rather (in|look|buy)|spain|greece|turkey|crete|italy|croatia|bulgaria|north(ern)? cyprus/i,
  geld: /provision|tippgeber|verg[üu]tung|nachlass|rabatt|skonto|prozente|konditionen|verhandel|courtage|honorar|bonus|was verdien|kick ?back|cashback|commission|discount|referral|negotiat|\bfees?\b|reduction|best price/i,
}

/** Welche Regeln könnten passen? (nur Vorfilter, leer = keine KI nötig) */
export function regelVorfilter(text: string): LotteRegel[] {
  const t = String(text ?? '')
  if (t.trim().length < 6) return []
  return (Object.keys(VORFILTER) as LotteRegel[]).filter(r => VORFILTER[r].test(t))
}

const mitName = (vorname: string | null | undefined) => (vorname ?? '').trim() ? `, ${(vorname ?? '').trim()}` : ''

// ── Datum, Preis ──────────────────────────────────────────────────────────────

/** "6.10." in deutscher Zeit. */
export function datumLabel(iso: string): string {
  const p = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: 'numeric', month: 'numeric' }).formatToParts(new Date(iso))
  const g = (t: string) => p.find(x => x.type === t)?.value ?? ''
  return `${g('day')}.${g('month')}.`
}

function tagKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
}

/** "am 6.10.", "am 6.10. und am 22.10.", "am 6.10., am 15.10. und am 22.10." */
export function datumsListe(isos: string[]): string {
  const tage = [...new Set(isos.map(datumLabel))].map(d => `am ${d}`)
  if (tage.length <= 1) return tage[0] ?? ''
  return `${tage.slice(0, -1).join(', ')} und ${tage[tage.length - 1]}`
}

/** "ab 150.000 € netto": exakt, nie gerundet (günstigste freie Einheit). */
export function preisLabel(n: number): string {
  return `ab ${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(n))} € netto`
}

// ── Namen ─────────────────────────────────────────────────────────────────────

const RECHTSFORM = /[\s,]+(ltd\.?|limited|llc|plc|gmbh|s\.?a\.?|inc\.?)$/i
// Wörter, die allein kein Projekt verraten ("Park", "Homes"): nie als eigener Treffer.
const ALLGEMEIN = new Set(['the', 'park', 'homes', 'home', 'living', 'villas', 'villa', 'residence', 'residences', 'house', 'gardens', 'garden', 'royal', 'sea', 'blue', 'golf', 'resort', 'apartments', 'tower', 'towers', 'hills', 'hill', 'view', 'heights', 'panorama', 'city', 'bay', 'beach', 'paphos', 'pafos', 'kato', 'grand', 'new', 'green', 'white', 'sun'])
const FIRMENZUSATZ = new Set(['homes', 'developers', 'developments', 'development', 'group', 'properties', 'estates', 'construction', 'constructions', 'holdings'])

/** "EMMETRE LTD" → "EMMETRE" (Rechtsform weg, Rest bleibt). */
export function bautraegerAnzeige(dev: string | null | undefined): string {
  return String(dev ?? '').trim().replace(RECHTSFORM, '').trim()
}

const normName = (s: string | null | undefined) => bautraegerAnzeige(s).toLowerCase().replace(/\s+/g, ' ')

/** Ist der Lead bei diesem Bauträger registriert? (lead_registrations.developer) */
export function istRegistriert(dev: string | null | undefined, registrierte: string[]): boolean {
  const d = normName(dev)
  return !!d && registrierte.some(r => normName(r) === d)
}

/** Woran man ein Projekt erkennt: voller Name, Name ohne Ortszusatz, markantes erstes Wort. */
export function namensTeile(name: string | null | undefined): string[] {
  const voll = String(name ?? '').trim()
  if (!voll) return []
  const basis = voll.split(/\s+-\s+|\s*\/\s*|,/)[0].trim()
  const erstes = basis.split(/\s+/)[0]
  const teile = [voll, basis]
  if (basis.includes(' ') && erstes.length >= 4 && !ALLGEMEIN.has(erstes.toLowerCase())) teile.push(erstes)
  return [...new Set(teile.filter(t => t.length >= 3))]
}

/** Woran man einen Bauträger erkennt: "Kuutio Homes" → Kuutio Homes, Kuutio. */
export function bautraegerTeile(dev: string | null | undefined): string[] {
  const roh = String(dev ?? '').trim()
  const anzeige = bautraegerAnzeige(roh)
  if (!anzeige) return []
  const w = anzeige.split(/\s+/)
  const teile = [roh, anzeige]
  if (w.length > 1 && w.slice(1).every(x => FIRMENZUSATZ.has(x.toLowerCase())) && w[0].length >= 4) teile.push(w[0])
  return [...new Set(teile.filter(t => t.length >= 3))]
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Ganze Wörter, ohne "Infinity-Pool" (Ausstattung, kein Projektname).
const namenMuster = (teile: string[]) => teile.length
  ? new RegExp(`(?<![\\p{L}\\p{N}])(${[...teile].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![\\p{L}\\p{N}]|\\s*-?\\s*pools?\\b)`, 'giu')
  : null

/** Namen durch eine neutrale Beschreibung ersetzen. */
export function namenErsetzen(text: string, teile: string[], ersatz: string): string {
  const re = namenMuster(teile)
  return re ? String(text ?? '').replace(re, ersatz) : String(text ?? '')
}

/** Steht einer der Namen im Text? */
export function enthaeltNamen(text: string, teile: string[]): boolean {
  const re = namenMuster(teile)
  return !!re && re.test(String(text ?? ''))
}

/** Ort aus den Projektfeldern: "in Chlorakas bei Paphos", "in Kato Paphos", "in Paphos". */
export function lageLabel(location: string | null | undefined, district: string | null | undefined): string {
  const stuecke = [...String(location ?? '').split(','), String(district ?? '')]
    .map(s => s.trim())
    .filter(s => s.length >= 3 && s.length <= 40 && !/\d|https?:|www\.|^(zypern|cyprus)$/i.test(s))
  const ort = stuecke.find(s => !/^(paphos|pafos)$/i.test(s)) ?? 'Paphos'
  if (/viertel\b/i.test(ort)) return `im ${ort}`
  return /paphos|pafos/i.test(ort) ? `in ${ort}` : `in ${ort} bei Paphos`
}

/** Objekttyp aus den Einheiten-Typen (crm_project_units.type). */
export function objektTyp(typen: (string | null | undefined)[]): string {
  const t = new Set(typen.filter(Boolean).map(x => String(x).toLowerCase()))
  const haus = t.has('villa') || t.has('townhouse')
  const wohnung = t.has('apartment') || t.has('studio')
  if (haus && wohnung) return 'Neubau mit Wohnungen und Villen'
  if (t.has('villa')) return 'Villenprojekt'
  if (t.has('townhouse')) return 'Neubau mit Reihenhäusern'
  return 'Neubau mit Wohnungen'
}

// ── Regel 1: Angebotsanfrage ──────────────────────────────────────────────────

export type DeckZeile = { token: string; project_id: string | null; created_at: string }
export type OutboxZeile = { status: string | null; sent_at: string | null; email_sent_at: string | null; whatsapp_sent_at: string | null; deck_tokens: string[] | null }
export type SichtZeile = { token: string | null; occurred_at: string }
export type VersandZeile = { type: string; created_at: string; content: string | null }
export type Sendung = { datum: string; mail: boolean; whatsapp: boolean; geoeffnet: boolean; tokens: string[] }

/** Was ging wann raus und wurde es angesehen? Postausgang plus Decks, die in einer
 *  ausgehenden Mail oder WhatsApp standen (z. B. Unterlagen-Anforderung aus der
 *  Anzeige). Ein Deck, das nur erzeugt, aber nie verschickt wurde, zählt nicht. */
export function sendungenBauen(decks: DeckZeile[], outbox: OutboxZeile[], sicht: SichtZeile[], versand: VersandZeile[]): Sendung[] {
  const bekannt = new Set(decks.map(d => d.token))
  const gedeckt = new Set<string>()
  const out: Sendung[] = []
  for (const o of outbox) {
    const datum = o.sent_at ?? o.email_sent_at ?? o.whatsapp_sent_at
    if (!datum || o.status === 'cancelled') continue
    const tokens = (o.deck_tokens ?? []).filter(t => bekannt.has(t))
    if (!tokens.length) continue
    tokens.forEach(t => gedeckt.add(t))
    out.push({ datum, mail: !!o.email_sent_at || !o.whatsapp_sent_at, whatsapp: !!o.whatsapp_sent_at, geoeffnet: false, tokens })
  }
  const tage = new Map<string, Sendung>()
  for (const d of decks) {
    if (gedeckt.has(d.token)) continue
    const treffer = versand.filter(v => (v.content ?? '').includes(d.token))
    if (!treffer.length && !sicht.some(s => s.token === d.token)) continue
    const datum = treffer[0]?.created_at ?? d.created_at
    const key = tagKey(datum)
    const s = tage.get(key) ?? { datum, mail: false, whatsapp: false, geoeffnet: false, tokens: [] }
    s.tokens.push(d.token)
    if (treffer.some(v => v.type === 'email')) s.mail = true
    if (treffer.some(v => v.type === 'whatsapp')) s.whatsapp = true
    tage.set(key, s)
  }
  out.push(...tage.values())
  for (const s of out) s.geoeffnet = sicht.some(e => !!e.token && s.tokens.includes(e.token))
  return out.sort((a, b) => Date.parse(a.datum) - Date.parse(b.datum))
}

function kanalText(s: Sendung[]): string {
  const mail = s.some(x => x.mail), wa = s.some(x => x.whatsapp)
  return mail && wa ? ' per Mail und WhatsApp' : mail ? ' per Mail' : wa ? ' per WhatsApp' : ''
}

/** Lottes Antwort auf eine Angebots- oder Exposé-Anfrage. */
export function lotteAngebotText(vorname: string | null, sendungen: Sendung[]): string {
  const letzte = sendungen.slice(-3)
  const teile: string[] = []
  if (letzte.length) {
    const spam = !letzte.some(s => s.geoeffnet) && letzte.some(s => s.mail)
    teile.push(`Gern${mitName(vorname)}! Sven hat dir ${datumsListe(letzte.map(s => s.datum))} schon Angebote${kanalText(letzte)} geschickt. Sind die gut bei dir angekommen?${spam ? ' Falls nicht, schau bitte kurz im Spam-Ordner nach.' : ''} 🙂`)
  } else {
    teile.push(`Gern${mitName(vorname)}! 🙂`)
  }
  teile.push('Wir betreuen über 200 Einheiten und können eigentlich nur taggenau anbieten, weil sich der Markt so schnell dreht.')
  teile.push('Damit Sven dir gezielt die passenden, aktuell freien Projekte schicken kann: Was suchst du genau (Lage, Objekttyp, selbst nutzen oder vermieten) und mit welchem Budget planst du?')
  return teile.join('\n\n')
}

export type ProjektFrei = { id: string; name: string; bautraeger: string; ort: string; ab: number; frei: number; typen: string[] }

const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöü]/g, '')

/** 2 bis 3 freie Projekte, die der Kunde noch nicht hat: preislich nah an dem, was er
 *  schon bekommen hat, gleicher Objekttyp und Bauträger mit Registrierung bevorzugt,
 *  möglichst verschiedene Bauträger. Ohne Bezug: günstig, mittel, teuer. */
export function kandidatenWaehlen(frei: ProjektFrei[], gesendet: ProjektFrei[], n = 3, registrierte: string[] = []): ProjektFrei[] {
  const schon = new Set(gesendet.map(p => p.id))
  const seen = new Set<string>()
  const pool = frei.filter(p => !schon.has(p.id) && p.ab > 0).filter(p => {
    const k = nameKey(p.name)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const preise = gesendet.map(p => p.ab).filter(x => x > 0).sort((a, b) => a - b)
  if (!preise.length) {
    const s = [...pool].sort((a, b) => a.ab - b.ab)
    const idx = [...new Set([0, Math.floor((s.length - 1) / 2), s.length - 1])].filter(i => i >= 0 && i < s.length)
    return idx.map(i => s[i]).slice(0, n)
  }
  const ref = preise[Math.floor(preise.length / 2)]
  const typen = new Set(gesendet.flatMap(p => p.typen))
  const wert = (p: ProjektFrei) => Math.abs(Math.log(p.ab / ref)) + (p.typen.some(t => typen.has(t)) ? 0 : 0.5) - (istRegistriert(p.bautraeger, registrierte) ? 0.3 : 0)
  const sortiert = [...pool].sort((a, b) => wert(a) - wert(b))
  const wahl: ProjektFrei[] = []
  for (const p of sortiert) if (wahl.length < n && !wahl.some(w => normName(w.bautraeger) === normName(p.bautraeger))) wahl.push(p)
  for (const p of sortiert) if (wahl.length < n && !wahl.includes(p)) wahl.push(p)
  return wahl
}

/** Notiz für Sven: was schon rausging und welche freien Projekte passen könnten. */
export function angebotNotiz(text: string, sendungen: Sendung[], projektVonToken: Record<string, string>, kandidaten: ProjektFrei[], registrierte: string[]): string {
  const z: string[] = [`Kunde: „${text.trim().slice(0, 600)}“`, '', 'Lotte hat gefragt, ob die bisherigen Angebote angekommen sind, und nach Suchprofil und Budget gefragt. Die neuen Projekte wählst du aus.', '']
  if (sendungen.length) {
    z.push('Schon verschickt:')
    for (const s of sendungen) {
      const namen = [...new Set(s.tokens.map(t => projektVonToken[t]).filter(Boolean))].sort().join(', ')
      z.push(`• ${datumLabel(s.datum)}${kanalText([s])}, ${s.geoeffnet ? 'angesehen' : 'nicht geöffnet'}: ${namen || 'Deck ohne Projekt'}`)
    }
  } else z.push('Bisher kein Angebot verschickt.')
  z.push('', 'Freie Projekte, die er noch nicht hat (günstigste freie Einheit):')
  if (kandidaten.length) {
    for (const k of kandidaten) z.push(`• ${k.name} (${bautraegerAnzeige(k.bautraeger) || 'Bauträger offen'}, ${k.ort.replace(/^i[nm] /, '')}): ${preisLabel(k.ab)}, ${k.frei} frei, ${istRegistriert(k.bautraeger, registrierte) ? 'registriert' : 'noch nicht registriert'}`)
  } else z.push('• keine passenden gefunden')
  return z.join('\n')
}

// ── Regel 2: Bauträger und Projektname ────────────────────────────────────────

// Bauträger mit deutschem Ansprechpartner (Sven 30.10.: "Aaron ist Deutscher, also
// dt. Ansprechpartner und entsprechende Qualität, gern Termin zum Zoom mit Aaron").
const DEUTSCHER_KONTAKT: Record<string, string> = { emmetre: 'Aaron' }

export type BautraegerProjekt = { name: string; bautraeger: string; lage: string; typ: string; registriert: boolean }

const kontaktVon = (dev: string) => DEUTSCHER_KONTAKT[normName(dev)] ?? null

/** Lottes Antwort auf "Wer ist der Bauträger?" bzw. "Wie heißt das Projekt?". */
export function lotteBautraegerText(vorname: string | null, projekte: BautraegerProjekt[]): string {
  const offen = projekte.filter(p => p.registriert && bautraegerAnzeige(p.bautraeger))
  const zu = projekte.filter(p => !offen.includes(p))
  const s: string[] = []
  if (offen.length === 1 && !zu.length) {
    s.push(`Gern${mitName(vorname)}! Der Bauträger von ${offen[0].name} ist ${bautraegerAnzeige(offen[0].bautraeger)}.`)
  } else if (offen.length) {
    s.push(`Gern${mitName(vorname)}! ${offen.map((p, i) => `${i ? 'bei' : 'Bei'} ${p.name} ist es ${bautraegerAnzeige(p.bautraeger)}`).join(', ')}.`)
  } else {
    s.push(`Gute Frage${mitName(vorname)}! 🙂`)
  }
  if (zu.length) {
    const was = zu.map(p => `${p.typ} ${p.lage}`)
    if (offen.length) s.push(`${zu.length === 1 ? 'Den Bauträger' : 'Die Bauträger'} beim ${was.join(' und beim ')} stellt dir Sven gern persönlich vor.`)
    else s.push(`${zu.length === 1 ? `Es ist ein ${was[0]}` : `Es sind Neubauprojekte ${zu.map(p => p.lage).join(' und ')}`}. Alles Weitere zum Bauträger erzählt dir Sven gern persönlich, ich gebe ihm direkt Bescheid.`)
  }
  const mitKontakt = offen.find(p => kontaktVon(p.bautraeger))
  if (mitKontakt) {
    const k = kontaktVon(mitKontakt.bautraeger)!
    s.push(`Dein Ansprechpartner dort ist ${k}. Er ist Deutscher, du kannst also alles auf Deutsch klären und hast jemanden mit deutschem Qualitätsanspruch an deiner Seite.`)
    s.push(`Wenn du magst, organisiert Sven dir gern einen kurzen Zoom mit ${k}, da kannst du ihm alle Fragen direkt stellen. Hast du Lust darauf? 🙂`)
  } else if (offen.length) {
    s.push(`Wenn du mehr über ${offen.length === 1 ? bautraegerAnzeige(offen[0].bautraeger) : 'die Bauträger'} wissen möchtest, erzählt dir Sven gern mehr dazu. 🙂`)
  }
  return s.join(' ')
}

/** Betreff der Notiz: mit Zoom-Angebot, wenn Lotte einen deutschen Kontakt genannt hat. */
export function bautraegerBetreff(projekte: BautraegerProjekt[]): string {
  const p = projekte.find(x => x.registriert && kontaktVon(x.bautraeger))
  return p ? `🏗️ Lotte: Bauträger genannt, Zoom mit ${kontaktVon(p.bautraeger)} angeboten` : '🏗️ Lotte: Frage nach dem Bauträger'
}

/** Notiz für Sven zur Bauträger-Frage. */
export function bautraegerNotiz(text: string, projekte: BautraegerProjekt[]): string {
  const z: string[] = [`Kunde: „${text.trim().slice(0, 600)}“`, '']
  for (const p of projekte) {
    z.push(p.registriert
      ? `• ${p.name}: Registrierung bei ${bautraegerAnzeige(p.bautraeger)} vorhanden, Lotte hat den Namen genannt.`
      : `• ${p.name}: noch keine Registrierung bei ${bautraegerAnzeige(p.bautraeger) || 'dem Bauträger'}, Lotte hat keinen Namen genannt (${p.typ} ${p.lage}). Erst registrieren, dann Namen nennen.`)
  }
  const mitKontakt = projekte.find(p => p.registriert && kontaktVon(p.bautraeger))
  if (mitKontakt) z.push('', `Lotte hat einen Zoom mit ${kontaktVon(mitKontakt.bautraeger)} angeboten. Sagt der Kunde ja, bitte den Termin mit ${kontaktVon(mitKontakt.bautraeger)} abstimmen.`)
  return z.join('\n')
}

// ── Regel 3: andere Region ────────────────────────────────────────────────────

export type RegionEintrag = { name: string; suche: string[]; guenstiger?: boolean; auslastung?: number; saison?: number; hinweis?: string }
export type RegionFakten = { stand: string; quelle: string; paphos: { auslastung: number; saison: number }; regionen: RegionEintrag[]; allgemein?: string }

// Startwerte: AirDNA-Marktseiten, Stand 27.10.2026, Kurzzeitvermietung, letzte 12
// Monate (Saison-Wert: höher = gleichmäßigere Nachfrage übers Jahr). Flughafen
// Larnaca bis Protaras 55 bis 66 km, 45 bis 60 Minuten. Winter 2025/26 rund 10.500
// offene Hotelbetten in Paphos (Cyprus Mail, 26.12.2025). Aktuelle Werte stehen in
// crm_settings lotte_region_fakten (gleiche Form) und gehen vor.
export const REGION_FAKTEN_START: RegionFakten = {
  stand: '27.10.2026',
  quelle: 'AirDNA',
  paphos: { auslastung: 69, saison: 69 },
  regionen: [
    { name: 'Protaras', suche: ['protaras'], guenstiger: true, auslastung: 61, saison: 44, hinweis: 'Und während es vom Flughafen Larnaca bis Protaras 45 bis 60 Minuten sind, hat Paphos seinen eigenen Flughafen.' },
  ],
  allgemein: 'Auch im Winter ist in Paphos viel los: Im Winter 2025/26 waren dort rund 10.500 Hotelbetten geöffnet (Cyprus Mail).',
}

/** crm_settings lotte_region_fakten lesen; kaputt oder leer = Startwerte. */
export function regionFaktenLesen(raw: string | null | undefined): RegionFakten {
  try {
    const f = JSON.parse(String(raw ?? '')) as RegionFakten
    if (typeof f?.paphos?.auslastung === 'number' && typeof f?.paphos?.saison === 'number' && f.stand && f.quelle && Array.isArray(f.regionen)) return f
  } catch { /* Startwerte */ }
  return REGION_FAKTEN_START
}

export function regionFinden(region: string | null | undefined, f: RegionFakten): RegionEintrag | null {
  const r = String(region ?? '').toLowerCase()
  if (!r) return null
  return f.regionen.find(e => [e.name, ...e.suche].some(s => r.includes(s.toLowerCase()))) ?? null
}

/** Lottes Antwort, wenn jemand lieber in einer anderen Region sucht. */
export function lotteRegionText(vorname: string | null, region: string | null, f: RegionFakten): string {
  const r = regionFinden(region, f)
  const name = r?.name ?? (String(region ?? '').trim().replace(/^\p{Ll}/u, c => c.toUpperCase()) || null)
  const kopf = [`Danke dir für die offene Rückmeldung${mitName(vorname)}! 🙂`]
  if (r?.guenstiger) kopf.push(`${r.name} ist beim Kaufpreis oft günstiger, das stimmt.`)
  else if (name) kopf.push(`${name} hat natürlich auch seinen Reiz.`)
  const mitte: string[] = []
  if (r?.auslastung != null) {
    mitte.push(`Bei der Vermietung lohnt aber ein Vergleich: Laut ${f.quelle} (Stand ${f.stand}) waren Ferienwohnungen in Paphos in den letzten 12 Monaten zu ${f.paphos.auslastung} % ausgelastet, in ${r.name} zu ${r.auslastung} %.`)
    if (r.saison != null) mitte.push(`Die Nachfrage verteilt sich in Paphos auch gleichmäßiger übers Jahr (Saisonwert ${f.paphos.saison} statt ${r.saison} von 100).`)
  } else {
    mitte.push(`Schau dir Paphos aber gern noch einmal im Vergleich an: Laut ${f.quelle} (Stand ${f.stand}) waren Ferienwohnungen dort in den letzten 12 Monaten zu ${f.paphos.auslastung} % ausgelastet, und die Nachfrage verteilt sich gut übers Jahr (Saisonwert ${f.paphos.saison} von 100).`)
  }
  const extra = r?.hinweis ?? f.allgemein
  if (extra) mitte.push(extra)
  return [kopf.join(' '), mitte.join(' '), 'Was ist dir bei deiner Suche am wichtigsten: selbst nutzen, vermieten oder beides?'].join('\n\n')
}

export function regionNotiz(text: string, region: string | null, f: RegionFakten): string {
  return [
    `Kunde: „${text.trim().slice(0, 600)}“`, '',
    `Er schaut ${region ? `in ${region}` : 'in einer anderen Region'}. Lotte hat ihn im Kontakt gehalten (Vorteile von Paphos laut ${f.quelle}, Stand ${f.stand}) und nach seinen Prioritäten gefragt. Bitte persönlich nachfassen.`,
  ].join('\n')
}

// ── Regel 4: Geld ─────────────────────────────────────────────────────────────

const GELD_WORTE = /provision|tippgeber|verg[üu]tung|nachlass|rabatt|skonto|courtage|honorar|bonus|cashback|kick ?back/i

/** Spricht ein Lotte-Text über Provision, Nachlass & Co. und nennt dabei eine Zahl? */
export function geldMitZahl(text: string): boolean {
  const t = String(text ?? '')
  return GELD_WORTE.test(t) && /\d/.test(t)
}

export function geldNotiz(text: string, imGespraech: boolean): string {
  return [
    `Kunde: „${text.trim().slice(0, 600)}“`, '',
    imGespraech ? 'Lotte hat nur geschrieben, dass du dich persönlich meldest, ohne Beträge.' : 'Lotte hat dazu nichts geschrieben.',
  ].join('\n')
}

// ── Preise in Fakten-Antworten (Sven 30.10.2026) ──────────────────────────────
// "Lotte darf den Preis nennen, wenn er sicher aus dem CRM kommt." Sicher heißt:
// live aus crm_project_units (freie Wohnungen) oder aus dem Zahlungsplan des
// Projekts, nicht aus dem Angebotstext oder der Beschreibung, die veraltet sein
// können. faktenAntwort prüft danach jeden Betrag gegen diese Liste.

export type EinheitFrei = { nummer: string | null; typ: string | null; schlafzimmer: number | null; flaeche: number | null; preis: number }

const TYP_DE: Record<string, string> = { apartment: 'Wohnung', studio: 'Studio', villa: 'Villa', townhouse: 'Reihenhaus' }
const zahlDe = (n: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(n)

/** Abschnitt für die Fakten: freie Wohnungen mit Preis, günstigste zuerst. */
export function preisListe(einheiten: EinheitFrei[], max = 40): string {
  const kopf = 'PREISE UND FREIE WOHNUNGEN (live aus dem CRM, nur diese Preise gelten)'
  if (!einheiten.length) return `${kopf}: Im CRM ist gerade keine Wohnung als frei hinterlegt.`
  const s = [...einheiten].sort((a, b) => a.preis - b.preis)
  const zeilen = s.slice(0, max).map(e => {
    const teile = [TYP_DE[(e.typ ?? '').toLowerCase()] ?? 'Wohnung']
    if (e.schlafzimmer && e.schlafzimmer > 0) teile.push(`${e.schlafzimmer} Schlafzimmer`)
    if (e.flaeche && e.flaeche > 0) teile.push(`${zahlDe(e.flaeche)} m²`)
    return `${e.nummer ?? 'ohne Nummer'}: ${teile.join(', ')}, ${preisLabel(e.preis).replace(/^ab /, '')}`
  })
  return [
    `${kopf}: ${preisLabel(s[0].preis)} (günstigste freie Wohnung), ${s.length} ${s.length === 1 ? 'Wohnung' : 'Wohnungen'} frei`,
    ...zeilen,
    s.length > max ? `(und ${s.length - max} weitere, alle teurer)` : '',
  ].filter(Boolean).join('\n')
}

const ZAHL = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?`
const BETRAG = new RegExp(String.raw`(?:€|\beuro?\b)\s?(${ZAHL})|(${ZAHL})\s?(?:€|\beuro?\b|tsd\b|k\b|mio\b|million|netto|brutto)`, 'gi')
const ziffernKern = (z: string) => z.replace(/,\d{1,2}$/, '').replace(/[.,]/g, '')

/** Alle Geldbeträge eines Textes als nackte Ziffern ("150.000 € netto" wird "150000"). */
export function betraegeIn(text: string): string[] {
  return [...String(text ?? '').matchAll(BETRAG)].map(m => ziffernKern(m[1] ?? m[2] ?? ''))
}

/** Alle Zahlen eines Textes als nackte Ziffern. */
export function zahlenIn(text: string): string[] {
  return [...String(text ?? '').matchAll(new RegExp(ZAHL, 'g'))].map(m => ziffernKern(m[0]))
}

/** Beträge in Lottes Antwort, die nicht sicher aus dem CRM kommen (leer = alles gut). */
export function fremdeBetraege(antwort: string, crm: Iterable<string>): string[] {
  const erlaubt = new Set(crm)
  return betraegeIn(antwort).filter(b => !erlaubt.has(b))
}
