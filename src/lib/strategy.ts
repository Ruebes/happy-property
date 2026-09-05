import {
  DEFAULT_PARAMS, compute, defaultMgmtPct, seasonBreakdown, vatSplit, cyTax, irrCalc,
  CY_CORP_TAX_PCT, DE_DIV_TAX_PCT, CY_DIV_TAX_PCT, CY_GESY_RATE, CY_GESY_CAP, CY_LOSS_CARRY_YEARS,
  CY_SI_RATE, CY_SI_MIN_INCOME, CY_SI_MAX_INCOME, CY_GESY_SELF_RATE,
  CY_CGT_PCT, CY_CGT_ALLOWANCE, CY_CGT_LIFETIME_CAP, DE_SPEC_YEARS,
  VAT_ADJUST_YEARS, CY_TRANSFER_LEVY_PCT, CY_SERVICE_VAT_PCT,
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
  // Verkaufsjahr dieser Wohnung. Leer = wird im Betrachtungszeitraum nicht
  // einzeln verkauft (dann greift der gemeinsame Verkauf der Strategie).
  saleYear?: number | null
  // Kennzeichnet ein vom Reinvestment-Motor erzeugtes Modellobjekt.
  model?: boolean
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
  // Sozialversicherung als selbststaendiger Vermieter: 16,6 % auf mindestens
  // 20.318 EUR fiktives Einkommen, dazu GESY mit 4 % auf den Gewinn statt
  // 2,65 % auf die Miete. Nur fuer in Zypern Ansaessige mit Kurzzeitvermietung
  // (Sven 5.9.26: "nur fuer Resident in Zypern, wenn D dann nein").
  socialIns: boolean
  // ── Laufende Kosten (Sven 5.9.26) ─────────────────────────────────────────
  opexMonthly: number       // Gemeinschaftskosten je Wohnung, EUR/Monat (Vorgabe)
  maintPct: number          // Instandhaltungsruecklage % p.a. vom Kaufpreis
  // ── Verkauf ───────────────────────────────────────────────────────────────
  // Ein gemeinsames Verkaufsjahr fuer die ganze Strategie: der Kunde beendet
  // eine Strategie, nicht drei einzelne Wohnungen. 0 = kein Verkauf rechnen.
  exitAfterYears: number    // Jahre nach dem ersten Kauf (5 bis 10)
  sellCostPct: number       // Maklerprovision % vom Verkaufspreis (zzgl. MwSt)
  lawyerPct: number         // Anwaltshonorar % vom Verkaufspreis (zzgl. MwSt)
  cpiPct: number            // angenommene Inflation p.a. fuer die zyprische Indexierung
  // ── Reinvestment / Kapital-Recycling (Sven 5.9.26) ────────────────────────
  // Aus bleibt alles exakt wie bisher: zehn Jahre, keine Tranchen, kein
  // Modellobjekt. An laeuft die Strategie ueber einen laengeren Horizont, weil
  // sich Kapital-Recycling in zehn Jahren nicht entfalten kann.
  reinvestEnabled: boolean
  horizonYears: number              // nur im Reinvestment-Modus, Standard 20
  reinvestAppreciationPct: number   // eigene Wertsteigerungsannahme des Motors
  refinanceLtv: number              // angenommene maximale Beleihung in %
  bankValuationFactor: number       // Abschlag der Bankbewertung auf den Marktwert, % 
  refinanceUtilizationPct: number   // wie viel der Kapazitaet wirklich genutzt wird, %
  minimumCashReserve: number        // Liquiditaet, die nie angetastet wird
  maxAdditionalPurchases: number    // Obergrenze gegen Endlosschleifen
  autoReinvest: boolean             // Modellobjekte automatisch kaufen?
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
  si: number               // Sozialversicherung des selbststaendigen Vermieters
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
  socialIns: true, opexMonthly: 150, maintPct: 0.75,
  exitAfterYears: 7, sellCostPct: 3, lawyerPct: 1, cpiPct: 2,
  reinvestEnabled: false, horizonYears: 20, reinvestAppreciationPct: 5,
  refinanceLtv: 70, bankValuationFactor: 100, refinanceUtilizationPct: 100,
  minimumCashReserve: 25000, maxAdditionalPurchases: 5, autoReinvest: true,
}

// Sinnvoller Vorschlag fuer die Steuer auf die Ausschuettung: der deutsche
// Gesellschafter zahlt Abgeltungsteuer + Soli, der zyprische Non-Dom nur GESY.
export function defaultDivTaxPct(res: 'de' | 'cy'): number {
  return res === 'cy' ? CY_DIV_TAX_PCT : DE_DIV_TAX_PCT
}

export const ymOf = (y: number, m: number) => y * 12 + (m - 1)

// Planungshorizont der Strategie in Jahren, ab dem ersten Kaufjahr. Ohne
// Reinvestment bleibt es bei zehn; mit Reinvestment gilt p.horizonYears.
export const HORIZON_YEARS = 10
export function horizonOf(p?: SimParams): number {
  if (!p?.reinvestEnabled) return HORIZON_YEARS
  return Math.max(HORIZON_YEARS, Math.round(p.horizonYears || HORIZON_YEARS))
}

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
    // Audit 5.9.26: socialIns wurde nicht durchgereicht, die Engine fiel auf
    // ihren Standard (an) zurueck. Die Portfolio-Steuer der Strategie hat das
    // ueberschrieben, aber die Kennzahlen JE WOHNUNG (Rendite, Monatsrate) und
    // die Einzelberechnung rechneten mit Sozialversicherung, obwohl sie
    // abgeschaltet war.
    socialIns: p.res === 'cy' && p.holder === 'privat' ? p.socialIns : false,
    hotelConcept: hotel, season,
    mgmtPct: fromCalc.mgmtPct ?? defaultMgmtPct(u.letType, hotel),
    equity: ekForUnit,
    // Miete kommt aus dem Simulator (monatlich) → als Bruttorendite an die Engine.
    // Brutto nach der MwSt-Regelung der Einzelberechnung (Sven waehlt sie manuell) -
    // sonst rechnete die Strategie mit 19 %, die Einzelrechnung aber mit 5/19 gemischt.
    yieldPct: u.priceNet > 0 ? (u.rent * 12) / vatSplit(u.priceNet, fromCalc.vatMode, fromCalc.livingSqm).gross * 100 : 0,
    // Zeitachsen-Parameter setzt IMMER die Strategie (gelten über alle Wohnungen)
    rentGrowth: p.rentGrowth, interestPct: p.interest, termYears: p.termYears,
    // Im Reinvestment-Modus rechnet der Motor mit seiner eigenen
    // Wertsteigerungsannahme; die normale Strategie bleibt bei p.growth.
    appreciationPct: p.reinvestEnabled ? p.reinvestAppreciationPct : p.growth,
    deTaxPct: p.deTaxPct,
    // Jede Wohnung wird so lange gerechnet, wie der Horizont ab ihrer Uebergabe
    // noch laeuft - hoechstens aber ueber den ganzen Horizont.
    years: horizonOf(p),
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

// ── Zusaetzliche Darlehenstranchen ───────────────────────────────────────────
// Eine Refinanzierung ist KEIN nachtraeglicher Aufschlag auf das bestehende
// Darlehen, sondern ein eigener Kredit mit eigener Annuitaet. Die urspruengliche
// Finanzierung bleibt dadurch nachvollziehbar, und die Tranche wirkt ab ihrem
// Startjahr auf Zins, Tilgung, Restschuld, Cashflow und Steuerbemessung.
export interface LoanTranche {
  id: string
  propertyKeys: string[]     // besichernde Wohnungen
  startYear: number
  amount: number
  ratePct: number
  termYears: number
  // Wofuer das Geld verwendet wurde. Nur Mittel, die in eine vermietete
  // Immobilie fliessen, tragen abzugsfaehige Zinsen; Geld, das in der Kasse
  // liegen bleibt, nicht.
  purpose: 'purchase' | 'liquidity'
  deductible: boolean
}

export interface TrancheYear { year: number; interest: number; principal: number; rest: number; rate: number }

// Annuitaetenplan einer Tranche, jahrweise. Gleiche Formel wie in der Engine.
export function trancheSchedule(t: LoanTranche, untilYear: number): TrancheYear[] {
  const out: TrancheYear[] = []
  const ir = t.ratePct / 100
  const n = Math.max(1, t.termYears)
  const pay = ir === 0 ? Math.round(t.amount / n)
    : Math.round(t.amount * (ir * Math.pow(1 + ir, n)) / (Math.pow(1 + ir, n) - 1))
  let rest = t.amount
  for (let y = t.startYear; y <= untilYear; y++) {
    if (rest <= 0) { out.push({ year: y, interest: 0, principal: 0, rest: 0, rate: 0 }); continue }
    const interest = Math.round(rest * ir)
    let principal = Math.max(0, pay - interest)
    if (principal > rest) principal = rest
    rest = Math.max(0, rest - principal)
    out.push({ year: y, interest, principal, rest, rate: interest + principal })
  }
  return out
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
function applyPortfolioTax(rows: YearRow[], p: SimParams, business: boolean): void {
  // Verlustvortrag der Gesellschaft, 5 Jahre (Zypern), portfolioweit.
  const open: Array<{ i: number; amt: number }> = []
  rows.forEach((r, idx) => {
    const baseCY = r.baseCY - r.bridgeInterest
    const baseDE = r.baseDE - r.bridgeInterest
    let taxCY = 0, taxDE = 0, gesy = 0, si = 0

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
      // Sozialversicherung: nur wer in Zypern ansaessig ist und die Wohnungen
      // gewerblich kurzzeitvermietet, gilt als selbststaendig. Sie faellt erst an,
      // wenn ueberhaupt vermietet wird, nicht schon in der Bauzeit. Das fiktive
      // Mindesteinkommen gilt auch dann, wenn der Gewinn kleiner ist.
      if (p.socialIns && business && r.rents > 0) {
        const siBase = Math.min(Math.max(inc, CY_SI_MIN_INCOME), CY_SI_MAX_INCOME)
        si = Math.round(siBase * CY_SI_RATE)
        // Als Selbststaendiger zahlt er GESY mit 4 % auf den Gewinn, nicht mit
        // 2,65 % auf die Bruttomiete.
        gesy = p.gesy ? Math.round(Math.min(inc, CY_GESY_CAP) * CY_GESY_SELF_RATE) : 0
      } else {
        gesy = p.gesy ? Math.round(Math.min(r.rents, CY_GESY_CAP) * CY_GESY_RATE) : 0
      }
      taxCY += gesy + si
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
    r.si = si
  })
}

export interface AggregateExtras {
  tranches?: LoanTranche[]
  // Verkaufsjahr je Wohnung: im Verkaufsjahr laeuft die Wohnung noch mit,
  // danach faellt sie komplett heraus.
  saleYears?: Map<string, number>
  // Erzwungenes Endjahr (Reinvestment-Motor rechnet Jahr fuer Jahr).
  untilYear?: number
}

export function aggregate(outcomes: UnitOutcome[], p?: SimParams, extras?: AggregateExtras): { rows: YearRow[]; firstYear: number; lastYear: number; bridgeNeeded: boolean; bridgePeak: number } {
  if (!outcomes.length) { const y = new Date().getFullYear(); return { rows: [], firstYear: y, lastYear: y, bridgeNeeded: false, bridgePeak: 0 } }
  const firstYear = Math.min(...outcomes.map(o => o.unit.buyY))
  // Zehn Jahre ab dem ERSTEN Kauf, hart (Sven 5.9.26): „Zeitraum endet nach 10
  // Jahren, auch wenn man eine Wohnung nach 8 Jahren kauft, laenger ist voellig
  // unrealistisch bei den vielen Variablen." Eine spaet gekaufte Wohnung wird
  // also nur mit ihren ersten Jahren gezeigt - das ist gewollt und ehrlicher als
  // ein Zeitraum, der sich mit jedem zusaetzlichen Kauf verschiebt.
  // Wird verkauft, endet die Darstellung im Verkaufsjahr - danach gibt es nichts
  // mehr zu zeigen, und ein weiterlaufender Verlauf waere schlicht falsch.
  const horizonEnd = firstYear + horizonOf(p) - 1
  const lastYear = extras?.untilYear ?? (p?.exitAfterYears && !p.reinvestEnabled
    ? Math.min(horizonEnd, firstYear + p.exitAfterYears - 1)
    : horizonEnd)
  const rows: YearRow[] = []
  for (let y = firstYear; y <= lastYear; y++) {
    const row: YearRow = { year: y, rents: 0, mgmt: 0, interest: 0, principal: 0, taxes: 0, vat: 0, cashflow: 0, invest: 0, debt: 0, value: 0, committed: 0, bridgeInterest: 0, bridgeDebt: 0, taxCY: 0, taxDE: 0, gesy: 0, si: 0, opex: 0, baseCY: 0, baseDE: 0, unitTax: 0 }
    for (const o of outcomes) {
      // Nach dem Verkaufsjahr existiert die Wohnung nicht mehr: keine Miete,
      // keine Kosten, kein Wert, keine Schuld, keine Steuer.
      const sold = extras?.saleYears?.get(o.unit.key) ?? o.unit.saleYear ?? null
      if (sold != null && y > sold) continue
      const i = y - o.unit.readyY
      // Noch nicht übergeben → bis hierher gezahlte Raten als gebundenes Kapital
      // führen (konservativ ohne Wertzuwachs). Ab Übergabe steht der volle
      // Immobilienwert aus der Engine, die Raten sind darin aufgegangen.
      if (i < 0) {
        for (const pay of o.payments) if (Math.floor(pay.ym / 12) <= y) row.committed += pay.amount
      }
      const n = o.res.rents.length
      if (i >= 0 && i < n) {
        row.rents += o.res.rents[i]; row.mgmt += o.res.mgmt[i]
        row.interest += o.res.intC[i]; row.principal += o.res.princC[i]
        row.taxes += o.res.taxU[i]; row.vat += o.res.vatA[i]; row.cashflow += o.res.cfA[i]
        row.taxCY += o.res.taxCY[i]; row.taxDE += o.res.taxDE[i]; row.gesy += o.res.gesyA[i]
        row.opex += o.res.opexA[i]
        row.baseCY += o.res.profitCY[i]; row.baseDE += o.res.profitDE[i]
        row.unitTax += o.res.taxU[i]
        // Im Verkaufsjahr steht der Wert nicht mehr im Portfolio, sondern der
        // Erloes in der Kasse. Schuld und Wert sind hier also null.
        if (sold == null || y < sold) { row.debt += o.res.restL[i]; row.value += o.res.propV[i] }
      } else if (i >= n) {
        if (sold == null || y < sold) { row.debt += o.res.restL[n - 1]; row.value += o.res.propV[n - 1] }
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
  // Modellobjekte des Reinvestment-Motors bleiben hier aussen vor: Sie werden
  // aus der Kasse und aus Refinanzierungstranchen bezahlt, und beides ist
  // bereits verzinst modelliert. Wuerde die Bauzeitrechnung sie mitzaehlen,
  // entstuende eine Phantom-Zwischenfinanzierung und die Restschuld waere
  // doppelt so hoch wie die tatsaechlichen Darlehen.
  const bridgeUnits = outcomes.filter(o => !o.unit.model)
  if (iMon > 0 && bridgeUnits.length) {
    const pays = bridgeUnits.flatMap(o => o.payments)
    const startYm = Math.min(...pays.map(x => x.ym))
    const endYm = ymOf(lastYear, 12)
    let paid = 0
    for (let ym = startYm; ym <= endYm; ym++) {
      paid += pays.filter(x => x.ym === ym).reduce((a, x) => a + x.amount, 0)
      // Enddarlehen stehen ab der Übergabe der jeweiligen Wohnung zur Verfügung
      const loansReady = bridgeUnits
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
  // ── Refinanzierungstranchen ───────────────────────────────────────────────
  // Wirken ab ihrem Startjahr wie jedes andere Darlehen: Zins und Tilgung
  // belasten den Cashflow, die Restschuld erhoeht die Verschuldung, und die
  // Zinsen mindern die Steuerbemessung - aber nur, wenn das Geld in eine
  // vermietete Immobilie geflossen ist.
  for (const t of extras?.tranches ?? []) {
    for (const ty of trancheSchedule(t, lastYear)) {
      const row = rows.find(r => r.year === ty.year)
      if (!row) continue
      row.interest += ty.interest
      row.principal += ty.principal
      row.debt += ty.rest
      row.cashflow -= ty.rate
      if (t.deductible) { row.baseCY -= ty.interest; row.baseDE -= ty.interest }
    }
  }

  // Steuer zum Schluss: sie braucht die fertigen Bemessungsgrundlagen inklusive
  // der Bauzeitzinsen und der Refinanzierungstranchen.
  if (p) applyPortfolioTax(rows, p, outcomes.some(o => o.unit.letType === 'short'))
  return { rows, firstYear, lastYear, bridgeNeeded: bridgePeak > 0.5, bridgePeak }
}

// ── Drei Szenarien ───────────────────────────────────────────────────────────
// Eine Zahl mit zwei Nachkommastellen suggeriert eine Genauigkeit, die es bei
// zehn Jahren Immobilienmarkt nicht gibt. Deshalb rechnet der Simulator jede
// Strategie dreimal: mit Svens eingestellten Annahmen (Basis) und mit einer
// vorsichtigeren und einer freundlicheren Welt. Abgeleitet wird IMMER aus dem
// Basis-Szenario, damit der Schieberegler die Grundlage bleibt.
export type ScenarioKey = 'basis' | 'konservativ' | 'optimistisch'

export interface ScenarioShift {
  growth: number; rentGrowth: number; interest: number; maint: number; rentFactor: number
}
// Bewusst breit angesetzt: eine Bandbreite, die nur die Wertsteigerung um einen
// halben Punkt verschiebt, beruhigt, statt zu informieren.
export const SCENARIO_SHIFTS: Record<ScenarioKey, ScenarioShift> = {
  basis:        { growth: 0,  rentGrowth: 0,  interest: 0,   maint: 0,    rentFactor: 1 },
  // Wertsteigerung und Mieten schwaecher, Anschlussfinanzierung teurer,
  // Instandhaltung hoeher, dazu 10 % Ausfall durch Leerstand und Preisdruck.
  konservativ:  { growth: -2, rentGrowth: -1, interest: 1,   maint: 0.25, rentFactor: 0.9 },
  // Freundlicher Markt: mehr Wertsteigerung, hoehere Mieten, guenstigere
  // Finanzierung, planmaessige Instandhaltung.
  optimistisch: { growth: 2,  rentGrowth: 1,  interest: -0.5, maint: -0.25, rentFactor: 1.05 },
}

export interface ScenarioResult {
  key: ScenarioKey
  params: SimParams
  units: SimUnit[]
  outcomes: UnitOutcome[]
  rows: YearRow[]
  firstYear: number; lastYear: number
  bridgeNeeded: boolean; bridgePeak: number
  exit: ExitResult | null
  totals: StrategyTotals
}

export function scenarioParams(p: SimParams, key: ScenarioKey): SimParams {
  const sh = SCENARIO_SHIFTS[key]
  return {
    ...p,
    growth: Math.max(0, Math.round((p.growth + sh.growth) * 100) / 100),
    rentGrowth: Math.max(0, Math.round((p.rentGrowth + sh.rentGrowth) * 100) / 100),
    interest: Math.max(0.1, Math.round((p.interest + sh.interest) * 100) / 100),
    maintPct: Math.max(0, Math.round((p.maintPct + sh.maint) * 100) / 100),
  }
}

export function runScenario(units: SimUnit[], p: SimParams, key: ScenarioKey): ScenarioResult {
  const sp = scenarioParams(p, key)
  const factor = SCENARIO_SHIFTS[key].rentFactor
  const su = factor === 1 ? units : units.map(u => ({ ...u, rent: Math.round(u.rent * factor) }))
  const outcomes = allocate(su, sp)
  const agg = aggregate(outcomes, sp)
  const exit = computeExit(outcomes, sp, agg.firstYear)
  const totals = totalsOf(outcomes, agg.rows, sp, exit)
  return { key, params: sp, units: su, outcomes, rows: agg.rows, firstYear: agg.firstYear, lastYear: agg.lastYear, bridgeNeeded: agg.bridgeNeeded, bridgePeak: agg.bridgePeak, exit, totals }
}

export const SCENARIO_KEYS: ScenarioKey[] = ['basis', 'konservativ', 'optimistisch']

export function runScenarios(units: SimUnit[], p: SimParams): Record<ScenarioKey, ScenarioResult> {
  return {
    basis: runScenario(units, p, 'basis'),
    konservativ: runScenario(units, p, 'konservativ'),
    optimistisch: runScenario(units, p, 'optimistisch'),
  }
}

// ── Risiko ───────────────────────────────────────────────────────────────────
// Keine erfundene Risikomathematik: Jede Ampel liest ein konkretes Ergebnis aus
// den drei Szenarien ab und hat eine Schwelle, die im Klartext danebensteht.
export type RiskLevel = 'gruen' | 'gelb' | 'rot'
export interface RiskItem { key: string; level: RiskLevel; value: string; note: string }

const worst = (a: number, b: number) => Math.min(a, b)

export function assessRisk(sc: Record<ScenarioKey, ScenarioResult>, breakEven: number): RiskItem[] {
  const base = sc.basis, kons = sc.konservativ
  const items: RiskItem[] = []

  // Wertentwicklung: Wie viel Vermoegen kostet die vorsichtige Welt?
  const wBase = base.exit ? base.exit.net : base.totals.netWorth
  const wKons = kons.exit ? kons.exit.net : kons.totals.netWorth
  const drop = wBase > 0 ? (wBase - wKons) / wBase : 1
  items.push({
    key: 'wert',
    level: drop < 0.25 ? 'gruen' : drop < 0.5 ? 'gelb' : 'rot',
    value: `−${Math.round(drop * 100)} %`,
    note: 'So viel weniger bleibt im vorsichtigen Szenario am Ende übrig.',
  })

  // Break-even: Wie viel Luft ist zwischen der angenommenen und der noetigen
  // Wertsteigerung?
  const margin = isFinite(breakEven) ? base.params.growth - breakEven : NaN
  items.push({
    key: 'breakeven',
    level: !isFinite(margin) ? 'rot' : margin > 3 ? 'gruen' : margin > 1 ? 'gelb' : 'rot',
    value: isFinite(breakEven) ? `${String(breakEven).replace('.', ',')} %` : '–',
    note: 'Nötige Wertsteigerung, damit das Eigenkapital zurückkommt. Angenommen sind ' + String(base.params.growth).replace('.', ',') + ' %.',
  })

  // Cashflow: Muss der Kunde zuschiessen, und wie viel im schlechten Fall?
  const cfBase = base.totals.cashflowLastYear, cfKons = kons.totals.cashflowLastYear
  const cfMin = worst(cfBase, cfKons)
  items.push({
    key: 'cashflow',
    level: cfMin >= 0 ? 'gruen' : cfMin > -12000 ? 'gelb' : 'rot',
    value: new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(cfMin)) + ' €',
    note: 'Schlechtester laufender Cashflow eines vollen Jahres, vorsichtiges Szenario eingerechnet.',
  })

  // Finanzierung: Wie stark haengt das Ergebnis am Zins?
  const debtShare = base.totals.valueEnd > 0 ? base.totals.debtEnd / base.totals.valueEnd : 0
  items.push({
    key: 'finanzierung',
    level: debtShare < 0.4 ? 'gruen' : debtShare < 0.65 ? 'gelb' : 'rot',
    value: `${Math.round(debtShare * 100)} %`,
    note: 'Anteil der Restschuld am Immobilienwert am Ende. Je höher, desto stärker wirkt ein Zinsanstieg.',
  })

  // Vermietung: Was kostet ein Ausfall von 10 % der Mieten?
  const rentGap = base.totals.rents > 0 ? (base.totals.rents - kons.totals.rents) / base.totals.rents : 0
  items.push({
    key: 'vermietung',
    level: rentGap < 0.15 ? 'gruen' : rentGap < 0.3 ? 'gelb' : 'rot',
    value: `−${Math.round(rentGap * 100)} %`,
    note: 'So viel Miete fehlt im vorsichtigen Szenario über den ganzen Zeitraum.',
  })

  // Exit: Bleibt nach Steuern und Kosten ueberhaupt etwas uebrig?
  if (base.exit) {
    const ratio = base.exit.value > 0 ? base.exit.net / base.exit.value : 0
    items.push({
      key: 'exit',
      level: kons.exit && kons.exit.net > 0 ? (ratio > 0.25 ? 'gruen' : 'gelb') : 'rot',
      value: `${Math.round(ratio * 100)} %`,
      note: 'Anteil des Verkaufspreises, der nach Kredit, Kosten und Steuern beim Kunden ankommt.',
    })
  }
  return items
}

// ── Verkauf am Ende der Strategie ────────────────────────────────────────────
// Ohne Exit fehlt die halbe Investitionsentscheidung: Wertsteigerung ist nur auf
// dem Papier, solange nicht verkauft wird, und beim Verkauf greifen drei Steuern
// auf einmal (zyprische Veraeusserungsgewinnsteuer, anteilige Rueckzahlung der
// gezogenen Mehrwertsteuer, in Deutschland das private Veraeusserungsgeschaeft).
export interface ExitUnitLine {
  name: string
  value: number        // Verkaufspreis
  cost: number         // Anschaffungskosten inkl. Nebenkosten
  costIndexed: number  // dieselben Kosten, inflationsbereinigt (zyprische Regel)
  sellCost: number     // Makler + Anwalt inkl. MwSt auf diese Wohnung
  gain: number         // Gewinn fuer die zyprische Steuer
  debt: number         // Restschuld dieser Wohnung
  vatClawback: number  // anteilige Rueckzahlung der gezogenen MwSt
  delivered: boolean   // zum Verkaufszeitpunkt schon uebergeben?
  yearsHeld: number
}
export interface ExitResult {
  year: number
  lines: ExitUnitLine[]
  value: number; debt: number
  sellCost: number     // Makler + Anwalt inkl. MwSt
  levy: number         // 0,4 % Uebertragungsabgabe
  vatClawback: number
  cgt: number          // zyprische Veraeusserungsgewinnsteuer
  taxDE: number        // deutsche Steuer nach Anrechnung
  divTax: number       // Ausschuettung des Verkaufserloeses aus der Firma
  gain: number         // indexierter Gewinn ueber alle Wohnungen
  net: number          // was beim Kunden ankommt
}

// ── Bausteine des Verkaufs ───────────────────────────────────────────────────
// Einmal geschrieben, von beiden Wegen genutzt: vom gemeinsamen Verkauf am Ende
// der Strategie (computeExit) und vom Einzelverkauf des Reinvestment-Motors
// (computeSale). Keine zweite Verkaufslogik.
export function saleLineOf(o: UnitOutcome, year: number, p: SimParams, tranches: LoanTranche[] = []): ExitUnitLine {
  const i = year - o.unit.readyY
  const n = o.res.rents.length
  const delivered = i >= 0
  const paid = o.payments.filter(x => Math.floor(x.ym / 12) <= year).reduce((a, x) => a + x.amount, 0)
  const value = delivered ? o.res.propV[Math.min(i, n - 1)] : paid
  const cost = o.res.pGross + o.res.costs
  const heldYears = Math.max(0, year - o.unit.buyY)
  const costIndexed = Math.round(cost * Math.pow(1 + p.cpiPct / 100, heldYears))
  const svcVat = 1 + CY_SERVICE_VAT_PCT / 100
  const sellCost = Math.round(value * ((p.sellCostPct + p.lawyerPct) / 100) * svcVat)
  // Restschuld: urspruengliches Darlehen PLUS die offenen Refinanzierungs-
  // tranchen, die auf dieser Wohnung liegen. Sonst waere der Erloes zu hoch.
  const ownDebt = delivered ? o.res.restL[Math.min(i, n - 1)] : 0
  const trancheDebt = tranches
    .filter(t => t.propertyKeys.includes(o.unit.key) && t.startYear <= year)
    .reduce((a, t) => {
      const sched = trancheSchedule(t, year)
      const last = sched[sched.length - 1]
      // Bei mehreren Sicherheiten faellt auf diese Wohnung nur ihr Anteil.
      return a + (last ? last.rest / Math.max(1, t.propertyKeys.length) : 0)
    }, 0)
  const debt = Math.round(ownDebt + trancheDebt)
  const soldInterval = delivered ? i + 1 : 0
  const vatClawback = (o.unit.letType === 'short' && delivered && soldInterval < VAT_ADJUST_YEARS)
    ? Math.round(o.res.vatAmt * (VAT_ADJUST_YEARS - soldInterval) / VAT_ADJUST_YEARS)
    : 0
  return {
    name: o.unit.name, value, cost, costIndexed, sellCost, debt, vatClawback, delivered,
    yearsHeld: soldInterval,
    gain: delivered ? Math.max(0, value - costIndexed - sellCost) : 0,
  }
}

export interface SaleTax { cgt: number; taxDE: number; usedExemption: number }

// Zyprische Veraeusserungsgewinnsteuer und deutsche Steuer auf einen Verkauf.
// Der lebenslange Freibetrag wird als Topf uebergeben und verbraucht.
export function saleTaxOf(
  lines: ExitUnitLine[], outcomes: UnitOutcome[], year: number, p: SimParams, exemptionLeft: number,
): SaleTax {
  const gain = lines.reduce((a, l) => a + l.gain, 0)
  // Der Freibetrag ist lebenslang und je Person gedeckelt - nie mehr, als noch
  // im Topf ist, und nie mehr als der Gewinn.
  const allowance = p.holder === 'firma'
    ? 0
    : Math.max(0, Math.min(exemptionLeft, CY_CGT_LIFETIME_CAP, gain))
  const cgt = Math.max(0, Math.round((gain - allowance) * CY_CGT_PCT / 100))
  let taxDE = 0
  if (p.res === 'de' && p.holder === 'privat') {
    let gainDE = 0
    for (const o of outcomes) {
      const i = year - o.unit.readyY
      if (i < 0) continue
      if (year - o.unit.buyY >= DE_SPEC_YEARS) continue
      const line = lines.find(l => l.name === o.unit.name)
      if (!line) continue
      const n = o.res.afaDE.length
      const afaUsed = o.res.afaDE.slice(0, Math.min(i + 1, n)).reduce((a, b) => a + b, 0)
      gainDE += Math.max(0, line.value - (line.cost - afaUsed) - line.sellCost)
    }
    const raw = Math.round(gainDE * (p.deTaxPct / 100))
    taxDE = raw <= 0 ? 0 : Math.max(0, raw - cgt)
  }
  return { cgt, taxDE, usedExemption: allowance }
}

// Einzelverkauf einer Wohnung im Reinvestment-Motor.
export interface SaleResult extends SaleTax {
  year: number; key: string; name: string
  line: ExitUnitLine
  levy: number
  netProceeds: number
}
export function computeSale(
  o: UnitOutcome, year: number, p: SimParams, exemptionLeft: number, tranches: LoanTranche[] = [],
): SaleResult {
  const line = saleLineOf(o, year, p, tranches)
  const tax = saleTaxOf([line], [o], year, p, exemptionLeft)
  const levy = Math.round(line.value * CY_TRANSFER_LEVY_PCT / 100)
  const netProceeds = line.value - line.debt - line.sellCost - levy - line.vatClawback - tax.cgt - tax.taxDE
  return { ...tax, year, key: o.unit.key, name: o.unit.name, line, levy, netProceeds }
}

export function computeExit(outcomes: UnitOutcome[], p: SimParams, firstYear: number): ExitResult | null {
  if (!outcomes.length || !p.exitAfterYears) return null
  const year = firstYear + p.exitAfterYears - 1
  const lines = outcomes.map(o => saleLineOf(o, year, p))
  const sum = (f: (l: ExitUnitLine) => number) => lines.reduce((a, l) => a + f(l), 0)
  const value = sum(l => l.value), debt = sum(l => l.debt)
  const sellCost = sum(l => l.sellCost), vatClawback = sum(l => l.vatClawback)
  const gain = sum(l => l.gain)
  const levy = Math.round(value * CY_TRANSFER_LEVY_PCT / 100)
  const { cgt, taxDE } = saleTaxOf(lines, outcomes, year, p, CY_CGT_ALLOWANCE)
  const beforeDiv = value - debt - sellCost - levy - vatClawback - cgt - taxDE
  const divTax = (p.holder === 'firma' && beforeDiv > 0)
    ? Math.round(beforeDiv * (p.divPayoutPct / 100) * (p.divTaxPct / 100))
    : 0
  return { year, lines, value, debt, sellCost, levy, vatClawback, cgt, taxDE, divTax, gain, net: beforeDiv - divTax }
}

// ── Eigenkapital-Abfluss auf der Zeitachse ───────────────────────────────────
// Wann fliesst wirklich Geld des Kunden ab? Dieselbe Reihenfolge wie in der
// Zwischenfinanzierung: erst das Eigenkapital, dann die Bank. Wird fuer die
// Zahlungsstrom-Rendite gebraucht - die bisherige EK-Rendite war eine reine
// Schlussbetrachtung ohne Zeitwert des Geldes.
export function equityOutflowByYear(outcomes: UnitOutcome[], p: SimParams): Map<number, number> {
  const out = new Map<number, number>()
  const pays = outcomes.flatMap(o => o.payments).sort((a, b) => a.ym - b.ym)
  let ekLeft = p.ek
  for (const pay of pays) {
    const use = Math.min(ekLeft, pay.amount)
    ekLeft -= use
    if (use > 0) {
      const y = Math.floor(pay.ym / 12)
      out.set(y, (out.get(y) ?? 0) + use)
    }
  }
  // Kaufnebenkosten zahlt der Kunde aus eigener Tasche, faellig zur Uebergabe.
  for (const o of outcomes) {
    const extra = o.res.ekStart - o.res.ekAbs
    if (extra > 0) out.set(o.unit.readyY, (out.get(o.unit.readyY) ?? 0) + extra)
  }
  return out
}

// Interner Zinsfuss auf den TATSAECHLICHEN Zahlungsstroemen des Kunden:
// Eigenkapital raus, laufender Cashflow rein, am Ende der Verkaufserloes.
export function irrOfPlan(rows: YearRow[], outcomes: UnitOutcome[], p: SimParams, exitProceeds = 0, exitYear?: number): number {
  if (!rows.length) return NaN
  const ekOut = equityOutflowByYear(outcomes, p)
  const flows: number[] = []
  for (const r of rows) {
    if (exitYear != null && r.year > exitYear) break
    let f = r.cashflow - (ekOut.get(r.year) ?? 0)
    if (exitYear != null && r.year === exitYear) f += exitProceeds
    flows.push(f)
  }
  if (exitYear == null && exitProceeds) flows[flows.length - 1] += exitProceeds
  return irrCalc(flows)
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
  taxCY: number; taxDE: number; gesy: number; si: number
  interest: number; cashflow: number; totalReturn: number; roe: number
  debtEnd: number          // offener Kredit am Ende des Zeitraums
  roe5: number; roe10: number   // Eigenkapital-Rendite nach 5 bzw. 10 Jahren
  // Sven 5.9.26: Kennzahlen, die fuer die Entscheidung fehlten.
  opex: number             // laufende Kosten der Wohnungen kumuliert
  mgmt: number             // Verwaltung kumuliert
  principal: number        // getilgt im Zeitraum
  valueEnd: number         // Immobilienwert am Ende, ohne Abzug der Schuld
  equityInProperty: number // Immobilienwert abzueglich Restschuld
  cashflowLastYear: number // was die Strategie im letzten vollen Jahr abwirft
  irr: number              // interner Zinsfuss auf den echten Zahlungsstroemen
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

export function totalsOf(outcomes: UnitOutcome[], rows: YearRow[], p?: SimParams, exit?: ExitResult | null): StrategyTotals {
  const sum = (f: (r: YearRow) => number) => rows.reduce((a, r) => a + f(r), 0)
  const ekTotal = outcomes.reduce((a, o) => a + o.ekUsed, 0)
  const last = rows[rows.length - 1]
  const netWorth = last ? last.value + last.committed - last.debt : 0
  const rents = sum(r => r.rents), taxes = sum(r => r.taxes), vat = sum(r => r.vat)
  const interest = sum(r => r.interest), cashflow = sum(r => r.cashflow)
  const totalReturn = netWorth - ekTotal + cashflow
  const roe = ekTotal > 0 ? (totalReturn / ekTotal) * 100 : 0
  const debtEnd = last ? last.debt : 0
  // Cashflow des letzten Jahres, in dem ueberhaupt vermietet wurde - das zeigt,
  // was die Strategie im eingeschwungenen Betrieb abwirft.
  const rented = rows.filter(r => r.rents > 0)
  const cashflowLastYear = rented.length ? rented[rented.length - 1].cashflow : 0
  const valueEnd = last ? last.value : 0
  const irr = p ? irrOfPlan(rows, outcomes, p, exit ? exit.net : 0, exit?.year) : NaN
  return {
    ekTotal, netWorth, rents, taxes, vat, interest, cashflow, totalReturn, roe, debtEnd,
    taxCY: sum(r => r.taxCY), taxDE: sum(r => r.taxDE), gesy: sum(r => r.gesy), si: sum(r => r.si),
    roe5: roeAfterYears(rows, ekTotal, 5), roe10: roeAfterYears(rows, ekTotal, 10),
    opex: sum(r => r.opex), mgmt: sum(r => r.mgmt), principal: sum(r => r.principal),
    valueEnd, equityInProperty: valueEnd - debtEnd, cashflowLastYear, irr,
  }
}

// Welche jaehrliche Wertsteigerung braucht die Strategie, damit am Ende genau
// das eingesetzte Eigenkapital wieder da ist? Alles darueber ist Gewinn.
// Break-even = Nettoerloes aus dem Verkauf plus der bis dahin geflossene
// Cashflow deckt das eingesetzte Eigenkapital.
export function breakEvenGrowth(units: SimUnit[], p: SimParams): number {
  if (!units.length) return NaN
  const surplus = (growth: number): number => {
    const pp = { ...p, growth }
    const outs = allocate(units, pp)
    const agg = aggregate(outs, pp)
    const ex = computeExit(outs, pp, agg.firstYear)
    const cash = agg.rows.filter(r => !ex || r.year <= ex.year).reduce((a, r) => a + r.cashflow, 0)
    const ekTotal = outs.reduce((a, o) => a + o.ekUsed, 0)
    const end = ex ? ex.net : (agg.rows.length ? agg.rows[agg.rows.length - 1].value - agg.rows[agg.rows.length - 1].debt : 0)
    return end + cash - ekTotal
  }
  let lo = -10, hi = 25
  if (surplus(lo) > 0) return lo
  if (surplus(hi) < 0) return NaN
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2
    if (surplus(m) < 0) lo = m; else hi = m
  }
  return Math.round(((lo + hi) / 2) * 100) / 100
}
