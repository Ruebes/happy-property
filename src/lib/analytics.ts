// ── Kundenauswertung: Datenaufbereitung ──────────────────────────────────────
// Die Kundenseite rechnet NICHTS selbst. Alles, was sie zeigt, entsteht hier aus
// den Ergebnissen der Strategie- und Reinvestment-Schicht. Wenn eine Zahl auf
// der Seite auftaucht, kommt sie aus dieser Datei - so koennen CRM und
// Kundenseite nicht auseinanderlaufen.
import {
  allocate, aggregate, totalsOf, computeExit, runScenarios, roeMeaningful, assessRisk,
  breakEvenGrowth, SCENARIO_KEYS,
  type SimUnit, type SimParams, type ScenarioKey, type RiskItem, type ExitResult,
  type ScenarioResult,
} from './strategy'
import { runReinvest, type ReinvestResult, type StrategyEvent } from './reinvest'

export interface WealthPoint {
  year: number
  propertyValue: number
  debt: number
  propertyEquity: number   // Immobilienwert abzueglich Schuld
  netWorth: number         // dazu Liquiditaet und gebundenes Kapital
  cash: number
}
export interface PortfolioPoint {
  year: number
  units: number        // im Bestand, also uebergeben und noch nicht verkauft
  owned: number        // bereits gekauft, auch wenn die Uebergabe noch aussteht
  purchases: number; sales: number
}
export interface CashflowPoint { year: number; cashflow: number; cumulative: number }
export interface CashflowRow {
  year: number; rent: number; costs: number; interest: number
  amortization: number; tax: number
  // Die Erstattung der Kaufpreis-Mehrwertsteuer bei Kurzzeitvermietung. Ohne
  // diese Spalte ging die Tabelle nicht auf: der Cashflow sprang um einen
  // fuenfstelligen Betrag, den keine der gezeigten Positionen erklaerte.
  vatRefund: number
  net: number
}
export interface LiquidityPoint { year: number; cash: number }
export interface FinancingPoint { year: number; debt: number; ltv: number; capacity: number }
export interface TaxPoint { year: number; total: number; cy: number; de: number; gesy: number; si: number }

export interface CapitalStep {
  label: string
  amount: number
  kind: 'start' | 'in' | 'out' | 'end'
  year?: number
}
export interface RecyclingRow {
  year: number; event: string; source: string; amount: number; reinvested: number
}

export interface PropertyCard {
  key: string; name: string
  buyYear: number; readyYear: number
  price: number; gross: number; equity: number; loan: number
  valueEnd: number; debtEnd: number; equityEnd: number
  rentFirstYear: number
  equityGrowthPct: number | null
  equityGrowthYears: number
  soldYear: number | null
  netSaleProceeds: number | null
  model: boolean
}

export interface ScenarioSummary {
  key: ScenarioKey
  units: number
  portfolioValue: number
  debt: number
  netWorth: number
  irr: number
  recyclingMultiple: number
  cumulativeCashflow: number
  exitNet: number | null
}

export interface SensitivityRow {
  appreciation: number
  units: number
  portfolioValue: number
  netWorth: number
}

export interface Insight { title: string; text: string }

export interface CustomerSummary {
  firstYear: number; lastYear: number
  originalEquity: number
  unitsEnd: number
  portfolioValue: number
  debt: number
  netWorth: number
  cash: number
  irr: number
  recyclingMultiple: number | null
  exitNet: number | null
  additionalEquityNeeded: number
  text: string
}

export interface CustomerAnalytics {
  reinvest: boolean
  summary: CustomerSummary
  wealth: WealthPoint[]
  portfolio: PortfolioPoint[]
  cashflow: CashflowPoint[]
  cashflowRows: CashflowRow[]
  liquidity: LiquidityPoint[]
  minimumReserve: number
  liquidityWarning: { from: number; to: number; lowest: number } | null
  financing: FinancingPoint[]
  financingKpis: {
    debtEnd: number; ltvEnd: number; assumedLtv: number
    capacityNow: number; totalRefinanced: number; totalInterest: number; totalAmortization: number
  }
  capitalSteps: CapitalStep[]
  recyclingRows: RecyclingRow[]
  opportunity: {
    year: number; capacity: number; maxPrice: number; modelPrice: number
    requiredEquity: number; cashAfter: number
  } | null
  properties: PropertyCard[]
  tax: TaxPoint[]
  taxKpis: {
    total: number; perYear: number; exit: number
    incomeTax: number    // reine Einkommensteuer, ohne GESY und Sozialversicherung
    gesy: number; si: number; de: number
  }
  scenarios: ScenarioSummary[]
  exits: Array<{ name: string; year: number; value: number; debt: number; costs: number; tax: number; net: number }>
  risks: RiskItem[]
  insights: Insight[]
  drivers: string[]
  sensitivity: SensitivityRow[]
  events: StrategyEvent[]
}

const r0 = (n: number) => Math.round(n)
const eur = (n: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' €'

// ── Hauptfunktion ────────────────────────────────────────────────────────────
export function buildCustomerAnalytics(units: SimUnit[], params: SimParams): CustomerAnalytics | null {
  if (!units.length) return null
  const reinvestOn = !!params.reinvestEnabled

  // Basisrechnung: mit Reinvestment ueber den Motor, sonst die normale Strategie.
  const ri: ReinvestResult | null = reinvestOn ? runReinvest(units, params) : null
  const outcomes = ri ? ri.outcomes : allocate(units, params)
  const agg = ri
    ? { rows: ri.rows, firstYear: ri.firstYear, lastYear: ri.lastYear }
    : (() => { const a = aggregate(outcomes, params); return { rows: a.rows, firstYear: a.firstYear, lastYear: a.lastYear } })()
  const exit: ExitResult | null = ri ? null : computeExit(outcomes, params, agg.firstYear)
  const totals = totalsOf(outcomes, agg.rows, params, exit)

  // ── Vermoegen ──────────────────────────────────────────────────────────────
  const cashByYear = new Map<number, number>()
  if (ri) for (const f of ri.flows) cashByYear.set(f.year, f.endingCash)
  const wealth: WealthPoint[] = agg.rows.map(row => {
    const cash = cashByYear.get(row.year) ?? 0
    return {
      year: row.year,
      propertyValue: r0(row.value),
      debt: r0(row.debt),
      propertyEquity: r0(row.value - row.debt),
      netWorth: r0(row.value + row.committed - row.debt + cash),
      cash: r0(cash),
    }
  })

  // ── Portfolio ──────────────────────────────────────────────────────────────
  const events: StrategyEvent[] = ri ? ri.events : []
  const portfolio: PortfolioPoint[] = agg.rows.map(row => {
    const active = outcomes.filter(o => {
      const sold = ri?.saleYears.get(o.unit.key) ?? o.unit.saleYear ?? null
      return o.unit.readyY <= row.year && (sold == null || row.year < sold)
    }).length
    // Gekauft ist eine Wohnung ab dem Kaufvertrag, im Bestand erst ab der
    // Uebergabe. Ohne diese Trennung behauptete die Seite im ersten Jahr
    // "0 Wohnungen", obwohl der Kunde da gerade gekauft hatte.
    const owned = outcomes.filter(o => {
      const sold = ri?.saleYears.get(o.unit.key) ?? o.unit.saleYear ?? null
      return o.unit.buyY <= row.year && (sold == null || row.year < sold)
    }).length
    return {
      year: row.year,
      units: active,
      owned,
      purchases: events.filter(e => e.kind === 'purchase' && e.year === row.year).length,
      sales: events.filter(e => e.kind === 'sale' && e.year === row.year).length,
    }
  })

  // ── Cashflow ───────────────────────────────────────────────────────────────
  let cum = 0
  const cashflow: CashflowPoint[] = agg.rows.map(row => {
    cum += row.cashflow
    return { year: row.year, cashflow: r0(row.cashflow), cumulative: r0(cum) }
  })
  const cashflowRows: CashflowRow[] = agg.rows.map(row => ({
    year: row.year,
    rent: r0(row.rents),
    costs: r0(row.mgmt + row.opex),
    interest: r0(row.interest),
    amortization: r0(row.principal),
    tax: r0(row.taxes),
    vatRefund: r0(row.vat),
    net: r0(row.cashflow),
  }))

  // ── Liquiditaet ────────────────────────────────────────────────────────────
  const liquidity: LiquidityPoint[] = ri ? ri.flows.map(f => ({ year: f.year, cash: f.endingCash })) : []
  const reserve = params.minimumCashReserve
  let liquidityWarning: CustomerAnalytics['liquidityWarning'] = null
  if (ri) {
    const below = liquidity.filter(l => l.cash < reserve)
    if (below.length) {
      liquidityWarning = {
        from: below[0].year,
        to: below[below.length - 1].year,
        lowest: Math.min(...below.map(l => l.cash)),
      }
    }
  }

  // ── Finanzierung ───────────────────────────────────────────────────────────
  const capacityByYear = new Map<number, number>()
  if (ri) for (const y of ri.years) capacityByYear.set(y.year, y.refinancingCapacity)
  const financing: FinancingPoint[] = agg.rows.map(row => ({
    year: row.year,
    debt: r0(row.debt),
    ltv: row.value > 0 ? Math.round(row.debt / row.value * 1000) / 10 : 0,
    capacity: capacityByYear.get(row.year) ?? 0,
  }))
  const lastRow = agg.rows[agg.rows.length - 1]
  const financingKpis = {
    debtEnd: r0(lastRow?.debt ?? 0),
    ltvEnd: lastRow && lastRow.value > 0 ? Math.round(lastRow.debt / lastRow.value * 1000) / 10 : 0,
    assumedLtv: params.refinanceLtv,
    capacityNow: financing.length ? financing[0].capacity : 0,
    totalRefinanced: ri ? ri.kpis.totalRefinancingProceeds : 0,
    totalInterest: r0(totals.interest),
    totalAmortization: r0(totals.principal),
  }

  // ── Kapital-Recycling ──────────────────────────────────────────────────────
  const capitalSteps: CapitalStep[] = []
  const recyclingRows: RecyclingRow[] = []
  if (ri) {
    capitalSteps.push({ label: 'Startkapital', amount: params.ek, kind: 'start' })
    const firstEquity = outcomes.filter(o => !o.unit.model).reduce((a, o) => a + o.ekUsed, 0)
    capitalSteps.push({ label: 'Erste Käufe', amount: -r0(firstEquity), kind: 'out', year: ri.firstYear })
    for (const e of ri.events) {
      if (e.kind === 'refinance') {
        capitalSteps.push({ label: `Refinanzierung ${e.year}`, amount: e.newLoanAmount, kind: 'in', year: e.year })
        recyclingRows.push({
          year: e.year, event: 'Refinanzierung', source: e.propertyNames.join(', '),
          amount: e.newLoanAmount, reinvested: e.newLoanAmount,
        })
      } else if (e.kind === 'sale') {
        capitalSteps.push({ label: `Verkauf ${e.year}`, amount: e.netProceeds, kind: 'in', year: e.year })
        recyclingRows.push({
          year: e.year, event: 'Verkauf', source: e.name,
          amount: e.netProceeds, reinvested: 0,
        })
      } else {
        capitalSteps.push({ label: `Kauf ${e.year}`, amount: -e.equity, kind: 'out', year: e.year })
        recyclingRows.push({
          year: e.year, event: 'Kauf', source: e.name,
          amount: -e.equity, reinvested: e.fundedFromRefinance + e.fundedFromSale,
        })
      }
    }
    capitalSteps.push({ label: 'Portfolio am Ende', amount: r0(lastRow?.value ?? 0), kind: 'end' })
  }

  // Naechste rechnerisch moegliche Investition.
  const nextOpp = ri?.opportunities.find(o => o.affordable && !ri.events.some(e => e.kind === 'purchase' && e.year === o.year))
    ?? ri?.opportunities.find(o => o.affordable)
    ?? null
  const opportunity = nextOpp ? {
    year: nextOpp.year,
    capacity: nextOpp.refinancingCapacity,
    maxPrice: nextOpp.maximumPurchasePrice,
    modelPrice: nextOpp.modelPurchasePrice,
    requiredEquity: nextOpp.requiredEquity,
    cashAfter: Math.max(0, nextOpp.availableCash - nextOpp.requiredEquity),
  } : null

  // ── Immobilien ─────────────────────────────────────────────────────────────
  const properties: PropertyCard[] = outcomes.map(o => {
    const sold = ri?.saleYears.get(o.unit.key) ?? o.unit.saleYear ?? null
    const idxEnd = Math.min(
      Math.max(0, (sold ?? agg.lastYear) - o.unit.readyY),
      o.res.propV.length - 1,
    )
    const sale = ri?.sales.find(s => s.key === o.unit.key) ?? null
    return {
      key: o.unit.key, name: o.unit.name,
      buyYear: o.unit.buyY, readyYear: o.unit.readyY,
      price: o.unit.priceNet, gross: r0(o.gross), equity: r0(o.ekUsed), loan: r0(o.loan),
      valueEnd: r0(o.res.propV[idxEnd]), debtEnd: r0(o.res.restL[idxEnd]),
      equityEnd: r0(o.res.propV[idxEnd] - o.res.restL[idxEnd]),
      rentFirstYear: r0(o.res.rents[0]),
      // Kumulierter Zuwachs ueber die gerechneten Jahre, KEINE Jahresrendite.
      // Die Karte beschriftet ihn entsprechend.
      equityGrowthPct: roeMeaningful(o) ? Math.round(o.res.roe10 * 10) / 10 : null,
      equityGrowthYears: o.res.rents.length,
      soldYear: sold,
      netSaleProceeds: sale ? r0(sale.netProceeds) : null,
      model: !!o.unit.model,
    }
  })

  // ── Steuern ────────────────────────────────────────────────────────────────
  const tax: TaxPoint[] = agg.rows.map(row => ({
    year: row.year,
    total: r0(row.taxes),
    cy: r0(row.taxCY - row.gesy - row.si),
    de: r0(row.taxDE),
    gesy: r0(row.gesy),
    si: r0(row.si),
  }))
  const exitTax = ri
    ? ri.sales.reduce((a, s) => a + s.cgt + s.taxDE, 0)
    : (exit ? exit.cgt + exit.taxDE : 0)
  const taxKpis = {
    total: r0(totals.taxes),
    // Die Einkommensteuer allein - GESY und Sozialversicherung stecken in
    // taxCY mit drin und wuerden die Zahl sonst verfaelschen.
    incomeTax: r0(totals.taxCY - totals.gesy - totals.si),
    perYear: agg.rows.length ? r0(totals.taxes / agg.rows.length) : 0,
    exit: r0(exitTax),
    gesy: r0(totals.gesy),
    si: r0(totals.si),
    de: r0(totals.taxDE),
  }

  // ── Szenarien ──────────────────────────────────────────────────────────────
  // Im Reinvestment-Modus muss jedes Szenario durch den Motor, sonst waeren
  // Portfolio-Groesse und Recycling identisch - und das waere falsch.
  const sc = runScenarios(units, params)
  // Jedes Szenario laeuft EINMAL durch den Reinvestment-Motor; das Ergebnis
  // wird fuer Vergleichstabelle und Risiko gemeinsam genutzt.
  const reinvestByScenario: Partial<Record<ScenarioKey, ReinvestResult>> = {}
  if (reinvestOn) {
    for (const key of SCENARIO_KEYS) {
      // Mit den Wohnungen DES SZENARIOS rechnen, nicht mit den Ausgangsdaten -
      // sonst fehlt die geaenderte Mietannahme des Szenarios.
      reinvestByScenario[key] = runReinvest(sc[key].units, sc[key].params)
    }
  }
  const scenarios: ScenarioSummary[] = SCENARIO_KEYS.map(key => {
    if (reinvestOn) {
      const r = reinvestByScenario[key]!
      const last = r.rows[r.rows.length - 1]
      return {
        key,
        units: r.kpis.activeUnitsEnd,
        portfolioValue: r0(last?.value ?? 0),
        debt: r0(last?.debt ?? 0),
        netWorth: r0((last?.value ?? 0) - (last?.debt ?? 0) + r.kpis.cashEnd),
        irr: r.totals.irr,
        recyclingMultiple: r.kpis.capitalRecyclingMultiple,
        cumulativeCashflow: r0(r.totals.cashflow),
        exitNet: null,
      }
    }
    const s = sc[key]
    return {
      key,
      units: s.outcomes.length,
      portfolioValue: r0(s.totals.valueEnd),
      debt: r0(s.totals.debtEnd),
      netWorth: r0(s.totals.netWorth),
      irr: s.totals.irr,
      recyclingMultiple: 0,
      cumulativeCashflow: r0(s.totals.cashflow),
      exitNet: s.exit ? r0(s.exit.net) : null,
    }
  })

  // ── Verkaeufe ──────────────────────────────────────────────────────────────
  const exits = ri
    ? ri.sales.map(s => ({
      name: s.name, year: s.year, value: r0(s.line.value), debt: r0(s.line.debt),
      costs: r0(s.line.sellCost + s.levy + s.line.vatClawback), tax: r0(s.cgt + s.taxDE),
      net: r0(s.netProceeds),
    }))
    : (exit ? exit.lines.map(l => ({
      name: l.name, year: exit.year, value: r0(l.value), debt: r0(l.debt),
      costs: r0(l.sellCost + l.vatClawback), tax: 0, net: 0,
    })) : [])

  // ── Risiko: bestehende Logik, aber auf DENSELBEN Zahlen ───────────────────
  // Im Reinvestment-Modus muss die Risikobewertung die Reinvestment-Ergebnisse
  // lesen, sonst standen auf derselben Seite zwei verschiedene Beleihungsgrade
  // und zwei verschiedene Szenariovergleiche (Befund 5.9.26).
  const be = breakEvenGrowth(units, params)
  const riskInput = reinvestOn
    ? Object.fromEntries(SCENARIO_KEYS.map(key => {
      const r = reinvestByScenario[key]!
      return [key, { ...sc[key], rows: r.rows, totals: r.totals, exit: null, outcomes: r.outcomes }]
    })) as Record<ScenarioKey, ScenarioResult>
    : sc
  const risks = assessRisk(riskInput, be)

  // ── Sensitivitaet ──────────────────────────────────────────────────────────
  // Nur im Reinvestment-Modus interessant, weil dort die Wertentwicklung ueber
  // die Anzahl der Immobilien entscheidet.
  const sensitivity: SensitivityRow[] = reinvestOn
    ? [0, 3, 5, 7, 9].map(app => {
      const r = runReinvest(units, { ...params, reinvestAppreciationPct: app })
      const last = r.rows[r.rows.length - 1]
      return {
        appreciation: app,
        units: r.kpis.activeUnitsEnd,
        portfolioValue: r0(last?.value ?? 0),
        netWorth: r0((last?.value ?? 0) - (last?.debt ?? 0) + r.kpis.cashEnd),
      }
    })
    : []

  // ── Zusammenfassung ────────────────────────────────────────────────────────
  const unitsEnd = portfolio.length ? portfolio[portfolio.length - 1].units : 0
  const cashEnd = ri ? ri.kpis.cashEnd : 0
  const netWorthEnd = wealth.length ? wealth[wealth.length - 1].netWorth : 0
  const summary: CustomerSummary = {
    firstYear: agg.firstYear, lastYear: agg.lastYear,
    originalEquity: params.ek,
    unitsEnd,
    portfolioValue: r0(lastRow?.value ?? 0),
    debt: r0(lastRow?.debt ?? 0),
    netWorth: netWorthEnd,
    cash: r0(cashEnd),
    irr: totals.irr,
    recyclingMultiple: ri ? ri.kpis.capitalRecyclingMultiple : null,
    exitNet: exit ? r0(exit.net) : null,
    additionalEquityNeeded: liquidityWarning ? r0(Math.abs(Math.min(0, liquidityWarning.lowest))) : 0,
    text: buildSummaryText(params, agg, unitsEnd, lastRow?.value ?? 0, ri),
  }

  const insights = buildInsights({ params, wealth, portfolio, cashflow, ri, sensitivity, risks, liquidityWarning })
  const drivers = buildDrivers({ params, ri, sensitivity, cashflow, financing })

  return {
    reinvest: reinvestOn, summary, wealth, portfolio, cashflow, cashflowRows,
    liquidity, minimumReserve: reserve, liquidityWarning,
    financing, financingKpis, capitalSteps, recyclingRows, opportunity,
    properties, tax, taxKpis, scenarios, exits, risks, insights, drivers, sensitivity,
    events,
  }
}

// ── Erzeugte Texte ───────────────────────────────────────────────────────────
// Alle Saetze entstehen aus den gerechneten Zahlen. Keine Textbausteine, die
// unabhaengig vom Ergebnis immer dasselbe behaupten.
function buildSummaryText(
  p: SimParams,
  agg: { firstYear: number; lastYear: number },
  unitsEnd: number,
  value: number,
  ri: ReinvestResult | null,
): string {
  const kern = `Mit einem Startkapital von ${eur(p.ek)} entsteht in dieser Modellrechnung bis ${agg.lastYear} ein Portfolio von ${unitsEnd} ${unitsEnd === 1 ? 'Wohnung' : 'Wohnungen'} mit einem Wert von ${eur(value)}.`
  if (!ri || ri.kpis.additionalPurchases === 0) {
    return `${kern} Ein weiterer Kauf aus Wertzuwachs und Tilgung ergibt sich unter diesen Annahmen im Betrachtungszeitraum nicht.`
  }
  return `${kern} ${ri.kpis.additionalPurchases === 1 ? 'Eine weitere Wohnung wird' : `${ri.kpis.additionalPurchases} weitere Wohnungen werden`} aus Wertzuwachs und Tilgung finanziert: Über ${ri.kpis.refinancings} ${ri.kpis.refinancings === 1 ? 'Refinanzierung' : 'Refinanzierungen'} werden ${eur(ri.kpis.totalRefinancingProceeds)} des gebundenen Kapitals wieder verfügbar und erneut investiert.`
}

function buildInsights(x: {
  params: SimParams
  wealth: WealthPoint[]
  portfolio: PortfolioPoint[]
  cashflow: CashflowPoint[]
  ri: ReinvestResult | null
  sensitivity: SensitivityRow[]
  risks: RiskItem[]
  liquidityWarning: CustomerAnalytics['liquidityWarning']
}): Insight[] {
  const out: Insight[] = []
  // Im ersten Jahr ist oft noch nichts uebergeben - gezaehlt wird deshalb, was
  // der Kunde zu diesem Zeitpunkt bereits gekauft hat.
  const first = x.portfolio[0]?.owned ?? 0
  const last = x.portfolio[x.portfolio.length - 1]?.units ?? 0
  const w0 = x.wealth[0], wN = x.wealth[x.wealth.length - 1]

  if (last > first) {
    out.push({
      title: 'Das Portfolio wächst',
      text: `Aus ${first === 1 ? 'deiner ersten Wohnung' : `deinen ${first} Wohnungen`} werden ${last}. Möglich wird das, weil Wertzuwachs und Tilgung Spielraum für weitere Finanzierungen schaffen.`,
    })
  } else if (wN && w0) {
    const plus = wN.propertyEquity - w0.propertyEquity
    out.push({
      title: 'Eigenkapital baut sich auf',
      text: `Der Anteil, der dir wirtschaftlich gehört, wächst um ${eur(plus)} - durch Tilgung und Wertentwicklung, ohne dass weiteres Kapital nötig wäre.`,
    })
  }

  if (x.ri && x.ri.kpis.totalRefinancingProceeds > 0) {
    out.push({
      title: 'Kapital arbeitet mehrfach',
      text: `${eur(x.ri.kpis.totalRecycledCapital)} fließen erneut als Eigenkapital in weitere Wohnungen, davon ${eur(x.ri.kpis.totalRefinancingProceeds)} aus Refinanzierungen. Bezogen auf dein Startkapital ist das der ${x.ri.kpis.capitalRecyclingMultiple.toFixed(1).replace('.', ',')}-fache Wiedereinsatz - kein Gewinn, sondern dasselbe Kapital, das mehrfach arbeitet.`,
    })
  } else {
    const neg = x.cashflow.filter(c => c.cashflow < 0).length
    if (neg > 0) {
      out.push({
        title: 'Die Anfangsjahre kosten Geld',
        text: `In ${neg} von ${x.cashflow.length} Jahren übersteigen Rate, Kosten und Steuern die Mieteinnahmen. Danach trägt sich das Portfolio selbst.`,
      })
    }
  }

  if (x.sensitivity.length >= 2) {
    const low = x.sensitivity[0], mid = x.sensitivity.find(s => s.appreciation === 5) ?? x.sensitivity[2]
    out.push({
      title: 'Die Wertentwicklung entscheidet',
      text: `Ohne Wertsteigerung endet das Modell bei ${low.units} ${low.units === 1 ? 'Wohnung' : 'Wohnungen'} und ${eur(low.netWorth)}. Mit den angenommenen ${String(x.params.reinvestAppreciationPct).replace('.', ',')} % sind es ${mid.units} und ${eur(mid.netWorth)}.`,
    })
  } else {
    const rot = x.risks.find(r => r.level === 'rot') ?? x.risks.find(r => r.level === 'gelb')
    if (rot) out.push({ title: 'Der wichtigste Hebel', text: rot.note })
  }

  // Die Liquiditaetswarnung ist die wichtigste Aussage, wenn es sie gibt. Sie
  // steht deshalb VORNE und darf nicht von den drei Erkenntnissen abgeschnitten
  // werden - eine Auswertung, die ein Liquiditaetsloch verschweigt, waere
  // schoengefaerbt.
  if (x.liquidityWarning) {
    out.unshift({
      title: 'Liquidität im Blick behalten',
      text: `Zwischen ${x.liquidityWarning.from} und ${x.liquidityWarning.to} unterschreitet das Modell die vereinbarte Reserve, im Tiefpunkt bei ${eur(x.liquidityWarning.lowest)}. In dieser Zeit wäre zusätzliches Kapital nötig oder ein Kauf müsste später erfolgen.`,
    })
  }
  return out.slice(0, 3)
}

function buildDrivers(x: {
  params: SimParams
  ri: ReinvestResult | null
  sensitivity: SensitivityRow[]
  cashflow: CashflowPoint[]
  financing: FinancingPoint[]
}): string[] {
  const out: string[] = []
  if (x.sensitivity.length >= 2) {
    const span = x.sensitivity[x.sensitivity.length - 1].netWorth - x.sensitivity[0].netWorth
    out.push(`Wertentwicklung: zwischen 0 und 9 % Unterschied von ${eur(span)} im Endvermögen - der stärkste Hebel.`)
  }
  if (x.ri && x.ri.kpis.refinancings > 0) {
    out.push(`Refinanzierung: ${x.ri.kpis.refinancings} Vorgänge ermöglichen ${x.ri.kpis.additionalPurchases} zusätzliche ${x.ri.kpis.additionalPurchases === 1 ? 'Wohnung' : 'Wohnungen'}.`)
  }
  const neg = x.cashflow.filter(c => c.cashflow < 0)
  if (neg.length) {
    out.push(`Anfangs-Cashflow: ${neg.length} Jahre im Minus begrenzen, wie schnell weiteres Kapital frei wird.`)
  }
  const ltvEnd = x.financing[x.financing.length - 1]?.ltv ?? 0
  out.push(`Finanzierung: Beleihungsgrad am Ende ${String(ltvEnd).replace('.', ',')} %, angenommener Zins ${String(x.params.interest).replace('.', ',')} %.`)
  return out
}
