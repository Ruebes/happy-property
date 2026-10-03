// IDENTISCH zu src/lib/werbeMathe.ts (bzw. supabase/functions/_shared/werbeMathe.ts). Änderungen immer in beiden Dateien; npm run verify:werbe prüft das.
//
// Werbe-Mathematik für den Qualitäts-Score und den Autopilot (rein, keine Imports,
// läuft im Browser, in Node und in Deno).
//
// Modell (05-automation-design §2.5): Termin-Äquivalente (TE) fallen je ausgegebenem
// Euro mit Rate lambda an (Poisson). Prior lambda ~ Gamma(a0, a0 * CPTE_parent),
// Posterior nach Spend S und Qualitätspunkten q: alpha = a0 + q, beta = a0 * prior + S.
//   CPTE_hat        = beta / alpha
//   P(CPTE > T)     = P(lambda < 1/T) = gammaP(alpha, beta / T)
//   P(CPTE < T)     = 1 - gammaP(alpha, beta / T)
//
// lgamma und gammaP sind Zeile für Zeile dieselben Verfahren wie die SQL-Funktionen
// werbe_lgamma / werbe_gamma_p (Lanczos g=7, Reihe bzw. Kettenbruch nach Lentz),
// damit UI, Regel-Engine und Datenbank dieselben Zahlen liefern.

const LANCZOS: number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
]

/** ln(Gamma(x)) nach Lanczos (g = 7), Spiegelung für x < 0,5. */
export function lgamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x)
  const y = x - 1
  let a = LANCZOS[0]
  const t = y + 7.5
  for (let i = 1; i <= 8; i++) a += LANCZOS[i] / (y + i)
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Regularisierte untere unvollständige Gammafunktion P(a, x). */
export function gammaP(a: number, x: number): number {
  if (!(a > 0) || !Number.isFinite(a)) return Number.NaN
  if (!(x > 0)) return 0
  if (!Number.isFinite(x)) return 1
  if (x < a + 1) {
    let s = 1 / a
    let t = s
    let n = 1
    while (Math.abs(t) > 1e-14 * Math.abs(s) && n < 1000) {
      t = (t * x) / (a + n)
      s += t
      n++
    }
    return clamp01(s * Math.exp(-x + a * Math.log(x) - lgamma(a)))
  }
  let b = x + 1 - a
  let c = 1e300
  let d = 1 / b
  let h = d
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < 1e-300) d = 1e-300
    c = b + an / c
    if (Math.abs(c) < 1e-300) c = 1e-300
    d = 1 / d
    const de = d * c
    h *= de
    if (Math.abs(de - 1) < 1e-14) break
  }
  return clamp01(1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h)
}

/** Obere regularisierte unvollständige Gammafunktion Q(a, x) = 1 - P(a, x). */
export function gammaQ(a: number, x: number): number {
  return 1 - gammaP(a, x)
}

export interface Posterior {
  alpha: number
  beta: number
  cpteHat: number
}

/**
 * Gamma-Poisson-Posterior für Kosten pro TE.
 * q = Qualitätspunkte (TE, gedeckelt), S = Spend in EUR, prior = CPTE der Elternebene,
 * a0 = Prior-Stärke in TE (Standard 1,5).
 */
export function posterior(q: number, S: number, prior: number, a0 = 1.5): Posterior {
  const qq = Number.isFinite(q) && q > 0 ? q : 0
  const ss = Number.isFinite(S) && S > 0 ? S : 0
  const pp = Number.isFinite(prior) && prior > 0 ? prior : 0
  const alpha = a0 + qq
  const beta = a0 * pp + ss
  return { alpha, beta, cpteHat: alpha > 0 ? beta / alpha : Number.NaN }
}

/** P(CPTE > T) bei Posterior Gamma(alpha, beta). */
export function pCpteGreater(alpha: number, beta: number, T: number): number {
  if (!(T > 0)) return 1
  if (!(beta > 0)) return 0
  return gammaP(alpha, beta / T)
}

/** P(CPTE < T) bei Posterior Gamma(alpha, beta). */
export function pCpteLess(alpha: number, beta: number, T: number): number {
  return 1 - pCpteGreater(alpha, beta, T)
}

/**
 * q-Quantil der Kosten pro TE (CPTE = 1/lambda): das c mit P(CPTE <= c) = q.
 * Bisektion auf x = beta / c, denn P(CPTE <= c) = Q(alpha, beta / c).
 */
export function cpteQuantil(alpha: number, beta: number, q: number): number {
  if (!(alpha > 0) || !(beta > 0)) return Number.NaN
  if (!(q > 0)) return 0
  if (!(q < 1)) return Number.POSITIVE_INFINITY
  const ziel = 1 - q // gesucht: gammaP(alpha, x) = 1 - q
  let lo = 0
  let hi = Math.max(1, alpha)
  let n = 0
  while (gammaP(alpha, hi) < ziel && n < 200) {
    hi *= 2
    n++
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (gammaP(alpha, mid) < ziel) lo = mid
    else hi = mid
    if (hi - lo < 1e-12 * Math.max(1, hi)) break
  }
  const x = (lo + hi) / 2
  return x > 0 ? beta / x : Number.POSITIVE_INFINITY
}

/** Deterministischer Zufallszahlengenerator (mulberry32), Werte in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normalSample(rnd: () => number): number {
  const u1 = 1 - rnd() // (0, 1]
  const u2 = rnd()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** Stichprobe aus Gamma(shape, rate) nach Marsaglia-Tsang (shape < 1 per Boost). */
export function gammaSample(shape: number, rate: number, rnd: () => number): number {
  if (!(shape > 0) || !(rate > 0)) return Number.NaN
  if (shape < 1) {
    const u = 1 - rnd()
    return gammaSample(shape + 1, rate, rnd) * Math.pow(u, 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (let i = 0; i < 10000; i++) {
    const x = normalSample(rnd)
    const v0 = 1 + c * x
    if (v0 <= 0) continue
    const v = v0 * v0 * v0
    const u = 1 - rnd()
    if (u < 1 - 0.0331 * x * x * x * x) return (d * v) / rate
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return (d * v) / rate
  }
  return shape / rate
}

export interface ThompsonArm {
  /** z. B. Winkel */
  schluessel: string
  /** Summe TE (gedeckelt) */
  te: number
  /** Summe Spend in EUR */
  spend_eur: number
  /** Anzahl bereits getesteter Werbemittel in diesem Arm */
  getestet?: number
}

export interface ThompsonOptionen {
  draws?: number
  exploit?: number
  seed?: number
  /** Prior-CPTE (Ziel), Standard 145 */
  prior_cpte?: number
  a0?: number
  /** Arme mit weniger getesteten Werbemitteln bekommen den Explorationsanteil */
  min_getestet?: number
}

export interface ThompsonAnteil {
  schluessel: string
  p_best: number
  anteil: number
  exploration: boolean
}

/**
 * Thompson Sampling über Arme (Winkel): je Ziehung lambda ~ Gamma(a0 + te, a0 * prior + spend),
 * P_best = Anteil der Ziehungen, in denen der Arm die höchste TE-Rate hat.
 * Anteil = exploit * P_best + (1 - exploit) gleichmäßig auf Arme mit < min_getestet Tests
 * (gibt es keine, geht alles in exploit).
 */
export function thompsonAnteile(arms: ThompsonArm[], opt: ThompsonOptionen = {}): ThompsonAnteil[] {
  const n = arms.length
  if (!n) return []
  const draws = Math.max(1, Math.floor(opt.draws ?? 4000))
  const exploitRaw = opt.exploit ?? 0.7
  const prior = opt.prior_cpte ?? 145
  const a0 = opt.a0 ?? 1.5
  const minGetestet = opt.min_getestet ?? 2
  const rnd = mulberry32(opt.seed ?? 1)
  const siege: number[] = new Array(n).fill(0)
  const shapes = arms.map(a => a0 + Math.max(0, a.te || 0))
  const rates = arms.map(a => a0 * prior + Math.max(0, a.spend_eur || 0))
  for (let k = 0; k < draws; k++) {
    let best = 0
    let bestVal = -1
    for (let i = 0; i < n; i++) {
      const v = gammaSample(shapes[i], rates[i], rnd)
      if (v > bestVal) {
        bestVal = v
        best = i
      }
    }
    siege[best]++
  }
  const explore = arms.map(a => (a.getestet ?? 0) < minGetestet)
  const nExplore = explore.filter(Boolean).length
  const exploit = nExplore > 0 ? exploitRaw : 1
  return arms.map((a, i) => {
    const pBest = siege[i] / draws
    const anteil = exploit * pBest + (explore[i] && nExplore > 0 ? (1 - exploit) / nExplore : 0)
    return { schluessel: a.schluessel, p_best: pBest, anteil, exploration: explore[i] }
  })
}

/** Beta-Posterior-Mittelwert: (erfolge + priorN * priorMean) / (n + priorN). */
export function betaPosteriorMean(erfolge: number, n: number, priorMean: number, priorN: number): number {
  const nn = Math.max(0, n)
  const pn = Math.max(0, priorN)
  if (nn + pn <= 0) return priorMean
  return (Math.max(0, erfolge) + pn * priorMean) / (nn + pn)
}

export interface PrognoseEingabe {
  /** Freigaben unter den Entscheidungen mit passenden Merkmalen */
  ja: number
  /** Entscheidungen mit passenden Merkmalen */
  n: number
  /** Globale Freigabequote aller Entscheidungen (Glättungsziel) */
  globale_quote: number
  /** Review-Note 0-100 (optional) */
  review_score?: number | null
  /** Pseudo-Stichprobe für die Glättung (Standard 5) */
  prior_n?: number
}

/**
 * Wahrscheinlichkeit, dass Sven/Giona ein Werbemittel freigeben: Beta-Posterior über
 * Entscheidungen mit passenden Merkmalen, geglättet zur globalen Quote; die Review-Note
 * zählt umso weniger, je mehr Entscheidungen vorliegen (Gewicht 0,5 * prior_n / (prior_n + n)).
 */
export function freigabePrognose(e: PrognoseEingabe): number {
  const priorN = e.prior_n ?? 5
  const g = clamp01(Number.isFinite(e.globale_quote) ? e.globale_quote : 0.5)
  const pm = betaPosteriorMean(e.ja, e.n, g, priorN)
  if (e.review_score == null || !Number.isFinite(e.review_score)) return clamp01(pm)
  const w = (0.5 * priorN) / (priorN + Math.max(0, e.n))
  return clamp01((1 - w) * pm + w * clamp01(e.review_score / 100))
}

// ── Währung ─────────────────────────────────────────────────────────────────

export const USD_PRO_EUR_FALLBACK = 1.14

/** Kurs USD pro EUR aus sum(spend USD) / sum(spend_eur) (7 Tage), sonst Fallback 1,14. */
export function usdProEur(spendUsd: number, spendEur: number, fallback = USD_PRO_EUR_FALLBACK): number {
  if (!(spendUsd > 0) || !(spendEur > 0)) return fallback
  const k = spendUsd / spendEur
  return k > 0.5 && k < 3 ? k : fallback
}

/** USD-Cent (Kontowährung) in EUR. */
export function centsZuEur(cents: number, usdPerEur: number): number {
  return cents / 100 / usdPerEur
}

/** EUR in USD-Cent (gerundet). */
export function eurZuCents(eur: number, usdPerEur: number): number {
  return Math.round(eur * usdPerEur * 100)
}

// ── Kennung (Werbemittel-Ebene) ─────────────────────────────────────────────

/**
 * Basisname einer Anzeige wie in werbe_qualitaet_berechnen (SQL):
 * coalesce(nullif(regexp_replace(btrim(ad_name), '_(lang|kurz)$', '', 'i'), ''), ad_id).
 * btrim entfernt nur Leerzeichen, das Suffix zählt ohne Groß-/Kleinschreibung,
 * leerer Rest fällt auf die Anzeigen-ID zurück.
 */
export function kennungBasis(adName: string | null | undefined, adId?: string | null): string {
  const b = String(adName ?? '').replace(/^ +| +$/g, '').replace(/_(lang|kurz)$/i, '')
  return b || String(adId ?? '')
}

/** Kennungs-ID wie in ad_quality_daily: campaign_id || ':' || Basisname (Rückfall Anzeigen-ID). */
export function kennungId(campaignId: string | null | undefined, adName: string | null | undefined, adId?: string | null): string {
  return `${campaignId ?? ''}:${kennungBasis(adName, adId)}`
}

/** Höchstzahl aktiver Anzeigen je Anzeigengruppe: clamp(floor(Tagesbudget / 20), 4, 10). */
export function maxAktiveAnzeigen(tagesbudgetEur: number, proAnzeige = 20, min = 4, max = 10): number {
  const n = Math.floor((Number.isFinite(tagesbudgetEur) ? tagesbudgetEur : 0) / proAnzeige)
  return Math.min(max, Math.max(min, n))
}

// ── Kalender Europe/Berlin (Werbekonto-Zeitzone) ────────────────────────────

export interface BerlinTag {
  /** YYYY-MM-DD */
  datum: string
  /** 0 = Sonntag, 1 = Montag, ... 6 = Samstag */
  wochentag: number
}

/** Kalendertag und Wochentag in Europe/Berlin für einen Zeitpunkt (ms). */
export function berlinTag(ms: number): BerlinTag {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  let y = ''
  let m = ''
  let d = ''
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type === 'year') y = p.value
    else if (p.type === 'month') m = p.value
    else if (p.type === 'day') d = p.value
  }
  const datum = `${y}-${m}-${d}`
  return { datum, wochentag: wochentagVonDatum(datum) }
}

/** Wochentag (0 = Sonntag) eines Kalenderdatums YYYY-MM-DD. */
export function wochentagVonDatum(datum: string): number {
  return new Date(`${datum.slice(0, 10)}T00:00:00Z`).getUTCDay()
}

/** Ganze Kalendertage von a nach b (b - a), Datumsangaben YYYY-MM-DD. */
export function tageZwischen(a: string, b: string): number {
  const ta = Date.parse(`${a.slice(0, 10)}T00:00:00Z`)
  const tb = Date.parse(`${b.slice(0, 10)}T00:00:00Z`)
  return Math.round((tb - ta) / 86400000)
}

/** Kalenderdatum + n Tage. */
export function datumPlus(datum: string, n: number): string {
  return new Date(Date.parse(`${datum.slice(0, 10)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
}

/** Letzter Tag des Monats eines Datums YYYY-MM-DD. */
export function monatsende(datum: string): string {
  const y = Number(datum.slice(0, 4))
  const m = Number(datum.slice(5, 7))
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return v
  return v < 0 ? 0 : v > 1 ? 1 : v
}
