// Deterministische Normalisierung eines Decks.
//
// Alles, was NICHT die KI entscheiden darf, wird hier gesetzt: Wohnungsnummern,
// Preiszeilen, MwSt-Box, Zahlungsplan, Grundriss-Bilder, Marina-Bild, Karte.
// Frueher lief das nur einmal in generate-deck. Ein Feinschliff ueber refine-deck
// ersetzte danach ganze Bloecke und loeschte diese Felder wieder — ohne dass es
// jemandem auffiel. Ab jetzt laeuft dieselbe Normalisierung nach JEDER
// Bearbeitung, aus demselben Kontext.
//
// Der Scrubber bleibt als Backstop erhalten, protokolliert seine Eingriffe aber
// jetzt (welche Regel, welcher Block, welcher Text) — sonst laesst sich nie
// beurteilen, welche Regel wirklich greift.
//
// ACHTUNG (CLAUDE.md Regel 8): Aenderung wirkt erst nach Redeploy jeder
// importierenden Function.

import { eur } from './deckVat.ts'
import { dropUnknownBlocks, type Block } from './deckBlocks.ts'
import type { DeckContext, PaySchedule, PayStage } from './deckContext.ts'

export interface ScrubEvent {
  rule: string
  block: number
  blockType: string
  field: string
  removed: string
}

export interface NormalizeResult {
  blocks: Block[]
  scrubEvents: ScrubEvent[]
  /** Was die Normalisierung selbst geaendert hat (fuer den Gate-Bericht). */
  notes: string[]
}

// ── Wahrheits-Backstop (Regex, satzweise) ────────────────────────────────────
const FORBIDDEN_GLOBAL: Array<[string, RegExp]> = [
  ['garantie',        /mietgarantie|rendite-?garantie|garantierte (miete|rendite|auslastung)/i],
  ['zahlung_spaeter', /erst nach (der )?fertigstellung/i],
  ['zahlung_gebaut',  /(du )?zahlst erst,? wenn gebaut wurde/i],
  ['zahlung_steht',   /wenn das apartment steht/i],
  ['kredit_traeger',  /nicht auf kredit des bauträgers/i],
  ['auslastung_tag1', /(sorgt|ab dem ersten tag)[^.!?]*auslastung/i],
  ['auslastung',      /immer vermietet|gesicherte auslastung|garantierte auslastung/i],
]
const FORBIDDEN_PAYMENT: Array<[string, RegExp]> = [
  ['pay_baufortschritt', /finanzierst keinen baufortschritt/i],
  ['pay_schutz',         /schützt (dich|deine)/i],
  ['pay_sicherheit',     /planungssicherheit/i],
  ['pay_loewenanteil',   /(löwenanteil|großteil)[^.!?]*(übergabe|fertig)/i],
  ['pay_phasen',         /jede phase muss abgeschlossen sein,? bevor die nächste rate/i],
]
const FORBIDDEN_FURNITURE: Array<[string, RegExp]> = [
  ['moebel_schluesselfertig', /schlüsselfertig/i],
  ['moebel_vollmoebliert',    /voll(ständig)?\s+möbliert/i],
  ['moebel_eingerichtet',     /komplett\s+eingerichtet/i],
  ['moebel_im_preis',         /(möbel|einrichtung|einrichtungspaket)[^.!?]*(im (kauf)?preis|inklusive|enthalten)/i],
  ['moebel_im_preis2',        /(im (kauf)?preis|inklusive)[^.!?]*(möbel|einrichtung)/i],
  ['moebel_koffer',           /nur (noch )?die koffer|packst (du )?die koffer/i],
  ['moebel_bezugsfertig',     /sofort bezugs-? ?(und vermiet)?(bereit|fertig)/i],
]
/** Verneinte Saetze sind erwuenscht ("NICHT im Kaufpreis enthalten"). */
const VERNEINT = /\b(nicht|kein[e]?[nmrs]?|ohne|optional|extra|Aufpreis|zusätzlich|separat)\b/i

const MOEBEL_WORT = /möbel|möbliert|einrichtungspaket|einrichtung|geschirr|besteck|bettwäsche|wäschepaket|cutlery|linen|sofa|matratze|bettrahmen/i
const FEST_VERBAUT = /küche|einbauschrank|einbauschränke|sanitär|klima|boden|böden|fenster|dusche|wc|armatur|schrankfront/i

const splitSentences = (s: string) => s.split(/(?<=[.!?…])\s+/)

function scrubText(
  s: unknown, rules: Array<[string, RegExp]>, sink: ScrubEvent[], meta: { block: number; blockType: string; field: string },
): unknown {
  if (typeof s !== 'string' || !s) return s
  const kept: string[] = []
  for (const part of splitSentences(s)) {
    const hit = rules.find(([, re]) => re.test(part) && !VERNEINT.test(part))
    if (hit) sink.push({ rule: hit[0], block: meta.block, blockType: meta.blockType, field: meta.field, removed: part.trim().slice(0, 300) })
    else kept.push(part)
  }
  return kept.join(' ').trim()
}

function scrubList(
  arr: unknown[], rules: Array<[string, RegExp]>, sink: ScrubEvent[], meta: { block: number; blockType: string; field: string },
): unknown[] {
  return arr.filter(x => {
    if (typeof x !== 'string') return true
    const hit = rules.find(([, re]) => re.test(x) && !VERNEINT.test(x))
    if (hit) { sink.push({ rule: hit[0], block: meta.block, blockType: meta.blockType, field: meta.field, removed: x.slice(0, 300) }); return false }
    return true
  })
}

/** Entfernt belegte Falschaussagen satzweise und protokolliert jeden Eingriff. */
export function scrubNarrative(blocks: Block[], furnitureIncluded: boolean): ScrubEvent[] {
  const events: ScrubEvent[] = []
  const furnRules = furnitureIncluded ? [] : FORBIDDEN_FURNITURE
  blocks.forEach((b, i) => {
    const t = String(b.type ?? '')
    const isPay = t === 'payment'
    const rules = [...FORBIDDEN_GLOBAL, ...furnRules, ...(isPay ? FORBIDDEN_PAYMENT : [])]
    const meta = (field: string) => ({ block: i, blockType: t, field })

    for (const f of ['intro', 'note', 'text', 'quote']) {
      if (typeof b[f] === 'string') b[f] = scrubText(b[f], rules, events, meta(f))
    }
    if (Array.isArray(b.paragraphs)) {
      b.paragraphs = (b.paragraphs as unknown[])
        .map((p, j) => scrubText(p, rules, events, meta(`paragraphs[${j}]`)))
        .filter(Boolean)
    }
    for (const listKey of ['specs', 'items', 'bullets']) {
      if (Array.isArray(b[listKey])) b[listKey] = scrubList(b[listKey] as unknown[], furnRules, events, meta(listKey))
    }
    for (const grpKey of ['groups', 'cards', 'cols']) {
      const arr = b[grpKey]
      if (!Array.isArray(arr)) continue
      for (const g of arr as Array<Record<string, unknown>>) {
        if (!g || typeof g !== 'object') continue
        for (const f of ['text', 'title', 'note']) {
          if (typeof g[f] === 'string') g[f] = scrubText(g[f], rules, events, meta(`${grpKey}.${f}`))
        }
        if (Array.isArray(g.items)) g.items = scrubList(g.items as unknown[], furnRules, events, meta(`${grpKey}.items`))
      }
    }
    if (!furnitureIncluded) {
      for (const f of ['headline', 'tagline']) {
        const v = b[f]
        if (typeof v === 'string' && furnRules.some(([, re]) => re.test(v) && !VERNEINT.test(v))) {
          events.push({ rule: 'moebel_headline', block: i, blockType: t, field: f, removed: v.slice(0, 300) })
          b[f] = t === 'inventory' ? 'Die Ausstattung im Überblick' : ''
        }
      }
    }
    for (const phKey of ['phase1', 'phase2']) {
      const ph = b[phKey] as Record<string, unknown> | undefined
      if (ph && typeof ph === 'object') {
        for (const f of ['advantage', 'title', 'label']) {
          if (typeof ph[f] === 'string') ph[f] = scrubText(ph[f], rules, events, meta(`${phKey}.${f}`))
        }
      }
    }
    if (isPay) {
      for (const [f, ersatz] of [['headline', 'Der Zahlungsplan im Überblick'], ['kicker', 'Zahlungsplan']] as const) {
        const v = b[f]
        if (typeof v === 'string' && rules.some(([, re]) => re.test(v))) {
          events.push({ rule: 'pay_headline', block: i, blockType: t, field: f, removed: v.slice(0, 300) })
          b[f] = ersatz
        }
      }
    }
  })
  return events
}

/** Bei furnitureMode 'none' fliegt jede Moebel-Erwaehnung raus. */
export function removeFurniture(blocks: Block[], sink: ScrubEvent[]): Block[] {
  const raus = (s: unknown, meta: { block: number; blockType: string; field: string }) => {
    if (typeof s !== 'string') return s
    const kept: string[] = []
    for (const p of splitSentences(s)) {
      if (MOEBEL_WORT.test(p) && !FEST_VERBAUT.test(p)) sink.push({ rule: 'furniture_mode_none', ...meta, removed: p.trim().slice(0, 300) })
      else kept.push(p)
    }
    return kept.join(' ').trim()
  }
  const out = blocks.filter((b, i) => {
    const txt = JSON.stringify(b)
    if (!MOEBEL_WORT.test(txt)) return true
    if (b.type === 'inventory') {
      const moebel = (txt.match(new RegExp(MOEBEL_WORT.source, 'gi')) ?? []).length
      const fest = (txt.match(new RegExp(FEST_VERBAUT.source, 'gi')) ?? []).length
      if (fest > moebel) return true
      sink.push({ rule: 'furniture_mode_none_block', block: i, blockType: String(b.type), field: '(block)', removed: String(b.headline ?? b.kicker ?? '').slice(0, 300) })
      return false
    }
    return true
  })
  out.forEach((b, i) => {
    const t = String(b.type ?? '')
    for (const f of ['intro', 'note', 'text', 'quote', 'headline', 'tagline', 'nickname', 'kicker']) {
      if (typeof b[f] === 'string') {
        const neu = raus(b[f], { block: i, blockType: t, field: f })
        b[f] = (['headline', 'kicker', 'nickname', 'tagline'].includes(f) && !neu) ? undefined : neu
      }
    }
    if (Array.isArray(b.paragraphs)) {
      b.paragraphs = (b.paragraphs as unknown[]).map((p, j) => raus(p, { block: i, blockType: t, field: `paragraphs[${j}]` })).filter(Boolean)
    }
    for (const listKey of ['specs', 'items', 'bullets']) {
      if (!Array.isArray(b[listKey])) continue
      b[listKey] = (b[listKey] as unknown[]).filter(x => {
        const s = typeof x === 'string' ? x : JSON.stringify(x)
        const weg = MOEBEL_WORT.test(s) && !FEST_VERBAUT.test(s)
        if (weg) sink.push({ rule: 'furniture_mode_none', block: i, blockType: t, field: listKey, removed: s.slice(0, 300) })
        return !weg
      })
    }
    for (const grpKey of ['groups', 'cards', 'cols', 'steps']) {
      if (!Array.isArray(b[grpKey])) continue
      b[grpKey] = (b[grpKey] as Array<Record<string, unknown>>).filter(g => {
        if (!g || typeof g !== 'object') return true
        for (const f of ['text', 'title', 'note']) {
          if (typeof g[f] === 'string') g[f] = raus(g[f], { block: i, blockType: t, field: `${grpKey}.${f}` })
        }
        if (Array.isArray(g.items)) {
          g.items = (g.items as unknown[]).filter(x => {
            const s = typeof x === 'string' ? x : JSON.stringify(x)
            return !(MOEBEL_WORT.test(s) && !FEST_VERBAUT.test(s))
          })
        }
        const s = JSON.stringify(g)
        const weg = MOEBEL_WORT.test(s) && !FEST_VERBAUT.test(s)
        if (weg) sink.push({ rule: 'furniture_mode_none', block: i, blockType: t, field: grpKey, removed: s.slice(0, 200) })
        return !weg
      })
    }
  })
  return out
}

// ── Zahlungsplan deterministisch bauen ───────────────────────────────────────
export function buildPaymentBlock(sched: PaySchedule, basis?: { net: number; gross: number } | null): Block {
  const stages = sched.stages ?? []
  const half = Math.ceil(stages.length / 2)
  const fmt = (n: number) => Math.round(n).toLocaleString('de-DE') + ' €'
  const hasBasis = !!basis && basis.gross > 0
  // Jede Rate einzeln zu runden ergibt in der Summe bis zu ein paar Euro daneben
  // (546.211 statt 546.210 bei Emerald Park). Die LETZTE Rate ist deshalb der
  // Restbetrag — so ergibt die Aufstellung exakt den Bruttopreis.
  const brutto: number[] = []
  if (hasBasis) {
    let rest = basis!.gross
    stages.forEach((s, i) => {
      const v = i === stages.length - 1 ? rest : Math.round(s.pct / 100 * basis!.gross)
      brutto.push(v); rest -= v
    })
  }
  const stageVal = (s: PayStage, i: number) => hasBasis ? fmt(brutto[i]) : `${s.pct} %`
  const stageSub = (s: PayStage) => {
    const parts: string[] = []
    if (s.sub) parts.push(s.sub)
    if (hasBasis) parts.push(`${s.pct} % · ${fmt(s.pct / 100 * basis!.net)} netto`)
    return parts.length ? parts.join(' · ') : undefined
  }
  const p1: Array<Record<string, unknown>> = []
  if (sched.reservation) {
    p1.push({ label: 'Reservierung', sub: hasBasis ? 'sofort fällig · sichert die Wohnung' : 'sichert die Wohnung', value: fmt(sched.reservation) })
  }
  stages.slice(0, half).forEach((s, i) => p1.push({ label: s.label, sub: stageSub(s), value: stageVal(s, i) }))
  const p2 = stages.slice(half).map((s, i) => ({ label: s.label, sub: stageSub(s), value: stageVal(s, half + i) }))
  return {
    type: 'payment',
    kicker: 'Zahlungsplan',
    headline: 'Der Zahlungsplan im Überblick',
    intro: 'In klaren Stufen über die Bauphasen verteilt — transparent und nachvollziehbar.',
    phase1: { label: 'Start', title: 'Reservierung & Vertrag', rows: p1 },
    phase2: { label: 'Bauphase & Übergabe', title: 'Raten nach Baufortschritt', rows: p2 },
    note: hasBasis
      ? 'Reservierung und die erste Rate bei Vertragsunterzeichnung sind sofort fällig; weitere Raten folgen mit dem Baufortschritt. Die Reservierung wird auf die erste Rate angerechnet. Hauptbeträge brutto (inkl. MwSt); der jeweilige Nettobetrag ist zusätzlich ausgewiesen.'
      : 'Der Reservierungsbetrag wird bei Vertragsunterzeichnung angerechnet. Prozentsätze bezogen auf den Kaufpreis; finale Beträge gemäß Bauträger-Konditionen.',
  }
}

// ── Die eigentliche Normalisierung ───────────────────────────────────────────
export function applyDeterministic(inputBlocks: Block[], ctx: DeckContext): NormalizeResult {
  const notes: string[] = []
  const scrubEvents: ScrubEvent[] = []

  // 0) Unbekannte Blocktypen raus — sie wuerden im Renderer lautlos verschwinden
  //    und ein vollstaendiges Deck vortaeuschen.
  const { kept, dropped } = dropUnknownBlocks(inputBlocks)
  let blocks = kept
  if (dropped.length) notes.push(`Unbekannte Blocktypen entfernt: ${dropped.join(', ')}`)

  // 1) Wahrheits-Backstop
  scrubEvents.push(...scrubNarrative(blocks, ctx.furnitureIncluded))
  if (ctx.furnitureMode === 'none') {
    const vorher = blocks.length
    blocks = removeFurniture(blocks, scrubEvents)
    if (blocks.length !== vorher) notes.push(`Ohne Möbel: ${vorher - blocks.length} Block/Blöcke entfernt`)
  }

  // 2) Wohnungsnummer: bei genau EINER Wohnung darf keine andere Nummer im Text
  //    stehen. Das Modell schrieb schon "Apartment 303", obwohl 203 gemeint war.
  if (ctx.units.length === 1) {
    const echt = ctx.units[0].unitNumber
    const falsch = new Set<string>()
    for (const b of blocks) {
      if (b.type === 'unit' && typeof b.number === 'string' && b.number.trim() !== echt) { falsch.add(b.number.trim()); b.number = echt }
    }
    const roh = JSON.stringify(blocks)
    for (const m of roh.matchAll(/(?:Apartment|Wohnung|Einheit|Apt\.?)\s+([A-Za-z]?-?\d{1,4}[a-zA-Z]?)/g)) {
      if (m[1] !== echt) falsch.add(m[1])
    }
    if (falsch.size) {
      let txt = roh
      for (const f of falsch) {
        txt = txt.replace(new RegExp(`((?:Apartment|Wohnung|Einheit|Apt\\.?)\\s+)${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), `$1${echt}`)
      }
      blocks = JSON.parse(txt) as Block[]
      notes.push(`Falsche Wohnungsnummer(n) korrigiert: ${[...falsch].join(', ')} → ${echt}`)
    }
  }

  // 3) Preiszeilen deterministisch setzen (die KI rechnet NICHTS).
  const withPrice = ctx.units.filter(u => u.priceLines.length)
  if (withPrice.length) {
    const unitBlocks = blocks.filter(b => b.type === 'unit')
    if (withPrice.length === 1 && unitBlocks.length) {
      for (const ub of unitBlocks) { ub.priceLines = withPrice[0].priceLines; delete ub.priceMain; delete ub.priceSub }
    } else {
      for (const ub of unitBlocks) {
        const key = normKey(ub.number) || normKey(ub.nickname)
        const u = withPrice.find(x => x.unitKey === key)
        if (u) { ub.priceLines = u.priceLines; delete ub.priceMain; delete ub.priceSub }
      }
    }
  }

  // 4) Zahlungsplan: liegt einer vor, gilt der konkrete Stufenplan — ein vager
  //    KI-Block wird ersetzt. Ohne Plan bleibt der KI-Block stehen.
  if (ctx.paymentSchedule) {
    const basis = withPrice.length === 1 && withPrice[0].price
      ? { net: withPrice[0].price!.netTotal, gross: withPrice[0].price!.gross } : null
    const idx = blocks.findIndex(b => b.type === 'payment')
    let at = idx >= 0 ? idx : blocks.findIndex(b => b.type === 'cta')
    if (idx >= 0) {
      for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].type === 'payment') { blocks.splice(i, 1); if (i < at) at-- }
    } else if (at < 0) at = blocks.length
    blocks.splice(at, 0, buildPaymentBlock(ctx.paymentSchedule, basis))
    notes.push(`Zahlungsplan deterministisch gesetzt (${ctx.paymentSource})`)
  }

  // 5) Netto/MwSt/Brutto-Box in die Zahlungsplan-Bloecke.
  const summaries = ctx.units.filter(u => u.priceSummary)
  if (summaries.length) {
    for (const pb of blocks.filter(b => b.type === 'payment')) {
      if (summaries.length === 1) { pb.priceSummary = summaries[0].priceSummary; continue }
      const hay = normKey(JSON.stringify({ k: pb.kicker, h: pb.headline }))
      const u = summaries.find(x => x.unitKey && hay.includes(x.unitKey))
      if (u) pb.priceSummary = u.priceSummary
    }
  }

  // 6) Grundrisse — deterministisch, je Wohnung genau einer.
  // Bis hierher wurden Bloecke nur BESTUECKT, nie erzeugt: hatte die KI keinen
  // floorplan-Block gebaut (er ist im Systemprompt optional), bekam das Deck
  // keinen Grundriss, obwohl ein Plan hinterlegt war. Und die Zuordnung lief
  // ueber die Listenposition, wodurch bei zwei Wohnungen der Plan der Nachbarin
  // im Block stehen konnte.
  const withPlan = ctx.units.filter(u => u.floorplanUrl)
  if (withPlan.length) {
    let fpBlocks = blocks.filter(b => b.type === 'floorplan')

    // Fehlende Bloecke ergaenzen — auch den allerersten.
    if (fpBlocks.length < withPlan.length) {
      const proto = fpBlocks[fpBlocks.length - 1]
      const neue: Block[] = Array.from({ length: withPlan.length - fpBlocks.length }, () => {
        if (!proto) return { type: 'floorplan', kicker: 'Grundriss & Flächen' }
        const clone = JSON.parse(JSON.stringify(proto)) as Block
        // Zahlen und Aufzaehlung des Prototyps gehoeren zur ANDEREN Wohnung.
        delete clone.stats; delete clone.bullets; delete clone.rooms; delete clone.planNote
        return clone
      })
      // Nach dem letzten unit-Block einsetzen, sonst vor payment bzw. cta.
      let at = blocks.length
      if (proto) at = blocks.indexOf(proto) + 1
      else {
        const letzterUnit = blocks.map((b, i) => ({ b, i })).filter(x => x.b.type === 'unit').pop()
        if (letzterUnit) at = letzterUnit.i + 1
        else {
          const pay = blocks.findIndex(b => b.type === 'payment')
          const cta = blocks.findIndex(b => b.type === 'cta')
          at = pay >= 0 ? pay : (cta >= 0 ? cta : blocks.length)
        }
      }
      blocks.splice(at, 0, ...neue)
      fpBlocks = blocks.filter(b => b.type === 'floorplan')
      notes.push(`${neue.length} Grundriss-Block/Blöcke ${proto ? 'ergänzt' : 'angelegt'} (je Wohnung einer)`)
    }

    // Ueberzaehlige Bloecke entfernen: mehr Grundriss-Bloecke als Wohnungen mit
    // Plan bedeutet Dubletten — derselbe Plan zweimal hintereinander (bei Infinity
    // 203 nach einem Feinschliff passiert).
    if (fpBlocks.length > withPlan.length) {
      const zuviel = fpBlocks.slice(withPlan.length)
      blocks = blocks.filter(b => !zuviel.includes(b))
      fpBlocks = blocks.filter(b => b.type === 'floorplan')
      notes.push(`${zuviel.length} doppelte(r) Grundriss-Block entfernt`)
    }

    // Zuordnung ueber die Wohnungsnummer im Block, nicht ueber die Position.
    const offen = [...withPlan]
    const zuweisen = (fb: Block, u: typeof withPlan[number]) => {
      fb.image = u.floorplanUrl!
      delete fb.rooms
      if (u.floorplanNote) fb.planNote = u.floorplanNote
      else delete fb.planNote
      if (withPlan.length > 1) {
        fb.kicker = `Grundriss & Flächen · ${u.unitNumber}`
        if (!fb.headline || /grundriss/i.test(String(fb.headline))) fb.headline = `${u.unitNumber} — Grundriss`
      }
    }
    // Erst die Bloecke, die ihre Wohnung selbst nennen.
    for (const fb of fpBlocks) {
      const hay = normKey(`${fb.number ?? ''} ${fb.kicker ?? ''} ${fb.headline ?? ''}`)
      const idx = offen.findIndex(u => u.unitKey && hay.includes(u.unitKey))
      if (idx >= 0) { zuweisen(fb, offen[idx]); offen.splice(idx, 1) }
    }
    // Rest der Reihe nach.
    for (const fb of fpBlocks) {
      if (fb.image) continue
      const u = offen.shift()
      if (u) zuweisen(fb, u)
    }
  }
  // Ein PDF als Grundriss ist im Deck unsichtbar (der Renderer nutzt <img> und
  // faellt still auf eine graue Flaeche zurueck). Bild entwerten, damit der Block
  // gleich mit entfernt wird — und im Bericht auftaucht.
  for (const b of blocks) {
    if (b.type !== 'floorplan' || typeof b.image !== 'string') continue
    if (/\.(pdf|docx?|xlsx?)($|\?|#)/i.test(b.image)) {
      notes.push('Grundriss-Block mit nicht darstellbarer Quelle (PDF) entfernt')
      delete b.image
    }
  }
  // Ein Grundriss-Block ohne Bild ist ein leerer Kasten mit Ueberschrift. Die
  // Entfernung wird protokolliert, statt still zu passieren — sonst merkt niemand,
  // dass ein Grundriss fehlt.
  {
    const ohne = blocks.filter(b => b.type === 'floorplan' && !b.image).length
    if (ohne) {
      blocks = blocks.filter(b => b.type !== 'floorplan' || b.image)
      notes.push(`${ohne} Grundriss-Block/Blöcke ohne Plan entfernt`)
    }
  }

  // 7) Marina-Abschnitte tragen IMMER das Modellbild — sonst landet dort ein
  //    beliebiges Innenraum-Render.
  for (const b of blocks) {
    const txt = `${b.kicker ?? ''} ${b.headline ?? ''}`
    if (/marina/i.test(txt) && b.type !== 'marina' && b.image !== ctx.marinaImage) {
      b.image = ctx.marinaImage
      notes.push('Marina-Abschnitt: Modellbild gesetzt')
    }
  }

  return { blocks, scrubEvents, notes }
}

const normKey = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

export { eur }
