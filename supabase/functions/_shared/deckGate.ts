// Quality-Gate: prueft ein fertiges Deck gegen die harten Fakten und entscheidet
// GREEN oder RED (review_required).
//
// Leitsatz: Das Gate macht Fehler SICHTBAR, es repariert sie nicht heimlich.
// Der Regex-Scrubber bleibt als Backstop bestehen, aber alles, was hier auffaellt,
// fuehrt zu einem Befund im Bericht — nicht zu einer stillen Loeschung.
//
// Ein RED-Deck bleibt erreichbar und versendbar; es wird im CRM nur deutlich als
// pruefbeduerftig markiert. Ziel ist Autonomie: ein normales, widerspruchsfreies
// Projekt laeuft ohne Kontrolle durch.
//
// ACHTUNG (CLAUDE.md Regel 8): Aenderung wirkt erst nach Redeploy jeder
// importierenden Function.

import { isKnownBlockType, type Block } from './deckBlocks.ts'
import { priceIsConsistent, unitKey } from './deckVat.ts'
import { MARINA_MODEL, type DeckContext } from './deckContext.ts'

export type GalleryImage = { url: string; category: string; label: string; unitType?: string }

export type Severity = 'kritisch' | 'hoch' | 'mittel' | 'niedrig'

export interface Finding {
  key: string
  severity: Severity
  /** Klartext fuer das Pruefpanel im CRM. */
  what: string
  /** Betroffener Block (Index in content.blocks), falls zuordenbar. */
  block?: number
  /** Der betroffene Wert oder Textausschnitt. */
  evidence?: string
  /** Konkurrierende Quellen, falls es ein Faktenkonflikt ist. */
  sourceA?: string
  sourceB?: string
  /** Was Sven tun kann. */
  fix?: string
}

export interface GateResult {
  status: 'green' | 'red'
  findings: Finding[]
  checkedBlocks: number
}

const RED_SEVERITIES: Severity[] = ['kritisch', 'hoch']

/** Platzhalterbilder, die nie in einem versendeten Deck stehen duerfen. */
const PLACEHOLDER = /picsum\.photos|placehold|dummyimage|example\.com/i

// ── Deterministische Pruefungen ──────────────────────────────────────────────
export function runDeckGate(blocks: Block[], ctx: DeckContext): GateResult {
  const f: Finding[] = []
  const add = (x: Finding) => f.push(x)

  // ── Struktur ───────────────────────────────────────────────────────────────
  if (!blocks.length) {
    add({ key: 'deck_leer', severity: 'kritisch', what: 'Das Deck enthält keine Blöcke.', fix: 'Deck neu erzeugen.' })
    return { status: 'red', findings: f, checkedBlocks: 0 }
  }
  blocks.forEach((b, i) => {
    if (!isKnownBlockType(b?.type)) {
      add({ key: 'block_unbekannt', severity: 'kritisch', block: i,
        what: `Block ${i} hat den unbekannten Typ '${String(b?.type)}' und würde im Deck unsichtbar bleiben.`,
        fix: 'Blocktyp im gemeinsamen Vokabular ergänzen oder Block entfernen.' })
    }
  })
  if (blocks[0]?.type !== 'cover') {
    add({ key: 'kein_cover', severity: 'mittel', block: 0, what: 'Das Deck beginnt nicht mit einem Cover.' })
  }
  if (blocks[blocks.length - 1]?.type !== 'cta') {
    add({ key: 'kein_cta', severity: 'niedrig', what: 'Das Deck endet nicht mit dem Abschluss-Block (cta).' })
  }
  if (!blocks.some(b => b.type === 'facts')) {
    add({ key: 'keine_lage', severity: 'mittel', what: 'Es fehlt der Standort-Block (facts) mit Entfernungen und Karte.' })
  }
  // Karte: der Renderer zeichnet sie aus Koordinaten (OpenStreetMap). Ohne
  // Koordinaten bleibt nur die Google-Suche - das ist ein Befund, keine Karte.
  {
    const fb = blocks.find(b => b.type === 'facts')
    if (fb) {
      const coords = typeof fb.mapLat === 'number' && typeof fb.mapLng === 'number'
      if (!coords && !fb.mapQuery && !fb.mapEmbed && !fb.image) {
        add({ key: 'karte_fehlt', severity: 'hoch', what: 'Der Standort-Block hat keine Kartenquelle (keine Koordinaten, keine Suche, kein Bild).',
          fix: 'Koordinaten am Projekt pflegen (Projektformular oder Geocoding).' })
      } else if (!coords) {
        add({ key: 'karte_ohne_koordinaten', severity: 'mittel', what: 'Die Karte läuft über eine Ortssuche statt über exakte Koordinaten - der Pin kann daneben liegen.',
          evidence: String(fb.mapQuery ?? fb.image ?? '').slice(0, 120), fix: 'Koordinaten am Projekt pflegen.' })
      }
    }
  }

  // ── Wohnungen ──────────────────────────────────────────────────────────────
  const unitBlocks = blocks.map((b, i) => ({ b, i })).filter(x => x.b.type === 'unit')
  if (!ctx.generic) {
    if (ctx.units.length && unitBlocks.length !== ctx.units.length) {
      add({ key: 'unit_anzahl', severity: 'hoch',
        what: `${ctx.units.length} Wohnung(en) angefragt, aber ${unitBlocks.length} Wohnungs-Block/Blöcke im Deck.`,
        evidence: ctx.units.map(u => u.unitNumber).join(', '),
        fix: 'Deck neu erzeugen oder den fehlenden Wohnungs-Block im Feinschliff ergänzen.' })
    }
    const erlaubt = new Set(ctx.units.map(u => u.unitKey))
    const gesehen = new Set<string>()
    for (const { b, i } of unitBlocks) {
      const k = unitKey(b.number)
      if (!k) {
        add({ key: 'unit_ohne_nummer', severity: 'hoch', block: i, what: `Wohnungs-Block ${i} trägt keine Wohnungsnummer.` })
        continue
      }
      if (erlaubt.size && !erlaubt.has(k)) {
        add({ key: 'unit_fremd', severity: 'kritisch', block: i,
          what: `Der Wohnungs-Block nennt die Nummer ${String(b.number)}, die gar nicht angefragt wurde.`,
          evidence: `erlaubt: ${[...erlaubt].join(', ')}`,
          fix: 'Wohnungsnummer korrigieren — der Kunde bekommt sonst ein Angebot für die falsche Wohnung.' })
      }
      if (gesehen.has(k)) {
        add({ key: 'unit_doppelt', severity: 'hoch', block: i, what: `Wohnung ${String(b.number)} kommt mehrfach als eigener Block vor.` })
      }
      gesehen.add(k)
    }
    for (const u of ctx.units) {
      if (u.priceLines.length && !gesehen.has(u.unitKey)) {
        add({ key: 'unit_fehlt', severity: 'hoch',
          what: `Für Wohnung ${u.unitNumber} gibt es keinen Wohnungs-Block im Deck.`,
          fix: 'Deck neu erzeugen.' })
      }
    }
  }
  for (const k of ctx.ambiguousUnitKeys) {
    if (ctx.units.some(u => u.unitKey === k)) {
      add({ key: 'unit_mehrdeutig', severity: 'hoch',
        what: `Die Wohnungsnummer '${k}' kommt im Projekt mehrfach vor — Preis und Grundriss sind nicht eindeutig zuordenbar.`,
        fix: 'Doppelte Wohnung im Projekt bereinigen.' })
    }
  }

  // ── Preise ─────────────────────────────────────────────────────────────────
  for (const u of ctx.units) {
    if (!u.price) continue
    if (!priceIsConsistent(u.price)) {
      add({ key: 'preis_inkonsistent', severity: 'kritisch',
        what: `Preisrechnung für Wohnung ${u.unitNumber} ist in sich widersprüchlich (brutto ≠ netto + MwSt).`,
        evidence: JSON.stringify({ netto: u.price.netTotal, mwst: u.price.vatTotal, brutto: u.price.gross }) })
    }
  }
  for (const { b, i } of unitBlocks) {
    const lines = Array.isArray(b.priceLines) ? b.priceLines as Array<Record<string, unknown>> : []
    const k = unitKey(b.number)
    const u = ctx.units.find(x => x.unitKey === k) ?? (ctx.units.length === 1 ? ctx.units[0] : null)
    if (u?.priceLines.length) {
      if (!lines.length) {
        add({ key: 'preis_fehlt', severity: 'hoch', block: i,
          what: `Wohnung ${u.unitNumber} hat im Deck keine Preiszeilen, obwohl ein Preis hinterlegt ist.` })
      } else {
        const soll = JSON.stringify(u.priceLines)
        const ist = JSON.stringify(lines)
        if (soll !== ist) {
          add({ key: 'preis_abweichung', severity: 'kritisch', block: i,
            what: `Die Preiszeilen im Deck weichen von der berechneten Wahrheit ab.`,
            sourceA: `berechnet: ${u.priceLines.map(l => `${l.label} ${l.value}`).join(' · ')}`,
            sourceB: `im Deck: ${lines.map(l => `${l.label} ${l.value}`).join(' · ')}`,
            fix: 'Deck neu normalisieren.' })
        }
      }
    }
    // Preis darf NICHT in freien Texten wiederholt werden — dort veraltet er.
    for (const field of ['text', 'note', 'quote', 'intro']) {
      const v = b[field]
      if (typeof v === 'string' && /\d{2,3}\.\d{3}\s*(€|EUR)/.test(v)) {
        add({ key: 'preis_im_fliesstext', severity: 'mittel', block: i,
          what: 'Im Fließtext steht ein Preis. Er wird bei Preisänderungen nicht mitgezogen.',
          evidence: v.slice(0, 200) })
      }
    }
  }

  // ── Zahlungsplan ───────────────────────────────────────────────────────────
  const payBlocks = blocks.map((b, i) => ({ b, i })).filter(x => x.b.type === 'payment')
  if (ctx.paymentSchedule && !payBlocks.length) {
    add({ key: 'zahlungsplan_fehlt', severity: 'hoch',
      what: 'Für das Projekt ist ein Zahlungsplan hinterlegt, aber das Deck zeigt keinen.' })
  }
  if (ctx.paymentSchedule) {
    const summe = ctx.paymentSchedule.stages.reduce((s, x) => s + (Number(x.pct) || 0), 0)
    if (Math.abs(summe - 100) > 0.01) {
      add({ key: 'zahlungsplan_summe', severity: 'kritisch',
        what: `Die Raten des Zahlungsplans ergeben ${summe} % statt 100 %.`,
        evidence: ctx.paymentSchedule.stages.map(s => `${s.label} ${s.pct} %`).join(' · '),
        fix: 'Zahlungsplan am Projekt korrigieren.' })
    }
    for (const s of ctx.paymentSchedule.stages) {
      if (s.pct <= 0 || s.pct > 100) {
        add({ key: 'zahlungsplan_rate', severity: 'kritisch',
          what: `Eine Rate liegt außerhalb des Gültigen: ${s.label} = ${s.pct} %.` })
      }
    }
    const u = ctx.units.find(x => x.price)
    if (u?.price && ctx.paymentSchedule.reservation && ctx.paymentSchedule.reservation > u.price.gross) {
      add({ key: 'zahlungsplan_reservierung', severity: 'kritisch',
        what: `Die Reservierung (${ctx.paymentSchedule.reservation} €) ist größer als der Kaufpreis.` })
    }
  }
  for (const { b, i } of payBlocks) {
    const rows = [...(Array.isArray((b.phase1 as any)?.rows) ? (b.phase1 as any).rows : []),
                  ...(Array.isArray((b.phase2 as any)?.rows) ? (b.phase2 as any).rows : [])]
    if (!rows.length) {
      add({ key: 'zahlungsplan_leer', severity: 'hoch', block: i, what: 'Der Zahlungsplan-Block enthält keine Raten.' })
    }
    const u = ctx.units.find(x => x.price)
    if (u?.price) {
      let summe = 0
      let alleBetraege = rows.length > 0
      for (const r of rows as Array<Record<string, unknown>>) {
        const betrag = parseEuro(String(r.value ?? ''))
        if (betrag == null) { alleBetraege = false; continue }
        if (betrag > u.price.gross) {
          add({ key: 'zahlungsplan_zu_hoch', severity: 'kritisch', block: i,
            what: `Eine einzelne Rate (${r.value}) ist größer als der gesamte Kaufpreis.`,
            evidence: String(r.label ?? '') })
        }
        // Die Reservierung wird auf die erste Rate angerechnet, sie zählt nicht mit.
        if (!/reserv/i.test(String(r.label ?? ''))) summe += betrag
      }
      // Die aufgeführten Raten müssen in der Summe exakt den Bruttopreis ergeben —
      // sonst rechnet der Kunde nach und findet eine Lücke.
      if (alleBetraege && summe > 0 && summe !== u.price.gross) {
        add({ key: 'zahlungsplan_summe_betrag', severity: 'hoch', block: i,
          what: `Die Raten ergeben ${summe.toLocaleString('de-DE')} € statt des Bruttopreises von ${u.price.gross.toLocaleString('de-DE')} €.`,
          sourceA: `Bruttopreis: ${u.price.gross.toLocaleString('de-DE')} €`,
          sourceB: `Summe der Raten: ${summe.toLocaleString('de-DE')} €`,
          fix: 'Zahlungsplan am Projekt prüfen.' })
      }
    }
  }

  // ── Grundrisse ─────────────────────────────────────────────────────────────
  // Ein Grundriss ist kein Schmuck: er entscheidet mit ueber den Kauf. Ein
  // fehlender oder fremder Plan faerbt das Deck deshalb ROT, nicht gelb.
  const fpBlocks = blocks.map((b, i) => ({ b, i })).filter(x => x.b.type === 'floorplan')
  const erlaubtePlaene = new Set(ctx.units.map(u => u.floorplanUrl).filter(Boolean) as string[])
  for (const { b, i } of fpBlocks) {
    if (!b.image) {
      add({ key: 'grundriss_ohne_bild', severity: 'hoch', block: i,
        what: 'Ein Grundriss-Block hat kein Bild.' })
      continue
    }
    const img = String(b.image)
    // Ein Grundriss darf NIEMALS ein gewoehnliches Projektbild sein — kein
    // Wohnzimmer-Render, kein Aussenbild, kein Masterplan, kein Plan einer
    // anderen Wohnung. Nur was der Deck-Kontext dieser Wohnung zugeordnet hat.
    if (!erlaubtePlaene.has(img)) {
      add({ key: 'grundriss_fremdquelle', severity: 'hoch', block: i,
        what: 'Im Grundriss-Block steht ein Bild, das keiner Wohnung dieses Decks als Grundriss zugeordnet ist.',
        evidence: img.slice(0, 160),
        fix: 'Deck neu normalisieren — der Block darf nur den hinterlegten Plan dieser Wohnung zeigen.' })
    }
    // Ein PDF rendert der Deck-Renderer nicht; es faellt still auf eine graue
    // Flaeche zurueck und kaeme sonst gruen durch.
    if (/\.(pdf|docx?|xlsx?)($|\?|#)/i.test(img)) {
      add({ key: 'grundriss_nicht_darstellbar', severity: 'hoch', block: i,
        what: 'Der Grundriss verweist auf ein Dokument (PDF o.ä.). Im Deck bleibt an dieser Stelle eine graue Fläche.',
        evidence: img.slice(0, 160),
        fix: 'Plan als Bild (PNG/JPG/SVG) hinterlegen.' })
    }
  }
  for (const u of ctx.units) {
    if (!u.floorplanUrl) {
      add({ key: 'grundriss_fehlt', severity: 'hoch',
        what: `Für Wohnung ${u.unitNumber} ist kein Grundriss hinterlegt — das Deck zeigt keinen.`,
        fix: 'Originalplan im Drive-Ordner ablegen und die Assets neu laden, oder über den HP-Grundriss-Generator erzeugen.' })
      continue
    }
    // Plan vorhanden, aber im Deck nicht angekommen.
    if (!fpBlocks.some(x => String(x.b.image) === u.floorplanUrl)) {
      add({ key: 'grundriss_block_fehlt', severity: 'hoch',
        what: `Für Wohnung ${u.unitNumber} ist ein Grundriss hinterlegt, aber im Deck steht kein Grundriss-Block damit.`,
        fix: 'Deck neu normalisieren.' })
    }
    if (u.floorplanFallback) {
      add({ key: 'grundriss_fallback', severity: 'hoch',
        what: `Der Grundriss für Wohnung ${u.unitNumber} stammt nur aus dem Zimmerzahl-Fallback (${u.bedrooms} Schlafzimmer) — es ist nicht der Plan dieser Wohnung.`,
        fix: 'Prüfen, ob der Plan wirklich zu dieser Wohnung passt, sonst Originalplan hinterlegen.' })
    } else if (u.floorplanSource === 'twin') {
      add({ key: 'grundriss_baugleich', severity: 'niedrig',
        what: `Der Grundriss für ${u.unitNumber} stammt von der baugleichen Wohnung (gleicher Typ, Zimmerzahl und Fläche) — im Deck als Hinweis vermerkt.`,
        evidence: `Quelle: ${u.floorplanSource}` })
    } else if (u.floorplanUnapproved) {
      add({ key: 'grundriss_nicht_freigegeben', severity: 'mittel',
        what: `Der Grundriss für ${u.unitNumber} ist ein automatischer Zuschnitt aus dem Bauträgerblatt und noch nicht freigegeben.`,
        fix: 'Im Projekt unter HP-Grundrisse prüfen und freigeben.' })
    } else if (u.floorplanSource === 'suffix') {
      add({ key: 'grundriss_suffix', severity: 'niedrig',
        what: `Der Grundriss für ${u.unitNumber} wurde über die Wohnungsnummer ohne Zusatz gefunden.`,
        evidence: `Quelle: ${u.floorplanSource}` })
    }
  }

  // ── Bilder ─────────────────────────────────────────────────────────────────
  blocks.forEach((b, i) => {
    const img = b.image
    if (typeof img !== 'string' || !img) return
    if (PLACEHOLDER.test(img)) {
      add({ key: 'bild_platzhalter', severity: 'hoch', block: i,
        what: 'Im Deck steht ein Platzhalterbild statt eines echten Projektbildes.', evidence: img.slice(0, 160),
        fix: 'Projektbilder aus dem Drive laden und Deck neu erzeugen.' })
    } else if (!/^https:\/\//.test(img)) {
      add({ key: 'bild_url_ungueltig', severity: 'hoch', block: i, what: 'Ein Bild hat keine gültige https-Adresse.', evidence: img.slice(0, 160) })
    }
  })
  const galleryImgs = blocks.filter(b => b.type === 'gallery')
    .flatMap(b => (Array.isArray(b.items) ? b.items as Array<Record<string, unknown>> : []))
    .map(x => String(x.image ?? '')).filter(Boolean)
  for (const g of galleryImgs) {
    if (PLACEHOLDER.test(g)) {
      add({ key: 'bild_platzhalter', severity: 'hoch', what: 'In einer Bildstrecke steht ein Platzhalterbild.', evidence: g.slice(0, 160) })
      break
    }
  }

  // ── Renditeaussagen ────────────────────────────────────────────────────────
  // Sven 9.9.2026: Renditeprognosen kommen NIE ins Sales Deck. Gerechnet wird
  // ausschliesslich mit unserem eigenen Rechner (/rechnung/:token), der die Zahlen
  // nachvollziehbar herleitet. Ein Prozentwert im Deck ist deshalb immer ein Fund,
  // egal ob ihn die KI erfunden oder aus Bautraeger-Unterlagen uebernommen hat.
  const RENDITE_RE = /(\b(rendite|mietrendite|renditeerwartung|yield|roi|rental\s+income|mieteinnahmen|mietertrag|kapitalverzinsung)\b[^.;!?]{0,60}?\d)|(\d[\d.,]*\s*%\s*(p\.?\s?a\.?|rendite|yield|roi|netto|brutto)\b)/i
  blocks.forEach((b, i) => {
    for (const [k, v] of Object.entries(b)) {
      if (k === 'type' || typeof v !== 'string') continue
      const m = v.match(RENDITE_RE)
      if (!m) continue
      add({ key: 'renditeaussage', severity: 'hoch', block: i,
        what: 'Im Deck steht eine Rendite- oder Mietertragsangabe. Solche Zahlen gehoeren in den Rendite-Rechner, nicht ins Deck.',
        evidence: `${k}: ${v.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 120)}`,
        fix: 'Aussage aus dem Deck entfernen und stattdessen auf die persoenliche Berechnung verweisen.' })
      return
    }
  })

  // ── Sprache ────────────────────────────────────────────────────────────────
  if (ctx.lang === 'en') {
    const DEUTSCH = /[äöüßÄÖÜ]|\b(und|der|die|das|mit|Wohnzimmer|Schlafzimmer|Terrasse|Zahlungsplan|Bruttopreis|Nettopreis)\b/
    blocks.forEach((b, i) => {
      for (const [k, v] of Object.entries(b)) {
        if (typeof v === 'string' && !v.startsWith('http') && DEUTSCH.test(v)) {
          add({ key: 'deutscher_text_in_en', severity: 'mittel', block: i,
            what: 'Im englischen Deck steht noch deutscher Text.', evidence: `${k}: ${v.slice(0, 160)}` })
          return
        }
      }
    })
  }

  // ── Zahlen in KI-Texten gegen die Stammdaten ──────────────────────────────
  // Sven 19.9.26: „CRM 84,5 m², KI schreibt 92 m²" muss rot werden - nicht nur
  // im specs-Feld, sondern in JEDEM freien Text. Geprueft werden nur Bloecke, die
  // die KI schreibt; Systembloecke (payment aus dem CRM, amenity, masterplan,
  // marina, video, gallery) tragen ihre Zahlen aus der Datenbank.
  {
    const KI_BLOECKE = new Set(['cover', 'letter', 'unit', 'facts', 'columns', 'feature', 'benefits', 'inventory', 'floorplan', 'cta'])
    // Bloecke, die EINE Wohnung beschreiben: Abweichung = hoch. In Projekt-Bloecken
    // (feature/columns/benefits/inventory/facts) koennen legitime Projektzahlen
    // stehen (Studio 140 m², Grundstueck 971 m²) - dort nur mittel.
    const WOHNUNGS_BLOECKE = new Set(['unit', 'floorplan', 'cover', 'letter', 'cta'])
    const nah = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
    const flaechen = new Set<number>()
    const zimmer = new Set<number>()
    const baeder = new Set<number>()
    const etagen = new Set<number>()
    for (const u of ctx.units) {
      for (const v of [u.sizeSqm, u.terraceSqm, u.plotSqm]) if (v != null && v > 0) flaechen.add(Number(v))
      if (u.sizeSqm != null && u.terraceSqm != null) flaechen.add(Number(u.sizeSqm) + Number(u.terraceSqm))
      if (u.bedrooms != null) zimmer.add(Number(u.bedrooms))
      if (u.bathrooms != null) baeder.add(Number(u.bathrooms))
      if (u.floor != null) etagen.add(Number(u.floor))
    }
    const betraege = new Set<number>()
    const addB = (n: number | null | undefined) => { if (n != null && Number.isFinite(n) && n > 0) betraege.add(Math.round(n)) }
    for (const u of ctx.units) {
      addB(u.netProperty); addB(u.netFurniture)
      if (u.price) {
        addB(u.price.netTotal); addB(u.price.vatTotal); addB(u.price.gross); addB(u.price.vatFurniture)
        addB(u.price.netFurniture + u.price.vatFurniture)
        addB(u.price.split.netReduced); addB(u.price.split.netStandard); addB(u.price.split.vatReduced); addB(u.price.split.vatStandard)
        if (ctx.paymentSchedule) {
          let rest = u.price.gross
          ctx.paymentSchedule.stages.forEach((s, i, arr) => {
            const v = i === arr.length - 1 ? rest : Math.round(s.pct / 100 * u.price!.gross)
            addB(v); rest -= v
            addB(Math.round(s.pct / 100 * u.price!.netTotal))
          })
        }
      }
    }
    if (ctx.paymentSchedule?.reservation) {
      addB(ctx.paymentSchedule.reservation)
      addB(Math.round(ctx.paymentSchedule.reservation * 1.19))
    }
    addB(ctx.furnitureDefault)
    for (const v of Object.values(ctx.furnitureByBedrooms ?? {})) addB(Number(v))

    const deNum = (s: string): number => {
      const t = s.trim()
      // "1.250" = Tausender, "84,5" = Dezimal, "84.5" (engl.) = Dezimal.
      if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'))
      return Number(t.replace(',', '.'))
    }
    const WORTZAHL: Record<string, number> = { ein: 1, eine: 1, einem: 1, zwei: 2, drei: 3, vier: 4, fuenf: 5, 'fünf': 5, one: 1, two: 2, three: 3, four: 4, five: 5 }
    const SKIP_KEYS = new Set(['type', 'image', 'priceLines', 'priceSummary', 'mapUrl', 'mapQuery', 'mapLabel', 'link', 'linkLabel', 'embedUrl', 'videoUrl', 'poster', 'plan', 'planLabel', 'video', 'assetId'])
    const texte = (node: unknown, pfad: string, out: Array<{ field: string; text: string }>) => {
      if (typeof node === 'string') { if (!/^https?:\/\//i.test(node)) out.push({ field: pfad, text: node }); return }
      if (Array.isArray(node)) { node.forEach((v, i) => texte(v, `${pfad}[${i}]`, out)); return }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (SKIP_KEYS.has(k)) continue
          texte(v, pfad ? `${pfad}.${k}` : k, out)
        }
      }
    }
    const MONATE: Record<string, number> = { januar: 1, februar: 2, 'märz': 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
      january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10, december: 12 }
    const [cm, cy] = ctx.completion ? ctx.completion.split('/').map(Number) : [0, 0]

    blocks.forEach((b, i) => {
      const t = String(b.type ?? '')
      if (!KI_BLOECKE.has(t) && !(t === 'payment' && !ctx.paymentSchedule)) return
      // Marina-Story mit Modellbild setzt das System (165.000 m², Baubeginn April 2027).
      if (typeof b.image === 'string' && b.image === MARINA_MODEL) return
      const hart = WOHNUNGS_BLOECKE.has(t)
      const felder: Array<{ field: string; text: string }> = []
      texte(b, '', felder)
      const gemeldet = new Set<string>()
      for (const { field, text } of felder) {
        const ausschnitt = (idx: number) => text.slice(Math.max(0, idx - 50), idx + 70)
        // Flaechen
        if (flaechen.size) {
          for (const m of text.matchAll(/(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:m²|m2|qm|sqm|sq\.?\s?m)(?![a-z0-9])/gi)) {
            const v = deNum(m[1])
            if (!Number.isFinite(v) || v < 5) continue
            if ([...flaechen].some(f => nah(f, v, 0.6))) continue
            // Ausserhalb von unit/floorplan (Anschreiben nennt Gym 105 m², Yoga-Studio
            // 140 m², Grundstueck 971 m²) nur melden, wenn die Zahl erkennbar die
            // WOHNUNG beschreibt. Schwere bleibt hoch in Wohnungs-Bloecken.
            const umfeld = text.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + m[0].length + 60)
            // Gemeinschaftsflaechen (181,74 m² Pool, 105 m² Gym) sind nie die Wohnung.
            if (/pool|gemeinschaft|anlage|club|gym|fitness|studio|spa\b|lobby|garten der anlage/i.test(umfeld)) continue
            if (t !== 'unit' && t !== 'floorplan') {
              if (!/wohnfl|innenfl|wohnung|apartment|terrasse|balkon|veranda|grundst|plot\b|villa|townhouse|living\s*area|internal|indoor|outdoor/i.test(umfeld)) continue
            }
            const key = `fl:${v}`
            if (gemeldet.has(key)) continue
            gemeldet.add(key)
            add({ key: 'flaeche_abweichung', severity: hart ? 'hoch' : 'mittel', block: i,
              what: `Im Text steht ${m[1]} m², in den Stammdaten ${[...flaechen].map(f => String(f).replace('.', ',')).join(' / ')} m².`,
              evidence: `${field}: ${ausschnitt(m.index ?? 0)}`, sourceA: `CRM: ${[...flaechen].join(' / ')} m²`, sourceB: `Deck: ${m[1]} m²`,
              fix: hart ? 'Fläche im Feinschliff auf den CRM-Wert setzen oder Deck neu erzeugen.' : 'Prüfen, ob die Zahl zum Projekt gehört; sonst korrigieren.' })
          }
        }
        if (!hart) continue
        // Schlafzimmer
        if (zimmer.size) {
          for (const m of text.matchAll(/\b(\d|ein|eine|einem|zwei|drei|vier|fünf|fuenf|one|two|three|four|five)[\s-]*(?:schlafzimmer|sz\b|bedrooms?\b|bed\b)/gi)) {
            const v = /^\d$/.test(m[1]) ? Number(m[1]) : (WORTZAHL[m[1].toLowerCase()] ?? NaN)
            if (!Number.isFinite(v) || zimmer.has(v)) continue
            const key = `sz:${v}`; if (gemeldet.has(key)) continue; gemeldet.add(key)
            add({ key: 'zimmer_abweichung', severity: 'hoch', block: i,
              what: `Im Text stehen ${v} Schlafzimmer, in den Stammdaten ${[...zimmer].join(' / ')}.`,
              evidence: `${field}: ${ausschnitt(m.index ?? 0)}`, fix: 'Zimmerzahl korrigieren.' })
          }
        }
        // Baeder
        if (baeder.size) {
          for (const m of text.matchAll(/\b(\d|ein|zwei|drei|one|two|three)[\s-]*(?:badezimmer|bäder|bathrooms?\b)/gi)) {
            const v = /^\d$/.test(m[1]) ? Number(m[1]) : (WORTZAHL[m[1].toLowerCase()] ?? NaN)
            if (!Number.isFinite(v) || baeder.has(v)) continue
            const key = `bad:${v}`; if (gemeldet.has(key)) continue; gemeldet.add(key)
            add({ key: 'bad_abweichung', severity: 'mittel', block: i,
              what: `Im Text stehen ${v} Bäder, in den Stammdaten ${[...baeder].join(' / ')}.`,
              evidence: `${field}: ${ausschnitt(m.index ?? 0)}` })
          }
        }
        // Etage
        if (etagen.size) {
          const treffer: Array<{ v: number; idx: number; roh: string }> = []
          for (const m of text.matchAll(/\b(\d{1,2})\.\s*(?:etage|obergeschoss|og\b|stock\b)/gi)) treffer.push({ v: Number(m[1]), idx: m.index ?? 0, roh: m[0] })
          for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\s+floor\b/gi)) treffer.push({ v: Number(m[1]), idx: m.index ?? 0, roh: m[0] })
          for (const m of text.matchAll(/\b(erdgeschoss|ground\s+floor)\b/gi)) treffer.push({ v: 0, idx: m.index ?? 0, roh: m[0] })
          for (const x of treffer) {
            if (etagen.has(x.v)) continue
            const key = `et:${x.v}`; if (gemeldet.has(key)) continue; gemeldet.add(key)
            add({ key: 'etage_abweichung', severity: 'hoch', block: i,
              what: `Im Text steht „${x.roh}", in den Stammdaten Etage ${[...etagen].join(' / ')}.`,
              evidence: `${field}: ${ausschnitt(x.idx)}`, fix: 'Etage korrigieren.' })
          }
        }
      }
      // Betraege: in ALLEN KI-Bloecken, auch Projektbloecken (Preise gehoeren nur in
      // die Preiszeilen/den Zahlungsplan).
      for (const { field, text } of felder) {
        for (const m of text.matchAll(/(\d{1,3}(?:\.\d{3})+|\d{4,7})(?:,\d{2})?\s*(?:€|EUR\b|Euro\b)/g)) {
          const v = Number(m[1].replace(/\./g, ''))
          if (!Number.isFinite(v) || betraege.has(v)) continue
          const key = `eur:${v}`; if (gemeldet.has(key)) continue; gemeldet.add(key)
          add({ key: 'betrag_fremd', severity: v >= 5000 ? 'hoch' : 'mittel', block: i,
            what: `Im Text steht ein Betrag (${m[0].trim()}), der weder Preis, MwSt, Rate, Reservierung noch Möbelpaket dieses Decks entspricht.`,
            evidence: `${field}: ${text.slice(Math.max(0, (m.index ?? 0) - 50), (m.index ?? 0) + 70)}`,
            fix: 'Betrag streichen oder auf einen der verbindlichen Werte setzen.' })
        }
        // Fertigstellung in Wortform ("September 2028")
        if (cm && cy) {
          for (const m of text.matchAll(/\b(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|may|june|july|october|december)\s+(20\d\d)\b/gi)) {
            const mm = MONATE[m[1].toLowerCase()], yy = Number(m[2])
            if (!mm || (mm === cm && yy === cy)) continue
            // Nur Termine, die als Fertigstellung/Uebergabe gemeint sind - nicht
            // "Für Kunde - September 2026" (Deckdatum) oder "Baubeginn April 2027".
            const umfeld = text.slice(Math.max(0, (m.index ?? 0) - 70), (m.index ?? 0) + m[0].length + 30)
            if (!/fertigstell|übergabe|uebergabe|bezugsfertig|einzug|schlüssel|schluessel|completion|handover|delivery|move[- ]in|ready/i.test(umfeld)) continue
            const key = `fert:${mm}/${yy}`; if (gemeldet.has(key)) continue; gemeldet.add(key)
            add({ key: 'fertigstellung_abweichung', severity: 'hoch', block: i,
              what: `Im Deck steht der Termin ${m[0]}, am Projekt ist ${ctx.completion} hinterlegt.`,
              sourceA: `Projekt: ${ctx.completion}`, sourceB: `Deck: ${m[0]}`, fix: 'Fertigstellung am Projekt prüfen oder Deck neu erzeugen.' })
          }
        }
      }
    })
  }

  // ── Fertigstellung ─────────────────────────────────────────────────────────
  if (ctx.completion) {
    const roh = JSON.stringify(blocks)
    for (const m of roh.matchAll(/\b(0[1-9]|1[0-2])\/(20\d\d)\b/g)) {
      if (m[0] !== ctx.completion) {
        add({ key: 'fertigstellung_abweichung', severity: 'hoch',
          what: `Im Deck steht der Termin ${m[0]}, am Projekt ist ${ctx.completion} hinterlegt.`,
          sourceA: `Projekt: ${ctx.completion}`, sourceB: `Deck: ${m[0]}`,
          fix: 'Fertigstellung am Projekt prüfen oder Deck neu erzeugen.' })
        break
      }
    }
  }

  const red = f.some(x => RED_SEVERITIES.includes(x.severity))
  return { status: red ? 'red' : 'green', findings: f, checkedBlocks: blocks.length }
}

// ── Wohnungstyp je Bild ──────────────────────────────────────────────────────
// villa/townhouse/apartment = zeigt genau diesen Typ; anlage/unklar/leer = neutral.
export const neutralTyp = (t: string | undefined | null) => !t || t === 'anlage' || t === 'unklar'
export const passtZuTyp = (bildTyp: string | undefined | null, deckTyp: string) =>
  neutralTyp(bildTyp) || String(bildTyp).toLowerCase() === deckTyp

/** Alle Bild-URLs eines Decks (Blockbild, Galerie-Items, Amenity-Items). */
export function bilderImDeck(blocks: Block[]): Array<{ block: number; url: string; feld: string }> {
  const out: Array<{ block: number; url: string; feld: string }> = []
  blocks.forEach((b, i) => {
    if (typeof b.image === 'string' && b.image.startsWith('http')) out.push({ block: i, url: b.image, feld: 'image' })
    if (Array.isArray(b.items)) {
      (b.items as Array<Record<string, unknown>>).forEach((it, j) => {
        if (it && typeof it.image === 'string' && (it.image as string).startsWith('http')) out.push({ block: i, url: it.image as string, feld: `items[${j}].image` })
      })
    }
  })
  return out
}

/** Deterministisch: Bilder, deren Vision-Tag einem ANDEREN Wohnungstyp gehoert
 *  als die angebotene Wohnung (Villa-Render im Apartment-Deck). Greift nur, wenn
 *  alle Wohnungen des Decks denselben Typ haben und das Bild ueberhaupt getaggt
 *  ist - ungetaggte Bilder werden gesondert gemeldet (niedrig), damit sichtbar
 *  bleibt, dass die Pruefung dort blind war. */
export function checkImageTypes(blocks: Block[], ctx: DeckContext, gal: GalleryImage[]): Finding[] {
  const f: Finding[] = []
  const types = [...new Set(ctx.units.map(u => String(u.unitType ?? '').toLowerCase()).filter(Boolean))]
  if (types.length !== 1) return f
  const deckTyp = types[0]
  const tagOf = new Map(gal.map(g => [g.url, g]))
  let ungetaggt = 0
  for (const { block, url, feld } of bilderImDeck(blocks)) {
    if (url === MARINA_MODEL || url.includes('/deck-assets/brand/')) continue
    const g = tagOf.get(url)
    if (!g) continue                                   // kein Galeriebild (Grundriss, Karte, Masterplan …)
    if (!g.unitType) { ungetaggt++; continue }
    if (passtZuTyp(g.unitType, deckTyp)) continue
    f.push({ key: 'bild_fremdtyp', severity: 'hoch', block,
      what: `Block ${block} zeigt ein ${g.unitType}-Bild, angeboten wird aber ein ${deckTyp}.`,
      evidence: `${feld}: ${g.label || url.slice(-40)}`,
      fix: 'Bild gegen ein Bild des richtigen Wohnungstyps tauschen oder Feld leeren.' })
  }
  if (ungetaggt) {
    f.push({ key: 'bild_typ_ungeprueft', severity: 'niedrig',
      what: `${ungetaggt} Galeriebild(er) tragen keinen Wohnungstyp-Tag - die Typ-Prüfung war dort blind.`,
      fix: 'Bilder im Projekt neu einsortieren (Aus Drive laden).' })
  }
  return f
}


function parseEuro(s: string): number | null {
  const m = s.replace(/\s/g, '').match(/^([\d.]+)(?:,\d+)?€?$/)
  if (!m) return null
  const n = Number(m[1].replace(/\./g, ''))
  return Number.isFinite(n) ? n : null
}

/** Befunde aus der KI-Behauptungsprüfung in Findings übersetzen. */
export function claimIssuesToFindings(issues: Array<Record<string, unknown>>): Finding[] {
  return issues.map(it => ({
    key: 'behauptung_' + String(it.status ?? 'unsupported'),
    severity: (String(it.severity) === 'high' ? 'hoch' : String(it.severity) === 'low' ? 'niedrig' : 'mittel') as Severity,
    block: typeof it.block_index === 'number' ? it.block_index : undefined,
    what: String(it.status) === 'conflict'
      ? `Behauptung widerspricht den Fakten: ${String(it.claim ?? '')}`
      : `Behauptung ist durch keinen Fakt gedeckt: ${String(it.claim ?? '')}`,
    evidence: String(it.evidence ?? it.reason ?? '').slice(0, 400),
    fix: 'Aussage im Feinschliff streichen oder mit einem belegten Fakt ersetzen.',
  }))
}
