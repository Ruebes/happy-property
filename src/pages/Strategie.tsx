import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'
import { migrateConfig, DEFAULT_SIM_PARAMS, type SimUnit, type SimParams, type StrategyConfig } from '../lib/strategy'
import { buildCustomerAnalytics, type CustomerAnalytics, type ScenarioSummary } from '../lib/analytics'
import {
  ChartCard, Legend, LineChart, BarChart, StepChart, Waterfall,
  C_VALUE, C_DEBT, C_EQUITY,
} from '../components/StrategieCharts'

// ── Öffentliche Investment-Auswertung ────────────────────────────────────────
// /strategie/:token - die Kundenansicht des Strategie-Simulators.
//
// WICHTIG: Diese Seite rechnet nichts. Jede Zahl kommt aus
// buildCustomerAnalytics(), das seinerseits auf der geprüften Strategie- und
// Reinvestment-Schicht sitzt. So können CRM und Kundenseite nicht
// auseinanderlaufen. Wenn hier eine Kennzahl fehlt, gehört sie in analytics.ts,
// nicht in diese Komponente.
//
// Aufbau als Geschichte: Ergebnis zuerst, dann Vermögen, Portfolio, Kapital,
// Cashflow, Finanzierung, Objekte, Steuern, Szenarien, Verkauf, Risiken,
// Annahmen.

const CORAL = '#ff795d', DARK = '#2e3c47'
const SERIF = "'Playfair Display',Georgia,serif"
const SANS = "'Montserrat','Helvetica Neue',Arial,sans-serif"

const eur = (n: number | null | undefined) => n == null || isNaN(n) ? '–'
  : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(n))
const pct = (n: number) => (isFinite(n) ? n.toFixed(1).replace('.', ',') : '0') + ' %'
const mmyyyy = (m: number, y: number) => `${String(m).padStart(2, '0')}/${y}`

const MOBILE_QUERY = '(max-width: 640px)'
function useIsMobile(): boolean {
  const get = () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
  const [isMobile, setIsMobile] = useState<boolean>(get)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isMobile
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#f4f3f1', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SANS, color: '#555', padding: 24, textAlign: 'center' }}>
      {children}
    </div>
  )
}

const card: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,.06)' }
const th: React.CSSProperties = { textAlign: 'right', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: '#8a8a8a', fontWeight: 600, whiteSpace: 'nowrap' }
const td: React.CSSProperties = { textAlign: 'right', padding: '7px 10px', fontSize: 13, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 34 }}>
      <h2 style={{ fontFamily: SERIF, fontSize: 21, color: DARK, margin: '0 0 4px' }}>{title}</h2>
      {sub && <p style={{ fontSize: 13, color: '#666', margin: '0 0 14px', lineHeight: 1.7, maxWidth: 720 }}>{sub}</p>}
      {!sub && <div style={{ height: 12 }} />}
      {children}
    </section>
  )
}

// Fachbegriffe bekommen eine Erklärung, die beim Überfahren erscheint.
function Term({ children, hint }: { children: React.ReactNode; hint: string }) {
  return (
    <span title={hint} style={{ borderBottom: '1px dotted #b9b2a8', cursor: 'help' }}>{children}</span>
  )
}

function ScrollBox({ children }: { children: React.ReactNode }) {
  return <div style={{ ...card, padding: 0, overflowX: 'auto' }}>{children}</div>
}

export default function Strategie() {
  const { t } = useTranslation()
  const { token } = useParams<{ token: string }>()
  const [units, setUnits] = useState<SimUnit[]>([])
  const [params, setParams] = useState<SimParams>({ ...DEFAULT_SIM_PARAMS })
  const [meta, setMeta] = useState<{ title?: string; recipient_name?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [showYears, setShowYears] = useState(false)
  const isMobile = useIsMobile()

  useEffect(() => { void (async () => {
    if (!token) return
    const { data, error } = await supabase.rpc('get_strategy_by_token', { p_token: token })
    const row = Array.isArray(data) ? data[0] : data
    if (error || !row) { setErr(t('strategie.notFound', 'Dieser Fahrplan wurde nicht gefunden.')); setLoading(false); return }
    // migrateConfig liest auch Altstände (v1) - sonst sieht der Kunde eine leere Seite
    const mig = migrateConfig((row.config ?? {}) as StrategyConfig)
    setUnits(mig.units)
    setParams(mig.params)
    setMeta({ title: row.title as string | undefined, recipient_name: row.recipient_name as string | undefined })
    setLoading(false)
  })() }, [token, t])

  // Aufruf fürs CRM-Dashboard protokollieren (interne Kontrollen zählen nicht).
  useEffect(() => {
    if (!token) return
    if (new URLSearchParams(window.location.search).get('preview') === '1') return
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) return
      supabase.functions.invoke('track-engagement', { body: { type: 'strategy_view', token } }).catch(() => { /* egal */ })
    })()
  }, [token])

  // EINE Berechnung für die ganze Seite.
  const a: CustomerAnalytics | null = useMemo(
    () => units.length ? buildCustomerAnalytics(units, params) : null,
    [units, params],
  )

  if (loading) return <Centered>{t('strategie.loading', 'Lädt…')}</Centered>
  if (err || !units.length || !a) return <Centered>{err || t('strategie.empty', 'Dieser Fahrplan enthält noch keine Wohnungen.')}</Centered>

  const years = a.wealth.map(w => w.year)
  const today = new Date().toLocaleDateString('de-DE')
  const kpiGrid: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4,1fr)', gap: 12, marginBottom: 16,
  }

  // Nur relevante Jahre in der Portfolio-Tabelle: Start, Kauf- und Verkaufsjahre,
  // Jahr 5, Jahr 10 und das Ende.
  const keyYears = new Set<number>([
    a.summary.firstYear, a.summary.firstYear + 4, a.summary.firstYear + 9, a.summary.lastYear,
    ...a.portfolio.filter(p => p.purchases || p.sales).map(p => p.year),
  ])
  const portfolioRows = a.portfolio.filter(p => showYears || keyYears.has(p.year))

  return (
    <div style={{ background: '#f4f3f1', minHeight: '100vh', fontFamily: SANS, color: '#1a1a1a' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: isMobile ? '18px 14px 48px' : '28px 22px 64px' }}>

        {/* Kopf */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 10 : 14, marginBottom: 6 }}>
          <img src={DECK_LOGO} alt="Happy Property Cyprus" style={{ height: isMobile ? 38 : 46, width: 'auto', borderRadius: 8, flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: SERIF, fontSize: isMobile ? 20 : 26, fontWeight: 800, color: DARK, lineHeight: 1.15 }}>
              {t('strategie.title', 'Dein Investitions-Fahrplan')}
            </div>
            <div style={{ fontSize: 12.5, color: '#666', marginTop: 2 }}>
              {meta?.recipient_name && <>{t('strategie.customer', 'Für')}: <b>{meta.recipient_name}</b> · </>}
              {t('strategie.periodShort', '{{from}} bis {{to}}', { from: a.summary.firstYear, to: a.summary.lastYear })}
            </div>
            <div style={{ fontSize: 11, color: '#aaa' }}>{t('strategie.generatedOn', 'Stand {{date}}', { date: today })}</div>
          </div>
        </div>
        <div style={{ height: 3, background: `linear-gradient(90deg,${CORAL},#ffb89d)`, borderRadius: 2, marginBottom: 26 }} />

        {/* 1 — Ergebnis */}
        <Section title={t('strategie.s1', 'Dein Ergebnis auf einen Blick')}>
          <div style={kpiGrid}>
            {[
              { l: t('strategie.kNet', 'Netto-Vermögen am Ende'), v: eur(a.summary.netWorth), hero: true },
              { l: t('strategie.kValue', 'Wert der Immobilien'), v: eur(a.summary.portfolioValue) },
              { l: t('strategie.kUnits', 'Wohnungen'), v: String(a.summary.unitsEnd) },
              { l: t('strategie.kIrr', 'Rendite pro Jahr'), v: isFinite(a.summary.irr) ? pct(a.summary.irr * 100) : '–' },
              { l: t('strategie.kEquity', 'Eingesetztes Kapital'), v: eur(a.summary.originalEquity) },
              { l: t('strategie.kDebt', 'Kredit am Ende'), v: eur(a.summary.debt) },
              ...(a.summary.recyclingMultiple != null
                ? [{ l: t('strategie.kRecycle', 'Kapital-Recycling'), v: `${String(a.summary.recyclingMultiple).replace('.', ',')}×` }]
                : []),
              ...(a.summary.exitNet != null
                ? [{ l: t('strategie.kExit', 'Erlös nach Verkauf'), v: eur(a.summary.exitNet) }]
                : [{ l: t('strategie.kCash', 'Liquidität am Ende'), v: eur(a.summary.cash) }]),
            ].map(k => (
              <div key={k.l} style={{ ...card, padding: isMobile ? 12 : 16, borderTop: `3px solid ${k.hero ? CORAL : '#e6e3dd'}` }}>
                <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: '#8a8a8a' }}>{k.l}</div>
                <div style={{ fontFamily: SERIF, fontSize: isMobile ? 19 : 23, fontWeight: 800, color: k.hero ? CORAL : DARK, marginTop: 4 }}>{k.v}</div>
              </div>
            ))}
          </div>
          <div style={{ ...card }}>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.8, color: '#3a3a3a' }}>{a.summary.text}</p>
          </div>
        </Section>

        {/* 2 — Vermögen */}
        <Section title={t('strategie.s2', 'Wie sich dein Vermögen entwickelt')}
          sub={t('strategie.s2sub', 'Der Wert der Immobilien wächst, der Kredit wird getilgt. Was dazwischen liegt, gehört dir.')}>
          <ChartCard title={t('strategie.c1', 'Wert, Kredit und Eigenkapital')}
            sub={t('strategie.c1sub', 'Eigenkapital in den Immobilien ist Wert abzüglich Kredit. Das Netto-Vermögen zählt zusätzlich die Liquidität und das während der Bauzeit gebundene Kapital.')}
            foot={<Legend items={[
              { c: C_VALUE, l: t('strategie.lValue', 'Wert der Immobilien') },
              { c: C_DEBT, l: t('strategie.lDebt', 'Kredit') },
              { c: C_EQUITY, l: t('strategie.lEquity', 'Eigenkapital in den Immobilien') },
              { c: '#8a8a8a', l: t('strategie.lNet', 'Netto-Vermögen') },
            ]} />}>
            <LineChart years={years} height={isMobile ? 220 : 260}
              marker={a.events.filter(e => e.kind === 'purchase' || e.kind === 'sale')
                .map(e => ({ year: e.year, label: e.kind === 'purchase' ? t('strategie.mBuy', 'Kauf') : t('strategie.mSale', 'Verkauf') }))}
              series={[
                { key: 'v', color: C_VALUE, label: t('strategie.lValue', 'Wert der Immobilien'), values: a.wealth.map(w => w.propertyValue) },
                { key: 'd', color: C_DEBT, label: t('strategie.lDebt', 'Kredit'), values: a.wealth.map(w => w.debt) },
                { key: 'e', color: C_EQUITY, label: t('strategie.lEquity', 'Eigenkapital in den Immobilien'), values: a.wealth.map(w => w.propertyEquity) },
                { key: 'n', color: '#8a8a8a', label: t('strategie.lNet', 'Netto-Vermögen'), values: a.wealth.map(w => w.netWorth), dashed: true },
              ]} />
          </ChartCard>
        </Section>

        {/* 3 — Portfolio */}
        {a.reinvest && (
          <Section title={t('strategie.s3', 'Wie dein Portfolio wächst')}
            sub={t('strategie.s3sub', 'Jede Stufe ist ein weiterer Kauf, der aus Wertzuwachs und Tilgung finanziert wird.')}>
            <ChartCard title={t('strategie.c2', 'Anzahl der Wohnungen')}>
              <StepChart years={years} values={a.portfolio.map(p => p.units)} height={isMobile ? 150 : 180}
                markers={[
                  ...a.portfolio.filter(p => p.purchases).map(p => ({ year: p.year, kind: 'buy' as const })),
                  ...a.portfolio.filter(p => p.sales).map(p => ({ year: p.year, kind: 'sell' as const })),
                ]} />
            </ChartCard>
            <ScrollBox>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
                <thead><tr style={{ borderBottom: '1px solid #eee' }}>
                  <th style={{ ...th, textAlign: 'left' }}>{t('strategie.tYear', 'Jahr')}</th>
                  <th style={th}>{t('strategie.tUnits', 'Wohnungen')}</th>
                  <th style={th}>{t('strategie.tValue', 'Wert')}</th>
                  <th style={th}>{t('strategie.tDebt', 'Kredit')}</th>
                  <th style={th}>{t('strategie.tEquity', 'Eigenkapital')}</th>
                </tr></thead>
                <tbody>
                  {portfolioRows.map(p => {
                    const w = a.wealth.find(x => x.year === p.year)!
                    return (
                      <tr key={p.year} style={{ borderBottom: '1px solid #f5f3f0' }}>
                        <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{p.year}</td>
                        <td style={td}>{p.units}</td>
                        <td style={td}>{eur(w.propertyValue)}</td>
                        <td style={td}>{eur(w.debt)}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{eur(w.propertyEquity)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </ScrollBox>
            <button onClick={() => setShowYears(v => !v)}
              style={{ marginTop: 8, background: 'none', border: 0, color: CORAL, fontSize: 12.5, cursor: 'pointer', padding: 0, fontFamily: SANS }}>
              {showYears ? t('strategie.less', 'Nur die wichtigen Jahre zeigen') : t('strategie.more', 'Alle Jahre anzeigen')}
            </button>
          </Section>
        )}

        {/* 4 — Kapital-Recycling */}
        {a.reinvest && a.capitalSteps.length > 0 && (
          <Section title={t('strategie.s4', 'Wie dein Kapital mehrfach arbeitet')}
            sub={t('strategie.s4sub', 'Steigt der Wert einer Wohnung und sinkt gleichzeitig der Kredit, entsteht Spielraum für eine weitere Finanzierung. Dieses Kapital fließt erneut in Immobilien.')}>
            {a.summary.recyclingMultiple != null && (
              <div style={{ ...card, marginBottom: 12, textAlign: 'center' }}>
                <div style={{ fontFamily: SERIF, fontSize: isMobile ? 34 : 44, fontWeight: 800, color: CORAL, lineHeight: 1 }}>
                  {String(a.summary.recyclingMultiple).replace('.', ',')}×
                </div>
                <div style={{ fontSize: 13, color: '#666', marginTop: 8, maxWidth: 560, margin: '8px auto 0', lineHeight: 1.7 }}>
                  <Term hint={t('strategie.hRecycle', 'Zeigt, wie oft Kapital aus Refinanzierungen und Verkäufen im Modell erneut für Immobilienkäufe eingesetzt wird.')}>
                    {t('strategie.recycleLabel', 'Kapital-Recycling-Faktor')}
                  </Term>
                  {': '}
                  {t('strategie.recycleText', 'So oft wurde dein ursprünglich eingesetztes Kapital im Modell erneut für weitere Investitionen verwendet.')}
                </div>
              </div>
            )}
            <ChartCard title={t('strategie.c3', 'Woher das Kapital kommt und wohin es geht')}
              sub={t('strategie.c3sub', 'Grün sind Zuflüsse aus Refinanzierung und Verkauf, orange das Kapital, das in einen Kauf fließt.')}>
              <Waterfall steps={a.capitalSteps} height={isMobile ? 220 : 260} />
            </ChartCard>
            {a.recyclingRows.length > 0 && (
              <ScrollBox>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
                  <thead><tr style={{ borderBottom: '1px solid #eee' }}>
                    <th style={{ ...th, textAlign: 'left' }}>{t('strategie.tYear', 'Jahr')}</th>
                    <th style={{ ...th, textAlign: 'left' }}>{t('strategie.tEvent', 'Ereignis')}</th>
                    <th style={{ ...th, textAlign: 'left' }}>{t('strategie.tSource', 'Objekt')}</th>
                    <th style={th}>{t('strategie.tAmount', 'Betrag')}</th>
                    <th style={th}>{t('strategie.tReinvested', 'davon reinvestiert')}</th>
                  </tr></thead>
                  <tbody>
                    {a.recyclingRows.map((r, i) => (
                      <tr key={`${r.year}-${i}`} style={{ borderBottom: '1px solid #f5f3f0' }}>
                        <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{r.year}</td>
                        <td style={{ ...td, textAlign: 'left' }}>{r.event}</td>
                        <td style={{ ...td, textAlign: 'left', color: '#666' }}>{r.source}</td>
                        <td style={{ ...td, color: r.amount < 0 ? CORAL : '#1d7a4f' }}>{eur(r.amount)}</td>
                        <td style={td}>{r.reinvested ? eur(r.reinvested) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollBox>
            )}
            {a.opportunity && (
              <div style={{ ...card, marginTop: 12, borderLeft: `4px solid ${CORAL}` }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: DARK, marginBottom: 6 }}>
                  {t('strategie.oppTitle', '{{y}}: eine weitere Investition wäre rechnerisch möglich', { y: a.opportunity.year })}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2,1fr)', gap: 6, fontSize: 13, color: '#555' }}>
                  <div>{t('strategie.oppCap', 'Zusätzliche Beleihungskapazität')}: <b>{eur(a.opportunity.capacity)}</b></div>
                  <div>{t('strategie.oppMax', 'Maximaler Kaufpreis')}: <b>{eur(a.opportunity.maxPrice)}</b></div>
                  <div>{t('strategie.oppModel', 'Modellkaufpreis')}: <b>{eur(a.opportunity.modelPrice)}</b></div>
                  <div>{t('strategie.oppEq', 'Benötigtes Eigenkapital')}: <b>{eur(a.opportunity.requiredEquity)}</b></div>
                </div>
                <p style={{ fontSize: 12, color: '#777', margin: '10px 0 0', lineHeight: 1.6 }}>
                  {t('strategie.oppNote', 'Rechnerisch möglich unter den gewählten Annahmen. Über die tatsächliche Finanzierung entscheidet die Bank.')}
                </p>
              </div>
            )}
          </Section>
        )}

        {/* 5 — Cashflow */}
        <Section title={t('strategie.s5', 'Was das Portfolio laufend abwirft')}
          sub={t('strategie.s5sub', 'Positiv bedeutet: Die Mieten tragen Rate, Kosten und Steuern. Negativ bedeutet: Du legst in diesem Jahr etwas zu.')}>
          <ChartCard title={t('strategie.c4', 'Cashflow je Jahr')}
            foot={<Legend items={[
              { c: C_EQUITY, l: t('strategie.lPos', 'Überschuss') },
              { c: '#b45309', l: t('strategie.lNeg', 'Zuzahlung') },
              { c: C_VALUE, l: t('strategie.lCum', 'kumuliert') },
            ]} />}>
            <BarChart years={years} values={a.cashflow.map(c => c.cashflow)}
              cumulative={a.cashflow.map(c => c.cumulative)} height={isMobile ? 190 : 220} />
          </ChartCard>
          <ScrollBox>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
              <thead><tr style={{ borderBottom: '1px solid #eee' }}>
                <th style={{ ...th, textAlign: 'left' }}>{t('strategie.tYear', 'Jahr')}</th>
                <th style={th}>{t('strategie.tRent', 'Mieten')}</th>
                <th style={th}>{t('strategie.tCosts', 'Kosten')}</th>
                <th style={th}>{t('strategie.tInterest', 'Zinsen')}</th>
                <th style={th}>{t('strategie.tAmort', 'Tilgung')}</th>
                <th style={th}>{t('strategie.tTax', 'Steuern')}</th>
                <th style={th}>{t('strategie.tNet', 'Cashflow')}</th>
              </tr></thead>
              <tbody>
                {a.cashflowRows.filter(r => showYears || keyYears.has(r.year) || r.rent > 0).slice(0, showYears ? 99 : 12).map(r => (
                  <tr key={r.year} style={{ borderBottom: '1px solid #f5f3f0' }}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{r.year}</td>
                    <td style={{ ...td, color: '#1d7a4f' }}>{r.rent ? eur(r.rent) : ''}</td>
                    <td style={td}>{r.costs ? `−${eur(r.costs)}` : ''}</td>
                    <td style={td}>{r.interest ? `−${eur(r.interest)}` : ''}</td>
                    <td style={td}>{r.amortization ? `−${eur(r.amortization)}` : ''}</td>
                    <td style={td}>{r.tax ? `−${eur(r.tax)}` : ''}</td>
                    <td style={{ ...td, fontWeight: 700, color: r.net >= 0 ? '#1d7a4f' : '#b45309' }}>{eur(r.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollBox>

          {a.reinvest && a.liquidity.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <ChartCard title={t('strategie.c5', 'Liquidität')}
                sub={t('strategie.c5sub', 'Die gestrichelte Linie ist die Reserve, die im Modell nie angetastet werden soll.')}>
                <LineChart years={a.liquidity.map(l => l.year)} height={isMobile ? 170 : 200}
                  zeroLine={{ value: a.minimumReserve, label: t('strategie.reserve', 'Reserve') }}
                  series={[{ key: 'c', color: C_VALUE, label: t('strategie.lCash', 'Liquidität'), values: a.liquidity.map(l => l.cash) }]} />
              </ChartCard>
              {a.liquidityWarning && (
                <div style={{ ...card, borderLeft: '4px solid #b45309' }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: DARK, marginBottom: 4 }}>
                    {t('strategie.liqTitle', 'Hinweis zur Liquidität')}
                  </div>
                  <div style={{ fontSize: 13, color: '#555', lineHeight: 1.7 }}>
                    {t('strategie.liqText', 'Zwischen {{from}} und {{to}} unterschreitet das Modell die vorgesehene Reserve, im Tiefpunkt bei {{low}}. In dieser Zeit wäre zusätzliches Eigenkapital nötig, oder ein weiterer Kauf müsste später erfolgen.', {
                      from: a.liquidityWarning.from, to: a.liquidityWarning.to, low: eur(a.liquidityWarning.lowest),
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </Section>

        {/* 6 — Finanzierung */}
        <Section title={t('strategie.s6', 'Finanzierung und Beleihung')}
          sub={a.reinvest
            ? t('strategie.s6sub', 'Je weiter der Kredit getilgt ist und je höher der Wert, desto mehr Spielraum entsteht für eine weitere Finanzierung.')
            : undefined}>
          <div style={kpiGrid}>
            {[
              { l: t('strategie.fDebt', 'Kredit am Ende'), v: eur(a.financingKpis.debtEnd) },
              { l: <Term hint={t('strategie.hLtv', 'Verhältnis von Kredit zum Wert der Immobilien.')}>{t('strategie.fLtv', 'Beleihungsgrad (LTV)')}</Term>, v: `${String(a.financingKpis.ltvEnd).replace('.', ',')} %` },
              { l: t('strategie.fInterest', 'Zinsen gesamt'), v: eur(a.financingKpis.totalInterest) },
              { l: t('strategie.fAmort', 'Tilgung gesamt'), v: eur(a.financingKpis.totalAmortization) },
            ].map((k, i) => (
              <div key={i} style={{ ...card, padding: isMobile ? 12 : 16 }}>
                <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: '#8a8a8a' }}>{k.l}</div>
                <div style={{ fontFamily: SERIF, fontSize: isMobile ? 17 : 20, fontWeight: 800, color: DARK, marginTop: 4 }}>{k.v}</div>
              </div>
            ))}
          </div>
          <ChartCard title={t('strategie.c6', 'Kredit und Beleihungsspielraum')}
            foot={<Legend items={[
              { c: C_DEBT, l: t('strategie.lDebt', 'Kredit') },
              ...(a.reinvest ? [{ c: C_EQUITY, l: t('strategie.lCap', 'Zusätzliche Beleihungskapazität') }] : []),
            ]} />}>
            <LineChart years={years} height={isMobile ? 180 : 210}
              series={[
                { key: 'd', color: C_DEBT, label: t('strategie.lDebt', 'Kredit'), values: a.financing.map(f => f.debt) },
                ...(a.reinvest
                  ? [{ key: 'c', color: C_EQUITY, label: t('strategie.lCap', 'Zusätzliche Beleihungskapazität'), values: a.financing.map(f => f.capacity) }]
                  : []),
              ]} />
          </ChartCard>
        </Section>

        {/* 7 — Immobilien */}
        <Section title={t('strategie.s7', 'Deine Wohnungen')}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit,minmax(320px,1fr))', gap: 12 }}>
            {a.properties.map(p => (
              <div key={p.key} style={{ ...card, borderTop: p.soldYear ? `3px solid ${CORAL}` : undefined }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: DARK }}>{p.name}</div>
                  {p.soldYear && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', color: CORAL }}>
                      {t('strategie.sold', 'VERKAUFT {{y}}', { y: p.soldYear })}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#777', marginTop: 2 }}>
                  {t('strategie.purchase', 'Kauf')} {mmyyyy(1, p.buyYear)} · {t('strategie.handover', 'Übergabe')} {mmyyyy(1, p.readyYear)}
                  {p.model && ` · ${t('strategie.modelUnit', 'Modellobjekt')}`}
                </div>
                <div style={{ marginTop: 10, display: 'grid', gap: 6, fontSize: 13 }}>
                  {([
                    [t('strategie.pPrice', 'Gesamtpreis'), eur(p.gross)],
                    [t('strategie.pEquity', 'davon Eigenkapital'), eur(p.equity)],
                    ...(p.loan > 0 ? [[t('strategie.pLoan', 'Darlehen'), eur(p.loan)]] : []),
                    [t('strategie.pRent', 'Miete im 1. Jahr'), eur(p.rentFirstYear)],
                    [p.soldYear ? t('strategie.pValueSale', 'Wert beim Verkauf') : t('strategie.pValue', 'Wert am Ende'), eur(p.valueEnd)],
                    [t('strategie.pEquityEnd', 'davon dir gehörend'), eur(p.equityEnd)],
                    ...(p.netSaleProceeds != null ? [[t('strategie.pNet', 'Erlös nach Verkauf'), eur(p.netSaleProceeds)]] : []),
                    ...(p.roe != null ? [[t('strategie.pRoe', 'Rendite auf Eigenkapital'), pct(p.roe)]] : []),
                  ] as Array<[string, string]>).map(([l, v]) => (
                    <div key={l} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid #f2f0ec', paddingBottom: 5 }}>
                      <span style={{ color: '#666' }}>{l}</span>
                      <b style={{ color: DARK, fontVariantNumeric: 'tabular-nums' }}>{v}</b>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* 8 — Steuern */}
        <Section title={t('strategie.s8', 'Steuern')}>
          <div style={kpiGrid}>
            {[
              { l: t('strategie.xTotal', 'Steuern gesamt'), v: eur(a.taxKpis.total) },
              { l: t('strategie.xYear', 'Im Schnitt pro Jahr'), v: eur(a.taxKpis.perYear) },
              ...(a.taxKpis.exit ? [{ l: t('strategie.xExit', 'Steuer beim Verkauf'), v: eur(a.taxKpis.exit) }] : []),
              ...(a.taxKpis.gesy ? [{ l: t('strategie.xGesy', 'Gesundheitsbeitrag'), v: eur(a.taxKpis.gesy) }] : []),
              ...(a.taxKpis.si ? [{ l: t('strategie.xSi', 'Sozialversicherung'), v: eur(a.taxKpis.si) }] : []),
              ...(a.taxKpis.de ? [{ l: t('strategie.xDe', 'Steuer in Deutschland'), v: eur(a.taxKpis.de) }] : []),
            ].map(k => (
              <div key={k.l} style={{ ...card, padding: isMobile ? 12 : 16 }}>
                <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: '#8a8a8a' }}>{k.l}</div>
                <div style={{ fontFamily: SERIF, fontSize: isMobile ? 17 : 20, fontWeight: 800, color: DARK, marginTop: 4 }}>{k.v}</div>
              </div>
            ))}
          </div>
        </Section>

        {/* 9 — Szenarien */}
        <Section title={t('strategie.s9', 'Drei mögliche Entwicklungen')}
          sub={t('strategie.s9sub', 'Niemand kennt den Markt der nächsten Jahre. Dieselbe Strategie, dreimal gerechnet: mit den geplanten Annahmen, mit vorsichtigeren und mit freundlicheren.')}>
          <ScrollBox>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
              <thead><tr style={{ borderBottom: '1px solid #eee' }}>
                <th style={{ ...th, textAlign: 'left' }}>{t('strategie.scMetric', 'Kennzahl')}</th>
                <th style={th}>{t('strategie.scBasis', 'Wie geplant')}</th>
                <th style={th}>{t('strategie.scCons', 'Vorsichtig')}</th>
                <th style={th}>{t('strategie.scOpt', 'Freundlich')}</th>
              </tr></thead>
              <tbody>
                {([
                  [t('strategie.scUnits', 'Wohnungen'), (s: ScenarioSummary) => String(s.units)],
                  [t('strategie.scValue', 'Wert der Immobilien'), (s: ScenarioSummary) => eur(s.portfolioValue)],
                  [t('strategie.scDebt', 'Kredit'), (s: ScenarioSummary) => eur(s.debt)],
                  [t('strategie.scWorth', 'Netto-Vermögen'), (s: ScenarioSummary) => eur(s.netWorth)],
                  [t('strategie.scIrr', 'Rendite pro Jahr'), (s: ScenarioSummary) => isFinite(s.irr) ? pct(s.irr * 100) : '–'],
                  [t('strategie.scCf', 'Cashflow zusammen'), (s: ScenarioSummary) => eur(s.cumulativeCashflow)],
                  ...(a.reinvest
                    ? [[t('strategie.scRec', 'Kapital-Recycling'), (s: ScenarioSummary) => `${String(s.recyclingMultiple).replace('.', ',')}×`]]
                    : [[t('strategie.scExit', 'Erlös nach Verkauf'), (s: ScenarioSummary) => s.exitNet != null ? eur(s.exitNet) : '–']]),
                ] as Array<[string, (s: ScenarioSummary) => string]>).map(([label, get]) => (
                  <tr key={label} style={{ borderBottom: '1px solid #f5f3f0' }}>
                    <td style={{ padding: '8px 10px', fontSize: 13, color: '#555' }}>{label}</td>
                    {a.scenarios.map(s => (
                      <td key={s.key} style={{ ...td, fontWeight: s.key === 'basis' ? 700 : 400, color: s.key === 'basis' ? DARK : '#666' }}>
                        {get(s)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollBox>

          {a.sensitivity.length > 0 && (
            <div style={{ ...card, marginTop: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: DARK, marginBottom: 8 }}>
                {t('strategie.sensTitle', 'Wie stark hängt alles an der Wertentwicklung?')}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${a.sensitivity.length},1fr)`, gap: 8 }}>
                {a.sensitivity.map(s => (
                  <div key={s.appreciation} style={{ textAlign: 'center', padding: '8px 4px', borderRadius: 10, background: s.appreciation === params.reinvestAppreciationPct ? '#fff3ee' : '#faf9f7' }}>
                    <div style={{ fontSize: 12, color: '#8a8a8a' }}>{String(s.appreciation).replace('.', ',')} %</div>
                    <div style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 800, color: DARK, marginTop: 2 }}>{s.units}</div>
                    <div style={{ fontSize: 11, color: '#777' }}>{eur(s.netWorth)}</div>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 12, color: '#777', margin: '10px 0 0', lineHeight: 1.6 }}>
                {t('strategie.sensNote', 'Angenommene Wertentwicklung pro Jahr, darunter die Zahl der Wohnungen und das Netto-Vermögen am Ende.')}
              </p>
            </div>
          )}
        </Section>

        {/* 10 — Verkauf */}
        {a.exits.length > 0 && (
          <Section title={t('strategie.s10', 'Was beim Verkauf übrig bleibt')}>
            <ScrollBox>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
                <thead><tr style={{ borderBottom: '1px solid #eee' }}>
                  <th style={{ ...th, textAlign: 'left' }}>{t('strategie.eObj', 'Wohnung')}</th>
                  <th style={th}>{t('strategie.eYear', 'Verkauf')}</th>
                  <th style={th}>{t('strategie.eValue', 'Wert')}</th>
                  <th style={th}>{t('strategie.eDebt', 'Kredit')}</th>
                  <th style={th}>{t('strategie.eCosts', 'Kosten')}</th>
                  <th style={th}>{t('strategie.eTax', 'Steuern')}</th>
                  <th style={th}>{t('strategie.eNet', 'Erlös')}</th>
                </tr></thead>
                <tbody>
                  {a.exits.map((e, i) => (
                    <tr key={`${e.name}-${i}`} style={{ borderBottom: '1px solid #f5f3f0' }}>
                      <td style={{ ...td, textAlign: 'left' }}>{e.name}</td>
                      <td style={td}>{e.year}</td>
                      <td style={td}>{eur(e.value)}</td>
                      <td style={td}>−{eur(e.debt)}</td>
                      <td style={td}>−{eur(e.costs)}</td>
                      <td style={td}>−{eur(e.tax)}</td>
                      <td style={{ ...td, fontWeight: 700, color: CORAL }}>{eur(e.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollBox>
            <p style={{ fontSize: 12, color: '#777', margin: '10px 0 0', lineHeight: 1.6 }}>
              {t('strategie.exNote2', 'Der Verkauf ist eine Modellannahme. Verkaufspreis, Kosten und Steuern können abweichen. Die bei Kurzzeitvermietung erstattete Mehrwertsteuer ist innerhalb der ersten zehn Jahre anteilig zurückzuzahlen; das ist in den Kosten enthalten.')}
            </p>
          </Section>
        )}

        {/* 11 — Erkenntnisse und Risiken */}
        <Section title={t('strategie.s11', 'Das Wichtigste in Kürze')}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3,1fr)', gap: 12, marginBottom: 12 }}>
            {a.insights.map((ins, i) => (
              <div key={ins.title} style={{ ...card }}>
                <div style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 800, color: CORAL, marginBottom: 6 }}>
                  {i + 1}. {ins.title}
                </div>
                <div style={{ fontSize: 13, color: '#555', lineHeight: 1.75 }}>{ins.text}</div>
              </div>
            ))}
          </div>
          <div style={{ ...card, marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: DARK, marginBottom: 8 }}>
              {t('strategie.drivers', 'Was das Ergebnis treibt')}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#555', lineHeight: 1.9 }}>
              {a.drivers.map(d => <li key={d}>{d}</li>)}
            </ul>
          </div>
          <div style={{ ...card }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: DARK, marginBottom: 8 }}>
              {t('strategie.riskTitle2', 'Wo die Risiken liegen')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2,1fr)', gap: 10 }}>
              {a.risks.map(r => {
                const color = r.level === 'gruen' ? '#1d7a4f' : r.level === 'gelb' ? '#b8860b' : '#b45309'
                const label: Record<string, string> = {
                  wert: t('strategie.rWert', 'Wertentwicklung'),
                  breakeven: t('strategie.rBe', 'Sicherheitsabstand'),
                  cashflow: t('strategie.rCf', 'Cashflow'),
                  finanzierung: t('strategie.rFin', 'Finanzierung'),
                  vermietung: t('strategie.rMiete', 'Vermietung'),
                  exit: t('strategie.rExit', 'Verkauf'),
                }
                return (
                  <div key={r.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <span style={{ width: 9, height: 9, borderRadius: 5, background: color, marginTop: 5, flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 13, color: DARK }}>
                        <b>{label[r.key] ?? r.key}</b> · <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.value}</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#777', lineHeight: 1.6 }}>{r.note}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </Section>

        {/* 12 — Annahmen */}
        <Section title={t('strategie.s12', 'Annahmen und Hinweise')}>
          <div style={{ ...card, marginBottom: 12 }}>
            <div style={{ fontSize: 12.5, color: '#666', lineHeight: 1.9 }}>
              {t('strategie.assumptions3', 'Wertentwicklung {{g}} % pro Jahr, Mietsteigerung {{r}} % pro Jahr, Finanzierung als Annuitätendarlehen zu {{i}} % über {{y}} Jahre.', {
                g: String(a.reinvest ? params.reinvestAppreciationPct : params.growth).replace('.', ','),
                r: String(params.rentGrowth).replace('.', ','),
                i: String(params.interest).replace('.', ','), y: params.termYears,
              })}{' '}
              {a.reinvest && t('strategie.assumptionsRe', 'Für Refinanzierungen ist eine maximale Beleihung von {{l}} % des Immobilienwertes angenommen, mit einer Mindestliquidität von {{c}}.', {
                l: String(params.refinanceLtv).replace('.', ','), c: eur(params.minimumCashReserve),
              })}{' '}
              {params.holder === 'firma'
                ? t('strategie.taxFirma2', 'Gehalten über eine zyprische Gesellschaft: {{k}} % Körperschaftsteuer, auf die Ausschüttung sind {{d}} % berücksichtigt.', {
                  k: String(params.corpTaxPct).replace('.', ','), d: String(params.divTaxPct).replace('.', ','),
                })
                : params.res === 'cy'
                  ? t('strategie.taxCy3', 'Privat gehalten, Steuersitz Zypern: 22.000 € steuerfrei, danach 20 bis 35 %, nach Abzug der laufenden Kosten, 3 % Gebäude-Abschreibung, 10 % auf die Einrichtung und der Darlehenszinsen.')
                  : t('strategie.taxDe3', 'Privat gehalten, Steuersitz Deutschland: Zypern besteuert zuerst, Deutschland rechnet mit {{d}} % nach und rechnet die zyprische Steuer an.', {
                    d: String(params.deTaxPct).replace('.', ','),
                  })}
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: '#999', lineHeight: 1.8 }}>
            <p style={{ margin: '0 0 8px' }}>
              {t('strategie.disc1', 'Die dargestellten Ergebnisse sind Modellrechnungen auf Basis der gewählten Annahmen. Insbesondere Wertentwicklung, Mieteinnahmen, Finanzierungskonditionen, Bankbewertung, Refinanzierungsmöglichkeiten und Verkaufspreise können in der Realität abweichen.')}
            </p>
            <p style={{ margin: '0 0 8px' }}>
              {t('strategie.disc2', 'Eine rechnerisch dargestellte Refinanzierung ist keine Zusage einer Bank. Die tatsächliche Finanzierung hängt unter anderem von Einkommen, bestehenden Verpflichtungen, Bonität, Objektbewertung und den jeweiligen Kreditrichtlinien ab.')}
            </p>
            <p style={{ margin: 0 }}>
              {t('strategie.disc3', 'Steuerliche Berechnungen dienen der Modellierung und ersetzen keine individuelle steuerliche Beratung.')}
            </p>
          </div>
        </Section>

        <div style={{ marginTop: 26, textAlign: 'center', fontSize: 12, color: '#999' }}>
          Happy Property Cyprus · <a href="https://happy-property.com" style={{ color: CORAL, textDecoration: 'none' }}>happy-property.com</a>
        </div>
      </div>
    </div>
  )
}
