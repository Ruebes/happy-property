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
  // Saisonmodell Kurzzeit (optional): statt pauschaler Bruttorendite
  season?: { totalOcc: number; adrHigh: number } | null
  // MwSt-Regelung (optional, Default standard19 = heutiges Verhalten)
  vatMode?: VatMode
  livingSqm?: number | null   // Wohnflaeche m² fuer die anteilige 5/19-Aufteilung
  // ── Halte-Struktur (Sven 4.9.26) ──────────────────────────────────────────
  // privat = die Wohnung gehoert der Person; firma = eine zyprische Ltd haelt
  // sie. Die Steuer laeuft komplett anders (siehe CY_* Konstanten unten):
  // privat hat Grundfreibetrag + 20 % Pauschalabzug, die Firma keins von beidem,
  // dafuer 15 % Koerperschaftsteuer statt Progression bis 35 % und einen
  // Verlustvortrag von 5 Jahren. Default 'privat' = bisheriges Verhalten.
  holder?: 'privat' | 'firma'
  corpTaxPct?: number       // Koerperschaftsteuer Zypern % (Default 15 seit 1.1.2026)
  divPayoutPct?: number     // Anteil des Gewinns, der ausgeschuettet wird (%)
  divTaxPct?: number        // Steuer beim Gesellschafter auf die Ausschuettung (%)
  gesy?: boolean            // GESY 2,65 % auf die Bruttomiete (nur CY-Steuerresidenz)
  // Kurzzeitvermietung als GEWERBLICHE Taetigkeit (Standard bei Kurzzeit):
  // registriertes Self-Service-Accommodation + 9 % MwSt auf die Miete. Dann
  // zieht auch die Privatperson die ECHTEN Kosten ab (Verwaltung!) statt der
  // 20-%-Pauschale. Bei Langzeitvermietung gilt die Pauschale.
  cyBusiness?: boolean
}

// ── Saisonmodell Kurzzeitvermietung (Paphos-Marktprofil) ─────────────────────
// Sven gibt GESAMT-Auslastung + Preis/Nacht der Hochsaison ein; wir verteilen
// auf 4 Saisons (Basisprofil aus Hotelier-Erfahrung) und leiten die Preise der
// übrigen Saisons über Marktfaktoren ab. Weihnachten (kurzer Ausreißer in der
// Nebensaison) ist im Basiswert der Nebensaison bereits eingepreist.
export interface SeasonRow { key: string; label: string; period: string; days: number; occPct: number; occDays: number; adr: number; revenue: number }
export const SEASON_DEF = [
  { key: 'neben', label: 'Nebensaison', period: '15.11. – 31.03.', days: 137, baseOcc: 27.5, adrFactor: 0.45 },
  { key: 'vor',   label: 'Vorsaison',   period: '01.04. – 31.05.', days: 61,  baseOcc: 55,   adrFactor: 0.65 },
  { key: 'hoch',  label: 'Hochsaison',  period: '01.06. – 31.08.', days: 92,  baseOcc: 87.5, adrFactor: 1 },
  { key: 'nach',  label: 'Nachsaison',  period: '01.09. – 14.11.', days: 75,  baseOcc: 70,   adrFactor: 0.75 },
] as const
export function seasonBreakdown(cfg: { totalOcc: number; adrHigh: number }): { rows: SeasonRow[]; totalDays: number; occDays: number; occPct: number; rent: number } {
  const totalDays = SEASON_DEF.reduce((a, x) => a + x.days, 0)                     // 365
  const baseAvg = SEASON_DEF.reduce((a, x) => a + x.baseOcc * x.days, 0) / totalDays
  const f = Math.max(0, cfg.totalOcc || 0) / baseAvg
  const rows: SeasonRow[] = SEASON_DEF.map(x => {
    const occPct = Math.min(98, Math.round(x.baseOcc * f * 10) / 10)
    const occDays = Math.round(x.days * occPct / 100)
    const adr = Math.round((cfg.adrHigh || 0) * x.adrFactor)
    return { key: x.key, label: x.label, period: x.period, days: x.days, occPct, occDays, adr, revenue: occDays * adr }
  })
  const occDays = rows.reduce((a, x) => a + x.occDays, 0)
  const rent = rows.reduce((a, x) => a + x.revenue, 0)
  return { rows, totalDays, occDays, occPct: Math.round(occDays / totalDays * 1000) / 10, rent }
}
// Saison aktiv → effektive Bruttorendite aus der Saison-Jahresmiete ableiten;
// die verifizierte Engine bleibt formelgleich (Miete = pGrossList × yield%).
export function applySeason(p: CalcParams): CalcParams {
  const sn = p.season
  if (!sn || p.letType !== 'short' || p.dealType !== 'single' || !(sn.totalOcc > 0) || !(sn.adrHigh > 0)) return p
  const basis = vatSplit(p.priceNet || 0, p.vatMode, p.livingSqm).gross
  if (basis <= 0) return p
  const { rent } = seasonBreakdown(sn)
  return { ...p, yieldPct: Math.round(rent / basis * 10000) / 100 }
}

// ── MwSt-Regelung Zypern (Immobilienkauf) ────────────────────────────────────
// Sven waehlt die Regelung MANUELL - das System entscheidet nie selbst, ob ein
// Kaeufer Anspruch auf den reduzierten Satz hat. Drei Optionen:
//   standard19  → gesamter Kaufpreis mit 19 % (heutiges Verhalten, Default)
//   reduced130  → aktuelle Regelung: bis 130 m² Wohnflaeche 5 %, Rest 19 %
//   reduced200  → Uebergangsregelung: bis 200 m² Wohnflaeche 5 %, Rest 19 %
// Aufteilung des Nettopreises proportional zur Wohnflaeche:
//   beguenstigt = netto × MIN(Grenze / Wohnflaeche, 1). Ohne Wohnflaeche (0/null)
// gilt alles als unterhalb der Grenze → komplett 5 %.
export type VatMode = 'standard19' | 'reduced130' | 'reduced200'
export interface VatSplit {
  netReduced: number; netStandard: number; vatReduced: number; vatStandard: number; vat: number; gross: number
  // Warum die Beguenstigung ganz entfaellt (leer = sie greift).
  entfallen?: 'wert' | 'flaeche'
}
// Grenzen der aktuellen zyprischen Regelung (seit 16.6.2023):
//  - 5 % nur auf die ersten 130 m² UND die ersten 350.000 EUR
//  - Voraussetzung: Wohnflaeche <= 190 m² UND Kaufpreis <= 475.000 EUR
//  - Wird eine der beiden Voraussetzungen gerissen, gilt fuer die GESAMTE
//    Immobilie 19 % - nicht nur fuer den ueberschiessenden Teil.
// Die Uebergangsregelung (reduced200) kennt diese Wertgrenzen nicht: dort gelten
// 5 % auf die ersten 200 m², unabhaengig vom Kaufpreis.
export const VAT_CAP_SQM = 130
export const VAT_CAP_WERT = 350000
export const VAT_MAX_SQM = 190
export const VAT_MAX_WERT = 475000

export function vatSplit(net: number, mode: VatMode | undefined, livingSqm?: number | null): VatSplit {
  const alles19 = (grund?: 'wert' | 'flaeche'): VatSplit => {
    // Bit-genau wie bisher: brutto = round(netto × 1,19), MwSt = brutto − netto.
    const gross = Math.round(net * 1.19)
    const vat = gross - net
    return { netReduced: 0, netStandard: net, vatReduced: 0, vatStandard: vat, vat, gross, entfallen: grund }
  }
  if (!mode || mode === 'standard19') return alles19()

  if (mode === 'reduced130') {
    // Ausschlusskriterien zuerst - sie kippen die Beguenstigung komplett.
    if (net > VAT_MAX_WERT) return alles19('wert')
    if (livingSqm && livingSqm > VAT_MAX_SQM) return alles19('flaeche')
    // Innerhalb der Grenzen: 5 % auf den kleineren der beiden Deckel
    // (Flaechenanteil bis 130 m² bzw. Wertanteil bis 350.000 EUR).
    const flaechenAnteil = (livingSqm && livingSqm > 0) ? Math.min(VAT_CAP_SQM / livingSqm, 1) : 1
    const netReduced = Math.min(Math.round(net * flaechenAnteil), VAT_CAP_WERT)
    const netStandard = net - netReduced
    const vatReduced = Math.round(netReduced * 0.05)
    const vatStandard = Math.round(netStandard * 0.19)
    const vat = vatReduced + vatStandard
    return { netReduced, netStandard, vatReduced, vatStandard, vat, gross: net + vat }
  }

  // Uebergangsregelung: 5 % bis 200 m², ohne Wertgrenze.
  const share = (livingSqm && livingSqm > 0) ? Math.min(200 / livingSqm, 1) : 1
  const netReduced = Math.round(net * share)
  const netStandard = net - netReduced
  const vatReduced = Math.round(netReduced * 0.05)
  const vatStandard = Math.round(netStandard * 0.19)
  const vat = vatReduced + vatStandard
  return { netReduced, netStandard, vatReduced, vatStandard, vat, gross: net + vat }
}

// Verwaltungskosten unterscheiden sich je Vermietungsart drastisch (Svens
// echte Berechnungen): Langzeit ~5 % der Miete, Kurzzeit 25 %, mit
// Hotelkonzept 40 % (Rezeption/Reinigung/Wäsche/Betreuung inklusive).
// Ein pauschaler Wert rechnet die Kurzzeitvermietung systematisch zu schön.
export function defaultMgmtPct(letType: 'short' | 'long', hotelConcept?: boolean): number {
  if (letType !== 'short') return 5
  return hotelConcept ? 40 : 25
}

// ── Zyprische Steuerfakten (Stand Steuerreform, in Kraft seit 1.1.2026) ──────
// Quellen: Gesetzespaket im Amtsblatt 31.12.2025 (Reform 2026), PwC Worldwide
// Tax Summaries Cyprus, Deloitte/Trident/Harneys-Zusammenfassungen zur Reform.
//
// PRIVAT (natuerliche Person, auch nicht in Zypern ansaessig):
//   • Grundfreibetrag 22.000 € (vorher 19.500 €), danach 20/25/30/35 %,
//     Spitzensatz erst ab 72.001 € (vorher ab 60.001 €).
//   • 20 % Pauschalabzug auf die BRUTTOMIETE statt echter Instandhaltung.
//   • Gebaeude-Abschreibung 3 % p.a. auf den Gebaeudeanteil (Grund und Boden
//     nicht abschreibbar; hier mit 80 % Gebaeudeanteil gerechnet).
//   • Einrichtung/Moebel 10 % p.a. (10 Jahre).
//   • Darlehenszinsen voll abziehbar.
//   • SDC auf Mieten ist zum 1.1.2026 ERSATZLOS ENTFALLEN.
//   • GESY (Gesundheitsbeitrag) 2,65 % auf die Bruttomiete, Bemessung gedeckelt
//     bei 180.000 € - nur fuer in Zypern Steueransaessige.
// FIRMA (zyprische Ltd):
//   • KEIN Grundfreibetrag, KEIN 20-%-Pauschalabzug - nur echte Kosten.
//   • 15 % Koerperschaftsteuer (bis 2025: 12,5 %).
//   • Gleiche Abschreibung (3 % Gebaeude, 10 % Einrichtung), Zinsen abziehbar.
//   • Verlustvortrag 5 Jahre - in der Bau-/Anlaufphase mit hoher Zinslast der
//     entscheidende Unterschied zur Privatvariante.
//   • Kein SDC/GESY auf Ebene der Gesellschaft; Steuer faellt erst wieder bei
//     der AUSSCHUETTUNG an den Gesellschafter an (Zypern behaelt nichts ein):
//     DE-Gesellschafter 26,375 % Abgeltungsteuer inkl. Soli, zyprischer Non-Dom
//     zahlt nur 2,65 % GESY auf die Dividende.
export const CY_TAX_BANDS = [
  { c: 22000, r: 0 }, { c: 32000, r: .2 }, { c: 42000, r: .25 }, { c: 72000, r: .3 }, { c: Infinity, r: .35 },
] as const
export const CY_RENT_FLAT_DEDUCTION = 0.20   // 20 % Pauschalabzug (nur privat)
export const CY_BUILDING_SHARE = 0.80        // Gebaeudeanteil am Kaufpreis
export const CY_BUILDING_AFA = 0.03          // 3 % p.a. Gebaeude
export const CY_FURN_AFA = 0.10              // 10 % p.a. Einrichtung
export const CY_CORP_TAX_PCT = 15            // Koerperschaftsteuer seit 1.1.2026
export const CY_LOSS_CARRY_YEARS = 5         // Verlustvortrag
export const CY_GESY_RATE = 0.0265           // Gesundheitsbeitrag auf Mieten
export const CY_GESY_CAP = 180000            // Bemessungsdeckel p.a.
export const DE_DIV_TAX_PCT = 26.375         // Abgeltungsteuer + Soli (DE-Gesellschafter)
export const CY_DIV_TAX_PCT = 2.65           // Non-Dom: nur GESY auf die Dividende

export const DEFAULT_PARAMS: CalcParams = {
  month: 8, year: 2025, dealType: 'single',
  priceNet: 250000, discountPct: 0, bedrooms: 2,
  sdInputMode: 'manual', sdUnits: [], sdPrice: 1000000, sdSqm: 250, sdTerr: 60, sdNum: 3,
  sdDiscount: 0, sdVatDrawn: 0, sdVatYears: 0, sdTaxRate: CY_CORP_TAX_PCT,
  fin: 'yes', letType: 'short', mode: 'ann', res: 'de', hotelConcept: false,
  equity: 75000, cyBI: 0, yieldPct: 5.5, rentGrowth: 5, mgmtPct: 2, interestPct: 4.1,
  termYears: 20, amortPct: 2, appreciationPct: 5, deTaxPct: 42, furnCost: 0, furnFree: false,
  ppVals: Array(10).fill(0),
  season: null,
  vatMode: 'standard19', livingSqm: null,
  holder: 'privat', corpTaxPct: CY_CORP_TAX_PCT, divPayoutPct: 100, divTaxPct: DE_DIV_TAX_PCT, gesy: true,
}

// Zypern progressive Einkommensteuer (Banden ab 2026)
export function cyTax(inc: number): number {
  const bands = CY_TAX_BANDS
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
  // Halte-Struktur: bei 'firma' steckt in taxCY die Koerperschaftsteuer und in
  // taxDE die Steuer auf die Ausschuettung. gesyA ist der Gesundheitsbeitrag
  // (nur privat + Steuersitz Zypern) und steckt bereits in taxCY.
  holder: 'privat' | 'firma'; corpTaxPct: number; divTaxPct: number; divPayoutPct: number
  gesyA: number[]; profitCY: number[]
  sumR: number; sumC: number; sumT: number; sumVat: number; sumPP: number; sumCF: number
  ek10: number; totRet: number; roe10: number; irrV: number; mRate: number; mCF: number; mF: number
  furnCost: number; furnFree: boolean; furnForIRR: number; furnVat: number; furnGross: number
  vatMode: VatMode; livingSqm: number; vatDetail: VatSplit
}

export function compute(p: CalcParams): CalcResult { return computeCore(applySeason(p)) }

function computeCore(p: CalcParams): CalcResult {
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
  // Aufschluesselung der Kaufpreis-MwSt (auf den rabattierten Nettopreis)
  let vatDetail: VatSplit = { netReduced: 0, netStandard: 0, vatReduced: 0, vatStandard: 0, vat: 0, gross: 0 }

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
    const vsL = vatSplit(pNetList, p.vatMode, p.livingSqm)
    const vsN = vatSplit(pNet, p.vatMode, p.livingSqm)
    pGrossList = vsL.gross
    pGross = vsN.gross
    vatAmt = vsN.vat
    vatDetail = vsN
    costs = Math.round(pGross * 0.01)
    bedrooms = p.bedrooms || 2
  }

  const fin = p.fin
  const letT = p.letType
  const mode = p.mode
  const resCY = p.res === 'cy'
  const hotelConcept = letT === 'short' ? !!p.hotelConcept : false

  // Einrichtung ist Teil der GESAMTINVESTITION (Sven 11.8.26): Das Eigenkapital
  // gilt auf Immobilie + Einrichtung, die Bank finanziert den Rest. Mehr Möbel =
  // höherer Kredit (bei gleichem EK) UND niedrigere Bruttorendite auf den Gesamtpreis.
  // Einrichtung trägt MwSt wie die Immobilie: normal 19 %, im sdMode netto (VAT via Sondertilgung).
  const furnCost = Math.max(0, p.furnCost || 0)
  const furnFree = !!p.furnFree
  const furnVat = (furnFree || sdMode) ? 0 : Math.round(furnCost * 0.19)
  const furnGross = furnFree ? 0 : furnCost + furnVat
  const furnForIRR = furnFree ? 0 : furnCost
  const totalGross = pGross + furnGross

  // WICHTIG: nullish-Prüfung statt `|| default` — eine ausdrücklich eingegebene 0
  // (kein Eigenkapital, 100 % Finanzierung) ist gültig und darf NICHT auf den
  // Default (75.000/200.000) zurückfallen. `0 || 75000` = 75000 war der Bug.
  let ekAbs = Math.max(0, Number.isFinite(p.equity) ? p.equity : (sdMode ? 200000 : 75000))
  if (ekAbs > totalGross) ekAbs = totalGross
  const loan = fin === 'no' ? 0 : Math.max(0, Math.round(totalGross - ekAbs))
  const ekCosts = costs + sdVatClawback
  const ekStart = fin === 'no' ? totalGross + ekCosts : Math.round(ekAbs + ekCosts)

  const cyBI = resCY ? Math.max(0, p.cyBI || 0) : 0
  const yPct = p.yieldPct || 5.5
  const rG = p.rentGrowth || 5
  const mgP = p.mgmtPct || 2
  const iP = p.interestPct || 4.1
  const termY = p.termYears || 20
  const amP = p.amortPct || 2
  const appP = p.appreciationPct || 5
  const deTx = p.deTaxPct || 42

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

  // ── Abschreibungen ────────────────────────────────────────────────────────
  // Zypern: 3 % p.a. auf den Gebaeudeanteil (80 % des Kaufpreises), Einrichtung
  // 10 % p.a. ueber 10 Jahre. Deutschland rechnet mit eigener AfA (5 % degressiv
  // auf das Gebaeude, Einrichtung ueber 5 Jahre) - deshalb zwei Groessen.
  const dCY = Math.round(pGross * CY_BUILDING_SHARE * CY_BUILDING_AFA)
  const furnAfaDE = (!furnFree && furnCost > 0) ? Math.round(furnCost / 5) : 0
  const furnAfaCY = (!furnFree && furnCost > 0) ? Math.round(furnCost * CY_FURN_AFA) : 0
  const holder: 'privat' | 'firma' = (!sdMode && p.holder === 'firma') ? 'firma' : 'privat'
  const corpTaxPct = Math.max(0, Math.min(35, Number.isFinite(p.corpTaxPct as number) ? (p.corpTaxPct as number) : CY_CORP_TAX_PCT))
  const divPayoutPct = Math.max(0, Math.min(100, Number.isFinite(p.divPayoutPct as number) ? (p.divPayoutPct as number) : 100))
  const divTaxPct = Math.max(0, Math.min(50, Number.isFinite(p.divTaxPct as number) ? (p.divTaxPct as number) : DE_DIV_TAX_PCT))
  const sdTaxRate = sdMode ? Math.max(0, Math.min(35, isNaN(p.sdTaxRate) ? CY_CORP_TAX_PCT : p.sdTaxRate)) / 100 : 0
  // GESY zahlt nur, wer in Zypern steueransaessig ist - und nur als Privatperson.
  const gesyOn = holder === 'privat' && resCY && (p.gesy ?? true)
  const gesyA = rents.map((r, i) => gesyOn ? Math.round(Math.min(r, Math.round(CY_GESY_CAP * fA[i])) * CY_GESY_RATE) : 0)
  let taxCY: number[], taxDE: number[], taxU: number[]
  const profitCY: number[] = []

  // Zyprischer Verlustvortrag (5 Jahre): Verluste der Anlaufjahre mindern die
  // spaeteren Gewinne. Ohne das faellt in der Firma sofort Steuer an, obwohl das
  // Objekt in Summe noch im Minus ist.
  const applyLossCarry = (profits: number[]): number[] => {
    const open: Array<{ y: number; amt: number }> = []
    return profits.map((profit, i) => {
      let rest = profit
      if (rest <= 0) { open.push({ y: i, amt: -rest }); return 0 }
      for (const l of open) {
        if (i - l.y > CY_LOSS_CARRY_YEARS || l.amt <= 0) continue
        const use = Math.min(l.amt, rest); l.amt -= use; rest -= use
        if (rest <= 0) break
      }
      return rest
    })
  }

  if (sdMode) {
    // Share-Deal-Holding: wie die Firma - echte Kosten, kein Pauschalabzug.
    const base = rents.map((r, i) => r - Math.round(dCY * fA[i]) - Math.round(furnAfaCY * fA[i]) - mgmt[i] - intC[i])
    const taxable = applyLossCarry(base)
    base.forEach(b => profitCY.push(b))
    taxCY = taxable.map(t => Math.max(0, Math.round(t * sdTaxRate)))
    taxDE = Array(10).fill(0)
    taxU = taxCY
  } else if (holder === 'firma') {
    // ── Zyprische Ltd haelt die Wohnung ──────────────────────────────────────
    // Kein Grundfreibetrag, kein 20-%-Pauschalabzug; dafuer fester Satz und
    // Verlustvortrag. Danach die Ausschuettung an den Gesellschafter.
    const base = rents.map((r, i) => r - Math.round(dCY * fA[i]) - Math.round(furnAfaCY * fA[i]) - mgmt[i] - intC[i])
    base.forEach(b => profitCY.push(b))
    const taxable = applyLossCarry(base)
    taxCY = taxable.map(t => Math.max(0, Math.round(t * corpTaxPct / 100)))
    taxDE = base.map((b, i) => {
      const afterTax = b - taxCY[i]
      if (afterTax <= 0) return 0
      return Math.round(afterTax * (divPayoutPct / 100) * (divTaxPct / 100))
    })
    taxU = taxCY.map((t, i) => t + taxDE[i])
  } else {
    // Gewerbliche Kurzzeitvermietung: echte Kosten (Verwaltung) statt Pauschale.
    // Die 20-%-Pauschale gilt fuer die passive (Langzeit-)Vermietung.
    const cyBusiness = p.cyBusiness ?? (letT === 'short')
    taxCY = rents.map((r, i) => {
      const furnAfa = Math.round(furnAfaCY * fA[i])
      const d = Math.round(dCY * fA[i])
      const m2 = cyBusiness ? mgmt[i] : Math.round(r * CY_RENT_FLAT_DEDUCTION)
      const tx = r - d - furnAfa - m2 - intC[i]
      profitCY.push(tx)
      const inc = resCY ? Math.max(0, cyTax(cyBI + Math.max(0, tx)) - cyTax(cyBI)) : cyTax(Math.max(0, tx))
      // GESY ist keine Einkommensteuer (in Deutschland auch nicht anrechenbar),
      // faellt aber real an - deshalb in derselben Zeile mitgefuehrt.
      return inc + gesyA[i]
    })
    const bDE = pGross * 0.8; let rDE = bDE
    const dDE: number[] = []
    for (let k2 = 0; k2 < 10; k2++) { const d2 = Math.round(rDE * 0.05 * fA[k2]); dDE.push(d2); rDE = Math.max(0, rDE - d2) }
    const deR = deTx / 100
    taxDE = resCY ? Array(10).fill(0) : rents.map((r, i) => {
      const furnAfa = i < 5 ? Math.round(furnAfaDE * fA[i]) : 0
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

  // Einrichtung steckt bereits in ekStart/loan (Gesamtinvestition) — daher hier
  // NICHT erneut auf das IRR-Eigenkapital aufaddieren, sonst doppelt gezählt.
  const cfIRR = [-ekStart].concat(cfA); cfIRR[cfIRR.length - 1] += ek10
  const irrV = irrCalc(cfIRR)
  const mRate = rateC[0] / Math.max(1, mF)
  const mCF = cfA[0] / Math.max(1, mF)

  // Bruttorendite auf den GESAMTPREIS inkl. bezahlter Einrichtung (Sven 11.8.26).
  // Ohne/bei kostenloser Einrichtung ist totalGross == pGross → unverändert.
  const effYield = totalGross > 0 ? baseR / totalGross * 100 : yPct
  return {
    km, ky, mA, fA, yN, pNet, pNetList, pGross, pGrossList, vatAmt, costs, loan, ekStart, ekAbs,
    fin, letT, hotelConcept, mode, resCY, cyBI, yPct, effYield, rG, mgP, iP, termY, amP, appP, deTx,
    discountPct, discountAmt, bedrooms,
    sdMode, sdNumUnits, sdTotalSqm, sdTotalTerr, sdVatDrawn, sdVatYears, sdVatClawback, sdTaxRate,
    rents, mgmt, intC, princC, rateC, restL, prepayC, propV, vatA, taxCY, taxDE, taxU, cfA,
    holder, corpTaxPct, divTaxPct, divPayoutPct, gesyA, profitCY,
    sumR, sumC, sumT, sumVat, sumPP, sumCF, ek10, totRet, roe10, irrV, mRate, mCF, mF,
    furnCost, furnFree, furnForIRR, furnVat, furnGross,
    vatMode: sdMode ? 'standard19' : (p.vatMode ?? 'standard19'), livingSqm: Math.max(0, p.livingSqm ?? 0), vatDetail,
  }
}
