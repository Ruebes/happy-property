// Erklaertexte zu Kredit und Wohnungen (Sven 8.10.26: „unter jede Tabelle
// einen ausfuehrlichen Text"):
//   creditPath  Abschnitt 9c „Wann du einen Kredit brauchst" (Kaesten + Ratentabelle)
//   loans       Kasten „Daraus werden diese Bankdarlehen"
//   timeline    Abschnitt 9b „Was wann passiert"
//   properties  Abschnitt 7 „Deine Wohnungen" (Karten)
//
// Feste Texte: strategie.guide.<id>.* in den Sprachdateien. Alle Zahlen kommen
// aus CustomerAnalytics und werden genauso gerundet wie auf der Seite
// (Strategie.tsx blendet Zellen <= 0,50 € aus). Rechenaussagen werden in
// checkGuides() mit einem eigenen Rechenweg nachgeprueft.
//
// Nie Namen aus den Daten ausgeben (Wohnungs- oder Projektnamen): die Texte
// sprechen von „der ersten Karte", „einer Wohnung" usw.
import type { CustomerAnalytics, PropertyCard } from '../analytics'
import type { BankLoanInfo, FinancingPath, FinancingStep } from '../strategy'
import { eur, num, mmYYYY } from './types'
import type { Guide, GuideCtx, GuideItem } from './types'

type Vars = Record<string, string | number>

const R = Math.round
// Zelle sichtbar? (gleiche Schwelle wie Strategie.tsx)
const shown = (n: number): boolean => n > 0.5
// Was in der Zelle steht, als Zahl (leere Zelle = 0)
const cellVal = (n: number): number => (shown(n) ? R(n) : 0)
// Formatierung wie Strategie.tsx (pct, mmyyyy)
const pct = (n: number): string => (isFinite(n) ? n.toFixed(1).replace('.', ',') : '0') + ' %'
const mmyyyy = (m: number, y: number): string => `${String(m).padStart(2, '0')}/${y}`
const ymCard = (y: number, m: number): number => y * 12 + (m - 1)

// Feste Saetze aus analytics.ts (Zeitachse). Die Eintraege kommen dort fest auf
// Deutsch aus der Rechnung; erkannt wird, welche Satzarten vorkommen.
const TL = {
  plan: 'Zahlungsplan:',
  rentOnly: 'Ab hier fließt Miete.',
  rentLoan: 'Zins und Tilgung laufen',
  after: 'an den Bauträger, zuzüglich',
  from: 'Davon kommen ',
  rest: 'Die restlichen ',
  loanFrom: 'Das Bankdarlehen läuft ab ',
  cashGap: 'Für den Barkauf fehlen ',
  handoverPrefix: 'Übergabe ',
  buyPrefix: 'Kauf ',
  salePrefix: 'Verkauf ',
  refi: 'Refinanzierung',
}

interface Tx {
  s: (k: string, v?: Vars) => string
  item: (key: string, v?: Vars) => GuideItem
  list: (parts: string[]) => string
}
function tx(ctx: GuideCtx, id: string): Tx {
  const base = `strategie.guide.${id}`
  const s = (k: string, v?: Vars): string => String(ctx.t(`${base}.${k}`, { ...(v ?? {}) }))
  return {
    s,
    item: (key, v) => ({ label: s(`items.${key}.label`, v), text: s(`items.${key}.text`, v) }),
    list: parts => parts.length <= 1 ? (parts[0] ?? '')
      : `${parts.slice(0, -1).join(', ')} ${s('and')} ${parts[parts.length - 1]}`,
  }
}
// Texte der Seite selbst (Abschnittstitel, Spalten), damit Verweise immer passen
const page = (ctx: GuideCtx, key: string, v?: Vars): string => String(ctx.t(`strategie.${key}`, { ...(v ?? {}) }))
function sections(ctx: GuideCtx): Vars {
  return {
    s5: page(ctx, 's5'), s6: page(ctx, 's6'), s7: page(ctx, 's7'), s9: page(ctx, 's9'), s10: page(ctx, 's10'),
    zinsen: page(ctx, 'tInterest'), toPay: page(ctx, 'tToPay'), fDebt: page(ctx, 'fDebt'), irr: page(ctx, 'scIrr'),
    credLoans: page(ctx, 'credLoans'), credTitle: page(ctx, 'credTitle'),
  }
}

// ── Fachbegriffe erklaeren ───────────────────────────────────────────────────
// Welche Zeilen ein Block zeigt, haengt vom Plan ab. Damit jeder Fachbegriff
// erklaert ist, bevor man ihn liest, haengt dieser Schritt an die Einleitung
// kurze Erklaersaetze („Kurz erklärt: …") fuer jeden Begriff, der im Block
// vorkommt (auch in den Zeilen-Beschriftungen) und nicht schon dort, wo er
// zuerst steht, oder im Satz danach erklaert ist. Regeln je Sprache in
// strategie.guide.creditPath.terms.<id> (re, known, def; leeres re = aus).
// Reihenfolge: Begriffe, deren Erklaerung einen anderen Begriff enthaelt, zuerst.
const TERM_IDS = ['ueb', 'vat', 'refi', 'rest', 'darl', 'bt', 'tilg', 'abg', 'nk', 'reinv', 'erl']
interface Term { re: RegExp; known: RegExp; def: string }
function terms(ctx: GuideCtx): Term[] {
  const out: Term[] = []
  for (const id of TERM_IDS) {
    const base = `strategie.guide.creditPath.terms.${id}`
    const get = (k: string): string => {
      const v = String(ctx.t(`${base}.${k}`))
      return v === `${base}.${k}` ? '' : v
    }
    const re = get('re'), known = get('known'), def = get('def')
    if (!re || !known || !def) continue
    out.push({ re: new RegExp(re), known: new RegExp(known), def })
  }
  return out
}
// Ende des Satzes ab Position i (Index hinter dem Satzzeichen)
function sentenceEnd(s: string, i: number): number {
  const re = /[.!?](?=\s|$)/g
  re.lastIndex = i
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const before = s.slice(Math.max(0, m.index - 4), m.index)
    if (/bzw$|z\. B$|ca$|ggf$|inkl$|e\.g$|i\.e$/.test(before)) continue
    return m.index + 1
  }
  return s.length
}
// Bis wohin eine vorhandene Erklaerung noch als „dort erklaert" zaehlt:
// Satz mit dem Begriff und der Satz danach
const knownLimit = (s: string, idx: number): number => sentenceEnd(s, Math.min(s.length, sentenceEnd(s, idx) + 1))
// Lesereihenfolge des Blocks (Beschriftungen zaehlen beim Suchen mit)
const readText = (g: Guide): string =>
  [g.intro, ...g.items.flatMap(i => [i.label, i.text]), g.example ?? '', ...g.meaning, ...g.pitfalls].join('\n')
function defineTerms(ctx: GuideCtx, g: Guide, list: Term[]): Guide {
  const add: string[] = []
  const lead = String(ctx.t('strategie.guide.creditPath.termsLead'))
  for (const term of list) {
    const intro = add.length ? `${g.intro} ${lead} ${add.join(' ')}` : g.intro
    const full = readText({ ...g, intro })
    const u = term.re.exec(full)
    if (!u) continue
    const k = term.known.exec(full)
    if (k && k.index <= knownLimit(full, u.index)) continue
    add.push(term.def)
  }
  return add.length ? { ...g, intro: `${g.intro} ${lead} ${add.join(' ')}` } : g
}

// ── gemeinsame Rechenhelfer (auch von checkGuides genutzt) ───────────────────
const ownCards = (a: CustomerAnalytics): PropertyCard[] => a.properties.filter(p => !p.model)
// Geldquellen einer Karte, wie sie dort stehen (ohne Gesamtpreis)
function cardSources(p: PropertyCard): number {
  return p.equity + (p.fromSurplus ?? 0) + (p.loan > 0 ? p.loan : 0) + (p.openRest ?? 0) + (p.openCredit ?? 0)
}
// Kaufnebenkosten einer Karte: Summe der Geldquellen minus Gesamtpreis
// (Gesamtpreis + Nebenkosten = Eigenkapital + Miete/MwSt + Kredit + offene Raten)
const cardCosts = (p: PropertyCard): number => cardSources(p) - p.gross
const costsPlausible = (p: PropertyCard): boolean => {
  const c = cardCosts(p)
  return c > 0 && c <= R(p.gross * 0.01) + 1
}
const endYearOf = (a: CustomerAnalytics, p: PropertyCard): number => p.soldYear ?? a.summary.lastYear
function rowParts(r: FinancingStep): number {
  return cellVal(r.fromEquity) + cellVal(r.fromSurplus) + cellVal(r.credit)
}
// Erste farbig hinterlegte Zeile (Strategie.tsx: ym === firstCreditYm && credit > 0,5)
function highlighted(cp: FinancingPath): FinancingStep[] {
  return cp.firstCreditYm == null ? [] : cp.steps.filter(s => s.ym === cp.firstCreditYm && shown(s.credit))
}
function annuityMonthly(amount: number, ratePct: number, years: number): number {
  const i = ratePct / 100, n = Math.max(1, years)
  if (amount <= 0) return 0
  return (i === 0 ? amount / n : amount * (i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1)) / 12
}
const normalLoans = (cp: FinancingPath): BankLoanInfo[] => cp.loans.filter(l => !l.open && !l.afterEnd)
// Kredit-Zellen je Wohnung in der Ratentabelle (nur bei eindeutigen Namen)
function unitCreditCells(cp: FinancingPath, name: string): number {
  return cp.steps.filter(s => s.unit === name).reduce((x, s) => x + cellVal(s.credit), 0)
}
const uniqueLoanNames = (cp: FinancingPath): boolean => new Set(cp.loans.map(l => l.name)).size === cp.loans.length
const uniqueOwnNames = (a: CustomerAnalytics): boolean => new Set(ownCards(a).map(p => p.name)).size === ownCards(a).length
// Karte ganz aus Eigenkapital bezahlt (kein Darlehen, kein Miete-Anteil, nichts offen)
const fullEquityCard = (p: PropertyCard): boolean => p.loan === 0 && !p.openCredit && !p.fromSurplus && !p.openRest
// Wohnungen ohne Darlehen, bei denen die Ratentabelle trotzdem Kredit zeigt
// (ohne Liquiditaetsrechnung verteilt die Tabelle das Eigenkapital nur nach Datum)
function cashCreditCards(a: CustomerAnalytics, cp: FinancingPath): Array<{ p: PropertyCard; credit: number }> {
  if (!uniqueOwnNames(a)) return []
  return ownCards(a).filter(fullEquityCard)
    .map(p => ({ p, credit: unitCreditCells(cp, p.name) }))
    .filter(x => x.credit > 0)
}
// Liegen Raten nach dem Ende des Plans (nicht in der Ratentabelle)?
function ratesCut(a: CustomerAnalytics): boolean {
  return ownCards(a).some(p => !!p.openRest || p.readyYear > endYearOf(a, p))
    || a.timeline.some(e => e.kind === 'handover' && e.detail.includes(TL.rest))
}
// Darlehen laufen alle gleichzeitig? (Bedingung fuer den Summensatz)
function loansTogether(a: CustomerAnalytics, cp: FinancingPath, termYears: number): { from: number; list: BankLoanInfo[] } | null {
  const list = normalLoans(cp)
  if (list.length < 2) return null
  const from = Math.max(...list.map(l => l.startYm))
  const first = Math.min(...list.map(l => l.startYm))
  if (from > a.summary.lastYear * 12 + 11) return null
  if (first + Math.max(1, termYears) * 12 <= from) return null
  const ok = list.every(l => {
    const p = a.properties.find(x => x.key === l.key)
    return !p || p.soldYear == null || p.soldYear > Math.floor(from / 12)
  })
  return ok ? { from, list } : null
}
// Wohnungen, bei denen der Plan vor der Uebergabe endet: was zieht
// „davon dir gehoerend" dort NICHT ab? (analytics.ts: devDebt = 0 vor der
// Uebergabe, Bankrestschuld wegen des Darlehensaufschubs teils 0)
type EarlyKind = 'none2' | 'rates' | 'credit' | null
function earlyKind(p: PropertyCard): EarlyKind {
  const ded = p.valueEnd - p.equityEnd
  const credit = (p.loan > 0 ? p.loan : 0) + (p.openCredit ?? 0)
  if (credit > 0 && ded <= 1) return p.openRest ? 'none2' : 'credit'
  // Abgezogen ist hoechstens der Kredit, die offenen Raten nicht
  if (p.openRest && ded <= credit + 1) return 'rates'
  return null
}
const creditLabelKey = (p: PropertyCard): string => p.creditSoFar ? 'pCreditSoFar' : p.loan > 0 ? 'pLoan' : 'pOpenCredit'

// ── 9c: Kaesten + Ratentabelle ──────────────────────────────────────────────
function creditPathGuide(ctx: GuideCtx): Guide | null {
  const { a } = ctx
  const cp = a.creditPath
  if (!cp || cp.steps.length === 0) return null
  const T = tx(ctx, 'creditPath')
  const sec = sections(ctx)
  const withSurplus = cp.steps.some(s => shown(s.fromSurplus))
  const withInterest = cp.steps.some(s => shown(s.interest))
  const hasCredit = cp.firstCreditYm != null
  const anyCredit = shown(cp.creditTotal)
  const cash = a.cashUnitsReserved
  const q = T.s(a.surplusWithVat ? 'q.vat' : 'q.rent')
  const lastRow = cp.steps[cp.steps.length - 1]
  const hl = highlighted(cp)
  const hlRow = hl[0]
  // Barkaeufe mit reserviertem Eigenkapital zaehlen in den Kaesten nicht mit
  const fin = cash ? T.s('fin') : ''
  const early = hasCredit && cp.steps.some(s => shown(s.credit) && s.ym < (cp.firstCreditYm as number))

  // Kaesten: gleiche Fallunterscheidung wie Strategie.tsx, Kastenwerte von der Seite
  const eqVal = cp.firstCreditYm == null && !withSurplus ? page(ctx, 'credAllCovered')
    : cp.equityLastYm != null ? mmYYYY(cp.equityLastYm) : page(ctx, 'credFirstRate')
  const eqKey = cp.firstCreditYm == null && !withSurplus ? (anyCredit ? 'eqUntilAllCash' : 'eqUntilAll')
    : cp.equityLastYm != null
      ? (hasCredit ? 'eqUntil'
        : cp.steps.some(s => s.ym > (cp.equityLastYm as number) && shown(s.fromSurplus)) ? 'eqUntilNoCredit' : 'eqUntilNoCreditLast')
      : (cash ? 'eqUntilFirstCash' : 'eqUntilFirst')
  const fromVal = hasCredit ? mmYYYY(cp.firstCreditYm as number)
    : withSurplus ? page(ctx, a.surplusWithVat ? 'credNoneSurplus' : 'credNoneRent') : page(ctx, 'credNone')
  // Erst pruefen, ob Kredit aus einem Barkauf da ist, dann die Miete-Varianten
  const fromKey = hasCredit ? (hl.length > 1 ? 'fromMulti' : 'from')
    : anyCredit ? (withSurplus ? (a.surplusWithVat ? 'fromNoneSurplusCash' : 'fromNoneRentCash') : 'fromNoneCash')
      : withSurplus ? (a.surplusWithVat ? 'fromNoneSurplus' : 'fromNoneRent') : 'fromNone'
  const items: GuideItem[] = [
    T.item(eqKey, { v: eqVal, fin, quelle: q }),
    T.item(fromKey, { v: fromVal, fin }),
    ...['total', 'date', 'rate', 'amount', 'equity'].map(k => T.item(k)),
    ...(withSurplus ? [T.item(a.surplusWithVat ? 'surplus' : 'surplusRent')] : []),
    T.item('credit'), T.item(shown(lastRow.creditTotal) ? 'cumul' : 'cumulNone'),
    ...(withInterest ? [T.item('interest')] : []),
  ]

  // Beispiel
  const ex: string[] = []
  const kredit = (r: FinancingStep): string => (R(r.amount) !== rowParts(r) ? T.s('ex.rund') : '') + eur(r.credit)
  if (hasCredit && hlRow) {
    const kreditAb = mmYYYY(cp.firstCreditYm as number)
    const same = cp.equityLastYm === cp.firstCreditYm
    if (cp.equityLastYm == null) ex.push(T.s(cash ? 'ex.firstEqNoneCash' : 'ex.firstEqNone'))
    else if (same) ex.push(T.s('ex.firstEqSame', { kreditAb, fin }))
    else ex.push(T.s('ex.firstEq', { eqBis: mmYYYY(cp.equityLastYm), fin }))
    ex.push(T.s(same ? 'ex.rowSame' : hl.length > 1 ? 'ex.rowMulti' : 'ex.row', { kreditAb, betrag: eur(hlRow.amount) }))
    const eq = shown(hlRow.fromEquity), sur = shown(hlRow.fromSurplus)
    const v = { ausEk: eur(hlRow.fromEquity), ausMiete: eur(hlRow.fromSurplus), quelle: q, kredit: kredit(hlRow),
      noch: cp.equityLastYm == null ? '' : T.s('ex.noch') }
    ex.push(T.s(eq && sur ? 'ex.eqSur' : eq ? 'ex.eqOnly' : sur ? 'ex.surOnly' : 'ex.noneLeft', v))
    ex.push(R(cp.creditTotal) > R(hlRow.credit) ? T.s('ex.rest', { gesamt: eur(cp.creditTotal) }) : T.s('ex.restNone'))
  }
  const lastSentence = (r: FinancingStep): string | null => {
    const parts: Array<{ key: string; one: string; v: number }> = []
    if (shown(r.fromEquity)) parts.push({ key: 'ex.partEq', one: 'ex.oneEq', v: r.fromEquity })
    if (shown(r.fromSurplus)) parts.push({ key: 'ex.partSur', one: 'ex.oneSur', v: r.fromSurplus })
    if (shown(r.credit)) parts.push({ key: 'ex.partCredit', one: 'ex.oneCredit', v: r.credit })
    if (!parts.length) return null
    const zins = shown(r.interest) ? ' ' + T.s('ex.lastInterest', { zinsen: eur(r.interest) }) : ''
    const base = { faellig: mmYYYY(r.ym), betrag: eur(r.amount), zins }
    if (parts.length === 1) return T.s('ex.lastOne', { ...base, teil: T.s(parts[0].one, { quelle: q }) })
    const rund = R(r.amount) !== rowParts(r) ? T.s('ex.rund') : ''
    const txt = parts.map((p, i) => T.s(p.key, { v: (i === parts.length - 1 ? rund : '') + eur(p.v), quelle: q }))
    return T.s('ex.last', { ...base, teile: T.list(txt) })
  }
  if (hasCredit && hlRow) {
    if (lastRow !== hlRow && (shown(lastRow.fromSurplus) || shown(lastRow.interest))) {
      const s = lastSentence(lastRow)
      if (s) ex.push(s)
    }
  } else if (!hasCredit && !withSurplus && !anyCredit) {
    const summe = eur(cp.steps.reduce((x, s) => x + R(s.amount), 0))
    ex.push(T.s(cp.steps.length === 1 ? 'ex.noCredit1' : cp.steps.length === 2 ? 'ex.noCredit2' : 'ex.noCredit',
      { n: cp.steps.length, summe, letzte: mmYYYY(lastRow.ym), null: eur(0) }))
  } else {
    const s = lastSentence(lastRow)
    if (s) ex.push(s)
  }

  // Bedeutung
  const m: string[] = []
  if (hasCredit) {
    const first = cp.firstCreditYm as number
    const kreditAb = mmYYYY(first)
    if (early) m.push(T.s('m.needEarly', { kreditAb }))
    else if (cp.equityLastYm == null) m.push(T.s(cash ? 'm.startCash' : 'm.start', { kreditAb }))
    else if (cp.equityLastYm === first) m.push(T.s('m.same', { kreditAb }))
    else m.push(T.s('m.need', { kreditAb }))
  } else if (anyCredit) m.push(T.s('m.cashOnlyCredit', { gesamt: eur(cp.creditTotal) }))
  else if (!withSurplus) m.push(T.s('m.noneEq'))
  else m.push(T.s(a.surplusWithVat ? 'm.noneSurplusVat' : 'm.noneSurplusRent'))
  if (cash) m.push(T.s('m.cashRes'))
  // Ohne Liquiditaetsrechnung binden Barkaeufe immer den vollen Preis als
  // Eigenkapital (strategy.ts allocateBase), auch wenn das Startkapital nicht reicht
  const eqCells = cp.steps.reduce((x, s) => x + cellVal(s.fromEquity), 0)
  if (eqCells > a.summary.originalEquity + 1 && ownCards(a).some(p => p.loan === 0 && !p.openCredit))
    m.push(T.s('m.overEquity', { ek: eur(eqCells), start: eur(a.summary.originalEquity) }))
  // Wohnung ohne Darlehen, aber mit Kredit-Zellen (Eigenkapital nach Datum verteilt)
  const cc = cashCreditCards(a, cp)
  if (cc.length) m.push(T.s(cc.length === 1 ? 'm.cashCredit1' : 'm.cashCreditN',
    { n: cc.length, kredit: eur(cc.reduce((x, c) => x + c.credit, 0)), darlehen: page(ctx, 'pLoan') }))
  if (a.reinvest) {
    const res = shown(a.minimumReserve)
    const costs = ownCards(a).reduce((x, p) => x + p.equity, 0) - R(cp.equity)
    // „deshalb" nur, wenn Startkapital minus Reserve minus Nebenkosten genau das Eingeplante ist
    const exact = Math.abs(a.summary.originalEquity - (res ? R(a.minimumReserve) : 0) - costs - R(cp.equity)) <= 1
    const key = cp.equity > a.summary.originalEquity + 1 ? 'm.reinvestOver' : exact ? 'm.reinvest' : 'm.reinvestPart'
    m.push(T.s(`${key}${res ? '' : 'NoReserve'}`, { reserve: eur(a.minimumReserve), ek: eur(cp.equity) }))
  }
  if (withSurplus) {
    const firstSur = cp.steps.find(s => shown(s.fromSurplus)) as FinancingStep
    // Summe ungerundet (wie Karte und Zeitachse), nicht die Summe der gerundeten Zellen
    m.push(T.s('m.surplus', { ...sec, ab: mmYYYY(firstSur.ym), quelle: q, summe: eur(cp.steps.reduce((x, s) => x + s.fromSurplus, 0)) }))
  }
  if (withInterest) m.push(T.s('m.interest', { ...sec, summe: eur(cp.steps.reduce((x, s) => x + s.interest, 0)) }))
  if (hasCredit && hlRow && withSurplus) {
    const i0 = cp.steps.indexOf(hlRow)
    if (cp.steps.slice(i0 + 1).some(s => !shown(s.credit) && shown(s.fromSurplus))) m.push(T.s('m.again', { quelle: q }))
  }
  if (a.vatReturned.length > 0) {
    const n = new Set(a.vatReturned.map(v => v.name)).size
    m.push(T.s(n === 1 ? 'm.vatReturned1' : 'm.vatReturnedN', { n }))
  }
  const open = ownCards(a).filter(p => p.openRest)
  if (open.length) {
    const labels = [...new Set(open.map(p => page(ctx, p.openRestFromSale ? 'pOpenSale' : 'pOpenAfter')))]
    m.push(T.s('m.openRest', { labels: T.list(labels.map(l => T.s('quote', { l }))) }))
  }

  // Nebenkosten: ohne Reinvestment zahlt der Kunde sie zusaetzlich zum Startkapital
  // (strategy.ts allocateBase), sofern das Startkapital ganz in die Kaufpreise geht
  const costsExtra = !a.reinvest && R(cp.equity) >= a.summary.originalEquity - 1
  const sameMonth = hasCredit && (cp.steps.filter(s => s.ym === cp.firstCreditYm).length > 1 || cp.equityLastYm === cp.firstCreditYm)
  const pitfalls = [
    ...(anyCredit ? [T.s('pitfalls.notDebt', sec), T.s('pitfalls.interest', sec)] : []),
    T.s(costsExtra ? 'pitfalls.costsExtra' : 'pitfalls.costs'),
    ...(sameMonth ? [T.s('pitfalls.sameMonth')] : []),
    T.s('pitfalls.shift'),
    ...(withInterest ? [T.s('pitfalls.devInterest', sec)] : []),
    T.s('pitfalls.round'),
    T.s('pitfalls.model'),
  ]
  return {
    heading: T.s('heading'), intro: T.s('intro'), items,
    example: ex.length ? ex.join(' ') : null,
    meaning: m, pitfalls,
  }
}

// ── 9c: Bankdarlehen ────────────────────────────────────────────────────────
function loansGuide(ctx: GuideCtx): Guide | null {
  const { a, params } = ctx
  const cp = a.creditPath
  if (!cp || cp.steps.length === 0 || cp.loans.length === 0) return null
  const T = tx(ctx, 'loans')
  const sec = sections(ctx)
  const zero = params.interest === 0
  const afterLoan = cp.loans.find(l => l.afterEnd && !l.sold)
  const itemKeys = ['apt', 'loan', 'start', zero ? 'monthly0' : 'monthly',
    ...(cp.loans.some(l => l.open) ? ['open'] : []),
    ...(cp.loans.some(l => l.sold) ? ['sold'] : [])]
  const items = itemKeys.map(k => T.item(k, sec))
  if (afterLoan) items.push(T.item('after', { d: mmYYYY(afterLoan.startYm) }))

  const S = cp.loans.reduce((x, l) => x + R(l.amount), 0)
  const sumMatches = S === R(cp.creditTotal)

  // Beispiel: erste Zeile mit normaler Monatsrate
  let example: string | null = null
  const l = normalLoans(cp)[0]
  if (l) {
    const card = a.properties.find(c => c.key === l.key)
    const saleYear = card?.soldYear ?? (a.exitTotal != null && a.exits.length ? a.exits[0].year : null)
    const v = {
      welche: T.s(l === cp.loans[0] ? 'ex.first' : 'ex.firstRate'),
      darlehen: eur(l.amount), start: mmYYYY(l.startYm), rate: eur(l.monthly),
      zins: num(params.interest),
      laufzeit: T.s(params.termYears === 1 ? 'ex.year1' : 'ex.years', { n: params.termYears }),
      jahr: saleYear ?? '',
    }
    const parts: string[] = []
    if (saleYear != null && saleYear * 12 + 11 < l.startYm) {
      // Verkauf schon vor dem Start der Monatsrate: sie wird im Plan nie gezahlt
      parts.push(T.s(zero ? 'ex.mainSoldBefore0' : 'ex.mainSoldBefore', v))
    } else {
      parts.push(T.s(zero ? 'ex.main0' : 'ex.main', v))
      // Endet der Plan mit dem Verkauf dieser Wohnung, loest der Erloes die Restschuld ab
      parts.push(saleYear != null && saleYear * 12 + 11 < l.startYm + Math.max(1, params.termYears) * 12
        ? T.s('ex.paidOffSale', v) : T.s('ex.paidOff'))
      if (cp.firstCreditYm != null && cp.firstCreditYm < l.startYm) parts.push(T.s(zero ? 'ex.early0' : 'ex.early', { kreditAb: mmYYYY(cp.firstCreditYm) }))
    }
    if (sumMatches) parts.push(cp.loans.length > 1 ? T.s('ex.sum', { summe: eur(S) }) : T.s('ex.sumOne'))
    example = parts.join(' ')
  }

  // Bedeutung
  const m: string[] = []
  const tog = loansTogether(a, cp, params.termYears)
  if (tog) m.push(T.s(tog.list.length === 2 ? 'm.together2' : 'm.together', { ...sec, ab: mmYYYY(tog.from), n: tog.list.length, summe: eur(tog.list.reduce((x, y) => x + R(y.monthly), 0)) }))
  let pooled = false
  if (uniqueLoanNames(cp)) {
    const diffs = cp.loans.map(x => Math.abs(unitCreditCells(cp, x.name) - R(x.amount)))
    const maxD = Math.max(...diffs)
    if (maxD === 0) m.push(T.s('m.matchExact'))
    else if (maxD <= 3) m.push(T.s(maxD === 1 ? 'm.matchRound1' : 'm.matchRound'))
    else pooled = true
  }
  const opens = cp.loans.filter(x => x.open)
  if (opens.length) m.push(T.s(opens.length === 1 ? 'm.open1' : 'm.openN', { n: opens.length, betrag: eur(opens.reduce((x, y) => x + R(y.amount), 0)) }))
  const solds = cp.loans.filter(x => x.sold)
  if (solds.length) m.push(T.s(solds.length === 1 ? 'm.sold1' : 'm.soldN', { n: solds.length, betrag: eur(solds.reduce((x, y) => x + R(y.amount), 0)) }))
  if (afterLoan) m.push(T.s('m.after', { start: mmYYYY(afterLoan.startYm), betrag: eur(afterLoan.amount) }))

  const pitfalls = [T.s('pitfalls.costs'), T.s('pitfalls.start', sec), ...(zero ? [] : [T.s('pitfalls.interest', sec)]), T.s('pitfalls.assume')]
  if (pooled && sumMatches) pitfalls.push(T.s('pitfalls.pooled'))
  if (!sumMatches) {
    // Bekannter Fall: Wohnung vor ihrer Uebergabe verkauft, Darlehen trotzdem mit Rate gelistet
    const soldEarly = normalLoans(cp).some(x => {
      const p = a.properties.find(c => c.key === x.key)
      return !!p && p.readyYear > endYearOf(a, p)
    })
    const v = { summe: eur(S), gesamt: eur(cp.creditTotal) }
    const cut = ratesCut(a)
    if (soldEarly) pitfalls.push(T.s('pitfalls.mismatchSold', v))
    else if (cashCreditCards(a, cp).length) pitfalls.push(T.s('pitfalls.mismatchCash', v) + (cut ? ' ' + T.s('pitfalls.mismatchCutAlso') : ''))
    else pitfalls.push(T.s('pitfalls.mismatch', v) + (cut ? ' ' + T.s('pitfalls.mismatchCut') : ''))
  }
  return { heading: T.s('heading'), intro: T.s('intro'), items, example, meaning: m, pitfalls }
}

// ── 9b: Zeitachse ───────────────────────────────────────────────────────────
function timelineGuide(ctx: GuideCtx): Guide | null {
  const { a } = ctx
  if (a.timeline.length === 0) return null
  const T = tx(ctx, 'timeline')
  const sec = sections(ctx)
  const kinds = new Set(a.timeline.map(e => e.kind))
  const details = a.timeline.map(e => e.detail)
  const has = (frag: string) => details.some(d => d.includes(frag))
  const hand = a.timeline.filter(e => e.kind === 'handover').map(e => e.detail)
  const cp = a.creditPath && a.creditPath.steps.length > 0 ? a.creditPath : null

  const dots = [
    ...(kinds.has('buy') || kinds.has('handover') ? [T.s('dot.grey')] : []),
    ...(kinds.has('purchase') ? [T.s('dot.blue')] : []),
    ...(kinds.has('refinance') ? [T.s('dot.green')] : []),
    ...(kinds.has('sale') ? [T.s('dot.coral')] : []),
  ]
  const intro = [T.s('intro'), T.s('dots', { list: T.list(dots) })].join(' ')

  const keys: string[] = []
  if (kinds.has('buy')) keys.push('buy')
  if (kinds.has('purchase')) keys.push('buyModel')
  if (has(TL.plan)) keys.push(cp ? 'planTable' : 'plan')
  if (kinds.has('handover')) keys.push('handover')
  if (hand.some(d => d.startsWith(TL.rentOnly))) keys.push('rentOnly')
  if (hand.some(d => d.includes(TL.rentLoan))) keys.push('rentLoan')
  if (has(TL.after)) keys.push('after')
  if (has(TL.from)) keys.push('from')
  if (has(TL.rest)) keys.push('rest')
  if (has(TL.loanFrom)) keys.push(cp && cp.loans.length ? 'loanFromTable' : 'loanFrom')
  if (has(TL.cashGap)) keys.push('cashGap')
  if (kinds.has('refinance')) keys.push('refi')
  if (kinds.has('sale')) keys.push('sale')

  // Beispiel: erste eigene Wohnung (Reihenfolge der Kauf-Eintraege) mit Bauzeit
  let example: string | null = null
  const own = [...ownCards(a)].sort((x, y) => x.buyYear - y.buyYear)
  const p = own.find(c => ymCard(c.readyYear, c.readyMonth) - ymCard(c.buyYear, c.buyMonth) > 0)
  if (p) {
    const readyYm = ymCard(p.readyYear, p.readyMonth)
    const parts = [T.s('ex.main', {
      kauf: mmyyyy(p.buyMonth, p.buyYear), uebergabe: mmyyyy(p.readyMonth, p.readyYear),
      monate: readyYm - ymCard(p.buyYear, p.buyMonth),
    })]
    const endY = endYearOf(a, p)
    if (p.readyYear > endY) parts.push(T.s('ex.afterEnd', { ende: endY }))
    else {
      const l = cp?.loans.find(x => x.key === p.key && !x.open && !x.afterEnd)
      if (l && l.startYm > readyYm) parts.push(T.s('ex.loanLater', { start: mmYYYY(l.startYm) }))
      else if ((l && l.startYm === readyYm) || (!cp && p.loan > 0 && !p.creditSoFar)) parts.push(T.s('ex.loanSame'))
    }
    example = parts.join(' ')
  }

  // Bedeutung
  const m: string[] = []
  if (a.exitTotal != null && a.exits.length) m.push(T.s('m.exit', { ...sec, jahr: a.exits[0].year }))
  // nur wenn Raten nach der Uebergabe wirklich im Plan liegen (Satz „… zuzüglich … Zinsen")
  if (hand.some(d => d.includes(TL.after))) m.push(T.s('m.after'))
  if (kinds.has('refinance')) {
    const summe = a.events.reduce((x, e) => x + (e.kind === 'refinance' ? R(e.newLoanAmount) : 0), 0)
    m.push(T.s('m.refi', { summe: eur(summe) }))
  }
  if (ownCards(a).some(c => c.buyYear === c.readyYear
    && !a.timeline.some(e => e.kind === 'handover' && e.label === TL.handoverPrefix + c.name))) m.push(T.s('m.sameYear'))
  const last = a.summary.lastYear
  if (a.timeline.some(e => e.year > last)) m.push(T.s(a.exitTotal != null ? 'm.afterPlanSale' : 'm.afterPlan', { ende: last }))

  const pitfalls = [T.s('pitfalls.years'), T.s('pitfalls.equity'),
    ...(kinds.has('refinance') ? [T.s('pitfalls.refi')] : []), T.s('pitfalls.dates')]
  return { heading: T.s('heading'), intro, items: keys.map(k => T.item(k, sec)), example, meaning: m, pitfalls }
}

// ── 7: Wohnungskarten ───────────────────────────────────────────────────────
function propertiesGuide(ctx: GuideCtx): Guide | null {
  const { a, params } = ctx
  if (a.properties.length === 0) return null
  const T = tx(ctx, 'properties')
  const sec = sections(ctx)
  const P = a.properties
  const own = ownCards(a)
  const models = P.some(p => p.model)
  const cp = a.creditPath && a.creditPath.steps.length > 0 ? a.creditPath : null
  const cpLoans = !!cp && cp.loans.length > 0
  const firstSold = P.find(p => p.soldYear != null)
  const growthCard = P.find(p => p.equityGrowthPct != null)
  const refis = a.events.filter(e => e.kind === 'refinance')
  const earlyCards = own.filter(p => p.readyYear > endYearOf(a, p))
  const earlyGaps = earlyCards.filter(p => earlyKind(p) != null)
  const karten = T.s(models ? 'karten.own' : 'karten.all')

  const items: GuideItem[] = [T.item('header')]
  if (models) items.push(T.item('model'))
  if (firstSold) items.push(T.item('sold', { y: firstSold.soldYear as number }))
  items.push(T.item('price'), T.item('equity'))
  if (P.some(p => p.fromSurplus)) items.push(T.item(a.surplusWithVat ? 'surplus' : 'surplusRent'))
  if (P.some(p => p.loan > 0 && !p.creditSoFar))
    items.push(T.item(!cpLoans ? 'loan' : P.some(p => p.model && p.loan > 0) ? 'loanTableModel' : 'loanTable', sec))
  if (P.some(p => p.loan > 0 && p.creditSoFar)) items.push(T.item('creditSoFar'))
  if (P.some(p => p.openRest && p.openRestFromSale)) items.push(T.item('openSale'))
  if (P.some(p => p.openRest && !p.openRestFromSale)) items.push(T.item('openAfter'))
  if (P.some(p => p.openCredit)) items.push(T.item('openCredit'))
  items.push(T.item('rent'))
  if (P.some(p => !p.soldYear)) items.push(T.item('value'))
  if (firstSold) items.push(T.item('valueSale'))
  items.push(T.item(earlyGaps.length ? 'equityEndEarly' : 'equityEnd'))
  if (P.some(p => p.netSaleProceeds != null)) items.push(T.item('net'))
  if (growthCard) items.push(T.item('growth', { n: growthCard.equityGrowthYears }))

  // Beispiel mit der ersten Karte (immer eine eigene Wohnung, Modellobjekte stehen hinten)
  let example: string | null = null
  const p0 = own[0]
  const surplusLabel = page(ctx, a.surplusWithVat ? 'pSurplus' : 'pSurplusRent')
  if (p0) {
    const ex: string[] = []
    if (costsPlausible(p0)) {
      const others: string[] = []
      if (p0.fromSurplus) others.push(T.s('ex.part', { label: surplusLabel, v: eur(p0.fromSurplus) }))
      if (p0.loan > 0) others.push(T.s('ex.part', { label: page(ctx, p0.creditSoFar ? 'pCreditSoFar' : 'pLoan'), v: eur(p0.loan) }))
      if (p0.openRest) others.push(T.s('ex.part', { label: page(ctx, p0.openRestFromSale ? 'pOpenSale' : 'pOpenAfter'), v: eur(p0.openRest) }))
      if (p0.openCredit) others.push(T.s('ex.part', { label: page(ctx, 'pOpenCredit'), v: eur(p0.openCredit) }))
      const diff = cardCosts(p0)
      if (others.length) {
        const weitere = others.length === 1 ? ` ${T.s('and')} ${others[0]}` : `, ${T.list(others)}`
        ex.push(T.s('ex.sum', { ek: eur(p0.equity), weitere, summe: eur(cardSources(p0)), diff: eur(diff), gesamt: eur(p0.gross) }))
      } else ex.push(T.s('ex.sumOnly', { ek: eur(p0.equity), diff: eur(diff), gesamt: eur(p0.gross) }))
      if (p0.equity === diff) {
        // Ohne Liquiditaetsrechnung verteilt die Ratentabelle das Eigenkapital nach
        // Datum - dort kann bei dieser Wohnung trotzdem Eigenkapital stehen
        const unique = uniqueOwnNames(a)
        const eqInTable = cp && unique ? cp.steps.filter(s => s.unit === p0.name).reduce((x, s) => x + cellVal(s.fromEquity), 0) : 0
        ex.push(T.s(!cp || (unique && eqInTable === 0) ? 'ex.onlyCosts' : unique ? 'ex.onlyCostsPooled' : 'ex.onlyCostsCard', sec))
      }
    }
    const endY = endYearOf(a, p0)
    if (p0.readyYear <= endY) {
      const schuld = p0.valueEnd - p0.equityEnd
      const zeit = T.s(p0.soldYear != null ? 'ex.zeitSale' : 'ex.zeitEnd', { jahr: endY })
      const v = { zeit, wert: eur(p0.valueEnd), gehoert: eur(p0.equityEnd), schuld: eur(schuld) }
      // Refinanzierungs-Kredite auf dieser Wohnung zieht die Karte nicht ab (analytics.ts debtEnd)
      const refi = refis.some(e => e.kind === 'refinance' && e.propertyKeys.includes(p0.key))
      // Nur Bank-Restschuld, wenn alle Raten an den Bautraeger bis zum Ende bezahlt
      // sind: das Bankdarlehen beginnt mit der letzten dieser Raten
      const l0 = cp?.loans.find(l => l.key === p0.key && !l.open && !l.afterEnd && !l.sold)
      const bankOnly = p0.loan > 0 && !p0.creditSoFar && !p0.openRest && !p0.openCredit
        && !!l0 && l0.startYm <= endY * 12 + 11 && schuld <= p0.loan
      ex.push(T.s(schuld > 0 ? (refi ? (bankOnly ? 'ex.valueRefiLoan' : 'ex.valueRefi') : 'ex.value')
        : (refi ? 'ex.valueFreeRefi' : 'ex.valueFree'), v))
    }
    if (ex.length) example = ex.join(' ')
  }

  // Bedeutung
  const m: string[] = []
  if (p0 && p0.readyMonth > 1 && p0.readyYear <= endYearOf(a, p0)) {
    const n = 13 - p0.readyMonth
    const v = { uebergabe: mmyyyy(p0.readyMonth, p0.readyYear), miete: eur(p0.rentFirstYear), n }
    let s = T.s(n === 1 ? 'm.rent1' : 'm.rentN', v)
    if (p0.readyYear + 1 <= endYearOf(a, p0)) s += ' ' + T.s('m.rentFull', { jahr: p0.readyYear + 1 })
    m.push(s)
  }
  const q = T.s(a.surplusWithVat ? 'q.vat' : 'q.rent')
  const surCards = P.filter(p => p.fromSurplus)
  if (surCards.length) m.push(T.s(surCards.length === 1 ? 'm.surplus1' : 'm.surplusN',
    { n: surCards.length, quelle: q, summe: eur(surCards.reduce((x, p) => x + (p.fromSurplus ?? 0), 0)) }))
  const openSale = P.filter(p => p.openRest && p.openRestFromSale)
  if (openSale.length) m.push(T.s(P.some(p => p.creditSoFar) ? 'm.openSaleCredit' : 'm.openSale',
    { summe: eur(openSale.reduce((x, p) => x + (p.openRest ?? 0), 0)) }))
  const openAfter = P.filter(p => p.openRest && !p.openRestFromSale)
  if (openAfter.length) m.push(T.s('m.openAfter', { ende: a.summary.lastYear, summe: eur(openAfter.reduce((x, p) => x + (p.openRest ?? 0), 0)) }))
  const oc = P.filter(p => p.openCredit)
  if (oc.length) m.push(T.s(oc.length === 1 ? 'm.openCredit1' : 'm.openCreditN', { n: oc.length, summe: eur(oc.reduce((x, p) => x + (p.openCredit ?? 0), 0)) }))
  if (own.length && own.every(costsPlausible)) {
    const sumEq = own.reduce((x, p) => x + p.equity, 0)
    const sumCosts = own.reduce((x, p) => x + cardCosts(p), 0)
    if (sumEq - sumCosts === a.summary.originalEquity)
      m.push(T.s(a.reinvest ? 'm.sumEq' : 'm.sumEqExtra', { karten, summe: eur(sumEq), start: eur(a.summary.originalEquity), nk: eur(sumCosts) }))
  }
  if (own.length && own.every(costsPlausible) && own.some(p => p.loan === 0 && !p.openCredit)) {
    // Barkauf ohne Liquiditaetsrechnung: voller Preis als Eigenkapital, auch ueber das Startkapital hinaus
    const intoPrices = own.reduce((x, p) => x + p.equity - cardCosts(p), 0)
    const sumEq = own.reduce((x, p) => x + p.equity, 0)
    if ((a.reinvest ? sumEq : intoPrices) > a.summary.originalEquity + 1)
      m.push(T.s('m.overEquity', { karten, summe: eur(sumEq), start: eur(a.summary.originalEquity) }))
  }
  if (a.exitTotal != null && a.exits.length) m.push(T.s('m.exit', { ...sec, jahr: a.exits[0].year }))
  const g = a.reinvest ? params.reinvestAppreciationPct : params.growth
  m.push(g === 0 ? T.s('m.growth0') : T.s('m.growth', { g: num(g) }))
  if (p0 && p0.equityGrowthPct != null) {
    const basis = p0.gross + cardCosts(p0) - (p0.loan > 0 ? p0.loan : 0)
    const gp = pct(p0.equityGrowthPct)
    // Die Basis steht nicht auf der Karte, laesst sich aber aus ihren Zeilen zusammenzaehlen
    const teile: string[] = []
    if (p0.fromSurplus) teile.push(T.s('ex.part', { label: surplusLabel, v: eur(p0.fromSurplus) }))
    if (p0.openRest) teile.push(T.s('ex.part', { label: page(ctx, p0.openRestFromSale ? 'pOpenSale' : 'pOpenAfter'), v: eur(p0.openRest) }))
    if (p0.openCredit) teile.push(T.s('ex.part', { label: page(ctx, 'pOpenCredit'), v: eur(p0.openCredit) }))
    const sumTxt = teile.length ? ' ' + T.s('m.growthSum', { ek: eur(p0.equity), teile: T.list(teile) }) : ''
    if (basis === p0.equity) m.push(T.s('m.growthBaseEq', { pct: gp, ek: eur(p0.equity) }))
    else if (p0.loan > 0) m.push(T.s('m.growthBase', { pct: gp, basis: eur(basis), kredit: page(ctx, p0.creditSoFar ? 'pCreditSoFar' : 'pLoan') }) + sumTxt)
    else m.push(T.s('m.growthBaseNoLoan', { pct: gp, basis: eur(basis) }) + sumTxt)
    const bis = p0.readyYear + p0.equityGrowthYears - 1
    m.push(T.s('m.growthYears', { n: p0.equityGrowthYears, von: p0.readyYear, bis }))
    if (bis > a.summary.lastYear) m.push(T.s('m.growthBeyond', { ende: a.summary.lastYear }))
  }
  const noGrowth = P.filter(p => p.equityGrowthPct == null).length
  if (noGrowth) m.push(T.s(noGrowth === 1 ? 'm.noGrowth1' : 'm.noGrowthN', { n: noGrowth }))
  if (a.reinvest && refis.length) m.push(T.s('m.refi', sec))
  if (earlyCards.length) {
    let s = T.s(earlyCards.length === 1 ? 'm.beforeHandover1' : 'm.beforeHandoverN', { n: earlyCards.length })
    // Was „davon dir gehoerend" dort nicht abzieht, je Karte aus Wert minus gehoerend
    const groups = new Map<string, number>()
    for (const p of earlyGaps) {
      const k = earlyKind(p) as EarlyKind
      const kredit = T.s('zeile', { l: page(ctx, creditLabelKey(p)) })
      const txt = T.s(`bh.${k}`, { kredit })
      groups.set(txt, (groups.get(txt) ?? 0) + 1)
    }
    if (groups.size === 1 && earlyGaps.length === earlyCards.length) s += ' ' + T.s('bh.there', { x: [...groups.keys()][0] })
    else {
      // Deckt die letzte Gruppe alle uebrigen Karten ab: „Auf der anderen …"
      const all = earlyGaps.length === earlyCards.length
      const list = [...groups]
      list.forEach(([x, k], i) => {
        const rest = all && i === list.length - 1 && i > 0
        s += ' ' + T.s(rest ? (k === 1 ? 'bh.other1' : 'bh.otherN') : (k === 1 ? 'bh.on1' : 'bh.onN'), { x, k })
      })
    }
    if (a.exits.length) s += ' ' + T.s('m.beforeHandoverExit', sec)
    m.push(s)
  }

  const pitfalls = [T.s('pitfalls.costs'), T.s(models ? 'pitfalls.sumCardsOwn' : 'pitfalls.sumCards'), T.s('pitfalls.rent'), T.s('pitfalls.furniture'),
    T.s('pitfalls.growthStart'), T.s('pitfalls.owned'),
    ...(growthCard ? [T.s('pitfalls.roe', sec)] : []), T.s('pitfalls.round')]
  return { heading: T.s('heading'), intro: T.s('intro'), items, example, meaning: m, pitfalls }
}

export function buildCreditGuides(ctx: GuideCtx): Record<string, Guide | null> {
  const list = terms(ctx)
  const def = (g: Guide | null): Guide | null => g ? defineTerms(ctx, g, list) : null
  return {
    creditPath: def(creditPathGuide(ctx)),
    loans: def(loansGuide(ctx)),
    timeline: def(timelineGuide(ctx)),
    properties: def(propertiesGuide(ctx)),
  }
}

// ── Nachpruefung ────────────────────────────────────────────────────────────
// Rechnet jede Zahl, die ein Beispiel- oder Bedeutungssatz behauptet, auf einem
// eigenen Weg aus den angezeigten (gerundeten) Werten nach und prueft, ob die
// Beschriftungen exakt die der Seite sind.
export function checkGuides(ctx: GuideCtx, res: Record<string, Guide | null>): string[] {
  const { a, params } = ctx
  const out: string[] = []
  const fail = (id: string, msg: string) => out.push(`${id}: ${msg}`)
  const want = ['creditPath', 'loans', 'timeline', 'properties']
  for (const k of want) if (!(k in res)) fail(k, 'fehlt im Ergebnis')
  for (const k of Object.keys(res)) if (!want.includes(k)) fail(k, 'unerwarteter Schluessel')
  // Erklaersaetze zu Fachbegriffen stehen nur in der Einleitung
  const strip = (x: string): string => x
  const txt = (g: Guide) => strip([g.example ?? '', ...g.meaning].join('\n'))
  const all = (g: Guide) => strip([g.intro, ...g.items.map(i => i.text), g.example ?? '', ...g.meaning, ...g.pitfalls].join('\n'))
  const needs = (id: string, g: Guide, s: string, why: string) => { if (!txt(g).includes(s)) fail(id, `${why}: „${s}" fehlt`) }
  const tr = (key: string, v?: Vars): string => String(ctx.t(`strategie.guide.${key}`, { ...(v ?? {}) }))
  // Satz (fertig eingesetzt) muss vorkommen bzw. darf nicht vorkommen
  const expect = (id: string, g: Guide, sentence: string, cond: boolean, why: string) => {
    const has = txt(g).includes(sentence)
    if (cond && !has) fail(id, `${why}: Satz fehlt („${sentence.slice(0, 80)}…")`)
    if (!cond && has) fail(id, `${why}: Satz steht da, obwohl die Bedingung nicht gilt`)
  }
  const labelsOk = (id: string, g: Guide, allowed: string[]) => {
    for (const it of g.items) if (!allowed.includes(it.label)) fail(id, `Beschriftung „${it.label}" steht so nicht auf der Seite`)
  }
  const cp = a.creditPath && a.creditPath.steps.length > 0 ? a.creditPath : null
  const own = a.properties.filter(p => !p.model)
  const endOf = (p: PropertyCard) => p.soldYear ?? a.summary.lastYear

  // Sichtbarkeit wie auf der Seite
  if (!!res.creditPath !== !!cp) fail('creditPath', 'Sichtbarkeit weicht von der Seite ab')
  if (!!res.loans !== !!(cp && cp.loans.length > 0)) fail('loans', 'Sichtbarkeit weicht von der Seite ab')
  if (!!res.timeline !== a.timeline.length > 0) fail('timeline', 'Sichtbarkeit weicht von der Seite ab')
  if (!!res.properties !== a.properties.length > 0) fail('properties', 'Sichtbarkeit weicht von der Seite ab')

  // Jeder Fachbegriff ist erklaert, bevor (oder gleich wo) er zuerst steht, und nur einmal
  for (const id of want) {
    const g = res[id]
    if (!g) continue
    const full = readText(g)
    const list = terms(ctx)
    for (const term of list) {
      const u = term.re.exec(full)
      if (!u) continue
      const k = term.known.exec(full)
      const d = full.indexOf(term.def)
      const inIntro = d >= 0 && d < g.intro.length
      if (!(k && k.index <= knownLimit(full, u.index)) && !inIntro) fail(id, `Begriff ${term.re.source} nicht erklärt`)
      if (full.split(term.def).length > 2) fail(id, `Begriff ${term.re.source} doppelt erklärt`)
    }
  }

  // ── creditPath
  const g1 = res.creditPath
  if (g1 && cp) {
    labelsOk('creditPath', g1, ['credEqUntil', 'credFrom', 'credTotal', 'credDate', 'credRate', 'credAmount', 'credEquity',
      'credSurplus', 'credSurplusRent', 'credCredit', 'credCumul', 'credInterest'].map(k => page(ctx, k)))
    const withSur = cp.steps.some(s => s.fromSurplus > 0.5)
    // Kastenwerte, die die Zeilen zitieren, sind die der Seite
    const boxEq = cp.firstCreditYm == null && !withSur ? page(ctx, 'credAllCovered')
      : cp.equityLastYm != null ? mmYYYY(cp.equityLastYm) : page(ctx, 'credFirstRate')
    const boxFrom = cp.firstCreditYm != null ? mmYYYY(cp.firstCreditYm)
      : withSur ? page(ctx, a.surplusWithVat ? 'credNoneSurplus' : 'credNoneRent') : page(ctx, 'credNone')
    const it0 = g1.items[0]?.text ?? '', it1 = g1.items[1]?.text ?? ''
    if (cp.equityLastYm == null && !it0.includes(boxEq)) fail('creditPath', `Zeile „${page(ctx, 'credEqUntil')}" zitiert nicht „${boxEq}"`)
    if (cp.firstCreditYm == null && !it1.includes(boxFrom)) fail('creditPath', `Zeile „${page(ctx, 'credFrom')}" zitiert nicht „${boxFrom}"`)
    // Zeilen-Identitaet und Summen unabhaengig nachrechnen
    for (const r of cp.steps) {
      const exact = r.fromEquity + r.fromSurplus + r.credit
      if (Math.abs(exact - r.amount) > 0.01) fail('creditPath', `Zeile ${mmYYYY(r.ym)}: Betrag ungleich Summe der Quellen`)
    }
    let running = 0
    for (const r of cp.steps) running += r.credit
    if (eur(running) !== eur(cp.creditTotal)) fail('creditPath', 'Summe der Kredite ungleich „Kredit insgesamt"')
    const last = cp.steps[cp.steps.length - 1]
    if (cp.creditTotal > 0.5 && eur(last.creditTotal) !== eur(cp.creditTotal)) fail('creditPath', 'letzte Zeile „Kredit gesamt" ungleich Kasten')
    const hlRows = cp.firstCreditYm == null ? [] : cp.steps.filter(s => s.ym === cp.firstCreditYm && s.credit > 0.5)
    const hl = hlRows[0]
    const rund = tr('creditPath.ex.rund')
    if (hl && g1.example) {
      needs('creditPath', g1, eur(hl.amount), 'Betrag der markierten Zeile')
      if (hl.fromEquity > 0.5) needs('creditPath', g1, eur(hl.fromEquity), 'Eigenkapitalteil')
      if (hl.fromSurplus > 0.5) needs('creditPath', g1, eur(hl.fromSurplus), 'Miete/MwSt-Teil')
      needs('creditPath', g1, eur(hl.credit), 'erster Kredit')
      const parts = (hl.fromEquity > 0.5 ? R(hl.fromEquity) : 0) + (hl.fromSurplus > 0.5 ? R(hl.fromSurplus) : 0) + R(hl.credit)
      if (parts !== R(hl.amount)) needs('creditPath', g1, rund + eur(hl.credit), 'Rundungshinweis')
      else if (txt(g1).includes(rund + eur(hl.credit))) fail('creditPath', 'unnoetiges „rund"')
      if (R(cp.creditTotal) > R(hl.credit)) needs('creditPath', g1, eur(cp.creditTotal), 'Kredit insgesamt')
      // „Bis einschliesslich … ohne Kredit": keine Zeile bis dahin hat Kredit (bei Barkauf-Reserve nur Wohnungen mit Bank)
      if (cp.equityLastYm != null && cp.equityLastYm !== cp.firstCreditYm && !a.cashUnitsReserved
        && cp.steps.some(s => s.ym <= (cp.equityLastYm as number) && s.credit > 0.5)) fail('creditPath', 'vor „Eigenkapital reicht bis" steht schon Kredit')
      // Zeile(n) farbig: Einzahl nur bei genau einer Zeile
      const fin = a.cashUnitsReserved ? tr('creditPath.fin') : ''
      const wantFrom = tr(hlRows.length > 1 ? 'creditPath.items.fromMulti.text' : 'creditPath.items.from.text', { v: boxFrom, fin })
      if (strip(it1) !== wantFrom) fail('creditPath', 'Ein-/Mehrzahl der farbigen Zeilen falsch')
    }
    // Letzte Zeile: Teile ergeben den Betrag (mit „rund", wenn die Zellen nicht aufgehen)
    if (g1.example && g1.example.includes(`(${mmYYYY(last.ym)})`)) {
      needs('creditPath', g1, eur(last.amount), 'Betrag der letzten Zeile')
      const cells = [last.fromEquity, last.fromSurplus, last.credit].filter(x => x > 0.5)
      for (const c of cells) needs('creditPath', g1, eur(c), 'Teil der letzten Zeile')
      const sumCells = cells.reduce((x, c) => x + R(c), 0)
      const hasRund = cells.length > 1 && txt(g1).includes(rund + eur(cells[cells.length - 1]))
      if (cells.length > 1 && (sumCells !== R(last.amount)) !== hasRund) fail('creditPath', 'letzte Zeile: „rund" passt nicht zur Summe der Zellen')
      if (last.interest > 0.5) needs('creditPath', g1, eur(last.interest), 'Zinsen der letzten Zeile')
    }
    if (cp.firstCreditYm != null) needs('creditPath', g1, mmYYYY(cp.firstCreditYm), 'Monat „Kredit nötig ab"')
    expect('creditPath', g1, tr('creditPath.m.cashOnlyCredit', { gesamt: eur(cp.creditTotal) }), cp.firstCreditYm == null && cp.creditTotal > 0.5, 'Kredit nur beim Barkauf')
    // Summen: ungerundet summiert; Abstand zur Summe der angezeigten Zellen hoechstens Rundung
    const sumCheck = (f: (s: FinancingStep) => number, why: string) => {
      let exact = 0, cells = 0
      for (const s of cp.steps) { exact += f(s); cells += f(s) > 0.5 ? R(f(s)) : 0 }
      needs('creditPath', g1, eur(exact), why)
      if (Math.abs(R(exact) - cells) > Math.ceil(cp.steps.length / 2)) fail('creditPath', `${why}: Zellensumme weicht zu stark ab`)
    }
    if (withSur) sumCheck(s => s.fromSurplus, 'Summe aus Miete/MwSt')
    if (cp.steps.some(s => s.interest > 0.5)) sumCheck(s => s.interest, 'Summe Bauträgerzinsen')
    if (cp.firstCreditYm == null && !withSur && !(cp.creditTotal > 0.5) && g1.example) {
      if (cp.steps.some(s => s.credit > 0.5 || s.fromSurplus > 0.5)) fail('creditPath', '„komplett aus Eigenkapital" stimmt nicht')
      needs('creditPath', g1, eur(cp.steps.reduce((x, s) => x + R(s.amount), 0)), 'Summe aller Raten')
    }
    if (a.reinvest) {
      // eingeplantes Eigenkapital: nie mehr als das Startkapital behaupten
      const claims = ['m.reinvest', 'm.reinvestNoReserve', 'm.reinvestPart', 'm.reinvestPartNoReserve']
        .some(k => txt(g1).includes(tr(`creditPath.${k}`, { reserve: eur(a.minimumReserve), ek: eur(cp.equity) })))
      if (claims && !(cp.equity <= a.summary.originalEquity + 1)) fail('creditPath', 'eingeplantes Eigenkapital größer als Startkapital')
      if (claims) needs('creditPath', g1, eur(cp.equity), 'eingeplantes Eigenkapital')
      const deshalb = txt(g1).includes(tr('creditPath.m.reinvest', { reserve: eur(a.minimumReserve), ek: eur(cp.equity) }))
        || txt(g1).includes(tr('creditPath.m.reinvestNoReserve', { reserve: eur(a.minimumReserve), ek: eur(cp.equity) }))
      if (deshalb) {
        let costs = 0
        for (const p of own) costs += p.equity
        costs -= R(cp.equity)
        const res0 = a.minimumReserve > 0.5 ? R(a.minimumReserve) : 0
        if (Math.abs(a.summary.originalEquity - res0 - costs - R(cp.equity)) > 1) fail('creditPath', '„deshalb eingeplant" geht nicht auf (Start - Reserve - Nebenkosten)')
      }
    }
    let eqCells = 0
    for (const s of cp.steps) eqCells += s.fromEquity > 0.5 ? R(s.fromEquity) : 0
    const over = tr('creditPath.m.overEquity', { ek: eur(eqCells), start: eur(a.summary.originalEquity) })
    if (txt(g1).includes(over) && !(eqCells > a.summary.originalEquity)) fail('creditPath', 'Aussage „mehr Eigenkapital als Startkapital" falsch')
    // Wohnungen ohne Darlehen mit Kredit-Zellen: Anzahl und Summe unabhaengig
    {
      const names = own.map(p => p.name)
      let n = 0, sum = 0
      if (new Set(names).size === names.length) for (const p of own) {
        if (p.loan !== 0 || p.openCredit || p.fromSurplus || p.openRest) continue
        let c = 0
        for (const s of cp.steps) if (s.unit === p.name && s.credit > 0.5) c += R(s.credit)
        if (c > 0) { n++; sum += c }
      }
      const key = n === 1 ? 'm.cashCredit1' : 'm.cashCreditN'
      if (n) expect('creditPath', g1, tr(`creditPath.${key}`, { n, kredit: eur(sum), darlehen: page(ctx, 'pLoan') }), true, 'Kredit bei Wohnung ohne Darlehen')
    }
    // Anzahl der Wohnungen mit MwSt-Erstattung an dich
    if (a.vatReturned.length) {
      const n = new Set(a.vatReturned.map(v => v.name)).size
      expect('creditPath', g1, tr(n === 1 ? 'creditPath.m.vatReturned1' : 'creditPath.m.vatReturnedN', { n }), true, 'Anzahl MwSt an dich')
    }
    // Nebenkosten „zusaetzlich zum Startkapital" nur ohne Reinvestment und bei ganz eingesetztem Startkapital
    if (all(g1).includes(tr('creditPath.pitfalls.costsExtra')) && (a.reinvest || R(cp.equity) < a.summary.originalEquity - 1))
      fail('creditPath', 'Nebenkosten „zusätzlich zum Startkapital" gilt hier nicht')
  }

  // ── loans
  const g2 = res.loans
  if (g2 && cp) {
    const after = cp.loans.find(l => l.afterEnd && !l.sold)
    labelsOk('loans', g2, [...['eObj', 'credLoan', 'credStart', 'credMonthly', 'credLoanOpen', 'credLoanSold'].map(k => page(ctx, k)),
      ...(after ? [page(ctx, 'credLoanAfter', { d: mmYYYY(after.startYm) })] : [])])
    for (const l of cp.loans) {
      if (l.open) continue
      const mon = annuityMonthly(R(l.amount), params.interest, params.termYears)
      if (Math.abs(R(mon) - R(l.monthly)) > 1) fail('loans', `Monatsrate ${eur(l.monthly)} passt nicht zu ${num(params.interest)} % / ${params.termYears} J. (${eur(mon)})`)
    }
    const l0 = cp.loans.find(l => !l.open && !l.afterEnd)
    if (l0 && g2.example) {
      needs('loans', g2, eur(l0.amount), 'Darlehen'); needs('loans', g2, eur(l0.monthly), 'Monatsrate'); needs('loans', g2, mmYYYY(l0.startYm), 'Start')
      const S = cp.loans.reduce((x, l) => x + R(l.amount), 0)
      const sumTxt = tr('loans.ex.sum', { summe: eur(S) })
      const oneTxt = tr('loans.ex.sumOne')
      if ((g2.example.includes(sumTxt) || g2.example.includes(oneTxt)) && S !== R(cp.creditTotal)) fail('loans', 'Summenaussage stimmt nicht')
      // Monatsrate und Rueckzahlung nur erzaehlen, wenn die Wohnung bis zum Start noch im Plan ist
      const card = a.properties.find(c => c.key === l0.key)
      const sale = card?.soldYear ?? (a.exitTotal != null && a.exits.length ? a.exits[0].year : null)
      const paid = [tr('loans.ex.paidOff'), tr('loans.ex.paidOffSale', { jahr: sale ?? '' })]
      if (sale != null && sale * 12 + 11 < l0.startYm && paid.some(x => g2.example?.includes(x))) fail('loans', 'Rückzahlung erzählt, obwohl vor dem Start verkauft')
      if (sale != null && sale * 12 + 11 >= l0.startYm && !paid.some(x => g2.example?.includes(x))) fail('loans', 'Satz zur Rückzahlung fehlt')
      if (params.interest === 0 && /Zinsanteil|interest share|Darin stecken Zinsen|contains interest/.test(all(g2))) fail('loans', 'Zinsanteil bei 0 % Zins')
    }
    const tog = loansTogether(a, cp, params.termYears)
    if (tog) {
      const sumM = tog.list.reduce((x, l) => x + R(l.monthly), 0)
      needs('loans', g2, eur(sumM), 'Summe der Monatsraten')
      if (tog.list.some(l => l.startYm > tog.from)) fail('loans', 'Startmonat der gemeinsamen Raten falsch')
    }
    const exactTxt = tr('loans.m.matchExact')
    const round1Txt = tr('loans.m.matchRound1')
    const roundTxt = tr('loans.m.matchRound')
    const limit = txt(g2).includes(exactTxt) ? 0 : txt(g2).includes(round1Txt) ? 1 : txt(g2).includes(roundTxt) ? 3 : -1
    if (limit >= 0) {
      for (const l of cp.loans) {
        const cells = cp.steps.filter(s => s.unit === l.name).reduce((x, s) => x + (s.credit > 0.5 ? R(s.credit) : 0), 0)
        if (Math.abs(cells - R(l.amount)) > limit) fail('loans', 'Darlehen ungleich Kredit-Zellen der Wohnung')
      }
    }
    // „Dieselbe Zahl steht auf der Karte": Darlehen bzw. offener Kredit der Wohnung
    for (const l of cp.loans) {
      const c = a.properties.find(x => x.key === l.key)
      const onCard = c ? (l.open ? c.openCredit ?? 0 : c.loan) : null
      if (onCard == null || eur(onCard) !== eur(l.amount)) fail('loans', `Darlehen ${eur(l.amount)} steht so nicht auf der Karte`)
    }
    // offene, verkaufte und spaeter startende Darlehen: Anzahl und Betrag
    let nO = 0, sO = 0, nS = 0, sS = 0
    for (const l of cp.loans) { if (l.open) { nO++; sO += R(l.amount) } if (l.sold) { nS++; sS += R(l.amount) } }
    if (nO) expect('loans', g2, tr(nO === 1 ? 'loans.m.open1' : 'loans.m.openN', { n: nO, betrag: eur(sO) }), true, 'offene Kredite')
    if (nS) expect('loans', g2, tr(nS === 1 ? 'loans.m.sold1' : 'loans.m.soldN', { n: nS, betrag: eur(sS) }), true, 'verkaufte Darlehen')
    if (after) expect('loans', g2, tr('loans.m.after', { start: mmYYYY(after.startYm), betrag: eur(after.amount) }), true, 'Darlehen nach dem Zeitraum')
  }

  // ── timeline
  const g3 = res.timeline
  if (g3) {
    const prefixOf = (label: string) => label.replace(/\s*…\s*$/, '').replace(/^…\s*/, '').trim()
    for (const it of g3.items) {
      const pre = prefixOf(it.label)
      if (!a.timeline.some(e => e.label.startsWith(pre) || e.detail.includes(pre.replace(/\s*….*$/, ''))))
        fail('timeline', `Beschriftung „${it.label}" kommt in der Zeitachse nicht vor`)
    }
    const ownS = [...own].sort((x, y) => x.buyYear - y.buyYear)
    const p = ownS.find(c => ymCard(c.readyYear, c.readyMonth) - ymCard(c.buyYear, c.buyMonth) > 0)
    if (p && g3.example) {
      const months = (p.readyYear * 12 + p.readyMonth) - (p.buyYear * 12 + p.buyMonth)
      needs('timeline', g3, `${mmyyyy(p.readyMonth, p.readyYear)}, ${months} `, 'Monate bis zur Übergabe')
      if (!a.timeline.some(e => e.kind === 'buy' && e.year === p.buyYear)) fail('timeline', 'Kauf-Eintrag des Beispiels fehlt')
    }
    if (a.timeline.some(e => e.kind === 'refinance')) {
      let s = 0
      for (const e of a.events) if (e.kind === 'refinance') s += R(e.newLoanAmount)
      needs('timeline', g3, eur(s), 'Summe der Refinanzierungen')
    }
    // Euro-Betraege im Kauf-Eintrag = Karte
    for (const c of own) {
      const e = a.timeline.find(x => x.kind === 'buy' && x.label === TL.buyPrefix + c.name)
      // analytics.ts formatiert mit normalem Leerzeichen vor €, die Seite mit geschuetztem
      const norm = (x: string) => x.replace(/\s/g, ' ')
      if (e && !(norm(e.detail).includes(norm(eur(c.gross))) && norm(e.detail).includes(norm(eur(c.equity))))) fail('timeline', 'Kauf-Eintrag ungleich Karte')
    }
  }

  // ── properties
  const g4 = res.properties
  if (g4) {
    const P = a.properties
    const allowed = [`${page(ctx, 'purchase')} … · ${page(ctx, 'handover')} …`,
      ...['modelUnit', 'pPrice', 'pEquity', 'pSurplus', 'pSurplusRent', 'pLoan', 'pCreditSoFar', 'pOpenSale', 'pOpenAfter',
        'pOpenCredit', 'pRent', 'pValue', 'pValueSale', 'pEquityEnd', 'pNet'].map(k => page(ctx, k)),
      ...P.filter(p => p.soldYear != null).map(p => page(ctx, 'sold', { y: p.soldYear as number })),
      ...P.map(p => page(ctx, 'pGrowth', { n: p.equityGrowthYears }))]
    labelsOk('properties', g4, allowed)
    const p0 = own[0]
    // „erste Karte" ist die erste eigene Wohnung
    if (p0 && P[0] !== p0 && g4.example) fail('properties', 'erste Karte ist keine eigene Wohnung')
    if (p0 && g4.example) {
      const src = p0.equity + (p0.fromSurplus ?? 0) + (p0.loan > 0 ? p0.loan : 0) + (p0.openRest ?? 0) + (p0.openCredit ?? 0)
      const costs = src - p0.gross
      if (txt(g4).includes(eur(costs)) && !(costs > 0 && costs <= R(p0.gross * 0.01) + 1)) fail('properties', `Kaufnebenkosten ${eur(costs)} unplausibel`)
      if (costs > 0 && costs <= R(p0.gross * 0.01) + 1) {
        needs('properties', g4, eur(costs), 'Unterschied = Kaufnebenkosten')
        if (src !== p0.gross) needs('properties', g4, eur(src), 'Summe der Geldquellen')
        // „kein Eigenkapital in den Kaufpreis": Ratentabelle zeigt bei dieser Wohnung auch keins
        if (cp && txt(g4).includes(tr('properties.ex.onlyCosts', sections(ctx)))) {
          const eqT = cp.steps.filter(s => s.unit === p0.name).reduce((x, s) => x + (s.fromEquity > 0.5 ? R(s.fromEquity) : 0), 0)
          if (eqT > 0) fail('properties', '„kein Eigenkapital im Kaufpreis", aber Ratentabelle zeigt Eigenkapital')
        }
      }
      if (p0.readyYear <= endOf(p0)) {
        needs('properties', g4, eur(p0.valueEnd), 'Wert'); needs('properties', g4, eur(p0.equityEnd), 'davon dir gehörend')
        const schuld = p0.valueEnd - p0.equityEnd
        if (schuld > 0) needs('properties', g4, eur(schuld), 'Schuld = Wert minus gehörend')
        // „nur Restschuld des Darlehens": nie mehr als das Darlehen, nichts mehr offen
        const zeit = tr(p0.soldYear != null ? 'properties.ex.zeitSale' : 'properties.ex.zeitEnd', { jahr: endOf(p0) })
        const vr = tr('properties.ex.valueRefiLoan', { zeit, wert: eur(p0.valueEnd), gehoert: eur(p0.equityEnd), schuld: eur(schuld) })
        if (txt(g4).includes(vr) && !(schuld > 0 && schuld <= p0.loan && !p0.openRest && !p0.openCredit && !p0.creditSoFar))
          fail('properties', 'Restschuld-Aussage passt nicht')
      }
    }
    if (p0 && p0.readyMonth > 1 && p0.readyYear <= endOf(p0)) {
      const n = 12 - p0.readyMonth + 1
      if (n > 1) needs('properties', g4, ` ${n} `, 'Mietmonate im 1. Jahr')
      needs('properties', g4, eur(p0.rentFirstYear), 'Miete im 1. Jahr')
    }
    let sur = 0, nSur = 0
    for (const p of P) if (p.fromSurplus) { sur += p.fromSurplus; nSur++ }
    if (sur) needs('properties', g4, eur(sur), 'Summe aus Miete/MwSt')
    const quelle = tr(a.surplusWithVat ? 'properties.q.vat' : 'properties.q.rent')
    if (nSur) expect('properties', g4, tr(nSur === 1 ? 'properties.m.surplus1' : 'properties.m.surplusN', { n: nSur, quelle, summe: eur(sur) }), true, 'Wohnungen mit Miete/MwSt-Anteil')
    // offene Raten und offener Kredit: Summen und Anzahl unabhaengig
    let sSale = 0, sAfter = 0, sOc = 0, nOc = 0
    for (const p of P) {
      if (p.openRest && p.openRestFromSale) sSale += p.openRest
      if (p.openRest && !p.openRestFromSale) sAfter += p.openRest
      if (p.openCredit) { sOc += p.openCredit; nOc++ }
    }
    if (sSale) expect('properties', g4, tr(P.some(p => p.creditSoFar) ? 'properties.m.openSaleCredit' : 'properties.m.openSale', { summe: eur(sSale) }), true, 'offene Raten aus dem Verkauf')
    if (sAfter) expect('properties', g4, tr('properties.m.openAfter', { ende: a.summary.lastYear, summe: eur(sAfter) }), true, 'offene Raten nach dem Zeitraum')
    if (nOc) expect('properties', g4, tr(nOc === 1 ? 'properties.m.openCredit1' : 'properties.m.openCreditN', { n: nOc, summe: eur(sOc) }), true, 'offener Kredit')
    const karten = tr(P.some(p => p.model) ? 'properties.karten.own' : 'properties.karten.all')
    if (own.length && own.every(p => { const c = cardSources(p) - p.gross; return c > 0 && c <= R(p.gross * 0.01) + 1 })) {
      const sumEq = own.reduce((x, p) => x + p.equity, 0)
      const sumNk = own.reduce((x, p) => x + cardSources(p) - p.gross, 0)
      for (const k of ['m.sumEq', 'm.sumEqExtra']) {
        const sentence = tr(`properties.${k}`, { karten, summe: eur(sumEq), start: eur(a.summary.originalEquity), nk: eur(sumNk) })
        if (txt(g4).includes(sentence) && sumEq !== a.summary.originalEquity + sumNk) fail('properties', 'Summe Eigenkapital ungleich Startkapital plus Nebenkosten')
        if (k === 'm.sumEqExtra' && txt(g4).includes(sentence) && a.reinvest) fail('properties', 'Nebenkosten „zusätzlich" im Reinvestment')
      }
    }
    {
      const sumEq = own.reduce((x, p) => x + p.equity, 0)
      const over = tr('properties.m.overEquity', { karten, summe: eur(sumEq), start: eur(a.summary.originalEquity) })
      if (txt(g4).includes(over) && !(sumEq > a.summary.originalEquity)) fail('properties', 'Aussage „mehr Eigenkapital als Startkapital" falsch')
    }
    if (p0 && p0.equityGrowthPct != null) {
      const basis = p0.equity + (p0.fromSurplus ?? 0) + (p0.openRest ?? 0) + (p0.openCredit ?? 0)
      if (basis !== p0.equity) {
        needs('properties', g4, eur(basis), 'Basis des Eigenkapital-Zuwachses')
        // Teile der Basis stehen dabei (Summe der Kartenzeilen)
        needs('properties', g4, eur(p0.equity), 'Basis: davon Eigenkapital')
        for (const v of [p0.fromSurplus, p0.openRest, p0.openCredit]) if (v) needs('properties', g4, eur(v), 'Basis: weiterer Teil')
      }
      needs('properties', g4, `${p0.readyYear + p0.equityGrowthYears - 1}`, 'letztes Jahr des Zuwachses')
    }
    {
      let n = 0
      for (const p of P) if (p.equityGrowthPct == null) n++
      if (n) expect('properties', g4, tr(n === 1 ? 'properties.m.noGrowth1' : 'properties.m.noGrowthN', { n }), true, 'Karten ohne Zuwachs')
    }
    // Plan endet vor der Uebergabe: Anzahl und was „davon dir gehoerend" nicht abzieht
    {
      const early = own.filter(p => p.readyYear > endOf(p))
      if (early.length) expect('properties', g4, tr(early.length === 1 ? 'properties.m.beforeHandover1' : 'properties.m.beforeHandoverN', { n: early.length }), true, 'Wohnungen vor der Übergabe')
      // je Karte unabhaengig: abgezogen (Wert minus gehoerend) gegen Kredit und offene Raten
      const facts = early.map(p => {
        const ded = p.valueEnd - p.equityEnd
        const cred = (p.loan > 0 ? p.loan : 0) + (p.openCredit ?? 0)
        const kredit = tr('properties.zeile', { l: page(ctx, p.creditSoFar ? 'pCreditSoFar' : p.loan > 0 ? 'pLoan' : 'pOpenCredit') })
        return { p, ded, cred, kredit, nothing: cred > 0 && ded <= 1, ratesKept: !!p.openRest && ded <= cred + 1 }
      })
      for (const f of facts) {
        // Nichts abgezogen, obwohl Kredit da ist: der Satz muss das sagen
        if (f.nothing && !txt(g4).includes(tr(f.p.openRest ? 'properties.bh.none2' : 'properties.bh.credit', { kredit: f.kredit })))
          fail('properties', `vor Übergabe: nicht abgezogener Kredit (${eur(f.cred)}) nicht genannt`)
      }
      const ratesTxt = tr('properties.bh.rates')
      if (txt(g4).includes(ratesTxt) && !facts.some(f => f.ratesKept && !f.nothing)) fail('properties', 'vor Übergabe: Aussage zu offenen Raten ohne passende Karte')
      // „Dort …" gilt fuer alle Karten zugleich
      if (txt(g4).includes(tr('properties.bh.there', { x: ratesTxt })) && !facts.every(f => f.ratesKept && !f.nothing))
        fail('properties', 'vor Übergabe: „offene Raten nicht abgezogen" gilt nicht für alle Karten')
      for (const f of facts) {
        const none = tr('properties.bh.there', { x: tr('properties.bh.none2', { kredit: f.kredit }) })
        if (txt(g4).includes(none) && !facts.every(x => x.nothing && !!x.p.openRest)) fail('properties', 'vor Übergabe: „weder … noch" gilt nicht für alle Karten')
      }
    }
    // Darlehen der eigenen Karten = Kasten „Daraus werden diese Bankdarlehen"
    if (cp && cp.loans.length && g4.items.some(i => i.label === page(ctx, 'pLoan')))
      for (const p of own.filter(x => x.loan > 0 && !x.creditSoFar)) {
        const l = cp.loans.find(x => x.key === p.key)
        if (!l || eur(l.amount) !== eur(p.loan)) fail('properties', `Darlehen ${eur(p.loan)} steht so nicht im Kasten der Bankdarlehen`)
      }
  }
  return out
}
