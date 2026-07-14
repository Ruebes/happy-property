// ── Rendite-Rechner-Engine ───────────────────────────────────────────────────
// 1:1-Portierung der compute()-Logik aus dem eigenständigen Rechner (index.html).
// KEINE Formel-Änderungen — nur DOM-Reads durch ein typisiertes Params-Objekt
// ersetzt. Numerisch verifiziert gegen das Original (scripts/verify-rechner.mjs).
//
// Single-Kauf (Einzelwohnung) UND Share-Deal (Holding-Portfolio) werden abgebildet.

export interface SdUnit { price: number; sqm: number; terr: number }

// ── Gespeicherter Inhalt einer Rechnung/eines Vergleichs (property_calculations.content) ──
export interface CalcItem {
  label: string; project: string; unit: string; color?: string
  bedrooms?: number | null; size_sqm?: number | null; terrace_sqm?: number | null; floor?: number | null
  price_net?: number | null; price_gross?: number | null
  location?: string; developer?: string; handover?: string
  tagline?: string; strategy_title?: string; strategy_text?: string
  params?: CalcParams      // nur wenn with_calc
}
export interface CalcContent {
  with_calc: boolean
  recipient_name?: string
  briefing?: string
  tagline?: string
  intro?: string
  items: CalcItem[]
}

export interface CalcParams {
  month: number            // Kaufmonat 1-12 (s-month, default 8)
  year: number             // Kaufjahr (s-year, default 2025)
  dealType: 'single' | 'share'   // s-dealtype
  // Einzelkauf:
  priceNet: number         // s-price (Listenpreis netto)
  discountPct: number      // s-discount (0-30)
  bedrooms: number         // s-bedrooms
  // Share-Deal:
  sdInputMode: 'units' | 'manual'  // sd-mode
  sdUnits: SdUnit[]
  sdPrice: number; sdSqm: number; sdTerr: number; sdNum: number
  sdDiscount: number; sdVatDrawn: number; sdVatYears: number; sdTaxRate: number
  // gemeinsam:
  fin: 'yes' | 'no'        // s-fin (Finanzierung ja/nein)
  letType: 'short' | 'long'// s-let (Kurz-/Langzeit)
  mode: 'ann' | 'tilg'     // s-mode (Annuität / fixe Tilgung)
  res: 'de' | 'cy'         // s-res (Steuersitz)
  hotelConcept: boolean    // s-hotel / sd-hotel (nur Kurzzeit)
  equity: number           // s-equity / sd-equity (Eigenkapital abs.)
  cyBI: number             // s-cyi (CY Bestandseinkommen, nur bei res=cy)
  yieldPct: number         // s-yield (Bruttomietrendite %)
  rentGrowth: number       // s-rg (Mietsteigerung % p.a.)
  mgmtPct: number          // s-mgmt (Verwaltung %)
  interestPct: number      // s-int (Zinssatz %)
  termYears: number        // s-term (Laufzeit Jahre)
  amortPct: number         // s-amort (Tilgung % – fixer Modus)
  appreciationPct: number  // s-app (Wertsteigerung % p.a.)
  deTaxPct: number         // s-det (DE Grenzsteuersatz %)
  furnCost: number         // s-furn (Einrichtungspaket €)
  furnFree: boolean        // furn-free (Einrichtung kostenfrei?)
  ppVals: number[]         // 10× Sondertilgung pro Jahr
}

export const DEFAULT_PARAMS: CalcParams = {
  month: 8, year: 2025, dealType: 'single',
  priceNet: 250000, discountPct: 0, bedrooms: 2,
  sdInputMode: 'manual', sdUnits: [], sdPrice: 1000000, sdSqm: 250, sdTerr: 60, sdNum: 3,
  sdDiscount: 0, sdVatDrawn: 0, sdVatYears: 0, sdTaxRate: 12.5,
  fin: 'yes', letType: 'short', mode: 'ann', res: 'de', hotelConcept: false,
  equity: 75000, cyBI: 0, yieldPct: 5.5, rentGrowth: 5, mgmtPct: 2, interestPct: 4.1,
  termYears: 20, amortPct: 2, appreciationPct: 5, deTaxPct: 42, furnCost: 0, furnFree: false,
  ppVals: Array(10).fill(0),
}

// Zypern progressive Einkommensteuer (Banden)
export function cyTax(inc: number): number {
  const bands = [{ c: 19500, r: 0 }, { c: 28000, r: .2 }, { c: 36300, r: .25 }, { c: 60000, r: .3 }, { c: Infinity, r: .35 }]
  let t2 = 0, rest = Math.max(0, inc), prev = 0
  for (const b of bands) { const w = Math.min(rest, b.c - prev); if (w > 0) t2 += w * b.r; rest -= w; prev = b.c; if (rest <= 0) break }
  return Math.round(t2)
}

// Tilgungslaufzeit aus Annuität (Bisektion) — für „Rate optimieren" (1:1 aus Original)
export function solveTerm(loan: number, ir: number, annPay: number, max = 35): number {
  if (loan <= 0 || annPay <= 0) return 20
  if (ir <= 0) return Math.min(max, Math.max(5, loan / annPay))
  const f = (n: number) => { const p = ir * Math.pow(1 + ir, n) / (Math.pow(1 + ir, n) - 1); return loan * p - annPay }
  let lo = 0.5, hi = max; if (f(hi) > 0) return max
  for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2, v = f(m); if (Math.abs(v) < 1e-4) return m; if (v > 0) lo = m; else hi = m }
  return (lo + hi) / 2
}

// Tilgungslaufzeit aus vorgegebener Monatsrate (1:1 aus Original)
export function termFromMonthly(loan: number, annR: number, mo: number): number {
  if (loan <= 0 || mo <= 0) return 20
  if (annR <= 0) return Math.min(35, Math.max(5, loan / (mo * 12)))
  const r = annR / 12; if (mo <= loan * r) return 35
  return Math.min(35, Math.max(5, -Math.log(1 - loan * r / mo) / Math.log(1 + r) / 12))
}

// IRR via Bisektion über den NPV
export function irrCalc(cfs: number[]): number {
  const npv = (r: number) => cfs.reduce((v, c, i) => v + c / Math.pow(1 + r, i), 0)
  let lo = -0.999, hi = 5
  if (npv(lo) * npv(hi) > 0) return NaN
  for (let i = 0; i < 120; i++) { const m = (lo + hi) / 2, v = npv(m); if (Math.abs(v) < 1e-6) return m; if (v > 0) lo = m; else hi = m }
  return (lo + hi) / 2
}

export interface CalcResult {
  km: number; ky: number; mA: number[]; fA: number[]; yN: number[]
  pNet: number; pNetList: number; pGross: number; pGrossList: number; vatAmt: number; costs: number
  loan: number; ekStart: number; ekAbs: number
  fin: string; letT: string; hotelConcept: boolean; mode: string; resCY: boolean; cyBI: number
  yPct: number; effYield: number; rG: number; mgP: number; iP: number; termY: number; amP: number; appP: number; deTx: number
  discountPct: number; discountAmt: number; bedrooms: number
  sdMode: boolean; sdNumUnits: number; sdTotalSqm: number; sdTotalTerr: number
  sdVatDrawn: number; sdVatYears: number; sdVatClawback: number; sdTaxRate: number
  rents: number[]; mgmt: number[]; intC: number[]; princC: number[]; rateC: number[]; restL: number[]
  prepayC: number[]; propV: number[]; vatA: number[]; taxCY: number[]; taxDE: number[]; taxU: number[]; cfA: number[]
  sumR: number; sumC: number; sumT: number; sumVat: number; sumPP: number; sumCF: number
  ek10: number; totRet: number; roe10: number; irrV: number; mRate: number; mCF: number; mF: number
  furnCost: number; furnFree: boolean; furnForIRR: number
}

export function compute(p: CalcParams): CalcResult {
  const ppVals = p.ppVals && p.ppVals.length === 10 ? p.ppVals : Array(10).fill(0)
  const km = p.month || 8
  const ky = p.year || 2025
  const mF = Math.max(1, 13 - km)
  const mA = [mF].concat(Array(9).fill(12))
  const fA = mA.map(m => m / 12)
  const yN = Array.from({ length: 10 }, (_, i) => ky + i)

  const sdMode = p.dealType === 'share'
  const sdInputMode = sdMode ? p.sdInputMode : ''
  let pNetList: number, discountPct: number, discountAmt: number, pNet: number
  let pGrossList: number, pGross: number, vatAmt: number, costs: number, bedrooms: number
  let sdVatDrawn = 0, sdVatYears = 0, sdVatClawback = 0, sdNumUnits = 0, sdTotalSqm = 0, sdTotalTerr = 0

  if (sdMode) {
    if (sdInputMode === 'units' && p.sdUnits.length > 0) {
      pNetList = p.sdUnits.reduce((a, u) => a + (u.price || 0), 0)
      sdTotalSqm = p.sdUnits.reduce((a, u) => a + (u.sqm || 0), 0)
      sdTotalTerr = p.sdUnits.reduce((a, u) => a + (u.terr || 0), 0)
      sdNumUnits = p.sdUnits.length
      bedrooms = 0
    } else {
      pNetList = Math.max(1, p.sdPrice || 1000000)
      sdTotalSqm = Math.max(20, p.sdSqm || 250)
      sdTotalTerr = Math.max(0, p.sdTerr || 60)
      sdNumUnits = Math.max(1, p.sdNum || 3)
      bedrooms = 0
    }
    discountPct = Math.max(0, Math.min(30, p.sdDiscount || 0))
    discountAmt = Math.round(pNetList * discountPct / 100)
    pNet = pNetList - discountAmt
    pGrossList = pNetList
    pGross = pNet
    vatAmt = 0
    costs = 0
    sdVatDrawn = Math.max(0, p.sdVatDrawn || 0)
    sdVatYears = Math.max(0, Math.min(10, p.sdVatYears || 0))
    sdVatClawback = sdVatYears >= 10 ? 0 : Math.round(sdVatDrawn * (10 - sdVatYears) / 10)
  } else {
    pNetList = Math.max(1, p.priceNet || 250000)
    discountPct = Math.max(0, Math.min(30, p.discountPct || 0))
    discountAmt = Math.round(pNetList * discountPct / 100)
    pNet = pNetList - discountAmt
    pGrossList = Math.round(pNetList * 1.19)
    pGross = Math.round(pNet * 1.19)
    vatAmt = pGross - pNet
    costs = Math.round(pGross * 0.01)
    bedrooms = p.bedrooms || 2
  }

  const fin = p.fin
  const letT = p.letType
  const mode = p.mode
  const resCY = p.res === 'cy'
  const hotelConcept = letT === 'short' ? !!p.hotelConcept : false

  // WICHTIG: nullish-Prüfung statt `|| default` — eine ausdrücklich eingegebene 0
  // (kein Eigenkapital, 100 % Finanzierung) ist gültig und darf NICHT auf den
  // Default (75.000/200.000) zurückfallen. `0 || 75000` = 75000 war der Bug.
  let ekAbs = Math.max(0, Number.isFinite(p.equity) ? p.equity : (sdMode ? 200000 : 75000))
  if (ekAbs > pGross) ekAbs = pGross
  const loan = fin === 'no' ? 0 : Math.max(0, Math.round(pGross - ekAbs))
  const ekCosts = costs + sdVatClawback
  const ekStart = fin === 'no' ? pGross + ekCosts : Math.round(ekAbs + ekCosts)

  const cyBI = resCY ? Math.max(0, p.cyBI || 0) : 0
  const yPct = p.yieldPct || 5.5
  const rG = p.rentGrowth || 5
  const mgP = p.mgmtPct || 2
  const iP = p.interestPct || 4.1
  const termY = p.termYears || 20
  const amP = p.amortPct || 2
  const appP = p.appreciationPct || 5
  const deTx = p.deTaxPct || 42
  const furnCost = Math.max(0, p.furnCost || 0)
  const furnFree = !!p.furnFree

  const vatA = Array(10).fill(0)
  if (letT === 'short') {
    let acc = 0
    for (let vi = 0; vi < mA.length; vi++) { acc += mA[vi]; if (acc >= 24) { vatA[vi] = vatAmt; break } }
  }

  const baseR = pGrossList * (yPct / 100)
  const rents = fA.map((f, i) => Math.round(baseR * Math.pow(1 + rG / 100, i) * f))
  const mgmt = rents.map((r, i) => Math.round(r * (mgP / 100) * Math.pow(1.02, i)))

  const iR = iP / 100
  const intC: number[] = [], princC: number[] = [], rateC: number[] = [], restL: number[] = [], prepayC: number[] = []
  let rem = loan

  if (fin === 'no' || loan <= 0) {
    for (let y2 = 0; y2 < 10; y2++) { intC.push(0); princC.push(0); rateC.push(0); restL.push(0); prepayC.push(0) }
  } else if (mode === 'ann') {
    const payA = iR === 0 ? Math.round(loan / Math.max(1, termY))
      : Math.round(loan * (iR * Math.pow(1 + iR, termY)) / (Math.pow(1 + iR, termY) - 1))
    for (let y3 = 0; y3 < 10; y3++) {
      const f2 = fA[y3]
      if (rem > 0 && y3 < termY) {
        const z = Math.round(rem * iR * f2)
        let rP = Math.round(payA * f2); let ti = Math.max(0, rP - z)
        if (ti > rem) { ti = rem; rP = z + ti }
        const pp = Math.max(0, Math.min(rem - ti, Math.round(ppVals[y3] * f2)))
        intC.push(z); princC.push(ti); rateC.push(rP); prepayC.push(pp)
        rem = Math.max(0, rem - ti - pp); restL.push(rem)
      } else { intC.push(0); princC.push(0); rateC.push(0); prepayC.push(0); restL.push(rem) }
    }
  } else {
    const pAnn = loan * (amP / 100)
    for (let y4 = 0; y4 < 10; y4++) {
      const f3 = fA[y4]
      if (y4 < termY && rem > 0) {
        const z2 = Math.round(rem * iR * f3); const ti2 = Math.min(rem, Math.round(pAnn * f3))
        const pp2 = Math.max(0, Math.min(rem - ti2, Math.round(ppVals[y4] * f3)))
        intC.push(z2); princC.push(ti2); rateC.push(z2 + ti2); prepayC.push(pp2)
        rem = Math.max(0, rem - ti2 - pp2); restL.push(rem)
      } else { intC.push(0); princC.push(0); rateC.push(0); prepayC.push(0); restL.push(rem) }
    }
  }

  const dCY = Math.round(pGross * 0.8 * 0.03)
  const furnAfaAnn = (!furnFree && furnCost > 0) ? Math.round(furnCost / 5) : 0
  const sdTaxRate = sdMode ? Math.max(0, Math.min(35, isNaN(p.sdTaxRate) ? 12.5 : p.sdTaxRate)) / 100 : 0
  let taxCY: number[], taxDE: number[], taxU: number[]

  if (sdMode) {
    taxCY = rents.map((r, i) => {
      const furnAfa = i < 5 ? Math.round(furnAfaAnn * fA[i]) : 0
      const d = Math.round(dCY * fA[i])
      const taxable = r - d - furnAfa - mgmt[i] - intC[i]
      return Math.max(0, Math.round(taxable * sdTaxRate))
    })
    taxDE = Array(10).fill(0)
    taxU = taxCY
  } else {
    taxCY = rents.map((r, i) => {
      const furnAfa = i < 5 ? Math.round(furnAfaAnn * fA[i]) : 0
      const d = Math.round(dCY * fA[i]), m2 = Math.round(r * 0.2), tx = r - d - furnAfa - m2 - intC[i]
      if (resCY) { const b = cyTax(cyBI); return Math.max(0, cyTax(cyBI + Math.max(0, tx)) - b) }
      return cyTax(Math.max(0, tx))
    })
    const bDE = pGross * 0.8; let rDE = bDE
    const dDE: number[] = []
    for (let k2 = 0; k2 < 10; k2++) { const d2 = Math.round(rDE * 0.05 * fA[k2]); dDE.push(d2); rDE = Math.max(0, rDE - d2) }
    const deR = deTx / 100
    taxDE = resCY ? Array(10).fill(0) : rents.map((r, i) => {
      const furnAfa = i < 5 ? Math.round(furnAfaAnn * fA[i]) : 0
      const g2 = Math.round((r - mgmt[i] - intC[i] - dDE[i] - furnAfa) * deR)
      return g2 <= 0 ? g2 : g2 - Math.min(taxCY[i], g2)
    })
    taxU = resCY ? taxCY : taxDE
  }
  const cfA = rents.map((r, i) => r - mgmt[i] - rateC[i] + (vatA[i] || 0) - taxU[i])
  const propV = Array.from({ length: 10 }, (_, i) => Math.round(pGross * Math.pow(1 + appP / 100, (i + 1) - (1 - fA[0]))))

  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const sumR = sum(rents), sumC = sum(mgmt) + sum(intC), sumT = sum(taxCY) + sum(taxDE)
  const sumVat = sum(vatA), sumPP = sum(prepayC), sumCF = sum(cfA)
  const ek10 = propV[9] - restL[9]
  const totRet = sumCF + (ek10 - ekStart)
  const roe10 = ekStart > 0 ? totRet / ekStart * 100 : 0

  const furnForIRR = furnFree ? 0 : furnCost
  const ekForIRR = ekStart + furnForIRR
  const cfIRR = [-ekForIRR].concat(cfA); cfIRR[cfIRR.length - 1] += ek10
  const irrV = irrCalc(cfIRR)
  const mRate = rateC[0] / Math.max(1, mF)
  const mCF = cfA[0] / Math.max(1, mF)

  const effYield = pGross > 0 ? baseR / pGross * 100 : yPct
  return {
    km, ky, mA, fA, yN, pNet, pNetList, pGross, pGrossList, vatAmt, costs, loan, ekStart, ekAbs,
    fin, letT, hotelConcept, mode, resCY, cyBI, yPct, effYield, rG, mgP, iP, termY, amP, appP, deTx,
    discountPct, discountAmt, bedrooms,
    sdMode, sdNumUnits, sdTotalSqm, sdTotalTerr, sdVatDrawn, sdVatYears, sdVatClawback, sdTaxRate,
    rents, mgmt, intC, princC, rateC, restL, prepayC, propV, vatA, taxCY, taxDE, taxU, cfA,
    sumR, sumC, sumT, sumVat, sumPP, sumCF, ek10, totRet, roe10, irrV, mRate, mCF, mF,
    furnCost, furnFree, furnForIRR,
  }
}
