import { useEffect, useMemo, useState, type ReactNode, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { compute, type CalcContent, type CalcItem, type CalcResult } from '../lib/rechner'

// ── Öffentliche Rendite-Rechnung / Immobilienvergleich (HTML-Microsite) ───────
// /rechnung/:token  — Einzelobjekt ODER Vergleich (mehrere Objekte) als gebrandete
// Seite im Happy-Property-CI (wie ein Deck). Rechnet aus den gespeicherten Parametern
// live mit der verifizierten Engine (single source of truth).

const PALETTE = ['#2f6b4f', '#226f8f', '#ff795d', '#7a5a9e', '#b8860b']
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
    <div style={{ background: '#fff', minHeight: '100vh', fontFamily: "'Montserrat',-apple-system,Segoe UI,Roboto,sans-serif", color: '#2b2b2b' }}>
      {/* Header-Leiste */}
      <div style={{ background: '#ff795d', color: '#fff', padding: '14px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, fontWeight: 600, letterSpacing: 0.5 }}>
        <span>HAPPY PROPERTY CYPRUS</span>
        <span style={{ opacity: 0.85 }}>{name ? `Persönlich für ${name} · ` : ''}{stamp}</span>
      </div>

      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '40px 32px 64px' }}>
        <h1 style={{ fontFamily: "'Playfair Display',Georgia,serif", fontSize: 38, fontWeight: 800, margin: '0 0 6px', letterSpacing: -0.5 }}>
          {name ? `${name.split(' ')[0]}s Immobilien${isCompare ? 'vergleich' : '-Rechnung'}` : (isCompare ? 'Immobilienvergleich' : 'Rendite-Rechnung')}
        </h1>
        <div style={{ height: 4, width: 90, background: '#ff795d', borderRadius: 2, margin: '0 0 14px' }} />
        {content.tagline && <p style={{ fontSize: 17, color: '#888', margin: '0 0 18px' }}>{content.tagline}</p>}
        {content.intro && <p style={{ fontSize: 15, lineHeight: 1.65, color: '#333', whiteSpace: 'pre-wrap', margin: '0 0 28px' }}>{content.intro}</p>}

        {/* Übersichts-Karten je Objekt */}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(rows.length, 3)},1fr)`, gap: 16, margin: '8px 0 28px' }}>
          {rows.map((r, i) => (
            <div key={i} style={{ background: r.color, color: '#fff', borderRadius: 14, padding: '20px 22px' }}>
              <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 21, fontWeight: 700, marginBottom: 4 }}>{r.item.label || r.item.project}</div>
              <div style={{ fontSize: 12.5, opacity: 0.9, marginBottom: 10 }}>
                {[r.item.bedrooms != null ? `${r.item.bedrooms}-Schlafzimmer` : '', r.item.size_sqm != null ? `${r.item.size_sqm} m²` : ''].filter(Boolean).join(' · ')}
              </div>
              {r.item.tagline && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{r.item.tagline}</div>}
              {r.res ? (
                <>
                  <div style={{ fontSize: 12.5, opacity: 0.9 }}>EK: {eur(r.res.ekStart)} · Kredit: {eur(r.res.loan)}</div>
                  <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 28, fontWeight: 800, margin: '8px 0 2px' }}>IRR p.a.: {pct(r.res.irrV * 100)}</div>
                  <div style={{ fontSize: 12.5, opacity: 0.9 }}>EK-Rendite kum.: {pct(r.res.roe10)}</div>
                  <div style={{ fontWeight: 700, fontSize: 14, marginTop: 6 }}>EK J10: {eur(r.res.ek10)}</div>
                </>
              ) : (
                <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, fontWeight: 800, marginTop: 6 }}>{eur(r.item.price_gross ?? r.item.price_net)}</div>
              )}
            </div>
          ))}
        </div>

        {/* Strategie-Karten */}
        {rows.some(r => r.item.strategy_title || r.item.strategy_text) && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(rows.length, 3)},1fr)`, gap: 16, margin: '0 0 32px' }}>
            {rows.map((r, i) => (
              <div key={i} style={{ background: '#fbfbfb', borderLeft: `4px solid ${r.color}`, borderRadius: 8, padding: '16px 18px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: r.color, marginBottom: 8 }}>{(r.item.label || r.item.project).toUpperCase()}</div>
                {r.item.strategy_title && <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 18, marginBottom: 8 }}>{r.item.strategy_title}</div>}
                {r.item.strategy_text && <div style={{ fontSize: 13, lineHeight: 1.6, color: '#555' }}>{r.item.strategy_text}</div>}
              </div>
            ))}
          </div>
        )}

        {/* Vergleichstabelle */}
        {withCalc && <CompareTable rows={rows} />}

        {/* Balken-Charts */}
        {withCalc && isCompare && <Bars rows={rows} />}

        {/* Cashflow-Tabelle */}
        {withCalc && <CashflowTable rows={rows} />}

        {/* Einzel-Objekt ohne Vergleich: Spezifikationen falls keine Berechnung */}
        {!withCalc && <SpecsTable rows={rows} />}

        <p style={{ fontSize: 11, color: '#999', marginTop: 36, lineHeight: 1.6 }}>
          IRR = Interne Kapitalrendite auf Eigenkapital (jährlich). Alle Werte unverbindlich, keine Steuer- oder Anlageberatung. Stand {stamp}.
        </p>
      </div>
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontFamily: 'Montserrat,sans-serif' }}>{children}</div>
}

const SectHead = ({ children }: { children: ReactNode }) => (
  <div style={{ background: '#fbe9e3', color: '#c2410c', fontWeight: 700, fontSize: 12, letterSpacing: 0.5, padding: '8px 12px' }}>{children}</div>
)

function CompareTable({ rows }: { rows: Row[] }) {
  const td: CSSProperties = { padding: '9px 12px', fontSize: 13, borderBottom: '1px solid #f0f0f0', textAlign: 'right' }
  const lbl: CSSProperties = { ...td, textAlign: 'left', color: '#666' }
  const best = (vals: number[], hi = true) => { const v = hi ? Math.max(...vals) : Math.min(...vals); return vals.map(x => x === v) }
  const irrBest = best(rows.map(r => r.res?.irrV ?? -1))
  const ekBest = best(rows.map(r => r.res?.ek10 ?? -1))
  const row = (label: string, fn: (r: Row) => string, bold?: boolean[]) => (
    <tr>
      <td style={lbl}>{label}</td>
      {rows.map((r, i) => <td key={i} style={{ ...td, fontWeight: bold?.[i] ? 800 : 400, color: bold?.[i] ? r.color : '#2b2b2b' }}>{fn(r)}</td>)}
    </tr>
  )
  return (
    <div style={{ margin: '8px 0 34px', overflowX: 'auto' }}>
      <h2 style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, margin: '0 0 12px' }}>Der Vergleich</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
        <thead><tr>
          <th style={{ background: '#1a1a1a', padding: '10px 12px' }}></th>
          {rows.map((r, i) => <th key={i} style={{ background: r.color, color: '#fff', padding: '10px 12px', fontSize: 13, textAlign: 'center' }}>{r.item.label || r.item.project}</th>)}
        </tr></thead>
        <tbody>
          <tr><td colSpan={rows.length + 1} style={{ padding: 0 }}><SectHead>OBJEKT</SectHead></td></tr>
          {rows.some(r => r.item.location) && row('Lage', r => r.item.location || '–')}
          {rows.some(r => r.item.handover) && row('Übergabe', r => r.item.handover || '–')}
          {rows.some(r => r.item.developer) && row('Bauträger', r => r.item.developer || '–')}
          {row('Wertsteigerung p.a.', r => pct(r.res?.appP ?? null, 1))}
          {row('Bruttorendite J1', r => pct(r.res?.yPct ?? null, 1))}
          <tr><td colSpan={rows.length + 1} style={{ padding: 0 }}><SectHead>FINANZIERUNG</SectHead></td></tr>
          {row('Kaufpreis netto', r => eur(r.res?.pNetList))}
          {row('EK (inkl. Nebenkosten)', r => eur(r.res?.ekStart))}
          {row('Fremdfinanzierung', r => eur(r.res?.loan))}
          {row('Cashflow J1', r => eur(r.res?.cfA[0]))}
          <tr><td colSpan={rows.length + 1} style={{ padding: 0 }}><SectHead>10-JAHRES-KENNZAHLEN</SectHead></td></tr>
          {row('Gesamtertrag J10', r => eur(r.res?.totRet))}
          {row('Immobilienwert J10', r => eur(r.res?.propV[9]))}
          {row('Restschuld J10', r => eur(r.res?.restL[9]))}
          {row('EK nach 10 Jahren', r => eur(r.res?.ek10), ekBest)}
          {row('EK-IRR (jährl.)', r => pct((r.res?.irrV ?? 0) * 100), irrBest)}
          {row('EK-Rendite kum.', r => pct(r.res?.roe10))}
          <tr><td colSpan={rows.length + 1} style={{ padding: 0 }}><SectHead>STRATEGIE</SectHead></td></tr>
          {rows.some(r => r.item.strategy_text) && (
            <tr><td style={lbl}>Passt wenn…</td>{rows.map((r, i) => <td key={i} style={{ ...td, fontSize: 12, color: '#666' }}>{r.item.strategy_text || '–'}</td>)}</tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function Bars({ rows }: { rows: Row[] }) {
  const block = (title: string, fn: (r: Row) => number, fmt: (n: number) => string) => {
    const vals = rows.map(fn); const max = Math.max(...vals.map(Math.abs), 1)
    return (
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>{title}</div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div style={{ width: 200, fontSize: 12, color: '#555', flexShrink: 0 }}>{r.item.label || r.item.project}</div>
            <div style={{ flex: 1, background: '#f3f3f3', borderRadius: 4, height: 26 }}>
              <div style={{ width: `${Math.max(2, Math.abs(vals[i]) / max * 100)}%`, background: r.color, height: 26, borderRadius: 4 }} />
            </div>
            <div style={{ width: 110, textAlign: 'right', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{fmt(vals[i])}</div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div style={{ margin: '8px 0 34px' }}>
      <h2 style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, margin: '0 0 16px' }}>Rendite & Wertentwicklung</h2>
      {block('Eigenkapital nach 10 Jahren', r => r.res?.ek10 ?? 0, eur)}
      {block('Immobilienwert nach 10 Jahren', r => r.res?.propV[9] ?? 0, eur)}
      {block('Jährliche EK-Rendite (IRR)', r => (r.res?.irrV ?? 0) * 100, n => pct(n))}
    </div>
  )
}

function CashflowTable({ rows }: { rows: Row[] }) {
  const years = rows[0]?.res?.yN ?? []
  return (
    <div style={{ margin: '8px 0 24px', overflowX: 'auto' }}>
      <h2 style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, margin: '0 0 6px' }}>Cashflow nach Steuern & Kreditrate</h2>
      <p style={{ fontSize: 13, color: '#666', margin: '0 0 14px', lineHeight: 1.6 }}>
        Positive Werte fließen auf dein Konto, negative bedeuten eine Zuzahlung aus eigener Tasche.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
        <thead><tr>
          <th style={{ background: '#1a1a1a', color: '#fff', padding: '9px 12px', fontSize: 13 }}>Jahr</th>
          {rows.map((r, i) => <th key={i} style={{ background: r.color, color: '#fff', padding: '9px 12px', fontSize: 13 }}>{r.item.label || r.item.project}</th>)}
        </tr></thead>
        <tbody>
          {years.map((y, yi) => (
            <tr key={y} style={{ background: yi % 2 ? '#fafafa' : '#fff' }}>
              <td style={{ padding: '8px 12px', fontWeight: 700, fontSize: 13, textAlign: 'center', borderBottom: '1px solid #f0f0f0' }}>{y}</td>
              {rows.map((r, i) => {
                const v = r.res?.cfA[yi] ?? 0
                return <td key={i} style={{ padding: '8px 12px', fontSize: 13, fontWeight: 600, textAlign: 'center', color: v < 0 ? '#d04545' : '#2b2b2b', borderBottom: '1px solid #f0f0f0' }}>{eur(v)}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SpecsTable({ rows }: { rows: Row[] }) {
  const td: CSSProperties = { padding: '9px 12px', fontSize: 13, borderBottom: '1px solid #f0f0f0', textAlign: 'right' }
  const lbl: CSSProperties = { ...td, textAlign: 'left', color: '#666' }
  const row = (label: string, fn: (r: Row) => string) => (
    <tr><td style={lbl}>{label}</td>{rows.map((r, i) => <td key={i} style={td}>{fn(r)}</td>)}</tr>
  )
  return (
    <div style={{ margin: '8px 0 24px', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
        <thead><tr>
          <th style={{ background: '#1a1a1a', padding: '10px 12px' }}></th>
          {rows.map((r, i) => <th key={i} style={{ background: r.color, color: '#fff', padding: '10px 12px', fontSize: 13 }}>{r.item.label || r.item.project}</th>)}
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
  )
}
