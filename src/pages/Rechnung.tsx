import { useEffect, useMemo, useState, type ReactNode, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { compute, type CalcContent, type CalcItem, type CalcResult } from '../lib/rechner'
import { DECK_LOGO } from '../lib/deckTypes'

// ── Öffentliche Rendite-Rechnung / Immobilienvergleich (HTML-Microsite) ───────
// /rechnung/:token — Einzelobjekt = detaillierte Auswertung (8 Abschnitte, exakt
// nach dem Original-Rechner-Export), oder Vergleich mehrerer Objekte. Rechnet live
// aus den gespeicherten Parametern mit der verifizierten Engine.

const CORAL = '#ff795d', DARK = '#2e3c47', GREEN = '#2d8a5e', RED = '#c03030'
const BLUE = '#2563eb', RENTG = '#10b981', PURPLE = '#7c3aed'
const PALETTE = ['#2f6b4f', '#226f8f', '#ff795d', '#7a5a9e', '#b8860b']
const SERIF = "'Playfair Display',Georgia,serif"
const SANS = "'Montserrat','Helvetica Neue',Arial,sans-serif"

const eur = (n: number | null | undefined) => n == null || isNaN(n) ? '–'
  : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(n))
const pct = (n: number | null | undefined, d = 1) => n == null || isNaN(n) ? '–'
  : new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n) + ' %'
const short = (v: number) => v >= 1e6 ? (v / 1e6).toFixed(2).replace('.', ',') + ' M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : Math.round(v).toString()

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
  const today = new Date().toLocaleDateString('de-DE')
  const projLabel = rows[0]?.item.label || rows[0]?.item.project || ''

  return (
    <div style={{ background: '#f4f3f1', minHeight: '100vh', fontFamily: SANS, color: '#1a1a1a' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 22px 64px' }}>
        {/* Kopf wie im Original-Export */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
          <img src={DECK_LOGO} alt="Happy Property Cyprus" style={{ height: 46, width: 'auto', borderRadius: 8, flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 800, color: DARK, lineHeight: 1.1 }}>
              {isCompare ? 'Immobilienvergleich' : 'Rendite & Cashflow – Übersicht'}
            </div>
            <div style={{ fontSize: 12.5, color: '#666', marginTop: 2 }}>
              {name && <>Kunde: <b>{name}</b></>}{name && projLabel ? ' · ' : ''}{projLabel && <>Projekt: <b>{projLabel}</b></>}
            </div>
            <div style={{ fontSize: 11, color: '#aaa' }}>Generiert am {today}</div>
          </div>
        </div>
        <div style={{ height: 3, background: `linear-gradient(90deg,${CORAL},#ffb89d)`, borderRadius: 2, marginBottom: 22 }} />

        {content.intro && <p style={{ fontSize: 14.5, lineHeight: 1.7, color: '#444', whiteSpace: 'pre-wrap', margin: '0 0 24px', maxWidth: 760 }}>{content.intro}</p>}

        {/* ── EINZEL-ANSICHT: detaillierte Auswertung ─────────────── */}
        {!isCompare && withCalc && rows[0]?.res && <Single row={rows[0]} today={today} />}

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

        {!withCalc && <SpecsCard rows={rows} />}

        <p style={{ fontSize: 10.5, color: '#aaa', marginTop: 36, lineHeight: 1.6 }}>
          <b>Haftungsausschluss:</b> Unverbindliche Information, keine steuerliche/rechtliche/finanzielle Beratung. Alle Angaben ohne Gewähr. IRR = interne Kapitalrendite auf das eingesetzte Eigenkapital (jährlich). Stand: {today}.
        </p>
      </div>
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontFamily: SANS, background: '#f4f3f1' }}>{children}</div>
}

const Card = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.05)', padding: 22, ...style }}>{children}</div>
)
const H2 = ({ children }: { children: ReactNode }) => (
  <h2 style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: DARK, margin: '0 0 12px', borderBottom: '2px solid #f0e8d8', paddingBottom: 6 }}>{children}</h2>
)
const Note = ({ children }: { children: ReactNode }) => (
  <div style={{ fontSize: 12, color: '#666', lineHeight: 1.55, background: '#f5f2ec', borderRadius: 8, padding: '10px 13px', marginTop: 14, borderLeft: `3px solid ${CORAL}` }}>{children}</div>
)
function KV({ k, v, color }: { k: ReactNode; v: ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid #eee', padding: '7px 0', fontSize: 13 }}>
      <span style={{ color: '#888' }}>{k}</span>
      <span style={{ fontWeight: 700, color: color || '#1a1a1a', textAlign: 'right' }}>{v}</span>
    </div>
  )
}

// ── Detaillierte Einzel-Auswertung (8 Abschnitte, exakt nach Original) ────────
function Single({ row }: { row: Row; today: string }) {
  const r = row.res!
  const p = row.item.params!
  const yl = (i: number) => i === 0 ? `${r.yN[0]} (${r.mF} Mon.)` : String(r.yN[i])
  // abgeleitete Reihen (Formeln 1:1 aus dem Original-Export)
  const cumRent: number[] = []; { let a = 0; r.rents.forEach(x => { a += x; cumRent.push(a) }) }
  const ekYear = r.propV.map((v, i) => v - r.restL[i])
  const gesamtkap = r.propV.map((v, i) => v - r.restL[i] + cumRent[i])
  const mietrend = r.rents.map(x => x / r.pNet * 100)
  const gesamtrend = r.rents.map((x, i) => { const rA = x * 0.81; const ap = r.propV[i] - (i === 0 ? r.pGross : r.propV[i - 1]); return (rA + ap) / r.pNet * 100 })
  const td: CSSProperties = { padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid #eee', fontSize: 12.5, whiteSpace: 'nowrap' }
  const th: CSSProperties = { background: DARK, color: '#fff', padding: '8px 10px', textAlign: 'right', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 700, whiteSpace: 'nowrap' }

  return (
    <>
      {/* 1. Übersicht: Investitionsdaten + Summen & Kennzahlen */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card>
          <H2>Investitionsdaten</H2>
          {p.discountPct > 0 ? (<>
            <KV k="Listenpreis netto" v={eur(r.pNetList)} />
            <KV k={`Rabatt ${pct(r.discountPct)}`} v={`−${eur(r.discountAmt)}`} color={GREEN} />
            <KV k="Kaufpreis netto (nach Rabatt)" v={eur(r.pNet)} />
          </>) : <KV k="Kaufpreis netto" v={eur(r.pNet)} />}
          <KV k="Umsatzsteuer (19%)" v={eur(r.vatAmt)} />
          <KV k="Kaufpreis brutto" v={eur(r.pGross)} />
          <KV k="Anwaltskosten (1%)" v={eur(r.costs)} />
          <KV k="Eigenkapital (Start)" v={eur(r.ekStart)} />
          <KV k="Fremdfinanzierung" v={eur(r.loan)} />
          <KV k="Schlafzimmer" v={String(r.bedrooms)} />
          {r.furnCost > 0 && <KV k="Einrichtungspaket" v={r.furnFree ? 'inklusive' : eur(r.furnCost)} color={r.furnFree ? GREEN : CORAL} />}
        </Card>
        <Card>
          <H2>Summen & Kennzahlen (10 Jahre)</H2>
          <KV k="Bruttomiete gesamt" v={eur(r.sumR)} color={CORAL} />
          <KV k="Kosten gesamt" v={eur(r.sumC)} />
          <KV k="Steuern gesamt" v={eur(r.sumT)} />
          <KV k="Ertrag nach Steuern" v={eur(r.sumCF)} />
          <KV k="Immobilienwert J10" v={eur(r.propV[9])} color={CORAL} />
          <KV k="EK Ende J10" v={eur(r.ek10)} color={GREEN} />
          <KV k="Gesamtertrag" v={eur(r.totRet)} color={GREEN} />
          <KV k="EK-Rendite kum. (10J)" v={pct(r.roe10)} color={CORAL} />
          <KV k="EK-IRR (jährlich)" v={pct(r.irrV * 100, 2)} color={CORAL} />
        </Card>
      </div>

      {/* 2. Annahmen & Parameter */}
      <Card style={{ marginTop: 18 }}>
        <H2>Annahmen & Parameter</H2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 26px' }}>
          <div>
            <KV k="Finanzierung" v={r.fin === 'yes' ? 'finanziert' : 'Barkauf'} />
            <KV k="Steuersitz" v={r.resCY ? 'Zypern' : 'Deutschland'} />
            <KV k="Kaufpreis brutto" v={eur(r.pGross)} />
            <KV k="Eigenkapital (Start)" v={eur(r.ekStart)} />
            <KV k="Schlafzimmer" v={String(r.bedrooms)} />
            <KV k="Bruttorendite J1" v={pct(r.yPct) + (r.discountPct > 0 ? ` → ${pct(r.effYield)}` : '')} />
            <KV k={r.letT === 'short' ? 'Ferienverwaltung & Buchungsprovision' : 'Laufende Kosten'}
              v={`${pct(r.mgP)} (+2% p.a.)${r.letT === 'short' && r.hotelConcept ? ' · 🏨 Hotelkonzept' : ''}`} />
            <KV k="Laufzeit Kredit" v={`${r.termY} Jahre`} />
            <KV k="AfA (DE)" v="5% degr. auf 80% brutto" />
          </div>
          <div>
            <KV k="Vermietungsart" v={r.letT === 'short' ? 'Kurzzeit (USt.-Erstattung ~24 Mon.)' : 'Langzeit'} />
            <KV k="Schlüsselübergabe" v={`${String(r.km).padStart(2, '0')}/${r.ky} – J1: ${r.mF} Mon.`} />
            <KV k="Umsatzsteuer (19%)" v={eur(r.vatAmt)} />
            <KV k="Anwaltskosten (1%)" v={eur(r.costs)} />
            <KV k="Fremdfinanzierung" v={eur(r.loan)} />
            <KV k="Mietsteigerung p.a." v={pct(r.rG)} />
            <KV k="Zinssatz" v={pct(r.iP)} />
            <KV k="Wertsteigerung p.a." v={pct(r.appP)} />
            <KV k="AfA (CY)" v="3% lin. auf 80% brutto" />
          </div>
        </div>
      </Card>

      {/* 3. Tabelle A – Cashflow */}
      <H2Section>Tabelle A – Cashflow (10 Jahre)</H2Section>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead><tr>
              <th style={{ ...th, textAlign: 'left' }}>Jahr</th><th style={th}>Bruttomiete</th>
              <th style={th}>{r.letT === 'short' ? 'Ferienverw.' : 'Laufend'}</th><th style={th}>Zinsen</th>
              <th style={th}>Tilgung</th><th style={th}>Kreditrate</th><th style={th}>USt.-Erst.</th><th style={th}>Steuer</th><th style={th}>CF netto</th>
            </tr></thead>
            <tbody>
              {r.yN.map((_, i) => {
                const tx = r.resCY ? r.taxCY[i] : r.taxDE[i]
                const cfN = r.cfA[i] - (r.vatA[i] || 0)
                return (
                  <tr key={i} style={{ background: i % 2 ? '#fafaf8' : '#fff' }}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{yl(i)}</td>
                    <td style={td}>{eur(r.rents[i])}</td><td style={td}>{eur(r.mgmt[i])}</td>
                    <td style={td}>{eur(r.intC[i])}</td><td style={td}>{eur(r.princC[i])}</td><td style={td}>{eur(r.rateC[i])}</td>
                    <td style={{ ...td, color: GREEN, fontWeight: 700 }}>{r.vatA[i] > 0 ? eur(r.vatA[i]) : '–'}</td>
                    <td style={{ ...td, color: tx < 0 ? GREEN : '#1a1a1a', fontWeight: tx < 0 ? 700 : 400 }}>{tx < 0 ? eur(-tx) : eur(tx)}</td>
                    <td style={{ ...td, color: cfN >= 0 ? GREEN : RED, fontWeight: 700 }}>{eur(cfN)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {r.letT === 'short' && r.hotelConcept && <Note>🏨 <b>Hotelkonzept:</b> Verwaltung übernimmt komplettes Hotelservice inkl. Reinigung, Check-in, Marketing & 24/7 Gästebetreuung.</Note>}
      <Note>Der Cashflow zeigt die tatsächlichen Einnahmen nach allen Kosten, Kreditraten und Steuern. Positive Werte bedeuten Überschuss aus der Immobilie. Die einmalige USt.-Erstattung ist separat ausgewiesen.</Note>

      {/* 4. Tabelle B – Darlehen / EK / Werte */}
      <H2Section>Tabelle B – Darlehen / EK / Werte (10 Jahre)</H2Section>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
            <thead><tr>
              <th style={{ ...th, textAlign: 'left' }}>Jahr</th><th style={th}>Tilgung</th><th style={th}>Sondertilg.</th>
              <th style={th}>Restschuld</th><th style={th}>Immobilienwert</th><th style={th}>Eigenkapital</th>
            </tr></thead>
            <tbody>
              {r.yN.map((_, j) => (
                <tr key={j} style={{ background: j % 2 ? '#fafaf8' : '#fff' }}>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{yl(j)}</td>
                  <td style={td}>{eur(r.princC[j])}</td><td style={td}>{r.prepayC[j] > 0 ? eur(r.prepayC[j]) : '0 €'}</td>
                  <td style={td}>{eur(r.restL[j])}</td>
                  <td style={{ ...td, color: CORAL, fontWeight: 700 }}>{eur(r.propV[j])}</td>
                  <td style={{ ...td, color: GREEN, fontWeight: 700 }}>{eur(ekYear[j])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Note>Das Eigenkapital ergibt sich aus Immobilienwert minus Restschuld. Durch Wertsteigerung und Tilgung wächst das EK erheblich über die Zeit.</Note>

      {/* 5. Chart EK-Entwicklung */}
      <H2Section>Entwicklung des Eigenkapitals (Wert − Restschuld)</H2Section>
      <Card><BarChart labels={r.yN} series={[{ data: ekYear, color: BLUE }]} /></Card>
      <div style={{ fontSize: 13, color: '#555', marginTop: 8 }}>Nach 10 Jahren beträgt das Eigenkapital: <b>{eur(r.ek10)}</b> (Wert {eur(r.propV[9])} − Restschuld {eur(r.restL[9])})</div>

      {/* 6. Chart Mieteinnahmen & Gesamtkapital */}
      <H2Section>Mieteinnahmen & Gesamtkapital (10 Jahre)</H2Section>
      <Card>
        <Legend items={[['Jahresmiete', RENTG], ['Kumulierte Miete', BLUE], ['Gesamtkapital', PURPLE]]} />
        <BarChart labels={r.yN} series={[{ data: r.rents, color: RENTG }, { data: cumRent, color: BLUE }, { data: gesamtkap, color: PURPLE }]} />
      </Card>
      <div style={{ fontSize: 13, color: '#555', marginTop: 8 }}>Kumulierte Miete über 10 Jahre: <b>{eur(cumRent[9])}</b> · Gesamtkapital Ende J10: <b>{eur(r.ek10 + cumRent[9])}</b></div>

      {/* 7. Chart Mietrendite % */}
      <H2Section>Mietrendite (%) – Basis: Nettokaufpreis</H2Section>
      <Card><BarChart labels={r.yN} series={[{ data: mietrend, color: BLUE }]} pct /></Card>
      <div style={{ fontSize: 13, color: '#555', marginTop: 8 }}>Mietrendite J1: <b>{pct(mietrend[0])}</b> · Mietrendite J10: <b>{pct(mietrend[9])}</b></div>

      {/* 8. Chart Gesamtrendite % */}
      <H2Section>Rendite (%) – Miete + nicht realisierte Wertsteigerung</H2Section>
      <Card><BarChart labels={r.yN} series={[{ data: gesamtrend, color: PURPLE }]} pct /></Card>
      <div style={{ fontSize: 13, color: '#555', marginTop: 8 }}>Gesamtrendite J1: <b>{pct(gesamtrend[0])}</b> · Gesamtrendite J10: <b>{pct(gesamtrend[9])}</b></div>
    </>
  )
}

const H2Section = ({ children }: { children: ReactNode }) => (
  <h2 style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 700, color: DARK, margin: '32px 0 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
    <span style={{ width: 6, height: 22, background: CORAL, borderRadius: 3, display: 'inline-block' }} />{children}
  </h2>
)

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 8, fontSize: 12, color: '#555' }}>
      {items.map(([label, c]) => <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 11, height: 11, background: c, borderRadius: 2 }} />{label}</span>)}
    </div>
  )
}

// ── SVG-Balkendiagramm (eine oder mehrere Reihen) ─────────────────────────────
function BarChart({ labels, series, pct: isPct }: { labels: (string | number)[]; series: { data: number[]; color: string }[]; pct?: boolean }) {
  const W = 960, H = 300, pL = 8, pR = 8, pT = 26, pB = 26
  const plotW = W - pL - pR, plotH = H - pT - pB
  const n = labels.length
  const max = Math.max(...series.flatMap(s => s.data).map(Math.abs), 1)
  const step = plotW / n
  const groups = series.length
  const bw = step * (groups > 1 ? 0.22 : 0.52)
  const totalBarW = bw * groups
  const fmt = (v: number) => isPct ? v.toFixed(1).replace('.', ',') + '%' : short(v)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {[0, 1, 2, 3, 4].map(g => { const y = pT + plotH * g / 4; return <line key={g} x1={pL} y1={y} x2={W - pR} y2={y} stroke="#eee" strokeWidth={1} /> })}
      {labels.map((lab, i) => {
        const xBase = pL + i * step + (step - totalBarW) / 2
        return (
          <g key={i}>
            {series.map((s, di) => {
              const v = s.data[i]
              const bh = Math.max(2, Math.abs(v) / max * plotH)
              const x = xBase + di * bw
              const y = pT + plotH - bh
              return (
                <g key={di}>
                  <rect x={x} y={y} width={Math.max(2, bw - 2)} height={bh} rx={2} fill={s.color} />
                  <text x={x + (bw - 2) / 2} y={y - 4} textAnchor="middle" fontSize={groups > 1 ? 9 : 11} fontWeight={700} fill="#444">{fmt(v)}</text>
                </g>
              )
            })}
            <text x={pL + i * step + step / 2} y={H - 7} textAnchor="middle" fontSize={11} fill="#888">{lab}</text>
          </g>
        )
      })}
    </svg>
  )
}

// ── Vergleich (mehrere Objekte) ───────────────────────────────────────────────
function CompareCards({ rows, withCalc }: { rows: Row[]; withCalc: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(rows.length, 3)},1fr)`, gap: 16 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ background: r.color, color: '#fff', borderRadius: 16, padding: 22, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}>
          <div style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 700, marginBottom: 4 }}>{r.item.label || r.item.project}</div>
          <div style={{ fontSize: 12.5, opacity: 0.9, marginBottom: 14 }}>
            {[r.item.bedrooms != null ? `${r.item.bedrooms}-Schlafzimmer` : '', r.item.size_sqm != null ? `${r.item.size_sqm} m²` : ''].filter(Boolean).join(' · ')}
          </div>
          {r.item.tagline && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>{r.item.tagline}</div>}
          {r.res && withCalc ? (<>
            <div style={{ fontSize: 12.5, opacity: 0.9 }}>EK {eur(r.res.ekStart)} · Kredit {eur(r.res.loan)}</div>
            <div style={{ fontFamily: SERIF, fontSize: 32, fontWeight: 800, margin: '10px 0 2px' }}>{pct(r.res.irrV * 100, 2)}</div>
            <div style={{ fontSize: 12.5, opacity: 0.9, marginBottom: 12 }}>Rendite p.a. (IRR)</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderTop: '1px solid rgba(255,255,255,0.25)', paddingTop: 10 }}>
              <span style={{ opacity: 0.9 }}>EK in 10 J.</span><strong>{eur(r.res.ek10)}</strong>
            </div>
          </>) : (
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
    <tr><td style={lbl}>{label}</td>{rows.map((r, i) => <td key={i} style={{ ...td, fontWeight: bold?.[i] ? 800 : 500, color: bold?.[i] ? r.color : '#1a1a1a' }}>{fn(r)}</td>)}</tr>
  )
  const sect = (txt: string) => <tr><td colSpan={rows.length + 1} style={{ padding: 0 }}><div style={{ background: '#fbe9e3', color: '#c2410c', fontWeight: 700, fontSize: 11.5, letterSpacing: 0.5, padding: '8px 14px' }}>{txt}</div></td></tr>
  return (
    <>
      <H2Section>Der Vergleich</H2Section>
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
              {row('Wertsteigerung p.a.', r => pct(r.res?.appP ?? null))}
              {row('Bruttorendite', r => pct(r.res?.yPct ?? null))}
              {sect('FINANZIERUNG')}
              {row('Kaufpreis brutto', r => eur(r.res?.pGross))}
              {row('Eigenkapital + NK', r => eur(r.res?.ekStart))}
              {row('Finanzierung', r => r.res && r.res.loan > 0 ? eur(r.res.loan) : 'Cash')}
              {row('Cashflow Jahr 1', r => eur(r.res ? r.res.cfA[0] - (r.res.vatA[0] || 0) : null))}
              {sect('NACH 10 JAHREN')}
              {row('Gesamtertrag', r => eur(r.res?.totRet))}
              {row('Immobilienwert', r => eur(r.res?.propV[9]))}
              {row('Restschuld', r => eur(r.res?.restL[9]))}
              {row('Eigenkapital', r => eur(r.res?.ek10), ekBest)}
              {row('Rendite p.a. (IRR)', r => pct((r.res?.irrV ?? 0) * 100, 2), irrBest)}
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
      <H2Section>Rendite & Wertentwicklung</H2Section>
      <Card>
        {block('Eigenkapital nach 10 Jahren', r => r.res?.ek10 ?? 0, eur)}
        {block('Immobilienwert nach 10 Jahren', r => r.res?.propV[9] ?? 0, eur)}
        {block('Jährliche Rendite (IRR)', r => (r.res?.irrV ?? 0) * 100, n => pct(n, 2))}
      </Card>
    </>
  )
}

function CashflowTable({ rows }: { rows: Row[] }) {
  const years = rows[0]?.res?.yN ?? []
  return (
    <>
      <H2Section>Cashflow nach Steuern & Kreditrate</H2Section>
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
                    const v = r.res ? r.res.cfA[yi] - (r.res.vatA[yi] || 0) : 0
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
