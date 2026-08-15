import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { DECK_LOGO } from '../lib/deckTypes'
import {
  allocate, aggregate, totalsOf, roeMeaningful, migrateConfig, DEFAULT_SIM_PARAMS,
  type SimUnit, type SimParams, type StrategyConfig, type YearRow,
} from '../lib/strategy'

// ── Öffentlicher Investitions-Fahrplan ───────────────────────────────────────
// /strategie/:token — die Kundenansicht des Strategie-Simulators. Rechnet live
// aus dem gespeicherten Szenario mit derselben Engine wie die Einzelrechnungen
// (lib/strategy → lib/rechner); Sven gibt den Plan im Simulator frei, der
// Begleit-Entwurf liegt dann im Postausgang.

const CORAL = '#ff795d', DARK = '#2e3c47', GREEN = '#2d8a5e'
// Diagramm-Palette: gegen Farbfehlsichtigkeit geprüft (Blau/Koralle/Grün),
// Kontrast-Warnung der Koralle wird durch Direktlabels + Tabelle aufgefangen.
const C_WORTH = '#2563eb', C_DEBT = '#ff795d', C_POS = '#1d7a4f', C_NEG = '#b45309'
const GRID = '#e8e5e0', AXIS = '#9a9a9a'
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


// ── Diagramme (reines SVG, keine Fremdbibliothek) ───────────────────────────
// Regeln: eine Achse je Diagramm (nie zwei Skalen), dünne Marken, zurückhaltendes
// Raster, Legende bei mehreren Reihen, Direktlabels statt Zahl an jedem Punkt.
// Werte erscheinen zusätzlich beim Überfahren (title) und stehen vollständig in
// der Jahres-Tabelle darunter - so ist nichts allein über Farbe kodiert.

const kEur = (n: number) => Math.abs(n) >= 1_000_000
  ? (n / 1_000_000).toFixed(1).replace('.', ',') + ' Mio'
  : Math.round(n / 1000) + 'k'

function Legend({ items }: { items: Array<{ c: string; l: string }> }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 10 }}>
      {items.map(i => (
        <span key={i.l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#555' }}>
          <i style={{ width: 12, height: 3, borderRadius: 2, background: i.c, display: 'inline-block' }} />{i.l}
        </span>
      ))}
    </div>
  )
}

function WorthChart({ rows, isMobile }: { rows: YearRow[]; isMobile: boolean }) {
  if (rows.length < 2) return null
  const W = 900, H = isMobile ? 220 : 260, padL = 58, padR = 14, padT = 14, padB = 30
  const worth = rows.map(r => r.value + r.committed - r.debt)
  const debt = rows.map(r => r.debt)
  const max = Math.max(...worth, ...debt, 1)
  const x = (i: number) => padL + (W - padL - padR) * (i / (rows.length - 1))
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max)
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => max * f)
  const lastW = worth[worth.length - 1], lastD = debt[debt.length - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
      aria-label="Verlauf von Netto-Vermögen und Restschuld">
      {ticks.map(v => (
        <g key={v}>
          <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke={GRID} strokeWidth={1} />
          <text x={padL - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={AXIS}>{kEur(v)}</text>
        </g>
      ))}
      {rows.map((r, i) => (i % (isMobile ? 3 : 2) === 0 || i === rows.length - 1) && (
        <text key={r.year} x={x(i)} y={H - 10} textAnchor="middle" fontSize={11} fill={AXIS}>{r.year}</text>
      ))}
      {/* Fläche unter dem Vermögen für Ruhe im Bild */}
      <path d={`${path(worth)} L${x(rows.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={C_WORTH} opacity={0.08} />
      <path d={path(debt)} fill="none" stroke={C_DEBT} strokeWidth={2} strokeLinecap="round" />
      <path d={path(worth)} fill="none" stroke={C_WORTH} strokeWidth={2.5} strokeLinecap="round" />
      {rows.map((r, i) => (
        <g key={r.year}>
          <title>{`${r.year}: Vermögen ${eur(worth[i])} · Kredit offen ${eur(debt[i])}`}</title>
          <rect x={x(i) - 8} y={padT} width={16} height={H - padT - padB} fill="transparent" />
        </g>
      ))}
      <circle cx={x(rows.length - 1)} cy={y(lastW)} r={4} fill={C_WORTH} stroke="#fff" strokeWidth={2} />
      <circle cx={x(rows.length - 1)} cy={y(lastD)} r={4} fill={C_DEBT} stroke="#fff" strokeWidth={2} />
    </svg>
  )
}

function CashflowChart({ rows, isMobile }: { rows: YearRow[]; isMobile: boolean }) {
  const data = rows.filter(r => r.rents > 0 || r.cashflow !== 0)
  if (!data.length) return null
  const W = 900, H = isMobile ? 190 : 220, padL = 58, padR = 14, padT = 14, padB = 30
  const vals = data.map(r => r.cashflow)
  const max = Math.max(...vals, 0), min = Math.min(...vals, 0)
  const span = (max - min) || 1
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - min) / span)
  const bw = Math.max(6, (W - padL - padR) / data.length - 6)   // 6px Luft zwischen den Balken
  const x = (i: number) => padL + (W - padL - padR) * (i / data.length) + 3
  const zero = y(0)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
      aria-label="Cashflow je Jahr">
      {[max, (max + min) / 2, min].map((v, i) => (
        <g key={i}>
          <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke={GRID} strokeWidth={1} />
          <text x={padL - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={AXIS}>{kEur(v)}</text>
        </g>
      ))}
      <line x1={padL} y1={zero} x2={W - padR} y2={zero} stroke={AXIS} strokeWidth={1} />
      {data.map((r, i) => {
        const pos = r.cashflow >= 0
        const h = Math.max(2, Math.abs(y(r.cashflow) - zero))
        return (
          <g key={r.year}>
            <title>{`${r.year}: ${eur(r.cashflow)}`}</title>
            <rect x={x(i)} y={pos ? zero - h : zero} width={bw} height={h} rx={4}
              fill={pos ? C_POS : C_NEG} />
            {(i === 0 || i === data.length - 1) && (
              <text x={x(i) + bw / 2} y={pos ? zero - h - 6 : zero + h + 14} textAnchor="middle"
                fontSize={11} fill={pos ? C_POS : C_NEG} fontWeight={600}>{kEur(r.cashflow)}</text>
            )}
            {(i % (isMobile ? 3 : 2) === 0 || i === data.length - 1) && (
              <text x={x(i) + bw / 2} y={H - 10} textAnchor="middle" fontSize={11} fill={AXIS}>{r.year}</text>
            )}
          </g>
        )
      })}
    </svg>
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
  const agg = useMemo(() => aggregate(outcomes, params), [outcomes, params])
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
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3,1fr)', gap: 12, marginBottom: 22 }}>
          {[
            { l: t('strategie.kpiEk', 'Eigenkapital inkl. Nebenkosten'), v: eur(totals.ekTotal) },
            { l: t('strategie.kpiWorth', 'Netto-Vermögen am Ende'), v: eur(totals.netWorth), hero: true },
            { l: t('strategie.kpiRents', 'Mieteinnahmen gesamt'), v: eur(totals.rents) },
            { l: t('strategie.kpiDebt', 'Kredit noch offen'), v: eur(totals.debtEnd) },
            { l: t('strategie.kpiRoe5', 'EK-Rendite nach 5 Jahren'), v: pct(totals.roe5) },
            { l: t('strategie.kpiRoe10', 'EK-Rendite nach 10 Jahren'), v: pct(totals.roe10) },
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

        {agg.bridgeNeeded && (
          <div style={{ ...card, marginBottom: 22, borderLeft: `4px solid ${CORAL}` }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: DARK, marginBottom: 4 }}>
              {t('strategie.bridgeTitle', 'Zwischenfinanzierung in der Bauzeit')}
            </div>
            <div style={{ fontSize: 13, color: '#555', lineHeight: 1.6 }}>
              {t('strategie.bridgeText', 'Die Kaufraten übersteigen zeitweise dein Eigenkapital - in der Spitze um {{peak}}. Dieser Betrag wird bis zur Übergabe zwischenfinanziert; die Zinsen dafür sind in der Tabelle enthalten (Spalte Zinsen) und bei der Übergabe löst das eigentliche Darlehen die Zwischenfinanzierung ab.', { peak: eur(agg.bridgePeak) })}
            </div>
          </div>
        )}

        {/* Grafiken */}
        <h2 style={{ fontFamily: SERIF, fontSize: isMobile ? 17 : 20, color: DARK, margin: '0 0 12px' }}>
          {t('strategie.chartsTitle', 'Auf einen Blick')}
        </h2>
        <div style={{ ...card, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: DARK, marginBottom: 2 }}>
            {t('strategie.chartWorthTitle', 'Vermögen und Restschuld')}
          </div>
          <div style={{ fontSize: 12, color: '#777', marginBottom: 10 }}>
            {t('strategie.chartWorthSub', 'Dein Netto-Vermögen wächst, während der Kredit getilgt wird.')}
          </div>
          <WorthChart rows={agg.rows} isMobile={isMobile} />
          <Legend items={[
            { c: C_WORTH, l: t('strategie.legendWorth', 'Netto-Vermögen') },
            { c: C_DEBT, l: t('strategie.legendDebt', 'Kredit offen') },
          ]} />
        </div>
        <div style={{ ...card, marginBottom: 26 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: DARK, marginBottom: 2 }}>
            {t('strategie.chartCfTitle', 'Cashflow je Jahr')}
          </div>
          <div style={{ fontSize: 12, color: '#777', marginBottom: 10 }}>
            {t('strategie.chartCfSub', 'Was nach Zins, Tilgung, Verwaltung und Steuern übrig bleibt.')}
          </div>
          <CashflowChart rows={agg.rows} isMobile={isMobile} />
          <Legend items={[
            { c: C_POS, l: t('strategie.legendPos', 'Überschuss') },
            { c: C_NEG, l: t('strategie.legendNeg', 'Zuzahlung') },
          ]} />
        </div>

        {/* Jahr für Jahr */}
        <h2 style={{ fontFamily: SERIF, fontSize: isMobile ? 17 : 20, color: DARK, margin: '0 0 12px' }}>{t('strategie.yearsTitle', 'Jahr für Jahr')}
          <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 400, color: '#8a8a8a', marginLeft: 8 }}>
            {t('strategie.period', '{{from}} bis {{to}}', { from: agg.firstYear, to: agg.lastYear })}
          </span>
        </h2>
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
            {t('strategie.periodNote', 'Betrachtungszeitraum: 10 Jahre ab der Übergabe der ersten Wohnung (bis {{to}}).', { to: agg.lastYear })}{' '}
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
