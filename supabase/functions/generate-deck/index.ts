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
- unit:     { type, kicker, number, nickname, specs:[string], priceMain, priceSub, note }
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
1. Beginne IMMER mit "cover", dann "letter". Ende IMMER mit "cta".
2. Das "letter"-Anschreiben nimmt das Kunden-Briefing direkt auf (Situation, Motiv, Wünsche) — persönlich, als käme es von Sven. signoff "Bis bald, Sven", signName "Sven · Happy Property Cyprus".
3. Webe das Briefing auch in andere Blöcke ein, WO es inhaltlich passt (z.B. Investor → betone Vermietung/ROI/Zahlungsplan; will selbst herziehen → Lifestyle/„ein Tag"/Terrassen; Sonnenuntergang → West-Terrasse/Feature). Nicht erzwingen.
4. Wähle 10–14 Blöcke passend zum Winkel (angle): "lifestyle" = Erlebnis/Terrassen/„ein Tag"/Pool; "investment" = ROI/Vermietung/Zahlungsplan/Wertsteigerung. Mische sinnvoll. PFLICHT: Ein "payment"-Block (Zahlungsplan) MUSS dabei sein, sobald im Input Zahlungsplan-Daten stehen — bei JEDEM Deck. Ein "facts"-Block für die Lage gehört ebenfalls immer dazu. Ein "floorplan"-Block, wenn Grundriss-/Flächendaten vorliegen.
4b. AUSSTATTUNG: Sobald im Input ein Einrichtungspaket / Ausstattung / Möbelliste / Geschirr / Besteck (cutlery) / Wäsche (linen) steht, MUSST du das prominent zeigen — als ein bis zwei "inventory"-Blöcke (ein bis zwei Seiten). Empfehlung: Block 1 = Möbel, Geräte & Premium-Marken (gruppiert, z.B. Wohnen, Küche & Geräte, Schlafen, Bad — mit den echten Markennamen aus den Fakten wie BOSCH, Neff, GROHE, LAUFEN, Samsung, Tomasella, DUPEN); Block 2 = die Komplett-Checkliste (Geschirr & Besteck mit Stückzahlen, Wäsche & Bettwäsche). Botschaft durchgängig: schlüsselfertig & voll möbliert, sofort bezugs- und vermietfertig — der Kunde packt nur die Koffer. Nutze NUR die im Input gelisteten Gegenstände/Marken, erfinde nichts dazu.
4c. ZAHLUNGSPLAN (payment) — HART: Alle Beträge und Prozente kommen AUSSCHLIESSLICH aus den Zahlungsplan-Daten der Fakten UND dem Kaufpreis GENAU DIESER Wohnung. Prozente müssen rechnerisch zum Kaufpreis passen (z.B. 30 % von 430.000 € = 129.000 €, NICHT 300.000 €). Übernimm NIEMALS Zahlen aus dem Kunden-Briefing/Anschreiben (z.B. „300k Eigenkapital") in den Zahlungsplan — das Briefing beschreibt den Kunden, nicht den Preis dieses Objekts. Liegen keine echten Raten/Prozente in den Fakten vor: nutze nur die Prozentstufen und schreibe als value „gemäß Bauträger-Konditionen" statt einen Betrag zu erfinden. Plausibilität prüfen: kein einzelner Schritt darf größer als der Kaufpreis sein, Summe der Schritte = 100 % des Preises.
5. Nutze NUR Fakten aus dem Input. Erfinde KEINE Zahlen/Preise/Entfernungen. Wenn ein Faktum fehlt, lass den Block/das Feld weg statt zu raten. Zahlen aus dem Kunden-Briefing sind KEINE Objekt-Fakten — niemals als Preis/Fläche/Rate eines Objekts verwenden.
5b. WAHRHEIT vor Verkauf: Werte Begriffe NICHT auf und kombiniere keine zwei Fakten zu einer stärkeren Aussage. VERBOTEN: aus '5 Jahre Garantie' wird 'Mietgarantie'/'Rendite-Garantie'; aus 'Hotelkonzept' wird 'garantierte Miete'/'gesicherte Auslastung'/'garantierte Rendite'. Ein Hotelkonzept ist eine Vermietungs-OPTION, keine Zusicherung. Garantien/Renditen/Auslastungen nur nennen, wenn sie WÖRTLICH in den Fakten stehen. Im Zweifel weglassen.
6. Preise/Beträge exakt aus den Fakten übernehmen (Format wie gegeben).
7. KRITISCH für gültiges JSON: Verwende in ALLEN Texten (Titel, Taglines, Absätze, überall) NIEMALS doppelte Anführungszeichen — weder gerade noch typografische deutsche. Für Spitznamen/Hervorhebungen nutze EINFACHE Anführungszeichen 'so' oder gar keine. Beispiel: Apartment 303 'Dior' (nicht mit doppelten Zeichen). Übergib blocks als echtes JSON-Array.`

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Echte Drive-Bilder (oder Platzhalter) in die Bild-Slots hängen.
type DeckImages = { renders?: string[]; floorplan?: string; map?: string; mapUrl?: string; gallery?: Array<{ url: string; category: string; label: string }> }
function assignImages(blocks: Array<Record<string, unknown>>, images?: DeckImages, projName?: string): void {
  const renders = images?.renders ?? []
  let ri = 0, pi = 0
  const nextRender = () => renders.length ? renders[ri++ % renders.length] : `https://picsum.photos/seed/deck${++pi}/1600/1000`
  for (const b of blocks) {
    const t = b.type
    if (t === 'cover' || t === 'unit' || t === 'columns' || t === 'feature') b.image = nextRender()
    if (t === 'facts') {
      // Nur eine ECHTE Karte bekommt den orangen Standort-Kreis + Objektnamen; ohne Karte
      // ein neutrales Bild (kein Kreis auf einem zufälligen Foto).
      if (images?.map) { b.image = images.map; if (projName) b.mapLabel = projName }
      else b.image = nextRender()
      if (images?.mapUrl) b.mapUrl = images.mapUrl   // Kartenausschnitt verlinkt auf Google Maps
    }
    if (t === 'floorplan') b.image = images?.floorplan ?? nextRender()
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
      images?: { renders?: string[]; floorplan?: string; map?: string; mapUrl?: string; gallery?: Array<{ url: string; category: string; label: string }> }
      lead_id?: string; deal_id?: string; project_id?: string; unit_id?: string; batch_id?: string; created_by?: string
      generic?: boolean
      background?: boolean
    }
    const generic   = body.generic === true
    const recipient = generic ? '' : (body.recipient_name?.trim() || 'den Kunden')
    const angle     = body.angle || 'lifestyle'
    if (!body.facts?.trim()) return json({ error: 'facts fehlt' }, 400)

    // Gelernte Vorgaben (deck_ai_rules, kind='deck') → fließen in JEDES Deck ein (Auto-Grab +
    // Feinschliff). Global (project_id null) immer; projektspezifische nur für DIESES Projekt.
    const sbRules = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    let rulesQ = sbRules.from('deck_ai_rules').select('rule').eq('active', true).eq('kind', 'deck')
    rulesQ = body.project_id ? rulesQ.or(`project_id.is.null,project_id.eq.${body.project_id}`) : rulesQ.is('project_id', null)
    const { data: aiRules } = await rulesQ
    const learnedTxt = (aiRules ?? []).map((r: { rule: string }) => `- ${r.rule}`).join('\n')
    const learnedBlock = learnedTxt ? `GELERNTE VORGABEN (immer beachten):\n${learnedTxt}\n\n` : ''

    const userMsg = learnedBlock + (generic ? [
      `GENERISCHES PROJEKT-DECK — KEIN spezifischer Kunde. Dieses Deck wird live im Zoom geteilt.`,
      `MONAT: ${body.month_label || ''}`,
      ``,
      `AUFGABE: Stelle DAS PROJEKT vor — Lage, Architektur, Ausstattung, Amenities, die verfügbaren Wohnungs-Typen und den Zahlungsplan. Einladend, hochwertig, du-Form.`,
      `SONDERREGELN FÜR DIESES DECK: KEIN persönliches Anschreiben und KEINE 'Für <Name>'-Zeile (forLine im cover weglassen). Statt eines 'letter' an eine Person ein einladender Projekt-Intro in du-Form (headline + 2–3 Absätze, ohne Namensanrede, signName nur 'Sven · Happy Property Cyprus'). Kein erfundener Kundenbezug.`,
      ``,
      `FAKTEN ZUM PROJEKT (nur diese verwenden):`,
      body.facts.trim(),
    ].join('\n') : [
      `KUNDE: ${recipient}`,
      `MONAT: ${body.month_label || ''}`,
      `WINKEL (angle): ${angle}`,
      ``,
      `KUNDEN-BRIEFING (für Anschreiben + passende Stellen einweben):`,
      body.briefing?.trim() || '(kein Briefing — halte das Anschreiben allgemein, aber persönlich)',
      ``,
      `FAKTEN ZUM PROJEKT & APARTMENT (nur diese verwenden):`,
      body.facts.trim(),
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
    assignImages(blocks, body.images, projName)

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
