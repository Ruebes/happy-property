// Prüft die Werbe-Mathematik (Qualitäts-Score / Autopilot) gegen die Entscheidungstabelle
// aus 05-automation-design §2.5, das Rechenbeispiel §2.7, die geschlossene Poisson-Form
// für ganzzahliges alpha, P + Q = 1, Monotonie und die Spiegel-Identität
// src/lib/werbeMathe.ts == supabase/functions/_shared/werbeMathe.ts (Byte für Byte).
//
// Ausführen:
//   node scripts/verify-werbe-mathe.mjs

import { execSync } from 'child_process'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'src/lib/werbeMathe.ts')
const EDGE = join(root, 'supabase/functions/_shared/werbeMathe.ts')

const fails = []
let checked = 0
const check = (ok, msg) => { checked++; if (!ok) fails.push(msg) }

// ── 0. Spiegel-Identität ────────────────────────────────────────────────────
const a = readFileSync(SRC)
const b = readFileSync(EDGE)
check(a.equals(b), 'src/lib/werbeMathe.ts und supabase/functions/_shared/werbeMathe.ts sind NICHT byte-identisch')

const dir = mkdtempSync(join(tmpdir(), 'hpwerbe-'))
const out = join(dir, 'werbeMathe.mjs')
execSync(`npx --yes esbuild ${JSON.stringify(EDGE)} --format=esm --outfile=${JSON.stringify(out)} --log-level=warning`, { stdio: 'pipe', cwd: root })
const m = await import(out)

// ── 1. Entscheidungstabelle §2.5 (Prior alpha0 1,5, Referenz 145, T = 290) ──
const SPENDS = [150, 300, 450, 600, 900]
const CPTE = {
  0: [245, 345, 445, 545, 745],
  1: [147, 207, 267, 327, 447],
  2: [105, 148, 191, 234, 319],
  3: [82, 115, 148, 182, 248],
}
const PGT = {
  0: [0.53, 0.69, 0.80, 0.87, 0.95],
  1: [0.23, 0.39, 0.53, 0.66, 0.83],
  2: [0.08, 0.17, 0.29, 0.42, 0.64],
  3: [0.02, 0.06, 0.13, 0.22, 0.44],
}
for (const k of [0, 1, 2, 3]) {
  SPENDS.forEach((S, i) => {
    const alpha = 1.5 + k
    const beta = 217.5 + S
    const post = m.posterior(k, S, 145, 1.5)
    check(Math.abs(post.alpha - alpha) < 1e-12 && Math.abs(post.beta - beta) < 1e-9, `posterior(${k}, ${S}, 145) = ${post.alpha}/${post.beta}, erwartet ${alpha}/${beta}`)
    check(Math.round(beta / alpha) === CPTE[k][i], `Tabelle k=${k} S=${S}: CPTE_hat ${Math.round(beta / alpha)} != ${CPTE[k][i]}`)
    check(Math.round(post.cpteHat) === CPTE[k][i], `posterior().cpteHat k=${k} S=${S}: ${post.cpteHat}`)
    const p = m.gammaP(alpha, beta / 290)
    check(Math.abs(p - PGT[k][i]) <= 0.006, `Tabelle k=${k} S=${S}: P(>290) ${p.toFixed(4)} weicht von ${PGT[k][i]} ab`)
    const p2 = m.pCpteGreater(alpha, beta, 290)
    check(Math.abs(p2 - p) < 1e-15, `pCpteGreater != gammaP bei k=${k} S=${S}`)
  })
}

// ── 2. Rechenbeispiel §2.7 ──────────────────────────────────────────────────
{
  const te = 4.0 + 1.6 + 1.2 + 3 * 0.20 + 3 * 0.05
  check(Math.abs(te - 7.55) < 1e-9, `Rechenbeispiel: QP ${te} != 7,55`)
  const post = m.posterior(te, 420, 145, 1.5)
  check(Math.abs(post.alpha - 9.05) < 1e-9 && Math.abs(post.beta - 637.5) < 1e-9, `Rechenbeispiel: alpha/beta ${post.alpha}/${post.beta}`)
  check(Math.abs(post.cpteHat - 70.44) < 0.05, `Rechenbeispiel: CPTE_hat ${post.cpteHat} statt ~70,4`)
  const pGood = m.pCpteLess(9.05, 637.5, 145)
  check(pGood >= 0.96, `Rechenbeispiel: p_good ${pGood} < 0,96`)
}

// ── 3. Ganzzahliges alpha gegen geschlossene Poisson-Form ───────────────────
// P(a, x) = 1 - sum_{i<a} e^-x x^i / i!
for (let a0 = 1; a0 <= 12; a0++) {
  for (const x of [0.05, 0.3, 1, 2.5, a0 - 0.5, a0, a0 + 0.5, a0 + 1, 5, 9.7, 15, 30, 60]) {
    if (!(x > 0)) continue
    let sum = 0
    let term = Math.exp(-x)
    for (let i = 0; i < a0; i++) {
      if (i > 0) term *= x / i
      sum += term
    }
    const closed = 1 - sum
    const got = m.gammaP(a0, x)
    check(Math.abs(got - closed) <= 1e-9, `gammaP(${a0}, ${x}) = ${got}, Poisson-Form ${closed}`)
  }
}

// ── 4. P + Q = 1 und Monotonie ──────────────────────────────────────────────
for (const a0 of [0.3, 1, 1.5, 2.5, 4.05, 9.05, 25, 80]) {
  let prev = -1
  for (let x = 0.01; x < 200; x *= 1.37) {
    const p = m.gammaP(a0, x)
    const qq = m.gammaQ(a0, x)
    check(Math.abs(p + qq - 1) < 1e-12, `P + Q != 1 bei a=${a0} x=${x}`)
    check(p >= 0 && p <= 1, `P außerhalb [0,1] bei a=${a0} x=${x}: ${p}`)
    check(p >= prev - 1e-12, `gammaP nicht monoton in x bei a=${a0} x=${x}`)
    prev = p
  }
}
for (const x of [0.5, 2, 6, 20]) {
  let prev = 2
  for (let a0 = 0.5; a0 < 40; a0 += 0.75) {
    const p = m.gammaP(a0, x)
    check(p <= prev + 1e-12, `gammaP nicht fallend in a bei x=${x} a=${a0}`)
    prev = p
  }
}
// Mehr Spend bei gleichen TE -> höhere P(CPTE > T); mehr TE bei gleichem Spend -> niedrigere
for (const k of [0, 1, 3]) {
  let prev = -1
  for (let S = 0; S <= 2000; S += 50) {
    const p = m.pCpteGreater(1.5 + k, 217.5 + S, 290)
    check(p >= prev - 1e-12, `pCpteGreater nicht steigend im Spend (k=${k}, S=${S})`)
    prev = p
  }
}
{
  let prev = 2
  for (let k = 0; k <= 10; k += 0.5) {
    const p = m.pCpteGreater(1.5 + k, 717.5, 290)
    check(p <= prev + 1e-12, `pCpteGreater nicht fallend in TE (k=${k})`)
    prev = p
  }
}
check(m.gammaP(2, 0) === 0, 'gammaP(a, 0) muss 0 sein')

// ── Zusatz: weitere exportierte Funktionen ──────────────────────────────────
check(Math.abs(m.lgamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-12, `lgamma(0,5) = ${m.lgamma(0.5)}`)
check(Math.abs(m.lgamma(10) - Math.log(362880)) < 1e-10, `lgamma(10) = ${m.lgamma(10)}`)
for (const [al, be] of [[1.5, 367.5], [9.05, 637.5], [4.5, 1117.5]]) {
  for (const qv of [0.1, 0.5, 0.9]) {
    const c = m.cpteQuantil(al, be, qv)
    const back = m.pCpteLess(al, be, c)
    check(Math.abs(back - qv) < 1e-8, `cpteQuantil(${al}, ${be}, ${qv}) = ${c}, P(CPTE < c) = ${back}`)
  }
}
{
  const r1 = m.mulberry32(42), r2 = m.mulberry32(42)
  let same = true
  for (let i = 0; i < 50; i++) if (r1() !== r2()) same = false
  check(same, 'mulberry32 ist bei gleichem Seed nicht reproduzierbar')
  const rnd = m.mulberry32(7)
  let s = 0
  const N = 20000
  for (let i = 0; i < N; i++) s += m.gammaSample(3.5, 2, rnd)
  check(Math.abs(s / N - 1.75) < 0.05, `gammaSample Mittelwert ${s / N} statt 1,75`)
  let s2 = 0
  for (let i = 0; i < N; i++) s2 += m.gammaSample(0.6, 1, rnd)
  check(Math.abs(s2 / N - 0.6) < 0.03, `gammaSample (shape < 1) Mittelwert ${s2 / N} statt 0,6`)
  const arms = [
    { schluessel: 'miete', te: 6, spend_eur: 450, getestet: 4 },
    { schluessel: 'kosten', te: 1, spend_eur: 500, getestet: 3 },
    { schluessel: 'neu', te: 0, spend_eur: 0, getestet: 0 },
  ]
  const t1 = m.thompsonAnteile(arms, { seed: 3 })
  const t2 = m.thompsonAnteile(arms, { seed: 3 })
  check(JSON.stringify(t1) === JSON.stringify(t2), 'thompsonAnteile nicht deterministisch')
  const sumA = t1.reduce((x, y) => x + y.anteil, 0)
  const sumP = t1.reduce((x, y) => x + y.p_best, 0)
  check(Math.abs(sumA - 1) < 1e-9 && Math.abs(sumP - 1) < 1e-9, `thompsonAnteile Summen ${sumA} / ${sumP}`)
  check(t1[0].p_best > t1[1].p_best, 'thompsonAnteile: besserer Winkel hat nicht höhere P_best')
  check(t1[2].anteil >= 0.3 - 1e-9, 'thompsonAnteile: Explorationsanteil fehlt')
}
check(Math.abs(m.betaPosteriorMean(5, 6, 0.65, 20) - 18 / 26) < 1e-12, 'betaPosteriorMean Beispiel §2.3 (5 von 6, Start 0,65) != 0,69')
check(m.usdProEur(114, 100) === 1.14 && m.usdProEur(0, 0) === 1.14 && Math.abs(m.usdProEur(120, 100) - 1.2) < 1e-12, 'usdProEur')
check(m.eurZuCents(50, 1.14) === 5700 && Math.abs(m.centsZuEur(5700, 1.14) - 50) < 1e-9, 'Cent/EUR-Umrechnung')
check(m.kennungId('123', 'plan_b_miete_lang') === '123:plan_b_miete' && m.kennungBasis('x_kurz') === 'x' && m.kennungBasis('x_kurz_v2') === 'x_kurz_v2', 'kennungId/kennungBasis')
// wie SQL: coalesce(nullif(regexp_replace(btrim(ad_name), '_(lang|kurz)$', '', 'i'), ''), ad_id)
{
  const faelle = [
    [['X_Kurz', '9'], 'X'], [['x_LANG', '9'], 'x'], [['a1_kurz ', '9'], 'a1'], [['  a1_lang', '9'], 'a1'],
    [['', '9'], '9'], [[null, '9'], '9'], [['_kurz', '9'], '9'], [['   ', '9'], '9'], [['a_kurz_kurz', '9'], 'a_kurz'],
    [['a\t', '9'], 'a\t'], [['', undefined], ''], [['plan_b_kurz', null], 'plan_b'],
  ]
  for (const [[name, id], soll] of faelle) {
    const ist = m.kennungBasis(name, id)
    check(ist === soll, `kennungBasis(${JSON.stringify(name)}, ${JSON.stringify(id)}) = ${JSON.stringify(ist)}, erwartet ${JSON.stringify(soll)}`)
  }
  check(m.kennungId('C1', 'a1_Kurz ', '7') === 'C1:a1' && m.kennungId('C1', '', '7') === 'C1:7' && m.kennungId('C1', null, '7') === 'C1:7', 'kennungId mit Anzeigen-ID-Rückfall')
}
check(m.maxAktiveAnzeigen(120) === 6 && m.maxAktiveAnzeigen(300) === 10 && m.maxAktiveAnzeigen(50) === 4, 'maxAktiveAnzeigen clamp(floor(b/20), 4, 10)')
check(m.berlinTag(Date.parse('2026-10-04T22:30:00Z')).datum === '2026-10-05' && m.berlinTag(Date.parse('2026-10-05T04:30:00Z')).wochentag === 1, 'berlinTag Zeitzone Europe/Berlin')
check(m.monatsende('2026-02-11') === '2026-02-28' && m.tageZwischen('2026-10-01', '2026-10-05') === 4, 'monatsende/tageZwischen')

if (fails.length) {
  console.error(`verify-werbe-mathe: ${fails.length} von ${checked} Prüfungen FEHLGESCHLAGEN`)
  for (const f of fails.slice(0, 40)) console.error('  - ' + f)
  process.exit(1)
}
console.log(`verify-werbe-mathe: ${checked} Prüfungen ok (Tabelle 2.5, Beispiel 2.7, Poisson-Form, P+Q, Monotonie, Spiegel identisch)`)
