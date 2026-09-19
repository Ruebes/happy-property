// Qualitaets-Nachlauf eines Decks - EIN Pfad fuer Erstgenerierung UND Feinschliff.
//
// Bis 19.9.26 lebten Bild-Audit, Behauptungspruefung und die englische
// Nachuebersetzung nur in generate-deck. refine-deck lief danach nur noch durch
// applyDeterministic + Gate: ein Feinschliff konnte ein fremdes Bild, einen
// unbelegten Satz oder deutsche Reste im englischen Deck einschleusen, ohne dass
// es jemand sah. Ab jetzt rufen beide Functions dieselben Funktionen auf.
//
// ACHTUNG (CLAUDE.md Regel 8): Aenderung wirkt erst nach Redeploy jeder
// importierenden Function (generate-deck, refine-deck).

import { callAnthropic, toolInput } from './anthropic.ts'
import { translateOutbound } from './translate.ts'
import { MARINA_MODEL, type DeckContext } from './deckContext.ts'
import { bilderImDeck, checkImageTypes, passtZuTyp, type Finding } from './deckGate.ts'
export { bilderImDeck, checkImageTypes }

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

export type { GalleryImage } from './deckGate.ts'
import type { GalleryImage } from './deckGate.ts'
export type Block = Record<string, unknown>

/** Bloecke, die das System deterministisch einsetzt - ihre Zahlen und Bilder
 *  kommen aus dem CRM/deck_assets, nicht von der KI. Sie werden weder auf
 *  Behauptungen noch auf Bild-Text-Passung geprueft. */
export const SYSTEM_BLOCKS = new Set(['payment', 'amenity', 'masterplan', 'gallery', 'marina', 'video'])

// ── Bild-Text-Endkontrolle (Vision) ──────────────────────────────────────────
const AUDIT_CATS = ['fassade', 'aussenbereich', 'aussicht', 'pool', 'wohnzimmer', 'esszimmer', 'kueche', 'schlafzimmer', 'badezimmer', 'gym', 'lobby']

export interface AuditResult { findings: Finding[]; swapped: number }

/** Prueft je unit/feature/columns/cover-Block, ob das Bild zum Text passt.
 *  Unpassende Bilder werden NUR gegen ein Galeriebild getauscht, das zum
 *  Wohnungstyp des Decks passt und noch unbenutzt ist. Gibt es keins, bleibt
 *  das Bild leer und der Befund steht im Bericht. Jeder Tausch ist ein Befund
 *  (niedrig), jeder Fehlgriff ohne Ersatz ein Befund (hoch). Best-effort: ein
 *  Fehler des Vision-Calls wird als Befund gemeldet, nicht verschluckt. */
export async function auditBlockImages(blocks: Block[], gal: GalleryImage[], ctx: DeckContext): Promise<AuditResult> {
  const findings: Finding[] = []
  if (!gal.length) return { findings, swapped: 0 }
  const types = [...new Set(ctx.units.map(u => String(u.unitType ?? '').toLowerCase()).filter(Boolean))]
  const deckTyp = types.length === 1 ? types[0] : ''
  const erlaubt = (g: GalleryImage) => !deckTyp || passtZuTyp(g.unitType, deckTyp)
  const kandidatenBloecke = blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => ['unit', 'feature', 'columns', 'cover'].includes(String(b.type)) &&
      typeof b.image === 'string' && (b.image as string).startsWith('http') && b.image !== MARINA_MODEL)
    .slice(0, 12)
  if (!kandidatenBloecke.length) return { findings, swapped: 0 }
  const thumb = (u: string) => {
    const marker = '/storage/v1/object/public/'
    const i = u.indexOf(marker)
    if (i < 0 || u.includes('?')) return u
    return `${u.slice(0, i)}/storage/v1/render/image/public/${u.slice(i + marker.length)}?width=512&height=512&resize=contain`
  }
  const imgs = await Promise.all(kandidatenBloecke.map(async ({ b }) => {
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
  const geprueft: Array<{ b: Block; i: number }> = []
  kandidatenBloecke.forEach((kb, idx) => {
    const im = imgs[idx]
    if (!im) {
      findings.push({ key: 'bild_nicht_ladbar', severity: 'hoch', block: kb.i,
        what: 'Ein Blockbild konnte nicht geladen werden (Storage antwortet nicht).', evidence: String(kb.b.image).slice(0, 160) })
      return
    }
    const thema = [kb.b.kicker, kb.b.headline, kb.b.title, kb.b.tagline, kb.b.number].filter(x => typeof x === 'string').join(' - ').slice(0, 180)
    if (!thema.trim()) return
    content.push({ type: 'text', text: `PAAR ${geprueft.length}: Blocktyp ${String(kb.b.type)}, Thema/Überschrift: „${thema}"` })
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } })
    geprueft.push(kb)
  })
  if (!geprueft.length) return { findings, swapped: 0 }
  const typHinweis = deckTyp
    ? `Das Deck bewirbt ein(e) ${deckTyp.toUpperCase()}. Ein Bild, das eindeutig einen ANDEREN Wohnungstyp zeigt (freistehende Villa mit Privatpool in einem Apartment-Deck, Apartmentblock in einem Villa-Deck), ist IMMER ein Fehlgriff - auch wenn es thematisch zum Text passt. Ebenso Fehlgriffe: Collagen aus mehreren Fotos, Handy-Screenshots, Bilder mit Textueberlagerung, Preislisten, Grundrisse, Karten.`
    : 'Fehlgriffe sind auch: Collagen aus mehreren Fotos, Handy-Screenshots, Bilder mit Textueberlagerung, Preislisten, Grundrisse, Karten.'
  content.push({ type: 'text', text: `Prüfe je Paar, ob das BILD inhaltlich zur Überschrift passt (Pool-Text braucht Poolbild, Küchen-Text Küche/Essbereich, Aussichts-Text einen Ausblick, Fassaden-/Architektur-Text ein Außenbild, ein unit-Block ein Bild der Wohnung oder ihres Gebäudes). ${typHinweis} Sei bei reiner Stimmung tolerant, bei Wohnungstyp und Collagen streng. Gib bei Fehlgriffen die passende Kategorie und den Grund an.` })
  const res = await callAnthropic(ANTHROPIC_API_KEY, {
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
                reason:   { type: 'string', description: 'Bei matches=false: ein Satz, was auf dem Bild zu sehen ist und warum es nicht passt.' },
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
    label: 'image_audit',
    attempts: 2,
  })
  if (!res.ok) {
    findings.push({ key: 'bildpruefung_ausgefallen', severity: 'mittel',
      what: 'Die Bild-Text-Prüfung konnte nicht durchlaufen - die Bilder sind ungeprüft.', evidence: res.error ?? '' })
    return { findings, swapped: 0 }
  }
  const items = toolInput<{ items?: Array<{ index?: number; matches?: boolean; category?: string; reason?: string }> }>(res)?.items ?? []
  const belegt = new Set(bilderImDeck(blocks).map(x => x.url))
  let swapped = 0
  for (const it of items) {
    if (it.matches !== false || typeof it.index !== 'number') continue
    const kb = geprueft[it.index]
    if (!kb) continue
    const vorher = String(kb.b.image)
    // Ersatz: passende Kategorie UND richtiger Wohnungstyp. Erst unbenutzt, sonst
    // ein bereits (z.B. in der Bildstrecke) gezeigtes Bild - eine Dublette ist
    // besser als ein leeres Cover. Nie ein Bild eines anderen Typs.
    const kand = gal.filter(x => x.category === it.category && erlaubt(x))
    const ersatz = kand.find(x => !belegt.has(x.url)) ?? kand[0] ?? null
    if (ersatz) {
      kb.b.image = ersatz.url
      belegt.add(ersatz.url)
      swapped++
      findings.push({ key: 'bild_getauscht', severity: 'niedrig', block: kb.i,
        what: `Bild passte nicht zu „${String(kb.b.headline ?? kb.b.kicker ?? '').slice(0, 60)}" und wurde gegen ein ${it.category}-Bild getauscht.`,
        evidence: `${it.reason ?? ''} · vorher: ${vorher.slice(-40)} · jetzt: ${ersatz.label || ersatz.url.slice(-40)}` })
    } else {
      // Kein erlaubtes Ersatzbild: lieber KEIN Bild als ein falsches.
      delete kb.b.image
      findings.push({ key: 'bild_fehlt', severity: String(kb.b.type) === 'cover' ? 'hoch' : 'mittel', block: kb.i,
        what: `Bild passte nicht zu „${String(kb.b.headline ?? kb.b.kicker ?? '').slice(0, 60)}" und es gibt kein passendes ${it.category ?? ''}-Bild des richtigen Wohnungstyps - Block bleibt ohne Bild.`,
        evidence: `${it.reason ?? ''} · entfernt: ${vorher.slice(-40)}`,
        fix: 'Passendes Bild im Projekt hinterlegen (Aus Drive laden) oder Block im Feinschliff anpassen.' })
    }
  }
  return { findings, swapped }
}

// ── Behauptungspruefung (Claude) ─────────────────────────────────────────────
// Diese Instanz erzeugt KEINE Fakten. Ihre einzige Aufgabe: pruefen, ob das Deck
// objektbezogene Aussagen enthaelt, die der Faktenbestand nicht hergibt. Der
// Befund fuehrt zu RED, nicht zu einer stillen Loeschung.
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

export interface ClaimResult { issues: Array<Record<string, unknown>>; failed: boolean; error?: string }

export async function checkClaims(blocks: Block[], facts: string, ctx: DeckContext): Promise<ClaimResult> {
  // Systembloecke sind KEINE KI-Behauptungen: Zahlungsplan aus dem CRM, Amenities/
  // Masterplan kuratiert, Galerien mit Vision-Labels, Marina/Video mit eigenen
  // Quellen. Bis 19.9.26 wurde der Zahlungsplan-Block regelmaessig als „nicht
  // belegt" gemeldet - jedes Deck war rot, das Signal wertlos.
  const systemIdx: number[] = []
  blocks.forEach((b, i) => {
    if (SYSTEM_BLOCKS.has(String(b.type))) systemIdx.push(i)
    else if (typeof b.image === 'string' && b.image === MARINA_MODEL) systemIdx.push(i)
  })
  const factsIdx = blocks.findIndex(b => b.type === 'facts')
  const TEXT_FELDER = ['kicker', 'title', 'tagline', 'headline', 'text', 'quote', 'intro', 'note', 'paragraphs', 'specs', 'items', 'cols', 'cards', 'groups', 'bullets', 'steps', 'phase1', 'phase2', 'priceLines', 'number', 'planNote', 'stats']
  const schlank = blocks
    .map((b, i) => ({ b, i }))
    .filter(({ i }) => !systemIdx.includes(i))
    .map(({ b, i }) => {
      const o: Record<string, unknown> = { index: i, type: b.type }
      for (const f of TEXT_FELDER) if (b[f] !== undefined) o[f] = b[f]
      return o
    })
  const hart = ctx.units.map(u => ({
    wohnung: u.unitNumber, zimmer: u.bedrooms, baeder: u.bathrooms, wohnflaeche_m2: u.sizeSqm,
    terrasse_m2: u.terraceSqm, grundstueck_m2: u.plotSqm, etage: u.floor, typ: u.unitType,
    netto_immobilie: u.netProperty, moebel_netto: u.netFurniture,
    netto_gesamt: u.price?.netTotal ?? null, mwst: u.price?.vatTotal ?? null, brutto: u.price?.gross ?? null,
    preiszeilen: u.priceLines.map(l => `${l.label}: ${l.value}`),
  }))
  const sched = ctx.paymentSchedule
  const resNet = sched?.reservation ?? null
  const resGross = resNet != null ? (sched?.reservationVat !== false ? Math.round(resNet * 1.19) : resNet) : null
  const zahlungsplan = sched
    ? [
        resNet != null ? `Reservierung ${resNet.toLocaleString('de-DE')} € netto${sched.reservationVat !== false ? ` zzgl. 19 % MwSt = ${resGross!.toLocaleString('de-DE')} € brutto` : ' (ohne MwSt)'}, wird auf die erste Rate angerechnet` : 'keine Reservierung hinterlegt',
        ...sched.stages.map(s => `${s.label}${s.sub ? ` (${s.sub})` : ''}: ${s.pct} %`),
        'Raten werden brutto (inkl. 19 % MwSt) auf den Bruttopreis gerechnet; die Netto-Unterzeile bezieht sich auf den Nettopreis inkl. Möbelpaket, falls eines dabei ist.',
      ].join('\n  ')
    : 'keiner hinterlegt'
  const amenities = blocks.filter(b => b.type === 'amenity' || b.type === 'masterplan').map(b => {
    const items = Array.isArray(b.items) ? (b.items as Array<Record<string, unknown>>).map(it => `${it.title ?? ''}: ${it.text ?? ''}`).join(' | ') : ''
    return `${b.headline ?? ''} ${b.intro ?? ''} ${items} ${b.note ?? ''}`.trim()
  }).filter(Boolean).join('\n')
  const faktenText = [
    `VERIFIZIERTE STAMMDATEN (aus dem CRM, hoechste Prioritaet):\n${JSON.stringify(hart, null, 1)}`,
    `Einrichtung: ${ctx.furnitureMode === 'included' ? 'im Kaufpreis enthalten' : ctx.furnitureMode === 'none' ? 'wird ohne Moebel verkauft' : ctx.furnitureUnknown ? 'nicht gepflegt (unbekannt)' : 'NICHT im Kaufpreis, kostet extra'}`,
    ctx.completion ? `Geplante Fertigstellung: ${ctx.completion}` : 'Fertigstellung: nicht gepflegt',
    `Zahlungsplan:\n  ${zahlungsplan}`,
    amenities ? `\nGEMEINSCHAFTSANLAGEN (kuratiert, gelten als belegt):\n${amenities.slice(0, 6000)}` : '',
    `\nPROJEKT-FAKTEN (aus den Bautraeger-Dokumenten):\n${facts.slice(0, 60000)}`,
  ].filter(Boolean).join('\n')

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
        ? `\nNICHT ENTHALTEN - Systembausteine: Die Blöcke mit den Indizes ${systemIdx.join(', ')} (Zahlungsplan, Gemeinschaftsanlagen, Lageplan, Bildstrecken, Marina, Video) setzt das System deterministisch aus dem CRM ein. Sie fehlen in der Liste unten absichtlich. Melde zu ihnen NICHTS.`
        : '',
      factsIdx >= 0
        ? `\nTEILWEISE NICHT PRÜFEN: Im Block ${factsIdx} sind die Entfernungs-Einträge (Feld items) aus den Geokoordinaten des Projekts berechnet — melde sie NICHT. Überschrift und Fließtext dieses Blocks prüfst du normal.`
        : '',
      `\nDECK (indizierte Blöcke, nur KI-geschriebene):\n${JSON.stringify(schlank).slice(0, 120000)}`,
    ].filter(Boolean).join('\n') }],
    label: 'claim_check',
    attempts: 2,
  })
  if (!res.ok) return { issues: [], failed: true, error: res.error }
  const out = toolInput<{ issues?: Array<Record<string, unknown>> }>(res)
  const roh = Array.isArray(out?.issues) ? out!.issues : []
  // Gedeckte Aussagen und Selbstwidersprueche verwerfen: das Modell listet trotz
  // Anweisung gelegentlich Aussagen auf, die es in der Begruendung selbst als
  // gedeckt bezeichnet ("- gedeckt.", "inhaltlich gedeckt").
  const issues = roh.filter(it => {
    if (String(it.status) === 'covered') return false
    if (systemIdx.includes(Number(it.block_index))) return false
    const grund = `${String(it.evidence ?? '')} ${String(it.reason ?? '')}`
    const positiv = /(^|[^a-zäöü])gedeckt\b/i.test(grund) || /\bcovered\b/i.test(grund)
    const negativ = /nicht\s+gedeckt|ungedeckt|not\s+covered|durch\s+keinen|keinen?\s+\w*\s*(fakt|beleg)/i.test(grund)
    return !(positiv && !negativ)
  })
  if (issues.length !== roh.length) console.log(`[deckQuality] Behauptungsprüfung: ${roh.length - issues.length} gedeckte/System-Aussage(n) verworfen`)
  return { issues, failed: false }
}

// ── Englische Nachuebersetzung ───────────────────────────────────────────────
// Rekursiv ueber ALLE Felder: deterministisch gesetzte Texte (Bild-Labels aus der
// Datenbank, Zahlungsplan) ebenso wie Woerter, die die KI aus den deutschen
// Fakten uebernommen hat. Gibt die Zahl der uebersetzten Stellen zurueck.
export async function translateGermanRemnants(blocks: Block[]): Promise<number> {
  const DEUTSCH = /[äöüßÄÖÜ]|\b(mit|und|der|die|das|im|Blick|Ansicht|Aussen|Innen|raumhoh\w*|bodentief\w*|schluesselfertig|Fussboden\w*|Wohnzimmer|Schlafzimmer|Kueche|Terrasse|Grundstueck|Bautraeger|Uebergabe|Wertsteigerung|Zahlungsplan|Reservierung|netto|brutto|zzgl)\b/i
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
  if (!traeger.length) return 0
  const roh = traeger.map(t => String(t.o[t.k]))
  const tr = await translateOutbound({ subject: null, body: JSON.stringify(roh), whatsapp: null }, 'en')
  const out = JSON.parse(tr.body ?? '[]') as string[]
  if (!Array.isArray(out) || out.length !== traeger.length) throw new Error('Übersetzung verworfen: Anzahl passt nicht')
  traeger.forEach((t, i) => { if (typeof out[i] === 'string' && out[i].trim()) t.o[t.k] = out[i] })
  return traeger.length
}
