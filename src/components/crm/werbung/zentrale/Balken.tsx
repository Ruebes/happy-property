import { CHART_COLORS } from '../format'

// ── Einfache Balkendiagramme der Aufschlüsselung ─────────────────────────────
// Gleicher Stil wie die Diagramme im Statistik-Reiter: eine Farbe je Kennzahl,
// hervorgehobene Zeile (z. B. die gewinnende Variante) in Grün.

export interface BalkenDatum { label: string; wert: number | null; text: string; hervor?: boolean }

export function BalkenWaagerecht({ daten }: { daten: BalkenDatum[] }) {
  const max = Math.max(1e-9, ...daten.map(d => d.wert ?? 0))
  return (
    <div className="space-y-2">
      {daten.map((d, i) => (
        <div key={i} title={`${d.label}: ${d.text}`}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-gray-600 truncate min-w-0">{d.label}</span>
            <span className="text-xs font-semibold text-gray-900 tabular-nums whitespace-nowrap">{d.text}</span>
          </div>
          <div className="mt-0.5 h-3.5 rounded-r bg-gray-100">
            <div className="h-full rounded-r"
              style={{
                width: `${((d.wert ?? 0) / max) * 100}%`,
                backgroundColor: d.hervor ? CHART_COLORS[2] : CHART_COLORS[0],
                minWidth: (d.wert ?? 0) > 0 ? 4 : 0,
              }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function BalkenSenkrecht({ daten }: { daten: BalkenDatum[] }) {
  const max = Math.max(1e-9, ...daten.map(d => d.wert ?? 0))
  return (
    <div>
      <div className="flex items-end gap-[3px] h-40">
        {daten.map((d, i) => (
          <div key={i} className="flex-1 min-w-0 group" title={`${d.label}: ${d.text}`}>
            <div className="rounded-t-sm w-full group-hover:opacity-80"
              style={{ height: `${Math.max(((d.wert ?? 0) / max) * 160, (d.wert ?? 0) > 0 ? 2 : 0)}px`, backgroundColor: CHART_COLORS[0] }} />
          </div>
        ))}
      </div>
      {daten.length > 0 && (
        <div className="flex justify-between text-[10px] text-gray-400 mt-1 gap-2">
          <span className="truncate">{daten[0].label}</span>
          <span className="truncate">{daten[daten.length - 1].label}</span>
        </div>
      )}
    </div>
  )
}
