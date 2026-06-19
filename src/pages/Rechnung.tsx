import { useEffect, useMemo, useState, type ReactNode, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { compute, type CalcContent, type CalcItem, type CalcResult } from '../lib/rechner'

// ── Öffentliche Rendite-Rechnung / Immobilienvergleich (HTML-Microsite) ───────
// /rechnung/:token — Einzelobjekt ODER Vergleich, gebrandet im Happy-Property-CI.
// Rechnet live aus den gespeicherten Parametern mit der verifizierten Engine.

const CORAL = '#ff795d', DARK = '#1a1a1a', GREEN = '#2f6b4f', RED = '#d04545'
const PALETTE = ['#2f6b4f', '#226f8f', '#ff795d', '#7a5a9e', '#b8860b']
const SERIF = "'Playfair Display',Georgia,serif"
const SANS = "'Montserrat','Helvetica Neue',Arial,sans-serif"

const eur = (n: number | null | undefined) => n == null || isNaN(n) ? '–'
  : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(n))
const pct = (n: number | null | undefined, d = 2) => n == null || isNaN(n) ? '–'
  : new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n) + ' %'

interface Row { item: CalcItem; color: string; res: CalcResult | null }

export default function Rechnung() {
  const { token } = useParams<{ token: string }>()
  const [content, setContent] = useState<CalcContent | null>(null)
  const [meta, setMeta] = useState<{ recipient_name?: string; title?: string; with_calc?: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => { void (async () => {
    if (!token) return
    const { data, error } = await supabase.rpc('get_calculation_by_token', { p_token: token })
    const row = Array.isArray(data) ? data[0] : data
    if (error || !row) { setErr('Diese Rechnung wurde nicht gefunden.'); setLoading(false); return }
    setContent(row.content as CalcContent)
    setMeta({ recipient_name: row.recipient_name, title: row.title, with_calc: row.with_calc })
    setLoading(false)
  })() }, [token])

  const rows: Row[] = useMemo(() => {
    if (!content?.items) return []
    return content.items.map((item, i) => ({
      item, color: item.color || PALETTE[i % PALETTE.length],
      res: item.params ? compute(item.params) : null,
    }))
  }, [content])

  if (loading) return <Centered>Lädt…</Centered>
  if (err || !content) return <Centered>{err || 'Nicht gefunden.'}</Centered>

  const name = meta?.recipient_name || content.recipient_name || ''
  const withCalc = (meta?.with_calc ?? content.with_calc) && rows.some(r => r.res)
  const isCompare = rows.length > 1
  const stamp = new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })

  return (
    <div style={{ background: '#f4f3f1', minHeight: '100vh', fontFamily: SANS, color: '#2b2b2b' }}>
      {/* Header-Leiste */}
      <div style={{ background: CORAL, color: '#fff', padding: '15px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, fontWeight: 600, letterSpacing: 0.8 }}>
        <span>HAPPY PROPERTY CYPRUS</span>
        <span style={{ opacity: 0.9 }}>{name ? `Persönlich für ${name} · ` : ''}{stamp}</span>
      </div>

      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '44px 24px 72px' }}>
        <div style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.5, color: CORAL, textTransform: 'uppercase' }}>
            {isCompare ? 'Immobilienvergleich' : 'Rendite-Rechnung'}
          </span>
        </div>
        <h1 style={{ fontFamily: SERIF, fontSize: 40, fontWeight: 800, margin: '0 0 8px', letterSpacing: -0.5, lineHeight: 1.1 }}>
          {isCompare
            ? (name ? `${name.split(' ')[0]}s Vergleich` : 'Dein Vergleich')
            : (rows[0]?.item.label || 'Deine Rechnung')}
        </h1>
        <div style={{ height: 4, width: 80, background: CORAL, borderRadius: 2, marginBottom: 18 }} />
        {content.tagline && <p style={{ fontSize: 17, color: '#777', margin: '0 0 16px' }}>{content.tagline}</p>}
        {content.intro && <p style={{ fontSize: 15, lineHeight: 1.7, color: '#444', whiteSpace: 'pre-wrap', margin: '0 0 28px', maxWidth: 720 }}>{content.intro}</p>}

        {/* ── EINZEL-ANSICHT ─────────────────────────────────────── */}
        {!isCompare && withCalc && rows[0]?.res && <Single row={rows[0]} />}

        {/* ── VERGLEICH ──────────────────────────────────────────── */}
        {isCompare && (
          <>
            <CompareCards rows={rows} withCalc={withCalc} />
            {rows.some(r => r.item.strategy_title || r.item.strategy_text) && <StrategyCards rows={rows} />}
            {withCalc && <CompareTable rows={rows} />}
            {withCalc && <Bars rows={rows} />}
            {withCalc && <CashflowTable rows={rows} />}
          </>
        )}

        {/* Ohne Berechnung → reine Objekt-Daten */}
        {!withCalc && <SpecsCard rows={rows} />}

        <p style={{ fontSize: 11, color: '#aaa', marginTop: 40, lineHeight: 1.6, textAlign: 'center' }}>
          IRR = interne Kapitalrendite auf das eingesetzte Eigenkapital (jährlich). Alle Werte sind Projektionen und unverbindlich — keine Steuer- oder Anlageberatung. Stand {stamp}.
        </p>
      </div>
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontFamily: SANS, background: '#f4f3f1' }}>{children}</div>
}

const Card = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div style={{ background: '#fff', borderRadius: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.05)', padding: 24, ...style }}>{children}</div>
)
const SectionTitle = ({ children }: { children: ReactNode }) => (
  <h2 style={{ fontFamily: SERIF, fontSize: 25, fontWeight: 700, margin: '36px 0 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
    <span style={{ width: 6, height: 24, background: CORAL, borderRadius: 3, display: 'inline-block' }} />{children}
  </h2>
)

// ── Einzel-Ansicht: KPI-Hero + Kennzahlen + Cashflow + Wertentwicklung ────────
function Single({ row }: { row: Row }) {
  const r = row.res!
  const kpi = (label: string, value: string, bg: string, color: string, sub?: string) => (
    <div style={{ background: bg, color, borderRadius: 16, padding: '20px 22px', flex: '1 1 0', minWidth: 150 }}>
      <div style={{ fontSize: 12.5, opacity: 0.85, marginBottom: 8, fontWeight: 500 }}>{label}</div>
      <div style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 800, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>{sub}</div>}
    </div>
  )
  const stat = (label: string, value: string, strong?: boolean) => (
    <div style={{ padding: '14px 4px', borderBottom: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 12.5, color: '#888', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: strong ? 800 : 600, color: strong ? CORAL : '#1a1a1a' }}>{value}</div>
    </div>
  )
  return (
    <>
      {/* KPI-Hero */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        {kpi('Rendite p.a. (IRR)', pct(r.irrV * 100), CORAL, '#fff', 'auf dein Eigenkapital')}
        {kpi('Eigenkapital nach 10 Jahren', eur(r.ek10), DARK, '#fff', `aus ${eur(r.ekStart)} Einsatz`)}
        {kpi('Cashflow / Monat (J1)', eur(r.mCF), r.mCF >= 0 ? GREEN : RED, '#fff', r.mCF >= 0 ? 'fließt dir zu' : 'Zuzahlung')}
        {kpi('EK-Rendite kumuliert', pct(r.roe10, 0), '#fff', '#1a1a1a', 'über 10 Jahre')}
      </div>

      {/* Kennzahlen auf einen Blick */}
      <Card style={{ marginTop: 24 }}>
        <div style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, marginBottom: 4 }}>Auf einen Blick</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: '0 28px' }}>
          {stat('Kaufpreis (brutto)', eur(r.pGross))}
          {stat('Eigenkapital + Nebenkosten', eur(r.ekStart))}
          {stat('Finanzierung', r.loan > 0 ? eur(r.loan) : 'ohne (Cash)')}
          {stat('Bruttomietrendite', pct(r.yPct, 1))}
          {stat('Wertsteigerung p.a.', pct(r.appP, 1))}
          {stat('Immobilienwert nach 10 J.', eur(r.propV[9]))}
          {stat('Restschuld nach 10 J.', eur(r.restL[9]))}
          {stat('Gesamtertrag über 10 J.', eur(r.totRet), true)}
        </div>
      </Card>

      {/* Wertentwicklung-Balken (Immobilienwert / Restschuld / EK) */}
      <Card style={{ marginTop: 18 }}>
        <div style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 700, marginBottom: 14 }}>So baust du Vermögen auf</div>
        {(() => {
          const max = Math.max(r.propV[9], r.ekStart, 1)
          const bar = (label: string, val: number, color: string) => (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <div style={{ width: 180, fontSize: 13, color: '#555', flexShrink: 0 }}>{label}</div>
              <div style={{ flex: 1, background: '#f1f0ee', borderRadius: 6, height: 30, position: 'relative' }}>
                <div style={{ width: `${Math.max(3, val / max * 100)}%`, background: color, height: 30, borderRadius: 6 }} />
              </div>
              <div style={{ width: 130, textAlign: 'right', fontWeight: 700, fontSize: 14, flexShrink: 0 }}>{eur(val)}</div>
            </div>
          )
          return <>
            {bar('Dein Einsatz heute', r.ekStart, '#cbb9a8')}
            {bar('Immobilienwert in 10 J.', r.propV[9], '#226f8f')}
            {bar('Dein Eigenkapital in 10 J.', r.ek10, CORAL)}
          </>
        })()}
      </Card>

      {/* Cashflow-Tabelle */}
      <SectionTitle>Cashflow nach Steuern & Kreditrate</SectionTitle>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ background: DARK, color: '#fff' }}>
            <th style={{ padding: '11px 16px', textAlign: 'left', fontSize: 13 }}>Jahr</th>
            <th style={{ padding: '11px 16px', textAlign: 'right', fontSize: 13 }}>Mieteinnahmen</th>
            <th style={{ padding: '11px 16px', textAlign: 'right', fontSize: 13 }}>Kreditrate</th>
            <th style={{ padding: '11px 16px', textAlign: 'right', fontSize: 13 }}>Cashflow / Jahr</th>
            <th style={{ padding: '11px 16px', textAlign: 'right', fontSize: 13 }}>/ Monat</th>
          </tr></thead>
          <tbody>
            {r.yN.map((y, i) => (
              <tr key={y} style={{ background: i % 2 ? '#fafafa' : '#fff' }}>
                <td style={{ padding: '10px 16px', fontWeight: 700, fontSize: 13.5 }}>{y}</td>
                <td style={{ padding: '10px 16px', textAlign: 'right', fontSize: 13.5, color: '#555' }}>{eur(r.rents[i])}</td>
                <td style={{ padding: '10px 16px', textAlign: 'right', fontSize: 13.5, color: '#555' }}>{eur(r.rateC[i])}</td>
                <td style={{ padding: '10px 16px', textAlign: 'right', fontSize: 13.5, fontWeight: 700, color: r.cfA[i] < 0 ? RED : GREEN }}>{eur(r.cfA[i])}</td>
                <td style={{ padding: '10px 16px', textAlign: 'right', fontSize: 13, color: r.cfA[i] < 0 ? RED : '#888' }}>{eur(r.cfA[i] / 12)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}

// ── Vergleich: Karten ─────────────────────────────────────────────────────────
function CompareCards({ rows, withCalc }: { rows: Row[]; withCalc: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(rows.length, 3)},1fr)`, gap: 16 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ background: r.color, color: '#fff', borderRadius: 18, padding: '24px 24px', boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}>
          <div style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{r.item.label || r.item.project}</div>
          <div style={{ fontSize: 12.5, opacity: 0.9, marginBottom: 14 }}>
            {[r.item.bedrooms != null ? `${r.item.bedrooms}-Schlafzimmer` : '', r.item.size_sqm != null ? `${r.item.size_sqm} m²` : ''].filter(Boolean).join(' · ')}
          </div>
          {r.item.tagline && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>{r.item.tagline}</div>}
          {r.res && withCalc ? (
            <>
              <div style={{ fontSize: 12.5, opacity: 0.9 }}>EK {eur(r.res.ekStart)} · Kredit {eur(r.res.loan)}</div>
              <div style={{ fontFamily: SERIF, fontSize: 32, fontWeight: 800, margin: '10px 0 2px' }}>{pct(r.res.irrV * 100)}</div>
              <div style={{ fontSize: 12.5, opacity: 0.9, marginBottom: 12 }}>Rendite p.a. (IRR)</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderTop: '1px solid rgba(255,255,255,0.25)', paddingTop: 10 }}>
                <span style={{ opacity: 0.9 }}>EK in 10 J.</span><strong>{eur(r.res.ek10)}</strong>
              </div>
            </>
          ) : (
            <div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 800, marginTop: 8 }}>{eur(r.item.price_gross ?? r.item.price_net)}</div>
          )}
        </div>
      ))}
    </div>
  )
}

function StrategyCards({ rows }: { rows: Row[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(rows.length, 3)},1fr)`, gap: 16, marginTop: 18 }}>
      {rows.map((r, i) => (
        <Card key={i} style={{ borderTop: `4px solid ${r.color}`, padding: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: r.color, marginBottom: 8 }}>{(r.item.label || r.item.project).toUpperCase()}</div>
          {r.item.strategy_title && <div style={{ fontFamily: SERIF, fontSize: 18, marginBottom: 8 }}>{r.item.strategy_title}</div>}
          {r.item.strategy_text && <div style={{ fontSize: 13, lineHeight: 1.6, color: '#555' }}>{r.item.strategy_text}</div>}
        </Card>
      ))}
    </div>
  )
}

function CompareTable({ rows }: { rows: Row[] }) {
  const td: CSSProperties = { padding: '11px 14px', fontSize: 13.5, borderBottom: '1px solid #f0f0f0', textAlign: 'right' }
  const lbl: CSSProperties = { ...td, textAlign: 'left', color: '#777' }
  const best = (vals: number[]) => { const v = Math.max(...vals); return vals.map(x => x === v) }
  const irrBest = best(rows.map(r => r.res?.irrV ?? -1))
  const ekBest = best(rows.map(r => r.res?.ek10 ?? -1))
  const row = (label: string, fn: (r: Row) => string, bold?: boolean[]) => (
    <tr>
      <td style={lbl}>{label}</td>
      {rows.map((r, i) => <td key={i} style={{ ...td, fontWeight: bold?.[i] ? 800 : 500, color: bold?.[i] ? r.color : '#1a1a1a' }}>{fn(r)}</td>)}
    </tr>
  )
  const sect = (txt: string) => <tr><td colSpan={rows.length + 1} style={{ padding: 0 }}><div style={{ background: '#fbe9e3', color: '#c2410c', fontWeight: 700, fontSize: 11.5, letterSpacing: 0.5, padding: '8px 14px' }}>{txt}</div></td></tr>
  return (
    <>
      <SectionTitle>Der Vergleich</SectionTitle>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
            <thead><tr>
              <th style={{ background: DARK, padding: '12px 14px' }}></th>
              {rows.map((r, i) => <th key={i} style={{ background: r.color, color: '#fff', padding: '12px 14px', fontSize: 13.5, textAlign: 'center' }}>{r.item.label || r.item.project}</th>)}
            </tr></thead>
            <tbody>
              {sect('OBJEKT')}
              {rows.some(r => r.item.location) && row('Lage', r => r.item.location || '–')}
              {rows.some(r => r.item.developer) && row('Bauträger', r => r.item.developer || '–')}
              {row('Wertsteigerung p.a.', r => pct(r.res?.appP ?? null, 1))}
              {row('Bruttorendite', r => pct(r.res?.yPct ?? null, 1))}
              {sect('FINANZIERUNG')}
              {row('Kaufpreis brutto', r => eur(r.res?.pGross))}
              {row('Eigenkapital + NK', r => eur(r.res?.ekStart))}
              {row('Finanzierung', r => r.res && r.res.loan > 0 ? eur(r.res.loan) : 'Cash')}
              {row('Cashflow Jahr 1', r => eur(r.res?.cfA[0]))}
              {sect('NACH 10 JAHREN')}
              {row('Gesamtertrag', r => eur(r.res?.totRet))}
              {row('Immobilienwert', r => eur(r.res?.propV[9]))}
              {row('Restschuld', r => eur(r.res?.restL[9]))}
              {row('Eigenkapital', r => eur(r.res?.ek10), ekBest)}
              {row('Rendite p.a. (IRR)', r => pct((r.res?.irrV ?? 0) * 100), irrBest)}
              {row('EK-Rendite kum.', r => pct(r.res?.roe10))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}

function Bars({ rows }: { rows: Row[] }) {
  const block = (title: string, fn: (r: Row) => number, fmt: (n: number) => string) => {
    const vals = rows.map(fn); const max = Math.max(...vals.map(Math.abs), 1)
    return (
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 12 }}>{title}</div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <div style={{ width: 180, fontSize: 12.5, color: '#555', flexShrink: 0 }}>{r.item.label || r.item.project}</div>
            <div style={{ flex: 1, background: '#f1f0ee', borderRadius: 6, height: 28 }}>
              <div style={{ width: `${Math.max(3, Math.abs(vals[i]) / max * 100)}%`, background: r.color, height: 28, borderRadius: 6 }} />
            </div>
            <div style={{ width: 120, textAlign: 'right', fontWeight: 700, fontSize: 13.5, flexShrink: 0 }}>{fmt(vals[i])}</div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <>
      <SectionTitle>Rendite & Wertentwicklung</SectionTitle>
      <Card>
        {block('Eigenkapital nach 10 Jahren', r => r.res?.ek10 ?? 0, eur)}
        {block('Immobilienwert nach 10 Jahren', r => r.res?.propV[9] ?? 0, eur)}
        {block('Jährliche Rendite (IRR)', r => (r.res?.irrV ?? 0) * 100, n => pct(n))}
      </Card>
    </>
  )
}

function CashflowTable({ rows }: { rows: Row[] }) {
  const years = rows[0]?.res?.yN ?? []
  return (
    <>
      <SectionTitle>Cashflow nach Steuern & Kreditrate</SectionTitle>
      <p style={{ fontSize: 13.5, color: '#666', margin: '-8px 0 16px', lineHeight: 1.6, maxWidth: 720 }}>
        Was nach Miete, Verwaltung, Kreditrate und Steuern übrig bleibt. Positive Werte fließen dir zu, negative bedeuten eine Zuzahlung.
      </p>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead><tr>
              <th style={{ background: DARK, color: '#fff', padding: '11px 16px', fontSize: 13.5, textAlign: 'left' }}>Jahr</th>
              {rows.map((r, i) => <th key={i} style={{ background: r.color, color: '#fff', padding: '11px 16px', fontSize: 13.5 }}>{r.item.label || r.item.project}</th>)}
            </tr></thead>
            <tbody>
              {years.map((y, yi) => (
                <tr key={y} style={{ background: yi % 2 ? '#fafafa' : '#fff' }}>
                  <td style={{ padding: '10px 16px', fontWeight: 700, fontSize: 13.5 }}>{y}</td>
                  {rows.map((r, i) => {
                    const v = r.res?.cfA[yi] ?? 0
                    return <td key={i} style={{ padding: '10px 16px', fontSize: 13.5, fontWeight: 600, textAlign: 'center', color: v < 0 ? RED : GREEN }}>{eur(v)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}

function SpecsCard({ rows }: { rows: Row[] }) {
  const td: CSSProperties = { padding: '11px 14px', fontSize: 13.5, borderBottom: '1px solid #f0f0f0', textAlign: 'right' }
  const lbl: CSSProperties = { ...td, textAlign: 'left', color: '#777' }
  const row = (label: string, fn: (r: Row) => string) => (
    <tr><td style={lbl}>{label}</td>{rows.map((r, i) => <td key={i} style={td}>{fn(r)}</td>)}</tr>
  )
  return (
    <Card style={{ padding: 0, overflow: 'hidden', marginTop: 8 }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
          <thead><tr>
            <th style={{ background: DARK, padding: '12px 14px' }}></th>
            {rows.map((r, i) => <th key={i} style={{ background: r.color, color: '#fff', padding: '12px 14px', fontSize: 13.5 }}>{r.item.label || r.item.project}</th>)}
          </tr></thead>
          <tbody>
            {rows.some(r => r.item.location) && row('Lage', r => r.item.location || '–')}
            {rows.some(r => r.item.developer) && row('Bauträger', r => r.item.developer || '–')}
            {row('Schlafzimmer', r => r.item.bedrooms != null ? String(r.item.bedrooms) : '–')}
            {row('Wohnfläche', r => r.item.size_sqm != null ? `${r.item.size_sqm} m²` : '–')}
            {row('Terrasse', r => r.item.terrace_sqm ? `${r.item.terrace_sqm} m²` : '–')}
            {row('Etage', r => r.item.floor != null ? `${r.item.floor}` : '–')}
            {row('Kaufpreis', r => eur(r.item.price_gross ?? r.item.price_net))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
