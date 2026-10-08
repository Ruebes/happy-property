// Erklärtexte der Übersicht auf der Kundenseite (Strategie.tsx):
//   kpis      unter den Kacheln „Dein Ergebnis auf einen Blick“
//   balance   unter der Tabelle „Woraus dein Vermögen besteht“
//             (ersetzt das frühere Aufklapp-Feld „Warum das nicht dein Kontostand ist“)
//   wealth    unter dem Diagramm „Wert, Kredit und Eigenkapital“
//   financing unter Kacheln und Diagramm „Finanzierung und Beleihung“
//             (ersetzt das frühere Aufklapp-Feld zum Beleihungsgrad)
//
// Feste Texte stehen in den Sprachdateien unter strategie.guide.<id>, alle
// Zahlen kommen aus derselben Auswertung wie die Seite und werden genauso
// formatiert. Jede Rechnung in einem Beispiel oder Bedeutungs-Satz wird auf den
// angezeigten (gerundeten) Werten geprüft, bevor der Satz erscheint, und
// checkGuides rechnet sie unabhängig noch einmal nach.
import type { Guide, GuideCtx, GuideItem } from './types'
import { eur, num } from './types'
import type { CustomerAnalytics, WealthPoint } from '../analytics'

type Vars = Record<string, string | number>
type Tx = (key: string, vars?: Vars) => string

// Wie auf der Seite (Strategie.tsx pct und Kachel „Kapital-Recycling")
const pct1 = (n: number) => (isFinite(n) ? n.toFixed(1).replace('.', ',') : '0') + ' %'
const mult1 = (n: number) => `${n.toFixed(1).replace('.', ',')}×`
const ltvStr = (n: number) => `${num(n)} %`
// Negative Beträge wie in der Tabelle „Woraus dein Vermögen besteht" (echtes Minuszeichen)
const signedEur = (n: number) => (n < 0 ? `−${eur(-n)}` : eur(n))
const cap1 = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

function tx(ctx: GuideCtx, id: string): Tx {
  const base = `strategie.guide.${id}`
  return (key, vars = {}) => String(ctx.t(`${base}.${key}`, vars))
}

// „2027, 2028 und 2029"
function joinList(ctx: GuideCtx, xs: Array<string | number>): string {
  const s = xs.map(String)
  if (s.length <= 1) return s.join('')
  const and = String(ctx.t('strategie.guide.kpis.m.and'))
  return `${s.slice(0, -1).join(', ')} ${and} ${s[s.length - 1]}`
}
// Hauptsätze: „A, B, und C"
function joinClauses(ctx: GuideCtx, xs: string[]): string {
  if (xs.length <= 1) return xs.join('')
  const and = String(ctx.t('strategie.guide.kpis.m.and'))
  return `${xs.slice(0, -1).join(', ')}, ${and} ${xs[xs.length - 1]}`
}
function when(ctx: GuideCtx, years: number[]): string {
  const t = tx(ctx, 'kpis')
  return years.length === 1 ? t('m.inYear', { y: years[0] }) : t('m.inYears', { ys: joinList(ctx, years) })
}
const uniq = (xs: number[]) => [...new Set(xs)].sort((x, y) => x - y)

function guideOf(t: Tx, heading: string, intro: string, items: Array<[string, Vars?]>, example: string | null, meaning: string[], pitfalls: Array<string | [string, Vars]>): Guide {
  const its: GuideItem[] = items.map(([k, v]) => ({ label: t(`items.${k}.label`), text: t(`items.${k}.text`, v ?? {}) }))
  return {
    heading, intro, items: its, example, meaning,
    pitfalls: pitfalls.map(p => (typeof p === 'string' ? t(`pitfalls.${p}`) : t(`pitfalls.${p[0]}`, p[1]))),
  }
}

// ── Gemeinsame Kennwerte ─────────────────────────────────────────────────────
interface Facts {
  L: number
  w: WealthPoint
  lastYear: number
  exit: boolean
  reinvest: boolean
  firma: boolean
  own: number                 // Zeile „In Immobilien gebunden" (positiv)
  loans: number               // Summe der Darlehen auf den Wohnungskarten
  gap: number                 // Kredit am Ende minus (Darlehen + Refinanzierung - Tilgung)
  cum: number                 // aufsummierter Cashflow
  growth: number
  monthly: number             // monatliche Zuzahlung (nur Reinvestment, sonst 0)
  unusedClassic: boolean      // klassisch: Startkapital größer als gebraucht, Rest außerhalb des Modells
  costsOnTop: boolean         // klassisch: Differenz zum Startkapital sind genau die Kaufnebenkosten
  building: number            // gekaufte Wohnungen, die am Ende noch im Bau sind
  unbuiltDebt: number         // Teil des Kredits am Ende für Wohnungen im Bau (nur klassisch, sonst 0)
  chartWealth: boolean
  chartFinancing: boolean
}

// Schuld der am Ende übergebenen Wohnungen laut Karten. Ohne Wohnung im Bau ist
// sie genau der Kredit am Ende (Karten enthalten Bauträger-Raten und den
// Zwischenkredit-Anteil); der Rest gehört zu Wohnungen im Bau.
function deliveredCardDebt(a: CustomerAnalytics): number {
  const ly = a.summary.lastYear
  return a.properties
    .filter(p => p.readyYear <= ly && (p.soldYear == null || ly < p.soldYear))
    .reduce((s, p) => s + p.debtEnd, 0)
}

function factsOf(ctx: GuideCtx): Facts {
  const { a, params } = ctx
  const L = a.wealth.length - 1
  const w = a.wealth[L]
  const own = -(a.moneyFlow.find(m => m.label === 'In Immobilien gebunden')?.amount ?? 0)
  const loans = a.properties.reduce((s, p) => s + p.loan, 0)
  const k = a.financingKpis
  const building = a.portfolio.length ? a.portfolio[a.portfolio.length - 1].owned - a.summary.unitsEnd : 0
  const unbuilt = !a.reinvest && w.committed > 0 && k.debtEnd > 0 ? k.debtEnd - deliveredCardDebt(a) : 0
  return {
    L, w, lastYear: a.summary.lastYear,
    exit: a.summary.exitNet != null,
    reinvest: a.reinvest,
    firma: params.holder === 'firma',
    own, loans,
    gap: k.debtEnd - (loans + k.totalRefinanced - k.totalAmortization),
    cum: a.cashflow.length ? a.cashflow[a.cashflow.length - 1].cumulative : 0,
    growth: a.reinvest ? params.reinvestAppreciationPct : params.growth,
    monthly: a.reinvest && !params.selfFundingOnly ? Math.max(0, params.additionalEquityMonthly || 0) : 0,
    unusedClassic: !a.reinvest && own < a.summary.originalEquity && w.cash === 0,
    // Kaufnebenkosten sind 1 % des Kaufpreises ohne Möbel, also höchstens 1 % des
    // Gesamtpreises. Ist die Differenz größer (Barkauf mit zu wenig Eigenkapital),
    // ist es nicht nur Nebenkosten und der Satz entfällt.
    costsOnTop: !a.reinvest && own > a.summary.originalEquity && w.cash === 0
      && own - a.summary.originalEquity <= Math.ceil(a.properties.filter(p => !p.model).reduce((x, p) => x + p.gross, 0) * 0.01) + a.properties.length,
    building: Math.max(0, building),
    unbuiltDebt: unbuilt > 1 ? unbuilt : 0,
    // LineChart zeichnet erst ab zwei Jahren (StrategieCharts.tsx)
    chartWealth: a.wealth.length >= 2,
    chartFinancing: a.financing.length >= 2,
  }
}

// Kennzahlen der Verkaufsrechnung, wenn die Summe auf den angezeigten Werten aufgeht
function exitParts(a: CustomerAnalytics): { nw: number; net: number; diff: number } | null {
  const x = a.exitTotal
  if (a.summary.exitNet == null || !x) return null
  const diff = a.summary.netWorth - a.summary.exitNet
  if (diff <= 0 || diff !== x.costs + x.vat + x.tax + x.equityBack) return null
  return { nw: a.summary.netWorth, net: a.summary.exitNet, diff }
}

// Womit das Netto-Vermögen ohne Verkaufsrechnung verglichen wird: das Startkapital,
// ohne Reinvestment aber nur der eingesetzte Teil, wenn der Rest außerhalb des
// Modells bleibt (wie die Kachel „Vermögenszuwachs", analytics cost.wealthGain).
function gainBase(a: CustomerAnalytics, f: Facts): { base: number; used: boolean } {
  if (f.unusedClassic) return { base: a.cost.ownEquity, used: true }
  return { base: a.summary.originalEquity, used: false }
}

// ── 1 Ergebnis-Kacheln ───────────────────────────────────────────────────────
function buildKpis(ctx: GuideCtx, f: Facts): Guide {
  const { a } = ctx
  const t = tx(ctx, 'kpis')
  const s = a.summary
  const ek = s.originalEquity
  const purchases = a.events.filter(e => e.kind === 'purchase').length
  const refis = a.events.filter(e => e.kind === 'refinance').length
  const items: Array<[string, Vars?]> = [
    // Ohne Reinvestment zählen Überschüsse nur, wenn sie Bauträger-Raten bezahlen oder auf dem Konto liegen
    [f.reinvest ? 'kNetReinvest' : a.cashflowRows.some(r => (r.toPayments ?? 0) > 0) ? 'kNetPays' : 'kNet'],
    [f.growth === 0 ? 'kValueZero' : f.growth < 0 ? 'kValueNeg' : 'kValue', { g: num(Math.abs(f.growth)) }],
    ['kUnits'],
    [f.reinvest ? 'kIrrReinvest' : f.exit ? 'kIrrSale' : 'kIrrHold'],
    [f.reinvest ? 'kEquityReinvest' : f.own <= ek ? 'kEquityUnused' : 'kEquity'],
    ['kDebt'],
  ]
  if (s.recyclingMultiple != null) items.push(['kRecycle'])
  if (f.exit) {
    items.push([a.exitTotal && a.exitTotal.vat !== 0 ? 'kExitVat' : 'kExit', { firma: f.firma ? t('m.firmaTax') : '' }])
  } else items.push([f.reinvest ? 'kCashReinvest' : 'kCash'])
  items.push([f.reinvest ? (purchases > 0 && refis === 0 ? 'kTextReinvest0' : 'kTextReinvest') : f.exit ? 'kTextSale' : 'kText'])

  // Beispiel
  let example: string | null = null
  const ep = exitParts(a)
  if (ep && a.exitTotal) {
    const x = a.exitTotal
    let parts = t('ex.pCosts', { v: eur(x.costs) })
    if (x.vat > 0) parts += t('ex.plusVat', { v: eur(x.vat) })
    if (x.vat < 0) parts += t('ex.minusVatOpen', { v: eur(-x.vat) })
    if (x.tax > 0) parts += t(f.firma ? 'ex.plusTaxFirma' : 'ex.plusTax', { v: eur(x.tax) })
    if (x.equityBack > 0) parts += t('ex.plusEquityBack', { v: eur(x.equityBack) })
    example = t('ex.sale', {
      netWorth: eur(ep.nw), exitNet: eur(ep.net), diff: eur(ep.diff), parts,
      noTax: x.tax === 0 ? t('ex.noTax') : '',
    })
  } else {
    const { base, used } = gainBase(a, f)
    const diff = s.netWorth - base
    let caveat: string
    if (f.reinvest) caveat = t(f.monthly > 0 ? 'ex.caveatReinvestMonthly' : 'ex.caveatReinvest')
    else {
      const cl: string[] = []
      if (f.cum > 0) cl.push(t('ex.cPos', { cum: eur(f.cum) }))
      if (f.cum < 0) cl.push(t('ex.cNeg', { cum: eur(-f.cum) }))
      if (f.own > ek) cl.push(t('ex.cCosts'))
      cl.push(t(f.exit ? 'ex.cSaleIncl' : 'ex.cSale'))
      // Deutsch: ganzer Satz nach Doppelpunkt groß, Englisch klein (ex.capFirst)
      const joined = joinClauses(ctx, cl)
      caveat = `${t('ex.capFirst') === '1' ? cap1(joined) : joined}.`
    }
    const vars = { netWorth: eur(s.netWorth), ek: eur(ek), base: eur(base), diff: eur(Math.abs(diff)) }
    example = t(used ? 'ex.introUsed' : 'ex.intro', vars)
      + t(diff >= 0 ? 'ex.calcUp' : 'ex.calcDown', vars)
      // Die Kachel „Vermögenszuwachs" nur nennen, wenn sie genau diese Zahl zeigt
      + (a.cost.wealthGain === diff ? t(diff >= 0 ? 'ex.sameUp' : 'ex.sameDown') : '')
      + t(diff >= 0 ? 'ex.notGain' : 'ex.notLoss', { caveat })
  }

  // Bedeutung
  const m: string[] = []
  if (f.exit && a.exitTotal) {
    const x = a.exitTotal
    let txt = t('m.sale', {
      lastYear: f.lastYear, exitNet: eur(s.exitNet),
      ebPart: x.equityBack > 0 ? t('m.saleEquityBack', { eb: eur(x.equityBack) }) : '',
    })
    if (s.debt > 0 && x.debt === s.debt) txt += t('m.saleDebt', { debt: eur(s.debt) })
    if (f.w.committed > 0) txt += t('m.saleUnbuilt')
    m.push(txt)
  } else if (f.reinvest) m.push(t('m.reinvest', { netWorth: eur(s.netWorth) }))
  else m.push(t('m.hold', { lastYear: f.lastYear, netWorth: eur(s.netWorth) }))

  if (!isFinite(s.irr)) m.push(t(a.wealth.length === 1 ? 'm.irrNaN1' : 'm.irrNaN'))
  else {
    const irr = pct1(s.irr * 100)
    if (f.reinvest) {
      const cashEnd = a.liquidity.length ? a.liquidity[a.liquidity.length - 1].cash : null
      // Endwert der Rendite = Netto-Vermögen, solange keine weitere Kasse dazukommt
      if (cashEnd === f.w.cash) {
        m.push(t('m.irrReinvest', {
          irr, ek: eur(ek), netWorth: eur(s.netWorth),
          monthlyPart: f.monthly > 0 ? t('m.irrMonthlyPart', { monthly: eur(f.monthly) }) : '',
        }))
      }
    } else if (s.irr >= 0) {
      m.push(t(f.exit ? 'm.irrSale' : 'm.irrHold', { irr, committedPart: f.w.committed > 0 ? t('m.irrHoldCommitted') : '' }))
    }
    if (s.irr < 0 && !f.reinvest) m.push(t(f.exit ? 'm.irrNegSale' : 'm.irrNeg', { irr }))
  }
  if (!f.reinvest && f.cum > 0) m.push(t('m.cumPos', { cum: eur(f.cum) }))
  if (!f.reinvest && f.cum < 0) m.push(t('m.cumNeg', { cum: eur(-f.cum) }))
  if (f.costsOnTop) m.push(t('m.costsOnTop', { own: eur(f.own), extra: eur(f.own - ek), ek: eur(ek) }))
  if (f.unusedClassic) m.push(t('m.unusedEk', { own: eur(f.own), rest: eur(ek - f.own), ek: eur(ek) }))
  if (f.reinvest && a.cost.ownEquity < ek) {
    const rest = ek - a.cost.ownEquity
    const r = a.minimumReserve
    m.push(t(r > 0 && rest === r ? 'm.reinvestOwnReserveExact' : r > 0 && rest > r ? 'm.reinvestOwn' : 'm.reinvestOwnNoReserve', {
      ek: eur(ek), own: eur(a.cost.ownEquity), rest: eur(rest), reserve: eur(r),
    }))
  }
  if (f.monthly > 0) m.push(t('m.monthly', { monthly: eur(f.monthly), total: eur(f.monthly * 12 * a.wealth.length) }))
  if (f.building > 0) m.push(t(f.building === 1 ? 'm.building1' : 'm.buildingN', { n: f.building }))
  if (s.recyclingMultiple != null) {
    const refi = a.financingKpis.totalRefinanced
    if (s.recyclingMultiple > 0) {
      m.push(t('m.recycle', { mult: mult1(s.recyclingMultiple), p: Math.round(s.recyclingMultiple * 100) })
        + (refi > 0 ? t('m.recycleRefi', { refi: eur(refi) }) : ''))
    } else {
      m.push(t(purchases > 0 ? 'm.recycle0Refi' : 'm.recycle0None'))
    }
  }

  const pit: string[] = ['notCash']
  if (f.exit) pit.push('netVsExit')
  pit.push('irr')
  if (!f.reinvest) {
    if (f.own > ek) pit.push('equityNotAll')
    else if (a.cashflowRows.some(r => r.net < 0)) pit.push('equityTopUps')
  }
  pit.push('debtMore')
  if (s.recyclingMultiple != null) pit.push('recycle')
  if (!f.reinvest && !f.exit) pit.push('cashZero')
  pit.push('valueAssumption', 'model')
  return guideOf(t, t('heading'), t(f.reinvest ? 'introReinvest' : 'intro', { lastYear: f.lastYear }), items, example, m, pit)
}

// ── 1b Woraus dein Vermögen besteht ──────────────────────────────────────────
function balanceRow(a: CustomerAnalytics, label: string) { return a.balance.find(b => b.label === label) }

function buildBalance(ctx: GuideCtx, f: Facts): Guide | null {
  const { a } = ctx
  if (!a.balance.length) return null
  const t = tx(ctx, 'balance')
  const value = balanceRow(a, 'Wert der Immobilien')?.amount ?? 0
  const debt = -(balanceRow(a, 'Offene Kredite')?.amount ?? 0)
  const equity = balanceRow(a, 'Eigenkapital in den Immobilien')?.amount ?? 0
  const committedRow = balanceRow(a, 'In der Bauphase gebundenes Kapital')
  const cashRow = balanceRow(a, 'Liquidität')
  const cash = cashRow?.amount ?? 0
  const nw = balanceRow(a, 'Netto-Vermögen')?.amount ?? 0

  const items: Array<[string, Vars?]> = [['bValue'], ['bDebt'], ['bEquity']]
  if (committedRow) items.push(['bCommitted'])
  items.push([f.reinvest ? 'bCashReinvest' : 'bCash'], ['bNet'])

  let intro = t(committedRow ? 'introCommitted' : 'intro', { lastYear: f.lastYear })
  if (a.balance.some(b => b.hint)) intro += t('m.hover')

  // Beispiel: exakt per Konstruktion, trotzdem nur, wenn die Summen aufgehen
  let example: string | null = null
  const committed = committedRow?.amount ?? 0
  if (equity === value - debt && nw === equity + committed + cash) {
    const first = value === 0 && debt === 0 ? t('ex.noneDelivered') : t('ex.first', { value: eur(value), debt: eur(debt), equity: signedEur(equity) })
    const second = committedRow ? t('ex.committed', { committed: eur(committed) }) : ''
    const cashTxt = cash >= 0 ? t('ex.cash', { cash: eur(cash) }) : t('ex.cashNeg', { cash: eur(-cash) })
    example = t('ex.sum', { first, second, cashTxt, netWorth: eur(nw) })
  }

  const m: string[] = []
  const share = nw > 0 && equity > 0 ? Math.round(equity / nw * 100) : null
  m.push(t(equity < 0 ? 'm.notCashNeg' : 'm.notCash') + (share != null && share <= 100 ? t('m.share', { p: share }) : ''))
  // Negativ wegen Kredit für Wohnungen im Bau nur, wenn das sicher feststeht
  if (equity < 0) m.push(t(committedRow && f.unbuiltDebt > 0 ? 'm.negEquityBuild' : 'm.negEquityValue'))
  if (!f.reinvest && cash === 0 && f.cum > 0) m.push(t('m.liq0Pos', { cum: eur(f.cum) }))
  if (!f.reinvest && cash === 0 && f.cum < 0) m.push(t('m.liq0Neg', { cum: eur(-f.cum) }))
  if (!f.reinvest && cash > 0) {
    if (f.exit) m.push(t('m.heldSale', { cash: eur(cash) }))
    else m.push(t(cashRow?.hint ? 'm.heldEnd' : 'm.heldRates', { cash: eur(cash) }))
  }
  if (f.reinvest && a.minimumReserve > 0) {
    if (cash + 1 >= a.minimumReserve) m.push(t('m.reserveOk', { cash: eur(cash), reserve: eur(a.minimumReserve) }))
    else m.push(t('m.reserveLow', { cash: eur(cash), reserve: eur(a.minimumReserve) }))
  }
  if (committedRow) {
    const modelInBuild = a.properties.some(p => p.model && p.readyYear > f.lastYear)
    const key = f.building === 1 ? 'm.committed1' : f.building > 1 ? 'm.committedN' : 'm.committed'
    m.push(t(key, { committed: eur(committed), n: f.building }) + (modelInBuild ? t('m.committedModel') : ''))
  }
  if (f.exit && a.summary.exitNet != null) {
    m.push(t(a.exitTotal && a.exitTotal.vat > 0 ? 'm.saleVat' : 'm.sale', { lastYear: f.lastYear, exitNet: eur(a.summary.exitNet) }))
  }

  const pit = ['notStatement', 'equityMeaning', 'noSaleCosts', 'furniture', f.reinvest ? 'debtMoreReinvest' : 'debtMore']
  if (!f.reinvest) pit.push('surplusMissing')
  return guideOf(t, t('heading'), intro, items, example, m, pit)
}

// ── 2 Vermögensdiagramm ─────────────────────────────────────────────────────
// Erstes Jahr ohne Wohnung im Bau (mit uebergebenen Wohnungen) vor dem Ende
function wealthStart(a: CustomerAnalytics): number {
  const L = a.wealth.length - 1
  for (let i = 0; i < L; i++) if (a.wealth[i].committed === 0 && a.wealth[i].propertyValue > 0) return i
  return -1
}
// Laufendes Ergebnis eines Jahres ohne Tilgung (Tilgung senkt nur die Schuld):
// Miete minus Kosten, Zinsen und Steuern, plus MwSt-Erstattung, auf den Tabellenwerten
function operatingOf(a: CustomerAnalytics, year: number): number | null {
  const r = a.cashflowRows.find(x => x.year === year)
  return r ? r.rent - r.costs - r.interest - r.tax + r.vatRefund : null
}
// Ab- und Zunahme so formulieren, dass die Rechnung immer „größer minus kleiner" ist
function signedCalc(t: Tx, dv: number, dd: number): string {
  const de = dv + dd
  const A = eur(Math.abs(dv)), B = eur(Math.abs(dd)), C = eur(Math.abs(de))
  if ((dv >= 0) === (dd >= 0)) return t('ex.calcPlus', { a: A, b: B, c: C })
  return Math.abs(dv) >= Math.abs(dd) ? t('ex.calcMinus', { a: A, b: B, c: C }) : t('ex.calcMinus', { a: B, b: A, c: C })
}

function buildWealth(ctx: GuideCtx, f: Facts): Guide | null {
  const { a } = ctx
  if (!f.chartWealth) return null
  const t = tx(ctx, 'wealth')
  const W = a.wealth
  const L = f.L
  const hasMarkers = a.events.some(e => e.kind === 'purchase' || e.kind === 'sale')
  const hasSales = a.events.some(e => e.kind === 'sale')
  let intro = t('intro', { first: a.summary.firstYear, last: f.lastYear })
  if (hasMarkers) intro += t('m.markers')
  const items: Array<[string, Vars?]> = [[hasSales ? 'wValueSale' : 'wValue'], ['wDebt'], ['wEquity'], ['wNet']]

  // Beispiel
  let example: string | null = null
  const i0 = wealthStart(a)
  if (i0 >= 0) {
    const s0 = W[i0], sN = W[L]
    const dv = sN.propertyValue - s0.propertyValue
    const dd = s0.debt - sN.debt
    if (s0.propertyEquity === s0.propertyValue - s0.debt && sN.propertyEquity - s0.propertyEquity === dv + dd) {
      const inRange = (y: number) => y > s0.year && y <= sN.year
      const purchaseNote = a.events.some(e => e.kind === 'purchase' && inRange(e.year)) ? t('ex.purchaseNote') : ''
      // Kredite für weitere Käufe zwischen den beiden Jahren: Refinanzierung oder
      // Bankdarlehen einer bis zum Ende übergebenen Modellwohnung
      const newLoans = a.events.some(e => e.kind === 'refinance' && inRange(e.year))
        || a.events.some(e => e.kind === 'purchase' && a.properties.some(p => p.key === e.key && inRange(p.readyYear) && p.loan > 0))
      const de = dv + dd
      example = [
        t('ex.start', { y0: s0.year, v0: eur(s0.propertyValue), d0: eur(s0.debt), e0: eur(s0.propertyEquity) }),
        dv > 0 ? t('ex.valueUp', { yN: sN.year, vN: eur(sN.propertyValue), dv: eur(dv), purchaseNote })
          : dv < 0 ? t('ex.valueDown', { yN: sN.year, vN: eur(sN.propertyValue), dv: eur(-dv) })
            : t('ex.valueSame', { yN: sN.year, vN: eur(sN.propertyValue) }),
        dd > 0 ? t('ex.debtDown', { dN: eur(sN.debt), dd: eur(dd), note: newLoans ? t('ex.debtNoteDown') : '' })
          : dd < 0 ? t('ex.debtUp', { dN: eur(sN.debt), dd: eur(-dd), note: newLoans ? t('ex.debtNoteUp') : '' })
            : t('ex.debtSame', { dN: eur(sN.debt) }),
        t(de >= 0 ? 'ex.eqUp' : 'ex.eqDown', { de: eur(Math.abs(de)), eN: eur(sN.propertyEquity), calc: signedCalc(t, dv, dd) }),
      ].join(' ')
    }
  }

  const m: string[] = []
  const ek = a.summary.originalEquity
  if (W[0].netWorth < ek && !f.unusedClassic) {
    m.push(t('m.firstBelow', {
      y0: W[0].year, nw0: eur(W[0].netWorth), ek: eur(ek),
      cashPart: W[0].cash > 0 ? t('m.firstBelowCash') : '',
    }))
  }
  const negYears = W.filter(x => x.propertyEquity < 0 && x.committed > 0 && x.netWorth > 0).map(x => x.year)
  if (negYears.length) m.push(t('m.negEquity', { when: when(ctx, negYears) }))
  for (let i = 1; i < W.length; i++) {
    if (W[i].netWorth >= W[i - 1].netWorth) continue
    const y = W[i].year
    const drop = eur(W[i - 1].netWorth - W[i].netWorth)
    // Mit Reinvestment zählt die Kasse im Netto-Vermögen mit: Ein laufendes
    // Minus (vor Tilgung) senkt es in diesem Jahr zusätzlich.
    const op = operatingOf(a, y)
    const opLoss = f.reinvest && op != null && op < 0 ? t('m.dropOpLoss', { y }) : ''
    if (a.properties.some(p => p.model && p.readyYear === y)) m.push(t('m.dropModel', { y, drop }) + opLoss)
    else if (a.properties.some(p => !p.model && p.readyYear === y)) m.push(t('m.dropHandover', { y, drop }) + opLoss)
  }
  if (!f.reinvest) {
    for (let i = 0; i < L; i++) {
      const x = W[i]
      if (x.cash > 0 && x.committed === 0 && (a.cashflowRows[i]?.toPayments ?? 0) > 0) {
        m.push(t(a.surplusWithVat ? 'm.heldVat' : 'm.heldRent', { y: x.year, cash: eur(x.cash) }))
      }
    }
  }
  if (f.exit && a.summary.exitNet != null) m.push(t('m.sale', { lastYear: f.lastYear, exitNet: eur(a.summary.exitNet) }))
  const buyYears = uniq(a.events.filter(e => e.kind === 'purchase').map(e => e.year))
  if (buyYears.length) m.push(t(buyYears.length === 1 ? 'm.purchases1' : 'm.purchasesN', { years: joinList(ctx, buyYears) }))
  const saleYears = uniq(a.events.filter(e => e.kind === 'sale').map(e => e.year))
  if (saleYears.length) m.push(t(saleYears.length === 1 ? 'm.sales1' : 'm.salesN', { years: joinList(ctx, saleYears) }))

  const pit = ['gapNotGain', 'greyNotCash', 'blueAssumption', 'jump', 'startBelow', 'yearEnd']
  if (!f.reinvest) pit.push('surplusMissing')
  return guideOf(t, t('heading'), intro, items, example, m, pit)
}

// ── 6 Finanzierung und Beleihung ────────────────────────────────────────────
// Sichtbare Zeilen der Cashflow-Tabelle ohne „Alle Jahre anzeigen" (Strategie.tsx).
// Den Schalter gibt es nur im Abschnitt „Wie dein Portfolio wächst" (Reinvestment).
function cashflowRowVisible(a: CustomerAnalytics, year: number): boolean {
  const s = a.summary
  const key = new Set<number>([s.firstYear, s.firstYear + 4, s.firstYear + 9, s.lastYear,
    ...a.portfolio.filter(p => p.purchases || p.sales).map(p => p.year)])
  return a.cashflowRows.filter(r => key.has(r.year) || r.rent > 0).slice(0, 12).some(r => r.year === year)
}
// Jahr mit reiner Tilgung: Kredit Vorjahr - Tilgung = Kredit (größtes solches Jahr).
// Ohne Reinvestment nur sichtbare Jahre, weil die Tabelle dort keinen Schalter hat.
function pureAmortYear(a: CustomerAnalytics, visibleOnly: boolean): number {
  for (let i = a.wealth.length - 1; i >= 1; i--) {
    const am = a.cashflowRows[i]?.amortization ?? 0
    if (am > 0 && a.wealth[i - 1].debt - am === a.wealth[i].debt && (!visibleOnly || cashflowRowVisible(a, a.wealth[i].year))) return i
  }
  return -1
}
function ltvHolds(a: CustomerAnalytics): boolean {
  const k = a.financingKpis
  return a.summary.portfolioValue > 0 && Math.round(k.debtEnd / a.summary.portfolioValue * 1000) / 10 === k.ltvEnd
}
// Jahre, in denen der Kredit stärker sinkt als die Tilgung, weil Bautraeger-Raten bezahlt werden
function devPaidYears(a: CustomerAnalytics): Array<{ year: number; extra: number }> {
  if (a.reinvest) return []
  const out: Array<{ year: number; extra: number }> = []
  for (let i = 1; i < a.wealth.length; i++) {
    const r = a.cashflowRows[i]
    if (!r || !((r.toPayments ?? 0) > 0)) continue
    const extra = a.wealth[i - 1].debt - r.amortization - a.wealth[i].debt
    if (extra > 1) out.push({ year: a.wealth[i].year, extra })
  }
  return out
}
// Sicher ein Zwischenkredit für Wohnungen im Bau: In einem Jahr mit Wohnungen im
// Bau ist der Kredit höher, als alle bis dahin übergebenen Wohnungen überhaupt
// schulden können (Gesamtpreis minus Eigenkapital plus 1 % Nebenkosten).
function bridgeForBuildingYears(a: CustomerAnalytics): number[] {
  if (a.reinvest) return []
  const out: number[] = []
  for (const x of a.wealth) {
    if (!(x.committed > 0) || !(x.debt > 0)) continue
    const cap = a.properties
      .filter(p => p.readyYear <= x.year && (p.soldYear == null || x.year < p.soldYear))
      .reduce((s, p) => s + Math.max(p.loan, p.gross - p.equity + Math.ceil(p.gross * 0.012)), 0)
    if (x.debt > cap + 1) out.push(x.year)
  }
  return out
}
// Zeilen der Cashflow-Tabelle, die ohne Schalter ausgeblendet sind
function hiddenRows(a: CustomerAnalytics) {
  return a.cashflowRows.filter(r => !cashflowRowVisible(a, r.year))
}

function buildFinancing(ctx: GuideCtx, f: Facts): Guide {
  const { a, params } = ctx
  const t = tx(ctx, 'financing')
  const k = a.financingKpis
  const W = a.wealth
  const L = f.L
  const chart = f.chartFinancing
  const intro = !chart ? t('introNoChart') : t(f.reinvest ? 'introReinvest' : 'intro')
  const items: Array<[string, Vars?]> = [['fDebt'], ['fLtv'], ['fInterest'], ['fAmort']]
  if (chart) items.push(['cDebt'])
  const bv = params.bankValuationFactor ?? 100
  const util = params.refinanceUtilizationPct ?? 100
  if (chart && f.reinvest) {
    const adj = bv === 100 && util === 100 ? t('m.capAdjNone')
      : bv !== 100 && util !== 100 ? t('m.capAdjBoth', { bv: num(bv), u: num(util) })
        : bv !== 100 ? t('m.capAdjBv', { bv: num(bv) }) : t('m.capAdjU', { u: num(util) })
    items.push(['cCap', { l: num(k.assumedLtv), adj }])
  }

  // Beispiel: Darlehen minus Tilgung, sonst ein Jahr mit reiner Tilgung; dazu der Beleihungsgrad
  const ltvOk = ltvHolds(a)
  const ltvSentence = ltvOk ? t('ex.ltv', { debtEnd: eur(k.debtEnd), value: eur(a.summary.portfolioValue), ltv: ltvStr(k.ltvEnd) }) : ''
  let example: string | null = null
  if (k.debtEnd > 0 && f.loans > 0 && f.gap === 0) {
    const withLoan = a.properties.filter(p => p.loan > 0)
    const credit = withLoan.some(p => p.creditSoFar)
    const bank = withLoan.some(p => !p.creditSoFar)
    const refi = k.totalRefinanced > 0
    const am = k.totalAmortization
    const vars = { lastYear: f.lastYear, amort: eur(am), loans: eur(f.loans), refi: eur(k.totalRefinanced), debtEnd: eur(k.debtEnd) }
    example = t(credit ? (bank ? 'ex.loansMixed' : 'ex.loansCredit') : 'ex.loans', vars)
      + (refi ? t('ex.refi', vars) : '')
      + t(am > 0 ? (refi ? 'ex.amortRefi' : 'ex.amort') : (refi ? 'ex.amortNoneRefi' : 'ex.amortNone'), vars)
      + ltvSentence
  } else {
    const i = chart ? pureAmortYear(a, !f.reinvest) : -1
    if (i >= 1) {
      const y = W[i].year
      example = t('ex.year', {
        yPrev: W[i - 1].year, dPrev: eur(W[i - 1].debt), y, amort: eur(a.cashflowRows[i].amortization), d: eur(W[i].debt),
        hint: cashflowRowVisible(a, y) ? '' : t('ex.allYears'),
      }) + ltvSentence
    } else if (ltvOk) example = t('ex.ltvOnly', { debtEnd: eur(k.debtEnd), value: eur(a.summary.portfolioValue), ltv: ltvStr(k.ltvEnd) })
  }

  const m: string[] = []
  if (k.ltvEnd > 0) {
    const vars = { ltv: ltvStr(k.ltvEnd), ltvR: Math.round(k.ltvEnd), rest: 100 - Math.round(k.ltvEnd) }
    const unbuilt = f.unbuiltDebt > 0 ? t(f.building > 1 ? 'm.ltvCommittedN' : 'm.ltvCommitted1') : ''
    if (k.ltvEnd > 100) m.push(t('m.ltvOver', vars) + unbuilt)
    else if (unbuilt) m.push(t('m.ltvPart', vars) + unbuilt)
    else m.push(t('m.ltv', vars))
  }
  if (k.ltvEnd === 0 && k.debtEnd > 0 && a.summary.portfolioValue === 0) m.push(t('m.ltv0'))
  if (k.totalInterest > 0 || k.totalAmortization > 0) {
    let s = t(k.totalAmortization > 0 ? 'm.interest' : 'm.interestNoAmort', { interest: eur(k.totalInterest), amort: eur(k.totalAmortization) })
    if (k.totalInterest > k.totalAmortization && k.totalAmortization > 0) s += t('m.interestHigher')
    // Was außer den Bankdarlehen Zinsen kostet, nur soweit es sicher feststeht
    const devInt = (a.creditPath?.steps ?? []).some(x => x.interest > 0)
    const bridge = bridgeForBuildingYears(a).length > 0
    if (k.totalInterest > 0 && (devInt || bridge)) s += t(devInt && bridge ? 'm.interestDevBridge' : devInt ? 'm.interestDev' : 'm.interestBridge')
    m.push(s)
  }
  if (k.debtEnd > 0) {
    m.push(f.exit ? t('m.saleDebt', { lastYear: f.lastYear, debtEnd: eur(k.debtEnd) })
      : t('m.holdDebt', { lastYear: f.lastYear, debtEnd: eur(k.debtEnd) }))
  }
  if (f.gap > 0) m.push(t('m.gap', { gap: eur(f.gap) }))
  if (f.gap < 0 && k.debtEnd >= 0) {
    m.push(t(a.events.some(e => e.kind === 'sale') ? 'm.gapNegSale' : 'm.gapNegUnpaid', { gap: eur(-f.gap) }))
  }
  if (k.totalRefinanced > 0) m.push(t('m.refi', { refi: eur(k.totalRefinanced) }))

  if (chart) {
    // Wann und warum der Kredit steigt
    const ups: Array<{ year: number; delta: number }> = []
    for (let i = 0; i < W.length; i++) {
      const prev = i === 0 ? 0 : W[i - 1].debt
      if (W[i].debt > prev) ups.push({ year: W[i].year, delta: W[i].debt - prev })
    }
    if (ups.length) {
      const later = ups.filter(u => u.year !== W[0].year)
      let s = ''
      if (W[0].debt > 0) s += t('m.debtStart', { y: W[0].year, d: eur(W[0].debt) })
      if (later.length) s += t('m.debtUp', { list: joinList(ctx, later.map(u => t('m.upItem', { y: u.year, d: eur(u.delta) }))) })
      const ho: number[] = [], hoNoLoan: number[] = [], hoModel: number[] = [], refi: number[] = [], other: number[] = []
      for (const u of ups) {
        const y = u.year
        const nonModel = a.properties.filter(p => !p.model && p.readyYear === y)
        const model = a.properties.filter(p => p.model && p.readyYear === y)
        const isRefi = a.events.some(e => e.kind === 'refinance' && e.year === y)
        if (nonModel.some(p => p.loan > 0)) ho.push(y)
        else if (nonModel.length) hoNoLoan.push(y)
        if (model.length) hoModel.push(y)
        if (isRefi) refi.push(y)
        if (!nonModel.length && !model.length && !isRefi) other.push(y)
      }
      // eine Wohnung insgesamt / je Jahr genau eine / mehrere
      const kind = (ys: number[], pick: (p: CustomerAnalytics['properties'][number]) => boolean) => {
        const per = ys.map(y => a.properties.filter(p => pick(p) && p.readyYear === y).length)
        return per.length === 1 && per[0] === 1 ? '1' : per.every(n => n === 1) ? 'Each' : 'N'
      }
      if (ho.length) s += ' ' + t(`m.whyHandover${kind(ho, p => !p.model)}`, { when: when(ctx, ho) })
      if (hoNoLoan.length) s += ' ' + t(`m.whyHandoverNoLoan${kind(hoNoLoan, p => !p.model && !(p.loan > 0))}`, { when: when(ctx, hoNoLoan) })
      if (refi.length) s += ' ' + t('m.whyRefi', { when: when(ctx, refi) })
      if (hoModel.length) s += ' ' + t(`m.whyModel${kind(hoModel, p => !!p.model)}`, { when: when(ctx, hoModel) })
      // Überschüsse bezahlen Kaufraten nur in der Liquiditätsrechnung (Spalte „für Kaufraten")
      const surplusPays = a.cashflowRows.some(r => r.toPayments)
      if (other.length) s += ' ' + t(surplusPays ? 'm.whyOther' : 'm.whyOtherEquity', { when: when(ctx, other) })
      m.push(s.trim())
    }
    // Bautraeger-Raten senken die Schuld zusaetzlich zur Tilgung
    const dp = devPaidYears(a)
    if (dp.length) {
      const sum = dp.reduce((x, d) => x + d.extra, 0)
      const cards = a.properties.filter(p => (p.fromSurplus ?? 0) > 0)
      const fromSurplus = cards.reduce((x, p) => x + (p.fromSurplus ?? 0), 0)
      const src = a.surplusWithVat ? 'Vat' : 'Rent'
      m.push(t(dp.length === 1 ? 'm.devPaid1' : 'm.devPaidN', { when: when(ctx, dp.map(d => d.year)), extra: eur(sum) })
        + (sum === fromSurplus && cards.length ? t(`m.devSurplus${src}${cards.length === 1 ? '1' : 'N'}`, { extra: eur(sum) }) : ''))
    }
    // Hoechster Stand
    let iMax = 0
    for (let i = 1; i < W.length; i++) if (W[i].debt > W[iMax].debt) iMax = i
    if (W[iMax].debt > 0) {
      m.push(t('m.peak', { yMax: W[iMax].year, dMax: eur(W[iMax].debt) })
        + (iMax < L && W[L].debt < W[iMax].debt ? t('m.peakAfter', { yN: W[L].year, dN: eur(W[L].debt) }) : ''))
    }
    if (!f.reinvest) m.push(t('m.noCapLine'))
    else {
      const F = a.financing
      const capN = F[F.length - 1].capacity
      if (capN > 0) {
        const value = W[L].propertyValue
        let calc = ''
        if (bv === 100 && util === 100) {
          const maxN = Math.round(k.assumedLtv / 100 * value)
          if (maxN - W[L].debt === capN) calc = t('m.capCalc', { l: num(k.assumedLtv), value: eur(value), max: eur(maxN), debt: eur(W[L].debt), cap: eur(capN) })
        } else {
          const bankValue = Math.round(value * bv / 100)
          const maxN = Math.round(bankValue * k.assumedLtv / 100)
          const room = maxN - W[L].debt
          if (room > 0 && Math.round(room * util / 100) === capN) {
            calc = t('m.capCalcAdj', {
              bv: num(bv), value: eur(value), bankValue: eur(bankValue), l: num(k.assumedLtv), max: eur(maxN),
              debt: eur(W[L].debt), room: eur(room), u: num(util), cap: eur(capN),
            })
          }
        }
        m.push(t('m.capEnd', { yN: F[F.length - 1].year, cap: eur(capN), calc }))
      }
      const zero = F.filter(x => x.capacity === 0).map(x => x.year)
      if (zero.length) m.push(t('m.cap0', { when: when(ctx, zero) }))
      const refiYears = uniq(a.events.filter(e => e.kind === 'refinance').map(e => e.year))
      if (refiYears.length) m.push(t('m.refiYears', { when: when(ctx, refiYears) }))
    }
  }

  // Ausgeblendete Jahre der Cashflow-Tabelle
  const hid = hiddenRows(a)
  const hi = hid.reduce((x, r) => x + r.interest, 0)
  const ha = hid.reduce((x, r) => x + r.amortization, 0)
  let rounding: string | [string, Vars] = 'rounding'
  if (hid.length && f.reinvest) rounding = 'roundingReinvest'
  else if (hid.length && (hi > 0 || ha > 0)) {
    const part = hi > 0 && ha > 0 ? t('m.hiddenBoth', { hi: eur(hi), ha: eur(ha) })
      : hi > 0 ? t('m.hiddenInterest', { hi: eur(hi) }) : t('m.hiddenAmort', { ha: eur(ha) })
    rounding = ['roundingHidden', { part }]
  }
  const pit: Array<string | [string, Vars]> = ['amortNotCost', 'interestSum', 'debtNotLoansMinusAmort', 'ltvAverage', 'ltvModelValue', rounding]
  if (chart) pit.push('handoverJump', 'fasterThanAmort')
  if (chart && f.reinvest) pit.push('capNotCash', 'capAssumption', 'capOnlyPaid')
  return guideOf(t, t(chart ? 'heading' : 'headingNoChart'), intro, items, example, m, pit)
}

// ── Einstieg ─────────────────────────────────────────────────────────────────
export function buildOverviewGuides(ctx: GuideCtx): Record<string, Guide | null> {
  if (!ctx.a.wealth.length) return { kpis: null, balance: null, wealth: null, financing: null }
  const f = factsOf(ctx)
  return {
    kpis: buildKpis(ctx, f),
    balance: buildBalance(ctx, f),
    wealth: buildWealth(ctx, f),
    financing: buildFinancing(ctx, f),
  }
}

// ── Nachrechnen ──────────────────────────────────────────────────────────────
// Unabhängig von den Bausteinen oben: Jede Zahl, die ein Text als Ergebnis
// einer Rechnung nennt, wird hier aus den Rohdaten der Seite noch einmal
// gerechnet. Erkannt wird ein Satz an den formatierten Beträgen, die er nennt
// (gleiches Format in beiden Sprachen). Beträge zählen nur als ganze Zahl:
// „0 €" steckt nicht in „220.100 €".
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function hasAmt(s: string | null | undefined, x: string): boolean {
  return !!s && new RegExp(`(?<![\\d.,])${escRe(x)}`).test(s)
}

export function checkGuides(ctx: GuideCtx, res: Record<string, Guide | null>): string[] {
  const { a } = ctx
  const out: string[] = []
  const has = (s: string | null | undefined, ...xs: string[]) => !!s && xs.every(x => hasAmt(s, x))
  const anyHas = (arr: string[], ...xs: string[]) => arr.some(s => has(s, ...xs))
  const ok = (cond: boolean, msg: string) => { if (!cond) out.push(msg) }
  const frag = (key: string) => String(ctx.t(`strategie.guide.${key}`)).trim()
  const ids = ['kpis', 'balance', 'wealth', 'financing']
  for (const id of ids) if (!(id in res)) out.push(`Block ${id} fehlt im Ergebnis`)
  for (const id of Object.keys(res)) if (!ids.includes(id)) out.push(`unerwarteter Block ${id}`)
  if (!a.wealth.length) return out
  const L = a.wealth.length - 1
  const w = a.wealth[L]
  const s = a.summary
  const ek = s.originalEquity
  const own = -(a.moneyFlow.find(x => x.label === 'In Immobilien gebunden')?.amount ?? 0)

  // Sichtbarkeit wie auf der Seite
  ok(!!res.kpis, 'kpis muss immer erscheinen')
  ok(!!res.financing, 'financing muss immer erscheinen')
  ok(!!res.balance === a.balance.length > 0, 'balance: Sichtbarkeit passt nicht zur Tabelle')
  ok(!!res.wealth === a.wealth.length >= 2, 'wealth: Sichtbarkeit passt nicht zum Diagramm')

  // Kacheln: Anzahl Erklärungen = Anzahl Kacheln + Text
  const kp = res.kpis
  if (kp) {
    const tiles = 7 + (s.recyclingMultiple != null ? 1 : 0)
    ok(kp.items.length === tiles + 1, `kpis: ${kp.items.length} Erklärungen für ${tiles} Kacheln + Text`)
    const ex = kp.example ?? ''
    if (s.exitNet != null && a.exitTotal && has(ex, eur(s.exitNet), eur(s.netWorth))) {
      const x = a.exitTotal
      const diff = s.netWorth - s.exitNet
      ok(diff === x.costs + x.vat + x.tax + x.equityBack, `kpis Beispiel: ${diff} != Summe der Verkaufsposten`)
      ok(has(ex, eur(diff), eur(x.costs)), 'kpis Beispiel: Differenz oder Kosten fehlen')
      if (x.vat > 0) ok(has(ex, eur(x.vat)), 'kpis Beispiel: MwSt fehlt')
      if (x.tax > 0) ok(has(ex, eur(x.tax)), 'kpis Beispiel: Steuer fehlt')
      if (x.equityBack > 0) ok(has(ex, eur(x.equityBack)), 'kpis Beispiel: reserviertes Eigenkapital fehlt')
    } else {
      // Ohne Reinvestment bleibt nicht gebrauchtes Startkapital nur dann außerhalb,
      // wenn am Ende kein Geld auf dem Konto liegt
      const unused = !a.reinvest && own < ek && w.cash === 0
      const base = unused ? Math.min(own, ek) : ek
      if (unused) ok(a.cost.ownEquity === base, `kpis Beispiel: eingesetztes Eigenkapital ${a.cost.ownEquity} != ${base}`)
      ok(has(ex, eur(s.netWorth), eur(base), eur(Math.abs(s.netWorth - base))), 'kpis Beispiel: Netto-Vermögen minus Kapital stimmt nicht')
      if (ex.includes(frag('kpis.ex.sameUp')) || ex.includes(frag('kpis.ex.sameDown'))) {
        ok(a.cost.wealthGain === s.netWorth - base, `kpis Beispiel: Vermögenszuwachs ${a.cost.wealthGain} != ${s.netWorth - base}`)
      }
      const cum = a.cashflow[L].cumulative
      if (!a.reinvest && cum !== 0) ok(has(ex, eur(Math.abs(cum))), 'kpis Beispiel: Summe der Überschüsse/Zuzahlungen fehlt')
      if (ex.toLowerCase().includes(frag('kpis.ex.cCosts').toLowerCase())) ok(!a.reinvest && own > base, 'kpis Beispiel: Kaufnebenkosten gehen nicht zusätzlich ab')
    }
    const m = kp.meaning
    if (isFinite(s.irr) && !a.reinvest) ok(m.some(x => x.includes(pct1(s.irr * 100))), 'kpis: Rendite-Satz fehlt')
    if (!a.reinvest) {
      const cum = a.cashflowRows.reduce((x, r) => x + r.net, 0)
      const shown = a.cashflow[L].cumulative
      ok(Math.abs(cum - shown) <= a.cashflowRows.length, `kpis: Summe Cashflow ${cum} weit weg von ${shown}`)
      if (shown !== 0) ok(anyHas(m, eur(Math.abs(shown))), 'kpis: Cashflow-Summe fehlt')
    }
    if (anyHas(m, eur(own), eur(own - ek), eur(ek)) && own > ek) {
      const maxCosts = Math.ceil(a.properties.filter(p => !p.model).reduce((x, p) => x + p.gross, 0) * 0.01) + a.properties.length
      ok(!a.reinvest && own - ek <= maxCosts, `kpis: ${own - ek} sind mehr als Kaufnebenkosten (max ${maxCosts})`)
    }
    if (!a.reinvest && own < ek && w.cash === 0) ok(anyHas(m, eur(own), eur(ek - own)), 'kpis: nicht genutztes Kapital fehlt oder falsch')
    // „Kaufnebenkosten kommen obendrauf" nur, wenn sie nicht aus dem Startkapital bezahlt werden
    const kEq = kp.items[4]?.text ?? ''
    if (!a.reinvest && own <= ek) ok(kEq === String(ctx.t('strategie.guide.kpis.items.kEquityUnused.text')), 'kpis: Kachel-Erklärung Eingesetztes Kapital passt nicht')
    if (a.reinvest && a.cost.ownEquity < ek) {
      const rest = ek - a.cost.ownEquity
      ok(anyHas(m, eur(a.cost.ownEquity), eur(rest)), 'kpis: Reinvest-Kapital-Satz falsch')
      if (anyHas(m, eur(rest), eur(a.minimumReserve)) && a.minimumReserve > 0) ok(rest >= a.minimumReserve, 'kpis: Rest kleiner als Reserve')
    }
    const monthly = a.reinvest && !ctx.params.selfFundingOnly ? Math.max(0, ctx.params.additionalEquityMonthly || 0) : 0
    if (monthly > 0) ok(anyHas(m, eur(monthly * 12 * a.wealth.length)), 'kpis: Summe der Zuzahlungen falsch')
    if (s.recyclingMultiple != null && s.recyclingMultiple > 0) {
      ok(anyHas(m, mult1(s.recyclingMultiple), `${Math.round(s.recyclingMultiple * 100)} %`), 'kpis: Recycling-Prozent falsch')
    }
    if (s.exitNet != null && a.exitTotal && a.exitTotal.debt === s.debt && s.debt > 0) ok(anyHas(m, eur(s.debt), eur(s.exitNet)), 'kpis: Verkaufs-Satz fehlt')
  }

  // Endbilanz
  const bl = res.balance
  if (bl) {
    const row = (l: string) => a.balance.find(b => b.label === l)?.amount ?? 0
    const value = row('Wert der Immobilien'), debt = -row('Offene Kredite'), equity = row('Eigenkapital in den Immobilien')
    const committed = row('In der Bauphase gebundenes Kapital'), cash = row('Liquidität'), nw = row('Netto-Vermögen')
    ok(bl.items.length === a.balance.length, `balance: ${bl.items.length} Erklärungen für ${a.balance.length} Zeilen`)
    ok(equity === value - debt, `balance: ${value} - ${debt} != ${equity}`)
    ok(nw === equity + committed + cash, `balance: Summe der Zeilen != ${nw}`)
    ok(nw === s.netWorth && value === s.portfolioValue && debt === s.debt, 'balance: Tabelle weicht von den Kacheln ab')
    if (bl.example) {
      ok(has(bl.example, eur(nw), eur(Math.abs(cash))), 'balance Beispiel: Ergebnis fehlt')
      if (value || debt) ok(has(bl.example, eur(value), eur(debt), (equity < 0 ? '−' : '') + eur(Math.abs(equity))), 'balance Beispiel: erste Rechnung fehlt')
      if (committed) ok(has(bl.example, eur(committed)), 'balance Beispiel: gebundenes Kapital fehlt')
    } else out.push('balance: Beispiel fehlt')
    if (nw > 0 && equity > 0) {
      const p = Math.round(equity / nw * 100)
      if (p <= 100) ok(has(bl.meaning[0], `${p} %`), `balance: Anteil ${p} % fehlt`)
    }
    if (equity < 0) ok(!bl.meaning.some(x => x.includes(frag('balance.m.notCash'))), 'balance: negatives Eigenkapital als „gehört dir" beschrieben')
    if (a.reinvest && a.minimumReserve > 0) {
      ok(anyHas(bl.meaning, eur(cash), eur(a.minimumReserve)), 'balance: Reserve-Satz fehlt')
    }
  }

  // Vermögensdiagramm
  const wg = res.wealth
  if (wg) {
    const W = a.wealth
    ok(W.every(x => x.propertyEquity === x.propertyValue - x.debt && x.netWorth === x.propertyEquity + x.committed + x.cash), 'wealth: Linien gehen nicht auf')
    let i0 = -1
    for (let i = 0; i < L; i++) if (W[i].committed === 0 && W[i].propertyValue > 0) { i0 = i; break }
    if (i0 >= 0 && wg.example) {
      const dv = W[L].propertyValue - W[i0].propertyValue, dd = W[i0].debt - W[L].debt
      const de = W[L].propertyEquity - W[i0].propertyEquity
      ok(de === dv + dd, `wealth Beispiel: ${dv} + ${dd} != ${de}`)
      ok(has(wg.example, String(W[i0].year), eur(W[i0].propertyValue), eur(W[i0].debt), eur(W[i0].propertyEquity), eur(W[L].propertyEquity), eur(Math.abs(de))), 'wealth Beispiel: Zahlen fehlen')
      if (dv) ok(has(wg.example, eur(Math.abs(dv))), 'wealth Beispiel: Wertänderung fehlt')
      if (dd) ok(has(wg.example, eur(Math.abs(dd))), 'wealth Beispiel: Kreditänderung fehlt')
      ok(W.slice(0, i0).every(x => !(x.committed === 0 && x.propertyValue > 0)), 'wealth Beispiel: nicht das erste Jahr')
      if (wg.example.includes(frag('wealth.ex.debtNoteDown')) || wg.example.includes(frag('wealth.ex.debtNoteUp'))) {
        ok(a.events.some(e => (e.kind === 'refinance' || e.kind === 'purchase') && e.year > W[i0].year), 'wealth Beispiel: Hinweis auf weitere Kredite ohne Kauf')
      }
    }
    if (i0 >= 0 && !wg.example) out.push('wealth: Beispiel fehlt')
    const opFrag = (y: number) => String(ctx.t('strategie.guide.wealth.m.dropOpLoss', { y })).trim()
    for (let i = 1; i < W.length; i++) {
      const drop = W[i - 1].netWorth - W[i].netWorth
      if (drop > 0 && anyHas(wg.meaning, String(W[i].year), eur(drop))) ok(a.properties.some(p => p.readyYear === W[i].year), `wealth: Rückgang ${W[i].year} ohne Übergabe erklärt`)
      if (wg.meaning.some(x => x.includes(opFrag(W[i].year)))) {
        const r = a.cashflowRows[i]
        ok(a.reinvest && !!r && r.rent - r.costs - r.interest - r.tax + r.vatRefund < 0, `wealth: laufendes Minus ${W[i].year} stimmt nicht`)
      }
    }
    for (let i = 0; i < L; i++) {
      const x = W[i]
      if (x.cash > 0 && x.committed === 0 && anyHas(wg.meaning, String(x.year), eur(x.cash))) {
        ok(x.netWorth - x.propertyEquity === x.cash, `wealth: Abstand grau/grün ${x.year} != Liquidität`)
      }
    }
    // „unter deinem Startkapital": nur wenn es stimmt
    if (anyHas(wg.meaning, `(${W[0].year})`, eur(W[0].netWorth), eur(ek))) ok(W[0].netWorth < ek, 'wealth: erstes Jahr liegt nicht unter dem Startkapital')
  }

  // Finanzierung
  const fg = res.financing
  if (fg) {
    const k = a.financingKpis
    ok(k.debtEnd === w.debt && k.debtEnd === s.debt, 'financing: Kredit am Ende weicht ab')
    const loans = a.properties.reduce((x, p) => x + p.loan, 0)
    const ex = fg.example ?? ''
    if (has(ex, eur(loans), eur(k.debtEnd)) && (k.totalAmortization === 0 || has(ex, eur(k.totalAmortization)))) {
      ok(loans + k.totalRefinanced - k.totalAmortization === k.debtEnd, `financing Beispiel: ${loans} + ${k.totalRefinanced} - ${k.totalAmortization} != ${k.debtEnd}`)
    }
    if (has(ex, eur(s.portfolioValue), ltvStr(k.ltvEnd))) {
      ok(s.portfolioValue > 0 && Math.round(k.debtEnd / s.portfolioValue * 1000) / 10 === k.ltvEnd, 'financing Beispiel: Beleihungsgrad passt nicht')
    }
    for (let i = 1; i < a.wealth.length; i++) {
      const am = a.cashflowRows[i]?.amortization ?? 0
      if (am > 0 && has(ex, `${a.wealth[i - 1].year}`, eur(a.wealth[i - 1].debt), eur(am), eur(a.wealth[i].debt))) {
        ok(a.wealth[i - 1].debt - am === a.wealth[i].debt, `financing Beispiel: Kredit ${a.wealth[i].year} geht nicht auf`)
        if (!a.reinvest) {
          const vis = new Set<number>([s.firstYear, s.firstYear + 4, s.firstYear + 9, s.lastYear, ...a.portfolio.filter(p => p.purchases || p.sales).map(p => p.year)])
          const shownYears = a.cashflowRows.filter(r => vis.has(r.year) || r.rent > 0).slice(0, 12).map(r => r.year)
          ok(shownYears.includes(a.wealth[i].year), `financing Beispiel: ${a.wealth[i].year} ist in der Tabelle ausgeblendet`)
        }
      }
    }
    // Beleihungsgrad: „gehören dir" nur ohne Kredit für Wohnungen im Bau
    const ly = s.lastYear
    const delivered = a.properties.filter(p => p.readyYear <= ly && (p.soldYear == null || ly < p.soldYear)).reduce((x, p) => x + p.debtEnd, 0)
    const unbuilt = !a.reinvest && w.committed > 0 && k.debtEnd - delivered > 1
    if (k.ltvEnd > 0) ok(anyHas(fg.meaning, ltvStr(k.ltvEnd), `${Math.round(k.ltvEnd)} €`), 'financing: Beleihungs-Satz fehlt')
    if (k.ltvEnd > 0 && k.ltvEnd <= 100 && !unbuilt) ok(anyHas(fg.meaning, ltvStr(k.ltvEnd), `${100 - Math.round(k.ltvEnd)} €`), 'financing: Anteil „gehört dir" fehlt')
    // bei rund 50 % sind „Kredit-Anteil" und „gehört dir" dieselbe Zahl, der Test waere blind
    if (unbuilt && k.ltvEnd <= 100 && 100 - Math.round(k.ltvEnd) !== Math.round(k.ltvEnd)) ok(!anyHas(fg.meaning, ltvStr(k.ltvEnd), `${100 - Math.round(k.ltvEnd)} €`), 'financing: „gehört dir" trotz Kredit für Wohnungen im Bau')
    if (unbuilt && k.ltvEnd > 0) ok(fg.meaning.some(x => x.includes(frag('financing.m.ltvCommitted1')) || x.includes(frag('financing.m.ltvCommittedN'))), 'financing: Hinweis auf Kredit für Wohnungen im Bau fehlt')
    const gap = k.debtEnd - (loans + k.totalRefinanced - k.totalAmortization)
    if (gap !== 0) ok(anyHas(fg.meaning, eur(Math.abs(gap))), `financing: Abweichung ${gap} nicht erklärt`)
    // ausgeblendete Jahre: genannte Summen nachrechnen
    const vis = new Set<number>([s.firstYear, s.firstYear + 4, s.firstYear + 9, s.lastYear, ...a.portfolio.filter(p => p.purchases || p.sales).map(p => p.year)])
    const shown = new Set(a.cashflowRows.filter(r => vis.has(r.year) || r.rent > 0).slice(0, 12).map(r => r.year))
    const hid = a.cashflowRows.filter(r => !shown.has(r.year))
    const hi = hid.reduce((x, r) => x + r.interest, 0), ha = hid.reduce((x, r) => x + r.amortization, 0)
    if (!a.reinvest && (hi > 0 || ha > 0)) {
      ok(fg.pitfalls.some(p => (hi === 0 || hasAmt(p, eur(hi))) && (ha === 0 || hasAmt(p, eur(ha)))), `financing: ausgeblendete Zinsen ${hi} / Tilgung ${ha} nicht genannt`)
    }
    if (a.reinvest && hid.length) ok(fg.pitfalls.some(p => p === frag('financing.pitfalls.roundingReinvest')), 'financing: Hinweis auf „Alle Jahre anzeigen" fehlt')
    if (a.financing.length >= 2) {
      const W = a.wealth
      for (let i = 1; i < W.length; i++) {
        const d = W[i].debt - W[i - 1].debt
        if (d > 0) ok(anyHas(fg.meaning, `${W[i].year}`, eur(d)), `financing: Anstieg ${W[i].year} um ${d} fehlt`)
      }
      let extraSum = 0
      if (!a.reinvest) {
        for (let i = 1; i < W.length; i++) {
          if (!((a.cashflowRows[i]?.toPayments ?? 0) > 0)) continue
          const e = W[i - 1].debt - a.cashflowRows[i].amortization - W[i].debt
          if (e > 1) extraSum += e
        }
      }
      if (extraSum > 0) {
        ok(anyHas(fg.meaning, eur(extraSum)), 'financing: Bauträger-Raten-Satz fehlt')
        const fs = a.properties.reduce((x, p) => x + (p.fromSurplus ?? 0), 0)
        if (fg.meaning.some(x => x.split(eur(extraSum)).length > 2)) ok(fs === extraSum, `financing: ${extraSum} != aus Miete ${fs}`)
      }
      const maxD = Math.max(...W.map(x => x.debt))
      if (maxD > 0) ok(anyHas(fg.meaning, eur(maxD)), 'financing: Höchststand fehlt')
      if (a.reinvest) {
        const F = a.financing
        const capN = F[F.length - 1].capacity
        const bv = ctx.params.bankValuationFactor ?? 100, u = ctx.params.refinanceUtilizationPct ?? 100
        const maxN = Math.round(Math.round(W[L].propertyValue * bv / 100) * k.assumedLtv / 100)
        // maxN === capN: beide Betraege stehen schon im Satz zur Kapazitaet, ohne Rechnung
        if (capN > 0 && maxN !== capN && anyHas(fg.meaning, eur(maxN), eur(capN))) ok(Math.round((maxN - W[L].debt) * u / 100) === capN, 'financing: Kapazitätsrechnung geht nicht auf')
      }
    }
  }
  return out
}
