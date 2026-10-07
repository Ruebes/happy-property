// Zahlungsplan des Bautraegers (Sven 6.10.2026): „Bei Mito 30 % jetzt, 20 % mit
// Uebergabe und die letzten 50 % in Raten bis 24 Monate nach Uebergabe, dann mit
// Zins. Andere gemaess der normalen Zahlungsplaene." Geprueft werden:
//   1. Plan aus crm_projects.payment_schedule lesen (beide Formate)
//   2. Raten summieren sich auf den Gesamtpreis, Mito-Rate wie im Deal Ilic
//   3. Bankdarlehen startet erst nach der letzten Rate, vorher keine Restschuld
//   4. Offene Raten sind Schuld, ihr Zins kostet Cashflow und mindert die Steuer
//   5. Luecke vor dem Bankstart laeuft als Zwischenfinanzierung
//   6. Alte Plaene ('luma', 'sofort') rechnen unveraendert
//   7. Plan-Summe ungleich 100 % wird nicht still unterschlagen
//
// Ausfuehren:
//   npx esbuild src/lib/rechner.ts  --bundle --format=esm --outfile=/tmp/rechner.mjs
//   npx esbuild src/lib/strategy.ts --bundle --format=esm --outfile=/tmp/strategy.mjs
//   npx esbuild src/lib/reinvest.ts --bundle --format=esm --outfile=/tmp/reinvest.mjs
//   npx esbuild src/lib/analytics.ts --bundle --format=esm --outfile=/tmp/analytics.mjs
//   node scripts/verify-devplan.mjs
import { compute, DEFAULT_PARAMS } from '/tmp/rechner.mjs'
import {
  DEFAULT_SIM_PARAMS, allocate, aggregate, computeExit, paymentPlan, scheduleFromProject,
  normalizeSchedule, describeSchedule, devBalanceAt, loanReadyYm, pledgeableFromYear, ymOf,
  MITO_SCHEDULE, LUMA_SCHEDULE, KUUTIO_SCHEDULE, isLumaStandard,
} from '/tmp/strategy.mjs'
import { runReinvest } from '/tmp/reinvest.mjs'

const eur = n => Math.round(n).toLocaleString('de-DE')
let pass = 0, fail = 0
function T(name, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol

// ── 1. Plan aus dem Projekt ──────────────────────────────────────────────────
const MAMBA_RAW = { stages: [
  { pct: 30, sub: 'abzüglich Reservierung', label: 'Bei Vertragsunterzeichnung' },
  { pct: 20, label: 'Bei Übergabe' },
  { pct: 50, sub: 'bis zu 24 Monate nach Übergabe in flexiblen Raten zu niedrigen Zinsen', label: 'Nach Übergabe · flexible Raten' },
], currency: 'EUR', reservation: 20000 }
const mito = scheduleFromProject(MAMBA_RAW, 'Mito')
T('Mito: 30 % Vertrag, 20 % Übergabe, 50 % danach', mito.contractPct === 30 && mito.handoverPct === 20 && mito.afterPct === 50 && mito.build.length === 0,
  describeSchedule(mito))
T('Mito: 24 Monate, Quartalsraten, 3,4 % Zins', mito.afterMonths === 24 && mito.afterPerYear === 4 && mito.afterRatePct === 3.4)

const EMERALD_RAW = [
  { label: 'RESERVIERUNG', percent: '10.000 €', trigger: 'wird auf die 35 % bei Vertrag angerechnet' },
  { label: 'BEI VERTRAG', percent: '35 %', trigger: 'abzüglich 10.000 € Reservierung' },
  { label: 'BAUFORTSCHRITT', percent: '30 %', trigger: 'Rohbau' },
  { label: 'BAUFORTSCHRITT', percent: '20 %', trigger: 'Mauerwerk & Verputz' },
  { label: 'BAUFORTSCHRITT', percent: '10 %', trigger: 'Fliesen & Fenster' },
  { label: 'ÜBERGABE', percent: '5 %', trigger: 'Schlüsselübergabe' },
]
const em = scheduleFromProject(EMERALD_RAW, 'Luma')
T('Projektformular-Format: 35 / 30-20-10 / 5, Reservierung 10.000', em.contractPct === 35 && em.build.join('/') === '30/20/10' && em.handoverPct === 5 && em.afterPct === 0 && em.reservation === 10000,
  describeSchedule(em))
T('Ohne Plan: Mito-Standard', scheduleFromProject([], 'Mito')?.afterPct === 50)
T('Ohne Plan: Luma-Standard', scheduleFromProject(null, 'Luma')?.build.join('/') === '20/20/15')
T('Ohne Plan und unbekannter Bautraeger: kein Plan', scheduleFromProject([], 'Olias Homes') === null)
T('Ohne Plan: Kuutio-Standard 40 / 20-10-10-10 / 10', (() => { const k = scheduleFromProject([], 'Kuutio Homes'); return k.contractPct === 40 && k.build.join('/') === '20/10/10/10' && k.handoverPct === 10 && k.reservationAt === 'handover' })())
T('Luma-Standard wird erkannt (bleibt alter Plan)', isLumaStandard(LUMA_SCHEDULE) && isLumaStandard(scheduleFromProject({ stages: [{ pct: 35, label: 'Bei Vertragsunterzeichnung' }, { pct: 20, label: '2. Rate · Baufortschritt' }, { pct: 20, label: '3. Rate · Baufortschritt' }, { pct: 15, label: '4. Rate · Baufortschritt' }, { pct: 10, label: 'Bei Übergabe · Title Deeds' }], reservation: 10000 }, 'Luma')) && !isLumaStandard(em) && !isLumaStandard(mito))
T('Emerald: Bauabschnitte aus der Beschriftung zurückgerechnet (10/7/4 Monate)', (em.buildMonthsBefore ?? []).join('/') === '10/7/4', (em.buildMonthsBefore ?? []).join('/'))

// ── 2. Raten ─────────────────────────────────────────────────────────────────
// Deal Ilic: 696.137,82 EUR Restsumme -> 8 Quartalsraten zu 90.378,50 EUR.
const ilicUnit = { key: 'I', name: 'I', priceNet: 1, furnNet: 0, rent: 0, letType: 'short', fin: true,
  buyM: 12, buyY: 2026, readyM: 12, readyY: 2028, plan: 'dev', schedule: { ...MITO_SCHEDULE } }
const ilicPays = paymentPlan(ilicUnit, 696137.82 * 2)
const after = ilicPays.filter(x => x.after)
T('Mito: 8 Raten nach Übergabe', after.length === 8)
T('Rate inkl. Zins = 90.378,50 € (Deal Ilic)', near(after[0].amount + after[0].interest, 90378.50, 0.01),
  (after[0].amount + after[0].interest).toFixed(2))
T('alle Raten gleich hoch', after.every(x => near(x.amount + x.interest, after[0].amount + after[0].interest, 0.01)))
T('Tilgung = 50 % des Preises', near(after.reduce((a, x) => a + x.amount, 0), 696137.82, 0.01))
T('Summe aller Zahlungen = Gesamtpreis', near(ilicPays.reduce((a, x) => a + x.amount, 0), 696137.82 * 2, 0.01))
T('letzte Rate 24 Monate nach Übergabe', after[7].ym === ymOf(2030, 12))

// ── 3.-5. Strategie mit Mito-Wohnung ─────────────────────────────────────────
const P = { ...DEFAULT_SIM_PARAMS, ek: 300000, interest: 3.8, termYears: 20, exitAfterYears: 0 }
const mamba = (o = {}) => ({
  key: 'M', name: 'Mamba', priceNet: 600000, furnNet: 0, rent: 3500, letType: 'short', fin: true,
  buyM: 10, buyY: 2026, readyM: 12, readyY: 2028, plan: 'dev', schedule: { ...MITO_SCHEDULE },
  calc: { mgmtPct: 25, bedrooms: 2 }, ...o,
})
const [om] = allocate([mamba()], P)
const delayIdx = om.res.restL.findIndex(x => x > 0)
T('Bank startet 24 Monate nach Übergabe', loanReadyYm(om.unit) === ymOf(2030, 12))
T('keine Bankrestschuld vor dem Start', om.res.restL[0] === 0 && om.res.restL[1] === 0 && delayIdx === 2,
  `restL ${om.res.restL.slice(0, 4).map(eur).join(' / ')}`)
T('keine Bankzinsen vor dem Start', om.res.intC[0] === 0 && om.res.intC[1] === 0 && om.res.intC[2] > 0)
T('Darlehensbetrag bleibt gleich', om.loan === allocate([mamba({ plan: 'luma', schedule: null })], P)[0].loan)
T('Monatsrate wird trotzdem ausgewiesen', om.annuityMonthly > 0, eur(om.annuityMonthly))

const agg = aggregate([om], P)
const r2029 = agg.rows.find(r => r.year === 2029)
const r2030 = agg.rows.find(r => r.year === 2030)
const devInt2029 = om.payments.filter(x => x.interest && Math.floor(x.ym / 12) === 2029).reduce((a, x) => a + x.interest, 0)
T('2029: Zins der Bautraeger-Raten in der Zinsspalte', r2029.interest >= devInt2029 && devInt2029 > 0, `${eur(devInt2029)} von ${eur(r2029.interest)}`)
T('2029: offene Raten zaehlen als Schuld', near(r2029.debt, devBalanceAt(om, 2029) + r2029.bridgeDebt + om.res.restL[1], 1),
  `${eur(r2029.debt)} = ${eur(devBalanceAt(om, 2029))} offen + ${eur(r2029.bridgeDebt)} Zwischenkredit`)
T('2029: Luecke ueber dem Eigenkapital als Zwischenkredit', r2029.bridgeDebt > 0 && r2029.bridgeInterest > 0)
T('2030: Bank loest den Zwischenkredit ab', r2030.bridgeDebt === 0 && devBalanceAt(om, 2030) === 0)
T('Kaufraten je Jahr folgen dem Plan', near(agg.rows.find(r => r.year === 2026).invest, om.gross * 0.30, 1)
  && near(agg.rows.find(r => r.year === 2028).invest, om.gross * 0.20, 1),
  agg.rows.slice(0, 5).map(r => `${r.year}: ${eur(r.invest)}`).join(', '))

// Zins mindert die Steuer: dieselbe Wohnung ohne Zins hat eine hoehere Bemessungsgrundlage.
const [om0] = allocate([mamba({ schedule: { ...MITO_SCHEDULE, afterRatePct: 0 } })], P)
const agg0 = aggregate([om0], P)
const b29 = agg0.rows.find(r => r.year === 2029)
T('Zins der Raten mindert die Steuer-Bemessung', near(b29.baseDE - r2029.baseDE, devInt2029, 1),
  `${eur(b29.baseDE)} → ${eur(r2029.baseDE)}`)

// Verkauf waehrend der Raten: offene Summe geht vom Erloes ab.
const exitEarly = computeExit([om], { ...P, exitAfterYears: 4 }, 2026, agg.rows)
T('Verkauf 2029: offene Raten und Zwischenkredit in der Restschuld',
  devBalanceAt(om, 2029) > 0 && near(exitEarly.lines[0].debt, devBalanceAt(om, 2029) + r2029.bridgeDebt, 2),
  `${eur(exitEarly.lines[0].debt)} = ${eur(devBalanceAt(om, 2029))} offen + ${eur(r2029.bridgeDebt)} Zwischenkredit`)
const exitLate = computeExit([om], { ...P, exitAfterYears: 7 }, 2026, agg.rows)
T('Verkauf nach Bankstart: nur Bankrestschuld', near(exitLate.lines[0].debt, om.res.restL[2032 - 2028], 1))

// Beleihung erst nach der letzten Rate
T('beleihbar erst nach der letzten Rate', pledgeableFromYear(om.unit) === 2030 && pledgeableFromYear(mamba({ plan: 'luma' })) === 2028)
const ri = runReinvest([mamba()], { ...P, reinvestEnabled: true, horizonYears: 20, ek: 400000 })
const tl = ri.unitTimeline.find(x => x.key === 'M')
T('Reinvest: Lebenslauf zeigt Beleihung ab der letzten Rate', tl.pledgeableFrom === 2030)
T('Reinvest: keine Refinanzierung vor der letzten Rate', !ri.events.some(e => e.kind === 'refinance' && e.year < 2030))

// Barkauf: Raten aus Eigenkapital, kein Bankdarlehen, Zins trotzdem Kosten.
const [cash] = allocate([mamba({ fin: false })], { ...P, ek: 800000 })
const aggC = aggregate([cash], { ...P, ek: 800000 })
T('Barkauf: Bank startet nicht, Zins der Raten bleibt Kosten', cash.loan === 0 && aggC.rows.find(r => r.year === 2029).interest > 0)

// ── 6. Alte Plaene unveraendert ──────────────────────────────────────────────
const luma = mamba({ plan: 'luma', schedule: null })
const pl = paymentPlan(luma, 714000)
T('Luma-Plan wie bisher (6 Zahlungen, 10 % bei Übergabe)', pl.length === 6 && near(pl[5].amount, 71400, 0.01) && pl.every(x => !x.after))
T('Engine ohne Aufschub bit-genau', JSON.stringify(compute({ ...DEFAULT_PARAMS })) === JSON.stringify(compute({ ...DEFAULT_PARAMS, loanDelayMonths: 0 })))

// ── 7. Summe ungleich 100 % ──────────────────────────────────────────────────
const low = normalizeSchedule({ ...MITO_SCHEDULE, afterPct: 40 })
T('90 %: Rest von 10 % bei Übergabe', near(low.handoverPct, 30, 1e-9))
const high = normalizeSchedule({ ...MITO_SCHEDULE, contractPct: 40 })
T('110 %: anteilig gekürzt', near(high.contractPct + high.handoverPct + high.afterPct, 100, 1e-9))
const sumPays = paymentPlan(mamba({ schedule: { ...MITO_SCHEDULE, afterPct: 40 } }), 714000).reduce((a, x) => a + x.amount, 0)
T('Zahlungen trotzdem = Gesamtpreis', near(sumPays, 714000, 0.01))

// ── 9. Kuutio (Sven 6.10.26): Bauraten vom Uebergabetermin zurueckgerechnet ──
const kuu = (o = {}) => ({ key: 'K', name: 'BAIA 9', priceNet: 584000, furnNet: 25000, rent: 3322, letType: 'short', fin: true,
  buyM: 10, buyY: 2026, readyM: 12, readyY: 2027, plan: 'dev', schedule: { ...KUUTIO_SCHEDULE }, calc: {}, ...o })
const kPays = paymentPlan(kuu(), 724710)
const at = (y, m) => kPays.filter(x => x.ym === ymOf(y, m)).reduce((a, x) => a + x.amount, 0)
T('Kuutio: 10.000 Reservierung + 40 % bei Vertrag', near(at(2026, 10), 10000 + 724710 * 0.40, 0.01))
T('Kuutio: Rohbau 10 Monate vor Übergabe (02/2027)', near(at(2027, 2), 724710 * 0.20, 0.01))
T('Kuutio: Mauerwerk 05/2027, Böden 08/2027, Aluminium 10/2027', near(at(2027, 5), 72471, 0.01) && near(at(2027, 8), 72471, 0.01) && near(at(2027, 10), 72471, 0.01))
T('Kuutio: 10 % abzüglich Reservierung bei Übergabe', near(at(2027, 12), 72471 - 10000, 0.01), kPays.map(x => x.label).join(' | '))
T('Kuutio: Summe = Gesamtpreis', near(kPays.reduce((a, x) => a + x.amount, 0), 724710, 0.01))
const late = paymentPlan(kuu({ buyM: 6, buyY: 2027 }), 724710)
T('Kauf spät im Bau: fertige Abschnitte mit dem Vertrag fällig', near(late.filter(x => x.ym === ymOf(2027, 6)).reduce((a, x) => a + x.amount, 0), 10000 + 724710 * 0.7, 0.01))
T('Text nennt Baufortschritt und Reservierung', /nach Baufortschritt/.test(describeSchedule(KUUTIO_SCHEDULE)) && /abzüglich Reservierung/.test(describeSchedule(KUUTIO_SCHEDULE)), describeSchedule(KUUTIO_SCHEDULE))

// ── 8. Review 6.10.26 ────────────────────────────────────────────────────────
// Laufzeit passt nicht ins Ratenraster: Text, letzte Rate und Bankstart muessen
// dieselbe Laufzeit nutzen.
const odd = mamba({ schedule: { ...MITO_SCHEDULE, afterMonths: 18, afterPerYear: 1 } })
const oddLast = paymentPlan(odd, 714000).filter(x => x.after).pop()
T('18 Monate jaehrlich: Bank startet mit der letzten Rate', loanReadyYm(odd) === oddLast.ym, `letzte Rate ${oddLast.ym % 12 + 1}/${Math.floor(oddLast.ym / 12)}`)
T('Text nennt dieselbe Laufzeit', /bis 24 Monate/.test(describeSchedule(odd.schedule)), describeSchedule(odd.schedule))
T('eine Rate: „in einer Rate"', /in einer Rate 12 Monate/.test(describeSchedule({ ...MITO_SCHEDULE, afterMonths: 12, afterPerYear: 1 })))

// Kundenseite: Raten nach dem Verkauf entfallen, Eigenkapital = ekAbs.
const { buildCustomerAnalytics } = await import('/tmp/analytics.mjs')
const baia = { key: 'B', name: 'BAIA 9', priceNet: 584000, furnNet: 25000, rent: 3322, letType: 'short', fin: true,
  buyM: 10, buyY: 2026, readyM: 12, readyY: 2027, plan: 'luma', calc: {} }
const CP = { ...DEFAULT_SIM_PARAMS, ek: 720000, deTaxPct: 30, interest: 3.8, buyerStructure: 'couple' }
const early = buildCustomerAnalytics([mamba(), baia], { ...CP, exitAfterYears: 4 })
T('Verkauf 2029: keine Rate nach 2029', !early.creditPath.steps.some(r => r.ym > ymOf(2029, 12)),
  [...new Set(early.creditPath.steps.map(r => Math.floor(r.ym / 12)))].join(', '))
const hoText = early.timeline.find(e => e.kind === 'handover' && e.label.includes('Mamba')).detail
T('Verkauf 2029: Rest aus dem Erlös, kein Bankstart 2030', /beim Verkauf aus dem Erlös/.test(hoText) && !/Bankdarlehen läuft ab/.test(hoText), hoText)
const full = buildCustomerAnalytics([mamba(), baia], { ...CP, exitAfterYears: 7 })
const eqSum = full.creditPath.steps.reduce((a, r) => a + r.fromEquity, 0)
T('Tabelle: Eigenkapital = Eigenkapital der Wohnungskarten ohne Nebenkosten', near(eqSum, full.properties.reduce((a, p) => a + p.equity, 0) - allocate([mamba(), baia], CP).reduce((a, o) => a + o.res.costs, 0), 2), eur(eqSum))
// Wohnungskarte: offene Raten + Zwischenkredit wie im Verkauf
const mEarly = early.properties.find(p => p.key === 'M'), mExit = early.exits.find(e => e.name === 'Mamba')
T('Karte = Verkauf: Schuld inkl. offener Raten und Zwischenkredit', near(mEarly.debtEnd, mExit.debt, 1), `${eur(mEarly.debtEnd)} / ${eur(mExit.debt)}`)
const sumCards = early.properties.reduce((a, p) => a + p.equityEnd, 0)
const bal = early.balance.find(b => b.label === 'Eigenkapital in den Immobilien').amount
T('Karten ergeben die Endbilanz', near(sumCards, bal, 2), `${eur(sumCards)} / ${eur(bal)}`)
// Ohne Verkauf: Rest faellt nach dem Zeitraum an, kein „aus dem Erlös"
const noExit = buildCustomerAnalytics([mamba({ buyY: 2033, buyM: 1, readyY: 2034, readyM: 12 }), baia], { ...CP, exitAfterYears: 0 })
const neText = noExit.timeline.find(e => e.kind === 'handover' && e.label.includes('Mamba')).detail
T('Ohne Verkauf: „nach dem Betrachtungszeitraum"', /nach dem Betrachtungszeitraum/.test(neText) && !/Erlös/.test(neText), neText)
// Nur Platzhalter-Plan: keine neue Tabelle (verschickte Seiten bleiben gleich)
const onlyLuma = buildCustomerAnalytics([mamba({ plan: 'luma', schedule: null }), baia], CP)
T('Nur alter Plan: Finanzierungsbedarf entfällt (verschickte Seiten gleich)', onlyLuma.creditPath === null)
// Finanzierungsbedarf: Kredit gesamt = Summe der Bankdarlehen, Start wie im Plan
const cpF = full.creditPath
T('Kredit gesamt = Summe der Bankdarlehen', near(cpF.creditTotal, cpF.loans.reduce((a, l) => a + l.amount, 0), 2), `${eur(cpF.creditTotal)}`)
T('Kredit nötig ab: erste Rate über dem Eigenkapital', cpF.firstCreditYm != null && cpF.steps.find(s => s.ym === cpF.firstCreditYm).credit > 0 && cpF.steps.filter(s => s.ym < cpF.firstCreditYm).every(s => s.credit < 0.5))
T('Bankdarlehen Mamba ab 12/2030', cpF.loans.find(l => l.name === 'Mamba').startYm === ymOf(2030, 12))
const reinv = buildCustomerAnalytics([baia, kuu({ key: 'K2', name: 'K2', buyY: 2027, buyM: 1 })], { ...CP, ek: 350000, reinvestEnabled: true, horizonYears: 20 })
const fin = reinv.creditPath.creditTotal
const loans = reinv.properties.filter(p => !p.model).reduce((a, p) => a + p.loan, 0)
T('Reinvest: finanziert = Darlehen der Wohnungen', near(fin, loans, 3), `${eur(fin)} / ${eur(loans)}`)

// ── 10. Review-Runde 3 ───────────────────────────────────────────────────────
// Kuutios eigener Wortlaut (Sven 6.10.26), englisch im Projektformular
const KU_EN = [
  { label: 'Reservation', percent: '10.000 €' },
  { label: '40%', percent: '40 %', trigger: 'upon signing contract' },
  { label: '20%', percent: '20 %', trigger: 'upon completion of structure' },
  { label: '10%', percent: '10 %', trigger: 'upon completion of brickwork' },
  { label: '10%', percent: '10 %', trigger: 'upon completion of flooring' },
  { label: '10%', percent: '10 %', trigger: 'upon completion of aluminium' },
  { label: '10%', percent: '10 %', trigger: 'minus reservation fee upon completion' },
]
const kEn = scheduleFromProject(KU_EN, 'Kuutio Homes')
T('Kuutio englisch: 40 / 20-10-10-10 / 10, Reservierung von der letzten Rate', kEn.contractPct === 40 && kEn.build.join('/') === '20/10/10/10' && kEn.handoverPct === 10 && kEn.reservationAt === 'handover',
  describeSchedule(kEn))
T('Kuutio englisch: zurückgerechnet 10/7/4/2', (kEn.buildMonthsBefore ?? []).join('/') === '10/7/4/2')
const KU_DE = { reservation: 10000, stages: [
  { pct: 40, label: 'Bei Vertragsunterzeichnung' }, { pct: 20, label: 'Fertigstellung Rohbau' },
  { pct: 10, label: 'Fertigstellung Mauerwerk' }, { pct: 10, label: 'Fertigstellung Böden' },
  { pct: 10, label: 'Fertigstellung Aluminium' }, { pct: 10, label: 'Bei Fertigstellung abzüglich Reservierung' } ] }
const kDe = scheduleFromProject(KU_DE, 'Kuutio Homes')
T('Kuutio deutsch: gleich erkannt', kDe.contractPct === 40 && kDe.build.join('/') === '20/10/10/10' && kDe.handoverPct === 10 && kDe.reservationAt === 'handover', describeSchedule(kDe))

// Uebergabe vor Kauf: Bank erst nach der letzten Rate, keine Ueberlappung
const pastU = mamba({ buyM: 10, buyY: 2026, readyM: 1, readyY: 2026 })
const pastPays = paymentPlan(pastU, 714000).filter(x => x.after)
T('Übergabe vor Kauf: Bankstart = letzte Rate', loanReadyYm(pastU) === pastPays[pastPays.length - 1].ym,
  `${loanReadyYm(pastU) % 12 + 1}/${Math.floor(loanReadyYm(pastU) / 12)}`)
const [pastO] = allocate([pastU], P)
const firstBank = pastO.res.restL.findIndex(x => x > 0)
T('Übergabe vor Kauf: keine Bankrestschuld vor der letzten Rate', 2026 + firstBank === 2028, `erstes Jahr mit Bankschuld ${2026 + firstBank}`)

// Verkauf: der GANZE Zwischenkredit wird abgeloest (auch Anteil anderer Wohnungen)
const MK = [mamba({ priceNet: 500000, readyM: 6, readyY: 2027 }), kuu({ key: 'K', priceNet: 400000, furnNet: 0, readyM: 6, readyY: 2029 })]
const PK = { ...P, ek: 400000 }
const oMK = allocate(MK, PK), aMK = aggregate(oMK, PK)
const exMK = computeExit(oMK, { ...PK, exitAfterYears: 3 }, 2026, aMK.rows)
const bridge28 = aMK.rows.find(r => r.year === 2028).bridgeDebt
const lineDebt = exMK.lines.reduce((a, l) => a + l.debt, 0)
const own = oMK.reduce((a, o) => a + (2028 >= o.unit.readyY ? o.res.restL[Math.min(2028 - o.unit.readyY, o.res.restL.length - 1)] + devBalanceAt(o, 2028) : 0), 0)
T('Verkauf: ganzer Zwischenkredit abgezogen', near(lineDebt, own + bridge28, 3), `${eur(lineDebt)} = ${eur(own)} + ${eur(bridge28)}`)

// EK-Rendite je Wohnung steigt nicht durch den Mito-Plan
const [rDev] = allocate([mamba()], P), [rLuma] = allocate([mamba({ plan: 'luma', schedule: null })], P)
T('EK-Rendite je Wohnung: Mito-Plan nicht besser als Bank ab Übergabe', rDev.roe10 <= rLuma.roe10 + 0.01, `${rDev.roe10.toFixed(1)} / ${rLuma.roe10.toFixed(1)}`)

// Reinvest: Zwischenkredit gegen das wirklich eingesetzte Eigenkapital
const RP = { ...P, ek: 400000, reinvestEnabled: true, horizonYears: 20, minimumCashReserve: 60000 }
const [rio] = allocate([mamba()], RP)
const rAgg = aggregate([rio], RP)
const paid29 = rio.payments.filter(x => Math.floor(x.ym / 12) <= 2029).reduce((a, x) => a + x.amount, 0)
T('Reinvest: Zwischenkredit = Raten minus eingesetztes Eigenkapital', near(rAgg.rows.find(r => r.year === 2029).bridgeDebt, paid29 - rio.res.ekAbs, 2),
  `${eur(rAgg.rows.find(r => r.year === 2029).bridgeDebt)} / ${eur(paid29 - rio.res.ekAbs)}`)

console.log(`\n${fail ? '❌' : '🎉'}  ${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
