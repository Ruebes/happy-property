import { DEFAULT_PARAMS, compute, type CalcParams, type CalcResult } from './rechner'

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
}

export interface SimParams {
  ek: number; growth: number; interest: number; termYears: number
  rentGrowth: number; deTaxPct: number; bundle: boolean
}

export interface UnitOutcome {
  unit: SimUnit; res: CalcResult; ekUsed: number; loan: number
  gross: number; payments: Array<{ ym: number; amount: number; label: string }>
}

export interface YearRow {
  year: number; rents: number; mgmt: number; interest: number; principal: number
  taxes: number; vat: number; cashflow: number; invest: number; debt: number; value: number
  // Bauphase: bereits gezahlte Kaufraten von Wohnungen, die noch nicht übergeben
  // sind. Dieses Geld ist NICHT weg, sondern in der Immobilie gebunden - ohne
  // diese Position sähe es im Vermögensverlauf aus, als würde Kapital
  // verschwinden (Svens Frage 15.8.: „Warum geht das erst so massiv runter?").
  committed: number
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
    return { units: cfg.unitsV2, params: { ...DEFAULT_SIM_PARAMS, ...(cfg.paramsV2 ?? {}) } }
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
}

export const ymOf = (y: number, m: number) => y * 12 + (m - 1)

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
  const params: CalcParams = {
    ...DEFAULT_PARAMS,
    month: u.readyM, year: u.readyY, dealType: 'single',
    priceNet: u.priceNet, discountPct: 0, bedrooms: 2,
    fin: u.fin ? 'yes' : 'no', letType: u.letType, mode: 'ann', res: 'de',
    hotelConcept: false,
    equity: ekForUnit,
    yieldPct: u.priceNet > 0 ? (u.rent * 12) / Math.round(u.priceNet * 1.19) * 100 : 0,
    rentGrowth: p.rentGrowth, interestPct: p.interest, termYears: p.termYears,
    appreciationPct: p.growth, deTaxPct: p.deTaxPct,
    furnCost: u.furnNet, furnFree: false, season: null,
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

export function aggregate(outcomes: UnitOutcome[]): { rows: YearRow[]; firstYear: number } {
  if (!outcomes.length) return { rows: [], firstYear: new Date().getFullYear() }
  const firstYear = Math.min(...outcomes.map(o => o.unit.buyY))
  const lastYear = Math.max(...outcomes.map(o => o.unit.readyY + 9))
  const rows: YearRow[] = []
  for (let y = firstYear; y <= lastYear; y++) {
    const row: YearRow = { year: y, rents: 0, mgmt: 0, interest: 0, principal: 0, taxes: 0, vat: 0, cashflow: 0, invest: 0, debt: 0, value: 0, committed: 0 }
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
        row.debt += o.res.restL[i]; row.value += o.res.propV[i]
      } else if (i >= 10) {
        row.debt += o.res.restL[9]; row.value += o.res.propV[9]
      }
      for (const pay of o.payments) if (Math.floor(pay.ym / 12) === y) row.invest += pay.amount
    }
    rows.push(row)
  }
  return { rows, firstYear }
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
  interest: number; cashflow: number; totalReturn: number; roe: number
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
  return { ekTotal, netWorth, rents, taxes, vat, interest, cashflow, totalReturn, roe }
}
