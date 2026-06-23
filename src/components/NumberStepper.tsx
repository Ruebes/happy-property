/**
 * NumberStepper — moderner Ersatz für native <input type="number"> (die kleinen
 * Browser-Pfeilchen). Großzügige +/−-Flächen (touch-tauglich), Wert ist direkt
 * tippbar (auch mit Komma), optionaler Suffix (€, %, J). Coral-Akzent, 2026-Look.
 */

interface Props {
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  suffix?: string
  className?: string
}

export function NumberStepper({ value, onChange, step = 1, min, max, suffix, className = '' }: Props) {
  // Nachkommastellen aus dem Step ableiten (0.1 → 1, 0.01 → 2), damit das Steppen
  // keine Float-Artefakte wie 6.299999 erzeugt.
  const dec = String(step).includes('.') ? String(step).split('.')[1].length : 0
  const round = (v: number) => { const f = Math.pow(10, dec); return Math.round(v * f) / f }
  const clamp = (v: number) => {
    if (min != null && v < min) return min
    if (max != null && v > max) return max
    return v
  }
  const bump = (dir: number) => onChange(clamp(round((Number.isFinite(value) ? value : 0) + dir * step)))

  const btn = 'px-3.5 flex items-center justify-center text-xl font-medium text-gray-400 ' +
    'hover:text-orange-600 hover:bg-orange-50 active:bg-orange-100 transition-colors select-none'

  return (
    <div className={`flex items-stretch h-11 rounded-xl border border-gray-200 bg-white overflow-hidden transition-all focus-within:border-orange-400 focus-within:ring-2 focus-within:ring-orange-100 ${className}`}>
      <button type="button" tabIndex={-1} aria-label="weniger" onClick={() => bump(-1)} className={btn}>−</button>
      <div className="relative flex-1 min-w-0 border-x border-gray-100">
        <input
          type="text"
          inputMode="decimal"
          value={Number.isFinite(value) ? String(value) : ''}
          onChange={e => {
            const raw = e.target.value.replace(',', '.').trim()
            if (raw === '' || raw === '-') { onChange(0); return }
            const v = parseFloat(raw)
            if (!Number.isNaN(v)) onChange(clamp(v))
          }}
          className={`w-full h-full text-center text-[15px] font-semibold text-gray-800 bg-transparent focus:outline-none tabular-nums ${suffix ? 'pr-6' : ''}`}
        />
        {suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-medium text-gray-400 pointer-events-none">{suffix}</span>}
      </div>
      <button type="button" tabIndex={-1} aria-label="mehr" onClick={() => bump(1)} className={btn}>+</button>
    </div>
  )
}
