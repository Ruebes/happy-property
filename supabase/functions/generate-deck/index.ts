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
4b. AUSSTATTUNG: Sobald im Input ein Einrichtungspaket / Ausstattung / Möbelliste / Geschirr / Besteck (cutlery) / Wäsche (linen) steht, MUSST du das prominent zeigen — als ein bis zwei "inventory"-Blöcke (ein bis zwei Seiten). Empfehlung: Block 1 = Möbel, Geräte & Premium-Marken (gruppiert, z.B. Wohnen, Küche & Geräte, Schlafen, Bad — mit den echten Markennamen aus den Fakten wie BOSCH, Neff, GROHE, LAUFEN, Samsung, Tomasella, DUPEN); Block 2 = die Komplett-Checkliste (Geschirr & Besteck mit Stückzahlen, Wäsche & Bettwäsche). Ein inventory-Block beschreibt AUSSCHLIESSLICH, WAS zum Paket gehört — NIEMALS, OB es im Kaufpreis enthalten ist. Ob die Einrichtung im Preis steckt, sagt allein der Abschnitt „EINRICHTUNG" in den Fakten; fehlt er, schreibst du dazu gar nichts. STRIKT VERBOTEN ohne ausdrückliche Deckung durch diesen Abschnitt: „schlüsselfertig", „voll möbliert", „komplett eingerichtet", „sofort bezugsfertig", „der Kunde packt nur die Koffer", „im Kaufpreis enthalten" und jede sinngemäße Formulierung. Nutze NUR die im Input gelisteten Gegenstände/Marken, erfinde nichts dazu.
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
type DeckImages = { heroVideo?: string; renders?: string[]; floorplan?: string; floorplans?: string[]; map?: string; mapUrl?: string; mapMarker?: { x: number; y: number }; mapLat?: number; mapLng?: number; mapQuery?: string; gallery?: Array<{ url: string; category: string; label: string }> }
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
// Moebel-Behauptungen: greifen NUR, wenn die Stammdaten die Einrichtung nicht als
// im Preis enthalten ausweisen. Deterministischer Backstop hinter der Prompt-Regel -
// das Deck fuer Holger Rumiantcev schrieb "Einrichtungspaket vollstaendig im
// Kaufpreis enthalten", obwohl der Preis die Moebel gar nicht enthielt (Sven 26.8.).
const FORBIDDEN_FURNITURE: RegExp[] = [
  /schlüsselfertig/i,
  /voll(ständig)?\s+möbliert/i,
  /komplett\s+eingerichtet/i,
  /(möbel|einrichtung|einrichtungspaket)[^.!?]*(im (kauf)?preis|inklusive|enthalten)/i,
  /(im (kauf)?preis|inklusive)[^.!?]*(möbel|einrichtung)/i,
  /nur (noch )?die koffer|packst (du )?die koffer/i,
  /sofort bezugs-? ?(und vermiet)?(bereit|fertig)/i,
]
// Verneinte Saetze sind erwuenscht ("NICHT im Kaufpreis enthalten") - die duerfen bleiben.
const VERNEINT = /\b(nicht|kein[e]?[nmrs]?|ohne|optional|extra|Aufpreis|zusätzlich|separat)\b/i

function dropBadSentences(s: unknown, res: RegExp[]): string {
  if (typeof s !== 'string' || !s) return typeof s === 'string' ? s : ''
  const parts = s.split(/(?<=[.!?…])\s+/)
  const kept = parts.filter(p => !res.some(re => re.test(p) && !VERNEINT.test(p)))
  return kept.join(' ').trim()
}
// Bei "ohne Moebel" fliegt jede Moebel-Erwaehnung raus - auch ganze inventory-Bloecke,
// die nur davon handeln. Sven verkauft solche Objekte ohne Einrichtung; ein Deck, das
// Moebel auch nur als Option zeigt, verwirrt den Kunden (Sven 26.8.).
const MOEBEL_WORT = /möbel|möbliert|einrichtungspaket|einrichtung|geschirr|besteck|bettwäsche|wäschepaket|cutlery|linen|sofa|matratze|bettrahmen/i
const FEST_VERBAUT = /küche|einbauschrank|einbauschränke|sanitär|klima|boden|böden|fenster|dusche|wc|armatur|schrankfront/i
function dropFurnitureBlocks(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return blocks.filter(b => {
    const txt = JSON.stringify(b)
    if (!MOEBEL_WORT.test(txt)) return true
    // Inventar-/Ausstattungsbloecke: nur behalten, wenn sie ueberwiegend fest
    // Verbautes zeigen; reine Moebelbloecke fliegen ganz raus.
    if (b.type === 'inventory' || b.type === 'unit_extra') {
      const moebel = (txt.match(MOEBEL_WORT) ?? []).length
      const fest = (txt.match(FEST_VERBAUT) ?? []).length
      return fest > moebel
    }
    return true
  })
}
function stripFurnitureWords(blocks: Array<Record<string, unknown>>): void {
  const raus = (s: unknown) => typeof s === 'string'
    ? s.split(/(?<=[.!?…])\s+/).filter(p => !(MOEBEL_WORT.test(p) && !FEST_VERBAUT.test(p))).join(' ').trim()
    : s
  for (const b of blocks) {
    for (const f of ['intro', 'note', 'text', 'quote', 'headline', 'tagline', 'nickname', 'kicker']) {
      if (typeof b[f] === 'string') {
        const neu = raus(b[f])
        b[f] = (f === 'headline' || f === 'kicker' || f === 'nickname' || f === 'tagline') && !neu ? undefined : neu
      }
    }
    if (Array.isArray(b.paragraphs)) b.paragraphs = (b.paragraphs as unknown[]).map(raus).filter(Boolean)
    for (const listKey of ['specs', 'items', 'bullets']) {
      if (Array.isArray(b[listKey])) {
        b[listKey] = (b[listKey] as unknown[]).filter(x => {
          const t = typeof x === 'string' ? x : JSON.stringify(x)
          return !(MOEBEL_WORT.test(t) && !FEST_VERBAUT.test(t))
        })
      }
    }
    for (const grpKey of ['groups', 'cards', 'cols', 'steps']) {
      if (!Array.isArray(b[grpKey])) continue
      b[grpKey] = (b[grpKey] as Array<Record<string, unknown>>).filter(g => {
        if (!g || typeof g !== 'object') return true
        for (const f of ['text', 'title', 'note']) if (typeof g[f] === 'string') g[f] = raus(g[f])
        if (Array.isArray(g.items)) {
          g.items = (g.items as unknown[]).filter(x => {
            const t = typeof x === 'string' ? x : JSON.stringify(x)
            return !(MOEBEL_WORT.test(t) && !FEST_VERBAUT.test(t))
          })
        }
        const t = JSON.stringify(g)
        return !(MOEBEL_WORT.test(t) && !FEST_VERBAUT.test(t))
      })
    }
  }
}

function scrubNarrative(blocks: Array<Record<string, unknown>>, furnIncluded = true): void {
  const furnRes = furnIncluded ? [] : FORBIDDEN_FURNITURE
  for (const b of blocks) {
    const isPay = b.type === 'payment'
    const res = [...FORBIDDEN_GLOBAL, ...furnRes, ...(isPay ? FORBIDDEN_PAYMENT : [])]
    for (const f of ['intro', 'note', 'text', 'quote']) {
      if (typeof b[f] === 'string') b[f] = dropBadSentences(b[f], res)
    }
    if (Array.isArray(b.paragraphs)) {
      b.paragraphs = (b.paragraphs as unknown[]).map(p => dropBadSentences(p, res)).filter(Boolean)
    }
    // Kurztexte tragen die Ausstattungs-Behauptung genauso oft wie Fliesstext:
    // specs, Karten und Inventar-Punkte muessen mitgeprueft werden.
    for (const listKey of ['specs', 'items', 'bullets']) {
      if (Array.isArray(b[listKey])) {
        b[listKey] = (b[listKey] as unknown[]).filter(x => typeof x !== 'string' || !furnRes.some(re => re.test(x) && !VERNEINT.test(x)))
      }
    }
    for (const grpKey of ['groups', 'cards', 'cols']) {
      const arr = b[grpKey]
      if (!Array.isArray(arr)) continue
      for (const g of arr as Array<Record<string, unknown>>) {
        if (!g || typeof g !== 'object') continue
        for (const f of ['text', 'title', 'note']) {
          if (typeof g[f] === 'string') g[f] = dropBadSentences(g[f], res)
        }
        if (Array.isArray(g.items)) {
          g.items = (g.items as unknown[]).filter(x => typeof x !== 'string' || !furnRes.some(re => re.test(x) && !VERNEINT.test(x)))
        }
      }
    }
    // Headline/Kicker eines Ausstattungs-Blocks duerfen die Behauptung ebenso wenig tragen.
    if (!furnIncluded) {
      for (const f of ['headline', 'tagline']) {
        if (typeof b[f] === 'string' && furnRes.some(re => re.test(b[f] as string) && !VERNEINT.test(b[f] as string))) {
          b[f] = b.type === 'inventory' ? 'Die Ausstattung im Überblick' : ''
        }
      }
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
// Quelle: Luma Agent-Guide (Reservierung 10.000 € → 35/20/20/15/10 % + Title Deeds).
// Wird genutzt, wenn ein Projekt keinen eigenen payment_schedule hinterlegt hat und
// der Bauträger Luma ist — damit JEDES Luma-Deck einen Zahlungsplan bekommt.
type PayStage = { label: string; sub?: string; pct: number }
type PaySchedule = { reservation?: number; currency?: string; stages: PayStage[] }
const LUMA_PAYMENT: PaySchedule = {
  reservation: 10000, currency: 'EUR',
  stages: [
    { label: 'Bei Vertragsunterzeichnung', sub: 'abzüglich Reservierung', pct: 35 },
    { label: '2. Rate · Baufortschritt', pct: 20 },
    { label: '3. Rate · Baufortschritt', pct: 20 },
    { label: '4. Rate · Baufortschritt', pct: 15 },
    { label: 'Bei Übergabe · Title Deeds', pct: 10 },
  ],
}

// Baut einen sachlichen payment-Block aus einem Zahlungsplan-Schema. Ist ein Kaufpreis
// bekannt (basis = {net, gross}), werden die absoluten Beträge je Stufe ausgewiesen
// (brutto als Hauptwert, netto zusätzlich); sonst nur die Prozentstufen. KEINE erfundenen
// Käufer-Schutz-/Timing-Narrative (Regel 4d) — nur sachliche Fälligkeits-Hinweise.
function buildPaymentBlock(sched: PaySchedule, basis?: { net: number; gross: number } | null): Record<string, unknown> {
  const stages = sched.stages ?? []
  const half = Math.ceil(stages.length / 2)
  const fmtEur = (n: number) => Math.round(n).toLocaleString('de-DE') + ' €'
  const hasBasis = !!basis && basis.gross > 0
  const stageVal = (s: PayStage) => hasBasis ? fmtEur(s.pct / 100 * basis!.gross) : `${s.pct} %`
  const stageSub = (s: PayStage) => {
    const parts: string[] = []
    if (s.sub) parts.push(s.sub)
    if (hasBasis) parts.push(`${s.pct} % · ${fmtEur(s.pct / 100 * basis!.net)} netto`)
    return parts.length ? parts.join(' · ') : undefined
  }
  const p1rows: Array<Record<string, unknown>> = []
  if (sched.reservation) p1rows.push({ label: 'Reservierung', sub: hasBasis ? 'sofort fällig · sichert die Wohnung' : 'sichert die Wohnung', value: fmtEur(sched.reservation) })
  stages.slice(0, half).forEach(s => p1rows.push({ label: s.label, sub: stageSub(s), value: stageVal(s) }))
  const p2rows = stages.slice(half).map(s => ({ label: s.label, sub: stageSub(s), value: stageVal(s) }))
  const block: Record<string, unknown> = {
    type: 'payment',
    kicker: 'Zahlungsplan',
    headline: 'Der Zahlungsplan im Überblick',
    intro: 'In klaren Stufen über die Bauphasen verteilt — transparent und nachvollziehbar.',
    phase1: { label: 'Start', title: 'Reservierung & Vertrag', rows: p1rows },
    phase2: { label: 'Bauphase & Übergabe', title: 'Raten nach Baufortschritt', rows: p2rows },
    note: hasBasis
      ? 'Reservierung und die erste Rate bei Vertragsunterzeichnung sind sofort fällig; weitere Raten folgen mit dem Baufortschritt. Die Reservierung wird auf die erste Rate angerechnet. Hauptbeträge brutto (inkl. MwSt); der jeweilige Nettobetrag ist zusätzlich ausgewiesen.'
      : 'Der Reservierungsbetrag wird bei Vertragsunterzeichnung angerechnet. Prozentsätze bezogen auf den Kaufpreis; finale Beträge gemäß Bauträger-Konditionen.',
  }
  return block   // priceSummary (Netto/MwSt/Brutto-Box) setzt der bestehende Injektionsschritt weiter unten je Wohnung
}

// Zahlungsplan deterministisch sicherstellen: Hat die KI KEINEN payment-Block gebaut
// (z.B. Projekt-Deck ohne Wohnungspreis, dessen Fakten keinen Plan enthalten), setze
// den hinterlegten/Standard-Zahlungsplan direkt vor den cta ein. Bestehende, aus echten
// Preisangaben gebaute payment-Blöcke bleiben unangetastet (kein Override).
// replace=true: einen bestehenden (vagen) KI-payment-Block durch den konkreten
// Standard-Plan ersetzen — für Projekt-Decks OHNE Wohnungspreis, wo die KI mangels
// Zahlen nur „gemäß Konditionen" schreibt. replace=false: nur einsetzen, wenn keiner
// da ist (Unit-Decks mit echten Beträgen behalten ihren KI-Block).
function injectPayment(blocks: Array<Record<string, unknown>>, sched: PaySchedule | null | undefined, replace: boolean, basis?: { net: number; gross: number } | null): void {
  if (!sched || !Array.isArray(sched.stages) || sched.stages.length === 0) return
  const existingIdx = blocks.findIndex(b => b.type === 'payment')
  if (existingIdx >= 0 && !replace) return
  // vorhandene payment-Blöcke entfernen (bei replace), Einfügeposition bestimmen
  let at = -1
  if (existingIdx >= 0) {
    at = existingIdx
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].type === 'payment') { blocks.splice(i, 1); if (i < at) at-- }
  } else {
    const ctaIdx = blocks.findIndex(b => b.type === 'cta')
    at = ctaIdx >= 0 ? ctaIdx : blocks.length
  }
  blocks.splice(at, 0, buildPaymentBlock(sched, basis))
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

// Passt ein Grundriss-Label zur Wohnungsart? "Maisonette A2b" gehoert nie in ein
// Villa-Deck, "Villa 3" nie in ein Apartment-Deck.
const APARTMENT_WORT = /maisonette|apartment|wohnung|studio|block\s*[a-z]\b|penthouse/i
const VILLA_WORT = /villa|haus|house|bungalow/i
function passtZuTyp(label: string, typ: string): boolean {
  if (!label) return true
  if (typ === 'villa') return !APARTMENT_WORT.test(label) || VILLA_WORT.test(label)
  return !VILLA_WORT.test(label) || APARTMENT_WORT.test(label)
}

function assignImages(blocks: Array<Record<string, unknown>>, images?: DeckImages, projName?: string, unitTyp?: string): void {
  const renders = images?.renders ?? []
  const gal = images?.gallery ?? []
  let ri = 0, pi = 0, fpi = 0
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
    // Mehrere Grundrisse (eine pro Wohnung) der Reihe nach auf die floorplan-Blöcke verteilen.
    // Grundriss: NIEMALS auf ein beliebiges Render ausweichen. Fehlt der Plan, bleibt
    // das Bild leer — ein Café-/Sauna-Foto unter der Überschrift „Grundriss" ist
    // schlimmer als gar keins (genau so kam Jessicas Café-Bild ins Deck).
    // Grundriss: NIE einer aus einer anderen Wohnungsart. Das Villa-Deck fuer
    // Agustin zeigte den Plan einer "Maisonette A2b" - ein Doppelapartment aus
    // Block A (Sven 27.8.). Passt kein Plan zum Typ, bleibt der Block ohne Bild.
    if (t === 'floorplan') {
      const fps = images?.floorplans ?? []
      const passend = unitTyp
        ? fps.filter(f => passtZuTyp(typeof f === 'string' ? '' : String((f as { label?: string }).label ?? ''), unitTyp))
        : fps
      const quelle = passend.length ? passend : (unitTyp && fps.length ? [] : fps)
      const fp = quelle.length ? quelle[fpi++ % quelle.length] : (unitTyp ? null : images?.floorplan)
      const url = typeof fp === 'string' ? fp : (fp as { url?: string } | null)?.url
      if (url) b.image = url; else delete b.image
    }
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
    const vatRate   = isEigennutz ? 0.05 : 0.19
    const vatPct    = isEigennutz ? '5 %' : '19 %'
    // Eigennutz rechnet NACH GESETZ (Sven 26.8.): 5 % nur auf den Wohnflaechen-Anteil
    // bis 130 m², darueber 19 % - proportional am Nettopreis (beguenstigt = netto x
    // MIN(130/Flaeche, 1); ohne gepflegte Wohnflaeche gilt alles als beguenstigt).
    // Die Einrichtung ist bewegliches Inventar und traegt IMMER 19 %.
    // Gleiche Mathematik wie vatSplit in src/lib/rechner.ts (Rendite-Rechner).
    // Grenzen der aktuellen Regelung (seit 16.6.2023): 5 % nur auf die ersten
    // 130 m² UND die ersten 350.000 EUR; Voraussetzung Wohnflaeche <= 190 m² und
    // Kaufpreis <= 475.000 EUR. Wird eine Voraussetzung gerissen, gilt fuer die
    // GESAMTE Immobilie 19 % (Infinity 203: 499.000 > 475.000 -> voll 19 %).
    // Gleiche Mathematik wie vatSplit in src/lib/rechner.ts.
    const VAT_CAP_SQM = 130, VAT_CAP_WERT = 350000, VAT_MAX_SQM = 190, VAT_MAX_WERT = 475000
    const vatSplitDeck = (net: number, sqm: number | null | undefined) => {
      if (net > VAT_MAX_WERT || (sqm && sqm > VAT_MAX_SQM)) {
        const vatStandard = Math.round(net * 0.19)
        return { netReduced: 0, netStandard: net, vatReduced: 0, vatStandard, vat: vatStandard,
                 entfallen: net > VAT_MAX_WERT ? 'wert' : 'flaeche' }
      }
      const share = (sqm && sqm > 0) ? Math.min(VAT_CAP_SQM / sqm, 1) : 1
      const netReduced = Math.min(Math.round(net * share), VAT_CAP_WERT)
      const netStandard = net - netReduced
      const vatReduced = Math.round(netReduced * 0.05)
      const vatStandard = Math.round(netStandard * 0.19)
      return { netReduced, netStandard, vatReduced, vatStandard, vat: vatReduced + vatStandard, entfallen: null as string | null }
    }
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
    // Traegt der Kaufpreis die Einrichtung? Steuert den Moebel-Backstop im Scrubber.
    // Default true = nicht filtern, solange nichts Gegenteiliges bekannt ist; der
    // Preisblock unten setzt den echten Wert aus den Projekt-Stammdaten.
    let furnStatusIncluded = true
    // Die echten Wohnungsnummern dieses Decks (aus body.units/unit_id).
    const unitNummern: string[] = (body.units ?? []).map(u => String(u.unit_number ?? '').trim()).filter(Boolean)
    let furnModus: 'none' | 'included' | 'optional' = body.furniture_mode ?? 'optional'
    // Rohe Preisbasis (netto/brutto) EINER Einzelwohnung — für die absoluten Beträge je
    // Zahlungsplan-Stufe. Nur gesetzt, wenn genau eine Wohnung mit Preis vorliegt.
    let payBasis: { net: number; gross: number } | null = null
    // GRUNDRISS-STANDARD (Sven): hinterlegte HP-Grundrisse je Wohnung — wenn einer
    // existiert, kommt er ins Deck. Quelle: crm_projects.deck_assets.floorplans
    // (Map Wohnungsnummer → Bild-URL, Fallback-Key "<n>br" je Zimmertyp).
    const floorplanByUnit: Record<string, string> = {}
    // Wohnungen im Deck, fuer die NIRGENDS ein HP-Grundriss hinterlegt ist — wird
    // in der Antwort gemeldet (Grundriss-Garantie: Luecken sichtbar machen).
    let missingFloorplans: string[] = []
    // Anzeige-Wohnungsnummer je normalisiertem Schlüssel — für die Beschriftung der
    // Grundriss-Blöcke, wenn ein Deck MEHRERE Wohnungen enthält.
    const floorplanLabel: Record<string, string> = {}
    let extraFacts = ''
    if (body.project_id) {
      try {
        let unitList: Array<{ unit_number: string; price_net: number; bedrooms: number | null; size_sqm: number | null }> = []
        // Alle Wohnungen des Projekts (Zimmerzahl + Wohnflaeche je Wohnung) für die
        // Möbel-Kalkulation und die 130-m²-MwSt-Regel als Map bereitstellen.
        const { data: allU } = await sbRules.from('crm_project_units').select('unit_number, bedrooms, size_sqm').eq('project_id', body.project_id)
        const bedByUnit = new Map<string, number | null>()
        const sqmByUnit = new Map<string, number | null>()
        for (const u of (allU ?? []) as Array<{ unit_number?: string; bedrooms?: number | null; size_sqm?: number | null }>) {
          if (u.unit_number) { bedByUnit.set(normU(u.unit_number), u.bedrooms ?? null); sqmByUnit.set(normU(u.unit_number), u.size_sqm ?? null) }
        }
        if (body.units?.length) {
          unitList = body.units.filter(u => u.unit_number).map(u => ({ unit_number: String(u.unit_number), price_net: Number(u.price_net) || 0, bedrooms: bedByUnit.get(normU(u.unit_number)) ?? null, size_sqm: sqmByUnit.get(normU(u.unit_number)) ?? null }))
        } else if (body.unit_id) {
          const { data: u } = await sbRules.from('crm_project_units').select('unit_number, price_net, bedrooms, size_sqm').eq('id', body.unit_id).maybeSingle()
          const uu = u as { unit_number?: string; price_net?: number; bedrooms?: number | null; size_sqm?: number | null } | null
          if (uu?.unit_number) unitList = [{ unit_number: uu.unit_number, price_net: Number(uu.price_net) || 0, bedrooms: uu.bedrooms ?? null, size_sqm: uu.size_sqm ?? null }]
        }
        const { data: p } = await sbRules.from('crm_projects').select('furniture_cost, furniture_included, completion_date, calc_defaults, deck_assets').eq('id', body.project_id).maybeSingle()
        // Hinterlegte Grundrisse je Wohnung einsammeln (Nummer exakt, sonst Zimmertyp "<n>br").
        // Quelle: deck_assets.unit_floorplans (Record) — NICHT deck_assets.floorplans, das ist
        // bei manchen Projekten ein Etagen-Array aus dem Drive-Import.
        const daFp = (p as { deck_assets?: { unit_floorplans?: Record<string, string>; floorplans?: unknown } } | null)?.deck_assets
        const rawFp = daFp?.unit_floorplans ?? ((daFp && !Array.isArray(daFp.floorplans)) ? (daFp.floorplans as Record<string, string> | undefined) : undefined) ?? {}
        // Keys normalisiert (lowercase) indizieren — die Mapping-Keys sind großgeschrieben
        // (z.B. 'C-202'), der Lookup nutzt normU (lowercase). Ohne das griff der Grundriss
        // nicht und der Block behielt ein KI-Bild (z.B. Yoga-Raum statt Grundriss).
        const fpMap: Record<string, string> = {}
        for (const [k, v] of Object.entries(rawFp)) if (typeof v === 'string') fpMap[normU(k)] = v
        for (const u of unitList) {
          const fpUrl = fpMap[normU(u.unit_number)] ?? (u.bedrooms != null ? fpMap[`${u.bedrooms}br`] : undefined)
          if (fpUrl) { floorplanByUnit[normU(u.unit_number)] = fpUrl; floorplanLabel[normU(u.unit_number)] = u.unit_number }
        }
        // GRUNDRISS-GARANTIE: fehlende Plaene laut melden statt still weglassen — der
        // floorplan-Block bliebe sonst ohne Zeichnung und niemand merkt es (Skala 14.8.).
        missingFloorplans = unitList.filter(u => !floorplanByUnit[normU(u.unit_number)]).map(u => u.unit_number)
        if (missingFloorplans.length) console.error(`[generate-deck] KEIN hinterlegter Grundriss fuer Wohnung(en) ${missingFloorplans.join(', ')} (Projekt ${body.project_id}) — deck_assets.unit_floorplans ergaenzen`)
        const furnIncluded = !!(p as { furniture_included?: boolean } | null)?.furniture_included
        const furnDefault = Number((p as { furniture_cost?: number } | null)?.furniture_cost) || 0
        const furnByBed = (p as { calc_defaults?: { furniture_by_bedrooms?: Record<string, number> } } | null)?.calc_defaults?.furniture_by_bedrooms ?? null
        // Möbel-Nettopreis je Wohnung: ZIMMERABHÄNGIG (furniture_by_bedrooms, z.B.
        // 1-SZ 17.000 / 2-SZ 19.000) mit Fallback auf den projektweiten furniture_cost.
        // Der ausdrueckliche Wunsch aus dem Wizard schlaegt die Projekt-Stammdaten.
        const modus: 'none' | 'included' | 'optional' = body.furniture_mode
          ?? (furnIncluded ? 'included' : 'optional')
        const furnFor = (bedrooms: number | null): number => {
          if (modus === 'none' || modus === 'included') return 0
          if (furnIncluded) return 0
          if (furnByBed && bedrooms != null && furnByBed[String(bedrooms)] != null) return Number(furnByBed[String(bedrooms)]) || 0
          return furnDefault
        }
        // Gesamt-MwSt je Wohnung: Investment pauschal 19 %; Eigennutz nach Gesetz
        // (130-m²-Regel auf die Immobilie, Einrichtung immer 19 %).
        const vatFor = (baseNet: number, furnNet: number, sqm: number | null) => {
          if (!isEigennutz) return { vat: Math.round((baseNet + furnNet) * vatRate), mixed: false, split: null as null | ReturnType<typeof vatSplitDeck>, furnVat: 0 }
          const split = vatSplitDeck(baseNet, sqm)
          const furnVat = Math.round(furnNet * 0.19)
          return { vat: split.vat + furnVat, mixed: split.netStandard > 0 || furnVat > 0, split, furnVat }
        }
        // Labels der Preiszeilen: Der Preisblock wird deterministisch gebaut und lief
        // deshalb nie durch die Uebersetzung - er blieb deutsch, waehrend das restliche
        // Deck englisch war (Sven 27.8.).
        const EN = deckLang === 'en'
        const L = {
          nettoImmo: EN ? 'Net price (property)' : 'Nettopreis Immobilie',
          nettoInklMoebel: EN ? 'Net price (incl. furniture)' : 'Nettopreis (inkl. Möbel)',
          netto: EN ? 'Net price' : 'Nettopreis',
          nettoInklEinr: EN ? 'Net price (incl. furnishing)' : 'Nettopreis (inkl. Einrichtung)',
          mwstGesamt: EN ? 'VAT total' : 'MwSt gesamt',
          brutto: EN ? 'Gross price' : 'Bruttopreis',
          einrichtungNetto: EN ? 'Furniture package (net)' : 'Einrichtungspaket (netto)',
          mwstEinr: EN ? 'VAT 19 % on furniture' : 'MwSt 19 % auf Einrichtung',
          einrichtung: EN ? 'Furnishing' : 'Einrichtung',
          imPreis: EN ? 'included in the purchase price' : 'im Kaufpreis enthalten',
          nichtImPreis: EN ? 'not included - price on request' : 'nicht im Kaufpreis - Preis auf Anfrage',
          davonEinr: EN ? 'of which furniture package' : 'davon Einrichtungspaket',
          zzglMwst: (pct: string) => EN ? `plus VAT (${pct})` : `zzgl. MwSt (${pct})`,
        }
        const buildLines = (baseNet: number, furnNet: number, sqm: number | null) => {
          const totalNet = baseNet + furnNet
          const v = vatFor(baseNet, furnNet, sqm)
          const brutto = totalNet + v.vat
          if (isEigennutz && v.split?.entfallen) {
            // Beguenstigung gekippt - eine ehrliche 19 %-Zeile plus Begruendung.
            return [
              { label: furnIncluded ? L.nettoInklMoebel : L.nettoImmo, value: eur(baseNet) },
              { label: v.split.entfallen === 'wert'
                  ? (EN ? `VAT 19 % (purchase price above ${eur(VAT_MAX_WERT)} — reduced rate does not apply)`
                        : `MwSt 19 % (Kaufpreis über ${eur(VAT_MAX_WERT)} — 5 %-Regelung gilt nicht)`)
                  : (EN ? `VAT 19 % (living area above ${VAT_MAX_SQM} m² — reduced rate does not apply)`
                        : `MwSt 19 % (Wohnfläche über ${VAT_MAX_SQM} m² — 5 %-Regelung gilt nicht)`),
                value: eur(v.split.vatStandard) },
              ...(furnNet > 0 ? [{ label: L.einrichtungNetto, value: eur(furnNet) },
                                 { label: 'MwSt 19 % auf Einrichtung', value: eur(v.furnVat) }] : []),
              { label: L.mwstGesamt, value: eur(v.vat) },
              { label: L.brutto, value: eur(totalNet + v.vat), strong: true },
            ]
          }
          if (isEigennutz && v.split) {
            // Aufgeschluesselt (Sven 26.8.): beguenstigter und regulaerer Anteil getrennt.
            const lines: Array<{ label: string; value: string; strong?: boolean }> = [
              { label: modus === 'included' ? L.nettoInklMoebel : L.nettoImmo, value: eur(baseNet) },
              { label: (EN ? `VAT 5 % on ${eur(v.split.netReduced)}` : `MwSt 5 % auf ${eur(v.split.netReduced)}`) + (v.split.netStandard > 0 ? (v.split.netReduced >= VAT_CAP_WERT ? (EN ? ' (cap of the reduced rate)' : ' (Höchstbetrag der 5 %-Regelung)') : (EN ? ` (share up to ${VAT_CAP_SQM} m² living area)` : ` (Anteil bis ${VAT_CAP_SQM} m² Wohnfläche)`)) : ''), value: eur(v.split.vatReduced) },
            ]
            if (v.split.netStandard > 0) {
              // Warum faellt der Rest unter 19 %? Ueber der Flaechengrenze, ueber dem
              // Wertdeckel von 350.000 EUR - oder beides. Das Label muss den echten
              // Grund nennen, sonst steht "über 130 m²" an einer 112-m²-Wohnung.
              const ueberFlaeche = !!(sqm && sqm > VAT_CAP_SQM)
              const ueberWert = v.split.netReduced >= VAT_CAP_WERT
              const grund = ueberFlaeche && ueberWert
                ? (EN ? `above ${VAT_CAP_SQM} m² and above ${eur(VAT_CAP_WERT)}` : `über ${VAT_CAP_SQM} m² und über ${eur(VAT_CAP_WERT)}`)
                : ueberFlaeche ? (EN ? `above ${VAT_CAP_SQM} m² living area` : `über ${VAT_CAP_SQM} m² Wohnfläche`)
                : (EN ? `share above ${eur(VAT_CAP_WERT)} — the reduced rate covers no more than this amount` : `Anteil über ${eur(VAT_CAP_WERT)} — die 5 %-Regelung deckt höchstens diesen Betrag`)
              lines.push({ label: (EN ? `VAT 19 % on ${eur(v.split.netStandard)} (${grund})` : `MwSt 19 % auf ${eur(v.split.netStandard)} (${grund})`), value: eur(v.split.vatStandard) })
            }
            if (furnNet > 0) {
              lines.push({ label: L.einrichtungNetto, value: eur(furnNet) })
              lines.push({ label: L.mwstEinr, value: eur(v.furnVat) })
            } else if (modus === 'included') lines.push({ label: L.einrichtung, value: L.imPreis })
            else if (modus === 'optional') lines.push({ label: EN ? 'Furniture package' : 'Einrichtungspaket', value: L.nichtImPreis })
            lines.push({ label: L.mwstGesamt, value: eur(v.vat) })
            lines.push({ label: L.brutto, value: eur(brutto), strong: true })
            return lines
          }
          const lines: Array<{ label: string; value: string; strong?: boolean }> = [
            { label: furnNet > 0 ? L.nettoInklEinr : (modus === 'included' ? L.nettoInklMoebel : L.netto), value: eur(totalNet) },
            { label: L.zzglMwst(vatPct), value: eur(v.vat) },
            { label: 'Bruttopreis', value: eur(brutto), strong: true },
          ]
          if (furnNet > 0) lines.push({ label: L.davonEinr, value: EN ? `${eur(furnNet)} net · ${eur(furnNet + Math.round(furnNet * 0.19))} gross` : `${eur(furnNet)} netto · ${eur(furnNet + Math.round(furnNet * 0.19))} brutto` })
          else if (modus === 'included') lines.push({ label: L.einrichtung, value: L.imPreis })
          // Schweigen las der Kunde bisher als "ist dabei" - deshalb immer benennen.
          // Bei 'none' bleibt die Zeile weg: das Objekt wird ohne Moebel verkauft.
          else if (modus === 'optional') lines.push({ label: EN ? 'Furniture package' : 'Einrichtungspaket', value: L.nichtImPreis })
          return lines
        }
        const priced = unitList.filter(u => u.price_net > 0)
        for (const u of priced) {
          const furnNet = furnFor(u.bedrooms)
          priceLinesByUnit[normU(u.unit_number)] = buildLines(u.price_net, furnNet, u.size_sqm)
          const totalNet = u.price_net + furnNet
          const v = vatFor(u.price_net, furnNet, u.size_sqm)
          priceSummaryByUnit[normU(u.unit_number)] = { net: eur(totalNet), vatRate: v.mixed ? '5 %/19 %' : vatPct, vat: eur(v.vat), gross: eur(totalNet + v.vat) }
          if (priced.length === 1) payBasis = { net: totalNet, gross: totalNet + v.vat }
        }
        // Bei Eigennutz die 5%-Basis explizit als Fakt mitgeben, damit die KI den GESAMTEN
        // Zahlungsplan (Reservierung/Anzahlung/Raten) + Intro auf 5 % rechnet, nicht 19 %.
        if (priced.length === 1) {
          extraFacts += `\n\n=== WOHNUNGSNUMMER: ${priced[0].unit_number} (HART) ===\nDieses Deck beschreibt AUSSCHLIESSLICH die Wohnung ${priced[0].unit_number}. Nenne in Ueberschriften, Fliesstext und Blocknamen NUR diese Nummer. Erfinde KEINE andere Wohnungsnummer und uebernimm keine Nummer aus Beispielen oder Preislisten-Zeilen anderer Einheiten.`
        }
        // HARTE BINDUNG an die Stammdaten: Ob die Einrichtung im Preis steckt, sagt
        // das CRM-Feld furniture_included - NICHT die Prospekt-Prosa. Vorher schrieb
        // die KI "Einrichtungspaket vollstaendig im Kaufpreis enthalten", obwohl der
        // Preis die Moebel gar nicht enthielt (Sven 26.8., Infinity 203 + Arbeo Park:
        // Preisliste sagt woertlich "Furniture package at 30.000 + 19% VAT").
        {
          const furnBeispiel = priced.length > 0 ? furnFor(priced[0].bedrooms) : furnDefault
          // Dritter Zustand: sind BEIDE Stammdatenfelder ungepflegt, ist der Status
          // schlicht unbekannt - dann darf das Deck in KEINE Richtung behaupten.
          const furnUnbekannt = modus === 'optional' && !furnIncluded && furnBeispiel <= 0 && !furnByBed
          // Nur ein ausdrueckliches "enthalten" erlaubt Moebel-Aussagen im Text.
          furnStatusIncluded = modus === 'included'
          furnModus = modus
          if (modus === 'none') {
            // Sven verkauft dieses Objekt OHNE Moebel - das Deck erwaehnt sie gar nicht.
            extraFacts += `\n\n=== EINRICHTUNG: KOMMT IM DECK NICHT VOR (HART, HOECHSTE PRIORITAET) ===\nDieses Objekt wird OHNE Moebel verkauft. Erwaehne Moebel, Einrichtungspakete, Moebelmarken, Geschirr, Besteck oder Waesche mit KEINEM Wort - kein inventory-Block dazu, keine Aufzaehlung, kein Nebensatz, auch nicht als Option oder Aufpreis. Ignoriere alle Moebel-, Geschirr- und Waescheangaben in den Fakten vollstaendig. Fest verbaute Ausstattung (Kueche, Einbauschraenke, Sanitaer, Klimatisierung, Boeden, Fenster) darfst und sollst du beschreiben, wenn die Fakten sie belegen - das ist keine Moeblierung.`
          } else extraFacts += furnUnbekannt
            ? `\n\n=== EINRICHTUNG: UNBEKANNT (HART) ===\nOb Moebel im Kaufpreis enthalten sind, ist in den Stammdaten NICHT gepflegt. Triff dazu KEINE Aussage - weder enthalten noch Aufpreis. Verboten sind "schluesselfertig", "moebliert", "komplett eingerichtet", "bezugsfertig" und jede sinngemaesse Formulierung. Fest verbaute Ausstattung (Kueche, Schraenke, Sanitaer, Klima) darfst du beschreiben, wenn die Fakten sie belegen.`
            : furnIncluded
            ? `\n\n=== EINRICHTUNG: IM KAUFPREIS ENTHALTEN (HART) ===\nDie Einrichtung ist laut Stammdaten Teil des Kaufpreises. So darfst du es schreiben.`
            : `\n\n=== EINRICHTUNG: NICHT IM KAUFPREIS (HART, HOECHSTE PRIORITAET) ===\nDie Moebel/das Einrichtungspaket sind NICHT im genannten Kaufpreis enthalten, sondern kosten${furnBeispiel > 0 ? ` ${eur(furnBeispiel)} netto` : ''} EXTRA (plus 19 % MwSt). STRIKT VERBOTEN sind daher: "schluesselfertig moebliert", "voll moebliert", "komplett eingerichtet", "Einrichtung im Kaufpreis enthalten", "im Preis inklusive", "du packst nur die Koffer" oder jede sinngemaesse Formulierung, die den Eindruck erweckt, Moebel seien im Preis. Beschreibe das Einrichtungspaket ausschliesslich als OPTIONAL und KOSTENPFLICHTIG. Fest verbaute Ausstattung (Kueche, Einbauschraenke, Sanitaer, Klimatisierung) darfst du als enthalten beschreiben, wenn die Fakten das hergeben - Moebel niemals. Diese Regel schlaegt jede anderslautende Formulierung in den Projekt-Fakten.`
        }
        if (isEigennutz && priced.length > 0) {
          const bruttoJeUnit = priced.map(u => {
            const furnNet = furnFor(u.bedrooms)
            const v = vatFor(u.price_net, furnNet, u.size_sqm)
            return `Wohnung ${u.unit_number}: Bruttopreis ${eur(u.price_net + furnNet + v.vat)}`
          }).join(' · ')
          extraFacts += `\n\n=== MWST-BASIS EIGENNUTZ (GESETZLICHE REGELUNG) — HART ===\nDie MwSt ist bereits EXAKT berechnet: 5 % auf den Wohnflaechen-Anteil bis 130 m², 19 % auf den Anteil darueber, 19 % auf die Einrichtung. NICHT selbst rechnen. Der gesamte Zahlungsplan (Reservierung, Anzahlung, alle Raten, Summen) rechnet auf diesen Bruttopreisen: ${bruttoJeUnit}. Im 'payment'-Block als note der Hinweis: Der reduzierte MwSt-Satz von 5 % setzt einen nachgewiesenen Eigennutz/Erstwohnsitz in Zypern voraus und gilt bis 130 m² Wohnflaeche (Steuerberater-Vorbehalt).`
        }
        if (priced.length === 1) {
          extraFacts += `\n\n=== VERBINDLICHE PREISANGABEN (im 'unit'-Block GENAU so darstellen, NICHT selbst rechnen, NICHT woanders wiederholen) ===\n${priceLinesByUnit[normU(priced[0].unit_number)].map(l => `${l.label}: ${l.value}`).join('\n')}`
        } else if (priced.length > 1) {
          const parts = priced.map(u => `WOHNUNG ${u.unit_number}:\n${priceLinesByUnit[normU(u.unit_number)].map(l => `  ${l.label}: ${l.value}`).join('\n')}`)
          extraFacts += `\n\n=== VERBINDLICHE PREISANGABEN JE WOHNUNG (für JEDE Wohnung EINEN eigenen 'unit'-Block mit number=Wohnungsnummer und GENAU diesen Werten als priceLines; NICHT selbst rechnen, NICHT woanders wiederholen) ===\n${parts.join('\n\n')}`
        }
        const cd = (p as { completion_date?: string } | null)?.completion_date
        if (cd) { const d = new Date(cd); extraFacts += `\n\n=== FERTIGSTELLUNG (muss im Deck genannt werden): ${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ===` }
        // Möbelpakete bei Projekt-Decks OHNE Wohnungspreis (keine priced units) trotzdem
        // sichtbar machen: als Fakt fürs inventory-Block, da sie sonst nur an Unit-Preisen
        // hängen und komplett wegfallen. Nettopreise je Zimmertyp aus furniture_by_bedrooms.
        if (priced.length === 0 && furnByBed && Object.keys(furnByBed).length > 0) {
          const lines = Object.entries(furnByBed)
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([bed, net]) => `- ${bed}-Schlafzimmer: ${eur(Number(net))} netto`)
            .join('\n')
          extraFacts += `\n\n=== MÖBELPAKETE (Vollausstattung, als 'inventory'-Block oder Fakt nennen; Nettopreise je Wohnungstyp) ===\n${lines}`
        }
      } catch { /* best effort — ohne Preisangaben generiert die KI wie bisher */ }
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
    // Wahrheits-Backstop: erfundene Zahlungs-/Garantie-/Auslastungs-Saetze raus - und
    // Moebel-Behauptungen, sobald die Stammdaten die Einrichtung NICHT als enthalten
    // ausweisen (furnStatusIncluded wird beim Preisaufbau gesetzt).
    // Die Wohnungsnummer darf die KI NICHT erfinden. Sie schrieb "Apartment 303",
    // obwohl 203 angefragt war - beide Nummern stehen nirgends in den Fakten
    // (Sven 26.8.). Deshalb deterministisch: unit-Bloecke bekommen die echte
    // Nummer, und falsche Nummern werden im gesamten Text ersetzt.
    if (unitNummern.length === 1) {
      const echt = unitNummern[0]
      const falsch = new Set<string>()
      for (const b of blocks) {
        if (b.type === 'unit' && typeof b.number === 'string' && b.number.trim() !== echt) {
          falsch.add(b.number.trim()); b.number = echt
        }
      }
      // Jede im Text genannte Wohnungsnummer, die nicht die echte ist, korrigieren.
      const roh = JSON.stringify(blocks)
      for (const m of roh.matchAll(/(?:Apartment|Wohnung|Einheit|Apt\.?)\s+([A-Za-z]?-?\d{1,4}[a-zA-Z]?)/g)) {
        if (m[1] !== echt) falsch.add(m[1])
      }
      if (falsch.size) {
        let txt = roh
        for (const f of falsch) {
          txt = txt.replace(new RegExp(`((?:Apartment|Wohnung|Einheit|Apt\\.?)\\s+)${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), `$1${echt}`)
        }
        blocks = JSON.parse(txt) as Array<Record<string, unknown>>
        console.warn(`[generate-deck] falsche Wohnungsnummer(n) korrigiert: ${[...falsch].join(', ')} → ${echt}`)
      }
    }

    // Karte deterministisch erzwingen: Liegen Kartendaten vor, MUSS ein map-Block
    // ins Deck - die KI liess ihn wiederholt weg (Sven 26.8.: "Google Maps nicht
    // drin, das hatte ich auch schon geschrieben").
    const projLocation = (projRow?.location ?? '').trim()
    if ((body.images?.map || body.images?.mapLat || body.images?.mapQuery || projLocation) && !blocks.some(b => b.type === 'map')) {
      const nachFacts = blocks.findIndex(b => b.type === 'facts')
      const pos = nachFacts >= 0 ? nachFacts + 1 : Math.min(6, blocks.length)
      const mapBlock: Record<string, unknown> = {
        type: 'map', kicker: 'Lage',
        headline: projName ? `${projName} auf der Karte` : 'Die Lage auf der Karte',
      }
      // Bild/Link direkt setzen - die Bildzuweisung oben lief bereits durch, ein
      // nachtraeglich eingefuegter Block bliebe sonst leer.
      if (body.images?.mapLat && body.images?.mapLng) {
        mapBlock.mapLat = body.images.mapLat; mapBlock.mapLng = body.images.mapLng
        if (body.images.mapQuery) mapBlock.mapQuery = body.images.mapQuery
      } else if (body.images?.map) {
        mapBlock.image = body.images.map
        if (body.images.mapMarker) mapBlock.mapMarker = body.images.mapMarker
      } else if (body.images?.mapQuery || projLocation) {
        // Kein Kartenbild im Drive: aus der gepflegten Ortsangabe eine echte
        // eingebettete Karte bauen, statt einen leeren Block zu zeigen.
        mapBlock.mapQuery = body.images?.mapQuery || `${projName ? projName + ', ' : ''}${projLocation}`
      }
      if (projName) mapBlock.mapLabel = projName
      if (body.images?.mapUrl) mapBlock.mapUrl = body.images.mapUrl
      blocks.splice(pos, 0, mapBlock)
      console.log('[generate-deck] map-Block ergänzt (KI hatte ihn weggelassen)')
    }

    scrubNarrative(blocks, furnStatusIncluded)
    if (furnModus === 'none') {
      const vorher = blocks.length
      blocks = dropFurnitureBlocks(blocks)
      stripFurnitureWords(blocks)
      if (blocks.length !== vorher) console.log(`[generate-deck] ohne Möbel: ${vorher - blocks.length} Möbel-Block/Blöcke entfernt`)
    }
    // Deck-Standard: Entfernungs-Chips (facts) + Marina-Sektion — deterministisch,
    // damit JEDES Deck sie hat, unabhängig davon was die KI liefert.
    injectLocationAndMarina(blocks, projRow?.name || projName, projRow, deckLang)
    // Projekt-Video (falls hinterlegt) nach der Lage-Sektion einsetzen.
    injectVideo(blocks, projRow?.video_url)
    // Zahlungsplan sicherstellen: eigener payment_schedule des Projekts, sonst — bei
    // Bauträger Luma — der Luma-Standard. Greift nur, wenn die KI keinen gebaut hat.
    const isLuma = /luma/i.test(String(projRow?.developer ?? ''))
    const paySchedule = (projRow?.payment_schedule && Array.isArray(projRow.payment_schedule.stages) && projRow.payment_schedule.stages.length)
      ? projRow.payment_schedule
      : (isLuma ? LUMA_PAYMENT : null)
    // Zahlungsplan: Liegt ein Plan vor (projekteigener oder Luma-Standard), IMMER den
    // konkreten Stufen-Plan setzen und einen vagen KI-Block ersetzen — die KI baut mangels
    // Stufen in den Fakten sonst nur „gemäß Konditionen", auch bei Decks MIT Preis.
    injectPayment(blocks, paySchedule, true, payBasis)
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
      let fpBlocks = blocks.filter(b => b.type === 'floorplan')
      // JE WOHNUNG EIN GRUNDRISS-BLOCK. Die KI legt oft nur EINEN an, auch wenn das
      // Deck zwei Wohnungen enthält — dann fiel die zweite bisher stillschweigend
      // raus (Jessicas C-104 zeigte den Grundriss von B-202). Fehlende Blöcke daher
      // ergänzen: den vorhandenen klonen, aber Zahlen/Aufzählung des Prototyps
      // entfernen — die gehören zur anderen Wohnung und wären sonst schlicht falsch.
      if (fpBlocks.length && fpBlocks.length < fpKeys.length) {
        const proto = fpBlocks[fpBlocks.length - 1]
        const at = blocks.indexOf(proto)
        const extra = Array.from({ length: fpKeys.length - fpBlocks.length }, () => {
          const clone = JSON.parse(JSON.stringify(proto)) as Record<string, unknown>
          delete clone.stats; delete clone.bullets; delete clone.rooms; delete clone.planNote
          return clone
        })
        blocks.splice(at + 1, 0, ...extra)
        fpBlocks = blocks.filter(b => b.type === 'floorplan')
      }
      fpBlocks.forEach((fb, i) => {
        const key = fpKeys.length === 1 ? fpKeys[0] : fpKeys[Math.min(i, fpKeys.length - 1)]
        const url = floorplanByUnit[key]
        if (url) { fb.image = url; delete fb.rooms }
        // Bei mehreren Wohnungen jeden Block klar der seinen zuordnen — sonst weiß
        // der Kunde nicht, welcher Plan zu welcher Wohnung gehört.
        const label = floorplanLabel[key]
        if (label && fpKeys.length > 1) {
          fb.kicker = `Grundriss & Flächen · ${label}`
          if (i > 0 || !fb.headline) fb.headline = `${label} — Grundriss`
        }
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

    // Grundriss-Block ohne Bild komplett entfernen: passt kein Plan zur Wohnungsart
    // (Mamba hat nur Maisonette-Plaene, The Cove gar keine), bleibt sonst ein leerer
    // Kasten mit Ueberschrift stehen (Sven 27.8.).
    {
      const vorher = blocks.length
      blocks = blocks.filter(b => b.type !== 'floorplan' || b.image)
      if (blocks.length !== vorher) console.log('[generate-deck] leeren Grundriss-Block entfernt (kein passender Plan)')
    }

    // ── Auffang fuer deterministische deutsche Texte ────────────────────────
    // Bild-Beschriftungen kommen als deutsche Vision-Labels aus der Datenbank und
    // laufen nie durch die KI - im englischen Deck standen sie deutsch unter den
    // Fotos (Sven 27.8.). Hier werden sie zusammen uebersetzt: ein Aufruf, alle
    // Labels, Reihenfolge bleibt erhalten.
    if (deckLang === 'en') {
      const felder: Array<{ obj: Record<string, unknown>; key: string }> = []
      const deutsch = (v: unknown) => typeof v === 'string' && v.trim() && /[äöüßÄÖÜ]|\b(mit|und|der|die|das|im|Blick|Ansicht|Aussen|Innen|raumhoh\w*|bodentief\w*|schluesselfertig|Fussboden\w*|Wohnzimmer|Schlafzimmer|Kueche|Terrasse|Grundstueck|Bautraeger|Uebergabe|Wertsteigerung|Zahlungsplan)\b/i.test(v)
      for (const b of blocks) {
        for (const k of ['headline', 'kicker', 'title', 'note', 'caption', 'text', 'intro', 'tagline', 'quote', 'nickname', 'linkLabel', 'sumLabel', 'advantage']) {
          if (deutsch(b[k])) felder.push({ obj: b, key: k })
        }
        if (Array.isArray(b.paragraphs)) {
          (b.paragraphs as unknown[]).forEach((v, i) => {
            if (deutsch(v)) felder.push({ obj: b.paragraphs as unknown as Record<string, unknown>, key: String(i) })
          })
        }
        for (const phKey of ['phase1', 'phase2']) {
          const ph = b[phKey] as Record<string, unknown> | undefined
          if (ph && typeof ph === 'object') {
            for (const k of ['title', 'label', 'advantage', 'sumLabel']) if (deutsch(ph[k])) felder.push({ obj: ph, key: k })
            if (Array.isArray(ph.rows)) for (const r of ph.rows as Array<Record<string, unknown>>) {
              for (const k of ['label', 'sub']) if (deutsch(r[k])) felder.push({ obj: r, key: k })
            }
          }
        }
        for (const arrKey of ['items', 'cards', 'cols', 'groups']) {
          if (!Array.isArray(b[arrKey])) continue
          for (const it of b[arrKey] as Array<Record<string, unknown>>) {
            if (!it || typeof it !== 'object') continue
            for (const k of ['title', 'label', 'caption', 'text', 'strong', 'sub', 'value']) if (deutsch(it[k])) felder.push({ obj: it, key: k })
          }
        }
      }
      if (felder.length) {
        try {
          const roh = felder.map(f => String(f.obj[f.key]))
          const tr = await translateOutbound({ subject: null, body: JSON.stringify(roh), whatsapp: null }, 'en')
          const neu = JSON.parse(tr.body ?? '[]') as string[]
          if (Array.isArray(neu) && neu.length === felder.length) {
            felder.forEach((f, i) => { if (typeof neu[i] === 'string' && neu[i].trim()) f.obj[f.key] = neu[i] })
            console.log(`[generate-deck] ${felder.length} feste Beschriftungen ins Englische übersetzt`)
          } else console.warn('[generate-deck] Label-Übersetzung verworfen: Anzahl passt nicht')
        } catch (err) {
          console.warn('[generate-deck] Label-Übersetzung fehlgeschlagen:', err instanceof Error ? err.message : String(err))
        }
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
    return json({ ok: true, token: out.token, url: `/deck/${out.token}`, blocks: out.blocks,
      ...(missingFloorplans.length ? { missing_floorplans: missingFloorplans } : {}) })

  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
