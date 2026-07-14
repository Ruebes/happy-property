// Supabase Edge Function: generate-deck
// Schreibt aus Fakten + Kunden-Briefing ein personalisiertes Sales-Deck (Claude)
// und legt es als sales_decks-Zeile an. Gibt token + url zurück.
//
// Body: { recipient_name, angle, briefing, facts, month_label?,
//         lead_id?, deal_id?, project_id?, unit_id?, batch_id?, created_by? }
// Bilder werden NICHT hier gesetzt — die hängt der Import/Generator später an die
// Bild-Slots (Stufe 1: Platzhalter zum Beurteilen der Texte/Struktur).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { jsonrepair } from 'https://esm.sh/jsonrepair@3.8.0'

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
4b. AUSSTATTUNG: Sobald im Input ein Einrichtungspaket / Ausstattung / Möbelliste / Geschirr / Besteck (cutlery) / Wäsche (linen) steht, MUSST du das prominent zeigen — als ein bis zwei "inventory"-Blöcke (ein bis zwei Seiten). Empfehlung: Block 1 = Möbel, Geräte & Premium-Marken (gruppiert, z.B. Wohnen, Küche & Geräte, Schlafen, Bad — mit den echten Markennamen aus den Fakten wie BOSCH, Neff, GROHE, LAUFEN, Samsung, Tomasella, DUPEN); Block 2 = die Komplett-Checkliste (Geschirr & Besteck mit Stückzahlen, Wäsche & Bettwäsche). Botschaft durchgängig: schlüsselfertig & voll möbliert, sofort bezugs- und vermietfertig — der Kunde packt nur die Koffer. Nutze NUR die im Input gelisteten Gegenstände/Marken, erfinde nichts dazu.
4c. ZAHLUNGSPLAN (payment) — HART: Alle Beträge und Prozente kommen AUSSCHLIESSLICH aus den Zahlungsplan-Daten der Fakten UND dem Kaufpreis GENAU DIESER Wohnung. Prozente müssen rechnerisch zum Kaufpreis passen (z.B. 30 % von 430.000 € = 129.000 €, NICHT 300.000 €). Übernimm NIEMALS Zahlen aus dem Kunden-Briefing/Anschreiben (z.B. „300k Eigenkapital") in den Zahlungsplan — das Briefing beschreibt den Kunden, nicht den Preis dieses Objekts. Liegen keine echten Raten/Prozente in den Fakten vor: nutze nur die Prozentstufen und schreibe als value „gemäß Bauträger-Konditionen" statt einen Betrag zu erfinden. Plausibilität prüfen: kein einzelner Schritt darf größer als der Kaufpreis sein, Summe der Schritte = 100 % des Preises.
4d. ZAHLUNGSPLAN-NARRATIV (kicker, headline, intro, note, phase-label/title, advantage) — HART, gleiche Klasse wie 5b: Beschreibe NUR die Stufen sachlich. Erfinde KEINE Aussage über das ZEITLICHE Verhältnis der Zahlungen zum Baufortschritt, die nicht WÖRTLICH in den Fakten steht. STRIKT VERBOTEN (nie schreiben, egal wie verkaufsfördernd): „du zahlst erst nach Fertigstellung", „erst wenn gebaut wurde", „der Löwenanteil/Großteil kommt bei oder nach der Übergabe", „du finanzierst keinen Baufortschritt, den du nicht siehst", „du zahlst nicht auf Kredit des Bauträgers", „nach echtem Baufortschritt — jede Phase muss abgeschlossen sein, bevor die nächste Rate fällig wird", „das schützt dich/deine Liquidität", „Planungssicherheit" — und jede andere Käufer-Schutz- oder Sicherheits-Story rund um den Zahlungsplan. Grund: Zypern-Neubau wird typischerweise BAUFORTSCHRITTS-BEGLEITEND und front-lastig gezahlt (Reservierung + Anzahlung bei Vertragsunterzeichnung, weitere Raten WÄHREND des Baus), NICHT nachgelagert — solche Sicherheits-Narrative sind faktisch falsch. Erlaubte neutrale Headlines: „Der Zahlungsplan im Überblick", „430.000 € — in klaren Stufen", „Transparent über die Bauphasen verteilt". Phase-Labels nur, wenn die Phasen wörtlich in den Fakten stehen; sonst generisch (Reservierung / Bei Vertrag / Baufortschritt / Bei Übergabe).
4e. PREIS (unit-Block) — HART: Stehen im Input "VERBINDLICHE PREISANGABEN", setze sie EXAKT als priceLines (gleiche Labels + Werte, Reihenfolge: Nettopreis, MwSt, Bruttopreis[strong:true], dann Einrichtung). Rechne NICHTS selbst, runde nichts, erfinde keinen Preis. Wiederhole den Preis NICHT in anderen Blöcken (kein „X € netto" im letter/feature/cta). Ohne verbindliche Preisangaben: lass priceLines weg.
4f. FERTIGSTELLUNG: Steht im Input "FERTIGSTELLUNG: MM/JJJJ", nenne sie konkret im payment-Block (z.B. Zeile „Geplante Fertigstellung: 10/2027" oder im intro). Steht keine Fertigstellung da, erfinde keine.
5. Nutze NUR Fakten aus dem Input. Erfinde KEINE Zahlen/Preise/Entfernungen. Wenn ein Faktum fehlt, lass den Block/das Feld weg statt zu raten. Zahlen aus dem Kunden-Briefing sind KEINE Objekt-Fakten — niemals als Preis/Fläche/Rate eines Objekts verwenden.
5c. BRIEFING ≠ OBJEKT-FAKT (HART): Das Kunden-Briefing/Anschreiben beschreibt den KUNDEN (seine Situation, Wünsche, Interessen) — NIEMALS das Objekt. Erwähnt das Briefing ein Konzept/Feature/eine Garantie (z.B. 'Hotelkonzept interessiert', 'will Mietgarantie', 'sucht Meerblick'), darfst du das NICHT als bestätigtes Objekt-Merkmal behaupten ('das Hotelkonzept des Projekts…', 'mit Mietgarantie', 'mit Meerblick'), es sei denn, GENAU dieses Merkmal steht auch in den OBJEKT-Fakten. Du darfst das Kundeninteresse im Anschreiben höchstens als WUNSCH des Kunden spiegeln ('du hast Interesse an…'), nie als Tatsache des Objekts.
5d. KEINE ERFUNDENE VERKNAPPUNG: Behaupte Knappheit/Verfügbarkeit ('nur noch wenige Einheiten', 'eine der letzten', 'fast ausverkauft') NUR, wenn eine konkrete Einheiten-/Verfügbarkeitszahl in den Fakten steht. Steht 'Anzahl Einheiten: keine Angabe' o.ä., formuliere die Reservierungs-CTA neutral ohne Knappheits-Behauptung.
5e. KEINE ERFUNDENEN MARKT-/NACHFRAGE-AUSSAGEN: Aussagen über Mieternachfrage, Zielgruppen, Marktstabilität, 'keine Überhitzung/Blase', erzielbare Mieten, Wertsteigerungs-Tempo oder Lage-Vorzüge (Hügel, Infrastruktur, Ruhe) nur, wenn sie WÖRTLICH in den Fakten stehen. Keine allgemeine Markt-Rhetorik dazudichten.
5f. KEIN WEITERVERKAUF-/EXIT-NARRATIV (HART): Das Deck verkauft ein Objekt zum Eigennutz/zur Vermietung — NICHT als Spekulation. STRIKT VERBOTEN: 'vor Fertigstellung verkaufen', 'Exit-Szenario', 'mit X % Gewinn/Wertzuwachs weiterverkaufen', 'in 2-4 Jahren verkaufen', 'flippen', 'Wiederverkauf mit Gewinn', oder ein eigener Block/Spalten über Verkaufs-/Exit-Strategien. KEINE konkreten Wertsteigerungs-Prozente/Renditen erfinden. Wenn der Kunde im Briefing über Weiterverkauf spricht, NICHT als Objekt-Strategie ausarbeiten.
5b. WAHRHEIT vor Verkauf: Werte Begriffe NICHT auf und kombiniere keine zwei Fakten zu einer stärkeren Aussage. VERBOTEN: aus '5 Jahre Garantie' wird 'Mietgarantie'/'Rendite-Garantie'; aus 'Hotelkonzept' wird 'garantierte Miete'/'gesicherte Auslastung'/'garantierte Rendite'/'sorgt ab dem ersten Tag für Auslastung'/'immer vermietet'/'der Hotelbetreiber kümmert sich um die Vermietung' (es sei denn das steht wörtlich so da). Ein Hotelkonzept ist eine Vermietungs-OPTION, keine Zusicherung auf Miete, Auslastung oder Rendite. Garantien/Renditen/Auslastungen/Belegungsquoten nur nennen, wenn sie WÖRTLICH in den Fakten stehen. Im Zweifel weglassen.
6. Preise/Beträge exakt aus den Fakten übernehmen (Format wie gegeben).
7. KRITISCH für gültiges JSON: Verwende in ALLEN Texten (Titel, Taglines, Absätze, überall) NIEMALS doppelte Anführungszeichen — weder gerade noch typografische deutsche. Für Spitznamen/Hervorhebungen nutze EINFACHE Anführungszeichen 'so' oder gar keine. Beispiel: Apartment 303 'Dior' (nicht mit doppelten Zeichen). Übergib blocks als echtes JSON-Array.`

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Echte Drive-Bilder (oder Platzhalter) in die Bild-Slots hängen.
type DeckImages = { renders?: string[]; floorplan?: string; floorplans?: string[]; map?: string; mapUrl?: string; mapMarker?: { x: number; y: number }; mapLat?: number; mapLng?: number; mapQuery?: string; gallery?: Array<{ url: string; category: string; label: string }> }
// Deterministischer Wahrheits-Backstop: filtert bekannte erfundene Behauptungen
// raus, falls das Modell die Prompt-Regeln (4d / 5b) doch mal ignoriert. Greift
// SATZWEISE (entfernt nur den betroffenen Satz, nicht den ganzen Block).
const FORBIDDEN_GLOBAL: RegExp[] = [
  /mietgarantie|rendite-?garantie|garantierte (miete|rendite|auslastung)/i,
  /erst nach (der )?fertigstellung/i,
  /(du )?zahlst erst,? wenn gebaut wurde/i,
  /wenn das apartment steht/i,
  /nicht auf kredit des bauträgers/i,
  /(sorgt|ab dem ersten tag)[^.!?]*auslastung/i,
  /immer vermietet|gesicherte auslastung|garantierte auslastung/i,
]
// Nur im Zahlungsplan-Block problematisch (Käufer-Schutz-/Liquiditäts-Narrativ):
const FORBIDDEN_PAYMENT: RegExp[] = [
  /finanzierst keinen baufortschritt/i,
  /schützt (dich|deine)/i,
  /planungssicherheit/i,
  /(löwenanteil|großteil)[^.!?]*(übergabe|fertig)/i,
  /jede phase muss abgeschlossen sein,? bevor die nächste rate/i,
]
function dropBadSentences(s: unknown, res: RegExp[]): string {
  if (typeof s !== 'string' || !s) return typeof s === 'string' ? s : ''
  const parts = s.split(/(?<=[.!?…])\s+/)
  const kept = parts.filter(p => !res.some(re => re.test(p)))
  return kept.join(' ').trim()
}
function scrubNarrative(blocks: Array<Record<string, unknown>>): void {
  for (const b of blocks) {
    const isPay = b.type === 'payment'
    const res = isPay ? [...FORBIDDEN_GLOBAL, ...FORBIDDEN_PAYMENT] : FORBIDDEN_GLOBAL
    for (const f of ['intro', 'note', 'text', 'quote']) {
      if (typeof b[f] === 'string') b[f] = dropBadSentences(b[f], res)
    }
    if (Array.isArray(b.paragraphs)) {
      b.paragraphs = (b.paragraphs as unknown[]).map(p => dropBadSentences(p, res)).filter(Boolean)
    }
    for (const phKey of ['phase1', 'phase2']) {
      const ph = b[phKey] as Record<string, unknown> | undefined
      if (ph && typeof ph === 'object') {
        for (const f of ['advantage', 'title', 'label']) {
          if (typeof ph[f] === 'string') ph[f] = dropBadSentences(ph[f], res)
        }
      }
    }
    // Headline/Kicker: nur im Zahlungsplan hart neutralisieren, wenn verboten —
    // sonst bliebe eine erfundene Schlagzeile stehen.
    if (isPay && (typeof b.headline === 'string') && res.some(re => re.test(b.headline as string))) {
      b.headline = 'Der Zahlungsplan im Überblick'
    }
    if (isPay && (typeof b.kicker === 'string') && res.some(re => re.test(b.kicker as string))) {
      b.kicker = 'Zahlungsplan'
    }
  }
}

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
const MARINA_MODEL = 'https://vjlwgajmtqlwjjreowbu.supabase.co/storage/v1/object/public/deck-assets/brand/paphos-marina-model.jpg'
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

function distanceChips(lat: number, lng: number): Array<{ min: string; label: string }> {
  const chips: Array<{ min: string; label: string }> = []
  const beach = BEACHES
    .map(b => ({ ...b, km: roadKm(haversineKm(lat, lng, b.lat, b.lng)) }))
    .sort((a, b) => a.km - b.km)[0]
  chips.push({ min: `ca. ${fmtKm(beach.km)}`, label: `Strand (${beach.label})` })
  for (const p of POIS) {
    chips.push({ min: `ca. ${fmtKm(roadKm(haversineKm(lat, lng, p.lat, p.lng)))}`, label: p.label })
  }
  chips.push({ min: `ca. ${fmtKm(roadKm(haversineKm(lat, lng, MARINA_SITE.lat, MARINA_SITE.lng)))}`, label: 'Neue Paphos-Marina (geplant)' })
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

function buildMarinaBlocks(projName: string, fromSub: string, lat?: number | null, lng?: number | null): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{
    type: 'feature',
    kicker: MARINA_TEXTS.featureKicker,
    headline: MARINA_TEXTS.featureHeadline,
    image: MARINA_MODEL,
    text: MARINA_TEXTS.featureText,
    quote: MARINA_TEXTS.featureQuote,
    link: MARINA_ARTICLE,
    linkLabel: 'Zum Zeitungsartikel',
  }]
  if (lat != null && lng != null) {
    const km  = roadKm(haversineKm(lat, lng, MARINA_SITE.lat, MARINA_SITE.lng))
    out.push({
      type: 'marina',
      kicker: 'Lage · Neue Paphos-Marina',
      headline: `Nur die Küste entlang: ca. ${fmtKm(km)} zur Marina.`,
      fromLabel: projName || 'Projekt', fromSub,
      toLabel: 'Paphos-Marina', toSub: 'Potima Bay · Kissonerga',
      distance: `ca. ${fmtKm(km)}`, drive: `ca. ${driveMin(km)} Min mit dem Auto`,
      valuePct: MARINA_TEXTS.valuePct,
      valueText: MARINA_TEXTS.valueText,
      note: MARINA_TEXTS.note,
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
): void {
  const lat = proj?.latitude, lng = proj?.longitude
  const fi = blocks.findIndex(b => b.type === 'facts')
  if (fi >= 0 && lat != null && lng != null) {
    const fb = blocks[fi] as Record<string, unknown>
    const aiItems = (Array.isArray(fb.items) ? fb.items as Array<{ min?: string; label?: string }> : [])
      .filter(it => !/km|min/i.test(String(it.min ?? ''))).slice(0, 2)
    fb.items = [...distanceChips(lat, lng), ...aiItems]
  }
  const hasMarina = blocks.some(b =>
    b.type === 'marina' ||
    /paphos-marina|marina/i.test(String(b.kicker ?? '') + ' ' + String(b.headline ?? '')))
  if (!hasMarina) {
    let at = fi >= 0 ? fi + 1 : Math.min(4, blocks.length - 1)
    while (at < blocks.length && blocks[at].type === 'columns') at++
    const fromSub = (proj?.location ?? '').split(',')[0].trim() || 'Region Paphos'
    blocks.splice(at, 0, ...buildMarinaBlocks(projName, fromSub, lat, lng))
  }
}

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

function assignImages(blocks: Array<Record<string, unknown>>, images?: DeckImages, projName?: string): void {
  const renders = images?.renders ?? []
  let ri = 0, pi = 0, fpi = 0
  const nextRender = () => renders.length ? renders[ri++ % renders.length] : `https://picsum.photos/seed/deck${++pi}/1600/1000`
  for (const b of blocks) {
    const t = b.type
    if (t === 'cover' || t === 'unit' || t === 'columns' || t === 'feature') b.image = nextRender()
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
    // Mehrere Grundrisse (eine pro Wohnung) der Reihe nach auf die floorplan-Blöcke verteilen.
    if (t === 'floorplan') { const fps = images?.floorplans ?? []; b.image = (fps.length ? fps[fpi++ % fps.length] : images?.floorplan) ?? nextRender() }
    if (t === 'gallery' && Array.isArray(b.items)) {
      for (const it of b.items as Array<Record<string, unknown>>) it.image = nextRender()
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY fehlt' }, 500)

  try {
    const body = await req.json() as {
      recipient_name?: string; angle?: string; briefing?: string; facts?: string
      month_label?: string
      images?: { renders?: string[]; floorplan?: string; floorplans?: string[]; map?: string; mapUrl?: string; mapMarker?: { x: number; y: number }; mapLat?: number; mapLng?: number; mapQuery?: string; gallery?: Array<{ url: string; category: string; label: string }> }
      lead_id?: string; deal_id?: string; project_id?: string; unit_id?: string; batch_id?: string; created_by?: string
      // Mehrere Wohnungen EINES Projekts in EINEM Deck (je eigener unit-Block + Preis).
      units?: Array<{ unit_number?: string; price_net?: number | null }>
      generic?: boolean
      background?: boolean
    }
    const generic   = body.generic === true
    const recipient = generic ? '' : (body.recipient_name?.trim() || 'den Kunden')
    const angle     = body.angle || 'investment'
    // Eigennutz (Erstwohnsitz) → reduzierte MwSt 5 % + Wohn-/Lifestyle-Ton; Investment → 19 % + ROI-Ton.
    // (Zyprische 5%-Regelung für Eigennutzer, Übergangsfrist bis 31.12.2026; qualifiziert der Kunde,
    //  wählt Sven im Wizard "Eigennutz".) angleTone gibt der KI weiter den bekannten lifestyle/investment-Ton.
    const isEigennutz = angle === 'eigennutz'
    const vatRate   = isEigennutz ? 0.05 : 0.19
    const vatPct    = isEigennutz ? '5 %' : '19 %'
    const angleTone = isEigennutz ? 'lifestyle' : angle
    if (!body.facts?.trim()) return json({ error: 'facts fehlt' }, 400)

    // Gelernte Vorgaben (deck_ai_rules, kind='deck') → fließen in JEDES Deck ein (Auto-Grab +
    // Feinschliff). Global (project_id null) immer; projektspezifische nur für DIESES Projekt.
    const sbRules = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    let rulesQ = sbRules.from('deck_ai_rules').select('rule').eq('active', true).eq('kind', 'deck')
    rulesQ = body.project_id ? rulesQ.or(`project_id.is.null,project_id.eq.${body.project_id}`) : rulesQ.is('project_id', null)
    const { data: aiRules } = await rulesQ
    const learnedTxt = (aiRules ?? []).map((r: { rule: string }) => `- ${r.rule}`).join('\n')
    const learnedBlock = learnedTxt ? `GELERNTE VORGABEN (immer beachten):\n${learnedTxt}\n\n` : ''

    // ── VERBINDLICHE Preisangaben (Netto/MwSt/Brutto + Einrichtungs-Ausweis) +
    // Fertigstellung — aus der DB, damit die KI NICHT selbst rechnet. priceLines
    // werden später deterministisch in den unit-Block gesetzt.
    const eur = (n: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
    const normU = (s: unknown) => String(s ?? '').trim().toLowerCase()
    // priceLines JE Wohnung (Schlüssel = normalisierte Wohnungsnummer) — so kann EIN Deck
    // mehrere Wohnungen eines Projekts mit je eigenem Preis-Block enthalten.
    const priceLinesByUnit: Record<string, Array<{ label: string; value: string; strong?: boolean }>> = {}
    // Parallel: Netto/MwSt/Brutto je Wohnung für die priceSummary-Box im Zahlungsplan
    // (MwSt-Berechnung im payment-Block = Standard, nicht der KI überlassen).
    const priceSummaryByUnit: Record<string, { net: string; vatRate: string; vat: string; gross: string }> = {}
    // GRUNDRISS-STANDARD (Sven): hinterlegte HP-Grundrisse je Wohnung — wenn einer
    // existiert, kommt er ins Deck. Quelle: crm_projects.deck_assets.floorplans
    // (Map Wohnungsnummer → Bild-URL, Fallback-Key "<n>br" je Zimmertyp).
    const floorplanByUnit: Record<string, string> = {}
    let extraFacts = ''
    if (body.project_id) {
      try {
        let unitList: Array<{ unit_number: string; price_net: number; bedrooms: number | null }> = []
        // Alle Wohnungen des Projekts (Zimmerzahl je Wohnung) für die zimmer-
        // abhängige Möbel-Kalkulation als Map bereitstellen.
        const { data: allU } = await sbRules.from('crm_project_units').select('unit_number, bedrooms').eq('project_id', body.project_id)
        const bedByUnit = new Map<string, number | null>()
        for (const u of (allU ?? []) as Array<{ unit_number?: string; bedrooms?: number | null }>) {
          if (u.unit_number) bedByUnit.set(normU(u.unit_number), u.bedrooms ?? null)
        }
        if (body.units?.length) {
          unitList = body.units.filter(u => u.unit_number).map(u => ({ unit_number: String(u.unit_number), price_net: Number(u.price_net) || 0, bedrooms: bedByUnit.get(normU(u.unit_number)) ?? null }))
        } else if (body.unit_id) {
          const { data: u } = await sbRules.from('crm_project_units').select('unit_number, price_net, bedrooms').eq('id', body.unit_id).maybeSingle()
          const uu = u as { unit_number?: string; price_net?: number; bedrooms?: number | null } | null
          if (uu?.unit_number) unitList = [{ unit_number: uu.unit_number, price_net: Number(uu.price_net) || 0, bedrooms: uu.bedrooms ?? null }]
        }
        const { data: p } = await sbRules.from('crm_projects').select('furniture_cost, furniture_included, completion_date, calc_defaults, deck_assets').eq('id', body.project_id).maybeSingle()
        // Hinterlegte Grundrisse je Wohnung einsammeln (Nummer exakt, sonst Zimmertyp "<n>br").
        // Quelle: deck_assets.unit_floorplans (Record) — NICHT deck_assets.floorplans, das ist
        // bei manchen Projekten ein Etagen-Array aus dem Drive-Import.
        const daFp = (p as { deck_assets?: { unit_floorplans?: Record<string, string>; floorplans?: unknown } } | null)?.deck_assets
        const fpMap = daFp?.unit_floorplans ?? ((daFp && !Array.isArray(daFp.floorplans)) ? (daFp.floorplans as Record<string, string> | undefined) : undefined) ?? {}
        for (const u of unitList) {
          const fpUrl = fpMap[normU(u.unit_number)] ?? (u.bedrooms != null ? fpMap[`${u.bedrooms}br`] : undefined)
          if (fpUrl) floorplanByUnit[normU(u.unit_number)] = fpUrl
        }
        const furnIncluded = !!(p as { furniture_included?: boolean } | null)?.furniture_included
        const furnDefault = Number((p as { furniture_cost?: number } | null)?.furniture_cost) || 0
        const furnByBed = (p as { calc_defaults?: { furniture_by_bedrooms?: Record<string, number> } } | null)?.calc_defaults?.furniture_by_bedrooms ?? null
        // Möbel-Nettopreis je Wohnung: ZIMMERABHÄNGIG (furniture_by_bedrooms, z.B.
        // 1-SZ 17.000 / 2-SZ 19.000) mit Fallback auf den projektweiten furniture_cost.
        const furnFor = (bedrooms: number | null): number => {
          if (furnIncluded) return 0
          if (furnByBed && bedrooms != null && furnByBed[String(bedrooms)] != null) return Number(furnByBed[String(bedrooms)]) || 0
          return furnDefault
        }
        const buildLines = (baseNet: number, furnNet: number) => {
          const totalNet = baseNet + furnNet
          const vat = Math.round(totalNet * vatRate)
          const brutto = totalNet + vat
          const lines: Array<{ label: string; value: string; strong?: boolean }> = [
            { label: furnNet > 0 ? 'Nettopreis (inkl. Einrichtung)' : (furnIncluded ? 'Nettopreis (inkl. Möbel)' : 'Nettopreis'), value: eur(totalNet) },
            { label: `zzgl. MwSt (${vatPct})`, value: eur(vat) },
            { label: 'Bruttopreis', value: eur(brutto), strong: true },
          ]
          if (furnNet > 0) lines.push({ label: 'davon Einrichtungspaket', value: `${eur(furnNet)} netto · ${eur(Math.round(furnNet * (1 + vatRate)))} brutto` })
          else if (furnIncluded) lines.push({ label: 'Einrichtung', value: 'im Kaufpreis enthalten' })
          return lines
        }
        const priced = unitList.filter(u => u.price_net > 0)
        for (const u of priced) {
          const furnNet = furnFor(u.bedrooms)
          priceLinesByUnit[normU(u.unit_number)] = buildLines(u.price_net, furnNet)
          const totalNet = u.price_net + furnNet
          const vat = Math.round(totalNet * vatRate)
          priceSummaryByUnit[normU(u.unit_number)] = { net: eur(totalNet), vatRate: vatPct, vat: eur(vat), gross: eur(totalNet + vat) }
        }
        // Bei Eigennutz die 5%-Basis explizit als Fakt mitgeben, damit die KI den GESAMTEN
        // Zahlungsplan (Reservierung/Anzahlung/Raten) + Intro auf 5 % rechnet, nicht 19 %.
        if (isEigennutz && priced.length > 0) {
          extraFacts += `\n\n=== MWST-BASIS: 5 % (EIGENNUTZ / ERSTWOHNSITZ) — HART ===\nAlle Brutto-Beträge, der Bruttopreis UND der gesamte Zahlungsplan (Reservierung, Anzahlung, alle Raten, Summen) sind auf Basis 5 % MwSt zu rechnen — NICHT 19 %. Im 'payment'-Block als note der Hinweis: Der reduzierte MwSt-Satz von 5 % setzt einen nachgewiesenen Eigennutz/Erstwohnsitz in Zypern voraus (Übergangsregelung, Steuerberater-Vorbehalt).`
        }
        if (priced.length === 1) {
          extraFacts += `\n\n=== VERBINDLICHE PREISANGABEN (im 'unit'-Block GENAU so darstellen, NICHT selbst rechnen, NICHT woanders wiederholen) ===\n${priceLinesByUnit[normU(priced[0].unit_number)].map(l => `${l.label}: ${l.value}`).join('\n')}`
        } else if (priced.length > 1) {
          const parts = priced.map(u => `WOHNUNG ${u.unit_number}:\n${priceLinesByUnit[normU(u.unit_number)].map(l => `  ${l.label}: ${l.value}`).join('\n')}`)
          extraFacts += `\n\n=== VERBINDLICHE PREISANGABEN JE WOHNUNG (für JEDE Wohnung EINEN eigenen 'unit'-Block mit number=Wohnungsnummer und GENAU diesen Werten als priceLines; NICHT selbst rechnen, NICHT woanders wiederholen) ===\n${parts.join('\n\n')}`
        }
        const cd = (p as { completion_date?: string } | null)?.completion_date
        if (cd) { const d = new Date(cd); extraFacts += `\n\n=== FERTIGSTELLUNG (muss im Deck genannt werden): ${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ===` }
      } catch { /* best effort — ohne Preisangaben generiert die KI wie bisher */ }
    }
    const factsAug = body.facts.trim() + extraFacts

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

    const reqBody = JSON.stringify({
      model:       'claude-sonnet-4-6',
      max_tokens:  16000,
      system:      SYSTEM,
      tools:       [{
        name:        'emit_deck',
        description: 'Gibt das fertige, personalisierte Sales-Deck als geordnete Block-Liste zurück.',
        input_schema: {
          type: 'object',
          properties: {
            blocks: {
              type: 'array',
              description: 'Die geordnete Liste der Deck-Blöcke.',
              items: {
                type: 'object',
                properties: {
                  type:       { type: 'string', enum: ['cover','letter','unit','facts','columns','feature','gallery','benefits','floorplan','payment','cta'] },
                  kicker:     { type: 'string' },
                  title:      { type: 'string' },
                  tagline:    { type: 'string' },
                  forLine:    { type: 'string' },
                  headline:   { type: 'string' },
                  paragraphs: { type: 'array', items: { type: 'string' } },
                  signoff:    { type: 'string' },
                  signName:   { type: 'string' },
                  number:     { type: 'string' },
                  nickname:   { type: 'string' },
                  specs:      { type: 'array', items: { type: 'string' } },
                  priceMain:  { type: 'string' },
                  priceSub:   { type: 'string' },
                  priceLines: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, strong: { type: 'boolean' } }, required: ['label', 'value'] } },
                  note:       { type: 'string' },
                  text:       { type: 'string' },
                  quote:      { type: 'string' },
                  intro:      { type: 'string' },
                  items:      { type: 'array', items: { type: 'object' } },
                  cols:       { type: 'array', items: { type: 'object' } },
                  cards:      { type: 'array', items: { type: 'object' } },
                  groups:     { type: 'array', items: { type: 'object' } },
                  stats:      { type: 'array', items: { type: 'object' } },
                  bullets:    { type: 'array', items: { type: 'object' } },
                  steps:      { type: 'array', items: { type: 'object' } },
                  phase1:     { type: 'object' },
                  phase2:     { type: 'object' },
                },
                required: ['type'],
              },
            },
          },
          required: ['blocks'],
        },
      }],
      tool_choice: { type: 'tool', name: 'emit_deck' },
      messages:    [{ role: 'user', content: userMsg }],
    })

    // Die eigentliche Generierung (Claude ~60-90s + Insert). Kann synchron laufen
    // oder — fürs generische Deck im Browser — im Hintergrund (waitUntil).
    const doGenerate = async (): Promise<{ token: string; blocks: number }> => {
    // Ein Call (mehrere sprengen das Edge-CPU-Budget). "blocks" kommt als Array
    // oder als String (dann parsen — durch die Anführungszeichen-Regel valide).
    let blocks: Array<Record<string, unknown>> = []
    let diag: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 1 && blocks.length === 0; attempt++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: reqBody,
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: { message?: string } }
        diag = { http: res.status, msg: e.error?.message }
        continue
      }
      const data = await res.json() as { content?: Array<{ type?: string; input?: { blocks?: unknown } }>; stop_reason?: string }
      const tu = (data.content ?? []).find(c => c.type === 'tool_use')
      const rawBlocks = tu?.input?.blocks
      if (Array.isArray(rawBlocks)) {
        blocks = rawBlocks as Array<Record<string, unknown>>
      } else if (typeof rawBlocks === 'string') {
        const candidates: string[] = [rawBlocks]
        try { candidates.push(jsonrepair(rawBlocks)) } catch { /* Reparatur fehlgeschlagen */ }
        for (const txt of candidates) {
          try { const p = JSON.parse(txt); if (Array.isArray(p)) { blocks = p; break } } catch { /* nächster Kandidat */ }
        }
      }
      diag = { stop_reason: data.stop_reason, blocksType: typeof rawBlocks, raw: typeof rawBlocks === 'string' ? rawBlocks : JSON.stringify(rawBlocks) }
    }
    if (blocks.length === 0) throw new Error('Keine Blöcke generiert: ' + JSON.stringify(diag).slice(0, 300))
    // Projektname für den Standort-Kreis auf der Karte (aus dem Fakten-Header „=== PROJEKT X (…)").
    const projName = (body.facts ?? '').match(/===\s*PROJEKT\s+(.+?)\s*[(\n]/)?.[1]?.trim() || ''
    // Standort-Karte IMMER interaktiv (Deck-Standard): exakte Koordinaten bevorzugt,
    // sonst Such-Query aus Projektname + Ort → Deck.tsx baut ein scroll-/zoombares
    // Google-Embed statt eines statischen Bildes.
    let projRow: { name?: string; location?: string | null; latitude?: number | null; longitude?: number | null; video_url?: string | null } | null = null
    if (body.project_id) {   // gilt für generische UND personalisierte Decks
      try {
        const { data: proj } = await sbRules.from('crm_projects')
          .select('name, location, latitude, longitude, video_url, deck_assets').eq('id', body.project_id).maybeSingle()
        const pr = proj as { name?: string; location?: string | null; latitude?: number | null; longitude?: number | null; video_url?: string | null; deck_assets?: { mapUrl?: string } | null } | null
        projRow = pr
        if (pr) {
          body.images = body.images ?? {}
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
          if (!body.images.mapUrl) {
            body.images.mapUrl = body.images.mapLat != null
              ? `https://www.google.com/maps?q=${body.images.mapLat},${body.images.mapLng}`
              : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(body.images.mapQuery ?? projName)}`
          }
        }
      } catch { /* Karte optional — Deck wird trotzdem erzeugt */ }
    }
    assignImages(blocks, body.images, projName)
    scrubNarrative(blocks)   // Wahrheits-Backstop (erfundene Zahlungs-/Garantie-/Auslastungs-Sätze raus)
    // Deck-Standard: Entfernungs-Chips (facts) + Marina-Sektion — deterministisch,
    // damit JEDES Deck sie hat, unabhängig davon was die KI liefert.
    injectLocationAndMarina(blocks, projRow?.name || projName, projRow)
    // Projekt-Video (falls hinterlegt) nach der Lage-Sektion einsetzen.
    injectVideo(blocks, projRow?.video_url)
    // Preis deterministisch in den unit-Block setzen (KI rechnet nicht) — exakt
    // Netto/MwSt/Brutto + Einrichtungs-Ausweis. Überschreibt KI-Preisfelder.
    const plKeys = Object.keys(priceLinesByUnit)
    if (plKeys.length) {
      const unitBlocks = blocks.filter(b => b.type === 'unit')
      if (plKeys.length === 1 && unitBlocks.length) {
        // Einzel-Wohnung: robust auf den ersten unit-Block (auch falls number leicht abweicht).
        const ub = unitBlocks[0]
        ub.priceLines = priceLinesByUnit[plKeys[0]]; delete ub.priceMain; delete ub.priceSub
      } else {
        // Mehrere Wohnungen: je unit-Block per Wohnungsnummer (number/nickname) zuordnen.
        for (const ub of unitBlocks) {
          const pl = priceLinesByUnit[normU(ub.number)] ?? priceLinesByUnit[normU(ub.nickname)]
          if (pl) { ub.priceLines = pl; delete ub.priceMain; delete ub.priceSub }
        }
      }
    }
    // MwSt-Berechnung als STANDARD auch im Zahlungsplan: Netto → MwSt → Brutto als
    // priceSummary-Box. Einzel-Wohnung → auf alle payment-Blöcke; mehrere → per
    // Wohnungsnummer aus kicker/headline zuordnen (sonst nicht raten).
    const psKeys = Object.keys(priceSummaryByUnit)
    if (psKeys.length) {
      for (const pb of blocks.filter(b => b.type === 'payment')) {
        if (psKeys.length === 1) { pb.priceSummary = priceSummaryByUnit[psKeys[0]]; continue }
        const hay = normU(JSON.stringify({ k: pb.kicker, h: pb.headline }))
        const k = psKeys.find(key => key && hay.includes(key))
        if (k) pb.priceSummary = priceSummaryByUnit[k]
      }
    }
    // GRUNDRISS-STANDARD: hinterlegten HP-Grundriss deterministisch in den floorplan-Block
    // setzen (ersetzt KI-rooms/Roh-Pläne). Einzel-Wohnung → alle floorplan-Blöcke; mehrere
    // Wohnungen → der Reihe nach (Regel: je Wohnung eigener unit+floorplan-Block in
    // Wohnungs-Reihenfolge). Der Hinweis „Maße ca." steckt im Grundriss-Bild selbst.
    const fpKeys = Object.keys(floorplanByUnit)
    if (fpKeys.length) {
      const fpBlocks = blocks.filter(b => b.type === 'floorplan')
      fpBlocks.forEach((fb, i) => {
        const url = fpKeys.length === 1 ? floorplanByUnit[fpKeys[0]] : floorplanByUnit[fpKeys[Math.min(i, fpKeys.length - 1)]]
        if (url) { fb.image = url; delete fb.rooms }
      })
    }

    // Generisches Projekt-Deck: beschriftete Bildstrecken pro Bereich (Wohnen, Küche,
    // Schlafen, Bäder, Pool, Lobby, Außen) aus den kategorisierten Renders einbauen,
    // damit der Kunde im Zoom sieht, wie alles aussieht.
    const gal = body.images?.gallery ?? []
    if (gal.length) {
      // Reihenfolge: zuerst Außen/Projekt (Sven: „immer Außenbilder zeigen"),
      // dann ein Rundgang durch die Wohnung. Jedes Bild trägt sein echtes
      // Vision-Label als Titel → Beschriftung passt garantiert zum Bildinhalt.
      const GROUPS: Array<{ cats: string[]; kicker: string; headline: string }> = [
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
        galleryBlocks.push({ type: 'gallery', kicker: 'Projekt', headline: 'Eindrücke', items: gal.slice(0, 6).map(x => ({ image: x.url, title: x.label || undefined })) })
      }
      if (galleryBlocks.length) {
        const filtered = blocks.filter(b => b.type !== 'gallery')   // Modell-Galerien ersetzen
        const ctaIdx = filtered.findIndex(b => b.type === 'cta')
        const at = ctaIdx >= 0 ? ctaIdx : filtered.length
        blocks = [...filtered.slice(0, at), ...galleryBlocks, ...filtered.slice(at)]
      }
    }

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // Generisches Projekt-Deck: bestehenden Token IN-PLACE überschreiben → stabiler Link
    // (Sven kann denselben Link teilen; Re-Grab/Feinschliff ändert die URL nicht).
    let existingToken: string | null = null
    if (generic && body.project_id) {
      const { data: pr } = await supabase.from('crm_projects').select('deck_token').eq('id', body.project_id).maybeSingle()
      existingToken = (pr as { deck_token?: string | null } | null)?.deck_token ?? null
    }

    let token: string
    if (existingToken) {
      const { error } = await supabase.from('sales_decks')
        .update({ content: { blocks }, status: 'ready', angle }).eq('token', existingToken)
      if (error) throw new Error(`DB: ${error.message}`)
      token = existingToken
      await supabase.from('crm_projects').update({ deck_generated_at: new Date().toISOString() }).eq('id', body.project_id!)
    } else {
      const { data: row, error } = await supabase.from('sales_decks').insert({
        recipient_name: body.recipient_name ?? null,
        angle,
        status:     'ready',
        content:    { blocks },
        lead_id:    body.lead_id ?? null,
        deal_id:    body.deal_id ?? null,
        project_id: body.project_id ?? null,
        unit_id:    body.unit_id ?? null,
        batch_id:   body.batch_id ?? null,
        created_by: body.created_by ?? null,
      }).select('token').single()
      if (error) throw new Error(`DB: ${error.message}`)
      token = (row as { token: string }).token
      if (generic && body.project_id) {
        await supabase.from('crm_projects').update({ deck_token: token, deck_generated_at: new Date().toISOString() }).eq('id', body.project_id)
      }
    }
    return { token, blocks: blocks.length }
    }   // ── Ende doGenerate ──

    // Generisches Deck im Browser: lange Generierung (~80s) im HINTERGRUND laufen lassen
    // → sofortige Antwort, kein Verbindungs-Timeout. Der Browser pollt danach
    // crm_projects.deck_token. Sonstige/sync-Aufrufer warten normal auf das Ergebnis.
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
    if (body.background && er?.waitUntil) {   // generisch UND personalisiert (Batch im Wizard)
      er.waitUntil(doGenerate().catch(() => {}))
      return json({ ok: true, background: true })
    }
    const out = await doGenerate()
    return json({ ok: true, token: out.token, url: `/deck/${out.token}`, blocks: out.blocks })

  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
