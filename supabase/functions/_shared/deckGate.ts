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
import type { DeckContext } from './deckContext.ts'

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
        if (!/reservier/i.test(String(r.label ?? ''))) summe += betrag
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
    if (erlaubtePlaene.size && !erlaubtePlaene.has(img)) {
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
