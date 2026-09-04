// Supabase Edge Function: generate-deck
// Schreibt aus Fakten + Kunden-Briefing ein personalisiertes Sales-Deck (Claude)
// und legt es als sales_decks-Zeile an. Gibt token + url zurück.
//
// Body: { recipient_name, angle, briefing, facts, month_label?,
//         lead_id?, deal_id?, project_id?, unit_id?, batch_id?, created_by? }
// Bilder werden NICHT hier gesetzt — die hängt der Import/Generator später an die
// Bild-Slots (Stufe 1: Platzhalter zum Beurteilen der Texte/Struktur).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { translateOutbound } from '../_shared/translate.ts'
import { jsonrepair } from 'https://esm.sh/jsonrepair@3.8.0'
import { callAnthropic, toolInput } from '../_shared/anthropic.ts'
import { emitDeckSchema } from '../_shared/deckBlocks.ts'
import { TRUTH_RULES } from '../_shared/deckRules.ts'
import { eur, VAT_CAP_SQM } from '../_shared/deckVat.ts'
import { buildDeckContext, MARINA_MODEL, type DeckContext, type FurnitureMode, type PaySchedule } from '../_shared/deckContext.ts'
import { applyDeterministic, type ScrubEvent } from '../_shared/deckNormalize.ts'
import { runDeckGate, claimIssuesToFindings, type Finding } from '../_shared/deckGate.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SYSTEM = `Du bist der Deck-Texter von Happy Property Cyprus — einer Brokerage für deutschsprachige Kapitalanleger, die Immobilien auf Zypern (Paphos) kaufen.

Du schreibst ein PERSÖNLICHES, hochwertiges Verkaufs-Deck für genau EINEN Kunden und EIN Apartment. Stil: editorial wie ein gutes Reise- oder Architektur-Magazin, warm, „du"-Form, sinnlich und KONKRET. Deutsch.

So schreibst du gute Texte (das ist die halbe Miete — gib dir hier Mühe):
- KONKRET statt allgemein: nicht „traumhafte Lage" oder „hochwertige Ausstattung", sondern das konkrete Bild — der Geruch von Pinien auf der Morgen-Terrasse, das Licht um 18 Uhr auf dem Wasser, die 7 Gehminuten zur Bäckerei. Nutze die echten Fakten aus dem Input als Sinnesanker.
- RHYTHMUS: wechsle kurze und lange Sätze. Ein kurzer Satz setzt einen Akzent. Dann darf ein längerer das Bild ausmalen. Nie drei gleich lange Sätze hintereinander.
- SCHLAGZEILEN wie ein Magazin: neugierig machend, kein Behörden-Deutsch. „Morgens Espresso, abends Meer" schlägt „Ihre neue Terrasse".
- VERBOTEN sind Worthülsen und Makler-Floskeln: „einzigartige Gelegenheit", „Wohnen auf höchstem Niveau", „nicht nur ... sondern auch", „lassen Sie sich verzaubern", „Lebensqualität pur", „ein Muss für". Streiche jedes Adjektiv, das nichts beweist.
- KEINE Übertreibungs-Kaskaden, keine drei Ausrufezeichen, kein Werbe-Geschrei. Vertrauen entsteht durch Präzision, nicht durch Lautstärke.
- Du-Form konsequent, als spräche Sven persönlich mit genau diesem Kunden.

Du rufst das Tool emit_deck auf — Feld "blocks" = die geordnete Liste der Deck-Blöcke.

Jeder Block hat ein "type" und passende Felder. Verfügbare Block-Typen (Bilder NICHT setzen — die werden später eingehängt):

- cover:    { type, kicker, title, tagline, forLine }   // forLine = "Für <Name> — <Monat Jahr>"
- letter:   { type, kicker, headline, paragraphs:[string], signoff, signName }  // das persönliche Anschreiben
- unit:     { type, kicker, number, nickname, specs:[string], priceLines:[{label,value,strong}], note }  // priceLines = Preis-Aufstellung; setze sie NUR aus den VERBINDLICHEN PREISANGABEN (Netto/MwSt/Brutto/Einrichtung), Brutto-Zeile strong:true
- facts:    { type, kicker, headline, items:[{min,label}] }   // Lage/Entfernungen, min z.B. "5 min"
- columns:  { type, kicker, headline, cols:[{title,sub,text}] } // 3 Spalten (Terrassen, „ein Tag", o.ä.)
- feature:  { type, kicker, headline, text, quote }    // ein Highlight (Pool, Dachterrasse…)
- gallery:  { type, kicker, headline, items:[{title,caption}], note }
- benefits: { type, kicker, headline, cards:[{icon,title,text}] }  // icon = ein Emoji
- inventory:{ type, kicker, headline, intro, groups:[{title,icon,items:[string]}], note }  // Vollausstattung: Möbel/Geräte/Premium-Marken + Geschirr/Besteck + Wäsche. icon = ein Emoji, items = kurze Stichpunkte
- floorplan:{ type, kicker, headline, stats:[{value,unit,label}], bullets:[{strong,text}] }
- payment:  { type, kicker, headline, intro, phase1:{label,title,rows:[{label,sub,value}],sumLabel,sumValue}, phase2:{label,title,rows:[{label,sub,value}],advantage}, note }
- cta:      { type, kicker, headline, text, steps:[{n,title,text}] }  // n = "01"/"02"/"03"

REGELN:
1. STANDARD-REIHENFOLGE der Blöcke (HALTE DIESE EIN): (a) cover → (b) letter (Einleitung) → (c) unit (Preis-Block — bei MEHREREN Wohnungen JE Wohnung ein eigener unit-Block mit number=Wohnungsnummer, direkt hintereinander, danach optional je ein floorplan) → (c2) benefits 'Key Facts' (PFLICHT, siehe Regel 4g) → (d) facts (STANDORT/Lage mit Karte) → (d2) columns 'Warum diese Lage' (PFLICHT, siehe Regel 4h) → (e) gallery + feature: Innen- und Außenansichten, jeden Raum benennen (Wohnzimmer, Schlafzimmer, Küche, Bad …); für Amenities wie Pool, Gym, Sauna, Yoga je ein "feature" mit kurzer Story → (f) floorplan (Grundriss, wenn Flächen/Plan vorliegen) → (g) inventory (wenn Ausstattung/Möbel in den Fakten) → (h) payment (Zahlungsplan) inkl. Fertigstellung → (i) cta. cover IMMER zuerst, cta IMMER zuletzt. HINWEIS: Eine Marina-Sektion und die Entfernungs-Chips im facts-Block werden automatisch vom System ergänzt — baue selbst KEINEN Paphos-Marina-Block, außer eine GELERNTE VORGABE verlangt es ausdrücklich.
4g. KEY FACTS (benefits-Block, PFLICHT direkt nach den unit-Blöcken): 6–8 Karten mit den stärksten KAUF-Argumenten des Objekts aus den Fakten — z.B. Fußbodenheizung, VRV-/Zentralklima, Doppel-/Dreifachverglasung, Photovoltaik/Solar, Gym, Pool, Sauna, Bauqualität/Materialien, Garantie, Smart Home, Aufzug, Tiefgarage/Stellplatz, Meerblick, Rooftop. NUR Fakten, die wirklich im Input stehen. Jede Karte: icon (Emoji), title (2–4 Worte), text (1–2 konkrete Sätze mit dem Nutzen für den Käufer). headline z.B. 'Die Key Facts — was dieses Objekt mitbringt'.
4h. WARUM DIESE LAGE (columns-Block, PFLICHT direkt nach dem facts-Block): 3 Spalten, die aus den Fakten begründen, warum GENAU diese Lage jetzt kaufenswert ist (z.B. Nachbarschaft/Charakter, Infrastruktur/Erreichbarkeit, Entwicklung der Gegend). Nutze NUR belegte Fakten aus dem Input (Regel 5e gilt: keine erfundenen Markt-Aussagen). headline z.B. 'Warum genau hier'.
2. Das "letter"-Anschreiben nimmt das Kunden-Briefing direkt auf (Situation, Motiv, Wünsche) — persönlich, als käme es von Sven. signoff "Bis bald, Sven", signName "Sven · Happy Property Cyprus".
3. Webe das Briefing auch in andere Blöcke ein, WO es inhaltlich passt (z.B. Investor → betone Vermietung/ROI/Zahlungsplan; will selbst herziehen → Lifestyle/„ein Tag"/Terrassen; Sonnenuntergang → West-Terrasse/Feature). Nicht erzwingen.
4. Wähle 10–14 Blöcke passend zum Winkel (angle): "lifestyle" = Erlebnis/Terrassen/„ein Tag"/Pool; "investment" = ROI/Vermietung/Zahlungsplan/Wertsteigerung. Mische sinnvoll. PFLICHT: Ein "payment"-Block (Zahlungsplan) MUSS dabei sein, sobald im Input Zahlungsplan-Daten stehen — bei JEDEM Deck. Ein "facts"-Block für die Lage gehört ebenfalls immer dazu. Ein "floorplan"-Block, wenn Grundriss-/Flächendaten vorliegen.
${TRUTH_RULES}
6. Preise/Beträge exakt aus den Fakten übernehmen (Format wie gegeben).
7. KRITISCH für gültiges JSON: Verwende in ALLEN Texten (Titel, Taglines, Absätze, überall) NIEMALS doppelte Anführungszeichen — weder gerade noch typografische deutsche. Für Spitznamen/Hervorhebungen nutze EINFACHE Anführungszeichen 'so' oder gar keine. Beispiel: Apartment 303 'Dior' (nicht mit doppelten Zeichen). Übergib blocks als echtes JSON-Array.`

/** Ergebnis eines Generierungslaufs — inklusive Gate-Urteil. */
interface GenResult { token: string; blocks: number; deckId: string | null; quality: 'green' | 'red'; findings: number }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Echte Drive-Bilder (oder Platzhalter) in die Bild-Slots hängen.
type DeckImages = { heroVideo?: string; renders?: string[]; floorplan?: string; floorplans?: string[]; map?: string; mapUrl?: string; mapMarker?: { x: number; y: number }; mapLat?: number; mapLng?: number; mapQuery?: string; gallery?: Array<{ url: string; category: string; label: string }> }


// ── Standort-Entfernungen + Marina-Sektion (DETERMINISTISCH, Deck-Standard) ───
// Sven (2026-07): Jedes Deck bekommt (1) Entfernungs-Chips im facts-Block
// (Flughafen/Mall/Strand/Hafen/Marina, berechnet aus Projekt-Koordinaten) und
// (2) eine eigene Marina-Sektion mit quellenbelegter Wertsteigerungs-Story.
const POIS: Array<{ label: string; lat: number; lng: number }> = [
  { label: 'Flughafen Paphos',  lat: 34.7180, lng: 32.4857 },
  { label: 'Kings Avenue Mall', lat: 34.7666, lng: 32.4232 },
  { label: 'Hafen Kato Paphos', lat: 34.7541, lng: 32.4066 },
]
const BEACHES: Array<{ label: string; lat: number; lng: number }> = [
  { label: 'Coral Bay',         lat: 34.8526, lng: 32.3678 },
  { label: 'Potima/Kissonerga', lat: 34.8180, lng: 32.3990 },
  { label: 'Lighthouse Beach',  lat: 34.7620, lng: 32.4020 },
  { label: 'Geroskipou Beach',  lat: 34.7420, lng: 32.4560 },
]
const MARINA_SITE  = { lat: 34.8306, lng: 32.3868 }   // Potima Bay (Kissonerga) — kalibriert an Mamba (3,8 km Straße)
// MARINA_MODEL kommt aus _shared/deckContext.ts — dieselbe Konstante braucht auch
// die Normalisierung, die nach jedem Feinschliff läuft.
const MARINA_ARTICLE = 'https://knews.kathimerini.com.cy/en/news/after-19-years-of-delays-the-paphos-marina-is-back-on-the-table'

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371, rad = (x: number) => x * Math.PI / 180
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
const roadKm  = (luft: number) => luft * 1.1                       // grobe Straßen-Näherung (an Mamba kalibriert)
const fmtKm   = (km: number) => km < 2 ? `${km.toFixed(1).replace('.', ',')} km` : `${Math.round(km)} km`
const driveMin = (km: number) => Math.max(4, Math.round(km * 1.3))

function distanceChips(lat: number, lng: number, lang: 'de' | 'en' = 'de'): Array<{ min: string; label: string }> {
  const ca = lang === 'en' ? 'approx.' : 'ca.'
  const chips: Array<{ min: string; label: string }> = []
  const beach = BEACHES
    .map(b => ({ ...b, km: roadKm(haversineKm(lat, lng, b.lat, b.lng)) }))
    .sort((a, b) => a.km - b.km)[0]
  chips.push({ min: `${ca} ${fmtKm(beach.km)}`, label: lang === 'en' ? `Beach (${beach.label})` : `Strand (${beach.label})` })
  for (const p of POIS) {
    chips.push({ min: `${ca} ${fmtKm(roadKm(haversineKm(lat, lng, p.lat, p.lng)))}`, label: lang === 'en' ? chipLabelEn(p.label) : p.label })
  }
  chips.push({ min: `${ca} ${fmtKm(roadKm(haversineKm(lat, lng, MARINA_SITE.lat, MARINA_SITE.lng)))}`, label: lang === 'en' ? 'New Paphos Marina (planned)' : 'Neue Paphos-Marina (geplant)' })
  return chips
}

// Marina-Story: Zahlen/Quellen aus Web-Recherche (Juli 2026) — nur belegte Werte.
// MARINA_TEXTS wird zentral gepflegt; Compliance: Wertsteigerung als Erfahrungswert/
// Prognose mit Quellen, NIE als Garantie.
const MARINA_TEXTS = {
  featureKicker:  'Standort · Die neue Paphos-Marina',
  featureHeadline: 'Nach 19 Jahren wird sie endlich gebaut.',
  featureText: 'Das hier ist das Modell der neuen Paphos-Marina in Potima Bay (Kissonerga): rund 165.000 m² Areal, bis zu 1.000 Liegeplätze zu Wasser und an Land, dazu Wohn- und Gewerbeflächen direkt am Hafenbecken — ein auf rund 200 Mio. € geschätztes Projekt (Gov.cy, 2025; Vize-Tourismusministerium, 2024). Nach 19 Jahren Verzögerung ist das Verfahren jetzt in der entscheidenden Phase: Vier internationale Bieter haben Angebote eingereicht (StockWatch, 2026), der Zuschlag ist für Ende 2026 geplant, Baubeginn April 2027 (Kathimerini, 2026). Für dich als Käufer zählt das Timing: Preise im Umfeld solcher Großprojekte ziehen erfahrungsgemäß schon mit der Vergabe an — nicht erst mit der Eröffnung. Wer vor dem Zuschlag kauft, kauft noch zu Vor-Marina-Konditionen.',
  featureQuote: 'Hafen-Lagen: weltweit +59 % Aufschlag (Knight Frank). Limassol: +102,7 % in der Marina-Dekade.',
  valuePct: '+51 %',
  valueText: 'Wasserlage ist der am besten dokumentierte Preistreiber im Immobilienmarkt: Knight Frank misst für Waterfront-Objekte im Schnitt +51 % gegenüber vergleichbaren Lagen im Landesinneren (Waterfront Homes, 2025) — Hafen-Lagen führen mit +59 % sogar das Feld an (Knight Frank, 2018). Zypern hat es vorgemacht: In der Limassol-Marina-Dekade 2015–2025 stiegen die Apartment-Preise dort um +102,7 % — Spitzenwert aller Distrikte der Insel (Zentralbank Zypern RPPI, 2026). Genau dieses Drehbuch beginnt jetzt in Paphos — noch zu Vor-Marina-Preisen.',
  note: 'Zuschlag geplant Ende 2026, Baubeginn April 2027 (Kathimerini, 2026). Quellen: Gov.cy (2025); Knight Frank (2018–2025); Zentralbank Zypern RPPI (2026); Financial Mirror (2021). Wertentwicklung = historische Erfahrungswerte, keine Garantie.',
}

// Englische Fassung: Die Marina-Sektion und die Entfernungs-Chips setzt das System
// DETERMINISTISCH ein - sie laufen nie durch die KI und blieben deshalb deutsch,
// auch wenn der Rest des Decks englisch war (Sven 27.8., Deck fuer Agustin).
const MARINA_TEXTS_EN = {
  featureKicker:  'Location · The new Paphos Marina',
  featureHeadline: 'After 19 years, it is finally being built.',
  featureText: 'This is the model of the new Paphos Marina at Potima Bay (Kissonerga): a site of around 165,000 m² with up to 1,000 berths on water and on land, plus residential and commercial space right on the harbour basin - a project estimated at around 200 million EUR (Gov.cy, 2025; Deputy Ministry of Tourism, 2024). After 19 years of delay the process has reached its decisive stage: four international bidders have submitted offers (StockWatch, 2026), the contract is due to be awarded in late 2026 and construction is scheduled to start in April 2027 (Kathimerini, 2026). What matters for you as a buyer is the timing: prices around projects of this scale typically start moving when the contract is awarded - not when the marina opens. Buying before the award still means buying at pre-marina terms.',
  featureQuote: 'Harbour locations: +59 % premium worldwide (Knight Frank). Limassol: +102.7 % over the marina decade.',
  valuePct: '+51 %',
  valueText: 'Waterfront is the best-documented price driver in real estate: Knight Frank measures an average premium of +51 % for waterfront properties over comparable inland locations (Waterfront Homes, 2025) - harbour locations lead the field at +59 % (Knight Frank, 2018). Cyprus has already shown it: during the Limassol marina decade from 2015 to 2025, apartment prices there rose by +102.7 %, the highest figure of any district on the island (Central Bank of Cyprus RPPI, 2026). That same script is now beginning in Paphos - still at pre-marina prices.',
  note: 'Contract award scheduled for late 2026, construction start April 2027 (Kathimerini, 2026). Sources: Gov.cy (2025); Knight Frank (2018-2025); Central Bank of Cyprus RPPI (2026); Financial Mirror (2021). Price development = historical experience, not a guarantee.',
}
const CHIP_LABELS_EN: Record<string, string> = {
  'Neue Paphos-Marina (geplant)': 'New Paphos Marina (planned)',
  'Flughafen Paphos': 'Paphos Airport', 'Kings Avenue Mall': 'Kings Avenue Mall',
  'Hafen Paphos': 'Paphos Harbour', 'Altstadt Paphos': 'Paphos Old Town',
  'Krankenhaus': 'Hospital', 'Supermarkt': 'Supermarket',
}
const chipLabelEn = (label: string): string => {
  if (CHIP_LABELS_EN[label]) return CHIP_LABELS_EN[label]
  // "Strand (Coral Bay)" -> "Beach (Coral Bay)" - Eigennamen bleiben stehen.
  const m = label.match(/^Strand\s*\((.+)\)$/)
  if (m) return `Beach (${m[1]})`
  return label
}

function buildMarinaBlocks(projName: string, fromSub: string, lat?: number | null, lng?: number | null, lang: 'de' | 'en' = 'de'): Array<Record<string, unknown>> {
  const T = lang === 'en' ? MARINA_TEXTS_EN : MARINA_TEXTS
  const out: Array<Record<string, unknown>> = [{
    type: 'feature',
    kicker: T.featureKicker,
    headline: T.featureHeadline,
    image: MARINA_MODEL,
    text: T.featureText,
    quote: T.featureQuote,
    link: MARINA_ARTICLE,
    linkLabel: lang === 'en' ? 'Read the news article' : 'Zum Zeitungsartikel',
  }]
  if (lat != null && lng != null) {
    const km  = roadKm(haversineKm(lat, lng, MARINA_SITE.lat, MARINA_SITE.lng))
    out.push({
      type: 'marina',
      kicker: lang === 'en' ? 'Location · New Paphos Marina' : 'Lage · Neue Paphos-Marina',
      headline: lang === 'en'
        ? `Just along the coast: approx. ${fmtKm(km)} to the marina.`
        : `Nur die Küste entlang: ca. ${fmtKm(km)} zur Marina.`,
      fromLabel: projName || (lang === 'en' ? 'Project' : 'Projekt'), fromSub,
      toLabel: lang === 'en' ? 'Paphos Marina' : 'Paphos-Marina', toSub: 'Potima Bay · Kissonerga',
      distance: `${lang === 'en' ? 'approx.' : 'ca.'} ${fmtKm(km)}`,
      drive: lang === 'en' ? `approx. ${driveMin(km)} min by car` : `ca. ${driveMin(km)} Min mit dem Auto`,
      valuePct: T.valuePct,
      valueText: T.valueText,
      note: T.note,
    })
  }
  return out
}

// Chips + Marina in die Block-Liste einsetzen (idempotent):
// - Entfernungs-Chips ERSETZEN die KI-Items im ersten facts-Block (KI-Items ohne
//   km/min-Angabe bleiben als Zusatz erhalten, max. 2 — z.B. 'Meerblick').
// - Marina-Sektion nach facts (+ direkt folgendem 'Warum diese Lage'-columns),
//   NUR wenn noch kein Marina-Block existiert (Mamba-Regeln erzeugen eigene).
function injectLocationAndMarina(
  blocks: Array<Record<string, unknown>>,
  projName: string,
  proj?: { location?: string | null; latitude?: number | null; longitude?: number | null } | null,
  lang: 'de' | 'en' = 'de',
): void {
  const lat = proj?.latitude, lng = proj?.longitude
  const fi = blocks.findIndex(b => b.type === 'facts')
  if (fi >= 0 && lat != null && lng != null) {
    const fb = blocks[fi] as Record<string, unknown>
    const aiItems = (Array.isArray(fb.items) ? fb.items as Array<{ min?: string; label?: string }> : [])
      .filter(it => !/km|min/i.test(String(it.min ?? ''))).slice(0, 2)
    fb.items = [...distanceChips(lat, lng, lang), ...aiItems]
  }
  // Feature (Story) und schematischer marina-Block werden GETRENNT geprüft:
  // Ein KI-gebauter Marina-Feature (z.B. via Mamba-Regel) darf den schematischen
  // Block nicht mehr unterdrücken — sonst fehlt die 'X km zur Marina'-Sektion.
  const marinaFeatureAt = blocks.findIndex(b =>
    b.type !== 'marina' &&
    /paphos-marina|marina/i.test(String(b.kicker ?? '') + ' ' + String(b.headline ?? '')))
  const hasMarinaSchema = blocks.some(b => b.type === 'marina')
  if (marinaFeatureAt < 0 || !hasMarinaSchema) {
    let at = fi >= 0 ? fi + 1 : Math.min(4, blocks.length - 1)
    while (at < blocks.length && blocks[at].type === 'columns') at++
    const fromSub = (proj?.location ?? '').split(',')[0].trim() || 'Region Paphos'
    let ins = buildMarinaBlocks(projName, fromSub, lat, lng, lang)
    if (marinaFeatureAt >= 0) {
      ins = ins.filter(b => b.type === 'marina')   // Story existiert schon → nur Schema ergänzen
      at = marinaFeatureAt + 1                      // direkt hinter den vorhandenen Marina-Feature
    }
    if (hasMarinaSchema) ins = ins.filter(b => b.type !== 'marina')
    blocks.splice(at, 0, ...ins)
  }
}

// ── Luma-Standard-Zahlungsplan ────────────────────────────────────────────────

// Projekt-Video (z.B. Drohnen-/Meerblick-Video) nach der Lage-/Marina-Sektion
// einsetzen — dort, wo der Kunde ohnehin über Standort & Blick liest. Idempotent.
// Entscheidet nur das Feld (embedUrl vs. videoUrl); die Embed-Normalisierung macht
// der Renderer (eine Quelle der Wahrheit). Direkte MP4 → nativer Player, sonst iframe.
function injectVideo(blocks: Array<Record<string, unknown>>, videoUrl?: string | null): void {
  const url = (videoUrl ?? '').trim()
  if (!url) return
  if (blocks.some(b => b.type === 'video')) return
  const isDirect = /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(url)
  const cover = blocks.find(b => b.type === 'cover') as { image?: string } | undefined
  const vb: Record<string, unknown> = {
    type: 'video',
    kicker: 'Rundgang',
    headline: 'Sehen statt vorstellen',
    text: 'Ein Eindruck, den kein Foto ersetzt — das Projekt in Bewegung.',
    ...(isDirect ? { videoUrl: url } : { embedUrl: url }),
    ...(cover?.image ? { poster: cover.image } : {}),
  }
  let at = blocks.findIndex(b => b.type === 'marina')
  if (at < 0) at = blocks.findIndex(b => b.type === 'facts')
  if (at < 0) at = blocks.findIndex(b => b.type === 'cover')
  at = at < 0 ? Math.min(1, blocks.length) : at + 1
  blocks.splice(at, 0, vb)
}

// Welche Bildkategorie passt zu welchen Woertern im Blocktext? Reihenfolge zaehlt:
// die erste Regel, die greift, gewinnt. Bisher bekam jeder Block einfach das
// naechste Bild aus der Liste - ein Block ueber den Pool landete so unter einem
// Fassadenfoto (Sven 26.8., The Cove).
const BILD_REGELN: Array<{ re: RegExp; cats: string[] }> = [
  { re: /\bpool|schwimm|sundeck|sonnendeck|planschen/i,           cats: ['pool', 'aussenbereich'] },
  { re: /\bk[üu]che|kochen|kulinar|essbereich|esszimmer|dinner/i, cats: ['kueche', 'esszimmer', 'wohnzimmer'] },
  { re: /schlafzimmer|schlafen|master|r[üu]ckzug|nachtruhe/i,      cats: ['schlafzimmer'] },
  { re: /\bbad|badezimmer|dusche|wanne|sanit[äa]r|wellness/i,     cats: ['badezimmer'] },
  { re: /wohnzimmer|wohnbereich|wohnen|lounge|sofa|kamin/i,        cats: ['wohnzimmer', 'esszimmer'] },
  { re: /terrasse|veranda|garten|au[ßs]en|outdoor|bbq|grill/i,     cats: ['aussenbereich', 'fassade'] },
  { re: /aussicht|blick|panorama|meer|sonnenunter|horizont/i,      cats: ['aussicht', 'aussenbereich', 'fassade'] },
  { re: /\bgym|fitness|sport|yoga/i,                              cats: ['gym', 'lobby'] },
  { re: /lobby|eingang|empfang|foyer/i,                            cats: ['lobby', 'fassade'] },
  { re: /architekt|fassade|geb[äa]ude|bauweise|konstruktion/i,     cats: ['fassade'] },
]

// Der frühere Villa/Apartment-Schutz (passtZuTyp) ist entfallen: er brauchte ein
// Label, das das Frontend nie mitschickte, und war dadurch wirkungslos. Die
// Zuordnung läuft jetzt über die Wohnungsnummer im Deck-Kontext — eine Wohnung
// bekommt ausschließlich ihren eigenen hinterlegten Plan.
function assignImages(blocks: Array<Record<string, unknown>>, images?: DeckImages, projName?: string, unitTyp?: string): void {
  const renders = images?.renders ?? []
  const gal = images?.gallery ?? []
  let ri = 0, pi = 0
  const verbraucht = new Set<string>()
  const nextRender = () => renders.length ? renders[ri++ % renders.length] : `https://picsum.photos/seed/deck${++pi}/1600/1000`
  // Bild zum TEXT des Blocks suchen: erst ueber die Vision-Kategorie, sonst ueber
  // das Bild-Label. Noch nicht verwendete Bilder haben Vorrang, damit sich nicht
  // dasselbe Foto durchs ganze Deck zieht.
  const passendesBild = (b: Record<string, unknown>): string | null => {
    if (!gal.length) return null
    const txt = [b.headline, b.kicker, b.intro, b.text, b.tagline, b.title]
      .filter(x => typeof x === 'string').join(' ')
    if (!txt.trim()) return null
    const regel = BILD_REGELN.find(r => r.re.test(txt))
    const kandidaten: Array<{ url: string; category: string; label: string }> = []
    if (regel) {
      for (const c of regel.cats) kandidaten.push(...gal.filter(x => x.category === c))
    }
    // Zusaetzlich ueber das Label suchen (z.B. "Poolbereich mit Lounge").
    for (const w of txt.toLowerCase().match(/[a-zäöüß]{5,}/g) ?? []) {
      for (const x of gal) if (x.label && x.label.toLowerCase().includes(w) && !kandidaten.includes(x)) kandidaten.push(x)
    }
    if (!kandidaten.length) return null
    return (kandidaten.find(x => !verbraucht.has(x.url)) ?? kandidaten[0]).url
  }
  const bildFuer = (b: Record<string, unknown>): string => {
    // Hat der Block schon ein GEWOLLTES Bild (z.B. das Marina-Modell aus einer
    // gelernten Vorgabe), bleibt es stehen. Vorher ueberschrieb die Zuordnung es
    // mit einem beliebigen Render - im Marina-Abschnitt stand ein Esszimmer
    // (Sven 27.8.).
    const vorhanden = typeof b.image === 'string' ? b.image.trim() : ''
    if (vorhanden.startsWith('http')) { verbraucht.add(vorhanden); return vorhanden }
    const treffer = passendesBild(b)
    const url = treffer ?? nextRender()
    verbraucht.add(url)
    return url
  }
  // ZWEI DURCHGAENGE: Bloecke mit klarem Motivbezug ("Der Pool gehoert nur dir")
  // waehlen ZUERST, danach die allgemeinen (cover, unit). Sonst greift sich das
  // Cover das Poolfoto und der Pool-Block bekommt die Fassade (Sven 26.8.).
  const bildBloecke = blocks.filter(b => ['cover', 'unit', 'columns', 'feature'].includes(b.type as string))
  const hatBezug = (b: Record<string, unknown>) => {
    const txt = [b.headline, b.kicker, b.intro, b.text, b.tagline, b.title].filter(x => typeof x === 'string').join(' ')
    return BILD_REGELN.some(r => r.re.test(txt))
  }
  for (const b of bildBloecke.filter(hatBezug)) b.image = bildFuer(b)
  for (const b of bildBloecke.filter(b => !hatBezug(b))) b.image = bildFuer(b)

  for (const b of blocks) {
    const t = b.type
    // Cover: animierte Kamerafahrt (Higgsfield) statt Standbild, wenn vorhanden
    if (t === 'cover' && images?.heroVideo) b.video = images.heroVideo
    if (t === 'facts') {
      // Standort-Karte, in Prioritäts-Reihenfolge:
      // 1) Echte Koordinaten (lat/lng) → interaktive Google-Maps-Einbettung im Deck
      //    (Deck.tsx baut den iframe). Pin sitzt IMMER exakt richtig (kein Vision-Marker
      //    mehr, kein manueller Screenshot, funktioniert auch für Projekte ohne Drive).
      // 2) Statischer Karten-Screenshot (Alt-Projekte) → Bild + Vision-Marker-Kreis.
      // 3) Keine Karte → neutrales Render (kein Kreis auf zufälligem Foto).
      if (images?.mapLat != null && images?.mapLng != null) {
        b.mapLat = images.mapLat
        b.mapLng = images.mapLng
        if (projName) b.mapLabel = projName
        if (images?.map) b.image = images.map   // optionaler statischer Fallback (PDF/Alt-Clients)
      } else if (images?.mapQuery) {
        // Keine exakten Koordinaten → trotzdem INTERAKTIVE Karte per Such-Query
        // (Projektname + Ort). Deck.tsx baut daraus das scrollbare Embed. Standard.
        b.mapQuery = images.mapQuery
        if (projName) b.mapLabel = projName
      } else if (images?.map) {
        b.image = images.map
        if (projName) b.mapLabel = projName
        if (images.mapMarker) b.mapMarker = images.mapMarker   // %-Position des echten Pins (Vision)
      } else {
        b.image = nextRender()
      }
      if (images?.mapUrl) b.mapUrl = images.mapUrl   // verlinkt auf Google Maps
    }
    // Grundrisse fasst die Bildzuordnung NICHT mehr an. Sie kamen hier aus einer
    // Liste, die das Frontend zusammenstellte — im Zweifel der ERSTE Plan des
    // Drive-Ordners (Dachplan, Masterplan, ein Plan einer fremden Wohnungsart).
    // Zustaendig ist jetzt allein applyDeterministic in _shared/deckNormalize.ts,
    // das je Wohnung genau den Plan setzt, den ihr der Deck-Kontext zuordnet.
    // Fehlt einer, bleibt der Block leer und wird entfernt — nie ein Ersatzbild.
    if (t === 'floorplan') delete b.image
    if (t === 'gallery' && Array.isArray(b.items)) {
      for (const it of b.items as Array<Record<string, unknown>>) it.image = nextRender()
    }
  }
}

// ── Bild-Text-ENDKONTROLLE (Sven 28.8.26: „Bilder passen oftmals nicht zum Text") ──
// Nach der Zuordnung prueft EIN Vision-Call alle Text-Bild-Paare der unit/feature/
// columns-Bloecke. Unpassende Bilder werden gegen ein passendes, noch unbenutztes
// Galerie-Bild getauscht (Kategorie kommt vom Modell, Tausch bleibt deterministisch).
// Best-effort: jeder Fehler laesst das Deck unveraendert.
const AUDIT_CATS = ['fassade', 'aussenbereich', 'aussicht', 'pool', 'wohnzimmer', 'esszimmer', 'kueche', 'schlafzimmer', 'badezimmer', 'gym', 'lobby']
async function auditBlockImages(blocks: Array<Record<string, unknown>>, gal: Array<{ url: string; category: string; label: string }>): Promise<void> {
  if (!gal.length) return
  const kandidatenBloecke = blocks.filter(b =>
    ['unit', 'feature', 'columns'].includes(String(b.type)) &&
    typeof b.image === 'string' && (b.image as string).startsWith('http') &&
    b.image !== MARINA_MODEL,
  ).slice(0, 10)
  if (!kandidatenBloecke.length) return
  const thumb = (u: string) => {
    const marker = '/storage/v1/object/public/'
    const i = u.indexOf(marker)
    if (i < 0 || u.includes('?')) return u
    return `${u.slice(0, i)}/storage/v1/render/image/public/${u.slice(i + marker.length)}?width=512&height=512&resize=contain`
  }
  // Bilder selbst laden + als base64 schicken (URL-Quellen laufen bei Anthropic in
  // Download-Timeouts, gleiche Lehre wie categorizeImages 20.6.).
  const imgs = await Promise.all(kandidatenBloecke.map(async b => {
    try {
      const r = await fetch(thumb(String(b.image)))
      if (!r.ok) return null
      const mime = (r.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
      const bytes = new Uint8Array(await r.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return { mime: mime.startsWith('image/') ? mime : 'image/jpeg', b64: btoa(bin) }
    } catch { return null }
  }))
  const content: Array<Record<string, unknown>> = []
  const geprueft: Array<Record<string, unknown>> = []
  kandidatenBloecke.forEach((b, i) => {
    const im = imgs[i]
    if (!im) return
    const thema = [b.kicker, b.headline, b.title, b.tagline].filter(x => typeof x === 'string').join(' — ').slice(0, 180)
    if (!thema.trim()) return
    content.push({ type: 'text', text: `PAAR ${geprueft.length}: Thema/Überschrift: „${thema}"` })
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } })
    geprueft.push(b)
  })
  if (!geprueft.length) return
  content.push({ type: 'text', text: 'Prüfe je Paar, ob das BILD inhaltlich zur Überschrift passt (Pool-Text braucht Poolbild, Küchen-Text Küche/Essbereich, Aussichts-Text einen Ausblick, Fassaden-/Architektur-Text ein Außenbild). Sei tolerant: ein stimmiges Stimmungsbild ist ok — melde NUR klare Fehlgriffe (Yoga-Raum unter „Einrichtungspaket", Esszimmer unter „Marina"). Gib bei Fehlgriffen die passende Kategorie an.' })
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1500,
        tools: [{
          name: 'emit_audit',
          description: 'Bild-Text-Abgleich je Paar.',
          input_schema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index:    { type: 'integer' },
                    matches:  { type: 'boolean' },
                    category: { type: 'string', enum: AUDIT_CATS, description: 'Bei matches=false: welche Bild-Kategorie zum Text passen würde.' },
                  },
                  required: ['index', 'matches'],
                },
              },
            },
            required: ['items'],
          },
        }],
        tool_choice: { type: 'tool', name: 'emit_audit' },
        messages: [{ role: 'user', content }],
      }),
    })
    if (!res.ok) { console.warn(`[generate-deck] Bild-Audit: Anthropic ${res.status}`); return }
    const data = await res.json() as { content?: Array<{ type?: string; input?: { items?: Array<{ index?: number; matches?: boolean; category?: string }> } }> }
    const items = (data.content ?? []).find(c => c.type === 'tool_use')?.input?.items ?? []
    const belegt = new Set(blocks.map(b => b.image).filter(x => typeof x === 'string') as string[])
    let getauscht = 0
    for (const it of items) {
      if (it.matches !== false || typeof it.index !== 'number') continue
      const b = geprueft[it.index]
      if (!b) continue
      const ersatz = gal.find(x => x.category === it.category && !belegt.has(x.url)) ?? gal.find(x => x.category === it.category)
      if (ersatz) {
        console.log(`[generate-deck] Bild-Audit: „${String(b.headline ?? b.kicker ?? '').slice(0, 60)}" → ${it.category} (${ersatz.label || ersatz.url.slice(-24)})`)
        b.image = ersatz.url
        belegt.add(ersatz.url)
        getauscht++
      }
    }
    if (getauscht) console.log(`[generate-deck] Bild-Audit: ${getauscht} Bild(er) getauscht`)
  } catch (e) {
    console.warn('[generate-deck] Bild-Audit uebersprungen:', e instanceof Error ? e.message : String(e))
  }
}


// ── Zweite KI-Prüfung: sind die Behauptungen des Decks gedeckt? ──────────────
// Diese Instanz erzeugt KEINE Fakten. Ihre einzige Aufgabe: prüfen, ob das Deck
// objektbezogene Aussagen enthält, die der Faktenbestand nicht hergibt
// (Meerblick, privater Pool, Dachterrasse, voll möbliert, Hotelservice,
// Mietgarantie, schlüsselfertig …). Bei Unsicherheit lieber melden als
// durchwinken — der Befund führt zu RED, nicht zu einer stillen Löschung.
const CLAIM_SYSTEM = `Du bist Faktenprüfer für ein Immobilien-Verkaufsdeck. Du bekommst (a) die belegten FAKTEN und (b) das fertige DECK als indizierte Blockliste.

Deine EINZIGE Aufgabe: Finde objektbezogene BEHAUPTUNGEN im Deck, die durch die Fakten NICHT gedeckt sind. Du erzeugst selbst keine Fakten und schlägst keine Texte vor.

Prüfe besonders: Meerblick, Blick auf etwas Bestimmtes, privater Pool, eigener Garten, Dachterrasse, Aufzug, Tiefgarage, Stellplatz, Fußbodenheizung, Klimaanlage, Photovoltaik, Gym, Sauna, voll möbliert, schlüsselfertig, Hotelservice/Hotelkonzept, Mietgarantie, garantierte Rendite oder Auslastung, Garantiedauer, Fertigstellungstermin, Entfernungen, Flächen, Zimmerzahl, Etage, Verfügbarkeit/Knappheit, Marktaussagen und Wertsteigerungszahlen.

Bewertung je geprüfter Aussage:
- unsupported = die Fakten sagen dazu NICHTS.
- conflict    = die Fakten sagen etwas ANDERES.
- covered     = die Fakten decken die Aussage. Nutze diesen Wert IMMER, wenn du eine Aussage geprüft und für gedeckt befunden hast — sie wird automatisch verworfen. Schreibe NIEMALS 'gedeckt' in die Begründung eines unsupported- oder conflict-Fundes; das ist ein Widerspruch in sich.

severity: high = harte Objekteigenschaft, Preis, Zahlungsplan, Garantie oder Termin. medium = weichere Eigenschaft oder Marktaussage. low = Stilfrage.

Nicht zu melden: Stimmungsbilder ohne Tatsachenbehauptung (etwa das Licht am Abend, das Gefühl auf der Terrasse), allgemeine Ansprache, Formulierungen über den KUNDEN aus dem Briefing.

Im Zweifel MELDEN. Ein übersehener falscher Fakt ist teurer als ein Fehlalarm.

Rufe emit_claim_check auf.`

async function checkClaims(
  blocks: Array<Record<string, unknown>>, facts: string, ctx: DeckContext,
): Promise<{ issues: Array<Record<string, unknown>>; failed: boolean; error?: string }> {
  // Deterministisch gesetzte Blöcke von der Prüfung ausnehmen: die Entfernungs-Chips
  // rechnet das System aus den Projekt-Koordinaten, die Marina-Sektion trägt ihre
  // Quellen selbst im Text. Ohne diese Ausnahme meldete der Prüfer sie als
  // „durch keinen Fakt gedeckt" — und JEDES Deck wäre rot geworden.
  const systemIdx: number[] = []
  blocks.forEach((b, i) => {
    if (b.type === 'marina' || b.type === 'video') systemIdx.push(i)
    else if (typeof b.image === 'string' && b.image === MARINA_MODEL) systemIdx.push(i)
  })
  const factsIdx = blocks.findIndex(b => b.type === 'facts')
  // Nur die Textfelder schicken — Bilder/URLs interessieren hier nicht und
  // sprengen nur das Kontextfenster.
  const TEXT_FELDER = ['kicker', 'title', 'tagline', 'headline', 'text', 'quote', 'intro', 'note', 'paragraphs', 'specs', 'items', 'cols', 'cards', 'groups', 'bullets', 'steps', 'phase1', 'phase2', 'priceLines', 'number']
  const schlank = blocks.map((b, i) => {
    const o: Record<string, unknown> = { index: i, type: b.type }
    for (const f of TEXT_FELDER) if (b[f] !== undefined) o[f] = b[f]
    return o
  })
  const hart = ctx.units.map(u => ({
    wohnung: u.unitNumber, zimmer: u.bedrooms, wohnflaeche_m2: u.sizeSqm,
    terrasse_m2: u.terraceSqm, grundstueck_m2: u.plotSqm, etage: u.floor, typ: u.unitType,
    netto: u.netProperty, moebel_netto: u.netFurniture,
    mwst: u.price?.vatTotal ?? null, brutto: u.price?.gross ?? null,
  }))
  const faktenText = [
    `VERIFIZIERTE STAMMDATEN (aus dem CRM, hoechste Prioritaet):\n${JSON.stringify(hart, null, 1)}`,
    `Einrichtung: ${ctx.furnitureMode === 'included' ? 'im Kaufpreis enthalten' : ctx.furnitureMode === 'none' ? 'wird ohne Moebel verkauft' : ctx.furnitureUnknown ? 'nicht gepflegt (unbekannt)' : 'NICHT im Kaufpreis, kostet extra'}`,
    ctx.completion ? `Geplante Fertigstellung: ${ctx.completion}` : 'Fertigstellung: nicht gepflegt',
    ctx.paymentSchedule ? `Zahlungsplan: ${ctx.paymentSchedule.stages.map(s => `${s.label} ${s.pct} %`).join(' · ')}` : 'Zahlungsplan: keiner hinterlegt',
    `\nPROJEKT-FAKTEN (aus den Bautraeger-Dokumenten):\n${facts.slice(0, 60000)}`,
  ].join('\n')

  const res = await callAnthropic(ANTHROPIC_API_KEY, {
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: CLAIM_SYSTEM,
    tools: [{
      name: 'emit_claim_check',
      description: 'Meldet ungedeckte oder widersprüchliche Behauptungen im Deck.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pass', 'review_required'] },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                severity:    { type: 'string', enum: ['high', 'medium', 'low'] },
                block_index: { type: 'integer' },
                claim:       { type: 'string', description: 'Die beanstandete Aussage, wörtlich.' },
                reason:      { type: 'string' },
                evidence:    { type: 'string', description: 'Was die Fakten stattdessen sagen — oder dass sie schweigen.' },
                status:      { type: 'string', enum: ['unsupported', 'conflict', 'covered'] },
              },
              required: ['severity', 'claim', 'status', 'reason'],
            },
          },
        },
        required: ['status', 'issues'],
      },
    }],
    tool_choice: { type: 'tool', name: 'emit_claim_check' },
    messages: [{ role: 'user', content: [
      `FAKTEN:\n${faktenText}`,
      systemIdx.length
        ? `\nNICHT PRÜFEN — Systembausteine: Die Blöcke mit den Indizes ${systemIdx.join(', ')} setzt das System deterministisch ein. Ihre Zahlen stammen aus den Projekt-Koordinaten bzw. aus fest hinterlegten, im Text selbst zitierten Quellen (Gov.cy, Knight Frank, Zentralbank Zypern, Kathimerini). Melde zu diesen Blöcken NICHTS.`
        : '',
      factsIdx >= 0
        ? `\nTEILWEISE NICHT PRÜFEN: Im Block ${factsIdx} sind die Entfernungs-Einträge (Feld items) aus den Geokoordinaten des Projekts berechnet — melde sie NICHT. Überschrift und Fließtext dieses Blocks prüfst du normal.`
        : '',
      `\nDECK (indizierte Blöcke):\n${JSON.stringify(schlank).slice(0, 120000)}`,
    ].filter(Boolean).join('\n') }],
    label: 'claim_check',
    attempts: 2,
  })
  if (!res.ok) return { issues: [], failed: true, error: res.error }
  const out = toolInput<{ issues?: Array<Record<string, unknown>> }>(res)
  const roh = Array.isArray(out?.issues) ? out!.issues : []
  // Gedeckte Aussagen und Selbstwidersprüche verwerfen: das Modell listet trotz
  // Anweisung gelegentlich Aussagen auf, die es in der Begründung selbst als
  // gedeckt bezeichnet. Solche Fehlalarme würden jedes Deck rot färben.
  const issues = roh.filter(it => {
    if (String(it.status) === 'covered') return false
    const grund = `${String(it.evidence ?? '')} ${String(it.reason ?? '')}`
    return !/^\s*gedeckt\b|\bist gedeckt\b|\.\s*gedeckt\.?\s*$|gedeckt durch/i.test(grund)
  })
  if (issues.length !== roh.length) console.log(`[generate-deck] Behauptungsprüfung: ${roh.length - issues.length} gedeckte Aussage(n) verworfen`)
  return { issues, failed: false }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY fehlt' }, 500)

  try {
    const body = await req.json() as {
      recipient_name?: string; angle?: string; briefing?: string; facts?: string
      month_label?: string
      job?: boolean
      images?: { heroVideo?: string; renders?: string[]; floorplan?: string; floorplans?: string[]; map?: string; mapUrl?: string; mapMarker?: { x: number; y: number }; mapLat?: number; mapLng?: number; mapQuery?: string; gallery?: Array<{ url: string; category: string; label: string }> }
      lead_id?: string; deal_id?: string; project_id?: string; unit_id?: string; batch_id?: string; created_by?: string
      // Mehrere Wohnungen EINES Projekts in EINEM Deck (je eigener unit-Block + Preis).
      // furniture_net = ausdruecklicher Moebelpreis je Wohnung aus dem Wizard.
      // Fehlt er, gilt die Stammdaten-Kette (Staffel je Zimmerzahl -> Projektwert).
      units?: Array<{ unit_number?: string; price_net?: number | null; furniture_net?: number | null }>
      generic?: boolean
      background?: boolean
      // Moebel-Modus je Deck (Sven waehlt im Wizard):
      //  'none'     = ohne Moebel verkauft - Moebel kommen im Deck NICHT vor
      //  'included' = Preis enthaelt die Moebel (zweite Preisspalte des Bautraegers)
      //  'optional' = Grundpreis + separat ausgewiesenes Moebelpaket
      // Fehlt der Wert, entscheiden wie bisher die Projekt-Stammdaten.
      furniture_mode?: 'none' | 'included' | 'optional'
      // Sprache des Kunden: 'en' erzeugt das komplette Deck auf Englisch
      // (Sven 26.8.). Fehlt der Wert, wird sie am Lead aufgeloest.
      lang?: 'de' | 'en'
    }
    const generic   = body.generic === true
    const recipient = generic ? '' : (body.recipient_name?.trim() || 'den Kunden')
    const angle     = body.angle || 'investment'
    // Eigennutz (Erstwohnsitz) → gesetzliche 130-m²-Regel (s.u.) + Wohn-/Lifestyle-Ton;
    // Investment → 19 % pauschal + ROI-Ton. Qualifiziert der Kunde, waehlt Sven im
    // Wizard "Eigennutz" (manuelle Entscheidung - das System prueft keinen Anspruch).
    // angleTone gibt der KI weiter den bekannten lifestyle/investment-Ton.
    const isEigennutz = angle === 'eigennutz'
    // Eigennutz (Erstwohnsitz) rechnet nach der zyprischen 130-m²-Regel, Investment
    // pauschal 19 %. Die Mathematik steht seit dem Umbau NUR NOCH in
    // _shared/deckVat.ts — bit-genau identisch zum Rendite-Rechner
    // (src/lib/rechner.ts), abgesichert durch scripts/verify-deck-vat.mjs.
    // Vorher gab es dafür fünf verschiedene Implementierungen im Repo, und
    // dieselbe Wohnung konnte in der Reservierungsmail einen anderen Bruttopreis
    // tragen als im Deck.
    const angleTone = isEigennutz ? 'lifestyle' : angle
    if (!body.facts?.trim()) return json({ error: 'facts fehlt' }, 400)

    // ── Deck-Sprache ─────────────────────────────────────────────────────────
    // Die Fakten und alle Vorgaben bleiben deutsch - nur das ERGEBNIS wird
    // englisch. So muss weder das Faktenmaterial noch das Regelwerk doppelt
    // gepflegt werden.
    let deckLang: 'de' | 'en' = body.lang === 'en' ? 'en' : 'de'
    if (!body.lang && body.lead_id) {
      try {
        const sbL = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
        const { data } = await sbL.from('leads').select('language').eq('id', body.lead_id).maybeSingle()
        if ((data as { language?: string } | null)?.language === 'en') deckLang = 'en'
      } catch { /* im Zweifel deutsch */ }
    }
    const langHinweis = deckLang === 'en'
      ? `\n\n=== SPRACHE: ENGLISCH (HART, HOECHSTE PRIORITAET) ===\nDer Empfaenger dieses Decks spricht Englisch. Schreibe JEDEN sichtbaren Text auf ENGLISCH: Ueberschriften, Kicker, Taglines, Fliesstext, Aufzaehlungen, Bildunterschriften, Labels der Preiszeilen, Zahlungsplan-Bezeichnungen, Handlungsaufforderungen. Die FAKTEN unten stehen auf Deutsch - uebersetze ihren Inhalt, uebernimm ihn nicht woertlich. NICHT uebersetzt werden: Eigennamen (Projekt- und Bautraegernamen, Ortsnamen, Wohnungsnummern, Markennamen), Zahlen, Preise, Flaechen und Datumsangaben. Waehrungsformat bleibt europaeisch (z.B. 499.000 EUR). Verwende britisches Englisch und dieselbe Ansprache wie im Deutschen: persoenlich und direkt (du -> you). Lass KEIN einzelnes deutsches Wort im englischen Satz stehen - auch nicht Fachbegriffe wie "raumhoch", "bodentief" oder "Fussbodenheizung"; uebersetze sie (floor-to-ceiling, underfloor heating).`
      : ''

    // BILDBESTAND als harter Fakt: Die KI baute Bloecke ueber Raeume, von denen es
    // gar kein Foto gibt - das System stopfte dann irgendein Bild darunter (Sven
    // 26.8., The Cove: 4 Bilder, nur Fassade und Aussenbereich). Sie soll nur
    // ueber das schreiben, was sich auch zeigen laesst.
    const galIn = body.images?.gallery ?? []
    const rendIn = body.images?.renders ?? []
    let bildFakten = ''
    if (galIn.length || rendIn.length) {
      const katListe = [...new Set(galIn.map(g => g.category).filter(Boolean))]
      const labels = galIn.map(g => g.label).filter(Boolean).slice(0, 20)
      bildFakten = `\n\n=== VERFUEGBARE BILDER (HART) ===\nFuer dieses Deck existieren ${galIn.length || rendIn.length} Fotos.`
      if (katListe.length) bildFakten += `\nMotive: ${katListe.join(', ')}.`
      if (labels.length) bildFakten += `\nBildinhalte: ${labels.join(' | ')}.`
      bildFakten += `\nBaue KEINEN eigenen Block (feature/columns) ueber ein Motiv, das hier NICHT vorkommt - ein Block ueber die Kueche ohne Kuechenfoto bekommt zwangslaeufig ein unpassendes Bild. Gibt es nur Aussenmotive, dann beschreibe Architektur, Lage und Aussenbereiche und halte dich bei Innenraeumen an den Text ohne eigenen Bildblock.`
      if (galIn.length + rendIn.length < 6) {
        bildFakten += `\nDer Bildbestand ist KLEIN: baue hoechstens ${Math.max(2, galIn.length || rendIn.length)} bebilderte feature/columns-Bloecke, sonst wiederholen sich die Fotos sichtbar.`
      }
    }

    // Gelernte Vorgaben (deck_ai_rules, kind='deck') → fließen in JEDES Deck ein (Auto-Grab +
    // Feinschliff). Global (project_id null) immer; projektspezifische nur für DIESES Projekt.
    const sbRules = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    let rulesQ = sbRules.from('deck_ai_rules').select('rule').eq('active', true).eq('kind', 'deck')
    rulesQ = body.project_id ? rulesQ.or(`project_id.is.null,project_id.eq.${body.project_id}`) : rulesQ.is('project_id', null)
    const { data: aiRules } = await rulesQ
    const learnedTxt = (aiRules ?? []).map((r: { rule: string }) => `- ${r.rule}`).join('\n')
    const learnedBlock = learnedTxt ? `GELERNTE VORGABEN (immer beachten):\n${learnedTxt}\n\n` : ''

    // ── Deck-Kontext: ALLE harten Fakten deterministisch aus der Datenbank ────
    // Wohnungen, Preise, MwSt, Zahlungsplan, Grundrisse — gebaut in
    // _shared/deckContext.ts. Die KI bekommt diese Werte als Text und darf sie
    // NUR wiedergeben. Derselbe Kontext wird nach jedem Feinschliff erneut
    // angewendet, damit eine Bearbeitung die Zahlen nicht wieder verliert.
    const unitInput: Array<{ unit_number: string; price_net?: number | null; furniture_net?: number | null }> =
      (body.units ?? [])
        .map(u => ({ unit_number: String(u.unit_number ?? '').trim(), price_net: u.price_net ?? null, furniture_net: u.furniture_net ?? null }))
        .filter(u => u.unit_number)
    if (!unitInput.length && body.unit_id) {
      const { data: u } = await sbRules.from('crm_project_units').select('unit_number').eq('id', body.unit_id).maybeSingle()
      const nr = (u as { unit_number?: string } | null)?.unit_number
      if (nr) unitInput.push({ unit_number: nr, price_net: null })
    }
    const ctx: DeckContext = await buildDeckContext(sbRules, {
      projectId: body.project_id ?? null,
      angle,
      lang: deckLang,
      furnitureMode: body.furniture_mode as FurnitureMode | undefined,
      generic,
      units: unitInput,
    })
    const missingFloorplans = ctx.missingFloorplans
    if (missingFloorplans.length) {
      // GRUNDRISS-GARANTIE: fehlende Pläne laut melden statt still weglassen —
      // der Block bliebe sonst ohne Zeichnung und niemand merkt es.
      console.error(`[generate-deck] KEIN hinterlegter Grundriss fuer Wohnung(en) ${missingFloorplans.join(', ')} (Projekt ${body.project_id})`)
    }

    // ── Harte Fakten als Prompt-Text ─────────────────────────────────────────
    const priced = ctx.units.filter(u => u.price)
    let extraFacts = ''

    if (priced.length === 1) {
      extraFacts += `\n\n=== WOHNUNGSNUMMER: ${priced[0].unitNumber} (HART) ===\nDieses Deck beschreibt AUSSCHLIESSLICH die Wohnung ${priced[0].unitNumber}. Nenne in Ueberschriften, Fliesstext und Blocknamen NUR diese Nummer. Erfinde KEINE andere Wohnungsnummer und uebernimm keine Nummer aus Beispielen oder Preislisten-Zeilen anderer Einheiten.`
    }

    // HARTE BINDUNG an die Stammdaten: Ob die Einrichtung im Preis steckt, sagt
    // das CRM-Feld furniture_included — NICHT die Prospekt-Prosa. Vorher schrieb
    // die KI "Einrichtungspaket vollstaendig im Kaufpreis enthalten", obwohl der
    // Preis die Moebel gar nicht enthielt (Sven 26.8., Infinity 203 + Arbeo Park).
    {
      const furnBeispiel = priced.length > 0 ? priced[0].netFurniture : ctx.furnitureDefault
      if (ctx.furnitureMode === 'none') {
        extraFacts += `\n\n=== EINRICHTUNG: KOMMT IM DECK NICHT VOR (HART, HOECHSTE PRIORITAET) ===\nDieses Objekt wird OHNE Moebel verkauft. Erwaehne Moebel, Einrichtungspakete, Moebelmarken, Geschirr, Besteck oder Waesche mit KEINEM Wort - kein inventory-Block dazu, keine Aufzaehlung, kein Nebensatz, auch nicht als Option oder Aufpreis. Ignoriere alle Moebel-, Geschirr- und Waescheangaben in den Fakten vollstaendig. Fest verbaute Ausstattung (Kueche, Einbauschraenke, Sanitaer, Klimatisierung, Boeden, Fenster) darfst und sollst du beschreiben, wenn die Fakten sie belegen - das ist keine Moeblierung.`
      } else if (ctx.furnitureUnknown) {
        extraFacts += `\n\n=== EINRICHTUNG: UNBEKANNT (HART) ===\nOb Moebel im Kaufpreis enthalten sind, ist in den Stammdaten NICHT gepflegt. Triff dazu KEINE Aussage - weder enthalten noch Aufpreis. Verboten sind "schluesselfertig", "moebliert", "komplett eingerichtet", "bezugsfertig" und jede sinngemaesse Formulierung. Fest verbaute Ausstattung (Kueche, Schraenke, Sanitaer, Klima) darfst du beschreiben, wenn die Fakten sie belegen.`
      } else if (ctx.furnitureIncluded) {
        extraFacts += `\n\n=== EINRICHTUNG: IM KAUFPREIS ENTHALTEN (HART) ===\nDie Einrichtung ist laut Stammdaten Teil des Kaufpreises. So darfst du es schreiben.`
      } else {
        extraFacts += `\n\n=== EINRICHTUNG: NICHT IM KAUFPREIS (HART, HOECHSTE PRIORITAET) ===\nDie Moebel/das Einrichtungspaket sind NICHT im genannten Kaufpreis enthalten, sondern kosten${furnBeispiel > 0 ? ` ${eur(furnBeispiel)} netto` : ''} EXTRA (plus 19 % MwSt). STRIKT VERBOTEN sind daher: "schluesselfertig moebliert", "voll moebliert", "komplett eingerichtet", "Einrichtung im Kaufpreis enthalten", "im Preis inklusive", "du packst nur die Koffer" oder jede sinngemaesse Formulierung, die den Eindruck erweckt, Moebel seien im Preis. Beschreibe das Einrichtungspaket ausschliesslich als OPTIONAL und KOSTENPFLICHTIG. Fest verbaute Ausstattung (Kueche, Einbauschraenke, Sanitaer, Klimatisierung) darfst du als enthalten beschreiben, wenn die Fakten das hergeben - Moebel niemals. Diese Regel schlaegt jede anderslautende Formulierung in den Projekt-Fakten.`
      }
    }

    if (isEigennutz && priced.length > 0) {
      const bruttoJeUnit = priced.map(u => `Wohnung ${u.unitNumber}: Bruttopreis ${eur(u.price!.gross)}`).join(' · ')
      extraFacts += `\n\n=== MWST-BASIS EIGENNUTZ (GESETZLICHE REGELUNG) — HART ===\nDie MwSt ist bereits EXAKT berechnet: 5 % auf den Wohnflaechen-Anteil bis ${VAT_CAP_SQM} m², 19 % auf den Anteil darueber, 19 % auf die Einrichtung. NICHT selbst rechnen. Der gesamte Zahlungsplan (Reservierung, Anzahlung, alle Raten, Summen) rechnet auf diesen Bruttopreisen: ${bruttoJeUnit}. Im 'payment'-Block als note der Hinweis: Der reduzierte MwSt-Satz von 5 % setzt einen nachgewiesenen Eigennutz/Erstwohnsitz in Zypern voraus und gilt bis ${VAT_CAP_SQM} m² Wohnflaeche (Steuerberater-Vorbehalt).`
    }

    if (priced.length === 1) {
      extraFacts += `\n\n=== VERBINDLICHE PREISANGABEN (im 'unit'-Block GENAU so darstellen, NICHT selbst rechnen, NICHT woanders wiederholen) ===\n${priced[0].priceLines.map(l => `${l.label}: ${l.value}`).join('\n')}`
    } else if (priced.length > 1) {
      const parts = priced.map(u => `WOHNUNG ${u.unitNumber}:\n${u.priceLines.map(l => `  ${l.label}: ${l.value}`).join('\n')}`)
      extraFacts += `\n\n=== VERBINDLICHE PREISANGABEN JE WOHNUNG (für JEDE Wohnung EINEN eigenen 'unit'-Block mit number=Wohnungsnummer und GENAU diesen Werten als priceLines; NICHT selbst rechnen, NICHT woanders wiederholen) ===\n${parts.join('\n\n')}`
    }

    if (ctx.completion) {
      extraFacts += `\n\n=== FERTIGSTELLUNG (muss im Deck genannt werden): ${ctx.completion} ===`
    }

    // Möbelpakete bei Projekt-Decks OHNE Wohnungspreis trotzdem sichtbar machen —
    // sie hängen sonst nur an Unit-Preisen und fallen komplett weg.
    if (priced.length === 0 && ctx.furnitureByBedrooms && Object.keys(ctx.furnitureByBedrooms).length > 0) {
      const lines = Object.entries(ctx.furnitureByBedrooms)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([bed, net]) => `- ${bed}-Schlafzimmer: ${eur(Number(net))} netto`)
        .join('\n')
      extraFacts += `\n\n=== MÖBELPAKETE (Vollausstattung, als 'inventory'-Block oder Fakt nennen; Nettopreise je Wohnungstyp) ===\n${lines}`
    }
    const factsAug = body.facts.trim() + extraFacts + bildFakten + langHinweis

    const userMsg = learnedBlock + (generic ? [
      `GENERISCHES PROJEKT-DECK — KEIN spezifischer Kunde. Dieses Deck wird live im Zoom geteilt.`,
      `MONAT: ${body.month_label || ''}`,
      ``,
      `AUFGABE: Stelle DAS PROJEKT vor — Lage, Architektur, Ausstattung, Amenities, die verfügbaren Wohnungs-Typen und den Zahlungsplan. Einladend, hochwertig, du-Form.`,
      `SONDERREGELN FÜR DIESES DECK: KEIN persönliches Anschreiben und KEINE 'Für <Name>'-Zeile (forLine im cover weglassen). Statt eines 'letter' an eine Person ein einladender Projekt-Intro in du-Form (headline + 2–3 Absätze, ohne Namensanrede, signName nur 'Sven · Happy Property Cyprus'). Kein erfundener Kundenbezug.`,
      ``,
      `FAKTEN ZUM PROJEKT (nur diese verwenden):`,
      factsAug,
    ].join('\n') : [
      `KUNDE: ${recipient}`,
      `MONAT: ${body.month_label || ''}`,
      `WINKEL (angle): ${angleTone}`,
      ``,
      `KUNDEN-BRIEFING (für Anschreiben + passende Stellen einweben):`,
      body.briefing?.trim() || '(kein Briefing — halte das Anschreiben allgemein, aber persönlich)',
      ``,
      `FAKTEN ZUM PROJEKT & APARTMENT (nur diese verwenden):`,
      factsAug,
    ].join('\n'))

    // Tool-Schema kommt aus dem gemeinsamen Vokabular (_shared/deckBlocks.ts).
    // Vorher stand hier eine eigene Enum-Liste, die 'inventory' NICHT enthielt,
    // obwohl der System-Prompt inventory-Blöcke ausdrücklich verlangt (Regel 4b) —
    // Prompt und Schema widersprachen sich.
    const emitTool = {
      name:        'emit_deck',
      description: 'Gibt das fertige, personalisierte Sales-Deck als geordnete Block-Liste zurück.',
      input_schema: emitDeckSchema(),
    }

    // Die eigentliche Generierung (Claude ~60-90s + Insert). Kann synchron laufen
    // oder — fürs generische Deck im Browser — im Hintergrund (waitUntil).
    const doGenerate = async (deferClaims: boolean): Promise<GenResult> => {
    // Protokoll aller deterministischen Eingriffe — landet im Quality-Bericht.
    const scrubEvents: ScrubEvent[] = []
    const normNotes: string[] = []

    // EIN Aufruf, aber mit echtem Retry: 429/500/502/503/529 und Timeouts werden
    // mit exponentiellem Backoff wiederholt (_shared/anthropic.ts). Vorher stand
    // hier `attempt < 1` — ein einziger Overload bedeutete: kein Deck, ohne Spur.
    let blocks: Array<Record<string, unknown>> = []
    const res = await callAnthropic(ANTHROPIC_API_KEY, {
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: SYSTEM,
      tools: [emitTool],
      tool_choice: { type: 'tool', name: 'emit_deck' },
      messages: [{ role: 'user', content: userMsg }],
      label: 'emit_deck',
    })
    if (!res.ok) throw new Error(`Claude nicht erreichbar (${res.attempts} Versuche): ${res.error}`)
    const rawBlocks = toolInput<{ blocks?: unknown }>(res)?.blocks
    if (Array.isArray(rawBlocks)) {
      blocks = rawBlocks as Array<Record<string, unknown>>
    } else if (typeof rawBlocks === 'string') {
      // "blocks" kommt gelegentlich als String — durch die Anführungszeichen-Regel
      // im Prompt meist valide, sonst repariert jsonrepair.
      const candidates: string[] = [rawBlocks]
      try { candidates.push(jsonrepair(rawBlocks)) } catch { /* Reparatur fehlgeschlagen */ }
      for (const txt of candidates) {
        try { const p = JSON.parse(txt); if (Array.isArray(p)) { blocks = p; break } } catch { /* nächster Kandidat */ }
      }
    }
    if (blocks.length === 0) {
      throw new Error('Keine Blöcke generiert: ' + JSON.stringify({ stop_reason: res.stop_reason, blocksType: typeof rawBlocks }).slice(0, 300))
    }
    // Projektname für den Standort-Kreis auf der Karte (aus dem Fakten-Header „=== PROJEKT X (…)").
    const projName = (body.facts ?? '').match(/===\s*PROJEKT\s+(.+?)\s*[(\n]/)?.[1]?.trim() || ''
    // Standort-Karte IMMER interaktiv (Deck-Standard): exakte Koordinaten bevorzugt,
    // sonst Such-Query aus Projektname + Ort → Deck.tsx baut ein scroll-/zoombares
    // Google-Embed statt eines statischen Bildes.
    let projRow: { name?: string; location?: string | null; latitude?: number | null; longitude?: number | null; video_url?: string | null; developer?: string | null; payment_schedule?: PaySchedule | null } | null = null
    if (body.project_id) {   // gilt für generische UND personalisierte Decks
      try {
        const { data: proj } = await sbRules.from('crm_projects')
          .select('name, location, latitude, longitude, video_url, developer, payment_schedule, deck_assets').eq('id', body.project_id).maybeSingle()
        const pr = proj as { name?: string; location?: string | null; latitude?: number | null; longitude?: number | null; video_url?: string | null; developer?: string | null; payment_schedule?: PaySchedule | null; deck_assets?: { mapUrl?: string; hero_video?: { url?: string } } | null } | null
        projRow = pr
        if (pr) {
          body.images = body.images ?? {}
          // Projekt-Hero-Video (EINE Kamerafahrt je Projekt, von allen Decks geteilt)
          if (!body.images.heroVideo && pr.deck_assets?.hero_video?.url) body.images.heroVideo = pr.deck_assets.hero_video.url
          if (body.images.mapLat == null && pr.latitude != null && pr.longitude != null) {
            body.images.mapLat = pr.latitude
            body.images.mapLng = pr.longitude
          }
          // Sicherheitsnetz: Projekt-Koordinaten wurden schon einmal durch ein
          // Formular-Save genullt (Genesis) — die deck_assets.mapUrl trägt sie oft
          // noch (query=…lat,lng). Daraus wiederherstellen, damit der Karten-Pin
          // nie wieder still verschwindet.
          if (body.images.mapLat == null) {
            const m = decodeURIComponent(pr.deck_assets?.mapUrl ?? '').match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/)
            if (m) { body.images.mapLat = Number(m[1]); body.images.mapLng = Number(m[2]) }
          }
          if (body.images.mapLat == null) {
            const loc = (pr.location ?? '').trim()
            const nm  = (pr.name ?? projName ?? '').trim()
            body.images.mapQuery = [nm, loc, 'Cyprus'].filter(Boolean).join(', ')
          }
          // Bei bekannten Koordinaten IMMER den exakten Pin verlinken (auch wenn eine
          // alte Such-mapUrl aus den deck_assets mitkommt) — sonst zeigt „In Maps öffnen"
          // auf eine ungenaue Suche statt auf den Standort.
          if (body.images.mapLat != null) {
            body.images.mapUrl = `https://www.google.com/maps?q=${body.images.mapLat},${body.images.mapLng}`
          } else if (!body.images.mapUrl) {
            body.images.mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(body.images.mapQuery ?? projName)}`
          }
        }
      } catch { /* Karte optional — Deck wird trotzdem erzeugt */ }
    }
    // Wohnungsart dieses Decks - entscheidet, welche Grundrisse ueberhaupt passen.
    let deckUnitTyp = ''
    if (body.unit_id) {
      try {
        const { data } = await sbRules.from('crm_project_units').select('type').eq('id', body.unit_id).maybeSingle()
        deckUnitTyp = String((data as { type?: string } | null)?.type ?? '')
      } catch { /* ohne Typ wird nicht gefiltert */ }
    }
    assignImages(blocks, body.images, projName, deckUnitTyp)

    // ── Karte: KEIN eigener map-Block mehr ───────────────────────────────────
    // Bis hierher setzte generate-deck einen Block { type: 'map' } ein. Den kennt
    // der Renderer nicht — er fiel in `default: return null` und rendert NICHTS.
    // Weil das KI-Enum 'map' ebenfalls nicht kennt, war die Idempotenz-Prüfung
    // `!blocks.some(b => b.type === 'map')` nie erfüllt: JEDES Deck mit
    // Koordinaten bekam einen unsichtbaren Block, und die „Karte fehlt"-Reparatur
    // reparierte nichts. Die Kartenfelder gehören an den facts-Block — so führt es
    // die Typdatei, und assignImages setzt sie dort bereits. Fehlt der facts-Block
    // ganz, wird jetzt ER ergänzt.
    const projLocation = (projRow?.location ?? '').trim()
    const hatKarte = !!(body.images?.map || body.images?.mapLat != null || body.images?.mapQuery || projLocation)
    if (hatKarte && !blocks.some(b => b.type === 'facts')) {
      const fb: Record<string, unknown> = {
        type: 'facts', kicker: deckLang === 'en' ? 'Location' : 'Lage',
        headline: projName
          ? (deckLang === 'en' ? `${projName} on the map` : `${projName} auf der Karte`)
          : (deckLang === 'en' ? 'The location on the map' : 'Die Lage auf der Karte'),
        items: [],
      }
      if (body.images?.mapLat != null && body.images?.mapLng != null) {
        fb.mapLat = body.images.mapLat; fb.mapLng = body.images.mapLng
        if (body.images.mapQuery) fb.mapQuery = body.images.mapQuery
      } else if (body.images?.mapQuery || projLocation) {
        fb.mapQuery = body.images?.mapQuery || `${projName ? projName + ', ' : ''}${projLocation}`
      } else if (body.images?.map) {
        fb.image = body.images.map
        if (body.images.mapMarker) fb.mapMarker = body.images.mapMarker
      }
      if (projName) fb.mapLabel = projName
      if (body.images?.mapUrl) fb.mapUrl = body.images.mapUrl
      blocks.splice(Math.min(4, blocks.length), 0, fb)
      console.log('[generate-deck] facts-Block mit Karte ergänzt (KI hatte ihn weggelassen)')
    }

    // ── Deterministische Normalisierung ──────────────────────────────────────
    // Wahrheits-Backstop, Wohnungsnummern, Preiszeilen, MwSt-Box, Zahlungsplan,
    // Grundrisse, Marina-Bild — alles aus dem Deck-Kontext, nichts von der KI.
    // GENAU DIESELBE Funktion läuft nach jedem Feinschliff (refine-deck) erneut,
    // damit eine Bearbeitung die harten Zahlen nicht wieder verliert.
    {
      const norm = applyDeterministic(blocks, ctx)
      blocks = norm.blocks
      scrubEvents.push(...norm.scrubEvents)
      normNotes.push(...norm.notes)
      for (const n of norm.notes) console.log(`[generate-deck] ${n}`)
      if (norm.scrubEvents.length) console.log(`[generate-deck] Scrubber: ${norm.scrubEvents.length} Eingriff(e) — ${[...new Set(norm.scrubEvents.map(e => e.rule))].join(', ')}`)
    }

    // Deck-Standard: Entfernungs-Chips (facts) + Marina-Sektion — deterministisch,
    // damit JEDES Deck sie hat, unabhängig davon was die KI liefert.
    injectLocationAndMarina(blocks, projRow?.name || projName, projRow, deckLang)
    // Projekt-Video (falls hinterlegt) nach der Lage-Sektion einsetzen.
    injectVideo(blocks, projRow?.video_url)
    // Generisches Projekt-Deck: beschriftete Bildstrecken pro Bereich (Wohnen, Küche,
    // Schlafen, Bäder, Pool, Lobby, Außen) aus den kategorisierten Renders einbauen,
    // damit der Kunde im Zoom sieht, wie alles aussieht.
    const gal = body.images?.gallery ?? []
    if (gal.length) {
      // Reihenfolge: zuerst Außen/Projekt (Sven: „immer Außenbilder zeigen"),
      // dann ein Rundgang durch die Wohnung. Jedes Bild trägt sein echtes
      // Vision-Label als Titel → Beschriftung passt garantiert zum Bildinhalt.
      const galEN = deckLang === 'en'
      const GROUPS: Array<{ cats: string[]; kicker: string; headline: string }> = galEN ? [
        { cats: ['fassade', 'aussenbereich', 'aussicht'], kicker: 'Project',   headline: 'Exterior & Setting' },
        { cats: ['wohnzimmer', 'esszimmer'],            kicker: 'Interiors',  headline: 'Living & Dining' },
        { cats: ['kueche'],                             kicker: 'Interiors',  headline: 'Kitchen' },
        { cats: ['schlafzimmer'],                       kicker: 'Interiors',  headline: 'Bedrooms' },
        { cats: ['badezimmer'],                         kicker: 'Interiors',  headline: 'Bathrooms' },
        { cats: ['pool'],                               kicker: 'Highlight',  headline: 'Pool & Sundeck' },
        { cats: ['lobby', 'gym'],                       kicker: 'Amenities',  headline: 'Lobby & Communal Areas' },
      ] : [
        { cats: ['fassade', 'aussenbereich', 'aussicht'], kicker: 'Projekt',  headline: 'Außenansicht & Lage' },
        { cats: ['wohnzimmer', 'esszimmer'],            kicker: 'Innenräume', headline: 'Wohnen & Essen' },
        { cats: ['kueche'],                             kicker: 'Innenräume', headline: 'Küche' },
        { cats: ['schlafzimmer'],                       kicker: 'Innenräume', headline: 'Schlafen' },
        { cats: ['badezimmer'],                         kicker: 'Innenräume', headline: 'Bäder' },
        { cats: ['pool'],                               kicker: 'Highlight',  headline: 'Pool & Sundeck' },
        { cats: ['lobby', 'gym'],                       kicker: 'Anlage',     headline: 'Lobby & Gemeinschaft' },
      ]
      const used = new Set<string>()
      const galleryBlocks: Array<Record<string, unknown>> = []
      for (const g of GROUPS) {
        const imgs = gal.filter(x => g.cats.includes(x.category) && !used.has(x.url)).slice(0, 6)
        if (!imgs.length) continue
        imgs.forEach(x => used.add(x.url))
        galleryBlocks.push({ type: 'gallery', kicker: g.kicker, headline: g.headline, items: imgs.map(x => ({ image: x.url, title: x.label || undefined })) })
      }
      // Konnten die Bilder nicht in Räume einsortiert werden (z.B. große Fotos, die
      // Vision ablehnt) → trotzdem eine saubere Sammel-Bildstrecke zeigen.
      if (!galleryBlocks.length && gal.length) {
        galleryBlocks.push({ type: 'gallery', kicker: galEN ? 'Project' : 'Projekt', headline: galEN ? 'Impressions' : 'Eindrücke', items: gal.slice(0, 6).map(x => ({ image: x.url, title: x.label || undefined })) })
      }
      if (galleryBlocks.length) {
        const filtered = blocks.filter(b => b.type !== 'gallery')   // Modell-Galerien ersetzen
        const ctaIdx = filtered.findIndex(b => b.type === 'cta')
        const at = ctaIdx >= 0 ? ctaIdx : filtered.length
        blocks = [...filtered.slice(0, at), ...galleryBlocks, ...filtered.slice(at)]
      }
    }

    // Marina-Abschnitte tragen IMMER das Marina-Modell. Die KI baut wegen der
    // gelernten Mamba-Vorgabe einen eigenen feature-Block dazu; ohne diese Regel
    // landet dort ein beliebiges Innenraum-Render (Sven 27.8.: Esszimmer).
    for (const b of blocks) {
      const txt = `${b.kicker ?? ''} ${b.headline ?? ''}`
      if (/marina/i.test(txt) && b.type !== 'marina' && b.image !== MARINA_MODEL) {
        b.image = MARINA_MODEL
        console.log('[generate-deck] Marina-Abschnitt: Modellbild gesetzt')
      }
    }

    // Bild-Text-Endkontrolle: klar unpassende Bilder gegen passende Galerie-Bilder
    // tauschen (EIN Vision-Call, best-effort — darf die Generierung NIE reissen).
    try { await auditBlockImages(blocks, gal) }
    catch (e) { console.warn('[generate-deck] Bild-Audit uebersprungen:', e instanceof Error ? e.message : String(e)) }

    // Grundriss-Block ohne Bild komplett entfernen: passt kein Plan zur Wohnungsart
    // (Mamba hat nur Maisonette-Plaene, The Cove gar keine), bleibt sonst ein leerer
    // Kasten mit Ueberschrift stehen (Sven 27.8.).
    {
      const vorher = blocks.length
      blocks = blocks.filter(b => b.type !== 'floorplan' || b.image)
      if (blocks.length !== vorher) console.log('[generate-deck] leeren Grundriss-Block entfernt (kein passender Plan)')
    }

    // ── Auffang: KEIN deutscher Text im englischen Deck ──────────────────────
    // Rekursiv ueber ALLE Felder, nicht nur ueber eine Feldliste - vorher rutschten
    // einzelne Woerter durch, weil sie in einem nicht geprueften Feld standen
    // ("schluesselfertig" mitten im englischen Absatz, Sven 27.8.). Betroffen sind
    // deterministisch gesetzte Texte (Bild-Labels aus der Datenbank) ebenso wie
    // Woerter, die die KI aus den deutschen Fakten uebernommen hat.
    if (deckLang === 'en') {
      const DEUTSCH = /[äöüßÄÖÜ]|\b(mit|und|der|die|das|im|Blick|Ansicht|Aussen|Innen|raumhoh\w*|bodentief\w*|schluesselfertig|Fussboden\w*|Wohnzimmer|Schlafzimmer|Kueche|Terrasse|Grundstueck|Bautraeger|Uebergabe|Wertsteigerung|Zahlungsplan)\b/i
      const traeger: Array<{ o: Record<string | number, unknown>; k: string | number }> = []
      const sammle = (n: unknown) => {
        if (Array.isArray(n)) {
          n.forEach((v, i) => {
            if (typeof v === 'string') { if (DEUTSCH.test(v) && !v.startsWith('http')) traeger.push({ o: n as unknown as Record<string | number, unknown>, k: i }) }
            else sammle(v)
          })
        } else if (n && typeof n === 'object') {
          for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
            if (typeof v === 'string') { if (DEUTSCH.test(v) && !v.startsWith('http')) traeger.push({ o: n as Record<string | number, unknown>, k }) }
            else sammle(v)
          }
        }
      }
      sammle(blocks)
      if (traeger.length) {
        try {
          const roh = traeger.map(t => String(t.o[t.k]))
          const tr = await translateOutbound({ subject: null, body: JSON.stringify(roh), whatsapp: null }, 'en')
          const out = JSON.parse(tr.body ?? '[]') as string[]
          if (Array.isArray(out) && out.length === traeger.length) {
            traeger.forEach((t, i) => { if (typeof out[i] === 'string' && out[i].trim()) t.o[t.k] = out[i] })
            console.log(`[generate-deck] ${traeger.length} deutsche Textstellen ins Englische uebersetzt`)
          } else console.warn('[generate-deck] Uebersetzung verworfen: Anzahl passt nicht')
        } catch (err) {
          console.warn('[generate-deck] Uebersetzung fehlgeschlagen:', err instanceof Error ? err.message : String(err))
        }
      }
    }



    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // ── QUALITY-GATE ─────────────────────────────────────────────────────────
    // Prüft das fertige Deck gegen die harten Fakten und entscheidet GREEN/RED.
    // Es REPARIERT nichts still — was hier auffällt, steht als Befund im Bericht
    // und wird im CRM angezeigt. Ein RED-Deck bleibt erreichbar und versendbar.
    const gate = runDeckGate(blocks, ctx)
    const findings: Finding[] = [...gate.findings]

    // Zweite, semantische Prüfung: deckt der Faktenbestand die Behauptungen des
    // Decks? Sie kostet einen weiteren Claude-Aufruf. Synchron aufgerufen sprengt
    // das zusammen mit Generierung und Bild-Audit das 150-Sekunden-Limit des
    // Gateways — deshalb läuft sie dort NACH der Antwort weiter (deferClaims) und
    // aktualisiert den Bericht, sobald sie fertig ist.
    if (!deferClaims) {
      try {
        const claim = await checkClaims(blocks, factsAug, ctx)
        if (claim.issues.length) findings.push(...claimIssuesToFindings(claim.issues))
        if (claim.failed) {
          findings.push({ key: 'behauptungspruefung_ausgefallen', severity: 'mittel',
            what: 'Die Behauptungsprüfung konnte nicht durchlaufen — die Aussagen im Deck sind ungeprüft.',
            evidence: claim.error ?? '' })
        }
      } catch (e) {
        findings.push({ key: 'behauptungspruefung_ausgefallen', severity: 'mittel',
          what: 'Die Behauptungsprüfung konnte nicht durchlaufen — die Aussagen im Deck sind ungeprüft.',
          evidence: e instanceof Error ? e.message : String(e) })
      }
    }

    const qualityStatus: 'green' | 'red' =
      findings.some(f => f.severity === 'kritisch' || f.severity === 'hoch') ? 'red' : 'green'
    const qualityReport = {
      status: qualityStatus,
      claims_pending: deferClaims,
      checked_blocks: gate.checkedBlocks,
      findings,
      normalization: normNotes,
      scrub_events: scrubEvents,
      facts_snapshot: ctx.units.map(u => ({
        unit: u.unitNumber, unit_key: u.unitKey, bedrooms: u.bedrooms,
        size_sqm: u.sizeSqm, terrace_sqm: u.terraceSqm, floor: u.floor,
        net_property: u.netProperty, net_furniture: u.netFurniture,
        vat: u.price?.vatTotal ?? null, gross: u.price?.gross ?? null,
        vat_mode: ctx.vatMode, furniture_mode: ctx.furnitureMode,
        floorplan: u.floorplanUrl, floorplan_fallback: u.floorplanFallback,
      })),
      images: blocks.map((b, i) => ({ block: i, type: String(b.type), image: typeof b.image === 'string' ? b.image : null }))
        .filter(x => x.image),
      completion: ctx.completion,
      payment_source: ctx.paymentSource,
      generated_at: new Date().toISOString(),
    }
    console.log(`[generate-deck] Quality-Gate: ${qualityStatus.toUpperCase()} — ${findings.length} Befund(e)`)
    for (const f of findings) console.log(`  [${f.severity}] ${f.key}: ${f.what}`)

    // deck_context: der komplette Faktenkontext am Deck. refine-deck baut daraus
    // die Preiszeilen/MwSt-Box/Grundrisse nach JEDER Bearbeitung neu auf.
    const persist = {
      content: { blocks },
      status: 'ready',
      angle,
      deck_context: ctx as unknown,
      quality_status: qualityStatus,
      quality_report: qualityReport,
      quality_checked_at: new Date().toISOString(),
    }

    // Generisches Projekt-Deck: bestehenden Token IN-PLACE überschreiben → stabiler Link
    // (Sven kann denselben Link teilen; Re-Grab/Feinschliff ändert die URL nicht).
    let existingToken: string | null = null
    if (generic && body.project_id) {
      const { data: pr } = await supabase.from('crm_projects').select('deck_token').eq('id', body.project_id).maybeSingle()
      existingToken = (pr as { deck_token?: string | null } | null)?.deck_token ?? null
    }

    let token: string
    let deckId: string | null = null
    if (existingToken) {
      const { data: row, error } = await supabase.from('sales_decks')
        .update(persist).eq('token', existingToken).select('id').maybeSingle()
      if (error) throw new Error(`DB: ${error.message}`)
      token = existingToken
      deckId = (row as { id?: string } | null)?.id ?? null
      await supabase.from('crm_projects').update({ deck_generated_at: new Date().toISOString() }).eq('id', body.project_id!)
    } else {
      const { data: row, error } = await supabase.from('sales_decks').insert({
        ...persist,
        recipient_name: body.recipient_name ?? null,
        lead_id:    body.lead_id ?? null,
        deal_id:    body.deal_id ?? null,
        project_id: body.project_id ?? null,
        unit_id:    body.unit_id ?? null,
        batch_id:   body.batch_id ?? null,
        created_by: body.created_by ?? null,
      }).select('id, token').single()
      if (error) throw new Error(`DB: ${error.message}`)
      token = (row as { token: string }).token
      deckId = (row as { id?: string }).id ?? null
      if (generic && body.project_id) {
        await supabase.from('crm_projects').update({ deck_token: token, deck_generated_at: new Date().toISOString() }).eq('id', body.project_id)
      }
    }
    if (deferClaims) {
      // Nach der Antwort weiterlaufen lassen und den Bericht ergänzen.
      const nachtragen = async () => {
        try {
          const claim = await checkClaims(blocks, factsAug, ctx)
          const zusatz = claim.issues.length ? claimIssuesToFindings(claim.issues) : []
          if (claim.failed) {
            zusatz.push({ key: 'behauptungspruefung_ausgefallen', severity: 'mittel',
              what: 'Die Behauptungsprüfung konnte nicht durchlaufen — die Aussagen im Deck sind ungeprüft.',
              evidence: claim.error ?? '' })
          }
          const alle = [...findings, ...zusatz]
          const neu: 'green' | 'red' = alle.some(f => f.severity === 'kritisch' || f.severity === 'hoch') ? 'red' : 'green'
          await supabase.from('sales_decks').update({
            quality_status: neu,
            quality_report: { ...qualityReport, status: neu, claims_pending: false, findings: alle },
            quality_checked_at: new Date().toISOString(),
          }).eq('token', token)
          console.log(`[generate-deck] Behauptungsprüfung nachgetragen: ${neu.toUpperCase()} (${alle.length} Befunde)`)
        } catch (e) {
          console.warn('[generate-deck] Behauptungsprüfung nachträglich fehlgeschlagen:', e instanceof Error ? e.message : String(e))
        }
      }
      const er2 = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
      if (er2?.waitUntil) er2.waitUntil(nachtragen())
    }

    return { token, blocks: blocks.length, deckId, quality: qualityStatus, findings: findings.length }
    }   // ── Ende doGenerate ──

    // ── Job-Zeile: der Wizard pollt sie statt auf einen neuen Token zu raten ──
    // Vorher merkte sich der Wizard den letzten Token und wartete 3 Minuten auf
    // einen anderen. Fehlschlag und Timeout waren dabei nicht unterscheidbar, und
    // bei parallelen Läufen für denselben Lead griff er das falsche Deck.
    const sbJob = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    let jobId: string | null = null
    if (body.job !== false) {
      const { data: job } = await sbJob.from('deck_generation_jobs').insert({
        kind: generic ? 'generic_deck' : 'deck',
        lead_id: body.lead_id ?? null,
        project_id: body.project_id ?? null,
        requested_unit_ids: ctx.units.map(u => u.unitId).filter(Boolean),
        status: 'generating',
        progress: 'Deck wird geschrieben',
        created_by: body.created_by ?? null,
        started_at: new Date().toISOString(),
        attempt: 1,
        request: { angle, lang: deckLang, generic, furniture_mode: ctx.furnitureMode, units: ctx.units.map(u => u.unitNumber) },
      }).select('id').maybeSingle()
      jobId = (job as { id?: string } | null)?.id ?? null
    }

    const finishJob = async (patch: Record<string, unknown>) => {
      if (!jobId) return
      await sbJob.from('deck_generation_jobs').update({ ...patch, completed_at: new Date().toISOString() }).eq('id', jobId)
    }

    // Im Hintergrundlauf gibt es kein Gateway-Limit — dort läuft die
    // Behauptungsprüfung direkt mit. Nur der synchrone Weg schiebt sie nach.
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
    const imHintergrund = !!(body.background && er?.waitUntil)
    const deferClaims = !imHintergrund

    const run = async (): Promise<GenResult> => {
      try {
        const out = await doGenerate(deferClaims)
        await finishJob({
          status: out.quality === 'red' ? 'review_required' : 'ready',
          quality_status: out.quality,
          deck_token: out.token,
          sales_deck_id: out.deckId,
          progress: out.quality === 'red' ? `${out.findings} Befund(e) — bitte prüfen` : 'Fertig',
          error: null,
        })
        return out
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[generate-deck] fehlgeschlagen:', msg)
        // Kein stilles Verschwinden mehr: der Fehlschlag steht in der Job-Zeile
        // und wird im CRM angezeigt.
        await finishJob({ status: 'failed', error: msg.slice(0, 1000), progress: 'Fehlgeschlagen' })
        throw e
      }
    }

    // Generisches Deck im Browser: lange Generierung (~80s) im HINTERGRUND laufen lassen
    // → sofortige Antwort, kein Verbindungs-Timeout. Der Aufrufer pollt den Job.
    if (imHintergrund) {   // generisch UND personalisiert (Batch im Wizard)
      er!.waitUntil!(run().catch(() => { /* Fehler steht in der Job-Zeile */ }))
      return json({ ok: true, background: true, job_id: jobId })
    }
    const out = await run()
    return json({ ok: true, token: out.token, url: `/deck/${out.token}`, blocks: out.blocks,
      job_id: jobId, quality_status: out.quality, findings: out.findings,
      ...(missingFloorplans.length ? { missing_floorplans: missingFloorplans } : {}) })

  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
