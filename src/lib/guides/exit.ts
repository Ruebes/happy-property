// Erklärtexte für vier Blöcke der Kundenseite:
//   exit      - unter der Verkaufstabelle (Abschnitt 10 „Was beim Verkauf übrig bleibt")
//   costKpis  - unter den vier Kacheln von Abschnitt 10b („Was dich die Strategie kostet")
//   moneyFlow - unter der Tabelle Kapitalfluss (Abschnitt 10b)
//   taxes     - unter den Steuer-Kacheln (Abschnitt 8)
// Inhalt nach der geprüften Vorlage (verify_exit.json, 8.10.26) und dem Review
// vom 8.10.26. Jede Zahl im Text ist eine Zahl, die so auf der Seite steht
// (dieselben gerundeten Werte) oder sich aus zwei angezeigten Zahlen ergibt,
// jede Rechnung geht mit diesen Werten auf. checkGuides rechnet sie nach.
import type { CustomerAnalytics } from '../analytics'
import { eur, num, type Guide, type GuideCtx, type GuideItem } from './types'

type Vars = Record<string, string | number>
const B = 'strategie.guide'

// Zeilen der Tabelle Kapitalfluss: Bezeichnung aus analytics.ts -> Schlüssel im Sprachfragment
const MF = {
  start: 'Startkapital',
  bound: 'In Immobilien gebunden',
  rent: 'Mieteinnahmen',
  costs: 'Laufende Kosten',
  interest: 'Zinsen',
  amort: 'Tilgung',
  taxes: 'Steuern und Abgaben',
  vat: 'MwSt-Erstattung',
  refi: 'Refinanzierung',
  sale: 'Verkaufserlöse',
  liq: 'Liquidität am Ende',
} as const
type MfKey = keyof typeof MF
const MF_KEYS = Object.keys(MF) as MfKey[]

const tr = (ctx: GuideCtx, id: string, key: string, vars?: Vars): string =>
  String(ctx.t(`${B}.${id}.${key}`, vars ?? {}))
const item = (ctx: GuideCtx, id: string, key: string, vars?: Vars): GuideItem => ({
  label: tr(ctx, id, `items.${key}.label`),
  text: tr(ctx, id, `items.${key}.text`, vars),
})
const pit = (ctx: GuideCtx, id: string, key: string, vars?: Vars) => tr(ctx, id, `pitfalls.${key}`, vars)
const mt = (ctx: GuideCtx, id: string, key: string, vars?: Vars) => tr(ctx, id, `m.${key}`, vars)
const ex = (ctx: GuideCtx, id: string, key: string, vars?: Vars) => tr(ctx, id, `ex.${key}`, vars)

// Dezimalzahl in der Sprache des Textes (de: 5,16 / en: 5.16)
const numL = (ctx: GuideCtx, n: number) => tr(ctx, 'exit', 'm.lang') === 'en' ? String(n) : num(n)

// „A, B und C" bzw. „A, B and C"
function joinList(ctx: GuideCtx, id: string, words: string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} ${mt(ctx, id, 'w_and')} ${words[words.length - 1]}`
}
// Aufeinanderfolgende Jahre als Läufe: [2026, 2027, 2028, 2031] -> [[2026, 2027, 2028], [2031]]
function yearRuns(ys: number[]): number[][] {
  const s = [...new Set(ys)].sort((x, y) => x - y)
  const runs: number[][] = []
  for (const y of s) {
    const last = runs[runs.length - 1]
    if (last && last[last.length - 1] === y - 1) last.push(y)
    else runs.push([y])
  }
  return runs
}
// „den Jahren 2027 bis 2036" bzw. „den Jahren 2026, 2028 und 2030 bis 2033"
// (ein einzelnes Jahr hat eigene Sätze)
function yearsPhrase(ctx: GuideCtx, id: string, ys: number[]): string {
  if (ys.length === 1) return String(ys[0])
  const parts = yearRuns(ys).flatMap(r => r.length >= 3
    ? [`${r[0]} ${mt(ctx, id, 'w_to')} ${r[r.length - 1]}`]
    : r.map(String))
  return mt(ctx, id, 'yearsMany', { list: joinList(ctx, id, parts) })
}
// „2026 bis 2033" bzw. „also nur das Jahr 2026"
const periodOf = (ctx: GuideCtx, id: string) => ctx.a.summary.firstYear === ctx.a.summary.lastYear
  ? mt(ctx, id, 'periodOne', { y: ctx.a.summary.firstYear })
  : mt(ctx, id, 'periodRange', { first: ctx.a.summary.firstYear, last: ctx.a.summary.lastYear })

// ── Gemeinsame Größen (alle aus den angezeigten, gerundeten Werten) ─────────
const mf = (a: CustomerAnalytics, k: MfKey): number | null => {
  const row = a.moneyFlow.find(m => m.label === MF[k])
  return row ? row.amount : null
}
// Obergrenze der Kaufnebenkosten (1 % des Kaufpreises je Wohnung, aufgerundet)
const nkBound = (a: CustomerAnalytics) =>
  a.properties.filter(p => !p.model).reduce((s, p) => s + Math.ceil(p.gross / 100), 0)
const growthOf = (ctx: GuideCtx) => ctx.params.reinvestEnabled ? ctx.params.reinvestAppreciationPct : ctx.params.growth
const cumMin = (a: CustomerAnalytics) => Math.min(0, ...a.cashflow.map(c => c.cumulative))

// Ohne Reinvestment gibt es zwei Rechenwege, wenn am Ende noch Raten offen sind:
//  - Liquiditätsrechnung (Raten nach der Übergabe, die Wohnungskarten tragen
//    openRest): „In Immobilien gebunden" enthält nur Gezahltes, das für spätere
//    Raten zurückgelegte Eigenkapital steht nur in „Liquidität am Ende" (heldOut).
//  - sonst: „In Immobilien gebunden" zählt das ganze geplante Eigenkapital, auch
//    den nie gezahlten Teil, und derselbe Teil steht noch einmal in
//    „Liquidität am Ende" (dbl, Review 8.10.26).
interface FlowFacts {
  start: number; bound: number; liq: number; nk: number
  heldOut: boolean; dbl: boolean
  own: number        // eigenes Geld, das der Plan braucht: gezahlt + zurückgelegt, mit Kaufnebenkosten
  unusedAmt: number  // Startkapital, das in keiner Zeile auftaucht (nur ohne Reinvestment)
}
function flowFacts(a: CustomerAnalytics): FlowFacts {
  const start = mf(a, 'start') ?? 0
  const bound = -(mf(a, 'bound') ?? 0)
  const liq = mf(a, 'liq') ?? 0
  const heldOut = !a.reinvest && liq > 0 && a.properties.some(p => (p.openRest ?? 0) > 0)
  const dbl = !a.reinvest && liq > 0 && !heldOut
  const own = bound + (heldOut ? liq : 0)
  return { start, bound, liq, nk: nkBound(a), heldOut, dbl, own, unusedAmt: a.reinvest ? 0 : start - own }
}
const unusedStart = (f: FlowFacts) => f.unusedAmt > 1
// „In Immobilien gebunden" größer als das Startkapital nur wegen der Kaufnebenkosten
const boundByCosts = (a: CustomerAnalytics, f: FlowFacts) => !a.reinvest && !f.dbl && f.bound > f.start && f.bound - f.start <= f.nk
// Ohne Reinvestment zahlst du die Kaufnebenkosten zusätzlich zum Startkapital
const costsOnTop = (a: CustomerAnalytics, f: FlowFacts) => !a.reinvest && !f.dbl && f.own > f.start && f.own - f.start <= f.nk
// Startkapital reicht nicht für das Eigenkapital aller Käufe: ein Kredit deckt die Lücke
const ekGap = (f: FlowFacts) => f.own - f.start > f.nk
const cashCredit = (a: CustomerAnalytics, f: FlowFacts) => ekGap(f) || a.properties.some(p => (p.openCredit ?? 0) > 0)

// „Zusätzlich nötiges Kapital" ohne Reinvestment: tiefste Stelle des
// aufsummierten Cashflows, je nach Stand von analytics.ts abzüglich des nicht
// gebrauchten Startkapitals. Erkannt an den angezeigten Zahlen.
type AddKind = 'plain' | 'unused' | 'old' | 'other'
function addKindOf(a: CustomerAnalytics, f: FlowFacts): AddKind {
  if (a.reinvest) return 'other'
  const add = a.cost.additionalEquity, lowest = -cumMin(a)
  if (add === lowest) return 'plain'
  const net = Math.max(0, lowest - Math.max(0, f.unusedAmt))
  if (add < lowest && Math.abs(add - net) <= 1 && f.unusedAmt > 1) return 'unused'
  if (add === 0 && lowest > 0) return 'old'
  return 'other'
}
// Jahr der knappsten Stelle, nur wenn es eindeutig zur Kachel passt
function gapYear(a: CustomerAnalytics): number | null {
  const add = a.cost.additionalEquity
  if (!(add > 0)) return null
  if (!a.reinvest) {
    const min = cumMin(a)
    if (-min !== add) return null
    return a.cashflow.find(c => c.cumulative === min)?.year ?? null
  }
  if (!a.liquidity.length) return null
  const low = Math.min(...a.liquidity.map(l => l.cash))
  if (Math.round(Math.abs(Math.min(0, low))) !== add) return null
  return a.liquidity.find(l => l.cash === low)?.year ?? null
}
const notReadyCount = (a: CustomerAnalytics) => a.exits.filter(e => {
  const p = a.properties.find(q => q.name === e.name)
  return !!p && p.readyYear > e.year
}).length
const openRestSum = (a: CustomerAnalytics) => a.exits.length
  ? a.properties.filter(p => !p.model && p.openRestFromSale && p.openRest && p.readyYear <= a.exits[0].year)
    .reduce((s, p) => s + (p.openRest ?? 0), 0)
  : 0
const sumPosVat = (a: CustomerAnalytics) => a.exits.filter(e => e.vat > 0).reduce((s, e) => s + e.vat, 0)
const sumNegVat = (a: CustomerAnalytics) => a.exits.filter(e => e.vat < 0).reduce((s, e) => s - e.vat, 0)
const costPctOf = (ctx: GuideCtx) =>
  Math.round(((ctx.params.sellCostPct + ctx.params.lawyerPct) * 1.19 + 0.4) * 100) / 100
const negCashYears = (a: CustomerAnalytics) => a.cashflow.filter(c => c.cashflow < 0)
// Wohnungen, die im Reinvestment-Modus bis zum Ende behalten werden
const keptUnits = (a: CustomerAnalytics) => a.properties.filter(p => p.soldYear == null).length

// ── 10 Verkauf ───────────────────────────────────────────────────────────────
function exitGuide(ctx: GuideCtx): Guide | null {
  const { a, params } = ctx
  if (!a.exits.length) return null
  const id = 'exit'
  const tot = a.exitTotal
  const joint = tot != null
  const withVat = a.exits.some(e => e.vat)
  const f = flowFacts(a)

  const intro = tr(ctx, id, 'intro', {
    mode: joint ? mt(ctx, id, 'introJoint')
      : mt(ctx, id, 'introSingle', { kept: keptUnits(a) > 0 ? mt(ctx, id, 'introKept') : '' }),
  })

  // Verkaufsjahr: das Jahr des ersten Kaufs zählt mit
  const own = a.properties.filter(p => !p.model)
  const firstBuy = own.length ? Math.min(...own.map(p => p.buyYear)) : a.summary.firstYear
  const n = params.exitAfterYears
  const yearOk = joint && firstBuy === a.summary.firstYear && a.exits[0].year === firstBuy + n - 1
  const yearItem = !joint ? item(ctx, id, 'yearSingle')
    : !yearOk ? item(ctx, id, 'yearGeneric')
      : item(ctx, id, n === 1 ? 'yearOne' : 'year', { first: firstBuy, n, year: a.exits[0].year })

  const taxExtra = [
    params.holder === 'firma' ? mt(ctx, id, 'taxAllowFirm') : mt(ctx, id, 'taxAllowPriv'),
    params.holder === 'privat' && params.res === 'de' ? mt(ctx, id, 'taxDe') : '',
    params.holder === 'firma' && joint ? mt(ctx, id, 'taxDivJoint') : '',
    mt(ctx, id, joint ? 'taxWhereJoint' : 'taxWhereSingle'),
  ].join('')

  // Zeile „Zusammen": was zu den Kacheln oben passt
  const totalChecks: string[] = []
  if (tot) {
    if (a.summary.exitNet === tot.net) totalChecks.push(mt(ctx, id, 'totalNet'))
    const dd = Math.abs(tot.debt - a.summary.debt)
    if (dd === 0) totalChecks.push(mt(ctx, id, 'totalDebtSame'))
    else if (dd === 1) totalChecks.push(mt(ctx, id, 'totalDebtRound', { d: eur(1) }))
    if (tot.value === a.summary.portfolioValue) totalChecks.push(mt(ctx, id, 'totalValueSame'))
    else if (notReadyCount(a) > 0) totalChecks.push(mt(ctx, id, 'totalValueDiff'))
  }

  const items: GuideItem[] = [
    item(ctx, id, 'obj'),
    yearItem,
    item(ctx, id, 'value'),
    item(ctx, id, 'debt', {
      ri: a.reinvest ? mt(ctx, id, 'debtRi') : '',
      cash: cashCredit(a, f) ? mt(ctx, id, 'debtCash') : '',
    }),
    item(ctx, id, 'costs', { joint: joint ? mt(ctx, id, 'costsJoint') : '' }),
    ...(withVat ? [item(ctx, id, 'vat')] : []),
    item(ctx, id, 'tax', { cpi: numL(ctx, params.cpiPct), extra: taxExtra }),
    item(ctx, id, 'net', {
      formula: mt(ctx, id, withVat ? 'netFormulaVat' : 'netFormula'),
      joint: joint ? mt(ctx, id, 'netJoint') : '',
    }),
    ...(tot ? [item(ctx, id, 'total', {
      cols: mt(ctx, id, withVat ? 'totalColsVat' : 'totalCols'),
      checks: totalChecks.length ? ` ${totalChecks.join(' ')}` : '',
    })] : []),
    ...(tot && tot.equityBack > 0 ? [item(ctx, id, 'eb')] : []),
  ]

  // Beispiel: Zeile „Zusammen" bzw. erste Zeile nachrechnen
  const r = tot ?? a.exits[0]
  let example: string | null = null
  if (r.tax != null && r.net != null) {
    const year = a.exits[0].year
    const eb = tot && tot.equityBack > 0 ? tot.equityBack : 0
    const ebSum = r.net + eb
    // Wofür der Verkaufspreis nicht reicht (nur die Abzüge, die es gibt)
    const cover = joinList(ctx, id, [
      r.debt > 0 ? mt(ctx, id, 'w_debt') : '',
      r.costs > 0 ? mt(ctx, id, 'w_costs') : '',
      r.vat > 0 ? mt(ctx, id, 'w_vat') : '',
      r.tax > 0 ? mt(ctx, id, 'w_tax') : '',
    ].filter(Boolean))
    let end: string
    let ebTxt = ''
    if (r.net >= 0) {
      end = ex(ctx, id, 'endPos', { year })
      if (eb > 0) ebTxt = ex(ctx, id, 'eb', { eb: eur(eb), sum: eur(ebSum) })
    } else if (a.reinvest) {
      end = ex(ctx, id, 'endNegRi', { year, list: cover })
    } else if (eb > 0) {
      end = ex(ctx, id, 'endNegShort', { list: cover })
      ebTxt = ebSum >= 0
        ? ex(ctx, id, 'ebCovers', { eb: eur(eb), sum: eur(ebSum) })
        : ex(ctx, id, 'ebShort', { eb: eur(eb), year, s: eur(-ebSum) })
    } else {
      end = ex(ctx, id, 'endNeg', { year, list: cover })
    }
    example = ex(ctx, id, 'main', {
      row: ex(ctx, id, tot ? 'rowTotal' : 'rowFirst'),
      value: eur(r.value), debt: eur(r.debt), costs: eur(r.costs),
      vat: r.vat > 0 ? ex(ctx, id, 'vatMinus', { v: eur(r.vat) }) : r.vat < 0 ? ex(ctx, id, 'vatPlus', { v: eur(-r.vat) }) : '',
      tax: eur(r.tax), net: eur(r.net), end, eb: ebTxt,
    })
  }

  const meaning: string[] = []
  const g = growthOf(ctx)
  meaning.push(g > 0 ? mt(ctx, id, 'growth', { g: numL(ctx, g) }) : mt(ctx, id, 'growth0'))
  if (tot && tot.value > 0 && tot.net > 0) {
    const words = [
      tot.debt > 0 ? mt(ctx, id, 'w_debt') : '',
      tot.costs > 0 ? mt(ctx, id, 'w_costs') : '',
      tot.vat > 0 ? mt(ctx, id, 'w_vat') : '',
      tot.tax > 0 ? mt(ctx, id, 'w_tax') : '',
    ].filter(Boolean)
    if (words.length) meaning.push(mt(ctx, id, 'cent', { cent: Math.round(tot.net / tot.value * 100), list: joinList(ctx, id, words) }))
  }
  meaning.push(mt(ctx, id, 'costPct', {
    broker: numL(ctx, params.sellCostPct), lawyer: numL(ctx, params.lawyerPct), pct: numL(ctx, costPctOf(ctx)),
  }))
  if (a.exits.some(e => e.vat > 0)) meaning.push(mt(ctx, id, 'vatBack', { v: eur(sumPosVat(a)) }))
  const nNeg = a.exits.filter(e => e.vat < 0).length
  if (nNeg > 0) meaning.push(mt(ctx, id, nNeg === 1 ? 'vatOpen1' : 'vatOpenN', { n: nNeg, v: eur(sumNegVat(a)) }))
  const rest = tot ? openRestSum(a) : 0
  if (rest > 0) meaning.push(mt(ctx, id, 'openRest', { v: eur(rest) }))
  const nr = notReadyCount(a)
  if (nr > 0) meaning.push(mt(ctx, id, nr === 1 ? 'notReady1' : 'notReadyN', { n: nr }))
  const taxSum = tot ? tot.tax : a.exits.reduce((s, e) => s + (e.tax ?? 0), 0)
  if (params.res === 'de' && params.holder === 'privat' && taxSum > 0) {
    meaning.push(mt(ctx, id, 'deTax', { rate: numL(ctx, params.deTaxPct), always: joint ? mt(ctx, id, 'deTaxAlways') : '' }))
  }
  if (params.holder === 'firma' && tot && tot.tax > a.taxKpis.exit) {
    meaning.push(mt(ctx, id, 'firmJoint', {
      payout: numL(ctx, params.divPayoutPct), rate: numL(ctx, params.divTaxPct), div: eur(tot.tax - a.taxKpis.exit),
      rest: params.divPayoutPct < 100 ? mt(ctx, id, 'firmJointRest') : '',
    }))
  }
  if (!joint && params.holder === 'firma') meaning.push(mt(ctx, id, 'firmSingle'))

  const pitfalls = [
    pit(ctx, id, 'profit'),
    ...(joint ? [pit(ctx, id, 'empty')] : []),
    pit(ctx, id, 'debt'),
    ...(withVat ? [pit(ctx, id, 'vat')] : []),
    ...(tot && tot.equityBack > 0 ? [pit(ctx, id, 'eb')] : []),
    ...(joint ? [pit(ctx, id, 'firstYear')] : []),
    pit(ctx, id, 'broker'),
    pit(ctx, id, 'value'),
  ]
  return { heading: tr(ctx, id, 'heading'), intro, items, example, meaning, pitfalls }
}

// ── 10b Kacheln ──────────────────────────────────────────────────────────────
// Was der Vermögenszuwachs vom Netto-Vermögen abzieht. Je nach Stand von
// analytics.ts ist das das Startkapital, „In Immobilien gebunden" oder beides
// zusammen mit „Liquidität am Ende". Erkannt wird es an den angezeigten Zahlen.
type GainKind = 'ek' | 'bound' | 'boundLiq' | 'other'
function gainKindOf(a: CustomerAnalytics, f: FlowFacts): { kind: GainKind; sub: number } {
  const sub = a.summary.netWorth - a.cost.wealthGain
  if (sub === Math.round(a.summary.originalEquity)) return { kind: 'ek', sub }
  if (!a.reinvest && sub === f.bound) return { kind: 'bound', sub }
  // Bei Doppelzählung stünde das zurückgelegte Geld zweimal im Abzug: nicht erklären
  if (!a.reinvest && f.heldOut && sub === f.bound + f.liq) return { kind: 'boundLiq', sub }
  return { kind: 'other', sub }
}

function costKpisGuide(ctx: GuideCtx): Guide {
  const { a } = ctx
  const id = 'costKpis'
  const tot = a.exitTotal
  const f = flowFacts(a)
  const add = a.cost.additionalEquity
  const ak = addKindOf(a, f)
  const lowest = -cumMin(a)
  const gk = gainKindOf(a, f)
  const when = mt(ctx, id, tot ? 'whenSale' : 'whenEnd')

  const intro = tr(ctx, id, 'intro', {
    period: periodOf(ctx, id),
    sale: tot ? mt(ctx, id, 'introSale', { last: a.summary.lastYear }) : '',
  })

  const nkAdd = boundByCosts(a, f) ? mt(ctx, id, 'addNk') : ''
  const addItem = a.reinvest ? item(ctx, id, add > 0 ? 'addRi' : 'add0Ri')
    : add > 0 ? item(ctx, id, ak === 'unused' ? 'addNet' : 'add', { nk: nkAdd })
      : lowest === 0 ? item(ctx, id, 'add0')
        : ak === 'unused' ? item(ctx, id, 'add0Unused')
          : item(ctx, id, 'add0Old')
  const gainItem = gk.kind === 'other' ? item(ctx, id, 'gainOther')
    : a.reinvest ? item(ctx, id, 'gainRi')
      : gk.kind === 'ek' ? item(ctx, id, 'gain', { nk: costsOnTop(a, f) ? mt(ctx, id, 'gainNk') : '' })
        : gk.kind === 'boundLiq' ? item(ctx, id, 'gainBoundLiq', { v: eur(gk.sub) })
          : item(ctx, id, f.heldOut ? 'gainBoundHeld' : f.dbl ? 'gainBoundDouble' : 'gainBound', { v: eur(gk.sub), when })
  const items: GuideItem[] = [
    item(ctx, id, 'equity', { ri: a.reinvest ? mt(ctx, id, 'equityRi') : '' }),
    addItem,
    item(ctx, id, 'interest', { ri: a.reinvest ? mt(ctx, id, 'interestRi') : '' }),
    gainItem,
  ]

  // Beispiel: Vermögenszuwachs nachrechnen
  const nw = a.summary.netWorth, gain = a.cost.wealthGain
  const unused = unusedStart(f)
  let example: string | null = null
  if (gk.kind !== 'other') {
    let sale = ''
    if (tot) {
      const ded = tot.costs + tot.vat + tot.tax
      const words = [
        tot.costs > 0 ? mt(ctx, id, 'w_costs') : '',
        tot.vat > 0 ? mt(ctx, id, 'w_vat') : '',
        tot.tax > 0 ? mt(ctx, id, 'w_tax') : '',
      ].filter(Boolean)
      const list = joinList(ctx, id, words) + (tot.vat < 0 ? mt(ctx, id, 'w_vatPlusSuffix') : '')
      const eb = tot.equityBack > 0 ? ex(ctx, id, 'eb', { eb: eur(tot.equityBack) }) : ''
      if (nw - ded !== tot.net + tot.equityBack || !words.length) sale = ex(ctx, id, 'saleGeneric')
      else if (tot.net < 0) {
        const cover = joinList(ctx, id, [
          tot.debt > 0 ? mt(ctx, id, 'w_debt') : '', tot.costs > 0 ? mt(ctx, id, 'w_costs') : '',
          tot.vat > 0 ? mt(ctx, id, 'w_vat') : '', tot.tax > 0 ? mt(ctx, id, 'w_tax') : '',
        ].filter(Boolean))
        const rem = tot.net + tot.equityBack
        sale = ded >= 0
          ? ex(ctx, id, 'saleDedNeg', {
            nw: eur(nw), ded: eur(ded), list, cover, v: eur(-tot.net),
            eb: tot.equityBack > 0 ? ex(ctx, id, rem >= 0 ? 'ebNegCovers' : 'ebNegShort', { eb: eur(tot.equityBack), sum: eur(rem), s: eur(-rem) }) : '',
          })
          : ex(ctx, id, 'saleGeneric')
      } else if (ded >= 0) sale = ex(ctx, id, 'saleDed', { nw: eur(nw), ded: eur(ded), list, net: eur(tot.net), eb })
      else sale = ex(ctx, id, 'saleAdd', { nw: eur(nw), add: eur(-ded), list: joinList(ctx, id, words), net: eur(tot.net), eb })
    }
    const v = eur(gk.sub)
    example = gain < 0 && !unused
      ? ex(ctx, id, 'mainNeg', { nw: eur(nw), sub: mt(ctx, id, `subD_${gk.kind}`, { v }), minus: eur(-gain), gain: eur(gain), sale })
      : ex(ctx, id, 'main', { nw: eur(nw), sub: mt(ctx, id, `sub_${gk.kind}`, { v }), gain: eur(gain), sale })
  }

  const meaning: string[] = []
  if (add > 0) {
    const y = gapYear(a)
    const cover = !a.reinvest && ak !== 'unused' && unused
      ? (f.unusedAmt >= add ? mt(ctx, id, 'gapUnusedAll') : mt(ctx, id, 'gapUnusedPart'))
      : ''
    meaning.push(mt(ctx, id, 'gap', { v: eur(add), when: y != null ? mt(ctx, id, 'gapWhen', { y }) : '', cover }))
  }
  const neg = negCashYears(a)
  const lastCf = a.cashflow.length ? a.cashflow[a.cashflow.length - 1].cumulative : 0
  // Zuzahlung über alle Jahre gleich (bis auf Rundung) der Kachel: in den Satz zu den negativen Jahren
  const cfMerged = !a.reinvest && lastCf < 0 && add > 0 && Math.abs(-lastCf - add) <= 3
  if (!a.reinvest && neg.length) {
    const summe = -neg.reduce((s, c) => s + c.cashflow, 0)
    const d = Math.abs(add - summe)
    const same = add > 0 && d === 0 ? mt(ctx, id, 'negSame') : add > 0 && d <= 3 ? mt(ctx, id, 'negRound') : ''
    const n1 = neg.length === 1
    const why = mt(ctx, id, `${same ? 'whyOwn' : 'whyMixed'}${n1 ? '1' : 'N'}`)
    let tail = ''
    if (!same) {
      if (ak === 'old') tail = mt(ctx, id, 'negOld')
      else if (add === 0 && lowest === 0) tail = mt(ctx, id, 'negCovered')
      else if (add === 0 && ak === 'unused') tail = mt(ctx, id, lowest < summe - 3 ? 'negCoveredBoth' : 'negCoveredUnused')
      else if (add > 0) {
        const bySurplus = lowest < summe - 3
        const byUnused = ak === 'unused' && add < lowest - 1
        if (bySurplus || byUnused) tail = mt(ctx, id, bySurplus && byUnused ? 'negPartlyBoth' : byUnused ? 'negPartlyUnused' : 'negPartly')
      }
    }
    if (cfMerged) tail += mt(ctx, id, 'cfNegMerged', { v: eur(-lastCf) })
    meaning.push(n1
      ? mt(ctx, id, 'negYear1', { y: neg[0].year, v: eur(summe), same, why, tail })
      : mt(ctx, id, 'negYears', { years: yearsPhrase(ctx, id, neg.map(c => c.year)), v: eur(summe), same, why, tail }))
  }
  if (!a.reinvest && lastCf > 0) {
    const basis = a.scenarios.find(s => s.key === 'basis')
    meaning.push(mt(ctx, id, 'cfPos', { v: eur(lastCf), ref: basis && basis.cumulativeCashflow === lastCf ? mt(ctx, id, 'cfRef') : '' }))
  }
  if (!a.reinvest && lastCf < 0 && !cfMerged) meaning.push(mt(ctx, id, 'cfNeg', { v: eur(-lastCf) }))
  if (unused) meaning.push(mt(ctx, id, gk.kind === 'ek' ? 'unused' : 'unusedOk'))
  if (gk.kind === 'bound' && f.heldOut) meaning.push(mt(ctx, id, 'gainLiqWarn', { liq: eur(f.liq) }))
  const rent = mf(a, 'rent') ?? 0
  if (a.cost.interest > 0 && rent > 0) {
    const pct = Math.round(a.cost.interest / rent * 100)
    if (a.cost.interest > rent) meaning.push(mt(ctx, id, 'interestOver', { interest: eur(a.cost.interest), rent: eur(rent) }))
    else if (pct >= 1) meaning.push(mt(ctx, id, 'interestShare', { pct, interest: eur(a.cost.interest), rent: eur(rent) }))
  }

  const pitfalls = [
    pit(ctx, id, 'capital'),
    add > 0 ? pit(ctx, id, 'amount') : pit(ctx, id, 'no'),
    pit(ctx, id, a.reinvest ? 'gainRi' : 'gain'),
    pit(ctx, id, tot ? 'interestSale' : 'interest'),
    pit(ctx, id, 'amort'),
  ]
  return { heading: tr(ctx, id, 'heading'), intro, items, example, meaning, pitfalls }
}

// ── 10b Tabelle Kapitalfluss ─────────────────────────────────────────────────
function moneyFlowGuide(ctx: GuideCtx): Guide {
  const { a, params } = ctx
  const id = 'moneyFlow'
  const f = flowFacts(a)
  const hasSale = mf(a, 'sale') != null
  const ri = a.reinvest
  const when = mt(ctx, id, hasSale ? 'whenSale' : 'whenEnd')
  const gap = ekGap(f)

  const rowItem = (k: MfKey): GuideItem | null => {
    const vars: Vars = {}
    let key: string = k
    if (k === 'bound') {
      if (gap) key = 'boundGap'
      vars.mode = ri ? (f.bound <= f.start ? mt(ctx, id, 'boundRi') : '')
        : f.dbl ? mt(ctx, id, 'boundDbl', { when })
          : gap ? ''
            : f.own > f.start ? mt(ctx, id, 'boundNoRi')
              : mt(ctx, id, 'boundFromStart')
    }
    if (k === 'amort') vars.ri = ri ? mt(ctx, id, 'amortRi') : ''
    if (k === 'taxes') vars.sale = hasSale ? mt(ctx, id, 'taxesSale') : ''
    if (k === 'vat') vars.sale = a.exits.length ? mt(ctx, id, 'vatSale') : ''
    if (k === 'sale') key = a.exitTotal ? 'sale' : 'saleRi'
    if (k === 'liq') {
      if (ri) key = 'liqRi'
      else {
        vars.sale = hasSale ? mt(ctx, id, 'liqNoSaleProceeds') : ''
        vars.when = when
      }
    }
    const it = item(ctx, id, key, vars)
    // Bezeichnung genau wie in der Tabelle
    return { label: MF[k], text: it.text }
  }
  const rows = a.moneyFlow
    .map(m => MF_KEYS.find(k => MF[k] === m.label))
    .filter((k): k is MfKey => k != null)
    .map(rowItem)
    .filter((x): x is GuideItem => x != null)
  const items: GuideItem[] = [item(ctx, id, 'flow'), item(ctx, id, 'amount'), item(ctx, id, 'meaning'), ...rows]

  const zinsRow = mf(a, 'interest'), tilgRow = mf(a, 'amort')
  let example: string | null = null
  if (zinsRow && tilgRow) {
    const zins = -zinsRow, tilg = -tilgRow
    example = ex(ctx, id, 'main', { sum: eur(zins + tilg), interest: eur(zins), amort: eur(tilg) })
  }

  const meaning: string[] = []
  const erl = mf(a, 'sale')
  if (!ri && erl != null) {
    const c = a.cashflow.length ? a.cashflow[a.cashflow.length - 1].cumulative : 0
    const cf = c === 0 ? '' : mt(ctx, id, 'saleLiqCf', { cf: c > 0 ? mt(ctx, id, 'cfPlus', { v: eur(c) }) : mt(ctx, id, 'cfMinus', { v: eur(-c) }) })
    const sum = erl + f.liq
    if (erl >= 0) {
      meaning.push(mt(ctx, id, 'saleLiq', {
        net: eur(erl), liq: eur(f.liq),
        eb: f.liq > 0 ? mt(ctx, id, 'saleLiqEb', { eb: eur(f.liq), sum: eur(sum) }) : '', cf,
      }))
    } else {
      meaning.push(mt(ctx, id, 'saleLiqNeg', {
        v: eur(-erl), liq: eur(f.liq),
        eb: f.liq > 0 ? mt(ctx, id, sum >= 0 ? 'saleLiqNegEb' : 'saleLiqNegEbShort', { eb: eur(f.liq), sum: eur(sum), s: eur(-sum) }) : '', cf,
      }))
    }
  }
  if (f.dbl) {
    meaning.push(mt(ctx, id, 'boundDouble', { bound: eur(f.bound), liq: eur(f.liq), when, paid: eur(f.bound - f.liq) }))
  }
  if (gap) {
    meaning.push(mt(ctx, id, 'boundGap', {
      bound: eur(f.bound), diff: eur(f.bound - f.start),
      nk: ri ? '' : mt(ctx, id, 'gapNkOwn'),
      where: a.exitTotal ? mt(ctx, id, 'gapWhereSale') : '',
      int: params.interest > 0 ? mt(ctx, id, 'gapInt') : '',
    }))
  } else if (boundByCosts(a, f)) {
    meaning.push(mt(ctx, id, 'boundCosts', {
      bound: eur(f.bound), diff: eur(f.bound - f.start),
      gain: a.summary.netWorth - a.cost.wealthGain === f.start ? mt(ctx, id, 'boundCostsGain') : '',
    }))
  } else if (ri && f.bound > f.start) {
    meaning.push(mt(ctx, id, 'boundCostsRi', { bound: eur(f.bound), diff: eur(f.bound - f.start) }))
  }
  if (f.bound < f.start && ri) {
    const restV = f.start - f.bound
    const res = params.minimumCashReserve
    meaning.push(mt(ctx, id, 'boundLessRi', {
      bound: eur(f.bound), rest: eur(restV),
      reserve: res > 0 && restV === res ? mt(ctx, id, 'boundLessRiReserveEq')
        : res > 0 && restV > res ? mt(ctx, id, 'boundLessRiReserve', { r: eur(res) }) : '',
    }))
  }
  if (f.bound < f.start && f.heldOut) {
    const sum = f.bound + f.liq
    meaning.push(mt(ctx, id, 'boundLessHeld', {
      bound: eur(f.bound), liq: eur(f.liq), when,
      sum: sum > f.start && sum - f.start <= f.nk ? mt(ctx, id, 'boundLessHeldSum', { sum: eur(sum), start: eur(f.start), nk: eur(sum - f.start) }) : '',
    }))
  }
  if (unusedStart(f)) meaning.push(mt(ctx, id, 'unused'))
  const vatIn = mf(a, 'vat')
  if (vatIn != null && a.surplusWithVat && a.cashflowRows.some(r => (r.toPayments ?? 0) > 0)) {
    meaning.push(mt(ctx, id, 'vatPays'))
  }
  const vatOut = a.exitTotal ? a.exitTotal.vat : a.exits.reduce((s, e) => s + e.vat, 0)
  if (vatIn != null && vatOut > 0) meaning.push(mt(ctx, id, 'vatBack', { in: eur(vatIn), out: eur(vatOut) }))
  const taxRow = mf(a, 'taxes')
  if (taxRow != null && taxRow > 0) meaning.push(mt(ctx, id, 'taxGreen', { v: eur(taxRow) }))
  const refi = mf(a, 'refi')
  if (refi != null) meaning.push(mt(ctx, id, 'refi', { v: eur(refi) }))

  // Die Erklärspalte der Tabelle nennt die Steuer in Deutschland (noch) nicht
  const taxMeaning = a.moneyFlow.find(m => m.label === MF.taxes)?.meaning ?? ''
  const pitfalls = [
    pit(ctx, id, 'notAccount'),
    ...(!ri ? [pit(ctx, id, 'liq')] : []),
    pit(ctx, id, 'bound'),
    ...(f.dbl ? [pit(ctx, id, 'unpaid', { liq: eur(f.liq) })] : []),
    pit(ctx, id, 'amort'),
    ...(a.taxKpis.de !== 0 && !/Deutschland/.test(taxMeaning) ? [pit(ctx, id, 'taxDe')] : []),
    ...(vatIn != null ? [pit(ctx, id, 'vat')] : []),
    pit(ctx, id, 'tile'),
  ]
  return { heading: tr(ctx, id, 'heading'), intro: tr(ctx, id, 'intro'), items, example, meaning, pitfalls }
}

// ── 8 Steuern ────────────────────────────────────────────────────────────────
function taxesGuide(ctx: GuideCtx): Guide {
  const { a, params } = ctx
  const id = 'taxes'
  const k = a.taxKpis
  const firm = params.holder === 'firma'
  const joint = a.exitTotal != null
  // Steuer auf die Ausschüttung des Verkaufserlöses (nur Firma, gemeinsamer Verkauf)
  const divSale = firm && a.exitTotal && a.exitTotal.tax > k.exit ? a.exitTotal.tax - k.exit : 0

  const intro = tr(ctx, id, 'intro', {
    period: periodOf(ctx, id),
    sale: k.exit ? mt(ctx, id, joint ? 'introSale' : 'introSaleSingle') : '',
  })

  const items: GuideItem[] = [
    firm ? item(ctx, id, 'incomeFirm') : item(ctx, id, 'income', { cy: params.res === 'cy' ? mt(ctx, id, 'incomeCy') : '' }),
    item(ctx, id, 'total'),
    item(ctx, id, 'year'),
    ...(k.exit ? [item(ctx, id, 'exit', {
      what: mt(ctx, id, joint ? 'exitWhatJoint' : 'exitWhatSingle'),
      allow: mt(ctx, id, firm ? 'exitAllowFirm' : 'exitAllowPriv'),
      de: !firm && params.res === 'de' ? mt(ctx, id, 'exitDe') : '',
      firm: firm ? mt(ctx, id, joint ? 'exitFirmJoint' : 'exitFirmSingle') : '',
    })] : []),
    ...(k.gesy ? [item(ctx, id, 'gesy')] : []),
    ...(k.si ? [item(ctx, id, 'si')] : []),
    ...(k.de ? [firm
      ? item(ctx, id, 'deFirm', { cy: params.res === 'cy' ? mt(ctx, id, 'deFirmCy') : '' })
      : item(ctx, id, 'de', { rate: numL(ctx, params.deTaxPct) })] : []),
  ]

  let example: string | null = null
  const jahre = a.tax.length
  if (k.total !== 0 && jahre > 0) {
    const parts = [
      mt(ctx, id, 'p_income', { v: eur(k.incomeTax) }),
      k.gesy ? mt(ctx, id, 'p_gesy', { v: eur(k.gesy) }) : '',
      k.si ? mt(ctx, id, 'p_si', { v: eur(k.si) }) : '',
      k.de > 0 ? mt(ctx, id, 'p_dePlus', { v: eur(k.de) }) : k.de < 0 ? mt(ctx, id, 'p_deMinus', { v: eur(-k.de) }) : '',
    ].filter(Boolean).join(' ')
    example = ex(ctx, id, jahre === 1 ? 'main1' : 'main', {
      parts,
      total: k.total > 0 ? ex(ctx, id, 'totPos', { v: eur(k.total) }) : ex(ctx, id, 'totNeg', { v: eur(k.total), s: eur(-k.total) }),
      n: jahre, from: a.summary.firstYear, to: a.summary.lastYear,
      avg: k.perYear >= 0 ? eur(k.perYear) : ex(ctx, id, 'avgSave', { v: eur(-k.perYear) }),
    })
  }

  // Warum die Einkommensteuer 0 € ist, erklärt der graue Hinweis direkt über
  // diesem Block (strategie.xNone*); hier nicht noch einmal.
  const meaning: string[] = []
  if (k.exit > 0) {
    const sum = k.total + k.exit
    const head = mt(ctx, id, joint ? 'exitHeadJoint' : 'exitHeadSingle', { v: eur(k.exit) })
    const firmTxt = divSale > 0 ? mt(ctx, id, 'exitFirm', { v: eur(divSale) })
      : firm && !joint ? mt(ctx, id, 'exitMFirmSingle') : ''
    meaning.push(k.total >= 0 ? mt(ctx, id, 'exit', { head, sum: eur(sum), firm: firmTxt })
      : sum >= 0 ? mt(ctx, id, 'exitNeg', { head, save: eur(-k.total), sum: eur(sum), firm: firmTxt })
        : mt(ctx, id, 'exitNegNet', { head, save: eur(-k.total), s: eur(-sum), firm: firmTxt }))
  } else if (divSale > 0) {
    meaning.push(mt(ctx, id, 'exitOnlyDiv', { v: eur(divSale) }))
  }
  if (params.res === 'de' && !firm && k.exit > 0) meaning.push(mt(ctx, id, 'deExit'))
  const negDe = a.tax.filter(t => t.de < 0)
  if (!firm && negDe.length) {
    const tile = k.de !== 0 ? mt(ctx, id, 'deNegTile') : ''
    meaning.push(negDe.length === 1
      ? mt(ctx, id, 'deNeg1', { y: negDe[0].year, tile })
      : mt(ctx, id, 'deNeg', { years: yearsPhrase(ctx, id, negDe.map(t => t.year)), tile }))
  }
  if (firm) {
    meaning.push(mt(ctx, id, 'firm', {
      cit: numL(ctx, params.corpTaxPct), payout: numL(ctx, params.divPayoutPct), rate: numL(ctx, params.divTaxPct),
    }))
  }
  if (!firm && params.res === 'cy' && (k.gesy || k.si)) {
    const lv = [k.gesy ? mt(ctx, id, 'lvGesy', { v: eur(k.gesy) }) : '', k.si ? mt(ctx, id, 'lvSi', { v: eur(k.si) }) : ''].filter(Boolean)
    meaning.push(mt(ctx, id, 'cyLevies', { list: joinList(ctx, id, lv) }))
  }

  // Kacheln nur nennen, wenn es sie gibt (Review 8.10.26)
  const firmSale = divSale > 0 ? mt(ctx, id, k.exit ? 'firmPitJoint' : 'firmPitJointNoTile')
    : firm && !joint && a.exits.length ? mt(ctx, id, 'firmPitSingle') : ''
  const tiles = [
    k.de ? String(ctx.t('strategie.xDe')) : '',
    k.gesy ? String(ctx.t('strategie.xGesy')) : '',
    k.si ? String(ctx.t('strategie.xSi')) : '',
  ].filter(Boolean).map(x => mt(ctx, id, 'q', { x }))
  const pitfalls = [
    ...(k.exit ? [pit(ctx, id, 'notAll')] : []),
    ...(k.incomeTax === 0 ? [firm
      ? pit(ctx, id, 'zeroFirm', { de: k.de !== 0 ? mt(ctx, id, 'zeroFirmDe') : '' })
      : pit(ctx, id, 'zero', {
        tiles: tiles.length ? mt(ctx, id, tiles.length === 1 ? 'zeroTiles1' : 'zeroTilesN', { list: joinList(ctx, id, tiles) }) : '',
      })] : []),
    ...(!firm && !k.gesy && params.res !== 'cy' ? [pit(ctx, id, 'gesy')] : []),
    ...(!firm && (negDe.length > 0 || k.de < 0) ? [pit(ctx, id, 'minus')] : []),
    pit(ctx, id, 'avg'),
    ...(firm ? [pit(ctx, id, k.de !== 0 ? 'firm' : 'firmNoDe', { sale: firmSale })] : []),
    pit(ctx, id, 'model'),
  ]
  return { heading: tr(ctx, id, 'heading'), intro, items, example, meaning, pitfalls }
}

export function buildExitGuides(ctx: GuideCtx): Record<string, Guide | null> {
  return {
    exit: exitGuide(ctx),
    costKpis: costKpisGuide(ctx),
    moneyFlow: moneyFlowGuide(ctx),
    taxes: taxesGuide(ctx),
  }
}

// ── Nachrechnen ──────────────────────────────────────────────────────────────
// Unabhängig vom Aufbau oben: Jede Rechnung, die ein Text behauptet, wird mit
// den angezeigten (gerundeten) Werten erneut gerechnet, und die Zahlen müssen
// im Text stehen.
export function checkGuides(ctx: GuideCtx, res: Record<string, Guide | null>): string[] {
  const { a, params } = ctx
  const out: string[] = []
  const bad = (msg: string) => out.push(msg)
  const R = Math.round
  const has = (txt: string | null | undefined, n: number) => !!txt && txt.includes(eur(n))
  const allText = (g: Guide) => [g.intro, ...g.items.map(i => i.text), g.example ?? '', ...g.meaning, ...g.pitfalls].join('\n')
  const ids = ['exit', 'costKpis', 'moneyFlow', 'taxes']
  for (const k of ids) if (!(k in res)) bad(`Block ${k} fehlt`)
  for (const k of Object.keys(res)) if (!ids.includes(k)) bad(`unerwarteter Block ${k}`)
  // Unabhängige Fassung der Jahres-Läufe: jedes Jahr der Liste muss im Text
  // stehen, entweder selbst oder als Anfang/Ende eines Laufs „A bis B" mit
  // allen Jahren dazwischen in der Liste.
  const yearsCovered = (txt: string, ys: number[], id: string): boolean => {
    const to = mt(ctx, id, 'w_to')
    const set = new Set(ys)
    const re = new RegExp(`(\\d{4}) ${to} (\\d{4})`, 'g')
    const covered = new Set<number>()
    for (const m of txt.matchAll(re)) {
      const x = Number(m[1]), y = Number(m[2])
      if (y - x < 2) return false
      for (let v = x; v <= y; v++) { if (!set.has(v)) return false; covered.add(v) }
    }
    return ys.every(y => covered.has(y) || txt.includes(String(y)))
  }
  const firstY = a.summary.firstYear, lastY = a.summary.lastYear
  for (const g of Object.values(res)) {
    if (!g) continue
    if (firstY === lastY && g.intro.includes(`${firstY} ${mt(ctx, 'costKpis', 'w_to')} ${firstY}`)) bad('Zeitraum „A bis A" im Einstieg')
  }

  // exit
  const ge = res.exit
  if ((ge == null) !== (a.exits.length === 0)) bad('exit: sichtbar, obwohl kein Verkauf (oder umgekehrt)')
  if (ge) {
    const tot = a.exitTotal
    const r = tot ?? a.exits[0]
    if (r.tax != null && r.net != null) {
      if (R(r.value) - R(r.debt) - R(r.costs) - R(r.vat) - R(r.tax) !== R(r.net)) bad(`exit: Beispiel geht nicht auf (${r.value} - ${r.debt} - ${r.costs} - ${r.vat} - ${r.tax} != ${r.net})`)
      for (const v of [r.value, r.debt, r.costs, r.tax, r.net]) if (!has(ge.example, v)) bad(`exit: Beispiel ohne ${eur(v)}`)
      if (r.vat !== 0 && !has(ge.example, Math.abs(r.vat))) bad('exit: Beispiel ohne MwSt-Betrag')
      if (tot && tot.equityBack > 0 && !has(ge.example, tot.equityBack)) bad('exit: Beispiel ohne Eigenkapital-Zeile')
      if (tot && tot.equityBack > 0 && tot.net + tot.equityBack >= 0 && !has(ge.example, tot.net + tot.equityBack)) bad('exit: Summe Erlös + Eigenkapital fehlt')
      if (tot && tot.equityBack > 0 && tot.net + tot.equityBack < 0 && !has(ge.example, -(tot.net + tot.equityBack))) bad('exit: Fehlbetrag nach Eigenkapital fehlt')
      // negativer Erlös: im Reinvestment zahlt der Kontostand, sonst du (ggf. aus dem zurückgelegten Eigenkapital)
      const tailOf = (key: string) => ex(ctx, 'exit', key, { year: a.exits[0].year, list: '§' }).split('§')[1] ?? ''
      if (r.net < 0 && a.reinvest && !ge.example?.includes(tailOf('endNegRi'))) bad('exit: negativer Erlös im Reinvestment ohne Hinweis auf den Kontostand')
      if (r.net < 0 && !a.reinvest && !(tot && tot.equityBack > 0) && !ge.example?.includes(tailOf('endNeg'))) bad('exit: negativer Erlös ohne Hinweis auf die Zuzahlung')
    } else if (ge.example) bad('exit: Beispiel ohne Steuer/Erlös')
    if (tot) {
      const s = (f: (e: CustomerAnalytics['exits'][number]) => number) => a.exits.reduce((x, e) => x + f(e), 0)
      if (s(e => e.value) !== tot.value || s(e => e.debt) !== tot.debt || s(e => e.costs) !== tot.costs || s(e => e.vat) !== tot.vat) bad('exit: Zeilen ergeben nicht „Zusammen"')
      if (a.exits.some(e => e.tax != null || e.net != null)) bad('exit: Wohnungszeilen mit Steuer/Erlös beim gemeinsamen Verkauf')
      const totalItem = ge.items.find(i => i.text.includes(tr(ctx, 'exit', 'm.totalNet')))
      if (totalItem && a.summary.exitNet !== tot.net) bad('exit: „Erlös nach Verkauf" ungleich Zeile „Zusammen"')
      if (Math.abs(tot.debt - a.summary.debt) > 1 && ge.items.some(i => i.text.includes(tr(ctx, 'exit', 'm.totalDebtSame')))) bad('exit: Kredit ungleich „Kredit am Ende"')
      const ym = ge.items[1]?.text ?? ''
      if (ym.includes(String(a.exits[0].year)) && a.exits[0].year !== a.summary.firstYear + params.exitAfterYears - 1) bad('exit: Verkaufsjahr passt nicht')
      // Anteil vom Euro
      if (tot.value > 0 && tot.net > 0) {
        const cent = R(tot.net / tot.value * 100)
        if (!ge.meaning.some(m => m.includes(` ${cent} `))) bad(`exit: Cent-Satz fehlt (${cent})`)
      }
      // Kostenquote
      const pct = costPctOf(ctx)
      if (tot.value > 10000 && Math.abs(tot.costs / tot.value * 100 - pct) > 0.06) bad(`exit: Kostenquote ${pct} % passt nicht zu ${tot.costs}/${tot.value}`)
      // offene Raten
      const rest = openRestSum(a)
      if (rest > tot.debt) bad('exit: offene Raten größer als Kredit')
      if (rest > 0 && !ge.meaning.some(m => m.includes(eur(rest)))) bad('exit: offene Raten fehlen')
      // Ausschüttungssteuer
      if (params.holder === 'firma' && tot.tax > a.taxKpis.exit) {
        const div = tot.tax - a.taxKpis.exit
        const expect = R((tot.net + div) * params.divPayoutPct / 100 * params.divTaxPct / 100)
        if (Math.abs(expect - div) > 1) bad(`exit: Ausschüttungssteuer ${div} passt nicht zu ${expect}`)
        if (!ge.meaning.some(m => m.includes(eur(div)))) bad('exit: Ausschüttungssteuer fehlt im Text')
      }
      if (params.holder === 'privat' && tot.tax !== a.taxKpis.exit) bad('exit: privat, Steuer „Zusammen" ungleich Kachel')
    } else {
      for (const e of a.exits) {
        if (e.tax == null || e.net == null) { bad('exit: Einzelverkauf ohne Steuer/Erlös'); continue }
        if (e.value - e.debt - e.costs - e.vat - e.tax !== e.net) bad(`exit: Einzelzeile geht nicht auf (${e.name})`)
      }
      const sumTax = a.exits.reduce((s, e) => s + (e.tax ?? 0), 0)
      if (Math.abs(sumTax - a.taxKpis.exit) > a.exits.length) bad('exit: Summe Steuern ungleich Kachel')
      // Behaltene Wohnungen stehen nicht in der Tabelle
      if (keptUnits(a) > 0 && !ge.intro.includes(mt(ctx, 'exit', 'introKept').trim())) bad('exit: Hinweis auf behaltene Wohnungen fehlt')
    }
    const pos = sumPosVat(a), negv = sumNegVat(a)
    if (pos > 0 && !ge.meaning.some(m => m.includes(eur(pos)))) bad('exit: MwSt-Rückzahlung fehlt')
    if (negv > 0 && !ge.meaning.some(m => m.includes(eur(negv)))) bad('exit: offene MwSt-Erstattung fehlt')
    if (a.exits.some(e => e.tax != null && e.tax < 0) || (tot && tot.tax < 0)) bad('exit: negative Steuer, Text sagt „minus Steuern"')
    for (const e of a.exits) if (allText(ge).includes(e.name) && e.name.length > 2) bad(`exit: Wohnungsname im Text (${e.name})`)
  }

  // costKpis
  const gk = res.costKpis
  const ff = flowFacts(a)
  if (!gk) bad('costKpis fehlt')
  else {
    const nw = a.summary.netWorth, gain = a.cost.wealthGain
    const sub = nw - gain
    const named = sub === R(a.summary.originalEquity) || (!a.reinvest && (sub === ff.bound || (ff.heldOut && sub === ff.bound + ff.liq)))
    if (gk.example) {
      if (!named) bad('costKpis: Beispiel, obwohl der Abzug keiner angezeigten Zahl entspricht')
      if (!has(gk.example, nw) || !has(gk.example, sub) || !has(gk.example, gain)) bad('costKpis: Zahlen fehlen im Beispiel')
      if (gain < 0 && gk.example.includes(eur(-gain)) && nw + (-gain) !== sub) bad('costKpis: „liegt um ... unter" geht nicht auf')
      const tot = a.exitTotal
      if (tot) {
        // Zahlensatz zum Verkauf nur, wenn er mit den angezeigten Werten exakt aufgeht
        const ded = tot.costs + tot.vat + tot.tax
        const numeric = !gk.example.includes(tr(ctx, 'costKpis', 'ex.saleGeneric').trim())
        if (numeric) {
          if (nw - ded !== tot.net + tot.equityBack) bad('costKpis: Verkaufsteil geht nicht auf')
          if (!has(gk.example, Math.abs(ded)) || !has(gk.example, Math.abs(tot.net))) bad('costKpis: Zahlen im Verkaufsteil fehlen')
          if (tot.equityBack > 0 && !has(gk.example, tot.equityBack)) bad('costKpis: Eigenkapital-Zeile fehlt')
        }
        // negativer Erlös nie als „-X € Erlös"
        if (tot.net < 0 && gk.example.includes(eur(tot.net))) bad('costKpis: negativer Erlös als Erlös formuliert')
      }
    } else if (named) bad('costKpis: Beispiel fehlt')
    // Doppelzählung: nicht „das Geld, das in die Käufe geflossen ist"
    if (ff.dbl && gk.items.some(i => i.text === tr(ctx, 'costKpis', 'items.gainBound.text', { v: eur(ff.bound) }))) bad('costKpis: „in die Käufe geflossen" trotz Doppelzählung')
    if (ff.dbl && gk.items.some(i => i.text.includes(mt(ctx, 'costKpis', 'gainNk').trim()))) bad('costKpis: Kaufnebenkosten „zusätzlich" trotz Doppelzählung')
    const add = a.cost.additionalEquity
    if (add > 0) {
      const gap = gk.meaning.find(m => m.includes(eur(add)))
      if (!gap) bad('costKpis: Lücke fehlt')
      const y = gapYear(a)
      if (y != null && gap) {
        if (!a.reinvest) {
          const row = a.cashflow.find(c => c.year === y)
          if (!row || -row.cumulative !== add) bad('costKpis: Jahr der Lücke passt nicht')
        }
        if (!gap.includes(String(y))) bad('costKpis: Jahr der Lücke fehlt')
      }
      if (gap && gap.includes(mt(ctx, 'costKpis', 'gapUnusedAll').trim()) && !(ff.unusedAmt >= add)) bad('costKpis: „Startkapital reicht dafür" stimmt nicht')
    }
    const neg = negCashYears(a)
    if (!a.reinvest && neg.length) {
      const summe = neg.reduce((s, c) => s - c.cashflow, 0)
      const m = gk.meaning.find(x => x.includes(eur(summe)) && yearsCovered(x, neg.map(c => c.year), 'costKpis'))
      if (!m) bad('costKpis: Satz zu den negativen Jahren fehlt oder ist unvollständig')
      else {
        if (m.includes(mt(ctx, 'costKpis', 'negCovered').trim()) && cumMin(a) < 0) bad('costKpis: „gedeckt", obwohl Summe negativ')
        if (m.includes(mt(ctx, 'costKpis', 'negPartly').trim()) && !(add > 0 && add < summe)) bad('costKpis: „teilweise gedeckt" passt nicht')
        const d = Math.abs(add - summe)
        if (add > 0 && d > 0 && d <= 3 && !m.includes(mt(ctx, 'costKpis', 'negRound').trim())) bad('costKpis: Rundungshinweis fehlt')
        if (m.includes(mt(ctx, 'costKpis', 'negSame').trim()) && add !== summe) bad('costKpis: „genau der Betrag" stimmt nicht')
        // „aus deiner eigenen Tasche" ohne Einschränkung nur, wenn die Kachel die ganze Summe zeigt
        const own = mt(ctx, 'costKpis', neg.length === 1 ? 'whyOwn1' : 'whyOwnN').trim()
        if (m.includes(own) && !(add > 0 && d <= 3)) bad('costKpis: „du musst Geld zulegen", obwohl Überschüsse decken')
      }
    }
    const lastCf = a.cashflow.length ? a.cashflow[a.cashflow.length - 1].cumulative : 0
    if (!a.reinvest && lastCf !== 0 && !gk.meaning.some(m => m.includes(eur(Math.abs(lastCf))))) bad('costKpis: Cashflow-Summe fehlt')
    const cfRef = mt(ctx, 'costKpis', 'cfRef').trim()
    if (cfRef && gk.meaning.some(m => m.includes(cfRef)) && a.scenarios.find(s => s.key === 'basis')?.cumulativeCashflow !== lastCf) bad('costKpis: Szenario-Verweis passt nicht')
    const rent = mf(a, 'rent') ?? 0
    if (a.cost.interest > 0 && rent > 0) {
      const pct = R(a.cost.interest / rent * 100)
      const m = gk.meaning.find(x => x.includes(eur(a.cost.interest)) && x.includes(eur(rent)))
      if (a.cost.interest > rent) { if (!m) bad('costKpis: Satz Zinsen über Miete fehlt') }
      else if (pct >= 1 && (!m || !(m.includes(`${pct} %`) || m.includes(`${pct}%`)))) bad(`costKpis: Zinsanteil ${pct} % fehlt`)
    }
    if (mf(a, 'interest') !== -a.cost.interest) bad('costKpis: Zins-Kachel ungleich Zeile Zinsen')
  }

  // moneyFlow
  const gm = res.moneyFlow
  if (!gm) bad('moneyFlow fehlt')
  else {
    const labels = new Set(a.moneyFlow.map(m => m.label))
    for (const m of a.moneyFlow) if (!gm.items.some(i => i.label === m.label)) bad(`moneyFlow: Zeile ${m.label} ohne Erklärung`)
    for (const i of gm.items.slice(3)) if (!labels.has(i.label)) bad(`moneyFlow: Erklärung ohne Zeile (${i.label})`)
    const zins = mf(a, 'interest'), tilg = mf(a, 'amort')
    if (gm.example) {
      if (zins == null || tilg == null) bad('moneyFlow: Beispiel ohne Zeilen')
      else {
        if (!has(gm.example, -zins - tilg) || !has(gm.example, -zins) || !has(gm.example, -tilg)) bad('moneyFlow: Beispiel-Zahlen fehlen')
        if (-zins !== a.cost.interest) bad('moneyFlow: Zinsen ungleich Kachel')
      }
    }
    if (mf(a, 'taxes') !== -a.taxKpis.total) bad('moneyFlow: Steuern ungleich „Steuern und Abgaben gesamt"')
    if (mf(a, 'start') !== a.summary.originalEquity) bad('moneyFlow: Startkapital ungleich „Eingesetztes Kapital"')
    const sale = mf(a, 'sale')
    if (sale != null) {
      const expect = a.exitTotal ? a.exitTotal.net : a.exits.reduce((s, e) => s + (e.net ?? 0), 0)
      if (Math.abs(sale - expect) > (a.exitTotal ? 0 : a.exits.length)) bad(`moneyFlow: Verkaufserlöse ${sale} ungleich Verkaufstabelle ${expect}`)
    }
    const f = ff
    const meanTxt = gm.meaning.join('\n')
    if (!a.reinvest && sale != null) {
      const m = gm.meaning.find(x => x.includes(eur(Math.abs(sale))))
      if (!m) bad('moneyFlow: Verkaufssatz fehlt')
      if (sale < 0 && meanTxt.includes(eur(sale))) bad('moneyFlow: negativer Erlös als Erlös formuliert')
      if (a.exitTotal && a.exitTotal.equityBack !== f.liq) bad('moneyFlow: Liquidität ungleich Eigenkapital-Zeile')
      if (f.liq > 0 && m && !m.includes(eur(Math.abs(sale + f.liq)))) bad('moneyFlow: Summe Erlös + Liquidität fehlt')
      const c = a.cashflow.length ? a.cashflow[a.cashflow.length - 1].cumulative : 0
      if (m && c !== 0 && !m.includes(eur(Math.abs(c)))) bad('moneyFlow: Cashflow-Summe fehlt')
    }
    // Teil des Kaufnebenkosten-Satzes nach den Zahlen („Der Grund: ...")
    const costsTail = (mt(ctx, 'moneyFlow', 'boundCosts', { bound: '', diff: '\u00a7', gain: '' }).split('\u00a7')[1] ?? '').trim()
    if (f.bound > f.start) {
      const m = gm.meaning.find(x => x.includes(eur(f.bound)) && x.includes(eur(f.bound - f.start)))
      if (!m && !f.dbl) bad('moneyFlow: Satz zu „In Immobilien gebunden" fehlt')
      if (m && costsTail && m.includes(costsTail) && !(f.bound - f.start <= f.nk && !a.reinvest)) bad('moneyFlow: Kaufnebenkosten-Satz passt nicht')
    }
    // Kaufnebenkosten-Satz nie, wenn „gebunden" nie gezahltes Eigenkapital doppelt zählt
    if (!a.reinvest && f.liq > 0 && f.bound + f.liq - f.start > f.nk && costsTail && meanTxt.includes(costsTail)) bad('moneyFlow: Kaufnebenkosten-Satz trotz Doppelzählung')
    if (f.dbl) {
      const paid = f.bound - f.liq
      if (!gm.meaning.some(x => x.includes(eur(f.bound)) && x.includes(eur(f.liq)) && x.includes(eur(paid)))) bad('moneyFlow: Satz zur Doppelzählung fehlt')
      if (paid < 0) bad('moneyFlow: gezahlter Teil negativ')
    }
    if (f.bound < f.start && a.reinvest && !gm.meaning.some(x => x.includes(eur(f.start - f.bound)))) bad('moneyFlow: Rest auf dem Konto fehlt')
    if (f.bound < f.start && f.heldOut) {
      const sum = f.bound + f.liq
      const m = gm.meaning.find(x => x.includes(eur(f.liq)) && x.includes(eur(f.bound)))
      if (!m) bad('moneyFlow: Satz zu zurückgehaltenem Eigenkapital fehlt')
      if (m && m.includes(eur(sum)) && !(sum > f.start && sum - f.start <= f.nk)) bad('moneyFlow: Summe gebunden + Liquidität passt nicht')
    }
    const vatIn = mf(a, 'vat')
    const vatOut = a.exitTotal ? a.exitTotal.vat : a.exits.reduce((s, e) => s + e.vat, 0)
    if (vatIn != null && vatOut > 0 && !gm.meaning.some(x => x.includes(eur(vatIn)) && x.includes(eur(vatOut)))) bad('moneyFlow: MwSt hin und zurück fehlt')
    // „MwSt-Erstattung bezahlt die Raten" nur, wenn wirklich etwas für Raten zurückbehalten wird
    if (meanTxt.includes(mt(ctx, 'moneyFlow', 'vatPays').slice(0, 40)) && !a.cashflowRows.some(r => (r.toPayments ?? 0) > 0)) bad('moneyFlow: MwSt bezahlt Raten, obwohl nichts zurückbehalten wird')
    const taxRow = mf(a, 'taxes')
    if (taxRow != null && taxRow > 0 && (params.holder !== 'privat' || params.res !== 'de')) bad('moneyFlow: Steuerersparnis außerhalb privat + Deutschland')
  }

  // taxes
  const gt = res.taxes
  if (!gt) bad('taxes fehlt')
  else {
    const k = a.taxKpis
    if (k.incomeTax + k.gesy + k.si + k.de !== k.total) bad('taxes: Teile ergeben nicht die Summe')
    if (a.tax.length !== a.summary.lastYear - a.summary.firstYear + 1) bad('taxes: Zahl der Jahre passt nicht')
    if (a.tax.length && R(k.total / a.tax.length) !== k.perYear) bad('taxes: Schnitt pro Jahr passt nicht')
    if (gt.example) {
      for (const v of [k.incomeTax, k.total, Math.abs(k.perYear)]) if (!has(gt.example, v)) bad(`taxes: ${eur(v)} fehlt im Beispiel`)
      if (k.de && !has(gt.example, Math.abs(k.de))) bad('taxes: Steuer in Deutschland fehlt im Beispiel')
      if (a.tax.length === 1 ? !gt.example.includes(String(a.summary.firstYear)) : !gt.example.includes(String(a.tax.length))) bad('taxes: Zahl der Jahre fehlt')
    } else if (k.total !== 0) bad('taxes: Beispiel fehlt')
    const sum = k.total + k.exit
    if (k.exit > 0 && !gt.meaning.some(m => m.includes(eur(k.exit)) && m.includes(eur(Math.abs(sum))))) bad('taxes: Summe mit Verkauf fehlt')
    if (k.exit > 0 && sum < 0 && gt.meaning.some(m => m.includes(eur(sum)))) bad('taxes: negative Steuersumme als Steuer formuliert')
    const divSale = params.holder === 'firma' && a.exitTotal && a.exitTotal.tax > k.exit ? a.exitTotal.tax - k.exit : 0
    if (divSale > 0 && !gt.meaning.some(m => m.includes(eur(divSale)))) bad('taxes: Ausschüttungssteuer beim Verkauf fehlt')
    // Kacheln, die fehlen, nur als fehlend nennen
    const missing = mt(ctx, 'taxes', 'tileMissing')
    for (const [val, key] of [[k.de, 'strategie.xDe'], [k.exit, 'strategie.xExit']] as const) {
      if (val !== 0) continue
      const lbl = mt(ctx, 'taxes', 'q', { x: String(ctx.t(key)) })
      for (const s of [...gt.meaning, ...gt.pitfalls, ...gt.items.map(i => i.text)]) {
        for (const sent of s.split('. ')) if (sent.includes(lbl) && !sent.includes(missing)) bad(`taxes: Kachel „${lbl}" genannt, obwohl sie fehlt`)
      }
    }
    if (k.de < 0 && params.holder !== 'privat') bad('taxes: negative Steuer bei Firma')
    if (k.gesy && (params.holder !== 'privat' || params.res !== 'cy')) bad('taxes: Gesundheitsbeitrag außerhalb privat + Zypern')
    const negDe = a.tax.filter(t => t.de < 0)
    if (params.holder !== 'firma' && negDe.length > 1 && !gt.meaning.some(m => yearsCovered(m, negDe.map(t => t.year), 'taxes') && m.includes(mt(ctx, 'taxes', 'yearsMany', { list: '' }).trim()))) bad('taxes: Jahre mit negativer Steuer in Deutschland unvollständig')
  }
  return out
}
