// Erklärtexte zu Abschnitt 5 der Kundenseite („Was das Portfolio laufend
// abwirft“):
//   cashflow  - unter der Cashflow-Tabelle, erklärt das Diagramm „Cashflow je
//               Jahr“ UND die Tabelle (alle Spalten, auch „für Kaufraten“)
//   liquidity - unter dem Liquiditätsdiagramm (nur Reinvestment)
//
// Alle Zahlen sind die gerundeten Werte, die auf der Seite stehen. Die Seite
// blendet in der Grundansicht Jahre aus (Strategie.tsx: keyYears + Filter +
// 12 Zeilen); der Umschalter „Alle Jahre anzeigen“ ist hier nicht bekannt.
// Deshalb beziehen sich Sätze über einzelne Zeilen nur auf Zeilen der
// Grundansicht - die stehen in jeder Ansicht in der Tabelle.
//
// Ob eine Wohnung mit Saisonmiete rechnet, sieht dieses Modul nicht (GuideCtx
// hat keine Wohnungen). Sätze zur Saison sind deshalb immer als Bedingung
// formuliert („Nutzt das Modell die Saisonrechnung, ...“), nie als Tatsache.
import type { TFunction } from 'i18next'
import type { CustomerAnalytics, CashflowRow } from '../analytics'
import { eur, type Guide, type GuideCtx, type GuideItem } from './types'

type A = CustomerAnalytics
type Vars = Record<string, string | number>
const B = 'strategie.guide'
const ymOf = (y: number, m: number) => y * 12 + (m - 1)

// ── Gemeinsame Hilfen ────────────────────────────────────────────────────────

interface Words {
  c: (k: string, o?: Vars) => string       // strategie.guide.cashflow.<k>
  x: (k: string, o?: Vars) => string       // strategie.guide.cashflow.ex.<k>
  l: (k: string, o?: Vars) => string       // strategie.guide.liquidity.<k>
  lx: (k: string, o?: Vars) => string      // strategie.guide.liquidity.ex.<k>
  p: (k: string, o?: Vars) => string       // strategie.<k> (Beschriftungen der Seite)
  list: (parts: string[]) => string
  years: (ys: number[]) => string
  inYears: (ys: number[], cap: boolean) => string
  month: (m: number) => string
}

function words(t: TFunction): Words {
  const tr = (key: string, o?: Vars) => String(o ? t(key, o) : t(key))
  const c = (k: string, o?: Vars) => tr(`${B}.cashflow.${k}`, o)
  const x = (k: string, o?: Vars) => tr(`${B}.cashflow.ex.${k}`, o)
  const l = (k: string, o?: Vars) => tr(`${B}.liquidity.${k}`, o)
  const lx = (k: string, o?: Vars) => tr(`${B}.liquidity.ex.${k}`, o)
  const p = (k: string, o?: Vars) => tr(`strategie.${k}`, o)
  const list = (parts: string[]) => parts.length <= 1 ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} ${c('m.and')} ${parts[parts.length - 1]}`
  const years = (ys: number[]) => {
    const s = [...new Set(ys)].sort((q, r) => q - r)
    const parts: string[] = []
    for (let i = 0; i < s.length;) {
      let j = i
      while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
      if (j - i >= 2) parts.push(c('m.range', { a: s[i], b: s[j] }))
      else for (let k = i; k <= j; k++) parts.push(String(s[k]))
      i = j + 1
    }
    return list(parts)
  }
  const inYears = (ys: number[], cap: boolean) => new Set(ys).size === 1
    ? c(cap ? 'm.InYear' : 'm.inYear', { y: ys[0] })
    : c(cap ? 'm.InYears' : 'm.inYears', { ys: years(ys) })
  const month = (m: number) => c('m.months').split(',')[m - 1]?.trim() ?? String(m)
  return { c, x, l, lx, p, list, years, inYears, month }
}

// Stichjahre der Tabelle, genau wie Strategie.tsx (keyYears). Ohne
// Reinvestment sind purchases/sales im Portfolio immer 0 (analytics.ts:
// events = ri ? ri.events : []), Stichjahre sind dann nur die vier festen Jahre.
export function keyYearsOf(a: A): Set<number> {
  return new Set<number>([
    a.summary.firstYear, a.summary.firstYear + 4, a.summary.firstYear + 9, a.summary.lastYear,
    ...a.portfolio.filter(p => p.purchases || p.sales).map(p => p.year),
  ])
}
// Zeilen der Grundansicht (showYears = false). Sie stehen in jeder Ansicht.
export function visibleRows(a: A): CashflowRow[] {
  const ky = keyYearsOf(a)
  return a.cashflowRows.filter(r => ky.has(r.year) || r.rent > 0).slice(0, 12)
}
const hasTPOf = (a: A) => a.cashflowRows.some(r => r.toPayments)
const rowSum = (r: CashflowRow) => r.rent - r.costs - r.interest - r.amortization - r.tax + r.vatRefund
// Belegt die Daten eine Kurzzeitvermietung? (MwSt-Erstattung gibt es nur dort)
const shortLetOf = (a: A) => a.cashflowRows.some(r => r.vatRefund > 0) || a.exits.some(e => e.vat !== 0)
  || a.vatReturned.length > 0 || (a.exitTotal?.vat ?? 0) !== 0
const investorOf = (ctx: GuideCtx) => !ctx.params.selfFundingOnly && ctx.params.additionalEquityMonthly > 0
  ? ctx.params.additionalEquityMonthly : 0
// Jahre, in denen Geld in den Topf geht und der Cashflow trotzdem negativ ist
const negTPRowsOf = (a: A) => a.cashflowRows.filter(r => (r.toPayments ?? 0) > 0 && r.net < 0)
// MwSt beim Verkauf: positiv = Rückzahlung, negativ = noch offene, gekürzte Erstattung
const vatSignsOf = (a: A) => ({ neg: a.exits.some(e => e.vat < 0), pos: a.exits.some(e => e.vat > 0) })

// Kostet Kredit, der vor dem Start der Monatsrate abgerufen wurde, im Jahr y
// Zinsen? (strategy.ts liquiditySim: Zins ab dem Monat nach dem Abruf bis zur
// Umwandlung ins Bankdarlehen, die nie vor loanReadyYm = startYm liegt.)
// Hinreichende Bedingung: lieber ein Satz zu wenig als ein falscher.
export function bridgeInYear(a: A, y: number): boolean {
  const cp = a.creditPath
  if (!cp) return false
  return cp.steps.some(s => {
    if (!(s.credit > 0) || s.ym > ymOf(y, 11)) return false
    const ls = cp.loans.filter(q => q.name === s.unit)
    return ls.length === 1 && ls[0].startYm >= ymOf(y, 1) && s.ym < ls[0].startYm
  })
}

// Topf für die Kaufraten (nur ohne Reinvestment): toPayments eines Jahres =
// aus dem Topf bezahlte Raten + Topf am Jahresende - Topf am Jahresanfang
// (strategy.ts liquiditySim). Topf am Jahresende = wealth.cash, ausser im
// letzten Jahr (dort steckt zusaetzlich nicht gebrauchtes Eigenkapital drin,
// der Topf selbst ist am Planende immer leer).
export function potOf(a: A, r: CashflowRow) {
  const hPrev = r.year > a.summary.firstYear ? (a.wealth.find(w => w.year === r.year - 1)?.cash ?? 0) : 0
  const hEnd = r.year < a.summary.lastYear ? (a.wealth.find(w => w.year === r.year)?.cash ?? 0) : 0
  const tp = r.toPayments ?? 0
  // aus den angezeigten Zahlen gebildet, damit der Leser exakt nachrechnen kann
  const paid = tp + hPrev - hEnd
  const steps = (a.creditPath?.steps ?? []).filter(s => Math.floor(s.ym / 12) === r.year)
  const paidSteps = Math.round(steps.reduce((s, x) => s + x.fromSurplus, 0))
  return { hPrev, hEnd, tp, paid, paidSteps, ok: !!a.creditPath && Math.abs(paid - paidSteps) <= 2 }
}

// Beginn des Topfs: Übergabe (bzw. Kauf, wenn später) der finanzierten
// Wohnungen mit Raten nach der Übergabe. Nur wenn eindeutig bestimmbar.
export function potStartYm(a: A): { ym: number; byPurchase: boolean } | null {
  const cp = a.creditPath
  if (!cp) return null
  const own = a.properties.filter(p => !p.model)
  const anchor = (p: (typeof own)[number]) => Math.max(ymOf(p.buyYear, p.buyMonth), ymOf(p.readyYear, p.readyMonth))
  const cands = own.filter(p => cp.steps.some(s => s.unit === p.name && s.ym > anchor(p)))
  if (!cands.length) return null
  if (cands.some(p => own.filter(q => q.name === p.name).length > 1 || !(p.loan > 0))) return null
  const first = cands.reduce((b, p) => (anchor(p) < anchor(b) ? p : b))
  return { ym: anchor(first), byPurchase: ymOf(first.buyYear, first.buyMonth) > ymOf(first.readyYear, first.readyMonth) }
}

// ── Cashflow: Diagramm + Tabelle ─────────────────────────────────────────────

function cashflowGuide(ctx: GuideCtx): Guide | null {
  const { a, params } = ctx
  if (!a.cashflow.length || !a.cashflowRows.length) return null
  const w = words(ctx.t)
  const { c, x, p } = w
  const hasTP = hasTPOf(a)
  const shortLet = shortLetOf(a)
  const first = a.summary.firstYear, last = a.summary.lastYear
  const rows = a.cashflowRows
  const vis = visibleRows(a)
  const visYears = new Set(vis.map(r => r.year))
  const rowOf = (y: number) => rows.find(r => r.year === y)
  const secExit = p('s10')
  const anySale = a.exits.length > 0
  const liqChart = a.reinvest && a.liquidity.length > 0
  const chart5 = p('c5')
  const negTP = negTPRowsOf(a)
  const vs = vatSignsOf(a)
  const zeroYears = a.cashflow.filter(q => q.cashflow === 0).map(q => q.year)

  // ── Spalten und Linien ────────────────────────────────────────────────────
  const item = (k: string, parts: string[] = [], vars?: Vars, pre: string[] = []): GuideItem => ({
    label: c(`items.${k}.label`),
    text: [...pre, c(`items.${k}.text`, vars), ...parts].filter(Boolean).join(' '),
  })
  const taxParts: string[] = []
  if (params.holder === 'firma') taxParts.push(c('m.taxFirma'))
  else if (params.res === 'cy') {
    taxParts.push(c('m.taxCy'))
    if (a.taxKpis.gesy > 0) taxParts.push(c('m.taxCyGesy'))
    if (a.taxKpis.si > 0) taxParts.push(c('m.taxCySi'))
  } else taxParts.push(c('m.taxDe'))
  if (anySale) taxParts.push(c('m.taxSale', { sec: secExit }))
  // MwSt-Spalte: Rückzahlung nur bei Kurzzeitvermietung; Erstattung, die erst
  // nach dem Verkauf käme, rechnet das Modell gekürzt in den Verkauf ein.
  const vatParts: string[] = []
  if (shortLet && anySale && (vs.pos || !vs.neg)) vatParts.push(c('m.vatSale'))
  if (vs.neg) vatParts.push(c('m.vatLate'))
  if (vatParts.length) vatParts.push(c('m.vatRef', { sec: secExit }))
  if (!rows.some(r => r.vatRefund) && !vs.neg) vatParts.push(c('m.vatNone'))
  // Eigenkapital beim ersten Auftreten erklären (pos mit Reinvestment, toPay, sonst net)
  const ekExplained = a.reinvest || hasTP
  const items: GuideItem[] = [
    item('chart', zeroYears.length ? [c('m.chartZero', { inYears: w.inYears(zeroYears, false) })] : []),
    item('pos', [
      a.reinvest ? c(liqChart ? 'm.posRe' : 'm.posReNoChart', { chart: chart5 }) : c('m.posFree'),
      hasTP ? c('m.posTP') : '',
    ]),
    item('neg', [
      negTP.length ? c('m.negTP') : '',
      negTP.some(r => visYears.has(r.year)) ? c('m.negTPMore') : '',
      liqChart ? c('m.negRe', { chart: chart5 }) : '',
    ]),
    item('cum'),
    item('year', a.exitTotal ? [c('m.yearSale')] : [], { first, last }),
    item('rent', [
      c('m.rentGrowth', { rg: String(params.rentGrowth).replace('.', ',') }),
      anySale ? c('m.rentSale') : '',
      a.reinvest ? c('m.rentRe') : '',
    ]),
    item('costs'),
    item('interest', a.reinvest ? [c('m.interestRe')] : []),
    item('amort', a.reinvest ? [c('m.amortRe')] : []),
    item('tax', taxParts),
    item('vat', vatParts),
    ...(hasTP ? [item('toPay', [
      a.surplusWithVat ? c('m.toPayVat') : '',
      a.vatReturned.length ? c('m.toPayVatOut') : '',
      c('m.toPayRest'),
      rows.some(r => (r.toPayments ?? 0) < 0) ? c('m.toPayPlus') : '',
    ])] : []),
    item('net', [liqChart ? c('m.netRe', { chart: chart5 }) : ''], { ek: c(ekExplained ? 'm.ekShort' : 'm.ekLong') }, [
      c(hasTP ? 'm.netCalcTP' : 'm.netCalc', { col: p('tToPay') }),
      a.reinvest ? c(liqChart ? 'm.netGreenRe' : 'm.netGreenReNoChart', { chart: chart5 }) : c('m.netGreen'),
    ]),
  ]

  // ── Beispiel: eine Zeile zum Nachrechnen ──────────────────────────────────
  const readyYears = new Set(a.properties.map(q => q.readyYear))
  const exitYears = new Set(a.exits.map(e => e.year))
  const cand = vis.filter(r => r.rent > 0)
  const pick = cand.find(r => r.vatRefund === 0 && !r.toPayments && !readyYears.has(r.year) && !exitYears.has(r.year))
    ?? cand.find(r => r.vatRefund === 0 && !r.toPayments) ?? cand[0]
  let example: string | null = null
  if (pick) {
    const r = pick
    const minus = [
      r.costs ? x('costs', { v: eur(r.costs) }) : '',
      r.interest ? x('interest', { v: eur(r.interest) }) : '',
      r.amortization ? x('amort', { v: eur(r.amortization) }) : '',
      r.tax > 0 ? x('tax', { v: eur(r.tax) }) : '',
    ].filter(Boolean)
    const plus = [
      r.tax < 0 ? x('taxBack', { v: eur(-r.tax) }) : '',
      r.vatRefund ? x('vat', { v: eur(r.vatRefund) }) : '',
    ].filter(Boolean)
    const tp = r.toPayments ?? 0
    const calc = rowSum(r) - tp
    const parts = [
      x('start', { year: r.year, rent: eur(r.rent) }),
      minus.length ? x('minus', { list: w.list(minus) }) : '',
      plus.length ? x('plus', { list: w.list(plus) }) : '',
      tp > 0 ? x('pot', { v: eur(tp) }) : tp < 0 ? x('potBack', { v: eur(-tp) }) : '',
      r.net >= 0 ? x('resultPos', { v: eur(r.net) }) : x('resultNeg', { v: eur(-r.net) }),
      r.net >= 12 ? x('monthly', { v: eur(Math.round(r.net / 12)) }) : '',
      r.amortization ? x('amortNote', { v: eur(r.amortization) }) : '',
      calc !== r.net ? x('rounding', { calc: eur(calc), diff: eur(Math.abs(r.net - calc)) }) : '',
    ]
    example = parts.filter(Boolean).join(' ')
  }

  // ── Was das bedeutet ──────────────────────────────────────────────────────
  const meaning: string[] = []
  // Diagramm: Jahre mit Zuzahlung
  const negs = a.cashflow.filter(q => q.cashflow < 0)
  // Plan ohne jede Zahl (z. B. Verkauf im Kaufjahr): ein Satz statt Balken-Sätzen.
  // Bei nur einer Zeile erklärt das schon der Satz zum Kaufjahr.
  const allZero = rows.every(r => r.rent === 0 && r.costs === 0 && r.interest === 0 && r.net === 0)
  if (allZero) {
    if (rows.length > 1) meaning.push(c('m.allZero'))
  } else if (!negs.length) {
    if (a.cashflow.some(q => q.cashflow > 0)) {
      meaning.push([c('m.negNone', { first, last }), shortLet ? c('m.negNoneSeason') : ''].filter(Boolean).join(' '))
    }
  } else if (negs.length === 1) {
    meaning.push(c('m.negOne', { year: negs[0].year, sum: eur(-negs[0].cashflow) }))
  } else {
    const worst = negs.reduce((b, q) => (q.cashflow < b.cashflow ? q : b))
    meaning.push(c(negs.length === a.cashflow.length ? 'm.negAll' : 'm.negMany', {
      n: negs.length, total: a.cashflow.length, years: w.years(negs.map(q => q.year)),
      sum: eur(negs.reduce((s, q) => s - q.cashflow, 0)), worstYear: worst.year, worst: eur(-worst.cashflow),
    }))
  }
  // Diagramm: Endpunkt der Linie
  const cumEnd = a.cashflow[a.cashflow.length - 1].cumulative
  const basis = a.scenarios.find(s => s.key === 'basis')
  const tpSum = rows.reduce((s, r) => s + (r.toPayments ?? 0), 0)
  if (!allZero) meaning.push([
    cumEnd >= 0 ? c('m.cumPos', { cum: eur(cumEnd) }) : c('m.cumNeg', { abs: eur(-cumEnd), cum: eur(cumEnd) }),
    basis && basis.cumulativeCashflow === cumEnd ? c('m.scen', { sec: p('s9'), col: p('scBasis'), row: p('scCf') }) : '',
    anySale ? c('m.saleNote') : '',
    hasTP && tpSum > 0 ? c('m.tpNote', { sum: eur(tpSum), col: p('tToPay') }) : '',
  ].filter(Boolean).join(' '))
  const vatSum = rows.reduce((s, r) => s + r.vatRefund, 0)
  if (!hasTP && vatSum > 0) {
    meaning.push(cumEnd - vatSum >= 0
      ? c('m.vatSum', { vat: eur(vatSum), rest: eur(cumEnd - vatSum) })
      : c('m.vatSumNeg', { vat: eur(vatSum), abs: eur(vatSum - cumEnd) }))
  }

  // Tabelle: Kaufjahr
  const r1 = vis.find(r => r.year === first)
  const firstZero = !!r1 && r1.rent === 0 && r1.costs === 0 && r1.interest === 0 && r1.net === 0
  if (firstZero) meaning.push(c('m.first', { year: first }))
  // Tabelle: Bauzeit mit Zinsen, noch keine Wohnung übergeben
  const build = vis.filter(r => r.rent === 0 && r.interest > 0 && !a.properties.some(q => q.readyYear <= r.year))
  if (build.length) {
    const s = [build.length === 1
      ? c('m.buildOne', { year: build[0].year, interest: eur(build[0].interest) })
      : c('m.buildMany', { years: w.years(build.map(r => r.year)), list: w.list(build.map(r => c('m.yearValue', { year: r.year, v: eur(r.interest) }))) })]
    const back = build.filter(r => r.tax < 0)
    if (back.length) s.push(c('m.buildTax', { list: w.list(back.map(r => c('m.yearValue', { year: r.year, v: eur(-r.tax) }))) }))
    meaning.push(s.join(' '))
  }
  // Tabelle: Übergabejahr (Rumpfjahr)
  const hand = a.properties.filter(q => !q.model && q.readyMonth > 1 && visYears.has(q.readyYear))
    .sort((q, r) => q.readyYear - r.readyYear || q.readyMonth - r.readyMonth).slice(0, 3)
  for (const q of hand) {
    const n = 13 - q.readyMonth
    const s = [c('m.handover', {
      month: w.month(q.readyMonth), year: q.readyYear,
      counts: c(n === 1 ? 'm.countsOne' : 'm.countsMany'),
      months: n === 1 ? c('m.monthsOne') : c('m.monthsMany', { n }),
      rent: eur(q.rentFirstYear),
    })]
    // Ob diese Wohnung mit Saisonmiete rechnet, ist hier nicht bekannt:
    // deshalb nur als Bedingung, die in beiden Fällen stimmt.
    if (shortLet) s.push(c(n > 1 ? 'm.handoverSeasonMany' : q.readyMonth === 12 ? 'm.handoverSeasonDec' : 'm.handoverSeasonOne'))
    if (q.readyYear + 1 <= last && (q.soldYear == null || q.soldYear > q.readyYear)) s.push(c('m.handoverNext', { year: q.readyYear + 1 }))
    meaning.push(s.join(' '))
  }
  // Tabelle: negative Jahre ohne Kaufraten-Topf
  const negRows = vis.filter(r => r.net < 0 && !r.toPayments && r.rent > 0)
  const nA = negRows.filter(r => r.net + r.amortization > 0)
  const nB = negRows.filter(r => r.net + r.amortization < 0)
  if (nA.length) meaning.push(c('m.negAmort', { InYears: w.inYears(nA.map(r => r.year), true), left: c(nA.length === 1 ? 'm.leftOne' : 'm.leftMany') }))
  if (nB.length) {
    const hy = nB.filter(r => a.properties.some(q => q.readyYear === r.year && q.readyMonth > 1)).map(r => r.year)
    const bridge = hy.length > 0 && hy.every(y => (rowOf(y)?.interest ?? 0) > 0 && bridgeInYear(a, y))
    meaning.push([
      c('m.negReal', { InYears: w.inYears(nB.map(r => r.year), true) }),
      hy.length === 1 ? c('m.negRealHandoverOne', { year: hy[0] }) : hy.length > 1 ? c('m.negRealHandoverMany', { years: w.years(hy) }) : '',
      bridge ? c('m.negRealBridge') : '',
    ].filter(Boolean).join(' '))
  }
  // Tabelle: Steuer-Plus
  const taxPlus = vis.filter(r => r.tax < 0)
  if (taxPlus.length) meaning.push(c('m.taxPlus', { InYears: w.inYears(taxPlus.map(r => r.year), true), inThese: c(taxPlus.length === 1 ? 'm.inTheseOne' : 'm.inTheseMany') }))
  // Tabelle: GESY und Sozialversicherung in der Steuerspalte
  if (a.taxKpis.gesy > 0 || a.taxKpis.si > 0) {
    const s = [c('m.levies', {
      list: w.list([a.taxKpis.gesy > 0 ? c('m.levyGesy', { v: eur(a.taxKpis.gesy) }) : '', a.taxKpis.si > 0 ? c('m.levySi', { v: eur(a.taxKpis.si) }) : ''].filter(Boolean)),
      sec: p('s8'),
    })]
    if (a.taxKpis.si > 0) {
      s.push(c('m.levySiNote'))
      // Der Jahresbetrag der Sozialversicherung steht nirgends auf der Seite:
      // nur die Miete nennen, die der Leser in der Tabelle sieht.
      const hi = vis.find(r => r.rent > 0 && (a.tax.find(q => q.year === r.year)?.si ?? 0) > r.rent)
      if (hi) s.push(c('m.levySiHigh', { year: hi.year, rent: eur(hi.rent) }))
    }
    meaning.push(s.join(' '))
  }
  // Tabelle: MwSt-Jahre ohne Topf
  const vatRows = vis.filter(r => r.vatRefund > 0 && !r.toPayments)
  if (vatRows.length) meaning.push(c('m.vatRows', {
    InYears: w.inYears(vatRows.map(r => r.year), true),
    list: w.list(vatRows.map(r => c('m.yearValue', { year: r.year, v: eur(r.vatRefund) }))),
    look: c(vatRows.length === 1 ? 'm.lookOne' : 'm.lookMany'),
    op: w.list(vatRows.map(r => c('m.yearValue', { year: r.year, v: eur(r.net - r.vatRefund) }))),
  }))
  // Tabelle: Jahre mit Geld für Kaufraten
  const startYm = potStartYm(a)
  for (const r of vis.filter(q => (q.toPayments ?? 0) > 0)) {
    const tp = r.toPayments ?? 0
    const sub = r.net + tp
    const src = c(r.vatRefund > 0 ? 'm.srcRentVat' : 'm.srcRent')
    const pot = potOf(a, r)
    const s: string[] = []
    if (r.net >= 0) {
      s.push(c('m.tpPos', { year: r.year, src, sub: eur(sub), tp: eur(tp), net: eur(r.net) }))
    } else {
      s.push(c('m.tpNegIntro', { year: r.year, tp: eur(tp), abs: eur(-r.net) }))
      s.push(sub >= 0
        ? c('m.tpNegBalance', { src, sub: eur(sub), tp: eur(tp), abs: eur(-r.net) })
        : c('m.tpNegBalanceNeg', { subAbs: eur(-sub), tp: eur(tp), abs: eur(-r.net) }))
      s.push(c('m.tpNegWhy'))
      if (shortLet) s.push(c('m.tpNegSeason'))
      const startEmpty = !a.reinvest && r.year > first && pot.hPrev === 0
      if (startEmpty) {
        s.push(c('m.tpNegEmpty', { year: r.year }))
        const prev = rowOf(r.year - 1)
        if (startYm != null && Math.floor(startYm.ym / 12) >= r.year - 1 && Math.floor(startYm.ym / 12) <= r.year) {
          s.push(c(startYm.byPurchase ? 'm.tpNegStartBuy' : 'm.tpNegStart', { month: w.month(startYm.ym % 12 + 1), startYear: Math.floor(startYm.ym / 12) }))
        }
        if (prev && !prev.toPayments && prev.net > 0) s.push(c('m.tpNegPrevFree', { prevYear: prev.year, prevNet: eur(prev.net) }))
        // Nur wenn es den Topf schon vor diesem Jahr gab: Beginnt er erst im
        // Lauf des Jahres, liegen die Wintermonate am Anfang vor dem Topf.
        if (shortLet && startYm != null && Math.floor(startYm.ym / 12) < r.year) s.push(c('m.tpNegSeasonEmpty', { year: r.year }))
      }
    }
    if (pot.ok && pot.paid > 0) s.push(c(pot.hPrev > 0 ? 'm.potPaidPrev' : 'm.potPaid', { year: r.year, paid: eur(pot.paid), prev: eur(pot.hPrev) }))
    if (pot.ok && pot.hEnd > 0) s.push(c('m.potEnd', { end: eur(pot.hEnd) }))
    if (r.net < 0 && a.creditPath && a.creditPath.steps.length > 0) s.push(c('m.credit', { sec: p('credTitle') }))
    const calc = rowSum(r)
    if (calc !== sub) s.push(c('m.rounding', { calc: eur(calc), sub: eur(sub) }))
    meaning.push(s.join(' '))
  }
  const tpBack = vis.filter(q => (q.toPayments ?? 0) < 0)
  if (tpBack.length) meaning.push(c('m.tpPlus', { InYears: w.inYears(tpBack.map(r => r.year), true), col: p('tToPay') }))
  // Tabelle: Verkauf
  const exitYear = a.exits[0]?.year
  if (a.exitTotal && exitYear === last) {
    const sr = rowOf(last)
    const s = [c('m.saleIntro', { year: last })]
    if (sr && sr.rent > 0) {
      s.push(c(a.properties.some(q => !q.model && q.readyYear === last) ? 'm.saleRunHand' : 'm.saleRun'))
    } else if (sr && sr.costs === 0 && sr.interest === 0 && sr.amortization === 0 && sr.tax === 0 && sr.net === 0) {
      // Steht schon im Satz zum Kaufjahr, wenn Kauf- und Verkaufsjahr gleich sind
      if (!(firstZero && first === last)) s.push(c('m.saleZero'))
    } else s.push(c('m.saleNoRent'))
    s.push(c('m.saleResult', { sec: secExit, ded: c(vs.pos ? 'm.dedVat' : 'm.dedBase'), net: eur(a.exitTotal.net) }))
    if (vs.neg) s.push(c('m.saleVatOpen'))
    if (a.exitTotal.equityBack > 0) s.push(c('m.saleEquity', { v: eur(a.exitTotal.equityBack) }))
    meaning.push(s.join(' '))
  } else if (a.reinvest && anySale) {
    meaning.push(c('m.saleRe', { InYears: w.inYears(a.exits.map(e => e.year), true), chart: chart5 }))
  }
  // Tabelle: ausgeblendete Jahre
  const ky = keyYearsOf(a)
  const hidden = rows.filter(r => !ky.has(r.year) && r.rent === 0)
  const hidSum = hidden.reduce((s, r) => s + r.net, 0)
  if (hidden.length && hidSum !== 0) {
    const keys = c(a.reinvest ? 'm.keysRe' : 'm.keysBase')
    const view = a.reinvest ? c('m.hiddenView') : ''
    meaning.push(hidden.length === 1
      ? c('m.hiddenOne', { year: hidden[0].year, sum: eur(hidSum), view, keys })
      : c('m.hiddenMany', { years: w.years(hidden.map(r => r.year)), sum: eur(hidSum), view, keys }))
  }
  const filtered = rows.filter(r => ky.has(r.year) || r.rent > 0)
  if (filtered.length > 12) {
    const cutNeg = filtered.slice(12).filter(r => r.net < 0)
    meaning.push([
      // Den Umschalter „Alle Jahre anzeigen“ gibt es nur im Abschnitt 3 (nur mit Reinvestment)
      a.reinvest
        ? c('m.cut', { lastShown: vis[vis.length - 1].year, last, sec: p('s3'), more: p('more') })
        : c('m.cutFixed', { lastShown: vis[vis.length - 1].year, last }),
      cutNeg.length ? c('m.cutNeg', { InYears: w.inYears(cutNeg.map(r => r.year), true) }) : '',
    ].filter(Boolean).join(' '))
  }

  // ── Typische Missverständnisse ────────────────────────────────────────────
  const pit: string[] = [c('pitfalls.notProfit')]
  if (vatSum > 0) pit.push(c('pitfalls.vatOnce'))
  pit.push(c('pitfalls.line'))
  pit.push(c(hasTP ? 'pitfalls.purchaseTP' : 'pitfalls.purchase', { col: p('tToPay') }))
  if (rows.some(r => r.tax < 0)) pit.push(c('pitfalls.taxPlus'))
  if (a.exitTotal) pit.push(c('pitfalls.saleYear', { sec: secExit }))
  else if (anySale) pit.push(c('pitfalls.saleYearRe'))
  if (negTP.length) pit.push(c('pitfalls.tpMinus', { col: p('tToPay') }))
  if (rows.length > vis.length) pit.push(c(a.reinvest ? 'pitfalls.notAllYearsRe' : 'pitfalls.notAllYears'))
  const maxBar = Math.max(...a.cashflow.map(q => Math.abs(q.cashflow)))
  const maxCum = Math.max(...a.cashflow.map(q => Math.abs(q.cumulative)))
  if (maxBar > 0 && maxCum > 3 * maxBar) pit.push(c('pitfalls.scale'))
  pit.push(c('pitfalls.rounding'))
  pit.push(c('pitfalls.model'))

  return {
    heading: c('heading'),
    intro: c(hasTP ? 'm.introTP' : 'intro', { chart: p('c4') }),
    items, example, meaning, pitfalls: pit,
  }
}

// ── Liquidität (nur Reinvestment) ────────────────────────────────────────────

// Jahre, in denen ausser dem Cashflow nichts aufs Konto fliesst oder abfliesst:
// kein Kauf, keine Refinanzierung, kein Verkauf, keine fällige Rate oder
// Kaufnebenkosten einer zusätzlich gekauften Wohnung (reinvest.ts
// pendingEquity: Raten nach dem Kaufjahr bis zur Übergabe, Nebenkosten bei der
// Übergabe), keine zusätzlichen Einzahlungen.
function quietYear(ctx: GuideCtx, y: number): boolean {
  const { a } = ctx
  return !a.events.some(e => e.year === y)
    && !a.properties.some(q => q.model && q.buyYear < y && y <= q.readyYear)
    && investorOf(ctx) === 0
}

// Gilt „Kontostand Vorjahr + Cashflow = Kontostand“ in JEDEM Jahr ohne Kauf,
// Refinanzierung und Verkauf? Dann reicht die kurze Fassung des Hinweises.
function eventFreeYearsAddUp(a: A): boolean {
  const L = a.liquidity
  for (let i = 1; i < L.length; i++) {
    if (a.events.some(e => e.year === L[i].year)) continue
    const net = a.cashflowRows.find(r => r.year === L[i].year)?.net ?? 0
    if (Math.abs(Math.round(L[i].cash) - Math.round(L[i - 1].cash) - net) > 1) return false
  }
  return true
}

// Gilt dieselbe Regel wenigstens in allen ruhigen Jahren (enge Fassung)? Nicht
// immer: z.B. Raten eigener Wohnungen nach der Uebergabe laufen auch ueber das
// Konto (Zufallstest 8.10.26). Dann kein Rundungshinweis.
function quietYearsAddUp(ctx: GuideCtx): boolean {
  const { a } = ctx
  const L = a.liquidity
  for (let i = 1; i < L.length; i++) {
    if (!quietYear(ctx, L[i].year)) continue
    const net = a.cashflowRows.find(r => r.year === L[i].year)?.net ?? 0
    if (Math.abs(Math.round(L[i].cash) - Math.round(L[i - 1].cash) - net) > 1) return false
  }
  return true
}

function liquidityGuide(ctx: GuideCtx): Guide | null {
  const { a } = ctx
  if (!(a.reinvest && a.liquidity.length > 0)) return null
  const w = words(ctx.t)
  const { l, lx, p } = w
  const L = a.liquidity
  const last = a.summary.lastYear
  const rowOf = (y: number) => a.cashflowRows.find(r => r.year === y)
  const visYears = new Set(visibleRows(a).map(r => r.year))
  const inv = investorOf(ctx)
  const res0 = a.minimumReserve === 0
  const lw = a.liquidityWarning
  const below = L.filter(q => q.cash < a.minimumReserve - 1)
  const buyUntil = (y: number) => a.events.some(e => e.kind === 'purchase' && e.year <= y)

  const item = (k: string, parts: string[] = [], vars?: Vars, text?: string): GuideItem => ({
    label: l(`items.${k}.label`),
    text: [text ?? l(`items.${k}.text`, vars), ...parts].filter(Boolean).join(' '),
  })
  const items: GuideItem[] = [
    item('cash', inv > 0 ? [l('m.cashInvestor', { v: eur(inv) })] : []),
    res0 ? item('reserve', [], undefined, l('m.reserve0')) : item('reserve', [], { reserve: eur(a.minimumReserve) }),
  ]
  if (lw) {
    const ys = below.map(q => q.year)
    const gaps = ys.length > 1 && ys[ys.length - 1] - ys[0] + 1 !== ys.length
    items.push(item('warn', [
      buyUntil(lw.to) ? l('m.warnBuy')
        : a.events.some(e => e.kind === 'purchase') ? l('m.warnNoBuy', { to: lw.to }) : l('m.warnNoBuyAll'),
      lw.from === lw.to ? l('m.warnSingle', { from: lw.from }) : gaps ? l('m.warnGaps', { level: l(res0 ? 'm.level0' : 'm.levelRes') }) : '',
    ], { level: l(res0 ? 'm.level0' : 'm.levelRes') }))
  }

  // Beispiel: ein ruhiges Jahr, in dem sich der Kontostand genau um den Cashflow ändert
  let example: string | null = null
  for (let i = 1; i < L.length; i++) {
    const y = L[i].year, r = rowOf(y)
    // nur mit Guthaben auf dem Konto, sonst liest sich „liegen -2.067 € auf dem Konto“ schief
    if (!r || r.net === 0 || !visYears.has(y) || !quietYear(ctx, y) || L[i - 1].cash < 0 || L[i].cash < 0) continue
    if (L[i].cash - L[i - 1].cash !== r.net) continue
    example = lx('main', {
      year: y, prev: L[i - 1].year, prevCash: eur(L[i - 1].cash), cash: eur(L[i].cash),
      cf: r.net > 0 ? lx('pos', { year: y, v: eur(r.net) }) : lx('neg', { year: y, v: eur(-r.net) }),
    })
    break
  }

  const meaning: string[] = []
  if (!lw || !below.length) {
    meaning.push(res0 ? l('m.ok0') : l('m.ok', { reserve: eur(a.minimumReserve) }))
  } else {
    const low = below.reduce((b, q) => (q.cash < b.cash ? q : b))
    const s = [res0
      ? (below.length === 1
        ? l('m.belowOne0', { year: low.year, lowest: eur(low.cash) })
        : l('m.below0', { InYears: w.inYears(below.map(q => q.year), true), lowYear: low.year, lowest: eur(low.cash) }))
      : (below.length === 1
        ? l('m.belowOne', { year: low.year, reserve: eur(a.minimumReserve), lowest: eur(low.cash) })
        : l('m.below', { InYears: w.inYears(below.map(q => q.year), true), reserve: eur(a.minimumReserve), lowYear: low.year, lowest: eur(low.cash) })),
      low.cash >= 0 ? l('m.belowPos') : l(res0 ? 'm.belowNeg0' : 'm.belowNeg', { abs: eur(-low.cash) }),
    ]
    // Ursache des ersten Jahres unter der Reserve: kein Kauf, sondern der Cashflow
    const Y = below[0].year
    const i = L.findIndex(q => q.year === Y)
    const net = rowOf(Y)?.net ?? 0
    const prevCash = i > 0 ? L[i - 1].cash
      : (a.events.some(e => e.year === Y) || inv > 0 || a.properties.some(q => q.model) ? null : L[0].cash - net)
    const moveIsCf = i > 0 ? Math.abs(L[i].cash - L[i - 1].cash - net) <= 1 : prevCash != null
    if (!buyUntil(Y) && net < 0 && prevCash != null && prevCash >= a.minimumReserve - 1 && moveIsCf) {
      s.push(l(below.length > 1 ? 'm.causeFirst' : 'm.cause', { year: Y, net: eur(net) }))
    }
    meaning.push(s.join(' '))
  }
  // Größte Bewegung, die nicht aus dem Cashflow kommt
  let best: { i: number; d: number; net: number; diff: number } | null = null
  for (let i = 1; i < L.length; i++) {
    const net = rowOf(L[i].year)?.net ?? 0
    // aus den angezeigten, gerundeten Kontoständen: der Unterschied ist dann exakt
    const d = Math.round(L[i].cash) - Math.round(L[i - 1].cash)
    const diff = d - net
    if (Math.abs(diff) > 2 && (!best || Math.abs(diff) > Math.abs(best.diff))) best = { i, d, net, diff }
  }
  if (best) {
    const y = L[best.i].year
    const refi = a.events.some(e => e.kind === 'refinance' && e.year === y)
    const sale = a.events.some(e => e.kind === 'sale' && e.year === y)
    const eqOut = a.events.some(e => e.kind === 'purchase' && e.year === y)
      || a.properties.some(q => q.model && q.buyYear < y && y <= q.readyYear)
    const s = [l('m.move', {
      year: y, move: best.d >= 0 ? l('m.moveUp', { v: eur(best.d) }) : l('m.moveDown', { v: eur(-best.d) }), net: eur(best.net),
    })]
    if (best.diff < 0) {
      const minus = [refi ? l('m.minusRefi') : '', sale ? l('m.minusSale') : '', inv > 0 ? l('m.minusInvestor') : ''].filter(Boolean)
      const bought = a.events.some(e => e.kind === 'purchase' && e.year === y)
      if (bought || eqOut) {
        s.push(l(bought ? 'm.moveOut' : 'm.moveOutBuild', { diff: eur(-best.diff), offset: minus.length ? l('m.moveOffset', { list: w.list(minus) }) : '' }))
      }
    } else {
      const from = [refi ? l('m.fromRefi') : '', sale ? l('m.fromSale') : '', inv > 0 ? l('m.fromInvestor') : ''].filter(Boolean)
      if (from.length) s.push(l('m.moveIn', { diff: eur(best.diff), list: w.list(from), minusEq: eqOut ? l('m.moveMinusEq') : '' }))
    }
    if (a.recyclingRows.some(rr => rr.year === y)) s.push(l('m.moveSec', { sec: p('s4') }))
    if (s.length > 1) meaning.push(s.join(' '))
  }
  // Fallende Linie am Ende
  let k = L.length - 1, runStart: number | null = null
  while (k >= 1) {
    const net = rowOf(L[k].year)?.net ?? 0
    if (net < 0 && !a.events.some(e => e.year === L[k].year) && L[k].cash < L[k - 1].cash) { runStart = L[k].year; k-- } else break
  }
  if (runStart != null && last - runStart >= 1) meaning.push(l('m.tail', { year: runStart }))
  // Endstand
  const endCash = L[L.length - 1].cash
  meaning.push([
    endCash >= 0 ? l('m.end', { year: L[L.length - 1].year, cash: eur(endCash) }) : l('m.endNeg', { year: L[L.length - 1].year, abs: eur(-endCash) }),
    a.summary.exitNet == null && a.summary.cash === endCash ? l('m.endKpi', { kpi: p('kCash') }) : '',
  ].filter(Boolean).join(' '))

  const pit: string[] = []
  if (a.events.some(e => e.kind === 'refinance')) pit.push(l('pitfalls.refi'))
  if (a.events.some(e => e.kind === 'purchase') || a.properties.some(q => q.model)) pit.push(l('pitfalls.equity'))
  pit.push(l('pitfalls.yearEnd'))
  if (!res0) pit.push(l('pitfalls.reserve'))
  if (eventFreeYearsAddUp(a)) pit.push(l('pitfalls.rounding'))
  else if (quietYearsAddUp(ctx)) pit.push(l('pitfalls.roundingNarrow'))
  if (a.cashflowRows.filter(r => keyYearsOf(a).has(r.year) || r.rent > 0).length > 12) pit.push(l('pitfalls.cut', { more: p('more') }))

  return {
    heading: l('heading', { chart: p('c5') }),
    intro: l('intro'),
    items, example, meaning, pitfalls: pit,
  }
}

export function buildCashflowGuides(ctx: GuideCtx): Record<string, Guide | null> {
  return { cashflow: cashflowGuide(ctx), liquidity: liquidityGuide(ctx) }
}

// ── Gegenprüfung (eigene Rechnung, nicht derselbe Code) ──────────────────────
// Prüft jede Rechenaussage der Texte an den angezeigten, gerundeten Zahlen und
// jede Bedingung, unter der ein Satz erscheint, an ihrer eigenen Aussage.
export function checkGuides(ctx: GuideCtx, res: Record<string, Guide | null>): string[] {
  const { a, t } = ctx
  const out: string[] = []
  const lab = (k: string) => String(t(`strategie.${k}`))
  const cs = (k: string, o?: Vars) => String(o ? t(`${B}.cashflow.${k}`, o) : t(`${B}.cashflow.${k}`))
  const ls = (k: string, o?: Vars) => String(o ? t(`${B}.liquidity.${k}`, o) : t(`${B}.liquidity.${k}`))
  // fester Satzanfang einer Vorlage (bis zur ersten Variablen), zum Wiedererkennen
  const stem = (s: string) => s.split('{{')[0].trim()
  const stemOf = (path: string) => stem(String(t(path, { skipInterpolation: true })))
  const csRaw = (k: string) => stemOf(`${B}.cashflow.${k}`)
  const lsRaw = (k: string) => stemOf(`${B}.liquidity.${k}`)
  const all = (g: Guide) => [g.heading, g.intro, ...g.items.flatMap(i => [i.label, i.text]), g.example ?? '', ...g.meaning, ...g.pitfalls].join('\n')
  const keys = Object.keys(res).sort().join(',')
  if (keys !== 'cashflow,liquidity') out.push(`falsche Schlüssel: ${keys}`)
  const first = a.summary.firstYear, last = a.summary.lastYear
  const netOf = (y: number) => a.cashflowRows.find(x => x.year === y)?.net ?? 0
  const visRows = visibleRowsCheck(a)
  const visY = new Set(visRows.map(r => r.year))
  // Jahr im Text genannt, einzeln oder in einer Spanne „2026 bis 2028“
  const named = (text: string, y: number) => text.includes(String(y))
    || [...text.matchAll(/(\d{4}) (?:bis|to) (\d{4})/g)].some(m => Number(m[1]) <= y && y <= Number(m[2]))

  // ── cashflow ──
  const g = res.cashflow
  if (!g) out.push('cashflow fehlt')
  else {
    const txt = all(g)
    const meaning = g.meaning.join('\n')
    const itemText = (label: string) => g.items.find(i => i.label === label)?.text ?? ''
    const tpOn = a.cashflowRows.some(r => r.toPayments)
    const want = ['c4', 'lPos', 'lNeg', 'lCum', 'tYear', 'tRent', 'tCosts', 'tInterest', 'tAmort', 'tTax', 'tVat', ...(tpOn ? ['tToPay'] : []), 'tNet'].map(lab)
    const got = g.items.map(i => i.label)
    if (want.join('|') !== got.join('|')) out.push(`Spaltennamen weichen ab: ${got.join('|')} statt ${want.join('|')}`)
    // Balken nach unten
    const neg = a.cashflow.filter(x => x.cashflow < 0)
    const negSum = neg.reduce((s, x) => s + -x.cashflow, 0)
    if (neg.length && !meaning.includes(eur(negSum))) out.push(`Summe der Zuzahlungen ${eur(negSum)} fehlt`)
    if (neg.length > 1) {
      const worst = Math.max(...neg.map(x => -x.cashflow))
      if (!meaning.includes(eur(worst))) out.push(`größte Zuzahlung ${eur(worst)} fehlt`)
      if (neg.length === a.cashflow.length) {
        if (!meaning.includes(cs('m.negAll', { total: a.cashflow.length, sum: eur(negSum), worstYear: neg.find(x => -x.cashflow === worst)?.year ?? '', worst: eur(worst) }))) out.push('Satz „alle Jahre negativ“ fehlt oder Zahlen falsch')
      } else {
        const m = meaning.match(/\b(\d+) (?:von|of) (\d+)\b/)
        if (!m || Number(m[1]) !== neg.length || Number(m[2]) !== a.cashflow.length) out.push(`Anzahl negativer Jahre: „${m?.[0]}“ statt ${neg.length} von ${a.cashflow.length}`)
      }
    }
    if (!neg.length && meaning.includes(csRaw('m.negNone'))) {
      if (a.cashflow.some(x => x.cashflow < 0)) out.push('„kein Balken nach unten“, obwohl es einen gibt')
    }
    // Flacher Strich bei 0 €
    const zeroYears = a.cashflow.filter(x => x.cashflow === 0).map(x => x.year)
    const zeroTxt = csRaw('m.chartZero')
    if (zeroYears.length !== 0 !== itemText(lab('c4')).includes(zeroTxt)) out.push('Satz zum flachen Strich bei 0 € passt nicht zu den Daten')
    if (zeroYears.length && !zeroYears.every(y => named(itemText(lab('c4')), y))) out.push('Jahre mit 0 € nicht alle genannt')
    // Endpunkt der Linie
    const end = a.cashflow[a.cashflow.length - 1].cumulative
    const zeroPlan = a.cashflowRows.every(r => r.rent === 0 && r.costs === 0 && r.interest === 0 && r.net === 0)
    if (!zeroPlan && !meaning.includes(eur(end >= 0 ? end : -end))) out.push(`Endpunkt ${eur(end)} fehlt`)
    let run = 0
    for (const x of a.cashflow) run += x.cashflow
    if (Math.abs(run - end) > a.cashflow.length) out.push(`Balkensumme ${run} passt nicht zum Endpunkt ${end}`)
    const basis = a.scenarios.find(s => s.key === 'basis')
    if (meaning.includes(`„${lab('scCf')}“`) && basis?.cumulativeCashflow !== end) out.push('Szenario-Wert ungleich Endpunkt, Satz trotzdem da')
    if (tpOn) {
      const tps = a.cashflowRows.reduce((s, r) => s + (r.toPayments ?? 0), 0)
      const steps = Math.round((a.creditPath?.steps ?? []).reduce((s, x) => s + x.fromSurplus, 0))
      if (tps > 0 && !meaning.includes(eur(tps))) out.push(`Summe „für Kaufraten“ ${eur(tps)} fehlt`)
      if (Math.abs(tps - steps) > a.cashflowRows.length) out.push(`„für Kaufraten“ zusammen ${tps} ≠ aus Überschuss bezahlte Raten ${steps}`)
    } else {
      const vat = a.cashflowRows.reduce((s, r) => s + r.vatRefund, 0)
      if (vat > 0 && !meaning.includes(eur(vat))) out.push(`MwSt-Summe ${eur(vat)} fehlt`)
      if (vat > 0 && !meaning.includes(eur(Math.abs(end - vat)))) out.push(`Cashflow ohne MwSt ${eur(end - vat)} fehlt`)
    }
    // Reinvestment: Überschuss ist nicht „frei verfügbar“
    if (a.reinvest && (itemText(lab('lPos')).includes(cs('m.posFree')) || itemText(lab('tNet')).includes(cs('m.netGreen')))) out.push('Reinvestment: Überschuss als frei verfügbar beschrieben')
    // Minus trotz Topf: Hinweis und „weiter unten“ nur, wenn es so ein Jahr gibt
    const negTP = a.cashflowRows.filter(r => (r.toPayments ?? 0) > 0 && r.net < 0)
    const negText = itemText(lab('lNeg'))
    if ((negTP.length > 0) !== negText.includes(cs('m.negTP'))) out.push('Satz „Minus trotz Topf“ passt nicht zu den Daten')
    if (negText.includes(cs('m.negTPMore')) && !negTP.some(r => visY.has(r.year))) out.push('„Mehr dazu weiter unten“ ohne Satz weiter unten')
    if ((negTP.length > 0) !== g.pitfalls.some(s => s.includes(csRaw('pitfalls.tpMinus')))) out.push('Hinweis tpMinus passt nicht zu den Daten')
    // MwSt-Spalte
    const vatText = itemText(lab('tVat'))
    const exNeg = a.exits.some(e => e.vat < 0), exPos = a.exits.some(e => e.vat > 0)
    const shortLet = a.cashflowRows.some(r => r.vatRefund > 0) || a.exits.some(e => e.vat !== 0) || a.vatReturned.length > 0
    if (vatText.includes(cs('m.vatSale')) && !(shortLet && a.exits.length > 0)) out.push('Rückzahlung der MwSt genannt ohne Kurzzeitvermietung oder Verkauf')
    if (vatText.includes(cs('m.vatSale')) && exNeg && !exPos) out.push('Rückzahlung genannt, obwohl die Erstattung erst nach dem Verkauf käme')
    if (exNeg !== vatText.includes(cs('m.vatLate'))) out.push('Satz zur Erstattung nach dem Verkauf passt nicht zu den Daten')
    if (vatText.includes(cs('m.vatNone')) && (a.cashflowRows.some(r => r.vatRefund) || exNeg)) out.push('„keine Erstattung“, obwohl es eine gibt')
    // Beispielzeile
    if (g.example) {
      const y = Number(g.example.match(/\b(20\d\d)\b/)?.[1])
      const r = a.cashflowRows.find(x => x.year === y)
      if (!r) out.push(`Beispieljahr ${y} nicht in der Tabelle`)
      else {
        if (!visY.has(y)) out.push(`Beispieljahr ${y} in der Grundansicht nicht sichtbar`)
        const calc = r.rent - r.costs - r.interest - r.amortization - r.tax + r.vatRefund - (r.toPayments ?? 0)
        for (const v of [r.rent, r.costs, r.interest, r.amortization, Math.abs(r.tax), r.vatRefund, Math.abs(r.net)]) {
          if (v && !g.example.includes(eur(v))) out.push(`Beispiel ${y}: Wert ${eur(v)} fehlt`)
        }
        if (calc !== r.net && !g.example.includes(eur(calc))) out.push(`Beispiel ${y}: Rundungshinweis fehlt (${calc} statt ${r.net})`)
      }
    }
    // Zeilen mit Topf
    for (const r of visRows) {
      const tp = r.toPayments ?? 0
      if (tp <= 0) continue
      const sub = r.net + tp
      if (!meaning.includes(eur(Math.abs(sub)))) out.push(`${r.year}: Zwischensumme ${eur(sub)} fehlt`)
      if (r.net < 0 && !meaning.includes(eur(-r.net))) out.push(`${r.year}: Minus ${eur(-r.net)} fehlt`)
      const calc = r.rent - r.costs - r.interest - r.amortization - r.tax + r.vatRefund
      if (calc !== sub && !meaning.includes(eur(calc))) out.push(`${r.year}: Rundungshinweis fehlt`)
      const hPrev = r.year > first ? (a.wealth.find(x => x.year === r.year - 1)?.cash ?? 0) : 0
      const hEnd = r.year < last ? (a.wealth.find(x => x.year === r.year)?.cash ?? 0) : 0
      const paid = tp + hPrev - hEnd
      const stepPaid = Math.round((a.creditPath?.steps ?? []).filter(s => Math.floor(s.ym / 12) === r.year).reduce((s, x) => s + x.fromSurplus, 0))
      if (paid > 0 && meaning.includes(eur(paid)) && Math.abs(paid - stepPaid) > 2) out.push(`${r.year}: bezahlte Raten ${paid} ≠ Zahlungsplan ${stepPaid}`)
      if (Math.abs(tp - (stepPaid + hEnd - hPrev)) > 2) out.push(`${r.year}: Topf-Gleichung verletzt (${tp} ≠ ${stepPaid} + ${hEnd} - ${hPrev})`)
    }
    // Übergabejahre: Miete und Zahl der Monate
    for (const x of a.properties.filter(q => !q.model && q.readyMonth > 1)) {
      if (!visY.has(x.readyYear)) continue
      if (!meaning.includes(eur(x.rentFirstYear))) out.push(`Übergabe ${x.readyMonth}/${x.readyYear}: Miete ${eur(x.rentFirstYear)} fehlt`)
      const n = 13 - x.readyMonth
      if (!meaning.includes(n === 1 ? cs('m.monthsOne') : cs('m.monthsMany', { n }))) out.push(`Übergabe ${x.readyMonth}/${x.readyYear}: ${n} Monate fehlen`)
    }
    // Zinsen vor dem Start der Monatsrate im Übergabejahr
    if (meaning.includes(cs('m.negRealBridge'))) {
      const hy = visRows.filter(r => r.net < 0 && !r.toPayments && r.rent > 0 && r.net + r.amortization < 0
        && a.properties.some(q => q.readyYear === r.year && q.readyMonth > 1))
      const cp = a.creditPath
      for (const r of hy) {
        const ok = r.interest > 0 && !!cp && cp.steps.some(s => s.credit > 0 && Math.floor(s.ym / 12) <= r.year && s.ym % 12 <= (Math.floor(s.ym / 12) < r.year ? 11 : 10)
          && cp.loans.filter(q => q.name === s.unit).length === 1 && cp.loans.some(q => q.name === s.unit && Math.floor(q.startYm / 12) >= r.year && q.startYm > s.ym))
        if (!ok) out.push(`${r.year}: Zinsen vor der Monatsrate behauptet, aber kein abgerufener Kredit offen`)
      }
    }
    // MwSt-Jahre ohne Topf: Differenz zweier angezeigter Zahlen
    for (const r of visRows.filter(q => q.vatRefund > 0 && !q.toPayments)) {
      if (!meaning.includes(eur(r.net - r.vatRefund))) out.push(`${r.year}: Cashflow ohne MwSt ${eur(r.net - r.vatRefund)} fehlt`)
    }
    // Verkaufsjahr
    if (a.exitTotal && a.exits[0]?.year === last) {
      if (!meaning.includes(eur(a.exitTotal.net))) out.push(`Verkaufserlös ${eur(a.exitTotal.net)} fehlt`)
      const sr = a.cashflowRows.find(r => r.year === last)
      const runs = meaning.includes(cs('m.saleRun')) || meaning.includes(cs('m.saleRunHand'))
      if (runs && !(sr && sr.rent > 0)) out.push('Verkaufsjahr: „Miete bis Ende Dezember“ ohne Miete')
      if (meaning.includes(cs('m.saleZero')) && !(sr && sr.rent === 0 && sr.net === 0)) out.push('Verkaufsjahr: „0 €“ stimmt nicht')
      if (meaning.includes(cs('m.saleRunHand')) && !a.properties.some(q => !q.model && q.readyYear === last)) out.push('Verkaufsjahr: Übergabe im Verkaufsjahr behauptet')
      if (exNeg !== meaning.includes(cs('m.saleVatOpen'))) out.push('Verkauf: Satz zur offenen MwSt-Erstattung passt nicht')
      if (meaning.includes(cs('m.dedVat')) !== exPos) out.push('Verkauf: Rückzahlung von MwSt-Erstattung passt nicht')
    }
    if (a.exitTotal && a.exitTotal.equityBack > 0 && !meaning.includes(eur(a.exitTotal.equityBack))) out.push('zurückfließendes Eigenkapital fehlt')
    // Ausgeblendete Jahre: Definition der Stichjahre wie auf der Seite
    const ky = new Set<number>([first, first + 4, first + 9, last])
    const evYears = new Set(a.events.filter(e => e.kind === 'purchase' || e.kind === 'sale').map(e => e.year))
    if (a.reinvest) for (const y of evYears) ky.add(y)
    const hidden = a.cashflowRows.filter(r => !ky.has(r.year) && r.rent === 0)
    const keysRe = cs('m.keysRe'), keysBase = cs('m.keysBase')
    const hidTxt = g.meaning.find(s => s.includes(keysRe) || s.includes(keysBase))
    if (hidTxt) {
      if (hidTxt.includes(keysRe) !== a.reinvest) out.push('Stichjahre: Kauf/Verkauf genannt, obwohl die Tabelle sie nicht als Stichjahre führt (oder umgekehrt)')
      for (const r of hidden) {
        if (!named(hidTxt, r.year)) out.push(`ausgeblendetes Jahr ${r.year} nicht genannt`)
        if (evYears.has(r.year)) out.push(`ausgeblendetes Jahr ${r.year} ist ein Kauf-/Verkaufsjahr`)
      }
      const hs = hidden.reduce((s, r) => s + r.net, 0)
      if (!hidTxt.includes(eur(hs))) out.push(`Summe der ausgeblendeten Jahre ${eur(hs)} fehlt`)
    } else if (hidden.length && hidden.reduce((s, r) => s + r.net, 0) !== 0) out.push('ausgeblendete Jahre mit Cashflow nicht erklärt')
    // Umschalter „Alle Jahre anzeigen“ gibt es nur mit Reinvestment
    if (!a.reinvest && meaning.includes(`„${lab('more')}“`)) out.push('Umschalter genannt, den es ohne Reinvestment nicht gibt')
    if (/undefined|NaN/.test(txt)) out.push('cashflow: undefined/NaN')
  }

  // ── liquidity ──
  const lg = res.liquidity
  const on = a.reinvest && a.liquidity.length > 0
  if (on !== !!lg) out.push(`Liquidität ${lg ? 'gezeigt' : 'fehlt'} bei reinvest=${a.reinvest}, Punkte=${a.liquidity.length}`)
  if (lg) {
    const want = [lab('lCash'), lab('reserve'), ...(a.liquidityWarning ? [lab('liqTitle')] : [])]
    if (want.join('|') !== lg.items.map(i => i.label).join('|')) out.push(`Liquidität: Beschriftungen ${lg.items.map(i => i.label).join('|')}`)
    const L = a.liquidity
    const meaning = lg.meaning.join('\n')
    const res0 = a.minimumReserve === 0
    const inv = investorOf(ctx)
    const resText = lg.items.find(i => i.label === lab('reserve'))?.text ?? ''
    if (res0 !== resText.includes(ls('m.reserve0'))) out.push('Reserve 0 €: Text passt nicht')
    if (res0 && lg.pitfalls.includes(ls('pitfalls.reserve'))) out.push('Hinweis zur Reserve, obwohl keine vorgegeben ist')
    if (lg.example) {
      const y = Number(lg.example.match(/\b(20\d\d)\b/)?.[1])
      const i = L.findIndex(x => x.year === y)
      const r = a.cashflowRows.find(x => x.year === y)
      if (i < 1 || !r) out.push(`Liquiditätsbeispiel ${y} ungültig`)
      else {
        if (L[i].cash - L[i - 1].cash !== r.net) out.push(`Liquiditätsbeispiel ${y}: ${L[i - 1].cash} + ${r.net} ≠ ${L[i].cash}`)
        if (a.events.some(e => e.year === y)) out.push(`Liquiditätsbeispiel ${y}: Jahr mit Kauf/Refinanzierung/Verkauf`)
        for (const v of [L[i - 1].cash, L[i].cash, Math.abs(r.net)]) if (!lg.example.includes(eur(v))) out.push(`Liquiditätsbeispiel ${y}: ${eur(v)} fehlt`)
      }
    }
    const below = L.filter(x => x.cash < a.minimumReserve - 1)
    const lw = a.liquidityWarning
    if (below.length) {
      const low = Math.min(...below.map(x => x.cash))
      if (!meaning.includes(eur(low))) out.push(`Tiefpunkt ${eur(low)} fehlt`)
      if (lw && lw.lowest !== low) out.push('Tiefpunkt ≠ Hinweis der Seite')
      for (const x of below) if (!named(meaning, x.year)) out.push(`Jahr unter der Reserve ${x.year} nicht genannt`)
    } else if (lw) out.push('Hinweis ohne Jahr unter der Reserve')
    if (lw) {
      const warn = lg.items.find(i => i.label === lab('liqTitle'))?.text ?? ''
      const buy = a.events.some(e => e.kind === 'purchase' && e.year <= lw.to)
      if (warn.includes(ls('m.warnNoBuy', { to: lw.to })) && buy) out.push('„kein Kauf bis …“ behauptet, obwohl gekauft wird')
      if (warn.includes(ls('m.warnNoBuyAll')) && a.events.some(e => e.kind === 'purchase')) out.push('„kein weiterer Kauf“ behauptet, obwohl gekauft wird')
      if (warn.includes(ls('m.warnBuy')) && !buy) out.push('späterer Kauf als Ausweg genannt, obwohl vorher nichts gekauft wird')
      if ((lw.from === lw.to) !== warn.includes(ls('m.warnSingle', { from: lw.from }))) out.push('Kasten mit einem Jahr: Satz passt nicht')
      const ys = below.map(x => x.year)
      const gaps = ys.length > 1 && ys[ys.length - 1] - ys[0] + 1 !== ys.length
      if (gaps && lw.from !== lw.to && !warn.includes(lsRaw('m.warnGaps'))) out.push('Lücken im Zeitraum des Kastens nicht erklärt')
      if (!gaps && warn.includes(lsRaw('m.warnGaps'))) out.push('Lücken behauptet, die es nicht gibt')
      // Ursache „kein Kauf, sondern Cashflow“
      if (below.length && (meaning.includes(lsRaw('m.cause')) || meaning.includes(lsRaw('m.causeFirst')))) {
        const Y = below[0].year, i = L.findIndex(x => x.year === Y), net = netOf(Y)
        if (!meaning.includes(eur(net))) out.push(`Ursache: Cashflow ${eur(net)} fehlt`)
        if (a.events.some(e => e.kind === 'purchase' && e.year <= Y)) out.push('Ursache „kein Kauf“, obwohl vorher gekauft wird')
        if (!(net < 0)) out.push('Ursache „negativer Cashflow“ bei Cashflow ≥ 0')
        if (i > 0) {
          if (Math.abs(L[i].cash - L[i - 1].cash - net) > 1) out.push(`Ursache: Bewegung ${L[i].cash - L[i - 1].cash} ≠ Cashflow ${net}`)
          if (L[i - 1].cash < a.minimumReserve - 1) out.push('Ursache: Vorjahr lag schon unter der Reserve')
        } else if (L[0].cash - net < a.minimumReserve - 1) out.push('Ursache: Startkapital lag schon unter der Reserve')
      }
    }
    const endC = L[L.length - 1].cash
    if (!meaning.includes(eur(Math.abs(endC)))) out.push('Endstand Liquidität fehlt')
    if (endC < 0 && meaning.includes(ls('m.end', { year: L[L.length - 1].year, cash: eur(endC) }))) out.push('negativer Endstand als Guthaben beschrieben')
    // Hinweis „Kontostand Vorjahr + Cashflow“ an seiner eigenen Bedingung prüfen
    const shortRule = lg.pitfalls.includes(ls('pitfalls.rounding'))
    const narrowRule = lg.pitfalls.includes(ls('pitfalls.roundingNarrow'))
    if (shortRule && narrowRule) out.push('Rundungshinweis zur Liquidität doppelt')
    if (!shortRule && !narrowRule && (eventFreeYearsAddUp(a) || quietYearsAddUp(ctx))) out.push('Rundungshinweis zur Liquidität fehlt')
    for (let i = 1; i < L.length; i++) {
      const y = L[i].year
      const net = netOf(y)
      const d = Math.round(L[i].cash) - Math.round(L[i - 1].cash)
      const noEvent = !a.events.some(e => e.year === y)
      // kurze Fassung: JEDES Jahr ohne Kauf, Refinanzierung, Verkauf
      if (shortRule && noEvent && Math.abs(d - net) > 1) out.push(`${y}: kurzer Hinweis falsch, Kontostand weicht um ${d - net} vom Cashflow ab`)
      // enge Fassung: zusätzlich keine fällige Rate/Nebenkosten einer weiteren Wohnung, keine Einzahlung
      const quiet = noEvent && !a.properties.some(x => x.model && x.buyYear < y && y <= x.readyYear) && inv === 0
      if (narrowRule && quiet && Math.abs(d - net) > 1) out.push(`${y}: ruhiges Jahr, Kontostand weicht um ${d - net} vom Cashflow ab`)
      // „In den anderen Jahren fließt Eigenkapital ab oder Geld zu“: ohne Einzahlung nur Abfluss
      if (narrowRule && noEvent && !quiet && inv === 0 && d - net > 1) out.push(`${y}: Zufluss ohne Ereignis`)
    }
    // Satz „Unterschied ist Geld für weitere Wohnungen“ nur, wenn es ein Abfluss sein kann
    // fester Mittelteil des Satzes (der Anfang „Der Unterschied von“ ist mehreren Sätzen gemeinsam)
    const buildPart = ls('m.moveOutBuild', { diff: '\u0000', offset: '' }).split('\u0000')[1] ?? ''
    if (buildPart && meaning.includes(buildPart)) {
      const y = Number(lg.meaning.find(s => s.includes(buildPart))?.match(/\b(20\d\d)\b/)?.[1])
      if (!a.properties.some(x => x.model && x.buyYear < y && y <= x.readyYear)) out.push(`${y}: Raten für eine Wohnung im Bau behauptet, aber keine im Bau`)
    }
    const eqPit = lg.pitfalls.includes(ls('pitfalls.equity'))
    if (eqPit !== (a.events.some(e => e.kind === 'purchase') || a.properties.some(x => x.model))) out.push('Hinweis „Eigenkapital in weitere Wohnung“ passt nicht')
  }
  return out
}

function visibleRowsCheck(a: A): CashflowRow[] {
  const first = a.summary.firstYear
  const ky = new Set<number>([first, first + 4, first + 9, a.summary.lastYear])
  for (const p of a.portfolio) if (p.purchases || p.sales) ky.add(p.year)
  const rows: CashflowRow[] = []
  for (const r of a.cashflowRows) if (ky.has(r.year) || r.rent > 0) rows.push(r)
  return rows.slice(0, 12)
}
