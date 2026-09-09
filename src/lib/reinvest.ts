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
  allocate, aggregate, runUnit, computeSale, totalsOf, horizonOf, purchaseGrowthOf, trancheSchedule,
  type SimUnit, type SimParams, type UnitOutcome, type YearRow,
  type LoanTranche, type SaleResult, type StrategyTotals,
} from './strategy'
import { CY_CGT_ALLOWANCE, irrCalc, personsOf } from './rechner'

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
  vatRefund: number             // Kapitalereignis, kein laufender Ertrag
  investorEquity: number        // zusaetzliches Geld des Investors in diesem Jahr
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

// Lebenslauf einer Wohnung: Kauf, Bauzeit, Uebergabe, Beleihbarkeit.
// Kaufvertrag und Uebergabe sind zwei verschiedene Zeitpunkte. Eine Wohnung im
// Bau ist bezahlt (oder in Raten), aber sie taugt nicht als Sicherheit - die
// Bank beleiht erst das fertige Objekt. Deshalb kann eine 2027 gekaufte
// Wohnung erst 2029 zum Kapital-Recycling beitragen (Sven 9.9.26).
export interface UnitTimeline {
  key: string
  name: string
  model: boolean
  purchaseYear: number
  purchaseMonth: number
  handoverYear: number
  handoverMonth: number
  constructionMonths: number      // 0 = sofort verfuegbar, kein Bau
  pledgeableFrom: number          // Jahr, ab dem die Wohnung Sicherheit sein kann
  firstRefinanceYear: number | null
  refinancings: number
  totalRefinanced: number
}

export interface ReinvestKpis {
  // ── Kapitaltrennung (Sven 6.9.26) ─────────────────────────────────────────
  // Geld des Investors und Kapital, das die Strategie selbst freisetzt, duerfen
  // nie vermischt werden.
  startingEquity: number          // Startkapital
  investorContributions: number   // spaetere Einzahlungen des Investors
  totalInvestorCapital: number    // beides zusammen
  selfFunding: boolean            // Modus: ohne weiteres Geld des Investors
  selfSupporting: boolean         // Ergebnis: Reserve zu jedem Zeitpunkt gehalten
  selfFundingBreaks: number | null // Jahr, in dem der Modus nicht mehr traegt
  selfFundingReason: string | null
  operatingPositiveFrom: number | null  // ab wann der operative Cashflow traegt
  additionalPurchases: number
  refinancings: number
  sales: number
  totalRefinancingProceeds: number
  totalSaleProceeds: number
  totalRecycledCapital: number
  totalBorrowedForPurchases: number   // Anteil der Zukaeufe, der aus Krediten stammt
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
  unitTimeline: UnitTimeline[]
}

const round = (n: number) => Math.round(n)

// Zentrale Toleranz fuer Ja-Nein-Entscheidungen ueber Geld (Audit 9.9.26).
// Die Kasse traegt Nachkommastellen aus den Bauzeitzinsen, die Tranchen werden
// auf ganze Euro gerundet. Ohne Toleranz entschieden dadurch 24 Cent ueber die
// gesamte Kaufkaskade: 399.000 Euro Startkapital ergaben 2,41 Millionen,
// 400.000 Euro dagegen 3,73 Millionen.
// Die Toleranz gilt AUSSCHLIESSLICH fuer die Entscheidungslogik. Jede
// ausgewiesene Zahl - Kasse, Schuld, Vermoegen - bleibt exakt gerechnet.
export const MONEY_TOLERANCE = 1

// ── Modellobjekt ─────────────────────────────────────────────────────────────
// Fuer ein Jahr in der Zukunft gibt es kein konkretes Angebot. Der Motor leitet
// deshalb ein Durchschnittsobjekt aus den bereits gewaehlten Wohnungen ab:
// Preis, Moebelanteil, Mietrendite, Vermietungsart, Verwaltung und laufende
// Kosten. Es ist ausdruecklich eine Modellannahme, kein reales Objekt.
export function buildModelUnit(units: SimUnit[], p: SimParams): SimUnit | null {
  const real = units.filter(u => !u.model)
  if (!real.length) return null
  // Explizit gewaehltes Referenzobjekt hat Vorrang vor dem Durchschnitt.
  const target = p.reinvestTargetKey ? real.find(u => u.key === p.reinvestTargetKey) : undefined
  const base = target ? [target] : real
  const avg = (f: (u: SimUnit) => number) => base.reduce((a, u) => a + f(u), 0) / base.length
  const priceNet = round(avg(u => u.priceNet) / 1000) * 1000
  const furnNet = round(avg(u => u.furnNet) / 500) * 500
  // Miete ueber die durchschnittliche Rendite, damit ein groesseres oder
  // kleineres Objekt konsistent bleibt.
  const yieldPct = avg(u => u.priceNet > 0 ? (u.rent * 12) / u.priceNet : 0)
  const mgmt = base.map(u => u.calc?.mgmtPct).filter((x): x is number => typeof x === 'number')
  return {
    key: 'model', name: 'Modellwohnung', priceNet, furnNet,
    rent: round(priceNet * yieldPct / 12),
    // Kurzzeitvermietung ist der Standard fuer neue Wohnungen (Sven 9.9.26).
    // Frueher wurde die Vermietungsart von den Startwohnungen geerbt: Waren
    // die mehrheitlich Langzeit, fiel bei jedem Zukauf die
    // Mehrwertsteuer-Erstattung ersatzlos weg, ohne dass es jemand sah.
    letType: 'short',
    fin: true,
    buyM: 1, buyY: 0, readyM: 1, readyY: 0,   // Zeitpunkte setzt der Motor
    // Zahlungsplan des Bautraegers statt Sofortkauf: Reservierung, 35 % bei
    // Vertrag, drei Bauraten, 10 % bei Uebergabe.
    plan: 'luma',
    opex: round(avg(u => u.opex ?? p.opexMonthly)),
    model: true,
    calc: mgmt.length ? { mgmtPct: round(mgmt.reduce((a, b) => a + b, 0) / mgmt.length) } : undefined,
  }
}

// Ein Modellobjekt auf einen bestimmten Preis und ein bestimmtes Jahr setzen.
// rentFactor schreibt die Marktmiete bis zum Kaufjahr fort. Bewusst NICHT ueber
// die Rendite an den Kaufpreis gekoppelt: Kaufpreise steigen in der Regel
// schneller als Mieten, deshalb faellt die Anfangsrendite spaeterer Kaeufe. Die
// Rendite mitzuziehen wuerde jedem Folgekauf die Mietsteigerung des Kaufpreises
// unterschieben und die Strategie zu gut aussehen lassen.
// Moebel bleiben auf dem heutigen Betrag (STEP 3G, Punkt 12): eine eigene
// Moebelpreissteigerung kommt spaeter als separater Parameter, nicht implizit.
function modelAt(model: SimUnit, price: number, year: number, index: number, rentFactor = 1, constructionMonths = 18): SimUnit {
  const priceNet = Math.max(50000, round(price / 1000) * 1000)
  // Vertrag im Januar des Kaufjahres, Uebergabe nach der Bauzeit. Vorher wurde
  // beides auf denselben Januar gesetzt: Die Wohnung war im Kaufmonat bezahlt,
  // vermietet und beliehen - ein Off-Plan-Kauf sieht anders aus.
  const cm = Math.max(0, Math.round(constructionMonths))
  const readyAbs = year * 12 + cm
  return {
    ...model,
    key: `model-${index}`,
    name: `Modellwohnung ${index}`,
    priceNet,
    furnNet: model.furnNet,
    rent: round(model.rent * rentFactor),
    buyM: 1, buyY: year,
    readyY: Math.floor(readyAbs / 12),
    readyM: (readyAbs % 12) + 1,
    plan: cm > 0 ? 'luma' : 'sofort',
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

// Eigenkapital OHNE Nebenkosten - genau das, was runUnit als Eigenkapitalanteil
// am Kaufpreis erwartet. equityNeeded liefert dagegen ekStart, also den Betrag
// INKLUSIVE der Nebenkosten, den der Investor aus der Kasse zahlt.
// Beide Zahlen zu verwechseln hiess: Nebenkosten ein zweites Mal aufschlagen
// und dafuer das Darlehen kuerzen (Audit 9.9.26). Der Beleihungsauslauf lag
// dadurch bei 69,0 statt der eingestellten 70 Prozent.
function modelEquityBase(unit: SimUnit, p: SimParams): number {
  const n = equityNeeded(unit, p, p.refinanceLtv)
  return Math.max(0, n.gross - n.loan)
}

// Groesstes Objekt, das mit dem verfuegbaren Kapital finanzierbar ist. Die
// einfache Formel Kapital/Eigenkapitalquote dient nur als Startwert; geprueft
// wird gegen die echte Engine, weil Nebenkosten, Moebel und MwSt mit haengen.
// Marktpreis des Modellobjekts im Kaufjahr. Wohnungen werden nicht billiger,
// waehrend der Bestand im Wert steigt - ein Kauf in fuenf Jahren kostet den
// heutigen Preis fortgeschrieben mit der Kaufpreissteigerung.
export function modelPriceAt(model: SimUnit, p: SimParams, year: number, baseYear: number): number {
  const g = purchaseGrowthOf(p) / 100
  const n = Math.max(0, year - baseYear)
  return round(model.priceNet * Math.pow(1 + g, n) / 1000) * 1000
}

// Kapitalbedarf eines Kaufs im Jahr `year`: Preis hochgerechnet, Miete mit der
// Mietsteigerung fortgeschrieben, alles Weitere (Nebenkosten, MwSt, Moebel,
// Darlehen, Eigenkapital) aus der Engine. Fuer Anzeige und Tests - der Motor
// selbst rechnet ueber dieselben Bausteine.
export interface PurchaseQuote { year: number; price: number; gross: number; loan: number; equity: number; costs: number; rent: number }
export function futurePurchaseQuote(model: SimUnit, p: SimParams, year: number, baseYear: number): PurchaseQuote {
  const price = modelPriceAt(model, p, year, baseYear)
  const rentFactor = Math.pow(1 + p.rentGrowth / 100, Math.max(0, year - baseYear))
  const unit = modelAt(model, price, year, 0, rentFactor, p.reinvestConstructionMonths)
  const need = equityNeeded(unit, p, p.refinanceLtv)
  return { year, price: unit.priceNet, gross: need.gross, loan: need.loan, equity: need.equity, costs: need.costs, rent: unit.rent }
}

export function maxAffordablePrice(model: SimUnit, p: SimParams, capital: number, year: number, rentFactor = 1): number {
  const ltv = p.refinanceLtv
  if (capital <= 0) return 0
  let lo = 0, hi = Math.max(100000, capital / Math.max(0.05, (100 - ltv) / 100) * 2)
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2
    const need = equityNeeded(modelAt(model, mid, year, 0, rentFactor, p.reinvestConstructionMonths), p, ltv).equity
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
  // Lebenslanger Freibetrag der Veraeusserungsgewinnsteuer: je Person einmal,
  // ueber ALLE Verkaufsjahre hinweg verbraucht - nicht je Wohnung und nicht
  // jedes Jahr neu.
  let exemptionLeft = CY_CGT_ALLOWANCE * personsOf(p.buyerStructure)
  // Startkasse: Was vom Eigenkapital nach den ersten Kaeufen uebrig bleibt.
  // Ohne diese Zeile wuerde der Motor so tun, als haette der Kunde ausser den
  // Wohnungen keinen Cent - und ein negativer Cashflow liefe sofort ins Minus.
  let cash = Math.max(0, p.ek - outcomes.reduce((a, o) => a + o.ekUsed, 0))
  // Eigenkapitalanteil der noch offenen Bautraegerraten, je Jahr. Ein Kauf ist
  // eine Verpflichtung ueber die ganze Bauzeit, keine einmalige Zahlung: Wer im
  // Januar 2027 unterschreibt, zahlt bis zur Uebergabe Mitte 2028 in Raten.
  // Frueher zog der Motor das gesamte Eigenkapital im Kaufjahr ab.
  const pendingEquity = new Map<number, number>()
  let investorTotal = 0
  let breakYear: number | null = null
  let breakReason: string | null = null
  let purchases = 0, refis = 0
  let recycled = 0, refiProceeds = 0, saleProceedsTotal = 0
  // Wie viel von den Zukaeufen aus neuen Krediten stammt - die Gegenzahl zum
  // wiederverwendeten Eigenkapital.
  let borrowedForPurchase = 0
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
    // Operativer Cashflow und Mehrwertsteuer-Erstattung getrennt fuehren: die
    // Erstattung ist ein einmaliges Kapitalereignis, kein laufender Ertrag.
    // Stand VOR einem Kauf dieses Jahres. Kommt es zu einem Kauf, wird die
    // Differenz weiter unten nachgebucht - die neue Wohnung wird im Januar
    // gekauft und traegt damit ein volles Jahr Miete, Kosten und Annuitaet.
    let operating = row ? row.operating : 0
    let vatIn = row ? row.vat : 0
    // Zusaetzliches Eigenkapital des Investors, nur im Wachstumsmodus.
    const investorIn = p.selfFundingOnly ? 0 : Math.max(0, p.additionalEquityMonthly) * 12
    investorTotal += investorIn
    // Faellige Raten frueherer Kaeufe: Sie belasten die Kasse in dem Jahr, in
    // dem sie wirklich anfallen, nicht im Jahr der Unterschrift.
    const dueThisYear = pendingEquity.get(y) ?? 0
    pendingEquity.delete(y)
    let equityOutThisYear = dueThisYear
    cash += operating + vatIn + investorIn - dueThisYear

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
      // Nur uebergebene Wohnungen sind beleihbar. Eine Wohnung im Bau taugt
      // nicht als Sicherheit, egal wie viele Raten schon bezahlt sind.
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
    const rentFactor = Math.pow(1 + p.rentGrowth / 100, Math.max(0, y - firstYear))
    const modelPrice = model ? modelPriceAt(model, p, y, firstYear) : 0
    const capitalWithoutRefi = Math.max(0, cash - p.minimumCashReserve)
    const capitalWithRefi = Math.max(0, cash + capacity - p.minimumCashReserve)
    const maxPrice = model ? maxAffordablePrice(model, p, capitalWithRefi, y, rentFactor) : 0
    const needForModel = model ? equityNeeded(modelAt(model, modelPrice, y, purchases + 1, rentFactor, p.reinvestConstructionMonths), p, p.refinanceLtv).equity : 0
    const affordable = !!model && y < lastYear && purchases < p.maxAdditionalPurchases
      && needForModel > 0 && capitalWithRefi + MONEY_TOLERANCE >= needForModel
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
      const unit = modelAt(model, modelPrice, y, idx, rentFactor, p.reinvestConstructionMonths)
      const need = equityNeeded(unit, p, p.refinanceLtv)
      // Die neue Wohnung kostet im Kaufjahr nicht nur das Eigenkapital, sondern
      // traegt ab Januar auch Annuitaet und laufende Kosten. Wie gross dieser
      // Erstjahresbedarf ist, weiss man erst, wenn die neue Tranche steht - und
      // jeder zusaetzlich gezogene Euro erhoeht ihn wieder ein wenig. Deshalb
      // wird der Fehlbetrag gemessen und die Beschaffung wiederholt; die Reihe
      // konvergiert schnell (typisch 2.400 auf 140 auf 8 Euro). Die
      // Beleihungsgrenze bleibt unangetastet: Reicht die Kapazitaet nicht oder
      // konvergiert es nicht, faellt der Kauf aus.
      const MAX_FUNDING_ROUNDS = 6
      let extraNeed = 0
      let bought = false
      for (let attempt = 0; attempt < MAX_FUNDING_ROUNDS && !bought; attempt++) {
      const target = need.equity + extraNeed
      // Zuerst vorhandenes Geld, dann refinanzieren - nur so viel wie noetig.
      const fromCash = Math.min(capitalWithoutRefi, target)
      const missing = Math.max(0, target - fromCash)
      let fromRefi = 0
      if (missing > 0 && capacity > 0) {
        let rest = Math.min(missing, capacity)
        // Die Wohnung mit dem groessten freien Spielraum zuerst. Frueher lief
        // die Liste in Portfolio-Reihenfolge durch und nahm die erste, die
        // genug hergab - dadurch lagen alle Refinanzierungen auf derselben
        // Wohnung, auch wenn andere laengst mehr Luft hatten (Sven 9.9.26).
        const byRoom = [...perUnit].sort((a, b) => b.usable - a.usable)
        for (const pu of byRoom) {
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
        .concat(probeUnits.filter(u => u.model).map(u => runUnit(u, modelEquityBase(u, p), p)))
      const probeRows = aggregate(probeOutcomes, p, { tranches, saleYears, untilYear: lastYear }).rows
      // Das Kaufjahr selbst gehoert in die Pruefung: Die neue Wohnung und die
      // neue Tranche kosten ab Januar Geld. Frueher startete die Probe erst im
      // Folgejahr, dadurch fehlte der Erstjahresbeitrag in der Kasse und die
      // Kasse landete in jedem Kaufjahr punktgenau auf der Mindestreserve.
      const probeRowY = probeRows.find(pr => pr.year === y)
      const deltaOperating = (probeRowY ? probeRowY.operating : operating) - operating
      const deltaVat = (probeRowY ? probeRowY.vat : vatIn) - vatIn
      let probeCash = cash - need.equity + deltaOperating + deltaVat
      // Festhalten: probeCash laeuft in der Folgejahrschleife weiter, fuer die
      // Begruendung und den zweiten Anlauf braucht es den Stand im Kaufjahr.
      const probeCashAtBuy = probeCash
      let sustainable = probeCash >= p.minimumCashReserve - MONEY_TOLERANCE
      const yearlyInvestor = p.selfFundingOnly ? 0 : Math.max(0, p.additionalEquityMonthly) * 12
      if (sustainable) {
        for (const pr of probeRows) {
          if (pr.year <= y) continue
          // Kuenftige Einzahlungen des Investors zaehlen mit - im
          // selbsttragenden Modus ist dieser Betrag null.
          probeCash += pr.cashflow + yearlyInvestor
          // Kuenftige Verkaufserloese entlasten die Kasse wieder.
          for (const o of probeOutcomes) {
            if (saleYears.get(o.unit.key) === pr.year) {
              probeCash += computeSale(o, pr.year, p, exemptionLeft, tranches).netProceeds
            }
          }
          if (probeCash < p.minimumCashReserve - MONEY_TOLERANCE) { sustainable = false; break }
        }
      }
      if (funded + MONEY_TOLERANCE >= need.equity && sustainable) {
        bought = true
        // Eigenkapital nach Faelligkeit verteilen. Der Anteil des Investors an
        // jeder Rate ist gleich, die Bank traegt den Rest; die Nebenkosten
        // werden bei Uebergabe faellig.
        const probe = probeOutcomes.find(o => o.unit.key === unit.key)
        const share = need.gross > 0 ? (need.gross - need.loan) / need.gross : 1
        let thisYear = 0
        if (probe) {
          for (const pay of probe.payments) {
            const py = Math.floor(pay.ym / 12)
            const part = pay.amount * share
            if (py <= y) thisYear += part
            else pendingEquity.set(py, (pendingEquity.get(py) ?? 0) + part)
          }
          const cy = probe.unit.readyY
          if (cy <= y) thisYear += need.costs
          else pendingEquity.set(cy, (pendingEquity.get(cy) ?? 0) + need.costs)
        } else thisYear = need.equity
        cash -= thisYear
        equityOutThisYear += thisYear
        // Erstjahresbeitrag der neuen Wohnung und der neuen Tranche nachbuchen.
        cash += deltaOperating + deltaVat
        operating += deltaOperating
        vatIn += deltaVat
        purchases++
        // Wiederverwendetes Kapital = das gesamte Eigenkapital, das nach dem
        // Start erneut in eine Immobilie geflossen ist - egal ob es aus einer
        // Refinanzierung, aus einem Verkauf oder aus dem laufenden Ueberschuss
        // stammt. Die frueher engere Zaehlung (nur Refinanzierung) ergab 0,
        // sobald ein Kauf aus der Kasse bezahlt wurde, obwohl der Kunde sichtbar
        // weitere Wohnungen bekam (Befund 5.9.26).
        // Wiederverwendetes Eigenkapital ist NUR Geld, das dem Investor schon
        // gehoerte: Ueberschuesse, Mehrwertsteuer-Erstattungen, Verkaufserloese.
        // Der Teil, der aus einer Refinanzierung stammt, ist neue Schuld und
        // zaehlt hier nicht mit (Sven 9.9.26). Frueher stand hier das gesamte
        // Eigenkapital jedes Zukaufs, also auch die Kreditbetraege.
        recycled += Math.max(0, thisYear - fromRefi)
        borrowedForPurchase += fromRefi
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
        // Erster Anlauf gescheitert, weil im Kaufjahr Geld fehlt? Dann den
        // Fehlbetrag messen und mit hoeherem Ziel noch einmal beschaffen.
        const gapY = p.minimumCashReserve - probeCashAtBuy
        if (attempt < MAX_FUNDING_ROUNDS - 1 && funded + MONEY_TOLERANCE >= need.equity
          && gapY > MONEY_TOLERANCE && extraNeed + gapY < capacity) {
          extraNeed = Math.ceil(extraNeed + gapY)
          continue
        }
        const opp = opportunities[opportunities.length - 1]
        opp.affordable = false
        opp.reason = funded + MONEY_TOLERANCE < need.equity
          ? 'verfügbares Kapital reicht nicht für das Modellobjekt'
          : probeCashAtBuy < p.minimumCashReserve - MONEY_TOLERANCE
            ? 'Mindestliquidität wäre schon im Kaufjahr unterschritten'
            : 'Mindestliquidität würde in einem der Folgejahre unterschritten'
      }
      }
    }

    // Selbsttragend heisst: nach dem Startkapital kein weiteres Geld des
    // Investors UND die Mindestreserve zu JEDEM Zeitpunkt gehalten. Eine
    // spaetere Mehrwertsteuer-Erstattung repariert eine Luecke nicht
    // rueckwirkend - wer 2041 nicht zahlen kann, ist 2041 zahlungsunfaehig
    // (Sven 9.9.26). Frueher schlug das erst bei einer negativen Kasse an.
    if (breakYear == null && cash < p.minimumCashReserve - MONEY_TOLERANCE) {
      breakYear = y
      breakReason = cash < 0
        ? 'Die Liquidität reicht ohne zusätzliches Eigenkapital nicht aus.'
        : 'Die Liquidität fällt unter die vereinbarte Mindestreserve.'
    }
    flows.push({
      year: y,
      startingCash: round(startingCash),
      operatingCashflow: round(operating),
      vatRefund: round(vatIn),
      investorEquity: round(investorIn),
      refinancingProceeds: round(events.filter(e => e.kind === 'refinance' && e.year === y).reduce((a, e) => a + (e as RefinanceEvent).newLoanAmount, 0)),
      saleProceeds: round(saleIn),
      // Was in DIESEM Jahr wirklich an Eigenkapital abgeflossen ist: die
      // faelligen Raten frueherer Kaeufe plus der Anteil eines neuen Kaufs.
      purchaseEquity: round(equityOutThisYear),
      purchaseCosts: 0,
      endingCash: round(cash),
    })
  }

  // Abschliessende Rechnung mit dem fertigen Zustand.
  const agg = aggregate(outcomes, p, { tranches, saleYears, untilYear: lastYear })
  rows = agg.rows
  const years0 = rows
  const totalsBase = totalsOf(outcomes, rows, p, null)

  // ── Rendite aus Sicht des Investors ───────────────────────────────────────
  // Im Reinvestment-Modus bleibt jeder Euro in der Strategie: Mieten wandern in
  // die Kasse und von dort in die naechste Wohnung. Ausgezahlt wird nichts.
  // Deshalb ist die ehrliche Sicht: der Investor zahlt sein Startkapital ein,
  // legt gegebenenfalls monatlich nach, und bekommt am Ende das, was da ist -
  // Immobilien abzueglich Schulden, gebundenes Kapital und die Kasse.
  // Die laufenden Cashflows als Zufluss zu zaehlen UND die daraus entstandene
  // Kasse noch einmal am Ende, waere doppelt.
  const lastRowForIrr = rows[rows.length - 1]
  const endWorth = lastRowForIrr
    ? lastRowForIrr.value + lastRowForIrr.committed - lastRowForIrr.debt + cash
    : cash
  const investorFlows: number[] = rows.map((r, i) => {
    const put = i === 0 ? p.ek : 0
    const add = flows.find(fl => fl.year === r.year)?.investorEquity ?? 0
    return -(put + add)
  })
  if (investorFlows.length) investorFlows[investorFlows.length - 1] += endWorth
  const totals: StrategyTotals = { ...totalsBase, irr: irrCalc(investorFlows) }

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
  // Ab wann traegt sich das Portfolio operativ selbst?
  const firstPositive = years0.find(y => y.rents > 0 && y.operating > 0)
  const kpis: ReinvestKpis = {
    startingEquity: originalEquity,
    investorContributions: round(investorTotal),
    totalInvestorCapital: round(originalEquity + investorTotal),
    selfFunding: p.selfFundingOnly,
    // Der Modus sagt, was gewollt ist. selfSupporting sagt, ob es aufgeht.
    // Beides zu verwechseln war der Grund, warum die Kundenseite
    // "selbsttragend" meldete, obwohl die Reserve dreimal unterschritten war.
    selfSupporting: breakYear == null,
    selfFundingBreaks: breakYear,
    selfFundingReason: breakReason,
    operatingPositiveFrom: firstPositive ? firstPositive.year : null,
    additionalPurchases: purchases,
    refinancings: refis,
    sales: sales.length,
    totalRefinancingProceeds: round(refiProceeds),
    totalSaleProceeds: round(saleProceedsTotal),
    // Wiederverwendet = Eigenkapital des Investors, das nach dem Start erneut
    // in eine Immobilie geflossen ist: Mietueberschuesse,
    // Mehrwertsteuer-Erstattungen, Verkaufserloese. NICHT dabei ist Geld aus
    // Refinanzierungen - das ist neue Schuld und steht in
    // totalBorrowedForPurchases. Das ist KEINE Rendite.
    totalRecycledCapital: round(recycled),
    totalBorrowedForPurchases: round(borrowedForPurchase),
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

  // ── Lebenslauf je Wohnung ─────────────────────────────────────────────────
  const refiEvents = events.filter((e): e is RefinanceEvent => e.kind === 'refinance')
  const unitTimeline: UnitTimeline[] = outcomes.map(o => {
    const u = o.unit
    const mine = refiEvents.filter(e => e.propertyKeys.includes(u.key))
    return {
      key: u.key,
      name: u.name,
      model: !!u.model,
      purchaseYear: u.buyY,
      purchaseMonth: u.buyM,
      handoverYear: u.readyY,
      handoverMonth: u.readyM,
      constructionMonths: Math.max(0, (u.readyY * 12 + u.readyM) - (u.buyY * 12 + u.buyM)),
      // Beleihbar ab dem Uebergabejahr - identisch mit der Bedingung, nach der
      // die Kapazitaetsrechnung oben eine Wohnung beruecksichtigt.
      pledgeableFrom: u.readyY,
      firstRefinanceYear: mine.length ? Math.min(...mine.map(e => e.year)) : null,
      refinancings: mine.length,
      totalRefinanced: round(mine.reduce((a, e) => a + e.newLoanAmount, 0)),
    }
  })

  return {
    units: allUnits, outcomes, rows, years, events, tranches, flows, opportunities,
    sales, saleYears, totals, kpis, firstYear, lastYear, modelUnit: model, unitTimeline,
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
