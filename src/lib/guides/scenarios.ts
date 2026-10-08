// Erklaertexte fuer Szenarien (Abschnitt 9), Sensitivitaet, Portfolio
// (Abschnitt 3), Kapital-Recycling (Abschnitt 4) und den Gelegenheits-Kasten.
//
// Jede Zahl im Text kommt aus denselben gerundeten Werten, die auf der Seite
// stehen. Saetze mit einer Rechnung werden nur gezeigt, wenn die Rechnung mit
// den angezeigten Zahlen aufgeht. checkGuides() rechnet alles unabhaengig nach.
import type { Guide, GuideCtx, GuideItem } from './types'
import { eur, num } from './types'
import type { CustomerAnalytics, RecyclingRow } from '../analytics'
import { scenarioParams, type ScenarioKey } from '../strategy'

const G = 'strategie.guide'
type Vars = Record<string, string | number>

interface Reg { vars: Record<string, string>; conds: string[]; conflicts: string[] }
const REG = new WeakMap<Guide, Reg>()

// Kleiner Baukasten je Erklaerblock: liest die Texte, merkt sich alle
// eingesetzten Werte und die Bedingungen, auf die sich ein Satz stuetzt.
class Txt {
  readonly reg: Reg = { vars: {}, conds: [], conflicts: [] }
  private readonly ctx: GuideCtx
  private readonly id: string
  constructor(ctx: GuideCtx, id: string) { this.ctx = ctx; this.id = id }
  tx(key: string, v: Vars = {}): string {
    for (const [k, val] of Object.entries(v)) {
      const s = String(val)
      const old = this.reg.vars[k]
      if (old != null && old !== s) this.reg.conflicts.push(`${this.id}.${k}: ${old} / ${s}`)
      this.reg.vars[k] = s
    }
    return String(this.ctx.t(`${G}.${this.id}.${key}`, v))
  }
  // Beschriftungen der Seite selbst (damit sie exakt passen)
  page(key: string, v: Vars = {}): string { return String(this.ctx.t(`strategie.${key}`, v)) }
  when(name: string, ok: boolean): boolean { if (ok) this.reg.conds.push(`${this.id}.${name}`); return ok }
  item(label: string, textKey: string, v: Vars = {}): GuideItem { return { label, text: this.tx(`items.${textKey}.text`, v).trim() } }
  done(g: Guide): Guide { REG.set(g, this.reg); return g }
}

// ── Formatierung wie auf der Seite ──────────────────────────────────────────
const pctIrr = (x: number) => (x * 100).toFixed(1).replace('.', ',') + ' %'
const n1 = (x: number) => x.toFixed(1).replace('.', ',')
const parseEur = (s: string) => Number(s.replace(/[^\d-]/g, ''))
// Negative Glieder als Gegenrechnung („- -48.370 €" wird „+ 48.370 €")
function eqn(first: number, rest: Array<[string, number]>, res: number): string {
  return [eur(first), ...rest.map(([op, n]) => n < 0 ? `${op === '-' ? '+' : '-'} ${eur(-n)}` : `${op} ${eur(n)}`), '=', eur(res)].join(' ')
}
const join = (parts: string[], and: string) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')}${and}${parts[parts.length - 1]}`
const sentences = (parts: string[]) => parts.map(p => p.trim()).filter(Boolean).join(' ')

function shifted(ctx: GuideCtx, key: ScenarioKey) {
  const p = scenarioParams(ctx.params, key)
  return {
    g: ctx.a.reinvest ? p.reinvestAppreciationPct : p.growth,
    rg: p.rentGrowth, i: p.interest, m: p.maintPct,
  }
}

// Gemeinsame Fakten, die Text und Nachrechnung gleich bestimmen
// Jahre, die die Cashflow-Tabelle (Abschnitt 5) ohne Klick zeigt (Strategie.tsx)
function cfVisibleCount(a: CustomerAnalytics): number {
  const ky = keyYearsOf(a)
  return a.cashflowRows.filter(r => ky.has(r.year) || r.rent > 0).slice(0, 12).length
}
// Einzeln verkaufte eigene Wohnung innerhalb des Zeitraums
const hasOwnSale = (a: CustomerAnalytics) =>
  a.properties.some(p => !p.model && p.soldYear != null && p.soldYear <= a.summary.lastYear)
const hasVatRows = (a: CustomerAnalytics) => a.cashflowRows.some(r => r.vatRefund > 0)

// ═════════════════════════════════════════════════════════════════════════════
// 9 — Drei mögliche Entwicklungen
// ═════════════════════════════════════════════════════════════════════════════
function scenariosGuide(ctx: GuideCtx): Guide | null {
  const { a, params } = ctx
  if (a.scenarios.length < 3) return null
  const T = new Txt(ctx, 'scenarios')
  const [B, K, O] = a.scenarios
  const s = a.summary
  const wl = a.wealth[a.wealth.length - 1]
  const ri = a.reinvest
  const hasExit = !ri && B.exitNet != null && K.exitNet != null && O.exitNet != null
  const L = {
    scBasis: T.page('scBasis'), scCons: T.page('scCons'), scOpt: T.page('scOpt'),
    scUnits: T.page('scUnits'), scIrr: T.page('scIrr'), scCf: T.page('scCf'), scExit: T.page('scExit'),
    s1: T.page('s1'), s4: T.page('s4'), s5: T.page('s5'), s10: T.page('s10'),
    kUnits: T.page('kUnits'), kCash: T.page('kCash'), tNet: T.page('tNet'), tToPay: T.page('tToPay'),
  }
  const y = s.lastYear
  const pb = shifted(ctx, 'basis'), pk = shifted(ctx, 'konservativ'), po = shifted(ctx, 'optimistisch')
  const pv = {
    gB: num(pb.g), rgB: num(pb.rg), iB: num(pb.i), mB: num(pb.m),
    gK: num(pk.g), rgK: num(pk.rg), iK: num(pk.i), mK: num(pk.m),
    gO: num(po.g), rgO: num(po.rg), iO: num(po.i), mO: num(po.m),
  }

  // ── Einleitung ──
  const sameIrr = isFinite(B.irr) && isFinite(s.irr) ? pctIrr(B.irr) === pctIrr(s.irr) : !isFinite(B.irr) && !isFinite(s.irr)
  const sameCore = B.portfolioValue === s.portfolioValue && B.debt === s.debt && B.netWorth === s.netWorth && sameIrr
    && (B.exitNet ?? null) === (s.exitNet ?? null)
    && (!ri || (s.recyclingMultiple != null && B.recyclingMultiple.toFixed(1) === s.recyclingMultiple.toFixed(1)))
  const saleNote = T.when('saleYear', hasExit && a.exits.length > 0 && a.exits[0].year === y) ? T.tx('ex.p_sale') : ''
  const sameNote = T.when('sameAll', sameCore && B.units === s.unitsEnd) ? T.tx('ex.p_same', { scBasis: L.scBasis, s1: L.s1 })
    : T.when('sameCore', sameCore && B.units !== s.unitsEnd) ? T.tx('ex.p_sameButUnits', { scBasis: L.scBasis, s1: L.s1, scUnits: L.scUnits }) : ''
  const intro = T.tx('intro', { lastYear: y, saleYearNote: saleNote, scCf: L.scCf, introRi: ri ? T.tx('ex.p_ri') : '', sameNote })

  // ── Spalten und Zeilen ──
  // Der Text zu „Cashflow zusammen" sagt: Summe der Spalte Cashflow (Abschnitt 5).
  // Nur wenn das stimmt: Bei negativer Annahme (z. B. -1 % Mietsteigerung)
  // setzt scenarioParams auch „Wie geplant" auf mindestens 0 % und die Spalte
  // weicht vom Rest der Seite ab.
  const cfSumRaw = a.cashflowRows.reduce((x, r) => x + r.net, 0)
  const cfSumOk = T.when('cfSum', Math.abs(B.cumulativeCashflow - cfSumRaw) <= Math.ceil(a.cashflowRows.length / 2) + 1)
  const g0 = ri ? params.reinvestAppreciationPct : params.growth
  const clampParts = [
    ...(g0 < 0 ? [T.tx('ex.p_clampG', { gPlan: num(g0) })] : []),
    ...(params.rentGrowth < 0 ? [T.tx('ex.p_clampRg', { rgPlan: num(params.rentGrowth) })] : []),
  ]
  const ownSale = hasOwnSale(a)
  const vatRows = hasVatRows(a)
  const et0 = a.exitTotal
  const contrib = !params.selfFundingOnly && params.additionalEquityMonthly > 0
  const cfSumRounded = a.cashflowRows.reduce((x, r) => x + Math.round(r.net), 0)
  const cfRound = cfSumOk && T.when('cfRound', cfSumRounded !== B.cumulativeCashflow)
  const cfHidden = cfSumOk && T.when('cfHidden', cfVisibleCount(a) < a.cashflowRows.length)
  const sumParts = [
    ...(cfRound ? [T.tx('ex.p_cfRound')] : []),
    ...(cfHidden ? [ri ? T.tx('ex.p_cfMore', { more: T.page('more'), s3: T.page('s3') }) : T.tx('ex.p_cfHidden')] : []),
  ]
  const items: GuideItem[] = [
    T.item(T.page('scMetric'), 'metric'),
    T.item(L.scBasis, 'basis', { ...pv, clampNote: clampParts.length ? T.tx('ex.p_clamp', { clampList: join(clampParts, T.tx('ex.wAnd')), scBasis: L.scBasis }) : '' }),
    T.item(L.scCons, 'cons', { ...pv, consRi: ri ? T.tx('ex.p_consRi') : '' }),
    T.item(L.scOpt, 'opt', { ...pv, optRi: ri ? T.tx('ex.p_optRi') : '' }),
    T.item(L.scUnits, ri ? 'unitsRI' : 'units', { unitsSold: !ri && ownSale ? T.tx('ex.p_unitsSold') : '' }),
    T.item(T.page('scValue'), 'value', {
      valueNote: T.when('valueSale', hasExit && a.exitTotal != null && a.exitTotal.value === B.portfolioValue) ? T.tx('ex.p_valueSale') : '',
      valueSold: !ri && ownSale ? T.tx('ex.p_valueSold') : '',
    }),
    T.item(T.page('scDebt'), 'debt', {
      debtRi: ri ? T.tx('ex.p_debtRi') : '',
      debtNote: T.when('debtSale', hasExit && a.exitTotal != null && a.exitTotal.debt === B.debt) ? T.tx('ex.p_debtSale') : '',
    }),
    T.item(T.page('scWorth'), ri ? 'worthRI' : 'worth', { worthNote: hasExit ? T.tx('ex.p_worthSale') : '', scCf: L.scCf }),
    T.item(L.scIrr, 'irr', {
      how: ri
        ? T.tx('ex.p_irrRi', { contrib: !params.selfFundingOnly && params.additionalEquityMonthly > 0 ? T.tx('ex.p_contrib') : '' })
        : B.exitNet != null ? T.tx('ex.p_irrSale') : T.tx('ex.p_irrHold'),
      dash: T.when('irrDash', a.scenarios.some(x => !isFinite(x.irr))) ? T.tx('ex.p_irrDash') : '',
    }),
    T.item(L.scCf, 'cf', {
      vatPlus: vatRows ? T.tx('ex.p_cfVatPlus') : '',
      vat: vatRows ? T.tx('ex.p_cfVat') : '',
      payNote: a.cashflowRows.some(r => r.toPayments) ? T.tx('ex.p_cfPay', { tToPay: L.tToPay }) : '',
      sumSentence: cfSumOk ? T.tx('ex.p_cfSum', {
        scBasis: L.scBasis, tNet: L.tNet, s5: L.s5,
        sumNote: sumParts.length ? T.tx('ex.p_cfSumNote', { parts: sumParts.join('; ') }) : '',
      }) : '',
      negNote: ri ? T.tx('ex.p_cfNegRi', { negContrib: contrib ? T.tx('ex.p_cfNegContrib') : '' }) : T.tx('ex.p_cfNeg'),
      where: ri ? T.tx('ex.p_cfRi') : T.tx('ex.p_cfOut'),
    }),
    ri
      ? T.item(T.page('scRec'), 'rec', { s4: L.s4 })
      : T.item(L.scExit, B.exitNet != null ? 'exit' : 'exitNone', {
        firma: params.holder === 'firma' ? T.tx('ex.p_firma') : '',
        vatRepay: et0 && (et0.vat > 0 || vatRows || a.vatReturned.length > 0) ? T.tx('ex.p_vatRepay') : '',
        vatOpenNote: et0 && B.exitNet != null && T.when('vatOpen', et0.vat < 0)
          ? T.tx('ex.p_vatOpenItem', { vatOpen: eur(-et0.vat), scBasis: L.scBasis }) : '',
      }),
  ]

  // ── Beispiel ──
  const ex: string[] = [T.tx('ex.col', { scBasis: L.scBasis })]
  const wert = eur(B.portfolioValue), kredit = eur(B.debt), netto = eur(B.netWorth)
  const restLabel = (committed: number, held: number) =>
    committed > 0 && held > 0 ? T.tx('ex.pBoth') : committed > 0 ? T.tx('ex.pPaid') : T.tx('ex.pHeld')
  if (!ri) {
    const diff = B.netWorth - (B.portfolioValue - B.debt)
    const partsOk = diff > 1 && wl.committed >= 0 && wl.cash >= 0 && Math.abs(wl.committed + wl.cash - diff) <= 2
    if (B.portfolioValue > 0) {
      ex.push(T.tx('ex.aValue', { y, wert, kredit }))
      if (T.when('idNR', diff === 0)) ex.push(T.tx('ex.aRest', { eqnNR: eqn(B.portfolioValue, [['-', B.debt]], B.netWorth), netto }))
      else if (T.when('restPlus', partsOk)) ex.push(T.tx('ex.aRestPlus', { plus: eur(diff), what: restLabel(wl.committed, wl.cash), netto, eqnPlus: eqn(B.portfolioValue, [['-', B.debt], ['+', diff]], B.netWorth) }))
      else ex.push(T.tx('ex.aRestRound', { netto }))
    } else {
      ex.push(T.tx('ex.aNoValue', { y, wert }))
      if (T.when('onlyPaid', B.debt === 0 && partsOk && diff === B.netWorth)) {
        ex.push(T.tx('ex.aOnlyPaid', { netto, whatD: T.tx(wl.committed > 0 && wl.cash > 0 ? 'ex.pBothD' : wl.committed > 0 ? 'ex.pPaidD' : 'ex.pHeldD') }))
      }
      else ex.push(T.tx('ex.aRestRound', { netto }))
    }
    if (hasExit && B.exitNet != null && K.exitNet != null) {
      const et = a.exitTotal
      // Negative MwSt im Verkauf = noch offene Erstattung, die zum Erlös dazukommt
      const vatOpen = et && et.vat < 0 ? -et.vat : 0
      const abzug = B.netWorth + vatOpen - B.exitNet
      const abzugOk = diff === 0 && et != null && et.equityBack === 0 && wl.committed === 0
        && et.value === B.portfolioValue && et.debt === B.debt && et.net === B.exitNet && abzug > 0
        && Math.abs(et.costs + Math.max(0, et.vat) + et.tax - abzug) <= 2
      if (T.when('abzugOk', abzugOk) && et) {
        const what = join([
          ...(et.costs > 0 ? [T.tx('ex.wCosts')] : []),
          ...(et.tax > 0 ? [T.tx('ex.wTax')] : []),
          ...(et.vat > 0 ? [T.tx('ex.wVat')] : []),
        ], T.tx('ex.wAnd'))
        if (vatOpen > 0) {
          ex.push(T.tx('ex.aDeductVat', { whatDeduct: what, abzug: eur(abzug), vatOpen: eur(vatOpen), erloes: eur(B.exitNet), eqnExit: eqn(B.netWorth, [['-', abzug], ['+', vatOpen]], B.exitNet), scExit: L.scExit }))
        } else {
          ex.push(T.tx('ex.aDeduct', { whatDeduct: what, abzug: eur(abzug), erloes: eur(B.exitNet), eqnExit: eqn(B.netWorth, [['-', abzug]], B.exitNet), scExit: L.scExit }))
        }
      } else {
        ex.push(T.tx('ex.aLeftPlain', { erloes: eur(B.exitNet), scExit: L.scExit }))
        if (vatOpen > 0) ex.push(T.tx('ex.aVatOpen', { vatOpen: eur(vatOpen) }))
      }
      if (et && T.when('back', et.equityBack > 0)) ex.push(T.tx('ex.aBack', { back: eur(et.equityBack) }))
    }
    if (B.cumulativeCashflow > 0) ex.push(T.tx(hasExit ? 'ex.cfPos' : 'ex.cfPosHold', { cf: eur(B.cumulativeCashflow), scCf: L.scCf }))
    else if (B.cumulativeCashflow < 0) ex.push(T.tx('ex.cfNeg', { cf: eur(-B.cumulativeCashflow), scCf: L.scCf }))
    if (hasExit && B.exitNet != null && K.exitNet != null) {
      const d = B.exitNet - K.exitNet
      if (T.when('consExitLess', d > 0)) ex.push(T.tx('ex.consExitLess', { scCons: L.scCons, erloesK: eur(K.exitNet), diffErloes: eur(d), eqnDiff: eqn(B.exitNet, [['-', K.exitNet]], d) }))
      else if (T.when('consExitMore', d < 0)) ex.push(T.tx('ex.consExitMore', { scCons: L.scCons, erloesK: eur(K.exitNet), diffErloes: eur(-d) }))
    } else {
      const d = B.netWorth - K.netWorth
      if (T.when('consNwLess', d > 0)) ex.push(T.tx('ex.consNwLess', { scCons: L.scCons, nettoK: eur(K.netWorth), diffNetto: eur(d), eqnDiff: eqn(B.netWorth, [['-', K.netWorth]], d) }))
      else if (T.when('consNwMore', d < 0)) ex.push(T.tx('ex.consNwMore', { scCons: L.scCons, nettoK: eur(K.netWorth), diffNetto: eur(-d) }))
    }
  } else {
    const w = (n: number) => T.tx(n === 1 ? 'ex.w1' : 'ex.wN')
    ex.push(T.tx('ex.riValue', { units: B.units, w: w(B.units), wert, kredit }))
    const cash = s.cash
    if (cash >= 0) ex.push(T.tx('ex.riCash', { cash: eur(cash), kCash: L.kCash }))
    else ex.push(T.tx('ex.riCashNeg', { cashAbs: eur(-cash) }))
    if (T.when('idR', B.portfolioValue - B.debt + cash === B.netWorth)) {
      ex.push(T.tx('ex.riSum', { eqnR: eqn(B.portfolioValue, [['-', B.debt], cash >= 0 ? ['+', cash] : ['-', -cash]], B.netWorth), netto }))
    } else ex.push(T.tx('ex.riSumRound', { netto }))
    const d = B.netWorth - K.netWorth
    const wk = T.tx(K.units === 1 ? 'ex.w1' : 'ex.wN')
    if (T.when('consNwLess', d > 0)) ex.push(T.tx('ex.riConsLess', { scCons: L.scCons, unitsK: K.units, wK: wk, nettoK: eur(K.netWorth), diffNetto: eur(d), eqnDiff: eqn(B.netWorth, [['-', K.netWorth]], d) }))
    else if (T.when('consNwMore', d < 0)) ex.push(T.tx('ex.riConsMore', { scCons: L.scCons, unitsK: K.units, wK: wk, nettoK: eur(K.netWorth), diffNetto: eur(-d) }))
  }

  // ── Was das bedeutet ──
  const meaning: string[] = []
  // Alle drei Spalten gleich (z. B. Verkauf, bevor eine Wohnung übergeben ist)
  const shown = (x: typeof B) => [x.units, eur(x.portfolioValue), eur(x.debt), eur(x.netWorth), isFinite(x.irr) ? pctIrr(x.irr) : '-',
    eur(x.cumulativeCashflow), ri ? x.recyclingMultiple.toFixed(1) : (x.exitNet != null ? eur(x.exitNet) : '-')].join('|')
  if (T.when('allSame', shown(B) === shown(K) && shown(B) === shown(O))) {
    const none = T.when('noneReady', B.portfolioValue === 0)
    meaning.push(sentences([
      T.tx('m.allSame'),
      none ? T.tx('m.allSameWhy', { y }) : '',
      none && hasExit ? T.tx('m.allSameSale') : '',
    ]))
  }
  if (hasExit && B.exitNet != null && K.exitNet != null && O.exitNet != null) {
    if (T.when('rangeExit', K.exitNet <= B.exitNet && B.exitNet <= O.exitNet && K.exitNet < O.exitNet)) {
      meaning.push(T.tx('m.rangeExit', { erloesK: eur(K.exitNet), erloesO: eur(O.exitNet), erloes: eur(B.exitNet), scCons: L.scCons, scOpt: L.scOpt }))
    }
    const dp = B.exitNet > 0 ? Math.round((B.exitNet - K.exitNet) / B.exitNet * 100) : 0
    if (T.when('dropExit', B.exitNet > 0 && K.exitNet < B.exitNet && dp >= 1)) meaning.push(T.tx('m.dropExit', { dropPctExit: dp, scCons: L.scCons }))
  } else {
    if (T.when('range', K.netWorth <= B.netWorth && B.netWorth <= O.netWorth && K.netWorth < O.netWorth)) {
      meaning.push(T.tx('m.range', { nettoK: eur(K.netWorth), nettoO: eur(O.netWorth), netto, scCons: L.scCons, scOpt: L.scOpt }))
    }
    const dp = B.netWorth > 0 ? Math.round((B.netWorth - K.netWorth) / B.netWorth * 100) : 0
    if (T.when('drop', B.netWorth > 0 && K.netWorth < B.netWorth && dp >= 1)) meaning.push(T.tx('m.drop', { dropPct: dp, scCons: L.scCons }))
  }
  if (T.when('irrNegB', isFinite(B.irr) && B.irr <= -0.001)) meaning.push(T.tx('m.irrNegB', { irrB: pctIrr(B.irr), scBasis: L.scBasis }))
  else if (T.when('irrNegK', isFinite(K.irr) && K.irr <= -0.001)) meaning.push(T.tx('m.irrNegK', { irrK: pctIrr(K.irr), scCons: L.scCons }))
  else if (T.when('irrPos', isFinite(K.irr) && isFinite(B.irr) && K.irr >= 0.001 && K.irr < B.irr && pctIrr(K.irr) !== pctIrr(B.irr))) {
    meaning.push(T.tx('m.irrPos', { irrK: pctIrr(K.irr), irrB: pctIrr(B.irr), scCons: L.scCons }))
  } else if (T.when('irrSame', isFinite(K.irr) && isFinite(B.irr) && K.irr >= 0.001 && K.irr < B.irr && pctIrr(K.irr) === pctIrr(B.irr))) {
    meaning.push(T.tx('m.irrSame', { irrK: pctIrr(K.irr), scCons: L.scCons }))
  }
  if (!ri && T.when('cfNegK', K.cumulativeCashflow < 0)) meaning.push(T.tx('m.cfNegK', { cfK: eur(-K.cumulativeCashflow), scCons: L.scCons, scCf: L.scCf }))
  if (hasExit && B.exitNet != null && K.exitNet != null && O.exitNet != null
    && T.when('total', a.exitTotal != null && a.exitTotal.equityBack === 0 && wl.committed === 0 && wl.cash === 0)) {
    const tot = (x: typeof B) => (x.exitNet ?? 0) + x.cumulativeCashflow
    const eqnB = eqn(B.exitNet, [B.cumulativeCashflow >= 0 ? ['+', B.cumulativeCashflow] : ['-', -B.cumulativeCashflow]], tot(B))
    meaning.push(sentences([
      T.tx('m.total', { scExit: L.scExit, scCf: L.scCf, scBasis: L.scBasis, scCons: L.scCons, scOpt: L.scOpt, gesB: eur(tot(B)), gesK: eur(tot(K)), gesO: eur(tot(O)), eqnB }),
      T.when('ek', a.cost.ownEquity === s.originalEquity) ? T.tx('m.ek', { ek: eur(s.originalEquity) }) : '',
    ]))
  }
  if (ri) {
    if (T.when('unitsK', K.units < B.units)) meaning.push(T.tx('m.unitsK', { unitsK: K.units, units: B.units, scCons: L.scCons }))
    else if (T.when('unitsKMore', K.units > B.units && K.netWorth < B.netWorth)) meaning.push(T.tx('m.unitsKMore', { unitsK: K.units, units: B.units, scCons: L.scCons }))
    if (T.when('unitsOMore', O.units > B.units)) meaning.push(T.tx('m.unitsOMore', { unitsO: O.units, units: B.units, scOpt: L.scOpt }))
    else if (T.when('unitsOSame', O.units === B.units && O.netWorth > B.netWorth)) meaning.push(T.tx('m.unitsOSame', { unitsO: O.units, scOpt: L.scOpt }))
    else if (T.when('unitsOLess', O.units < B.units && O.netWorth > B.netWorth)) meaning.push(T.tx('m.unitsOLess', { unitsO: O.units, units: B.units, scOpt: L.scOpt }))
  }

  // ── Damit du es nicht falsch liest ──
  // Saisonmodell nur bei Kurzzeitvermietung; mit Reinvestment kann das Modell
  // nicht sehen, welche eigene Wohnung es nutzt, deshalb dort immer.
  const maybeShort = ri || vatRows || a.vatReturned.length > 0 || (et0 != null && et0.vat !== 0)
  const pitfalls = [
    T.tx('pitfalls.notWorst', { scCons: L.scCons }),
    T.tx('pitfalls.noProb'),
    ri ? T.tx('pitfalls.inWorth', { scCf: L.scCf }) : T.tx('pitfalls.twoPots', { scCf: L.scCf }),
    ...(hasExit ? [T.tx('pitfalls.beforeSale', { scExit: L.scExit, s10: L.s10 })] : []),
    T.tx('pitfalls.notYield', { scIrr: L.scIrr }),
    ...(B.exitNet == null ? [T.tx(ri || ownSale ? 'pitfalls.noSaleCostsRest' : 'pitfalls.noSaleCosts', { scIrr: L.scIrr })] : []),
    ...(!ri && T.when('unitsDiff', B.units !== s.unitsEnd) ? [T.tx('pitfalls.unitsDiff', { scUnits: L.scUnits, kUnits: L.kUnits, top: s.unitsEnd })] : []),
    T.tx('pitfalls.rateDay1', { scCons: L.scCons }),
    ...(maybeShort ? [T.tx('pitfalls.season', { scCons: L.scCons })] : []),
  ]
  return T.done({ heading: T.tx('heading'), intro, items, example: sentences(ex), meaning, pitfalls })
}

// ═════════════════════════════════════════════════════════════════════════════
// Sensitivität (nur mit Reinvestment)
// ═════════════════════════════════════════════════════════════════════════════
function sensitivityGuide(ctx: GuideCtx): Guide | null {
  const { a, params } = ctx
  if (a.sensitivity.length === 0) return null
  const T = new Txt(ctx, 'sensitivity')
  const S = a.sensitivity
  const B = a.scenarios[0]
  const scBasis = T.page('scBasis')
  const app = params.reinvestAppreciationPct
  const hl = S.find(x => x.appreciation === app)
  const list = join(S.map(x => num(x.appreciation)), T.tx('ex.wAnd'))
  const plan = hl
    ? (T.when('hlSame', B != null && hl.units === B.units && hl.netWorth === B.netWorth)
      ? T.tx('ex.p_planSame', { app: num(app), scBasis })
      : T.tx('ex.p_planHl', { app: num(app) }))
    : T.tx('ex.p_planNone', { app: num(app) })
  const intro = T.tx('intro', { lastYear: a.summary.lastYear, list, plan })
  const items: GuideItem[] = [
    T.item(T.tx('items.pct.label'), 'pct', {
      pgNote: params.purchasePriceGrowth == null ? T.tx('ex.p_pgLinked') : T.tx('ex.p_pgFixed', { pg: num(params.purchasePriceGrowth) }),
    }),
    T.item(T.tx('items.units.label'), 'units'),
    T.item(T.tx('items.worth.label'), 'worth'),
  ]
  const w = (n: number) => T.tx(n === 1 ? 'ex.w1' : 'ex.wN')
  const s0 = S[0], sN = S[S.length - 1]
  const ex: string[] = [T.tx(s0.appreciation === 0 ? 'ex.base0' : 'ex.base', { a0: num(s0.appreciation), u0: s0.units, w0: w(s0.units), n0: eur(s0.netWorth) })]
  if (hl && hl !== s0) {
    const unitsNote = hl.units !== s0.units ? T.tx('ex.p_planUnits', { a0: num(s0.appreciation), u0: s0.units, uP: hl.units, wP: w(hl.units) }) : ''
    if (T.when('planUp', hl.netWorth > s0.netWorth)) {
      const d = hl.netWorth - s0.netWorth
      ex.push(T.tx('ex.plan', { a0: num(s0.appreciation), aP: num(hl.appreciation), uP: hl.units, wP: w(hl.units), nP: eur(hl.netWorth), diffSens: eur(d), eqnPlan: eqn(hl.netWorth, [['-', s0.netWorth]], d), unitsNote }))
    } else if (T.when('planDown', hl.netWorth < s0.netWorth)) {
      const d = s0.netWorth - hl.netWorth
      ex.push(T.tx('ex.planLess', { a0: num(s0.appreciation), aP: num(hl.appreciation), uP: hl.units, wP: w(hl.units), nP: eur(hl.netWorth), diffSensLess: eur(d), eqnPlanLess: eqn(s0.netWorth, [['-', hl.netWorth]], d) }))
    }
  }
  if (sN !== s0 && T.when('spanUp', sN.netWorth > s0.netWorth)) {
    const d = sN.netWorth - s0.netWorth
    ex.push(T.tx('ex.span', { a0: num(s0.appreciation), aN: num(sN.appreciation), span: eur(d), eqnSpan: eqn(sN.netWorth, [['-', s0.netWorth]], d) }))
  }
  const meaning: string[] = []
  // Weniger Wohnungen bei mehr Wertsteigerung: einmal mit mehr, einmal mit
  // weniger Netto-Vermögen (jeweils das erste Kästchenpaar, bei dem es auftritt)
  const iDrop = S.findIndex((x, i) => i > 0 && x.units < S[i - 1].units && x.netWorth > S[i - 1].netWorth)
  if (T.when('drop', iDrop > 0)) {
    const H = S[iDrop], Lo = S[iDrop - 1]
    meaning.push(T.tx('m.drop', {
      aH: num(H.appreciation), uH: H.units, nH: eur(H.netWorth), aL: num(Lo.appreciation), uL: Lo.units, nL: eur(Lo.netWorth),
      why: params.purchasePriceGrowth == null ? T.tx('ex.p_dropWhy') : '',
    }))
  }
  const iLess = S.findIndex((x, i) => i > 0 && x.units < S[i - 1].units && x.netWorth < S[i - 1].netWorth)
  if (T.when('dropLess', iLess > 0 && params.purchasePriceGrowth == null)) {
    const H = S[iLess], Lo = S[iLess - 1]
    meaning.push(T.tx('m.dropLess', {
      bH: num(H.appreciation), vH: H.units, mH: eur(H.netWorth), bL: num(Lo.appreciation), vL: Lo.units, mL: eur(Lo.netWorth),
    }))
  }
  if (s0.appreciation === 0 && T.when('belowEk', s0.netWorth < a.summary.originalEquity)) {
    meaning.push(T.tx('m.belowEk', { n0: eur(s0.netWorth), ek: eur(a.summary.originalEquity) }))
  }
  const ratio = s0.netWorth > 0 ? sN.netWorth / s0.netWorth : 0
  if (sN !== s0 && T.when('ratio', s0.netWorth > 0 && ratio >= 1.1)) {
    meaning.push(T.tx('m.ratio', { aN: num(sN.appreciation), a0: num(s0.appreciation), ratio: n1(ratio) }))
  }
  const pitfalls = [
    T.tx('pitfalls.onlyOne', { scCons: T.page('scCons'), scOpt: T.page('scOpt') }),
    ...(s0.appreciation === 0 ? [T.tx('pitfalls.zeroNotWorst')] : []),
    T.tx('pitfalls.moreUnits'),
    T.tx('pitfalls.notCash'),
  ]
  return T.done({ heading: T.tx('heading'), intro, items, example: sentences(ex), meaning, pitfalls })
}

// ═════════════════════════════════════════════════════════════════════════════
// 3 — Wie dein Portfolio wächst (Treppe + Tabelle, nur mit Reinvestment)
// ═════════════════════════════════════════════════════════════════════════════
function keyYearsOf(a: CustomerAnalytics): Set<number> {
  // dieselbe Auswahl wie auf der Seite (Strategie.tsx: keyYears)
  return new Set<number>([
    a.summary.firstYear, a.summary.firstYear + 4, a.summary.firstYear + 9, a.summary.lastYear,
    ...a.portfolio.filter(p => p.purchases || p.sales).map(p => p.year),
  ])
}

function portfolioGuide(ctx: GuideCtx): Guide | null {
  const { a, params } = ctx
  if (!a.reinvest || a.portfolio.length === 0) return null
  const T = new Txt(ctx, 'portfolio')
  const tUnits = T.page('tUnits'), tValue = T.page('tValue'), tOwned = T.page('tOwned')
  const hasBuy = a.portfolio.some(p => p.purchases > 0)
  const hasSale = a.portfolio.some(p => p.sales > 0)
  const intro = T.tx('intro', { firstYear: a.summary.firstYear, lastYear: a.summary.lastYear })
  const items: GuideItem[] = [
    T.item(T.tx('items.line.label'), 'line'),
    ...(hasBuy ? [T.item(T.tx('items.buy.label'), 'buy')] : []),
    ...(hasSale ? [T.item(T.tx('items.sell.label'), 'sell')] : []),
    T.item(T.page('tYear'), 'year', { more: T.page('more') }),
    T.item(tOwned, 'owned'),
    T.item(tUnits, 'units', { tValue }),
    T.item(tValue, 'value', { app: num(params.reinvestAppreciationPct) }),
    T.item(T.page('tDebt'), 'debt'),
    T.item(T.page('tEquity'), 'equity'),
  ]
  const w = (n: number) => T.tx(n === 1 ? 'ex.w1' : 'ex.wN')
  const verb = (n: number) => T.tx(n === 1 ? 'ex.is1' : 'ex.isN')
  const ex: string[] = []
  const m = a.properties.filter(p => p.model).sort((x, z) => x.buyYear - z.buyYear)[0]
  if (m && T.when('firstBuy', a.portfolio.some(p => p.year === m.buyYear && p.purchases > 0))) {
    ex.push(T.tx('ex.buy', { buyYear: m.buyYear }))
    if (m.readyYear > m.buyYear) ex.push(T.tx('ex.buyLater', { readyYear: m.readyYear, tUnits }))
    else ex.push(T.tx('ex.buySame'))
  }
  const last = a.portfolio[a.portfolio.length - 1]
  const wl = a.wealth.find(x => x.year === last.year)
  if (wl && last.units > 0) {
    ex.push(T.tx('ex.last', {
      y: last.year, units: last.units, w: w(last.units), verb: verb(last.units),
      wert: eur(wl.propertyValue), kredit: eur(wl.debt), eqnLast: eqn(wl.propertyValue, [['-', wl.debt]], wl.propertyEquity),
    }))
  }
  const ky = keyYearsOf(a)
  const f = a.portfolio.find(p => ky.has(p.year) && p.owned > p.units)
  if (f) {
    const base = { fy: f.year, owned: f.owned, wF: w(f.owned), verbO: verb(f.owned) }
    if (f.units === 0) ex.push(T.tx(f.owned === 1 ? 'ex.firstNone1' : 'ex.firstNone', base))
    else ex.push(T.tx('ex.firstSome', { ...base, fUnits: f.units, verbF: verb(f.units) }))
  }
  const meaning: string[] = []
  const startUnits = a.properties.filter(p => !p.model).length
  if (T.when('grow', a.summary.unitsEnd > startUnits)) {
    meaning.push(T.tx(startUnits === 1 ? 'm.grow1' : 'm.grow', { start: startUnits, end: a.summary.unitsEnd, lastYear: a.summary.lastYear }))
  }
  if (T.when('noBuy', !a.properties.some(p => p.model))) {
    const sold = hasSale ? T.tx('ex.p_sold') : ''
    if (!params.autoReinvest) {
      const oppNote = a.opportunity && a.capitalSteps.length > 0
        ? T.tx('ex.p_oppHint', { oy: a.opportunity.year, s4: T.page('s4') }) : ''
      meaning.push(T.tx('m.noBuyOff', { sold, oppNote }))
    } else meaning.push(T.tx('m.noBuy', { sold }))
  }
  if (wl) {
    if (T.when('eqPct', wl.propertyValue > 0 && wl.propertyEquity > 0 && wl.debt > 0)) {
      meaning.push(T.tx('m.eqPct', { pct: Math.round(wl.propertyEquity / wl.propertyValue * 100) }))
    }
    if (T.when('nwPlus', wl.cash >= 0 && wl.committed >= 0 && wl.cash + wl.committed > 0)) {
      const parts = [
        ...(wl.cash > 0 ? [T.tx('m.p_cash', { cash: eur(wl.cash) })] : []),
        ...(wl.committed > 0 ? [T.tx('m.p_comm', { committed: eur(wl.committed) })] : []),
      ]
      const rest: Array<[string, number]> = [...(wl.cash > 0 ? [['+', wl.cash] as [string, number]] : []), ...(wl.committed > 0 ? [['+', wl.committed] as [string, number]] : [])]
      meaning.push(T.tx('m.nwPlus', { nw: eur(wl.netWorth), parts: join(parts, T.tx('ex.wAnd')), eqnNw: eqn(wl.propertyEquity, rest, wl.netWorth) }))
    } else if (T.when('nwMinus', wl.cash < 0)) {
      const rest: Array<[string, number]> = [['-', -wl.cash], ...(wl.committed > 0 ? [['+', wl.committed] as [string, number]] : [])]
      meaning.push(T.tx('m.nwMinus', { nw: eur(wl.netWorth), cashAbs: eur(-wl.cash), eqnNw: eqn(wl.propertyEquity, rest, wl.netWorth) }))
    }
  }
  if (a.events.some(e => e.kind === 'refinance' || e.kind === 'purchase')) meaning.push(T.tx('m.debtUp'))
  const ownLater = a.properties.some(p => !p.model && p.readyYear > a.summary.firstYear)
  const pitfalls = [
    sentences([T.tx('pitfalls.stepIsHandover'), ownLater ? T.tx('ex.p_ownSteps') : '']),
    ...(hasBuy && params.reinvestConstructionMonths > 0 ? [T.tx('pitfalls.greenNoRent')] : []),
    T.tx('pitfalls.ownedNotUnits', { tOwned, tUnits }),
    // Nur eigene Wohnungen im Bau: bei Modellwohnungen zählt die Analyse im
    // Kaufjahr die vollen Raten (auch den Bankanteil) als gebunden, das
    // erklärt der Text bewusst nicht als „von dir bezahlt".
    ...(a.properties.some(p => !p.model && p.readyYear > p.buyYear) ? [T.tx('pitfalls.earlyEquity')] : []),
    T.tx('pitfalls.notCash'),
    T.tx('pitfalls.estimate'),
    ...(hasBuy ? [T.tx('pitfalls.model')] : []),
  ]
  return T.done({ heading: T.tx('heading'), intro, items, example: ex.length ? sentences(ex) : null, meaning, pitfalls })
}

// ═════════════════════════════════════════════════════════════════════════════
// 4 — Wie dein Kapital mehrfach arbeitet (Faktor, Weg, Tabelle)
// ═════════════════════════════════════════════════════════════════════════════
const EV_REFI = 'Refinanzierung', EV_SALE = 'Verkauf', EV_BUY = 'Kauf'

function recyclingGuide(ctx: GuideCtx): Guide | null {
  const { a, params } = ctx
  if (!a.reinvest || a.capitalSteps.length === 0 || a.journey.length < 5) return null
  const T = new Txt(ctx, 'recycling')
  const s = a.summary
  const wl = a.wealth[a.wealth.length - 1]
  const J = a.journey
  const rows = a.recyclingRows
  const buys = rows.filter(r => r.event === EV_BUY)
  const refis = rows.filter(r => r.event === EV_REFI)
  const sales = rows.filter(r => r.event === EV_SALE)
  const recycleLabel = T.page('recycleLabel'), journeyTitle = T.page('journeyTitle')
  const tReinvested = T.page('tReinvested'), kNet = T.page('kNet'), kDebt = T.page('kDebt')
  const ek = s.originalEquity
  const faktor = s.recyclingMultiple != null ? n1(s.recyclingMultiple) : '0,0'
  const ltv = num(params.refinanceLtv)
  const contrib = !params.selfFundingOnly && params.additionalEquityMonthly > 0

  // Stationen: feste Positionen (Start, erste Käufe, Mieten, Eigenkapital ... Ergebnis)
  const jStart = J[0], jFirst = J[1], jRents = J[2], jEq = J[3], jNet = J[J.length - 1]
  const middle = J.slice(4, -1)
  const jRefi = refis.length > 0 ? middle[0] : undefined
  const jBuys = buys.length > 0 ? middle[middle.length - 1] : undefined
  const own = parseEur(jFirst.value), built = parseEur(jEq.value), rents = parseEur(jRents.value)
  const rec = jBuys ? parseEur(jBuys.value) : 0

  const kasse = join([
    T.tx('ex.kStart'), T.tx('ex.kSurplus'),
    ...(a.cashflowRows.some(r => r.vatRefund > 0) ? [T.tx('ex.kVat')] : []),
    ...(sales.length ? [T.tx('ex.kSale')] : []),
    ...(contrib ? [T.tx('ex.kContrib')] : []),
  ], T.tx('ex.wAnd'))
  const intro = T.tx('intro', { recycleLabel, journeyTitle, tablePart: rows.length ? T.tx('ex.p_table') : '', kasse })

  const ownCards = a.properties.filter(p => !p.model)
  const firstMoney = T.tx(ownCards.length === 1 ? 'ex.firstMoney1' : 'ex.firstMoneyN')
  const bank = ownCards.every(p => p.loan > 0) ? T.tx('ex.p_bankAll') : ownCards.every(p => p.loan <= 0) ? T.tx('ex.p_bankNone') : T.tx('ex.p_bankSome')
  const restNote = T.when('ownLeft', own < ek) ? T.tx('ex.p_restLeft', { left: eur(ek - own) })
    : T.when('ownOver', own > ek) ? T.tx('ex.p_restOver', { ek: eur(ek) }) : ''
  const items: GuideItem[] = [
    T.item(recycleLabel, 'factor', { faktor, ek: eur(ek), kasse }),
    T.item(jStart.label, 'jStart'),
    T.item(jFirst.label, ownCards.length === 1 ? 'jFirst1' : 'jFirst', { bank, restNote }),
    T.item(jRents.label, 'jRents'),
    T.item(jEq.label, 'jEq', { neg: built < 0 ? T.tx('ex.p_eqNeg') : '', jFirstLabel: jFirst.label, firstMoney }),
    ...(jRefi ? [T.item(jRefi.label, 'jRefi')] : []),
    ...(jBuys ? [T.item(jBuys.label, 'jBuys', { recycleLabel })] : []),
    T.item(jNet.label, 'jNet', { jComm: wl.committed > 0 ? T.tx('ex.p_jComm') : '', kNet }),
  ]
  if (rows.length) {
    const ev = [
      ...(refis.length ? [T.tx('ex.evRefi', { evRefi: EV_REFI })] : []),
      ...(sales.length ? [T.tx('ex.evSale', { evSale: EV_SALE })] : []),
      ...(buys.length ? [T.tx('ex.evBuy', { evBuy: EV_BUY })] : []),
    ]
    items.push(
      T.item(T.page('tYear'), 'year'),
      T.item(T.page('tEvent'), 'event', { list: sentences(ev) }),
      T.item(T.page('tSource'), 'source'),
      T.item(T.page('tAmount'), 'amount', { ltv, rates: params.reinvestConstructionMonths > 0 ? T.tx('ex.p_rates') : '' }),
      T.item(tReinvested, 'reinvested', { saleDash: sales.length ? T.tx('ex.p_saleDash') : '' }),
    )
  }

  // ── Beispiel ──
  const ex: string[] = []
  if (jBuys && s.recyclingMultiple != null && T.when('factorMath', ek > 0 && n1(rec / ek) === faktor)) {
    ex.push(T.tx('ex.factor', { rec: eur(rec), ek: eur(ek), faktor }))
  }
  const eqEnd = wl.propertyEquity
  if (T.when('journeyId', own + built === eqEnd)) {
    const firstWord = T.tx(ownCards.length === 1 ? 'ex.first1' : 'ex.firstN')
    if (built >= 0) ex.push(T.tx('ex.journey', { own: eur(own), built: eur(built), eqEnd: eur(eqEnd), eqnJ: eqn(own, [['+', built]], eqEnd), firstWord }))
    else ex.push(T.tx('ex.journeyNeg', { own: eur(own), eqEnd: eur(eqEnd), eqnJ: eqn(own, [['-', -built]], eqEnd), firstWord }))
    if (T.when('netId', eqEnd + wl.cash + wl.committed === wl.netWorth && wl.netWorth === s.netWorth)) {
      const rest: Array<[string, number]> = [
        wl.cash >= 0 ? ['+', wl.cash] : ['-', -wl.cash],
        ...(wl.committed > 0 ? [['+', wl.committed] as [string, number]] : []),
      ]
      const eqnN = eqn(eqEnd, rest, wl.netWorth)
      const comm = wl.committed > 0 ? T.tx('ex.p_comm', { committed: eur(wl.committed) }) : ''
      if (wl.cash >= 0) ex.push(T.tx('ex.net', { cash: eur(wl.cash), comm, nw: eur(wl.netWorth), eqnN }))
      else ex.push(T.tx('ex.netNeg', { cashAbs: eur(-wl.cash), comm, nw: eur(wl.netWorth), eqnN }))
    }
    if (T.when('cashNeg', wl.cash < 0)) ex.push(T.tx('ex.rentsNeg', { rents: eur(rents) }))
    else ex.push(T.tx(buys.length ? 'ex.rents' : 'ex.rentsNoBuy', { rents: eur(rents) }))
  }
  const k = buys.find(r => r.reinvested > 0)
  if (k) {
    const refY = refis.filter(r => r.year === k.year)
    const refiY = refY.reduce((x, r) => x + r.amount, 0)
    const eq = -k.amount
    if (T.when('refiY', refY.length > 0 && refiY === k.reinvested)) {
      ex.push(T.tx(refY.length === 1 ? 'ex.tRefi1' : 'ex.tRefiN', { y: k.year, nRefi: refY.length, refiY: eur(refiY), evRefi: EV_REFI }))
      ex.push(T.tx('ex.tBuy', { eq: eur(eq), evBuy: EV_BUY }))
      const restK = eq - k.reinvested
      if (restK > 0) ex.push(T.tx('ex.tRest', { reinv: eur(k.reinvested), rest: eur(restK), eqnT: eqn(k.reinvested, [['+', restK]], eq) }))
      else if (restK === 0) ex.push(T.tx('ex.tExact'))
      else ex.push(T.tx('ex.tOver', { over: eur(-restK), eqnT: eqn(k.reinvested, [['-', eq]], -restK) }))
    }
  }
  const k2 = buys.find(r => r.reinvested === 0)
  if (k2) ex.push(T.tx('ex.tCash', { y2: k2.year, eq2: eur(-k2.amount), tReinvested }))

  // ── Was das bedeutet ──
  const meaning: string[] = []
  if (T.when('noBuy', !jBuys && buys.length === 0)) {
    if (!params.autoReinvest) {
      const oppNote = a.opportunity ? T.tx('ex.p_oppBelow', { oy: a.opportunity.year }) : ''
      meaning.push(T.tx('m.noBuyOff', { faktor, oppNote }))
    } else meaning.push(T.tx('m.noBuy', { faktor }))
  }
  else if (T.when('zero', buys.length > 0 && faktor === '0,0')) meaning.push(T.tx('m.zero', { faktor }))
  else if (s.recyclingMultiple != null && T.when('below1', buys.length > 0 && s.recyclingMultiple < 0.95 && params.refinanceLtv >= 50)) {
    meaning.push(sentences([
      T.tx('m.below1', { ltv }),
      refis.length ? T.tx('ex.p_below1Refi') : '',
      T.tx(params.reinvestConstructionMonths > 0 ? 'ex.p_below1Count' : 'ex.p_below1CountNoRates'),
    ]))
  } else if (s.recyclingMultiple != null && T.when('above1', s.recyclingMultiple >= 0.95)) meaning.push(T.tx('m.above1', { faktor }))
  if (jRefi && T.when('refi', refis.length > 0)) {
    meaning.push(T.tx('m.refi', { refi: eur(parseEur(jRefi.value)), jRefiLabel: jRefi.label, kDebt, debt: eur(s.debt) }))
  }
  const eqSum = buys.reduce((x, r) => x - r.amount, 0)
  const refiSum = buys.reduce((x, r) => x + r.reinvested, 0)
  if (T.when('split', buys.length > 0 && buys.every(r => r.reinvested <= -r.amount))) {
    const restSum = eqSum - refiSum
    meaning.push(sentences([
      refiSum > 0
        ? T.tx(buys.length === 1 ? 'm.split1' : 'm.split', { n: buys.length, eqSum: eur(eqSum), refiSum: eur(refiSum), restSum: eur(restSum), eqnS: eqn(refiSum, [['+', restSum]], eqSum) })
        : T.tx(buys.length === 1 ? 'm.splitCash1' : 'm.splitCash', { n: buys.length, eqSum: eur(eqSum) }),
      jBuys && T.when('splitFactor', restSum > rec) ? T.tx('ex.p_splitFactor', { recycleLabel, rec: eur(rec) }) : '',
    ]))
  }
  const sale = sales[0]
  if (sale && sale.amount > 0) meaning.push(T.tx('m.sale', { ys: sale.year, net: eur(sale.amount), tReinvested }))
  const gain = s.netWorth - ek
  if (gain >= 0) meaning.push(sentences([T.tx('m.gain', { ek: eur(ek), lastYear: s.lastYear, gain: eur(gain), eqnG: eqn(s.netWorth, [['-', ek]], gain) }), contrib ? T.tx('ex.p_gainContrib') : '']))
  else meaning.push(T.tx('m.loss', { ek: eur(ek), lastYear: s.lastYear, lossAbs: eur(-gain), eqnG: eqn(ek, [['-', s.netWorth]], -gain) }))

  const pitfalls = [
    T.tx('pitfalls.notReturn'),
    T.tx('pitfalls.higherNotBetter'),
    T.tx('pitfalls.noSum'),
    T.tx('pitfalls.rentsOnly', { jRents: jRents.label, jEq: jEq.label }),
    ...(refis.length ? [
      T.tx('pitfalls.refiNotProfit', { evRefi: EV_REFI, saleGreen: sales.length ? T.tx('ex.p_saleGreen', { evSale: EV_SALE }) : '' }),
      T.tx('pitfalls.sameMoney'),
    ] : []),
    ...(buys.length ? [T.tx('pitfalls.notPrice')] : []),
    ...(rows.length ? [T.tx('pitfalls.twoThings', { tReinvested })] : []),
  ]
  return T.done({ heading: T.tx('heading'), intro, items, example: ex.length ? sentences(ex) : null, meaning, pitfalls })
}

// ═════════════════════════════════════════════════════════════════════════════
// Gelegenheits-Kasten (nur mit Reinvestment)
// ═════════════════════════════════════════════════════════════════════════════
function opportunityGuide(ctx: GuideCtx): Guide | null {
  const { a, params } = ctx
  const o = a.opportunity
  if (!a.reinvest || a.capitalSteps.length === 0 || !o) return null
  const T = new Txt(ctx, 'opportunity')
  const ltv = num(params.refinanceLtv)
  const reserve = eur(a.minimumReserve)
  // Die Probe „Reserve hält in allen Folgejahren" rechnet der Motor nur, wenn
  // er selbst kauft (reinvest.ts, nur mit autoReinvest)
  const intro = T.tx('intro', { reserve, probe: params.autoReinvest ? T.tx('ex.p_probe') : '' })
  const target = params.reinvestTargetKey != null && a.properties.some(p => !p.model && p.key === params.reinvestTargetKey)
  const pg = params.purchasePriceGrowth ?? (params.reinvestEnabled ? params.reinvestAppreciationPct : params.growth)
  const items: GuideItem[] = [
    T.item(T.page('oppTitle', { y: o.year }), 'title'),
    T.item(T.page('oppCap'), 'cap', {
      ltv,
      bvfNote: params.bankValuationFactor !== 100 ? T.tx('ex.p_bvf', { bvf: num(params.bankValuationFactor) }) : '',
      utilNote: params.refinanceUtilizationPct !== 100 ? T.tx('ex.p_util', { util: num(params.refinanceUtilizationPct) }) : '',
    }),
    T.item(T.page('oppModel'), 'price', { basis: target ? T.tx('ex.p_target') : T.tx('ex.p_avg'), pg: num(pg) }),
    T.item(T.page('oppEq'), 'eq', { ltv }),
  ]
  const buys = a.recyclingRows.filter((r: RecyclingRow) => r.event === EV_BUY)
  const k = buys.find(r => r.year === o.year)
  const ex: string[] = [o.capacity > 0
    ? T.tx('ex.base', { y: o.year, cap: eur(o.capacity), price: eur(o.modelPrice), req: eur(o.requiredEquity) })
    : T.tx('ex.baseNoCap', { y: o.year, cap: eur(o.capacity), price: eur(o.modelPrice), req: eur(o.requiredEquity) })]
  if (k) {
    const exact = T.when('sameEq', -k.amount === o.requiredEquity)
    ex.push(T.tx(exact ? 'ex.execExact' : 'ex.exec', { evBuy: EV_BUY, y: o.year }))
    if (k.reinvested > 0) {
      if (T.when('usedLess', k.reinvested < o.capacity)) ex.push(T.tx('ex.usedPart', { cap: eur(o.capacity), used: eur(k.reinvested) }))
      else ex.push(T.tx('ex.usedFull', { used: eur(k.reinvested) }))
    } else ex.push(T.tx('ex.noLoan'))
  } else ex.push(T.tx(params.autoReinvest ? 'ex.notExec' : 'ex.notExecOff'))
  const meaning: string[] = []
  if (k && T.when('firstBuy', buys[0] === k)) meaning.push(T.tx('m.exec', { y: o.year }))
  if (!k) meaning.push(T.tx('m.notExec', { cap: eur(o.capacity) }))
  if (T.when('reqGtCap', o.requiredEquity > o.capacity)) {
    const d = o.requiredEquity - o.capacity
    if (o.capacity > 0) meaning.push(T.tx('m.reqGtCap', { diffCap: eur(d), eqnC: eqn(o.requiredEquity, [['-', o.capacity]], d), reserve }))
    else meaning.push(T.tx('m.reqNoCap', { reserve }))
  }
  const pitfalls = [T.tx('pitfalls.noPromise'), T.tx('pitfalls.notBalance'), T.tx('pitfalls.modelPrice'),
    T.tx('pitfalls.moreThanShare', { eqPct: num(100 - params.refinanceLtv) })]
  return T.done({ heading: T.tx('heading'), intro, items, example: sentences(ex), meaning, pitfalls })
}

export function buildScenarioGuides(ctx: GuideCtx): Record<string, Guide | null> {
  return {
    scenarios: scenariosGuide(ctx),
    sensitivity: sensitivityGuide(ctx),
    portfolio: portfolioGuide(ctx),
    recycling: recyclingGuide(ctx),
    opportunity: opportunityGuide(ctx),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Unabhängige Nachrechnung
// ═════════════════════════════════════════════════════════════════════════════
// 1. Jede Gleichung „a € - b € = c €" im Text muss mit den Zahlen aufgehen.
// 2. Jeder eingesetzte Zahlenwert wird hier unabhängig aus den Daten der Seite
//    neu gebildet und muss gleich sein und im Text vorkommen.
// 3. Jede Bedingung, auf die sich ein Satz stützt, wird neu geprüft.
// 4. Kein Wohnungsname aus den Daten im Text.
const fmtE = (n: number) => eur(n)
const fmtP = (n: number) => String(n).replace('.', ',')

function factsOf(ctx: GuideCtx): Record<string, Record<string, string>> {
  const { a, params: p } = ctx
  const out: Record<string, Record<string, string>> = {}
  const s = a.summary
  const wl = a.wealth[a.wealth.length - 1]
  const [B, K, O] = a.scenarios
  if (B && K && O) {
    const g0 = p.reinvestEnabled ? p.reinvestAppreciationPct : p.growth
    const R2 = (x: number) => Math.round(x * 100) / 100
    const f: Record<string, string> = {
      lastYear: String(s.lastYear), y: String(s.lastYear),
      gB: fmtP(Math.max(0, R2(g0))), rgB: fmtP(Math.max(0, R2(p.rentGrowth))), iB: fmtP(Math.max(0.1, R2(p.interest))), mB: fmtP(Math.max(0, R2(p.maintPct))),
      gK: fmtP(Math.max(0, R2(g0 - 2))), rgK: fmtP(Math.max(0, R2(p.rentGrowth - 1))), iK: fmtP(Math.max(0.1, R2(p.interest + 1))), mK: fmtP(Math.max(0, R2(p.maintPct + 0.25))),
      gO: fmtP(Math.max(0, R2(g0 + 2))), rgO: fmtP(Math.max(0, R2(p.rentGrowth + 1))), iO: fmtP(Math.max(0.1, R2(p.interest - 0.5))), mO: fmtP(Math.max(0, R2(p.maintPct - 0.25))),
      wert: fmtE(B.portfolioValue), kredit: fmtE(B.debt), netto: fmtE(B.netWorth), nettoK: fmtE(K.netWorth), nettoO: fmtE(O.netWorth),
      plus: fmtE(B.netWorth - B.portfolioValue + B.debt),
      cf: fmtE(Math.abs(B.cumulativeCashflow)), cfK: fmtE(Math.abs(K.cumulativeCashflow)),
      diffNetto: fmtE(Math.abs(B.netWorth - K.netWorth)),
      cash: fmtE(s.cash), cashAbs: fmtE(Math.abs(s.cash)),
      units: String(B.units), unitsK: String(K.units), unitsO: String(O.units),
      irrB: (B.irr * 100).toFixed(1).replace('.', ',') + ' %', irrK: (K.irr * 100).toFixed(1).replace('.', ',') + ' %',
      dropPct: String(Math.round((B.netWorth - K.netWorth) / B.netWorth * 100)),
      ek: fmtE(s.originalEquity), top: String(s.unitsEnd),
      ...(a.exitTotal ? { back: fmtE(a.exitTotal.equityBack) } : {}),
    }
    if (B.exitNet != null && K.exitNet != null && O.exitNet != null) {
      Object.assign(f, {
        erloes: fmtE(B.exitNet), erloesK: fmtE(K.exitNet), erloesO: fmtE(O.exitNet),
        abzug: fmtE(B.netWorth + Math.max(0, -(a.exitTotal?.vat ?? 0)) - B.exitNet), diffErloes: fmtE(Math.abs(B.exitNet - K.exitNet)),
        dropPctExit: String(Math.round((B.exitNet - K.exitNet) / B.exitNet * 100)),
        gesB: fmtE(B.exitNet + B.cumulativeCashflow), gesK: fmtE(K.exitNet + K.cumulativeCashflow), gesO: fmtE(O.exitNet + O.cumulativeCashflow),
      })
    }
    if (a.exitTotal && a.exitTotal.vat < 0) f.vatOpen = fmtE(-a.exitTotal.vat)
    if (g0 < 0) f.gPlan = fmtP(g0)
    if (p.rentGrowth < 0) f.rgPlan = fmtP(p.rentGrowth)
    out.scenarios = f
  }
  if (a.sensitivity.length) {
    const S = a.sensitivity, s0 = S[0], sN = S[S.length - 1]
    const hl = S.find(x => x.appreciation === p.reinvestAppreciationPct)
    const f: Record<string, string> = {
      lastYear: String(s.lastYear), app: fmtP(p.reinvestAppreciationPct),
      a0: fmtP(s0.appreciation), u0: String(s0.units), n0: fmtE(s0.netWorth),
      aN: fmtP(sN.appreciation), span: fmtE(sN.netWorth - s0.netWorth),
      ek: fmtE(s.originalEquity), ratio: (sN.netWorth / s0.netWorth).toFixed(1).replace('.', ','),
    }
    if (p.purchasePriceGrowth != null) f.pg = fmtP(p.purchasePriceGrowth)
    if (hl) Object.assign(f, { aP: fmtP(hl.appreciation), uP: String(hl.units), nP: fmtE(hl.netWorth), diffSens: fmtE(hl.netWorth - s0.netWorth) })
    const i = S.findIndex((x, j) => j > 0 && x.units < S[j - 1].units && x.netWorth > S[j - 1].netWorth)
    if (i > 0) Object.assign(f, { aH: fmtP(S[i].appreciation), uH: String(S[i].units), nH: fmtE(S[i].netWorth), aL: fmtP(S[i - 1].appreciation), uL: String(S[i - 1].units), nL: fmtE(S[i - 1].netWorth) })
    const i2 = S.findIndex((x, j) => j > 0 && x.units < S[j - 1].units && x.netWorth < S[j - 1].netWorth)
    if (i2 > 0) Object.assign(f, { bH: fmtP(S[i2].appreciation), vH: String(S[i2].units), mH: fmtE(S[i2].netWorth), bL: fmtP(S[i2 - 1].appreciation), vL: String(S[i2 - 1].units), mL: fmtE(S[i2 - 1].netWorth) })
    if (hl) f.diffSensLess = fmtE(s0.netWorth - hl.netWorth)
    out.sensitivity = f
  }
  if (a.reinvest && a.portfolio.length) {
    const last = a.portfolio[a.portfolio.length - 1]
    const w = a.wealth.find(x => x.year === last.year)
    const firstModel = a.properties.filter(x => x.model).sort((x, z) => x.buyYear - z.buyYear)[0]
    const shown = new Set<number>([s.firstYear, s.firstYear + 4, s.firstYear + 9, s.lastYear, ...a.portfolio.filter(x => x.purchases || x.sales).map(x => x.year)])
    const fr = a.portfolio.find(x => shown.has(x.year) && x.owned > x.units)
    const f: Record<string, string> = {
      firstYear: String(s.firstYear), lastYear: String(s.lastYear), app: fmtP(p.reinvestAppreciationPct),
      y: String(last.year), units: String(last.units),
      start: String(a.properties.filter(x => !x.model).length), end: String(s.unitsEnd),
    }
    if (w) Object.assign(f, {
      wert: fmtE(w.propertyValue), kredit: fmtE(w.debt), nw: fmtE(w.netWorth), cash: fmtE(w.cash), cashAbs: fmtE(Math.abs(w.cash)),
      committed: fmtE(w.committed), pct: String(Math.round((w.propertyValue - w.debt) / w.propertyValue * 100)),
    })
    if (firstModel) Object.assign(f, { buyYear: String(firstModel.buyYear), readyYear: String(firstModel.readyYear) })
    if (fr) Object.assign(f, { fy: String(fr.year), owned: String(fr.owned), fUnits: String(fr.units) })
    if (a.opportunity) f.oy = String(a.opportunity.year)
    out.portfolio = f
  }
  if (a.reinvest && a.journey.length >= 5) {
    const ownEq = -(a.moneyFlow.find(m => m.label === 'In Immobilien gebunden')?.amount ?? NaN)
    const rentsMf = a.moneyFlow.find(m => m.label === 'Mieteinnahmen')?.amount ?? NaN
    const builtX = wl.propertyEquity - ownEq
    const rws = a.recyclingRows
    const buys = rws.filter(r => r.event === 'Kauf'), refis = rws.filter(r => r.event === 'Refinanzierung')
    const jW = a.journey.find(j => /^(Eine weitere Wohnung|\d+ weitere Wohnungen)$/.test(j.label))
    const f: Record<string, string> = {
      ek: fmtE(p.ek), faktor: (s.recyclingMultiple ?? 0).toFixed(1).replace('.', ','), ltv: fmtP(p.refinanceLtv),
      own: fmtE(ownEq), built: fmtE(builtX), eqEnd: fmtE(wl.propertyEquity), cash: fmtE(wl.cash), cashAbs: fmtE(Math.abs(wl.cash)),
      committed: fmtE(wl.committed), nw: fmtE(s.netWorth), rents: fmtE(rentsMf), left: fmtE(p.ek - ownEq),
      debt: fmtE(s.debt), refi: fmtE(refis.reduce((x, r) => x + r.amount, 0)),
      n: String(buys.length), eqSum: fmtE(buys.reduce((x, r) => x - r.amount, 0)), refiSum: fmtE(buys.reduce((x, r) => x + r.reinvested, 0)),
      restSum: fmtE(buys.reduce((x, r) => x - r.amount - r.reinvested, 0)),
      gain: fmtE(s.netWorth - p.ek), lossAbs: fmtE(p.ek - s.netWorth), lastYear: String(s.lastYear),
    }
    if (jW) f.rec = fmtE(parseEur(jW.value))
    const k = buys.find(r => r.reinvested > 0)
    if (k) Object.assign(f, {
      y: String(k.year), eq: fmtE(-k.amount), reinv: fmtE(k.reinvested), rest: fmtE(-k.amount - k.reinvested), over: fmtE(k.reinvested + k.amount),
      refiY: fmtE(refis.filter(r => r.year === k.year).reduce((x, r) => x + r.amount, 0)),
    })
    const k2 = buys.find(r => r.reinvested === 0)
    if (k2) Object.assign(f, { y2: String(k2.year), eq2: fmtE(-k2.amount) })
    const sale = rws.find(r => r.event === 'Verkauf')
    if (sale) Object.assign(f, { ys: String(sale.year), net: fmtE(sale.amount) })
    f.jFirstLabel = a.journey[1].label
    if (a.opportunity) f.oy = String(a.opportunity.year)
    out.recycling = f
  }
  if (a.reinvest && a.opportunity) {
    const o = a.opportunity
    const k = a.recyclingRows.find(r => r.event === 'Kauf' && r.year === o.year)
    out.opportunity = {
      y: String(o.year), reserve: fmtE(p.minimumCashReserve), eqPct: fmtP(100 - p.refinanceLtv), ltv: fmtP(a.financingKpis.assumedLtv),
      bvf: fmtP(p.bankValuationFactor), util: fmtP(p.refinanceUtilizationPct), pg: fmtP(p.purchasePriceGrowth ?? p.reinvestAppreciationPct),
      cap: fmtE(o.capacity), price: fmtE(o.modelPrice), req: fmtE(o.requiredEquity), diffCap: fmtE(o.requiredEquity - o.capacity),
      ...(k ? { used: fmtE(k.reinvested) } : {}),
    }
  }
  return out
}

function condsOf(ctx: GuideCtx): Record<string, boolean> {
  const { a, params: p } = ctx
  const s = a.summary
  const wl = a.wealth[a.wealth.length - 1]
  const c: Record<string, boolean> = {}
  const [B, K, O] = a.scenarios
  if (B && K && O) {
    const fin = (x: number) => Number.isFinite(x)
    const irrSame = fin(B.irr) && fin(s.irr) ? Math.abs(B.irr - s.irr) * 100 < 0.05 || (B.irr * 100).toFixed(1) === (s.irr * 100).toFixed(1) : !fin(B.irr) && !fin(s.irr)
    const core = B.portfolioValue === s.portfolioValue && B.debt === s.debt && B.netWorth === s.netWorth && irrSame && B.exitNet === s.exitNet
      && (!a.reinvest || (B.recyclingMultiple * 10).toFixed(0) === ((s.recyclingMultiple ?? -1) * 10).toFixed(0))
    const diff = B.netWorth - B.portfolioValue + B.debt
    const exitAll = !a.reinvest && B.exitNet != null && K.exitNet != null && O.exitNet != null
    const et = a.exitTotal
    Object.assign(c, {
      'scenarios.saleYear': exitAll && a.exits.some(e => e.year === s.lastYear),
      'scenarios.sameAll': core && B.units === s.unitsEnd,
      'scenarios.sameCore': core && B.units !== s.unitsEnd,
      'scenarios.valueSale': exitAll && et != null && et.value === B.portfolioValue,
      'scenarios.debtSale': exitAll && et != null && et.debt === B.debt,
      'scenarios.idNR': !a.reinvest && B.portfolioValue - B.debt === B.netWorth,
      'scenarios.restPlus': !a.reinvest && diff >= 2 && Math.abs(wl.committed + wl.cash - diff) <= 2,
      'scenarios.onlyPaid': !a.reinvest && B.portfolioValue === 0 && B.debt === 0 && Math.abs(wl.committed + wl.cash - B.netWorth) <= 2,
      'scenarios.abzugOk': exitAll && et != null && diff === 0 && et.equityBack === 0 && et.net === B.exitNet
        && Math.abs(et.costs + Math.max(0, et.vat) + et.tax - (B.netWorth + Math.max(0, -et.vat) - (B.exitNet ?? 0))) <= 2,
      'scenarios.vatOpen': exitAll && et != null && et.vat < 0,
      'scenarios.consExitLess': exitAll && (K.exitNet ?? 0) < (B.exitNet ?? 0),
      'scenarios.consExitMore': exitAll && (K.exitNet ?? 0) > (B.exitNet ?? 0),
      'scenarios.consNwLess': K.netWorth < B.netWorth,
      'scenarios.consNwMore': K.netWorth > B.netWorth,
      'scenarios.idR': a.reinvest && B.portfolioValue - B.debt + s.cash === B.netWorth,
      'scenarios.rangeExit': exitAll && (K.exitNet ?? 0) <= (B.exitNet ?? 0) && (B.exitNet ?? 0) <= (O.exitNet ?? 0),
      'scenarios.range': K.netWorth <= B.netWorth && B.netWorth <= O.netWorth,
      'scenarios.dropExit': exitAll && (B.exitNet ?? 0) > (K.exitNet ?? 0) && (B.exitNet ?? 0) > 0,
      'scenarios.drop': B.netWorth > K.netWorth && B.netWorth > 0,
      'scenarios.irrNegB': fin(B.irr) && B.irr < 0,
      'scenarios.irrNegK': fin(K.irr) && K.irr < 0,
      'scenarios.irrPos': fin(K.irr) && fin(B.irr) && K.irr > 0 && K.irr < B.irr && (K.irr * 100).toFixed(1) !== (B.irr * 100).toFixed(1),
      'scenarios.irrSame': fin(K.irr) && fin(B.irr) && K.irr > 0 && K.irr < B.irr && (K.irr * 100).toFixed(1) === (B.irr * 100).toFixed(1),
      'scenarios.cfNegK': K.cumulativeCashflow < 0,
      'scenarios.total': exitAll && et != null && et.equityBack === 0 && wl.committed === 0 && wl.cash === 0,
      'scenarios.ek': a.cost.ownEquity === s.originalEquity,
      'scenarios.unitsK': a.reinvest && K.units < B.units,
      'scenarios.unitsKMore': a.reinvest && K.units > B.units && K.netWorth < B.netWorth,
      'scenarios.unitsOMore': a.reinvest && O.units > B.units,
      'scenarios.unitsOSame': a.reinvest && O.units === B.units && O.netWorth > B.netWorth,
      'scenarios.unitsOLess': a.reinvest && O.units < B.units && O.netWorth > B.netWorth,
      'scenarios.unitsDiff': !a.reinvest && B.units !== s.unitsEnd,
      'scenarios.irrDash': a.scenarios.some(x => !fin(x.irr)),
      'scenarios.back': exitAll && et != null && et.equityBack > 0,
      // „Cashflow zusammen" (Wie geplant) = Summe der Spalte Cashflow, bis auf Rundung je Jahr
      'scenarios.cfSum': Math.abs(B.cumulativeCashflow - a.cashflowRows.reduce((x, r) => x + r.net, 0)) <= Math.ceil(a.cashflowRows.length / 2) + 1,
      'scenarios.cfRound': a.cashflowRows.map(r => Math.round(r.net)).reduce((x, v) => x + v, 0) !== B.cumulativeCashflow,
      'scenarios.cfHidden': (() => {
        const ky = [s.firstYear, s.firstYear + 4, s.firstYear + 9, s.lastYear, ...a.portfolio.filter(x => x.purchases > 0 || x.sales > 0).map(x => x.year)]
        return Math.min(12, a.cashflowRows.filter(r => ky.includes(r.year) || r.rent > 0).length) < a.cashflowRows.length
      })(),
      'scenarios.allSame': [K, O].every(x => x.units === B.units && x.portfolioValue === B.portfolioValue && x.debt === B.debt
        && x.netWorth === B.netWorth && x.cumulativeCashflow === B.cumulativeCashflow && x.exitNet === B.exitNet
        && (fin(x.irr) ? fin(B.irr) && (x.irr * 100).toFixed(1) === (B.irr * 100).toFixed(1) : !fin(B.irr))
        && x.recyclingMultiple.toFixed(1) === B.recyclingMultiple.toFixed(1)),
      'scenarios.noneReady': B.portfolioValue === 0,
    })
  }
  const S = a.sensitivity
  if (S.length) {
    const s0 = S[0], sN = S[S.length - 1]
    const hl = S.find(x => x.appreciation === p.reinvestAppreciationPct)
    let more = false, less = false
    for (let j = 1; j < S.length; j++) {
      if (S[j].units < S[j - 1].units && S[j].netWorth > S[j - 1].netWorth) more = true
      if (S[j].units < S[j - 1].units && S[j].netWorth < S[j - 1].netWorth) less = true
    }
    Object.assign(c, {
      'sensitivity.hlSame': !!hl && !!B && hl.units === B.units && hl.netWorth === B.netWorth,
      'sensitivity.planUp': !!hl && hl.netWorth > s0.netWorth,
      'sensitivity.planDown': !!hl && hl.netWorth < s0.netWorth,
      'sensitivity.spanUp': sN.netWorth > s0.netWorth,
      'sensitivity.drop': more,
      'sensitivity.dropLess': less && p.purchasePriceGrowth == null,
      'sensitivity.belowEk': s0.netWorth < s.originalEquity,
      'sensitivity.ratio': s0.netWorth > 0 && sN.netWorth / s0.netWorth >= 1.1,
    })
  }
  if (a.reinvest) {
    const firstModel = a.properties.filter(x => x.model).sort((x, z) => x.buyYear - z.buyYear)[0]
    const firstBuyYear = a.portfolio.find(x => x.purchases > 0)?.year
    const ownEq = -(a.moneyFlow.find(m => m.label === 'In Immobilien gebunden')?.amount ?? NaN)
    const jEqV = a.journey.length >= 4 ? parseEur(a.journey[3].value) : NaN
    const rws = a.recyclingRows
    const buys = rws.filter(r => r.event === 'Kauf')
    const k = buys.find(r => r.reinvested > 0)
    const sumRefiK = k ? rws.filter(r => r.event === 'Refinanzierung' && r.year === k.year).reduce((x, r) => x + r.amount, 0) : -1
    const jW = a.journey.find(j => /^(Eine weitere Wohnung|\d+ weitere Wohnungen)$/.test(j.label))
    const rec = jW ? parseEur(jW.value) : 0
    const restSum = buys.reduce((x, r) => x - r.amount - r.reinvested, 0)
    Object.assign(c, {
      'portfolio.firstBuy': !!firstModel && firstBuyYear === firstModel.buyYear,
      'portfolio.grow': s.unitsEnd > a.properties.filter(x => !x.model).length,
      'portfolio.noBuy': !a.properties.some(x => x.model),
      'portfolio.eqPct': wl.propertyValue > 0 && wl.propertyValue - wl.debt > 0,
      'portfolio.nwPlus': wl.netWorth > wl.propertyEquity && wl.cash >= 0,
      'portfolio.nwMinus': wl.cash < 0,
      'recycling.ownLeft': ownEq < p.ek,
      'recycling.cashNeg': wl.cash < 0,
      'recycling.ownOver': ownEq > p.ek,
      'recycling.factorMath': (rec / p.ek).toFixed(1) === (s.recyclingMultiple ?? 0).toFixed(1),
      'recycling.journeyId': ownEq + jEqV === wl.propertyEquity,
      'recycling.netId': wl.propertyEquity + wl.committed + wl.cash === s.netWorth,
      'recycling.refiY': !!k && sumRefiK === k.reinvested,
      'recycling.noBuy': buys.length === 0 && (s.recyclingMultiple ?? 0) === 0,
      'recycling.zero': buys.length > 0 && (s.recyclingMultiple ?? 0) < 0.05,
      'recycling.below1': buys.length > 0 && (s.recyclingMultiple ?? 0) < 1 && p.refinanceLtv >= 50,
      'recycling.above1': (s.recyclingMultiple ?? 0) >= 0.95,
      'recycling.refi': rws.some(r => r.event === 'Refinanzierung'),
      'recycling.split': buys.length > 0 && buys.every(r => r.reinvested <= -r.amount),
      'recycling.splitFactor': restSum > rec,
    })
    const o = a.opportunity
    if (o) {
      const kk = buys.find(r => r.year === o.year)
      Object.assign(c, {
        'opportunity.sameEq': !!kk && -kk.amount === o.requiredEquity,
        'opportunity.usedLess': !!kk && kk.reinvested < o.capacity,
        'opportunity.firstBuy': !!kk && buys[0] === kk,
        'opportunity.reqGtCap': o.requiredEquity > o.capacity,
      })
    }
  }
  return c
}

const AMT = '(-?\\d{1,3}(?:\\.\\d{3})*)\\s€'
const EQ_RE = new RegExp(`${AMT}((?:\\s[+-]\\s${AMT})+)\\s=\\s${AMT}`, 'g')
const TERM_RE = /([+-])\s(\d{1,3}(?:\.\d{3})*)\s€/g
const toN = (s: string) => Number(s.replace(/\./g, ''))

export function checkGuides(ctx: GuideCtx, res: Record<string, Guide | null>): string[] {
  const out: string[] = []
  const facts = factsOf(ctx)
  const conds = condsOf(ctx)
  const names = ctx.a.properties.filter(x => !x.model).map(x => x.name).filter(n => n && n.length >= 3)
  const want = ['scenarios', 'sensitivity', 'portfolio', 'recycling', 'opportunity']
  for (const id of want) if (!(id in res)) out.push(`${id}: fehlt im Ergebnis`)
  // Sichtbarkeit wie auf der Seite
  const vis: Record<string, boolean> = {
    scenarios: ctx.a.scenarios.length >= 3,
    sensitivity: ctx.a.sensitivity.length > 0,
    portfolio: ctx.a.reinvest,
    recycling: ctx.a.reinvest && ctx.a.capitalSteps.length > 0,
    opportunity: ctx.a.reinvest && ctx.a.capitalSteps.length > 0 && !!ctx.a.opportunity,
  }
  for (const id of want) if (vis[id] !== !!res[id]) out.push(`${id}: sichtbar=${!!res[id]}, Seite=${vis[id]}`)
  for (const [id, g] of Object.entries(res)) {
    if (!g) continue
    const text = [g.heading, g.intro, ...g.items.flatMap(i => [i.label, i.text]), g.example ?? '', ...g.meaning, ...g.pitfalls].join('\n')
    // 1. Gleichungen
    for (const mt of text.matchAll(EQ_RE)) {
      let v = toN(mt[1])
      for (const tm of mt[2].matchAll(TERM_RE)) v += (tm[1] === '+' ? 1 : -1) * toN(tm[2])
      const r = toN(mt[mt.length - 1])
      if (v !== r) out.push(`${id}: Rechnung geht nicht auf: ${mt[0]}`)
    }
    // 2. Zahlenwerte
    const reg = REG.get(g)
    if (!reg) { out.push(`${id}: keine Nachweise`); continue }
    for (const cf of reg.conflicts) out.push(`${id}: Platzhalter doppelt belegt ${cf}`)
    const f = facts[id] ?? {}
    for (const [k, v] of Object.entries(reg.vars)) {
      if (!(k in f)) continue
      if (f[k] !== v) out.push(`${id}: ${k} = ${v}, nachgerechnet ${f[k]}`)
      else if (!text.includes(v)) out.push(`${id}: ${k} (${v}) steht nicht im Text`)
    }
    // 3. Bedingungen
    for (const cn of reg.conds) {
      if (!(cn in conds)) out.push(`${id}: Bedingung ${cn} ungeprüft`)
      else if (!conds[cn]) out.push(`${id}: Bedingung ${cn} trifft nicht zu`)
    }
    // 4. keine Wohnungsnamen
    for (const n of names) if (text.includes(n)) out.push(`${id}: Wohnungsname im Text`)
    if (g.items.some(i => !i.label || !i.text)) out.push(`${id}: leerer Eintrag`)
  }
  return out
}
