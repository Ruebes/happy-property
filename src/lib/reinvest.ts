// ── Reinvestment- und Kapital-Recycling-Motor ────────────────────────────────
// Beantwortet nicht mehr nur „was passiert mit diesen Wohnungen", sondern:
// wie weit traegt das vorhandene Kapital, wenn Wertzuwachs und Tilgung neue
// Beleihungsspielraeume schaffen und Verkaufserloese wieder investiert werden?
//
// Aufbau: Der Motor arbeitet JAHR FUER JAHR auf der bestehenden Strategie-
// Schicht. Er rechnet nichts selbst nach, was strategy.ts oder rechner.ts schon
// koennen - er entscheidet nur, wann refinanziert, gekauft und verkauft wird,
// und gibt den veraenderten Zustand in die naechste Runde. Eine Refinanzierung
// wirkt damit sofort auf Zins, Tilgung, Restschuld, Cashflow und Steuer der
// folgenden Jahre; sie wird nicht im Nachhinein daraufgerechnet.
//
// WICHTIG fuer alle Texte: Was hier entsteht, ist eine Modellrechnung unter
// gewaehlten Annahmen, keine Finanzierungszusage. Ob eine Bank tatsaechlich
// finanziert, haengt an Einkommen, Bonitaet, Bewertung und Bankrichtlinien.
import {
  allocate, aggregate, runUnit, computeSale, totalsOf, horizonOf, trancheSchedule,
  type SimUnit, type SimParams, type UnitOutcome, type YearRow,
  type LoanTranche, type SaleResult, type StrategyTotals,
} from './strategy'
import { CY_CGT_ALLOWANCE } from './rechner'

// ── Ereignisse ───────────────────────────────────────────────────────────────
export interface PurchaseEvent {
  kind: 'purchase'; year: number; key: string; name: string
  price: number; gross: number; equity: number; loan: number; model: boolean
  fundedFromCash: number; fundedFromRefinance: number; fundedFromSale: number
}
export interface RefinanceEvent {
  kind: 'refinance'; year: number; trancheId: string
  propertyKeys: string[]; propertyNames: string[]
  marketValue: number; refinanceLtv: number; bankValuationFactor: number
  existingSecuredDebt: number
  theoreticalCapacity: number; usableCapacity: number
  newLoanAmount: number; ratePct: number; termYears: number; monthlyPayment: number
}
export interface SaleEvent {
  kind: 'sale'; year: number; key: string; name: string
  value: number; debt: number; sellCost: number; levy: number
  vatClawback: number; cgt: number; taxDE: number; netProceeds: number
}
export type StrategyEvent = PurchaseEvent | RefinanceEvent | SaleEvent

// ── Kasse ────────────────────────────────────────────────────────────────────
export interface CapitalFlow {
  year: number
  startingCash: number
  operatingCashflow: number     // Miete abzueglich Kosten, Rate und Steuern
  refinancingProceeds: number
  saleProceeds: number
  purchaseEquity: number        // Eigenkapital in neue Objekte
  purchaseCosts: number         // Kaufnebenkosten neuer Objekte
  endingCash: number
}

// ── Gelegenheit ──────────────────────────────────────────────────────────────
export interface ReinvestmentOpportunity {
  year: number
  availableCash: number
  refinancingCapacity: number
  saleProceeds: number
  maximumPurchasePrice: number
  modelPurchasePrice: number
  requiredEquity: number
  minimumReserveAfterPurchase: number
  affordable: boolean
  reason?: string
}

// ── Jahreszeile fuer die spaetere Kundenauswertung ───────────────────────────
export interface ReinvestYear {
  year: number
  activeUnits: number
  cumulativePurchases: number
  cumulativeSales: number
  propertyValue: number
  debt: number
  equity: number            // Immobilienwert abzueglich Schuld
  netWorth: number          // dazu die Kasse
  ltv: number
  annualCashflow: number
  cumulativeCashflow: number
  rent: number
  operatingCosts: number    // Verwaltung und Kosten der Wohnung
  interest: number
  amortization: number
  tax: number
  cumulativeTax: number
  refinancingCapacity: number
  endingCash: number
}

export interface ReinvestKpis {
  additionalPurchases: number
  refinancings: number
  sales: number
  totalRefinancingProceeds: number
  totalSaleProceeds: number
  totalRecycledCapital: number
  originalEquity: number
  capitalRecyclingMultiple: number
  maximumAdditionalPurchasePrice: number
  earliestNextPurchaseYear: number | null
  activeUnitsEnd: number
  portfolioValueEnd: number
  debtEnd: number
  portfolioEquityEnd: number
  cashEnd: number
  // Niedrigster Kassenstand ueber den ganzen Zeitraum. Wird er negativ, muss
  // der Kunde zwischendurch zuschiessen - das gehoert offen ausgewiesen.
  lowestCash: number
  lowestCashYear: number | null
}

export interface ReinvestResult {
  units: SimUnit[]
  outcomes: UnitOutcome[]
  rows: YearRow[]
  years: ReinvestYear[]
  events: StrategyEvent[]
  tranches: LoanTranche[]
  flows: CapitalFlow[]
  opportunities: ReinvestmentOpportunity[]
  sales: SaleResult[]
  saleYears: Map<string, number>
  totals: StrategyTotals
  kpis: ReinvestKpis
  firstYear: number
  lastYear: number
  modelUnit: SimUnit | null
}

const round = (n: number) => Math.round(n)

// ── Modellobjekt ─────────────────────────────────────────────────────────────
// Fuer ein Jahr in der Zukunft gibt es kein konkretes Angebot. Der Motor leitet
// deshalb ein Durchschnittsobjekt aus den bereits gewaehlten Wohnungen ab:
// Preis, Moebelanteil, Mietrendite, Vermietungsart, Verwaltung und laufende
// Kosten. Es ist ausdruecklich eine Modellannahme, kein reales Objekt.
export function buildModelUnit(units: SimUnit[], p: SimParams): SimUnit | null {
  const base = units.filter(u => !u.model)
  if (!base.length) return null
  const avg = (f: (u: SimUnit) => number) => base.reduce((a, u) => a + f(u), 0) / base.length
  const priceNet = round(avg(u => u.priceNet) / 1000) * 1000
  const furnNet = round(avg(u => u.furnNet) / 500) * 500
  // Miete ueber die durchschnittliche Rendite, damit ein groesseres oder
  // kleineres Objekt konsistent bleibt.
  const yieldPct = avg(u => u.priceNet > 0 ? (u.rent * 12) / u.priceNet : 0)
  const short = base.filter(u => u.letType === 'short').length >= base.length / 2
  const mgmt = base.map(u => u.calc?.mgmtPct).filter((x): x is number => typeof x === 'number')
  return {
    key: 'model', name: 'Modellwohnung', priceNet, furnNet,
    rent: round(priceNet * yieldPct / 12),
    letType: short ? 'short' : 'long',
    fin: true,
    buyM: 1, buyY: 0, readyM: 1, readyY: 0,   // Zeitpunkte setzt der Motor
    plan: 'sofort',
    opex: round(avg(u => u.opex ?? p.opexMonthly)),
    model: true,
    calc: mgmt.length ? { mgmtPct: round(mgmt.reduce((a, b) => a + b, 0) / mgmt.length) } : undefined,
  }
}

// Ein Modellobjekt auf einen bestimmten Preis und ein bestimmtes Jahr setzen.
function modelAt(model: SimUnit, price: number, year: number, index: number): SimUnit {
  const yieldPct = model.priceNet > 0 ? (model.rent * 12) / model.priceNet : 0
  const furnShare = model.priceNet > 0 ? model.furnNet / model.priceNet : 0
  const priceNet = Math.max(50000, round(price / 1000) * 1000)
  return {
    ...model,
    key: `model-${index}`,
    name: `Modellwohnung ${index}`,
    priceNet,
    furnNet: round(priceNet * furnShare / 500) * 500,
    rent: round(priceNet * yieldPct / 12),
    buyM: 1, buyY: year, readyM: 1, readyY: year,
  }
}

// Was kostet ein Objekt an Eigenkapital, wenn es mit dem angenommenen
// Beleihungsauslauf finanziert wird? Kommt aus der bestehenden Engine, nicht
// aus einer Faustformel: runUnit liefert Gesamtpreis, Darlehen und ekStart.
function equityNeeded(unit: SimUnit, p: SimParams, ltv: number): { equity: number; gross: number; loan: number; costs: number } {
  const probe = runUnit({ ...unit }, 0, p)
  const gross = probe.gross
  const loan = round(gross * ltv / 100)
  const eq = Math.max(0, gross - loan)
  const withEq = runUnit({ ...unit }, eq, p)
  return { equity: withEq.res.ekStart, gross, loan: withEq.loan, costs: withEq.res.costs }
}

// Groesstes Objekt, das mit dem verfuegbaren Kapital finanzierbar ist. Die
// einfache Formel Kapital/Eigenkapitalquote dient nur als Startwert; geprueft
// wird gegen die echte Engine, weil Nebenkosten, Moebel und MwSt mit haengen.
export function maxAffordablePrice(model: SimUnit, p: SimParams, capital: number, year: number): number {
  const ltv = p.refinanceLtv
  if (capital <= 0) return 0
  let lo = 0, hi = Math.max(100000, capital / Math.max(0.05, (100 - ltv) / 100) * 2)
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2
    const need = equityNeeded(modelAt(model, mid, year, 0), p, ltv).equity
    if (need > capital) hi = mid; else lo = mid
  }
  return round(lo / 1000) * 1000
}

export function runReinvest(units: SimUnit[], p: SimParams): ReinvestResult {
  const firstYear = units.length ? Math.min(...units.map(u => u.buyY)) : new Date().getFullYear()
  const lastYear = firstYear + horizonOf(p) - 1
  const events: StrategyEvent[] = []
  const tranches: LoanTranche[] = []
  const flows: CapitalFlow[] = []
  const opportunities: ReinvestmentOpportunity[] = []
  const sales: SaleResult[] = []
  const saleYears = new Map<string, number>()

  // Startbestand: unveraendert ueber die bestehende Verteilung.
  let outcomes = allocate(units, p)
  let allUnits = [...units]
  const model = buildModelUnit(units, p)
  let exemptionLeft = CY_CGT_ALLOWANCE
  // Startkasse: Was vom Eigenkapital nach den ersten Kaeufen uebrig bleibt.
  // Ohne diese Zeile wuerde der Motor so tun, als haette der Kunde ausser den
  // Wohnungen keinen Cent - und ein negativer Cashflow liefe sofort ins Minus.
  let cash = Math.max(0, p.ek - outcomes.reduce((a, o) => a + o.ekUsed, 0))
  let purchases = 0, refis = 0
  let recycled = 0, refiProceeds = 0, saleProceedsTotal = 0
  let maxPriceSeen = 0
  let earliestNext: number | null = null

  // Vorgegebene Einzelverkaeufe uebernehmen.
  for (const u of units) if (u.saleYear) saleYears.set(u.key, u.saleYear)

  // Jahr fuer Jahr. Nach jedem Ereignis wird der Zustand neu aggregiert, damit
  // die Folgejahre wirklich mit dem neuen Portfolio rechnen.
  let rows: YearRow[] = aggregate(outcomes, p, { tranches, saleYears, untilYear: lastYear }).rows
  const capacityByYear = new Map<number, number>()

  for (let y = firstYear; y <= lastYear; y++) {
    const row = rows.find(r => r.year === y)
    const startingCash = cash
    const operating = row ? row.cashflow : 0
    cash += operating

    // ── Verkaeufe dieses Jahres ─────────────────────────────────────────────
    let saleIn = 0
    for (const o of outcomes) {
      if (saleYears.get(o.unit.key) !== y) continue
      const sale = computeSale(o, y, p, exemptionLeft, tranches)
      exemptionLeft = Math.max(0, exemptionLeft - sale.usedExemption)
      sales.push(sale)
      saleIn += sale.netProceeds
      saleProceedsTotal += sale.netProceeds
      events.push({
        kind: 'sale', year: y, key: o.unit.key, name: o.unit.name,
        value: sale.line.value, debt: sale.line.debt, sellCost: sale.line.sellCost,
        levy: sale.levy, vatClawback: sale.line.vatClawback,
        cgt: sale.cgt, taxDE: sale.taxDE, netProceeds: sale.netProceeds,
      })
      // Tranchen dieser Wohnung sind mit dem Verkauf abgeloest.
      for (let i = tranches.length - 1; i >= 0; i--) {
        const t = tranches[i]
        if (t.propertyKeys.length === 1 && t.propertyKeys[0] === o.unit.key) tranches.splice(i, 1)
      }
    }
    cash += saleIn

    // ── Beleihungskapazitaet ────────────────────────────────────────────────
    // Marktwert und Restschuld kommen aus der laufenden Rechnung, die Tranchen
    // zaehlen als besicherte Schuld mit.
    let capacity = 0
    const perUnit: Array<{ o: UnitOutcome; value: number; debt: number; usable: number }> = []
    for (const o of outcomes) {
      const sold = saleYears.get(o.unit.key)
      if (sold != null && y >= sold) continue
      const i = y - o.unit.readyY
      if (i < 0) continue
      const n = o.res.rents.length
      const value = o.res.propV[Math.min(i, n - 1)]
      const own = o.res.restL[Math.min(i, n - 1)]
      const tr = tranches.filter(t => t.propertyKeys.includes(o.unit.key) && t.startYear <= y)
        .reduce((a, t) => {
          const sch = trancheRest(t, y)
          return a + sch / Math.max(1, t.propertyKeys.length)
        }, 0)
      const maxSecured = value * (p.bankValuationFactor / 100) * (p.refinanceLtv / 100)
      const theoretical = Math.max(0, maxSecured - own - tr)
      const usable = round(theoretical * (p.refinanceUtilizationPct / 100))
      perUnit.push({ o, value, debt: round(own + tr), usable })
      capacity += usable
    }
    capacityByYear.set(y, capacity)

    // ── Gelegenheit pruefen ─────────────────────────────────────────────────
    const modelPrice = model ? model.priceNet : 0
    const capitalWithoutRefi = Math.max(0, cash - p.minimumCashReserve)
    const capitalWithRefi = Math.max(0, cash + capacity - p.minimumCashReserve)
    const maxPrice = model ? maxAffordablePrice(model, p, capitalWithRefi, y) : 0
    const needForModel = model ? equityNeeded(modelAt(model, modelPrice, y, purchases + 1), p, p.refinanceLtv).equity : 0
    const affordable = !!model && y < lastYear && purchases < p.maxAdditionalPurchases
      && needForModel > 0 && capitalWithRefi >= needForModel
    if (maxPrice > maxPriceSeen) maxPriceSeen = maxPrice
    opportunities.push({
      year: y,
      availableCash: round(cash),
      refinancingCapacity: round(capacity),
      saleProceeds: round(saleIn),
      maximumPurchasePrice: maxPrice,
      modelPurchasePrice: modelPrice,
      requiredEquity: round(needForModel),
      minimumReserveAfterPurchase: p.minimumCashReserve,
      affordable,
      reason: affordable ? undefined
        : !model ? 'kein Modellobjekt ableitbar'
          : purchases >= p.maxAdditionalPurchases ? 'Obergrenze für zusätzliche Käufe erreicht'
            : y >= lastYear ? 'im letzten Jahr des Zeitraums lohnt kein Kauf mehr'
              : 'verfügbares Kapital reicht nicht für das Modellobjekt',
    })
    if (affordable && earliestNext == null) earliestNext = y

    // ── Kauf durchfuehren ───────────────────────────────────────────────────
    if (affordable && p.autoReinvest && model) {
      const idx = purchases + 1
      const unit = modelAt(model, modelPrice, y, idx)
      const need = equityNeeded(unit, p, p.refinanceLtv)
      // Zuerst vorhandenes Geld, dann refinanzieren - nur so viel wie noetig.
      const fromCash = Math.min(capitalWithoutRefi, need.equity)
      const missing = Math.max(0, need.equity - fromCash)
      let fromRefi = 0
      if (missing > 0 && capacity > 0) {
        let rest = Math.min(missing, capacity)
        for (const pu of perUnit) {
          if (rest <= 0.5) break
          const take = Math.min(pu.usable, rest)
          if (take < 1000) continue
          const t: LoanTranche = {
            id: `refi-${y}-${pu.o.unit.key}`,
            propertyKeys: [pu.o.unit.key],
            startYear: y,
            amount: round(take),
            ratePct: p.interest,
            termYears: p.termYears,
            purpose: 'purchase',
            // Die Mittel fliessen in eine vermietete Immobilie, die Zinsen sind
            // damit abzugsfaehig.
            deductible: true,
          }
          tranches.push(t)
          const sch = trancheSchedule1(t)
          events.push({
            kind: 'refinance', year: y, trancheId: t.id,
            propertyKeys: t.propertyKeys, propertyNames: [pu.o.unit.name],
            marketValue: round(pu.value), refinanceLtv: p.refinanceLtv,
            bankValuationFactor: p.bankValuationFactor,
            existingSecuredDebt: pu.debt,
            theoreticalCapacity: pu.usable, usableCapacity: pu.usable,
            newLoanAmount: t.amount, ratePct: t.ratePct, termYears: t.termYears,
            monthlyPayment: round(sch / 12),
          })
          fromRefi += t.amount
          rest -= take
          refis++
          refiProceeds += t.amount
        }
      }
      const funded = fromCash + fromRefi
      cash += fromRefi
      // Tragbarkeit: Die Mindestreserve muss nicht nur im Kaufjahr stehen,
      // sondern auch in allen Folgejahren. Dafuer wird der Kauf probeweise
      // durchgerechnet - mit dem neuen Objekt, der neuen Tranche und der
      // veraenderten Steuer. Faellt die Kasse irgendwann unter die Reserve,
      // ist der Kauf unter diesen Annahmen nicht tragbar.
      const probeUnits = [...allUnits, unit]
      const probeOutcomes = allocate(probeUnits.filter(u => !u.model), p)
        .concat(probeUnits.filter(u => u.model).map(u => runUnit(u, equityNeeded(u, p, p.refinanceLtv).equity, p)))
      const probeRows = aggregate(probeOutcomes, p, { tranches, saleYears, untilYear: lastYear }).rows
      let probeCash = cash - need.equity
      let sustainable = probeCash >= p.minimumCashReserve
      if (sustainable) {
        for (const pr of probeRows) {
          if (pr.year <= y) continue
          probeCash += pr.cashflow
          // Kuenftige Verkaufserloese entlasten die Kasse wieder.
          for (const o of probeOutcomes) {
            if (saleYears.get(o.unit.key) === pr.year) {
              probeCash += computeSale(o, pr.year, p, exemptionLeft, tranches).netProceeds
            }
          }
          if (probeCash < p.minimumCashReserve) { sustainable = false; break }
        }
      }
      if (funded + 0.5 >= need.equity && sustainable) {
        cash -= need.equity
        purchases++
        // Wiederverwendetes Kapital = das gesamte Eigenkapital, das nach dem
        // Start erneut in eine Immobilie geflossen ist - egal ob es aus einer
        // Refinanzierung, aus einem Verkauf oder aus dem laufenden Ueberschuss
        // stammt. Die frueher engere Zaehlung (nur Refinanzierung) ergab 0,
        // sobald ein Kauf aus der Kasse bezahlt wurde, obwohl der Kunde sichtbar
        // weitere Wohnungen bekam (Befund 5.9.26).
        recycled += need.equity
        allUnits = probeUnits
        outcomes = probeOutcomes
        events.push({
          kind: 'purchase', year: y, key: unit.key, name: unit.name,
          price: unit.priceNet, gross: need.gross, equity: round(need.equity), loan: need.loan,
          model: true,
          fundedFromCash: round(fromCash), fundedFromRefinance: round(fromRefi), fundedFromSale: 0,
        })
        rows = probeRows
      } else {
        // Nicht tragbar: die eben angelegten Tranchen zuruecknehmen.
        for (let i = tranches.length - 1; i >= 0; i--) {
          if (tranches[i].startYear !== y) continue
          refiProceeds -= tranches[i].amount
          refis--
          tranches.splice(i, 1)
        }
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].kind === 'refinance' && events[i].year === y) events.splice(i, 1)
        }
        cash -= fromRefi
        const opp = opportunities[opportunities.length - 1]
        opp.affordable = false
        opp.reason = funded + 0.5 < need.equity
          ? 'verfügbares Kapital reicht nicht für das Modellobjekt'
          : 'Mindestliquidität würde in einem der Folgejahre unterschritten'
      }
    }

    flows.push({
      year: y,
      startingCash: round(startingCash),
      operatingCashflow: round(operating),
      refinancingProceeds: round(events.filter(e => e.kind === 'refinance' && e.year === y).reduce((a, e) => a + (e as RefinanceEvent).newLoanAmount, 0)),
      saleProceeds: round(saleIn),
      purchaseEquity: round(events.filter(e => e.kind === 'purchase' && e.year === y).reduce((a, e) => a + (e as PurchaseEvent).equity, 0)),
      purchaseCosts: 0,
      endingCash: round(cash),
    })
  }

  // Abschliessende Rechnung mit dem fertigen Zustand.
  const agg = aggregate(outcomes, p, { tranches, saleYears, untilYear: lastYear })
  rows = agg.rows
  const totals = totalsOf(outcomes, rows, p, null)

  // Jahreszeilen fuer die spaetere Kundenauswertung.
  let cumCf = 0, cumTax = 0, cumPurch = 0, cumSales = 0
  const years: ReinvestYear[] = rows.map(r => {
    cumCf += r.cashflow
    cumTax += r.taxes
    cumPurch += events.filter(e => e.kind === 'purchase' && e.year === r.year).length
    cumSales += events.filter(e => e.kind === 'sale' && e.year === r.year).length
    const active = outcomes.filter(o => {
      const sold = saleYears.get(o.unit.key)
      return o.unit.readyY <= r.year && (sold == null || r.year < sold)
    }).length
    const flow = flows.find(f => f.year === r.year)
    return {
      year: r.year,
      activeUnits: active,
      cumulativePurchases: cumPurch,
      cumulativeSales: cumSales,
      propertyValue: round(r.value),
      debt: round(r.debt),
      equity: round(r.value - r.debt),
      netWorth: round(r.value + r.committed - r.debt + (flow?.endingCash ?? 0)),
      ltv: r.value > 0 ? Math.round(r.debt / r.value * 1000) / 10 : 0,
      annualCashflow: round(r.cashflow),
      cumulativeCashflow: round(cumCf),
      rent: round(r.rents),
      operatingCosts: round(r.mgmt + r.opex),
      interest: round(r.interest),
      amortization: round(r.principal),
      tax: round(r.taxes),
      cumulativeTax: round(cumTax),
      refinancingCapacity: round(capacityByYear.get(r.year) ?? 0),
      endingCash: flow?.endingCash ?? 0,
    }
  })

  const lastRow = rows[rows.length - 1]
  const originalEquity = p.ek
  const kpis: ReinvestKpis = {
    additionalPurchases: purchases,
    refinancings: refis,
    sales: sales.length,
    totalRefinancingProceeds: round(refiProceeds),
    totalSaleProceeds: round(saleProceedsTotal),
    // Wiederverwendet = Eigenkapital, das nach dem Start erneut in eine
    // Immobilie geflossen ist. Quelle egal (Refinanzierung, Verkauf, laufender
    // Ueberschuss), aber immer nur echtes Kapital in echten Kaeufen - keine
    // Summe aller Cashflows. Das ist KEINE Rendite.
    totalRecycledCapital: round(recycled),
    originalEquity,
    capitalRecyclingMultiple: originalEquity > 0 ? Math.round(recycled / originalEquity * 100) / 100 : 0,
    maximumAdditionalPurchasePrice: maxPriceSeen,
    earliestNextPurchaseYear: earliestNext,
    activeUnitsEnd: years.length ? years[years.length - 1].activeUnits : 0,
    portfolioValueEnd: round(lastRow?.value ?? 0),
    debtEnd: round(lastRow?.debt ?? 0),
    portfolioEquityEnd: round((lastRow?.value ?? 0) - (lastRow?.debt ?? 0)),
    cashEnd: round(cash),
    lowestCash: flows.length ? Math.min(...flows.map(f => f.endingCash)) : 0,
    lowestCashYear: flows.length
      ? flows.reduce((a, b) => (b.endingCash < a.endingCash ? b : a)).year
      : null,
  }

  return {
    units: allUnits, outcomes, rows, years, events, tranches, flows, opportunities,
    sales, saleYears, totals, kpis, firstYear, lastYear, modelUnit: model,
  }
}

// Restschuld einer Tranche am Ende eines Jahres.
function trancheRest(t: LoanTranche, year: number): number {
  const sch = trancheSchedule(t, year)
  return sch.length ? sch[sch.length - 1].rest : t.amount
}
// Jahresrate einer Tranche, fuer die Anzeige der Monatsrate.
function trancheSchedule1(t: LoanTranche): number {
  const sch = trancheSchedule(t, t.startYear)
  return sch.length ? sch[0].rate : 0
}
