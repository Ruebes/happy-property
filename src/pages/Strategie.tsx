import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'
import {
  allocate, aggregate, totalsOf, roeMeaningful, migrateConfig, DEFAULT_SIM_PARAMS,
  type SimUnit, type SimParams, type StrategyConfig,
} from '../lib/strategy'

// ── Öffentlicher Investitions-Fahrplan ───────────────────────────────────────
// /strategie/:token — die Kundenansicht des Strategie-Simulators. Rechnet live
// aus dem gespeicherten Szenario mit derselben Engine wie die Einzelrechnungen
// (lib/strategy → lib/rechner); Sven gibt den Plan im Simulator frei, der
// Begleit-Entwurf liegt dann im Postausgang.

const CORAL = '#ff795d', DARK = '#2e3c47', GREEN = '#2d8a5e'
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

export default function Strategie() {
  const { t } = useTranslation()
  const { token } = useParams<{ token: string }>()
  const [units, setUnits] = useState<SimUnit[]>([])
  const [params, setParams] = useState<SimParams>({ ...DEFAULT_SIM_PARAMS })
  const [meta, setMeta] = useState<{ title?: string; recipient_name?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
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

  const outcomes = useMemo(() => units.length ? allocate(units, params) : [], [units, params])
  const agg = useMemo(() => aggregate(outcomes), [outcomes])
  const totals = useMemo(() => totalsOf(outcomes, agg.rows), [outcomes, agg])

  if (loading) return <Centered>{t('strategie.loading', 'Lädt…')}</Centered>
  if (err || !units.length) return <Centered>{err || t('strategie.empty', 'Dieser Fahrplan enthält noch keine Wohnungen.')}</Centered>

  const today = new Date().toLocaleDateString('de-DE')
  const card: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: isMobile ? 16 : 20, boxShadow: '0 1px 3px rgba(0,0,0,.06)' }
  const th: React.CSSProperties = { textAlign: 'right', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: '#8a8a8a', fontWeight: 600, whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { textAlign: 'right', padding: '7px 10px', fontSize: 13, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

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
              {units.length === 1 ? t('strategie.oneUnit', '1 Wohnung') : t('strategie.nUnits', '{{n}} Wohnungen', { n: units.length })}
            </div>
            <div style={{ fontSize: 11, color: '#aaa' }}>{t('strategie.generatedOn', 'Stand {{date}}', { date: today })}</div>
          </div>
        </div>
        <div style={{ height: 3, background: `linear-gradient(90deg,${CORAL},#ffb89d)`, borderRadius: 2, marginBottom: 22 }} />

        {/* Kernzahlen */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4,1fr)', gap: 12, marginBottom: 22 }}>
          {[
            { l: t('strategie.kpiEk', 'Eigenkapital inkl. Nebenkosten'), v: eur(totals.ekTotal) },
            { l: t('strategie.kpiWorth', 'Netto-Vermögen am Ende'), v: eur(totals.netWorth), hero: true },
            { l: t('strategie.kpiRents', 'Mieteinnahmen gesamt'), v: eur(totals.rents) },
            { l: t('strategie.kpiRoe', 'Gesamtrendite über den Zeitraum'), v: pct(totals.roe) },
          ].map(k => (
            <div key={k.l} style={{ ...card, padding: isMobile ? 12 : 16, borderTop: `3px solid ${k.hero ? CORAL : '#e6e3dd'}` }}>
              <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: '#8a8a8a' }}>{k.l}</div>
              <div style={{ fontFamily: SERIF, fontSize: isMobile ? 19 : 23, fontWeight: 800, color: k.hero ? CORAL : DARK, marginTop: 4 }}>{k.v}</div>
            </div>
          ))}
        </div>

        {/* Die Wohnungen auf der Zeitachse */}
        <h2 style={{ fontFamily: SERIF, fontSize: isMobile ? 17 : 20, color: DARK, margin: '0 0 12px' }}>{t('strategie.unitsTitle', 'Deine Wohnungen')}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit,minmax(320px,1fr))', gap: 12, marginBottom: 26 }}>
          {outcomes.map(o => (
            <div key={o.unit.key} style={card}>
              <div style={{ fontWeight: 700, fontSize: 15, color: DARK }}>{o.unit.name}</div>
              <div style={{ fontSize: 12, color: '#777', marginTop: 2 }}>
                {t('strategie.purchase', 'Kauf')} {mmyyyy(o.unit.buyM, o.unit.buyY)} · {t('strategie.handover', 'Übergabe')} {mmyyyy(o.unit.readyM, o.unit.readyY)}
                {' · '}{o.unit.letType === 'short' ? t('strategie.short', 'Kurzzeitvermietung') : t('strategie.long', 'Langzeitvermietung')}
              </div>
              <div style={{ marginTop: 10, display: 'grid', gap: 6, fontSize: 13 }}>
                {[
                  [t('strategie.rowPrice', 'Gesamtpreis inkl. Einrichtung'), eur(o.gross)],
                  [t('strategie.rowEk', 'davon Eigenkapital'), eur(o.ekUsed)],
                  ...(o.loan > 0 ? [[t('strategie.rowLoan', 'Annuitätendarlehen'), `${eur(o.loan)} · ${eur(o.res.mRate)}/${t('strategie.month', 'Monat')}`]] : []),
                  [t('strategie.rowRent', 'Miete im 1. Jahr'), eur(o.res.rents[0])],
                  ...(roeMeaningful(o)
                    ? [[t('strategie.rowRoe', 'Rendite auf Eigenkapital (10 J.)'), pct(o.res.roe10)]]
                    : [[t('strategie.rowFinanced', 'Finanzierungsanteil'), t('strategie.mostlyFinanced', 'überwiegend fremdfinanziert')]]),
                ].map(([l, v]) => (
                  <div key={l} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid #f2f0ec', paddingBottom: 5 }}>
                    <span style={{ color: '#666' }}>{l}</span><b style={{ color: DARK, fontVariantNumeric: 'tabular-nums' }}>{v}</b>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Jahr für Jahr */}
        <h2 style={{ fontFamily: SERIF, fontSize: isMobile ? 17 : 20, color: DARK, margin: '0 0 12px' }}>{t('strategie.yearsTitle', 'Jahr für Jahr')}</h2>
        <div style={{ ...card, padding: 0, overflowX: 'auto', marginBottom: 22 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #eee' }}>
                <th style={{ ...th, textAlign: 'left' }}>{t('strategie.colYear', 'Jahr')}</th>
                <th style={th}>{t('strategie.colInvest', 'Zahlungen Kauf')}</th>
                <th style={th}>{t('strategie.colRents', 'Mieten')}</th>
                <th style={th}>{t('strategie.colCosts', 'Verwaltung')}</th>
                <th style={th}>{t('strategie.colInterest', 'Zinsen')}</th>
                <th style={th}>{t('strategie.colPrincipal', 'Tilgung')}</th>
                <th style={th}>{t('strategie.colTaxes', 'Steuern')}</th>
                <th style={th}>{t('strategie.colVat', 'MwSt-Erstattung')}</th>
                <th style={th}>{t('strategie.colCashflow', 'Cashflow')}</th>
                <th style={th}>{t('strategie.colCommitted', 'gebundenes Kapital')}</th>
                <th style={th}>{t('strategie.colWorth', 'Netto-Vermögen')}</th>
              </tr>
            </thead>
            <tbody>
              {agg.rows.map(r => (
                <tr key={r.year} style={{ borderBottom: '1px solid #f5f3f0' }}>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{r.year}</td>
                  <td style={{ ...td, color: CORAL }}>{r.invest ? `−${eur(r.invest)}` : ''}</td>
                  <td style={{ ...td, color: GREEN }}>{r.rents ? eur(r.rents) : ''}</td>
                  <td style={td}>{r.mgmt ? `−${eur(r.mgmt)}` : ''}</td>
                  <td style={td}>{r.interest ? `−${eur(r.interest)}` : ''}</td>
                  <td style={td}>{r.principal ? `−${eur(r.principal)}` : ''}</td>
                  <td style={td}>{r.taxes ? `−${eur(r.taxes)}` : ''}</td>
                  <td style={{ ...td, color: GREEN }}>{r.vat ? `+${eur(r.vat)}` : ''}</td>
                  <td style={{ ...td, fontWeight: 700, color: r.cashflow >= 0 ? GREEN : '#b45309' }}>{r.rents || r.cashflow ? eur(r.cashflow) : ''}</td>
                  <td style={{ ...td, color: '#777' }}>{r.committed ? eur(r.committed) : ''}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{(r.value + r.committed) ? eur(r.value + r.committed - r.debt) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Annahmen + Hinweis */}
        <div style={{ ...card, marginBottom: 18 }}>
          <div style={{ fontSize: 12.5, color: '#666', lineHeight: 1.8 }}>
            <b style={{ color: DARK }}>{t('strategie.assumptionsTitle', 'Annahmen')}:</b>{' '}
            {t('strategie.assumptions', 'Wertsteigerung {{g}} % p.a., Mietsteigerung {{r}} % p.a., Finanzierung als Annuitätendarlehen zu {{i}} % auf {{y}} Jahre, Steuersitz Deutschland ({{d}} % Grenzsteuersatz). Bei Kurzzeitvermietung ist die MwSt-Erstattung nach 24 Monaten berücksichtigt.', {
              g: String(params.growth).replace('.', ','), r: String(params.rentGrowth).replace('.', ','),
              i: String(params.interest).replace('.', ','), y: params.termYears, d: params.deTaxPct,
            })}
          </div>
        </div>
        <p style={{ fontSize: 11.5, color: '#999', lineHeight: 1.7, margin: 0 }}>
          {t('strategie.disclaimer', 'Diese Übersicht ist eine Beispielrechnung auf Basis der oben genannten Annahmen und ersetzt keine Steuer- oder Anlageberatung. Die detaillierten Einzelrechnungen zu den Wohnungen hast du separat erhalten.')}
        </p>
        <div style={{ marginTop: 26, textAlign: 'center', fontSize: 12, color: '#999' }}>
          Happy Property Cyprus · <a href="https://happy-property.com" style={{ color: CORAL, textDecoration: 'none' }}>happy-property.com</a>
        </div>
      </div>
    </div>
  )
}
