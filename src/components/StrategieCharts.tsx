// ── Diagramme der Kundenauswertung ───────────────────────────────────────────
// Reines SVG, keine Fremdbibliothek - wie schon bisher auf der Kundenseite.
// Regeln: eine Achse je Diagramm, dünne Marken, zurückhaltendes Raster, Legende
// bei mehreren Reihen, Direktlabels statt einer Zahl an jedem Punkt. Alle Werte
// stehen zusätzlich beim Überfahren und in den Tabellen darunter, damit nichts
// allein über Farbe kodiert ist.
import type { ReactNode } from 'react'

export const C_VALUE = '#2563eb'   // Immobilienwert
export const C_DEBT = '#ff795d'    // Schulden
export const C_EQUITY = '#1d7a4f'  // Eigenkapital
export const C_NEG = '#b45309'
const GRID = '#e8e5e0', AXIS = '#9a9a9a'

const kEur = (n: number) => Math.abs(n) >= 1_000_000
  ? (n / 1_000_000).toFixed(1).replace('.', ',') + ' Mio'
  : Math.round(n / 1000) + 'k'
const eur = (n: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' €'

export function Legend({ items }: { items: Array<{ c: string; l: string }> }) {
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

export function ChartCard({ title, sub, children, foot }: { title: string; sub?: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div style={{ background: '#fff', borderRadius: 16, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,.06)', marginBottom: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: '#2e3c47', marginBottom: 2 }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: '#777', marginBottom: 10 }}>{sub}</div>}
      {children}
      {foot}
    </div>
  )
}

interface Serie { key: string; color: string; label: string; values: number[]; dashed?: boolean }

// Mehrere Linien auf einer Achse.
export function LineChart({ years, series, height = 240, zeroLine, marker }: {
  years: number[]; series: Serie[]; height?: number
  zeroLine?: { value: number; label: string; color?: string }
  marker?: Array<{ year: number; label: string }>
}) {
  if (years.length < 2) return null
  const W = 900, H = height, padL = 62, padR = 16, padT = 14, padB = 30
  const all = series.flatMap(s => s.values).concat(zeroLine ? [zeroLine.value] : [])
  const max = Math.max(...all, 1)
  const min = Math.min(...all, 0)
  const span = (max - min) || 1
  const x = (i: number) => padL + (W - padL - padR) * (i / (years.length - 1))
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - min) / span)
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => min + span * f)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
      aria-label={series.map(s => s.label).join(', ')}>
      {ticks.map(v => (
        <g key={v}>
          <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke={GRID} strokeWidth={1} />
          <text x={padL - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={AXIS}>{kEur(v)}</text>
        </g>
      ))}
      {years.map((yr, i) => (i % Math.ceil(years.length / 8) === 0 || i === years.length - 1) && (
        <text key={yr} x={x(i)} y={H - 10} textAnchor="middle" fontSize={11} fill={AXIS}>{yr}</text>
      ))}
      {zeroLine && (
        <g>
          <line x1={padL} y1={y(zeroLine.value)} x2={W - padR} y2={y(zeroLine.value)}
            stroke={zeroLine.color ?? C_NEG} strokeWidth={1.5} strokeDasharray="5 4" />
          <text x={W - padR} y={y(zeroLine.value) - 6} textAnchor="end" fontSize={11} fill={zeroLine.color ?? C_NEG}>
            {zeroLine.label}
          </text>
        </g>
      )}
      {series.map(s => (
        <path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2.4}
          strokeLinecap="round" strokeDasharray={s.dashed ? '6 4' : undefined} />
      ))}
      {marker?.map(m => {
        const i = years.indexOf(m.year)
        if (i < 0) return null
        return (
          <g key={`${m.year}-${m.label}`}>
            <line x1={x(i)} y1={padT} x2={x(i)} y2={H - padB} stroke="#cfcac2" strokeWidth={1} strokeDasharray="3 3" />
            <text x={x(i)} y={padT + 10} textAnchor="middle" fontSize={10} fill="#8a8a8a">{m.label}</text>
          </g>
        )
      })}
      {years.map((yr, i) => (
        <g key={`h-${yr}`}>
          <title>{`${yr}: ${series.map(s => `${s.label} ${eur(s.values[i])}`).join(' · ')}`}</title>
          <rect x={x(i) - 8} y={padT} width={16} height={H - padT - padB} fill="transparent" />
        </g>
      ))}
      {series.map(s => (
        <circle key={`p-${s.key}`} cx={x(years.length - 1)} cy={y(s.values[s.values.length - 1])} r={4}
          fill={s.color} stroke="#fff" strokeWidth={2} />
      ))}
    </svg>
  )
}

// Balken je Jahr, optional mit kumulierter Linie auf derselben Achse.
export function BarChart({ years, values, cumulative, height = 220 }: {
  years: number[]; values: number[]; cumulative?: number[]; height?: number
}) {
  if (!years.length) return null
  const W = 900, H = height, padL = 62, padR = 16, padT = 14, padB = 30
  const all = values.concat(cumulative ?? [])
  const max = Math.max(...all, 0), min = Math.min(...all, 0)
  const span = (max - min) || 1
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - min) / span)
  const bw = Math.max(5, (W - padL - padR) / years.length - 6)
  const x = (i: number) => padL + (W - padL - padR) * (i / years.length) + 3
  const zero = y(0)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Cashflow je Jahr">
      {[max, (max + min) / 2, min].map((v, i) => (
        <g key={i}>
          <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke={GRID} strokeWidth={1} />
          <text x={padL - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={AXIS}>{kEur(v)}</text>
        </g>
      ))}
      <line x1={padL} y1={zero} x2={W - padR} y2={zero} stroke={AXIS} strokeWidth={1} />
      {years.map((yr, i) => {
        const v = values[i]
        const h = Math.max(2, Math.abs(y(v) - zero))
        return (
          <g key={yr}>
            <title>{`${yr}: ${eur(v)}`}</title>
            <rect x={x(i)} y={v >= 0 ? y(v) : zero} width={bw} height={h} rx={2}
              fill={v >= 0 ? C_EQUITY : C_NEG} opacity={0.85} />
            {(i % Math.ceil(years.length / 8) === 0 || i === years.length - 1) && (
              <text x={x(i) + bw / 2} y={H - 10} textAnchor="middle" fontSize={11} fill={AXIS}>{yr}</text>
            )}
          </g>
        )
      })}
      {cumulative && (
        <path d={cumulative.map((v, i) => `${i ? 'L' : 'M'}${(x(i) + bw / 2).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
          fill="none" stroke={C_VALUE} strokeWidth={2.2} strokeLinecap="round" />
      )}
    </svg>
  )
}

// Treppe: Anzahl der Wohnungen ueber die Zeit.
export function StepChart({ years, values, markers, height = 180 }: {
  years: number[]; values: number[]; markers?: Array<{ year: number; kind: 'buy' | 'sell' }>; height?: number
}) {
  if (years.length < 2) return null
  const W = 900, H = height, padL = 40, padR = 16, padT = 18, padB = 30
  const max = Math.max(...values, 1)
  const x = (i: number) => padL + (W - padL - padR) * (i / (years.length - 1))
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / (max + 0.4))
  let d = ''
  values.forEach((v, i) => {
    if (i === 0) d += `M${x(i).toFixed(1)},${y(v).toFixed(1)}`
    else d += ` L${x(i).toFixed(1)},${y(values[i - 1]).toFixed(1)} L${x(i).toFixed(1)},${y(v).toFixed(1)}`
  })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Anzahl Wohnungen über die Zeit">
      {Array.from({ length: max + 1 }, (_, n) => (
        <g key={n}>
          <line x1={padL} y1={y(n)} x2={W - padR} y2={y(n)} stroke={GRID} strokeWidth={1} />
          <text x={padL - 8} y={y(n) + 4} textAnchor="end" fontSize={11} fill={AXIS}>{n}</text>
        </g>
      ))}
      <path d={d} fill="none" stroke={C_VALUE} strokeWidth={2.6} strokeLinejoin="round" />
      {years.map((yr, i) => (i % Math.ceil(years.length / 8) === 0 || i === years.length - 1) && (
        <text key={yr} x={x(i)} y={H - 10} textAnchor="middle" fontSize={11} fill={AXIS}>{yr}</text>
      ))}
      {markers?.map(m => {
        const i = years.indexOf(m.year)
        if (i < 0) return null
        return (
          <g key={`${m.year}-${m.kind}`}>
            <title>{`${yr(m.year)}: ${m.kind === 'buy' ? 'Kauf' : 'Verkauf'}`}</title>
            <circle cx={x(i)} cy={y(values[i])} r={5} fill={m.kind === 'buy' ? C_EQUITY : C_DEBT} stroke="#fff" strokeWidth={2} />
          </g>
        )
      })}
      {years.map((year, i) => (
        <g key={`h-${year}`}>
          <title>{`${year}: ${values[i]} ${values[i] === 1 ? 'Wohnung' : 'Wohnungen'}`}</title>
          <rect x={x(i) - 8} y={padT} width={16} height={H - padT - padB} fill="transparent" />
        </g>
      ))}
    </svg>
  )
}
const yr = (n: number) => String(n)

// Wasserfall: woher das Kapital kommt und wohin es geht.
export function Waterfall({ steps, height = 260 }: {
  steps: Array<{ label: string; amount: number; kind: 'start' | 'in' | 'out' | 'end' }>; height?: number
}) {
  if (!steps.length) return null
  const W = 900, H = height, padL = 62, padR = 16, padT = 16, padB = 58
  // Laufender Saldo, das Endbalken-Element steht fuer sich.
  let run = 0
  const bars = steps.map(s => {
    if (s.kind === 'end') return { ...s, from: 0, to: s.amount }
    const from = s.kind === 'start' ? 0 : run
    run = s.kind === 'start' ? s.amount : run + s.amount
    return { ...s, from, to: run }
  })
  const max = Math.max(...bars.map(b => Math.max(b.from, b.to)), 1)
  const min = Math.min(...bars.map(b => Math.min(b.from, b.to)), 0)
  const span = (max - min) || 1
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - min) / span)
  const bw = Math.max(14, (W - padL - padR) / bars.length - 10)
  const x = (i: number) => padL + (W - padL - padR) * (i / bars.length) + 5
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Herkunft und Verwendung des Kapitals">
      {[max, (max + min) / 2, min].map((v, i) => (
        <g key={i}>
          <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke={GRID} strokeWidth={1} />
          <text x={padL - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={AXIS}>{kEur(v)}</text>
        </g>
      ))}
      {bars.map((b, i) => {
        const top = Math.min(y(b.from), y(b.to)), h = Math.max(3, Math.abs(y(b.to) - y(b.from)))
        const color = b.kind === 'out' ? C_DEBT : b.kind === 'in' ? C_EQUITY : C_VALUE
        return (
          <g key={`${b.label}-${i}`}>
            <title>{`${b.label}: ${eur(b.amount)}`}</title>
            <rect x={x(i)} y={top} width={bw} height={h} rx={2} fill={color} opacity={b.kind === 'end' ? 0.9 : 0.8} />
            <text x={x(i) + bw / 2} y={H - 34} textAnchor="end" fontSize={10} fill="#6a6a6a"
              transform={`rotate(-35 ${x(i) + bw / 2} ${H - 34})`}>{b.label}</text>
          </g>
        )
      })}
    </svg>
  )
}
