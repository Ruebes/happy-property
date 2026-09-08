import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { compute, DEFAULT_PARAMS, defaultMgmtPct, CY_CORP_TAX_PCT } from '../lib/rechner'

// ── Antwortseite /zypern-check ───────────────────────────────────────────────
// Landeseite fuer Anzeigen in ChatGPT. Der Verkehr von dort kommt aus einer
// gestellten Frage, nicht aus einer Unterbrechung im Feed: der Besucher will
// zuerst eine Antwort sehen und erst danach ein Angebot. Deshalb steht oben die
// Antwort, in der Mitte der Rechner (dieselbe Engine wie im CRM, damit keine
// zweite Wahrheit entsteht) und erst darunter der Termin.
//
// Der Klickpreis in ChatGPT liegt bei 3 bis 5 $. Eine Seite, die erst nach dem
// Scrollen liefert, verbrennt dieses Geld. Alles Wesentliche steht deshalb ohne
// Scrollen oder direkt darunter.

const CORAL = '#ff795d'
const NAVY = '#1a2332'

// Die Herkunft muss bis zum Funnel durchgereicht werden, sonst weiss das CRM
// spaeter nicht, welche Anzeige den Termin gebracht hat.
function terminHref(): string {
  const p = new URLSearchParams(window.location.search)
  const durch = new URLSearchParams()
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'ref']) {
    const v = p.get(k)
    if (v) durch.set(k, v.slice(0, 120))
  }
  // Ohne Herkunft in der URL trotzdem als ChatGPT-Verkehr kennzeichnen: die
  // Seite wird ausschliesslich aus diesen Anzeigen heraus verlinkt.
  if (!durch.get('utm_source') && !durch.get('src')) durch.set('utm_source', 'chatgpt')
  if (!durch.get('utm_campaign')) durch.set('utm_campaign', 'zypern-check')
  return `/termin?${durch.toString()}`
}

const eur = (n: number) => Math.round(n).toLocaleString('de-DE') + ' €'

interface Fakt { k: string; f: string }

export default function ZypernCheck() {
  const { t } = useTranslation()
  const [preis, setPreis] = useState(300000)
  const [eigen, setEigen] = useState(120000)
  const [art, setArt] = useState<'short' | 'long'>('short')

  const href = useMemo(() => terminHref(), [])

  // Bewusst dieselbe Engine wie /rechnung und der Strategie-Simulator. Fuer die
  // Landeseite werden nur drei Groessen freigegeben, der Rest bleibt auf den
  // Standardannahmen stehen.
  const r = useMemo(() => compute({
    ...DEFAULT_PARAMS,
    priceNet: preis,
    equity: Math.min(eigen, preis),
    fin: eigen >= preis ? 'no' : 'yes',
    letType: art,
    // Verwaltungsanteil haengt an der Vermietungsart (25 % kurz, 5 % lang).
    // DEFAULT_PARAMS steht auf 2 % und wuerde den Cashflow schoenrechnen.
    mgmtPct: defaultMgmtPct(art),
    // Ab Januar rechnen, sonst ist "Jahr 1" ein Rumpfjahr und die Kacheln zeigen
    // Betraege, die niemand einordnen kann.
    month: 1, year: new Date().getFullYear() + 1,
    holder: 'privat',
    res: 'de',
    years: 10,
  }), [preis, eigen, art])

  const mieteJ1 = r.rents[0] ?? 0
  const steuerJ1 = r.taxCY[0] ?? 0
  const cfMonat = r.mCF

  const fakten: Fakt[] = [
    { k: t('zypernCheck.fact1k', 'Körperschaftsteuer'), f: t('zypernCheck.fact1f', `${CY_CORP_TAX_PCT} % seit 1. Januar 2026. Vorher waren es 12,5 %.`) },
    { k: t('zypernCheck.fact2k', 'Mieteinnahmen privat'), f: t('zypernCheck.fact2f', '22.000 Euro pro Person und Jahr steuerfrei, danach progressiv. Zusätzlich 20 % Pauschalabzug auf die Bruttomiete.') },
    { k: t('zypernCheck.fact3k', 'Abschreibung'), f: t('zypernCheck.fact3f', '3 % pro Jahr auf den Gebäudeanteil, 10 % auf die Einrichtung.') },
    { k: t('zypernCheck.fact4k', 'Doppelbesteuerung'), f: t('zypernCheck.fact4f', 'Das Abkommen Deutschland/Zypern nutzt die Anrechnungsmethode. Der Vorteil entsteht aus Abschreibung und Zinsen, nicht aus Steuerfreiheit.') },
    { k: t('zypernCheck.fact5k', 'Mehrwertsteuer'), f: t('zypernCheck.fact5f', 'Bei Eigennutzung 5 % statt 19 % auf die ersten 130 qm bis 350.000 Euro. Bei Vermietung gilt der volle Satz.') },
  ]

  const faq: { q: string; a: string }[] = [
    {
      q: t('zypernCheck.faq1q', 'Muss ich nach Zypern ziehen, damit sich das rechnet?'),
      a: t('zypernCheck.faq1a', 'Nein. Die meisten unserer Käufer bleiben in Deutschland gemeldet. Die Miete wird in Zypern besteuert und in Deutschland angerechnet. Wer den Wohnsitz verlegt, hat zusätzlich den Non-Dom-Status, das ist aber eine eigene Entscheidung und keine Voraussetzung.'),
    },
    {
      q: t('zypernCheck.faq2q', 'Wie hoch ist der Einstieg?'),
      a: t('zypernCheck.faq2a', 'Ab rund 200.000 Euro Kaufpreis. Mit Finanzierung liegt das benötigte Eigenkapital typischerweise zwischen 30 und 40 % plus Nebenkosten.'),
    },
    {
      q: t('zypernCheck.faq3q', 'Kurzzeit- oder Langzeitvermietung?'),
      a: t('zypernCheck.faq3a', 'Kurzzeit bringt mehr Ertrag und mehr Aufwand, Langzeit weniger von beidem. Der Rechner oben zeigt beide Varianten. Die Verwaltung übernehmen wir in beiden Fällen.'),
    },
    {
      q: t('zypernCheck.faq4q', 'Wer steht hinter Happy Property?'),
      a: t('zypernCheck.faq4a', 'Sven Rüprich, seit Jahren auf Zypern, spezialisiert auf deutschsprachige Kapitalanleger. Wir begleiten Kauf, Finanzierung, Vermietung und Verwaltung aus einer Hand.'),
    },
  ]

  return (
    <div className="min-h-screen bg-hp-bg font-body text-hp-black">
      <main className="max-w-3xl mx-auto px-5 py-10 sm:py-14">

        {/* Antwort zuerst. Wer aus einer Frage kommt, will keine Begruessung. */}
        <h1 className="font-heading text-3xl sm:text-4xl leading-tight" style={{ color: NAVY }}>
          {t('zypernCheck.h1', 'Lohnt sich eine Immobilie auf Zypern für deutsche Kapitalanleger?')}
        </h1>
        <p className="mt-4 text-base sm:text-lg leading-relaxed text-hp-slate">
          {t('zypernCheck.lead', 'Kurz: ja, wenn du vermietest und finanzierst. Der Vorteil kommt nicht daher, dass Zypern steuerfrei wäre. Er kommt aus drei Dingen: 15 % Körperschaftsteuer statt deutscher Sätze, 22.000 Euro Freibetrag pro Person bei privater Vermietung, und einer Abschreibung, die den steuerpflichtigen Gewinn in den ersten Jahren fast auf null drücken kann.')}
        </p>

        <div className="mt-8 rounded-2xl border border-black/10 bg-white p-5 sm:p-6">
          <h2 className="font-heading text-xl" style={{ color: NAVY }}>
            {t('zypernCheck.factsTitle', 'Die Zahlen, Stand 2026')}
          </h2>
          <dl className="mt-4 space-y-3">
            {fakten.map(f => (
              <div key={f.k} className="sm:flex sm:gap-4">
                <dt className="font-semibold text-sm sm:w-52 sm:shrink-0" style={{ color: NAVY }}>{f.k}</dt>
                <dd className="text-sm text-hp-slate">{f.f}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Rechner: der eigentliche Grund, warum jemand hierbleibt. */}
        <section className="mt-10">
          <h2 className="font-heading text-2xl" style={{ color: NAVY }}>
            {t('zypernCheck.calcTitle', 'Rechne es für deinen Betrag durch')}
          </h2>
          <p className="mt-2 text-sm text-hp-slate">
            {t('zypernCheck.calcSub', 'Dieselbe Rechenlogik, die wir auch im Kundengespräch verwenden. Keine Mailadresse nötig.')}
          </p>

          <div className="mt-5 rounded-2xl border border-black/10 bg-white p-5 sm:p-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-semibold" style={{ color: NAVY }}>
                  {t('zypernCheck.price', 'Kaufpreis netto')}
                </span>
                <span className="block text-lg font-semibold mt-1" style={{ color: CORAL }}>{eur(preis)}</span>
                <input
                  type="range" min={150000} max={900000} step={10000}
                  value={preis} onChange={e => setPreis(Number(e.target.value))}
                  className="w-full mt-2 accent-hp-highlight"
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold" style={{ color: NAVY }}>
                  {t('zypernCheck.equity', 'Eigenkapital')}
                </span>
                <span className="block text-lg font-semibold mt-1" style={{ color: CORAL }}>{eur(Math.min(eigen, preis))}</span>
                <input
                  type="range" min={30000} max={900000} step={10000}
                  value={eigen} onChange={e => setEigen(Number(e.target.value))}
                  className="w-full mt-2 accent-hp-highlight"
                />
              </label>
            </div>

            <div className="mt-5 flex gap-2">
              {(['short', 'long'] as const).map(k => (
                <button
                  key={k} type="button" onClick={() => setArt(k)}
                  className={`px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${
                    art === k ? 'text-white border-transparent' : 'bg-white text-hp-slate border-black/15 hover:bg-black/5'
                  }`}
                  style={art === k ? { backgroundColor: CORAL } : undefined}
                >
                  {k === 'short'
                    ? t('zypernCheck.short', 'Kurzzeitvermietung')
                    : t('zypernCheck.long', 'Langzeitvermietung')}
                </button>
              ))}
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl p-4" style={{ backgroundColor: NAVY }}>
                <div className="text-[11px] uppercase tracking-wide text-white/60">
                  {t('zypernCheck.outRent', 'Mieteinnahmen Jahr 1')}
                </div>
                <div className="text-xl font-semibold text-white mt-1">{eur(mieteJ1)}</div>
              </div>
              <div className="rounded-xl p-4" style={{ backgroundColor: NAVY }}>
                <div className="text-[11px] uppercase tracking-wide text-white/60">
                  {t('zypernCheck.outTax', 'Steuer Zypern Jahr 1')}
                </div>
                <div className="text-xl font-semibold text-white mt-1">{eur(steuerJ1)}</div>
              </div>
              <div className="rounded-xl p-4" style={{ backgroundColor: NAVY }}>
                <div className="text-[11px] uppercase tracking-wide text-white/60">
                  {t('zypernCheck.outCf', 'Cashflow pro Monat')}
                </div>
                <div className="text-xl font-semibold mt-1" style={{ color: cfMonat >= 0 ? '#8fd6a8' : '#ff9f8c' }}>
                  {eur(cfMonat)}
                </div>
              </div>
            </div>

            <p className="mt-4 text-xs leading-relaxed text-hp-slate/80">
              {t('zypernCheck.disclaimer', 'Modellrechnung mit Standardannahmen (Zinssatz, Auslastung, Verwaltung, Nebenkosten). Keine Steuerberatung. Die echten Zahlen hängen an der konkreten Wohnung, an deinem Steuersatz und daran, ob privat oder über eine Gesellschaft gehalten wird.')}
            </p>
          </div>
        </section>

        {/* Termin. Erst hier, und mit ehrlichem Grund statt Druck. */}
        <section className="mt-10 rounded-2xl p-6 sm:p-8" style={{ backgroundColor: NAVY }}>
          <h2 className="font-heading text-2xl text-white">
            {t('zypernCheck.ctaTitle', 'Was der Rechner nicht weiß')}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-white/75">
            {t('zypernCheck.ctaText', 'Welche Wohnungen gerade wirklich verfügbar sind, was die jeweilige Lage an Auslastung hergibt, und ob privat oder über eine Gesellschaft in deinem Fall günstiger ist. Das klären wir in 30 Minuten am Bildschirm, mit deinen Zahlen statt mit Standardannahmen.')}
          </p>
          <a
            href={href}
            className="inline-block mt-6 px-6 py-3 rounded-xl font-semibold text-white"
            style={{ backgroundColor: CORAL }}
          >
            {t('zypernCheck.ctaButton', 'Termin aussuchen')}
          </a>
          <p className="mt-3 text-xs text-white/50">
            {t('zypernCheck.ctaNote', 'Direkt im Kalender, ohne Rückruf und ohne Verkaufsdruck.')}
          </p>
        </section>

        <section className="mt-10">
          <h2 className="font-heading text-2xl" style={{ color: NAVY }}>
            {t('zypernCheck.faqTitle', 'Häufige Fragen')}
          </h2>
          <div className="mt-4 space-y-4">
            {faq.map(f => (
              <div key={f.q} className="rounded-2xl border border-black/10 bg-white p-5">
                <h3 className="font-semibold text-sm" style={{ color: NAVY }}>{f.q}</h3>
                <p className="mt-2 text-sm leading-relaxed text-hp-slate">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        <footer className="mt-12 text-center">
          <a
            href={href}
            className="inline-block px-6 py-3 rounded-xl font-semibold text-white"
            style={{ backgroundColor: CORAL }}
          >
            {t('zypernCheck.ctaButton', 'Termin aussuchen')}
          </a>
          <p className="mt-6 text-xs text-hp-slate/70">
            Happy Property {new Date().getFullYear()}
          </p>
        </footer>
      </main>
    </div>
  )
}
