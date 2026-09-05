import {
  DEFAULT_PARAMS, compute, defaultMgmtPct, seasonBreakdown, vatSplit, cyTax,
  CY_CORP_TAX_PCT, DE_DIV_TAX_PCT, CY_DIV_TAX_PCT, CY_GESY_RATE, CY_GESY_CAP, CY_LOSS_CARRY_YEARS,
  type CalcParams, type CalcResult,
} from './rechner'

// ── Strategie-Rechnung (gemeinsame Logik) ────────────────────────────────────
// Wird vom CRM-Simulator UND von der öffentlichen Kundenseite /strategie/:token
// benutzt — beide rechnen damit garantiert dieselben Zahlen.
//
// Aufbau: JEDE Wohnung läuft durch die verifizierte Rechner-Engine (rechner.ts),
// verankert am ÜBERGABE-Datum (ab da Miete, Annuität, Steuern, MwSt-Erstattung) —
// identisch zur Einzelrechnung, die der Kunde bekommt. Die Strategie-Schicht legt
// nur die Zeitachse darüber: Kaufraten vor der Übergabe und die Verteilung des
// Eigenkapitals über mehrere Käufe (Bundlekauf).

export interface SimUnit {
  key: string
  name: string
  priceNet: number            // Listenpreis netto (Engine rechnet MwSt/brutto)
  furnNet: number             // Möbelpaket netto
  rent: number                // Miete/Monat → Engine-Bruttorendite
  letType: 'short' | 'long'   // Kurzzeit (MwSt-Erstattung) / Langzeit
  fin: boolean                // Annuitätendarlehen ja/nein
  buyM: number; buyY: number      // Kauf Monat/Jahr
  readyM: number; readyY: number  // Übergabe Monat/Jahr (= Mietstart)
  plan: 'sofort' | 'luma'
  // Gemeinschaftskosten dieser Wohnung (EUR/Monat). Leer = globaler Vorgabewert.
  opex?: number | null
  // Feineinstellungen aus der EINZELBERECHNUNG dieser Wohnung (Verwaltung,
  // Hotelkonzept, Saisonmodell, Rendite, Zins …). Sven 15.8.: „Der
  // Strategierechner muss auf die Daten zugreifen, die ich vorher in der
  // Einzelberechnung eingegeben habe." Ohne das rechnete die Strategie mit
  // Standardwerten - v.a. 2 % Verwaltung statt real 25-40 % bei Kurzzeit.
  calc?: Partial<CalcParams>
}

export interface SimParams {
  ek: number; growth: number; interest: number; termYears: number
  rentGrowth: number; deTaxPct: number; bundle: boolean
  // ── Besteuerung (Sven 4.9.26) ─────────────────────────────────────────────
  // Gilt fuer den GANZEN Plan, nicht je Wohnung: wo der Kunde steuerlich sitzt
  // und ob er privat oder ueber eine zyprische Ltd haelt. Vorher rechnete der
  // Simulator immer „privat, Steuersitz Deutschland" - Zypern war gar nicht
  // eingebbar.
  res: 'de' | 'cy'          // Steuersitz des Kunden
  cyBI: number              // vorhandenes zyprisches Einkommen (Progression)
  holder: 'privat' | 'firma'
  corpTaxPct: number        // Koerperschaftsteuer Zypern %
  divPayoutPct: number      // Anteil des Gewinns, der ausgeschuettet wird %
  divTaxPct: number         // Steuer beim Gesellschafter auf die Ausschuettung %
  gesy: boolean             // GESY 2,65 % (nur privat + Steuersitz Zypern)
  // ── Laufende Kosten (Sven 5.9.26) ─────────────────────────────────────────
  opexMonthly: number       // Gemeinschaftskosten je Wohnung, EUR/Monat (Vorgabe)
  maintPct: number          // Instandhaltungsruecklage % p.a. vom Kaufpreis
}

export interface UnitOutcome {
  unit: SimUnit; res: CalcResult; ekUsed: number; loan: number
  gross: number; payments: Array<{ ym: number; amount: number; label: string }>
}

export interface YearRow {
  year: number; rents: number; mgmt: number; interest: number; principal: number
  taxes: number; vat: number; cashflow: number; invest: number; debt: number; value: number
  // Aufteilung der Steuerlast: bei privat = zyprische Steuer (inkl. GESY) und
  // deutsche Steuer nach Anrechnung; bei Firma = Koerperschaftsteuer und Steuer
  // auf die Ausschuettung. gesy ist in taxCY bereits enthalten.
  taxCY: number; taxDE: number; gesy: number
  // Laufende Kosten der Wohnungen (Gemeinschaftskosten + Instandhaltungsruecklage)
  opex: number
  // Steuerliche Bemessungsgrundlagen ALLER Wohnungen dieses Jahres, aus denen
  // die Steuer fuer die Person/Gesellschaft als Ganzes gerechnet wird.
  baseCY: number; baseDE: number
  // Summe der wohnungsweise gerechneten Steuer aus der Engine. Wird beim
  // Umstieg auf die gemeinsame Steuer wieder herausgerechnet.
  unitTax: number
  // Bauphase: bereits gezahlte Kaufraten von Wohnungen, die noch nicht übergeben
  // sind. Dieses Geld ist NICHT weg, sondern in der Immobilie gebunden - ohne
  // diese Position sähe es im Vermögensverlauf aus, als würde Kapital
  // verschwinden (Svens Frage 15.8.: „Warum geht das erst so massiv runter?").
  committed: number
  // Zwischenfinanzierung während der Bauzeit: Sobald die Kaufraten das
  // Eigenkapital übersteigen, braucht der Kunde SOFORT Geld von der Bank - nicht
  // erst bei der Übergabe. Diese Zinsen fielen vorher komplett unter den Tisch
  // (Sven 15.8.: „2027 haben wir alle Kredite genommen, 2028 müsste die höchste
  // Zinslast sein"). bridgeDebt = offener Zwischenkredit am Jahresende.
  bridgeInterest: number
  bridgeDebt: number
}

export interface StrategyConfig { unitsV2?: SimUnit[]; paramsV2?: SimParams; units?: LegacyUnit[]; params?: LegacyParams }

// ── Altbestand (v1) ──────────────────────────────────────────────────────────
// Die erste Simulator-Fassung speicherte Bruttopreise, MwSt-Wahl und Monats-
// ABSTÄNDE statt Datumsangaben. Solche Stände liegen noch in der Datenbank und
// entstehen sogar neu, solange irgendwo ein alter Browser-Tab offen ist (der
// speichert im Altformat weiter). Ohne Umrechnung stünde der Kunde vor einer
// leeren Seite - deshalb lesen beide Ansichten v1 mit.
interface LegacyUnit {
  key: string; name: string; price?: number; vat?: number; netBase?: number | null
  rent?: number; buyM?: number; readyM?: number; plan?: 'sofort' | 'luma'; mortgage?: boolean
}
interface LegacyParams { ek?: number; growth?: number; ltv?: number; interest?: number; rentGrowth?: number; bundle?: boolean }

export function migrateConfig(cfg: StrategyConfig | null | undefined): { units: SimUnit[]; params: SimParams } {
  if (cfg?.unitsV2?.length) {
    const saved = cfg.paramsV2 ?? {}
    // Alte Szenarien kannten keinen Steuersitz - dort stand er (wenn ueberhaupt)
    // in der Einzelberechnung der Wohnung. Den uebernehmen, sonst Deutschland.
    const resFromUnits = cfg.unitsV2.some(u => u.calc?.res === 'cy') ? 'cy' : 'de'
    return { units: cfg.unitsV2, params: { ...DEFAULT_SIM_PARAMS, res: resFromUnits, ...saved } }
  }
  const now = new Date()
  const baseYm = now.getFullYear() * 12 + now.getMonth()   // 0-basierter Monat
  const fromOffset = (off: number) => {
    const ym = baseYm + Math.max(0, Math.round(off || 0))
    return { m: (ym % 12) + 1, y: Math.floor(ym / 12) }
  }
  const units: SimUnit[] = (cfg?.units ?? []).map(u => {
    const vat = u.vat === 19 ? 19 : 5
    // netBase = netto inkl. Möbel; sonst aus dem Bruttopreis zurückrechnen.
    const net = u.netBase && u.netBase > 0 ? u.netBase : Math.round((u.price ?? 0) / (1 + vat / 100))
    const buy = fromOffset(u.buyM ?? 0), ready = fromOffset(u.readyM ?? 24)
    return {
      key: u.key, name: u.name,
      priceNet: net, furnNet: 0,          // Möbel steckten in v1 im Gesamtpreis
      rent: u.rent ?? 0,
      letType: 'short', fin: true,        // v1 kannte beides nicht → Standardfall
      buyM: buy.m, buyY: buy.y, readyM: ready.m, readyY: ready.y,
      plan: u.plan === 'sofort' ? 'sofort' : 'luma',
    }
  })
  const lp = cfg?.params ?? {}
  return {
    units,
    params: {
      ...DEFAULT_SIM_PARAMS,
      ek: lp.ek ?? DEFAULT_SIM_PARAMS.ek,
      growth: lp.growth ?? DEFAULT_SIM_PARAMS.growth,
      interest: lp.interest ?? DEFAULT_SIM_PARAMS.interest,
      rentGrowth: lp.rentGrowth ?? DEFAULT_SIM_PARAMS.rentGrowth,
      bundle: lp.bundle ?? DEFAULT_SIM_PARAMS.bundle,
    },
  }
}

export const DEFAULT_SIM_PARAMS: SimParams = {
  ek: 350000, growth: 5, interest: 4.1, termYears: 20, rentGrowth: 2, deTaxPct: 42, bundle: true,
  res: 'de', cyBI: 0, holder: 'privat',
  corpTaxPct: CY_CORP_TAX_PCT, divPayoutPct: 100, divTaxPct: DE_DIV_TAX_PCT, gesy: true,
  opexMonthly: 100, maintPct: 0.75,
}

// Sinnvoller Vorschlag fuer die Steuer auf die Ausschuettung: der deutsche
// Gesellschafter zahlt Abgeltungsteuer + Soli, der zyprische Non-Dom nur GESY.
export function defaultDivTaxPct(res: 'de' | 'cy'): number {
  return res === 'cy' ? CY_DIV_TAX_PCT : DE_DIV_TAX_PCT
}

export const ymOf = (y: number, m: number) => y * 12 + (m - 1)

// Planungshorizont der Strategie in Jahren, ab dem ersten Kaufjahr.
export const HORIZON_YEARS = 10

// Monatsmiete aus dem Saisonmodell (Auslastung + Preis/Nacht je Saison).
// WICHTIG: Ist ein Saisonmodell gesetzt, rechnet die Engine IMMER damit und
// ignoriert eine abweichend eingetippte Miete. Damit Anzeige und Rechnung nicht
// auseinanderlaufen, wird die Miete daraus abgeleitet, sobald ein Modell
// übernommen wird.
export function rentFromSeason(season: { totalOcc: number; adrHigh: number } | null | undefined): number | null {
  if (!season || !(season.totalOcc > 0) || !(season.adrHigh > 0)) return null
  return Math.round(seasonBreakdown(season).rent / 12)
}

export function paymentPlan(u: SimUnit, gross: number): Array<{ ym: number; amount: number; label: string }> {
  const buy = ymOf(u.buyY, u.buyM), ready = Math.max(buy, ymOf(u.readyY, u.readyM))
  if (u.plan === 'sofort') return [{ ym: buy, amount: gross, label: 'Kaufpreis komplett' }]
  const span = Math.max(1, ready - buy)
  return [
    { ym: buy, amount: 10000, label: 'Reservierung' },
    { ym: buy, amount: gross * 0.35 - 10000, label: '35 % bei Vertrag' },
    { ym: Math.round(buy + span * 0.33), amount: gross * 0.20, label: '2. Rate 20 %' },
    { ym: Math.round(buy + span * 0.62), amount: gross * 0.20, label: '3. Rate 20 %' },
    { ym: Math.round(buy + span * 0.85), amount: gross * 0.15, label: '4. Rate 15 %' },
    { ym: ready, amount: gross * 0.10, label: '10 % bei Übergabe' },
  ]
}

export function runUnit(u: SimUnit, ekForUnit: number, p: SimParams): UnitOutcome {
  const fromCalc = u.calc ?? {}
  // Hotelkonzept + Saisonmodell nur bei Kurzzeit; Verwaltung: Wert aus der
  // Einzelberechnung, sonst der fachliche Standard der Vermietungsart.
  const hotel = u.letType === 'short' ? !!fromCalc.hotelConcept : false
  const season = u.letType === 'short' ? (fromCalc.season ?? null) : null
  const params: CalcParams = {
    ...DEFAULT_PARAMS,
    ...fromCalc,                                   // Einzelberechnung als Basis
    month: u.readyM, year: u.readyY, dealType: 'single',
    priceNet: u.priceNet, discountPct: 0,
    bedrooms: fromCalc.bedrooms ?? 2,
    fin: u.fin ? 'yes' : 'no', letType: u.letType, mode: 'ann',
    // Steuersitz und Halte-Struktur setzt IMMER die Strategie: sie gelten fuer
    // den Kunden, nicht je Wohnung (die Einzelberechnung kann hier nicht
    // gewinnen, sonst rechnete eine Wohnung DE und die naechste CY).
    res: p.res, cyBI: p.cyBI, holder: p.holder,
    corpTaxPct: p.corpTaxPct, divPayoutPct: p.divPayoutPct, divTaxPct: p.divTaxPct,
    gesy: p.res === 'cy' && p.holder === 'privat' ? p.gesy : false,
    hotelConcept: hotel, season,
    mgmtPct: fromCalc.mgmtPct ?? defaultMgmtPct(u.letType, hotel),
    equity: ekForUnit,
    // Miete kommt aus dem Simulator (monatlich) → als Bruttorendite an die Engine.
    // Brutto nach der MwSt-Regelung der Einzelberechnung (Sven waehlt sie manuell) -
    // sonst rechnete die Strategie mit 19 %, die Einzelrechnung aber mit 5/19 gemischt.
    yieldPct: u.priceNet > 0 ? (u.rent * 12) / vatSplit(u.priceNet, fromCalc.vatMode, fromCalc.livingSqm).gross * 100 : 0,
    // Zeitachsen-Parameter setzt IMMER die Strategie (gelten über alle Wohnungen)
    rentGrowth: p.rentGrowth, interestPct: p.interest, termYears: p.termYears,
    appreciationPct: p.growth, deTaxPct: p.deTaxPct,
    furnCost: u.furnNet, furnFree: false,
    // Laufende Kosten der Wohnung: Gemeinschaftskosten je Wohnung (sonst der
    // globale Vorgabewert), Ruecklage einheitlich als Prozentsatz.
    opexMonthly: u.opex ?? p.opexMonthly, maintPct: p.maintPct,
    mgmtMode: fromCalc.mgmtMode ?? 'pct', mgmtFix: fromCalc.mgmtFix ?? 0,
  }
  const res = compute(params)
  const gross = res.pGross + res.furnGross
  return { unit: u, res, ekUsed: res.ekStart, loan: res.loan, gross, payments: paymentPlan(u, gross) }
}

// Bundlekauf: EK in ÜBERGABE-Reihenfolge verteilen (die zuerst fertige Wohnung
// wird zuerst bedient); ohne Bundle bekommt jede Wohnung denselben EK-Anteil.
export function allocate(units: SimUnit[], p: SimParams): UnitOutcome[] {
  const order = [...units].sort((a, b) => ymOf(a.readyY, a.readyM) - ymOf(b.readyY, b.readyM))
  let pool = p.ek
  const out = new Map<string, UnitOutcome>()
  for (const u of order) {
    const probe = runUnit(u, 0, p)
    const ekForUnit = p.bundle ? Math.min(pool, probe.gross) : Math.min(p.ek / Math.max(1, units.length), probe.gross)
    pool -= ekForUnit
    out.set(u.key, u.fin ? runUnit(u, ekForUnit, p) : runUnit(u, probe.gross, p))
  }
  return units.map(u => out.get(u.key)!)
}

// ── Steuer ueber ALLE Wohnungen zusammen ─────────────────────────────────────
// Der zyprische Freibetrag von 22.000 EUR und die Progression gelten pro PERSON,
// nicht pro Wohnung. Die Engine rechnet je Wohnung - wuerde man ihre Steuer
// einfach addieren, bekaeme jede Wohnung ihren eigenen Freibetrag (drei Wohnungen
// mit zusammen 33.228 EUR Gewinn ergaben so 0 statt 2.307 EUR Steuer im Jahr).
// Deshalb liefert die Engine nur noch die Bemessungsgrundlagen; die Steuer
// entsteht hier, einmal je Kalenderjahr fuer den ganzen Kunden.
//
// Die Bauzeitzinsen der Zwischenfinanzierung mindern die Bemessungsgrundlage wie
// jede andere Zinslast.
function applyPortfolioTax(rows: YearRow[], p: SimParams): void {
  // Verlustvortrag der Gesellschaft, 5 Jahre (Zypern), portfolioweit.
  const open: Array<{ i: number; amt: number }> = []
  rows.forEach((r, idx) => {
    const baseCY = r.baseCY - r.bridgeInterest
    const baseDE = r.baseDE - r.bridgeInterest
    let taxCY = 0, taxDE = 0, gesy = 0

    if (p.holder === 'firma') {
      let rest = baseCY
      if (rest <= 0) { open.push({ i: idx, amt: -rest }); rest = 0 }
      else {
        for (const l of open) {
          if (idx - l.i > CY_LOSS_CARRY_YEARS || l.amt <= 0) continue
          const use = Math.min(l.amt, rest); l.amt -= use; rest -= use
          if (rest <= 0) break
        }
      }
      taxCY = Math.max(0, Math.round(rest * p.corpTaxPct / 100))
      const afterTax = baseCY - taxCY
      taxDE = afterTax > 0
        ? Math.round(afterTax * (p.divPayoutPct / 100) * (p.divTaxPct / 100))
        : 0
    } else if (p.res === 'cy') {
      const inc = Math.max(0, baseCY)
      // Bestandseinkommen hebt die Progression - einmal fuer den Kunden, nicht je Wohnung.
      taxCY = Math.max(0, cyTax(p.cyBI + inc) - cyTax(p.cyBI))
      gesy = p.gesy ? Math.round(Math.min(r.rents, CY_GESY_CAP) * CY_GESY_RATE) : 0
      taxCY += gesy
    } else {
      // Steuersitz Deutschland: Zypern besteuert zuerst, Deutschland rechnet die
      // zyprische Steuer an. Die Gesamtlast ist die zyprische Steuer PLUS der
      // nicht angerechnete deutsche Rest - nicht nur der deutsche Rest.
      const cy = cyTax(Math.max(0, baseCY))
      const de = Math.round(baseDE * (p.deTaxPct / 100))
      taxCY = cy
      taxDE = de <= 0 ? de : de - Math.min(cy, de)
    }

    const total = taxCY + taxDE
    // Die wohnungsweise Steuer der Engine wieder herausrechnen und durch die
    // gemeinsame ersetzen; der Cashflow zieht damit die richtige Last ab.
    r.cashflow += r.unitTax - total
    r.taxes = total
    r.taxCY = taxCY
    r.taxDE = taxDE
    r.gesy = gesy
  })
}

export function aggregate(outcomes: UnitOutcome[], p?: SimParams): { rows: YearRow[]; firstYear: number; lastYear: number; bridgeNeeded: boolean; bridgePeak: number } {
  if (!outcomes.length) { const y = new Date().getFullYear(); return { rows: [], firstYear: y, lastYear: y, bridgeNeeded: false, bridgePeak: 0 } }
  const firstYear = Math.min(...outcomes.map(o => o.unit.buyY))
  // Zehn Jahre ab dem ERSTEN Kauf, hart (Sven 5.9.26): „Zeitraum endet nach 10
  // Jahren, auch wenn man eine Wohnung nach 8 Jahren kauft, laenger ist voellig
  // unrealistisch bei den vielen Variablen." Eine spaet gekaufte Wohnung wird
  // also nur mit ihren ersten Jahren gezeigt - das ist gewollt und ehrlicher als
  // ein Zeitraum, der sich mit jedem zusaetzlichen Kauf verschiebt.
  const lastYear = firstYear + HORIZON_YEARS - 1
  const rows: YearRow[] = []
  for (let y = firstYear; y <= lastYear; y++) {
    const row: YearRow = { year: y, rents: 0, mgmt: 0, interest: 0, principal: 0, taxes: 0, vat: 0, cashflow: 0, invest: 0, debt: 0, value: 0, committed: 0, bridgeInterest: 0, bridgeDebt: 0, taxCY: 0, taxDE: 0, gesy: 0, opex: 0, baseCY: 0, baseDE: 0, unitTax: 0 }
    for (const o of outcomes) {
      const i = y - o.unit.readyY
      // Noch nicht übergeben → bis hierher gezahlte Raten als gebundenes Kapital
      // führen (konservativ ohne Wertzuwachs). Ab Übergabe steht der volle
      // Immobilienwert aus der Engine, die Raten sind darin aufgegangen.
      if (i < 0) {
        for (const pay of o.payments) if (Math.floor(pay.ym / 12) <= y) row.committed += pay.amount
      }
      if (i >= 0 && i < 10) {
        row.rents += o.res.rents[i]; row.mgmt += o.res.mgmt[i]
        row.interest += o.res.intC[i]; row.principal += o.res.princC[i]
        row.taxes += o.res.taxU[i]; row.vat += o.res.vatA[i]; row.cashflow += o.res.cfA[i]
        row.taxCY += o.res.taxCY[i]; row.taxDE += o.res.taxDE[i]; row.gesy += o.res.gesyA[i]
        row.opex += o.res.opexA[i]
        row.baseCY += o.res.profitCY[i]; row.baseDE += o.res.profitDE[i]
        row.unitTax += o.res.taxU[i]
        row.debt += o.res.restL[i]; row.value += o.res.propV[i]
      } else if (i >= 10) {
        row.debt += o.res.restL[9]; row.value += o.res.propV[9]
      }
      for (const pay of o.payments) if (Math.floor(pay.ym / 12) === y) row.invest += pay.amount
    }
    rows.push(row)
  }

  // ── Zwischenfinanzierung in der Bauzeit ───────────────────────────────────
  // Monat für Monat: Was ist bis hier zu zahlen, und was ist gedeckt? Gedeckt
  // sind das Eigenkapital und die Enddarlehen der bereits ÜBERGEBENEN Wohnungen.
  // Alles darüber muss die Bank vorfinanzieren - darauf laufen Zinsen ab dem
  // Monat der Entstehung, nicht erst ab Übergabe.
  const ek = p?.ek ?? 0
  const iMon = (p?.interest ?? 0) / 100 / 12
  let bridgePeak = 0
  if (iMon > 0) {
    const pays = outcomes.flatMap(o => o.payments)
    const startYm = Math.min(...pays.map(x => x.ym))
    const endYm = ymOf(lastYear, 12)
    let paid = 0
    for (let ym = startYm; ym <= endYm; ym++) {
      paid += pays.filter(x => x.ym === ym).reduce((a, x) => a + x.amount, 0)
      // Enddarlehen stehen ab der Übergabe der jeweiligen Wohnung zur Verfügung
      const loansReady = outcomes
        .filter(o => ymOf(o.unit.readyY, o.unit.readyM) <= ym)
        .reduce((a, o) => a + o.loan, 0)
      const bridge = Math.max(0, paid - ek - loansReady)
      if (bridge > bridgePeak) bridgePeak = bridge
      const row = rows.find(r => r.year === Math.floor(ym / 12))
      if (row) {
        if (bridge > 0) row.bridgeInterest += bridge * iMon
        // IMMER setzen (auch 0): sonst bliebe der Höchststand aus der Bauzeit
        // stehen, obwohl das Enddarlehen die Zwischenfinanzierung bei der
        // Übergabe ablöst - die Restschuld wäre doppelt gezählt.
        row.bridgeDebt = bridge
      }
    }
    // Bauzeitzinsen zählen wie jede andere Zinslast: in die Zinsspalte, in den
    // Cashflow und in die Restschuld-Betrachtung.
    for (const r of rows) {
      if (!r.bridgeInterest) { r.bridgeDebt = 0; continue }
      r.interest += r.bridgeInterest
      r.cashflow -= r.bridgeInterest
      r.debt += r.bridgeDebt
    }
  }
  // Steuer zum Schluss: sie braucht die fertigen Bemessungsgrundlagen inklusive
  // der Bauzeitzinsen.
  if (p) applyPortfolioTax(rows, p)
  return { rows, firstYear, lastYear, bridgeNeeded: bridgePeak > 0.5, bridgePeak }
}

// Eigenkapital-Rendite ist nur aussagekräftig, wenn nennenswertes EK im Spiel
// ist: bei einer fast vollständig fremdfinanzierten Wohnung (Rest-EK nach der
// Bundle-Verteilung) laufen die Prozente ins Absurde (mehrere tausend Prozent).
// Solche Zahlen gehen NICHT an Kunden - dann lieber ehrlich nichts ausweisen.
export const MIN_EK_SHARE = 0.05
export function roeMeaningful(o: UnitOutcome): boolean {
  return o.gross > 0 && o.ekUsed / o.gross >= MIN_EK_SHARE
}

export interface StrategyTotals {
  ekTotal: number; netWorth: number; rents: number; taxes: number; vat: number
  taxCY: number; taxDE: number; gesy: number
  interest: number; cashflow: number; totalReturn: number; roe: number
  debtEnd: number          // offener Kredit am Ende des Zeitraums
  roe5: number; roe10: number   // Eigenkapital-Rendite nach 5 bzw. 10 Jahren
}

// Eigenkapital-Rendite zu einem Zeitpunkt: erwirtschaftetes Plus (Vermögen zum
// Stichtag + bis dahin geflossener Cashflow − eingesetztes Eigenkapital) bezogen
// auf das Eigenkapital. Kumuliert über den Zeitraum, NICHT p.a.
export function roeAfterYears(rows: YearRow[], ekTotal: number, years: number): number {
  if (!rows.length || ekTotal <= 0) return 0
  const target = rows[0].year + years
  let cash = 0, worth = 0, found = false
  for (const r of rows) {
    if (r.year > target) break
    cash += r.cashflow
    worth = r.value + r.committed - r.debt
    found = true
  }
  if (!found) return 0
  return ((worth + cash - ekTotal) / ekTotal) * 100
}

export function totalsOf(outcomes: UnitOutcome[], rows: YearRow[]): StrategyTotals {
  const sum = (f: (r: YearRow) => number) => rows.reduce((a, r) => a + f(r), 0)
  const ekTotal = outcomes.reduce((a, o) => a + o.ekUsed, 0)
  const last = rows[rows.length - 1]
  const netWorth = last ? last.value + last.committed - last.debt : 0
  const rents = sum(r => r.rents), taxes = sum(r => r.taxes), vat = sum(r => r.vat)
  const interest = sum(r => r.interest), cashflow = sum(r => r.cashflow)
  const totalReturn = netWorth - ekTotal + cashflow
  const roe = ekTotal > 0 ? (totalReturn / ekTotal) * 100 : 0
  const debtEnd = last ? last.debt : 0
  return {
    ekTotal, netWorth, rents, taxes, vat, interest, cashflow, totalReturn, roe, debtEnd,
    taxCY: sum(r => r.taxCY), taxDE: sum(r => r.taxDE), gesy: sum(r => r.gesy),
    roe5: roeAfterYears(rows, ekTotal, 5), roe10: roeAfterYears(rows, ekTotal, 10),
  }
}
