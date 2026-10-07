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
import { compute, DEFAULT_PARAMS, irrCalc } from '/tmp/rechner.mjs'
import {
  DEFAULT_SIM_PARAMS, allocate, aggregate, computeExit, paymentPlan, scheduleFromProject,
  normalizeSchedule, describeSchedule, devBalanceAt, loanReadyYm, pledgeableFromYear, ymOf,
  MITO_SCHEDULE, LUMA_SCHEDULE, KUUTIO_SCHEDULE, isLumaStandard, totalsOf, financingPath, saleLineOf,
} from '/tmp/strategy.mjs'
import { runReinvest } from '/tmp/reinvest.mjs'
const st_ready = o => loanReadyYm(o.unit)

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
T('Darlehen höchstens Kaufpreis minus Eigenkapital-Anteil', om.loan <= om.gross - om.ekAlloc + 1, `${eur(om.loan)} / ${eur(om.gross - om.ekAlloc)}`)
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

// ── 11. Liquiditaet wie im Deal Ilic (Sven 7.10.26) ──────────────────────────
// Miete und MwSt-Erstattung zahlen die Mito-Raten mit, die Bank nur die Luecke.
const LP = { ...DEFAULT_SIM_PARAMS, ek: 720000, deTaxPct: 30, interest: 3.8, buyerStructure: 'couple', exitAfterYears: 7 }
const LU = [mamba({ calc: { mgmtPct: 25, bedrooms: 2, hotelConcept: true, season: { totalOcc: 70, adrHigh: 400 } }, rent: 6265 }),
  kuu({ key: 'B9', priceNet: 585000, furnNet: 25000 })]
const lo = allocate(LU, LP), la = aggregate(lo, LP)
const lm = lo.find(o => o.unit.key === 'M'), lb = lo.find(o => o.unit.key === 'B9')
T('Liquidität aktiv', !!la.liquidity)
T('Mito-Kredit deutlich kleiner als 70 % (Miete/MwSt zahlen mit)', lm.loan < 0.5 * (lm.gross - lm.ekAlloc), `Mamba ${eur(lm.loan)} statt ${eur(lm.gross - lm.ekAlloc)}`)
T('Kuutio-Darlehen unverändert bei Übergabe', lb.loan === lb.res.loan && st_ready(lb) === ymOf(2027, 12))
const recOk = la.liquidity.records.every(r => near(r.amount, r.fromEquity + r.fromSurplus + r.credit, 0.05))
T('jede Rate = Eigenkapital + Überschuss + Kredit', recOk)
const surSum = la.liquidity.records.reduce((a, r) => a + r.fromSurplus, 0)
const retSum = la.rows.reduce((a, r) => a + (r.retained ?? 0), 0)
T('einbehaltener Cashflow = aus Überschuss bezahlte Raten', near(surSum, retSum, 3), `${eur(surSum)} / ${eur(retSum)}`)
const credSum = la.liquidity.records.reduce((a, r) => a + r.credit, 0)
T('Kredit gesamt = Summe der Bankdarlehen', near(credSum, lm.loan + lb.loan, 3), `${eur(credSum)} / ${eur(lm.loan + lb.loan)}`)
T('Mito-Kredit = abgerufener Kredit bis zur letzten Rate', near(lm.loan, la.liquidity.records.filter(r => r.key === 'M').reduce((a, r) => a + r.credit, 0), 2))
const debtOk = la.rows.every(r => near(r.debt, lo.reduce((a, o) => {
  const i = r.year - o.unit.readyY
  return a + (i >= 0 ? o.res.restL[Math.min(i, o.res.restL.length - 1)] : 0) + devBalanceAt(o, r.year)
}, 0) + r.bridgeDebt, 2))
T('Restschuld = Bankdarlehen + offene Mito-Raten + abgerufener Kredit', debtOk, la.rows.map(r => `${r.year}:${eur(r.debt)}`).join(' '))
T('Eigenkapital des Kunden bleibt der Verteilungsanteil', near(lo.reduce((a, o) => a + o.ekAlloc, 0), 720000, 2))
const lt = totalsOf(lo, la.rows, LP, computeExit(lo, LP, la.firstYear, la.rows))
T('Rendite und Vermögen rechenbar', Number.isFinite(lt.irr) && lt.netWorth > 0, `IRR ${(lt.irr * 100).toFixed(1)} %`)
const lcp = buildCustomerAnalytics(LU, LP).creditPath
T('Kundenseite zeigt Spalte aus Miete/MwSt', lcp.steps.some(x => x.fromSurplus > 0) && near(lcp.creditTotal, lm.loan + lb.loan, 3))
// MwSt-Erstattung zurueckfuehren (Haken je Objekt, Sven 7.10.26)
const LUr = LU.map(u => ({ ...u, vatReturn: true }))
const lor = allocate(LUr, LP), lar = aggregate(lor, LP)
const lmr = lor.find(o => o.unit.key === 'M'), lbr = lor.find(o => o.unit.key === 'B9')
const vat29 = lar.rows.find(r => r.year === 2029).vat, vat30 = lar.rows.find(r => r.year === 2030).vat
T('Zurückgeführt: MwSt nicht für Raten verwendet', lar.liquidity.vatReturned.length === 2 && near(lar.liquidity.vatReturned.reduce((a, v) => a + v.amount, 0), vat29 + vat30, 1))
// Mit Haken kommt die Erstattung im Erstattungsjahr zusaetzlich frei an (Winter-
// Zuzahlungen gibt es mit Saisonprofil in beiden Varianten).
const free = (rows, y) => rows.find(r => r.year === y).cashflow
T('Zurückgeführt: Erstattung im Erstattungsjahr frei verfügbar', free(lar.rows, 2029) - free(la.rows, 2029) >= 0.9 * vat29 && free(lar.rows, 2030) - free(la.rows, 2030) >= 0.5 * vat30,
  `2029 +${eur(free(lar.rows, 2029) - free(la.rows, 2029))}, 2030 +${eur(free(lar.rows, 2030) - free(la.rows, 2030))}`)
T('Zurückgeführt: Mamba-Kredit steigt entsprechend', lmr.loan > lm.loan + 0.9 * (vat29 + vat30) - 20000, `${eur(lm.loan)} → ${eur(lmr.loan)}`)
T('Zurückgeführt: Identitäten halten', lar.liquidity.records.every(r => near(r.amount, r.fromEquity + r.fromSurplus + r.credit, 0.05))
  && near(lar.liquidity.records.reduce((a, r) => a + r.fromSurplus, 0), lar.rows.reduce((a, r) => a + (r.retained ?? 0), 0), 3)
  && near(lar.liquidity.records.reduce((a, r) => a + r.credit, 0), lmr.loan + lbr.loan, 3))
T('Zurückgeführt: Kundenseite nennt die Erstattung', buildCustomerAnalytics(LUr, LP).vatReturned.length === 2)
T('Ohne Haken: keine Rückführung', buildCustomerAnalytics(LU, LP).vatReturned.length === 0)
// ── 12. Review 7.10.26 (Liquiditaetsmodell) ──────────────────────────────────
const balance = (units, pp) => {
  const o = allocate(units, pp), a = aggregate(o, pp)
  const recs = a.liquidity.records
  const pay = recs.reduce((x, r) => x + r.amount, 0)
  const eq = recs.reduce((x, r) => x + r.fromEquity, 0), su = recs.reduce((x, r) => x + r.fromSurplus, 0), cr = recs.reduce((x, r) => x + r.credit, 0)
  const loans = o.filter(x => x.unit.fin).reduce((x, u) => x + u.loan, 0)
  return { o, a, pay, eq, su, cr, loans, openEnd: a.rows[a.rows.length - 1].bridgeDebt }
}
// (a) Kuutio spaeter uebergeben als Mito, EK 600k (vorher verschwand Bankgeld)
const SA = [mamba({ readyM: 12, readyY: 2026, rent: 4500 }), kuu({ key: 'K', priceNet: 585000, furnNet: 25000, readyM: 6, readyY: 2029 })]
const bA = balance(SA, { ...LP, ek: 600000 })
T('Fall a: Zahlungen = EK + Überschuss + Kredit', near(bA.pay, bA.eq + bA.su + bA.cr, 1))
T('Fall a: Kredit = Summe der Darlehen, kein Rest', near(bA.cr, bA.loans, 3) && bA.openEnd < 1, `${eur(bA.cr)} / ${eur(bA.loans)} / offen ${eur(bA.openEnd)}`)
// (b) Kuutio erst nach Mito-Uebergabe gekauft, EK 500k (vorher ewiger Restkredit)
const SB = [mamba({ readyM: 12, readyY: 2027, rent: 4000 }), kuu({ key: 'K', priceNet: 585000, furnNet: 25000, buyM: 1, buyY: 2028, readyM: 12, readyY: 2030 })]
const bB = balance(SB, { ...LP, ek: 500000, exitAfterYears: 0 })
T('Fall b: Kredit = Summe der Darlehen, kein Rest', near(bB.cr, bB.loans, 3) && bB.openEnd < 1, `${eur(bB.cr)} / ${eur(bB.loans)} / offen ${eur(bB.openEnd)}`)
// (c) Reihenfolge der Liste egal
const bC1 = balance(LU, { ...LP, ek: 400000 }), bC2 = balance([...LU].reverse(), { ...LP, ek: 400000 })
const tC1 = totalsOf(bC1.o, bC1.a.rows, { ...LP, ek: 400000 }), tC2 = totalsOf(bC2.o, bC2.a.rows, { ...LP, ek: 400000 })
T('Reihenfolge egal: gleiche Darlehen und gleiches Vermögen', near(bC1.loans, bC2.loans, 1) && near(tC1.netWorth, tC2.netWorth, 1) && near(tC1.irr, tC2.irr, 1e-9),
  `${eur(bC1.loans)} / ${eur(bC2.loans)}`)
T('EK 400k: kein Restkredit', bC1.openEnd < 1 && near(bC1.cr, bC1.loans, 3))
// (d) Barkauf neben Mito: Barkauf bekommt nie Kredit, wenn das EK reicht
const SD = [mamba({ key: 'A1' }), mamba({ key: 'C1', fin: false, plan: 'luma', schedule: null })]
const bD = balance(SD, { ...LP, ek: 1000000 })
T('Barkauf trägt keinen Kredit', bD.a.liquidity.records.filter(r => r.key === 'C1').every(r => r.credit < 0.01) && bD.openEnd < 1)
// (e) EK deckt alles: nichts wird einbehalten
const bE = balance(LU, { ...LP, ek: 1500000 })
T('EK deckt alles: kein Einbehalt, kein Kredit', bE.a.rows.every(r => Math.abs(r.retained ?? 0) < 1) && bE.cr < 1)
// (f) Mito erst 2033 gekauft: BAIA-Ueberschuss davor frei
const bF = balance([mamba({ buyY: 2033, buyM: 1, readyY: 2034, readyM: 12 }), kuu({ key: 'B9', priceNet: 585000, furnNet: 25000 })], { ...LP, exitAfterYears: 0 })
T('Mito 2033: vor der Mito-Übergabe nichts einbehalten', bF.a.rows.filter(r => r.year < 2034).every(r => Math.abs(r.retained ?? 0) < 1))
// (g) Wohnungskarte geht auf: Preis = EK + Überschuss + Darlehen
const cardOk = buildCustomerAnalytics(LU, LP).properties.every(pc => near(pc.gross, pc.equity - (lo.find(x => x.unit.key === pc.key).res.costs) + (pc.fromSurplus ?? 0) + pc.loan, 2))
T('Wohnungskarte: Gesamtpreis = Eigenkapital + Miete/MwSt + Darlehen', cardOk)
// ── 13. Review Runde 2 (7.10.26) ─────────────────────────────────────────────
// (1) Rendite: Eigenkapital-Abfluss genau wie in der Liquiditaetsrechnung
const S1 = [mamba({ rent: 3500 }), { key: 'C', name: 'Bar', priceNet: 250000, furnNet: 0, rent: 1200, letType: 'long', fin: false,
  buyM: 6, buyY: 2030, readyM: 6, readyY: 2030, plan: 'sofort', calc: {} }]
const P1 = { ...LP, ek: 600000, interest: 4, exitAfterYears: 0 }
const o1 = allocate(S1, P1), a1 = aggregate(o1, P1), t1 = totalsOf(o1, a1.rows, P1, null, a1.liquidity)
const ekY = new Map(); for (const r of a1.liquidity.records) ekY.set(Math.floor(r.ym / 12), (ekY.get(Math.floor(r.ym / 12)) ?? 0) + r.fromEquity)
for (const o of o1) ekY.set(o.unit.readyY, (ekY.get(o.unit.readyY) ?? 0) + (o.res.ekStart - o.res.ekAbs))
const last1 = a1.rows[a1.rows.length - 1]
const flows1 = a1.rows.map(r => r.cashflow - (ekY.get(r.year) ?? 0)); flows1[flows1.length - 1] += last1.value + last1.committed - last1.debt
T('Rendite nutzt den Eigenkapital-Zeitpunkt der Liquiditätsrechnung', near(t1.irr, irrCalc(flows1), 1e-9), `${(t1.irr * 100).toFixed(2)} %`)
// (2) Verkauf vor der MwSt-Erstattung: Forderung statt Rueckzahlung
const o2 = allocate([mamba()], { ...P, exitAfterYears: 4 })
const l2 = saleLineOf(o2[0], 2029, { ...P, exitAfterYears: 4 })
T('Verkauf vor der Erstattung: keine Rückzahlung, sondern Forderung (Erstattung minus Berichtigung)', near(l2.vatClawback, Math.round(o2[0].res.vatRefund * 8 / 10) - o2[0].res.vatRefund, 1), `${eur(l2.vatClawback)}`)
const l2b = saleLineOf(o2[0], 2031, { ...P, exitAfterYears: 6 })
T('Verkauf nach der Erstattung: Rückzahlung wie bisher (6 von 10 Restjahren)', near(l2b.vatClawback, Math.round(o2[0].res.vatRefund * 6 / 10), 1))
// (3) Einbehalt nur fuers laufende Fenster
const mA = mamba({ key: 'A', priceNet: 400000, rent: 6000, buyM: 1, buyY: 2026, readyM: 6, readyY: 2026 })
const mB = mamba({ key: 'B', priceNet: 400000, rent: 6000, buyM: 6, buyY: 2029, readyM: 6, readyY: 2031 })
const P3 = { ...P, ek: 400000, interest: 4, exitAfterYears: 0 }
const aA = aggregate(allocate([mA], P3), P3), aAB = aggregate(allocate([mA, mB], P3), P3)
T('Einbehalt im Fenster A unabhängig von späterem Kauf B', near(aA.rows.find(r => r.year === 2027).retained ?? 0, aAB.rows.find(r => r.year === 2027).retained ?? 0, 1),
  `${eur(aA.rows.find(r => r.year === 2027).retained ?? 0)} / ${eur(aAB.rows.find(r => r.year === 2027).retained ?? 0)}`)
// (4) Zurueckgefuehrte Erstattung nach Planende wird nicht genannt
const an4 = buildCustomerAnalytics([mamba({ vatReturn: true })], { ...P, ek: 300000, exitAfterYears: 4 })
T('Erstattung nach dem Verkauf wird nicht als zurückgeführt genannt', an4.vatReturned.length === 0)
// (5) Wohnungskarte geht auf, auch wenn der Plan in den Raten endet
const an5 = buildCustomerAnalytics([mamba()], { ...P, ek: 300000, exitAfterYears: 4 })
const c5 = an5.properties[0], o5 = allocate([mamba()], { ...P, ek: 300000, exitAfterYears: 4 })[0]
T('Karte bei Verkauf in den Raten: Preis = EK + Miete/MwSt + Kredit + offene Raten', near(c5.gross, c5.equity - o5.res.costs + (c5.fromSurplus ?? 0) + c5.loan + (c5.openRest ?? 0), 2) && c5.openRestFromSale && c5.creditSoFar,
  `offen ${eur(c5.openRest ?? 0)}`)
// (6) Kennzahlen unabhaengig von der Listenreihenfolge
const cpa = buildCustomerAnalytics(LU, { ...LP, ek: 400000 }).creditPath, cpb = buildCustomerAnalytics([...LU].reverse(), { ...LP, ek: 400000 }).creditPath
T('"Eigenkapital reicht bis" / "Kredit nötig ab" unabhängig von der Reihenfolge', cpa.equityLastYm === cpb.equityLastYm && cpa.firstCreditYm === cpb.firstCreditYm,
  `${cpa.equityLastYm} ${cpa.firstCreditYm}`)
// (7) Grammatik
const ho7 = buildCustomerAnalytics([mamba({ rent: 500, vatReturn: true })], { ...P, ek: 300000 }).timeline.find(e => e.kind === 'handover').detail
T('Satz zur Übergabe: „Davon kommen …"', /Davon kommen/.test(ho7) && !/Davon zahlen/.test(ho7), ho7)
// (8) Alle Erstattungen zurueckgefuehrt: nur die Miete zahlt mit
const an8 = buildCustomerAnalytics(LU.map(u => ({ ...u, vatReturn: true })), LP)
T('Alles zurückgeführt: Texte ohne MwSt', an8.surplusWithVat === false && !/MwSt-Erstattung \d/.test(an8.timeline.map(e => e.detail).join(' ')))
// (9) Kreditbedarf mit Planende: Kredit gesamt = Darlehen (inkl. bis Planende abgerufen)
const cp9 = an5.creditPath
T('Kreditbedarf bei Verkauf in den Raten: Kredit gesamt = aufgeführte Kredite', near(cp9.creditTotal, cp9.loans.reduce((a, l) => a + l.amount, 0), 3) && cp9.loans.every(l => l.afterEnd))
// (10) Barkauf mit zu wenig EK: offener Kredit sichtbar und in der Summe
const an10 = buildCustomerAnalytics([mamba({ key: 'A1' }), mamba({ key: 'C1', fin: false, plan: 'luma', schedule: null })], { ...LP, ek: 600000 })
const cp10 = an10.creditPath
T('Barkauf ohne genug EK: offener Kredit gelistet, Summe stimmt', cp10.loans.some(l => l.open) && near(cp10.creditTotal, cp10.loans.reduce((a, l) => a + l.amount, 0), 3)
  && an10.properties.find(pc => pc.key === 'C1').openCredit > 0)
// ── 14. Saisonmodell im Uebergabejahr (Sven 7.10.26) ─────────────────────────
const SN = { totalOcc: 60, adrHigh: 350 }
const seasonUnit = (m) => kuu({ key: 'S' + m, priceNet: 585000, furnNet: 25000, readyM: m, readyY: 2027, calc: { season: SN, mgmtPct: 25, bedrooms: 2 } })
const [oDec] = allocate([seasonUnit(12)], LP), [oJun] = allocate([seasonUnit(6)], LP)
const shareDec = oDec.res.rents[0] / (oDec.res.rents[1] / (1 + LP.rentGrowth / 100))
const shareJun = oJun.res.rents[0] / (oJun.res.rents[1] / (1 + LP.rentGrowth / 100))
T('Übergabe Dezember: nur der Saisonanteil Dezember (ca. 2,4 %)', shareDec > 0.02 && shareDec < 0.03, `${(shareDec * 100).toFixed(2)} %`)
T('Übergabe Juni: Juni bis Dezember (ca. 78 %)', shareJun > 0.74 && shareJun < 0.82, `${(shareJun * 100).toFixed(1)} %`)
T('Einzelrechnung unverändert (ohne Schalter Monate/12)', compute({ ...DEFAULT_PARAMS, letType: 'short', season: SN, month: 12 }).rents[0] === Math.round(compute({ ...DEFAULT_PARAMS, letType: 'short', season: SN, month: 12 }).rents[1] / (1 + DEFAULT_PARAMS.rentGrowth / 100) / 12))
// Reinvestment: Liquiditaetsrechnung aus (eigener Kassen-Motor)
T('Reinvest: keine Liquiditätsrechnung', !aggregate(allocate(LU, { ...LP, reinvestEnabled: true }), { ...LP, reinvestEnabled: true }).liquidity)

console.log(`\n${fail ? '❌' : '🎉'}  ${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
