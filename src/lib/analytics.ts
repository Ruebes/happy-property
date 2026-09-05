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
  // Waehrend der Bauzeit gezahlte Kaufraten. Das Geld ist weder Liquiditaet
  // noch schon Immobilienwert - es steckt in der Baustelle. Ohne diese eigene
  // Groesse ginge die Vermoegensrechnung in den ersten Jahren nicht auf.
  committed: number
  cash: number
  netWorth: number         // Eigenkapital + gebundenes Kapital + Liquiditaet
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

// ── Die Vermoegensrechnung zum Nachrechnen ───────────────────────────────────
// Der Kunde soll sehen, WIE sich das Netto-Vermoegen zusammensetzt, nicht nur
// das Ergebnis. Die Zeilen sind so gebaut, dass die Summe der angezeigten
// Zahlen exakt den angezeigten Endwert ergibt.
export interface BalanceLine { label: string; amount: number; kind: 'plus' | 'minus' | 'sum'; hint?: string }

// ── Was die Strategie gekostet hat ───────────────────────────────────────────
export interface CostOverview {
  ownEquity: number            // eingesetztes Eigenkapital
  additionalEquity: number     // was ueber das Startkapital hinaus noetig waere
  peakFunding: number          // hoechster Kapitalbedarf zu einem Zeitpunkt
  interest: number
  runningCosts: number
  taxes: number
  vatRefund: number
  refinancing: number
  saleProceeds: number
  wealthGain: number           // Netto-Vermoegen am Ende minus Startkapital
}

// ── Wohin das Geld geht ──────────────────────────────────────────────────────
export interface MoneyFlowRow { label: string; amount: number; meaning: string }

// ── Die Stationen der Strategie ──────────────────────────────────────────────
// Ersetzt den frueheren Wasserfall: Der erklaerte nichts, weil das Startkapital
// neben dem Portfoliowert nur ein Strich war. Hier steht stattdessen der Weg
// des Kapitals als Kette von Stationen, jede mit ihrer echten Zahl.
export interface JourneyStep { label: string; value: string; note: string }

// ── Was wann passiert ────────────────────────────────────────────────────────
export interface TimelineEntry { year: number; kind: 'buy' | 'handover' | 'refinance' | 'purchase' | 'sale'; label: string; detail: string }

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
  balance: BalanceLine[]
  cost: CostOverview
  moneyFlow: MoneyFlowRow[]
  journey: JourneyStep[]
  timeline: TimelineEntry[]
  keyInsights: Insight[]
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
  // Alle Groessen aus den GERUNDETEN Werten bilden, damit die Rechnung auf der
  // Seite aufgeht: Der Kunde rechnet mit dem nach, was dort steht.
  const wealth: WealthPoint[] = agg.rows.map(row => {
    const cash = r0(cashByYear.get(row.year) ?? 0)
    const propertyValue = r0(row.value)
    const debt = r0(row.debt)
    const committed = r0(row.committed)
    const propertyEquity = propertyValue - debt
    return {
      year: row.year,
      propertyValue, debt, propertyEquity, committed, cash,
      netWorth: propertyEquity + committed + cash,
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
  const lastWealth = wealth.length ? wealth[wealth.length - 1] : null
  const netWorthEnd = lastWealth ? lastWealth.netWorth : 0
  const summary: CustomerSummary = {
    firstYear: agg.firstYear, lastYear: agg.lastYear,
    originalEquity: params.ek,
    unitsEnd,
    portfolioValue: lastWealth?.propertyValue ?? 0,
    debt: lastWealth?.debt ?? 0,
    netWorth: netWorthEnd,
    cash: lastWealth?.cash ?? 0,
    irr: totals.irr,
    recyclingMultiple: ri ? ri.kpis.capitalRecyclingMultiple : null,
    exitNet: exit ? r0(exit.net) : null,
    additionalEquityNeeded: ri ? r0(Math.abs(Math.min(0, ...ri.flows.map(fl => fl.endingCash)))) : 0,
    text: buildSummaryText(params, agg, unitsEnd, lastRow?.value ?? 0, ri),
  }

  // ── Endbilanz ─────────────────────────────────────────────────────────────
  const balance: BalanceLine[] = lastWealth ? [
    { label: 'Wert der Immobilien', amount: lastWealth.propertyValue, kind: 'plus' },
    { label: 'Offene Kredite', amount: -lastWealth.debt, kind: 'minus' },
    { label: 'Eigenkapital in den Immobilien', amount: lastWealth.propertyEquity, kind: 'sum' },
    ...(lastWealth.committed
      ? [{ label: 'In der Bauphase gebundenes Kapital', amount: lastWealth.committed, kind: 'plus' as const,
        hint: 'Bereits gezahlte Kaufraten für Wohnungen, die noch nicht übergeben sind.' }]
      : []),
    { label: 'Liquidität', amount: lastWealth.cash, kind: 'plus' },
    { label: 'Netto-Vermögen', amount: lastWealth.netWorth, kind: 'sum' },
  ] : []

  // ── Was die Strategie gekostet hat ────────────────────────────────────────
  const ownEquity = outcomes.filter(o => !o.unit.model).reduce((a, o) => a + o.ekUsed, 0)
  // Zusaetzlicher Kapitalbedarf: der tiefste Punkt, an dem die Kasse ins Minus
  // laeuft. Genau so viel muesste der Kunde nachlegen.
  const lowestCash = ri ? Math.min(0, ...ri.flows.map(fl => fl.endingCash)) : 0
  const runningCosts = agg.rows.reduce((a, r) => a + r.mgmt + r.opex, 0)
  const vatSum = agg.rows.reduce((a, r) => a + r.vat, 0)
  const cost: CostOverview = {
    ownEquity: r0(Math.min(ownEquity, params.ek)),
    additionalEquity: r0(Math.abs(lowestCash)),
    peakFunding: r0(Math.max(ownEquity, params.ek) + Math.abs(lowestCash)),
    interest: r0(totals.interest),
    runningCosts: r0(runningCosts),
    taxes: r0(totals.taxes),
    vatRefund: r0(vatSum),
    refinancing: ri ? ri.kpis.totalRefinancingProceeds : 0,
    saleProceeds: ri ? ri.kpis.totalSaleProceeds : (exit ? r0(exit.net) : 0),
    wealthGain: r0(netWorthEnd - params.ek),
  }

  // ── Wohin das Geld geht ───────────────────────────────────────────────────
  const principalSum = agg.rows.reduce((a, r) => a + r.principal, 0)
  const moneyFlow: MoneyFlowRow[] = [
    { label: 'Startkapital', amount: params.ek, meaning: 'Dein Ausgangspunkt.' },
    { label: 'In Immobilien gebunden', amount: -r0(ownEquity),
      meaning: 'Eigenkapital und Kaufnebenkosten der ersten Käufe. Das Geld ist nicht weg, es steckt in den Wohnungen.' },
    { label: 'Mieteinnahmen', amount: r0(totals.rents), meaning: 'Alles, was die Wohnungen über den Zeitraum einbringen.' },
    { label: 'Laufende Kosten', amount: -r0(runningCosts), meaning: 'Verwaltung, Gemeinschaftskosten und Instandhaltungsrücklage.' },
    { label: 'Zinsen', amount: -r0(totals.interest), meaning: 'Die Kosten der Finanzierung. Dieses Geld ist tatsächlich weg.' },
    { label: 'Tilgung', amount: -r0(principalSum),
      meaning: 'Verlässt dein Konto, senkt aber die Schuld um denselben Betrag. Dein Eigenkapital steigt entsprechend.' },
    { label: 'Steuern und Abgaben', amount: -r0(totals.taxes), meaning: 'Einkommensteuer, Gesundheitsbeitrag und, wo sie anfällt, Sozialversicherung.' },
    ...(vatSum ? [{ label: 'MwSt-Erstattung', amount: r0(vatSum),
      meaning: 'Einmaliger Zufluss: die Kaufpreis-Mehrwertsteuer kommt bei Kurzzeitvermietung zurück.' }] : []),
    ...(cost.refinancing ? [{ label: 'Refinanzierung', amount: cost.refinancing,
      meaning: 'Kapital, das durch Wertzuwachs und Tilgung wieder verfügbar wird. Es erhöht gleichzeitig die Schuld.' }] : []),
    ...(cost.saleProceeds ? [{ label: 'Verkaufserlöse', amount: cost.saleProceeds,
      meaning: 'Was nach Kredit, Kosten und Steuern aus einem Verkauf übrig bleibt.' }] : []),
    { label: 'Liquidität am Ende', amount: lastWealth?.cash ?? 0, meaning: 'Was am Ende tatsächlich auf dem Konto liegt.' },
  ]

  // ── Stationen ─────────────────────────────────────────────────────────────
  const firstBuyYear = Math.min(...outcomes.filter(o => !o.unit.model).map(o => o.unit.buyY))
  const startUnits = outcomes.filter(o => !o.unit.model).length
  const equityBuilt = lastWealth ? lastWealth.propertyEquity - r0(ownEquity) : 0
  const journey: JourneyStep[] = [
    { label: 'Dein Startkapital', value: eur(params.ek), note: `Ausgangspunkt im Jahr ${firstBuyYear}.` },
    { label: startUnits === 1 ? 'Erste Wohnung' : `${startUnits} Wohnungen`, value: eur(r0(ownEquity)),
      note: 'So viel Eigenkapital ist beim Kauf gebunden, den Rest finanziert die Bank.' },
    { label: 'Miete, Tilgung, Wertzuwachs', value: eur(r0(totals.rents)),
      note: 'Mieteinnahmen über den ganzen Zeitraum. Sie tragen Zinsen und Tilgung mit.' },
    { label: 'Eigenkapital wächst', value: eur(equityBuilt),
      note: 'So viel Eigenkapital entsteht zusätzlich durch Tilgung und Wertentwicklung.' },
    ...(ri && ri.kpis.refinancings > 0
      ? [{ label: 'Refinanzierung', value: eur(ri.kpis.totalRefinancingProceeds),
        note: `${ri.kpis.refinancings === 1 ? 'Eine Refinanzierung macht' : `${ri.kpis.refinancings} Refinanzierungen machen`} gebundenes Kapital wieder verfügbar.` }]
      : []),
    ...(ri && ri.kpis.additionalPurchases > 0
      ? [{ label: ri.kpis.additionalPurchases === 1 ? 'Eine weitere Wohnung' : `${ri.kpis.additionalPurchases} weitere Wohnungen`,
        value: eur(ri.kpis.totalRecycledCapital),
        note: 'Dieses Kapital fließt erneut als Eigenkapital in Immobilien.' }]
      : []),
    { label: 'Netto-Vermögen', value: eur(netWorthEnd), note: `Stand am Ende des Zeitraums, ${agg.lastYear}.` },
  ]

  // ── Zeitachse aus echten Ereignissen ──────────────────────────────────────
  const timeline: TimelineEntry[] = []
  for (const o of outcomes) {
    if (o.unit.model) continue
    timeline.push({
      year: o.unit.buyY, kind: 'buy', label: `Kauf ${o.unit.name}`,
      detail: `${eur(o.gross)} gesamt, davon ${eur(o.ekUsed)} Eigenkapital.`,
    })
    if (o.unit.readyY !== o.unit.buyY) {
      timeline.push({
        year: o.unit.readyY, kind: 'handover', label: `Übergabe ${o.unit.name}`,
        detail: 'Ab hier fließt Miete, und Zins und Tilgung laufen.',
      })
    }
  }
  for (const e of events) {
    if (e.kind === 'refinance') {
      timeline.push({
        year: e.year, kind: 'refinance', label: 'Refinanzierung',
        detail: `${eur(e.newLoanAmount)} auf ${e.propertyNames.join(', ')} werden wieder verfügbar.`,
      })
    } else if (e.kind === 'purchase') {
      timeline.push({
        year: e.year, kind: 'purchase', label: `Kauf ${e.name}`,
        detail: `${eur(e.gross)} gesamt, davon ${eur(e.equity)} Eigenkapital aus wiederverwendetem Geld.`,
      })
    } else {
      timeline.push({
        year: e.year, kind: 'sale', label: `Verkauf ${e.name}`,
        detail: `${eur(e.netProceeds)} bleiben nach Kredit, Kosten und Steuern übrig.`,
      })
    }
  }
  timeline.sort((x, y) => x.year - y.year)

  // ── Die fünf wichtigsten Punkte ───────────────────────────────────────────
  const unitsEndForKeys = portfolio.length ? portfolio[portfolio.length - 1].units : 0
  const keyInsights: Insight[] = [
    { title: 'Dein Startkapital', text: `${eur(params.ek)} bilden den Ausgangspunkt der Strategie.` },
    { title: 'Dein Portfolio',
      text: startUnits === unitsEndForKeys
        ? `Es bleibt bei ${unitsEndForKeys} ${unitsEndForKeys === 1 ? 'Wohnung' : 'Wohnungen'} mit einem Wert von ${eur(lastWealth?.propertyValue ?? 0)}.`
        : `Aus ${startUnits === 1 ? 'der ersten Wohnung' : `${startUnits} Wohnungen`} werden ${unitsEndForKeys} mit einem Wert von ${eur(lastWealth?.propertyValue ?? 0)}.` },
    { title: 'Dein Kapital arbeitet mehrfach',
      text: ri && ri.kpis.totalRecycledCapital > 0
        ? `${eur(ri.kpis.totalRecycledCapital)} werden erneut in Immobilien investiert, das ${ri.kpis.capitalRecyclingMultiple.toFixed(1).replace('.', ',')}-fache deines Startkapitals.`
        : 'Unter diesen Annahmen reicht das freiwerdende Kapital im Betrachtungszeitraum nicht für einen weiteren Kauf.' },
    { title: 'Dein Vermögen',
      text: `Das Netto-Vermögen erreicht ${eur(netWorthEnd)}, ein Zuwachs von ${eur(netWorthEnd - params.ek)} gegenüber deinem Startkapital.` },
    { title: 'Deine Liquidität',
      text: cost.additionalEquity > 0
        ? `Zwischenzeitlich wären bis zu ${eur(cost.additionalEquity)} zusätzliches Kapital nötig. Am Ende verbleiben ${eur(lastWealth?.cash ?? 0)}.`
        : `Die Liquiditätsreserve bleibt durchgehend erhalten. Am Ende verbleiben ${eur(lastWealth?.cash ?? 0)}.` },
  ]

  const insights = buildInsights({ params, wealth, portfolio, cashflow, ri, sensitivity, risks, liquidityWarning })
  const drivers = buildDrivers({ params, ri, sensitivity, cashflow, financing })

  return {
    reinvest: reinvestOn, summary, wealth, portfolio, cashflow, cashflowRows,
    liquidity, minimumReserve: reserve, liquidityWarning,
    financing, financingKpis, capitalSteps, recyclingRows, opportunity,
    properties, tax, taxKpis, scenarios, exits, risks, insights, drivers, sensitivity,
    balance, cost, moneyFlow, journey, timeline, keyInsights, events,
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
