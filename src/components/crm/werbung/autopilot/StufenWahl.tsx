import { useId } from 'react'

// ── Stufen-Regler als Knopfleiste (Modus, Vorrats-Automatik) ────────────────
// Eine Reihe gleich breiter Knöpfe, die aktive Stufe gefüllt (Navy). Stufen,
// die der Nutzer nicht wählen darf (Hochstellen nur Admin), sind gesperrt und
// tragen den Grund als Tooltip. Tastatur: Tab + Enter/Leertaste je Knopf.
export interface Stufe<T extends string | number> {
  wert: T
  label: string
  /** gesperrt: Grund (Tooltip), sonst null */
  sperre?: string | null
}

export default function StufenWahl<T extends string | number>({ stufen, wert, onWahl, ariaLabel, busy = false, gefahr }: {
  stufen: Stufe<T>[]
  wert: T | null
  onWahl: (w: T) => void
  ariaLabel: string
  busy?: boolean
  /** Stufen mit roter Markierung, wenn aktiv (z.B. aus) */
  gefahr?: ReadonlySet<T>
}) {
  const id = useId()
  return (
    <div role="radiogroup" aria-label={ariaLabel} id={id} className="flex w-full overflow-hidden rounded-xl border border-gray-200 bg-white">
      {stufen.map((s, i) => {
        const aktiv = s.wert === wert
        const rot = aktiv && gefahr?.has(s.wert)
        return (
          <button
            key={String(s.wert)}
            type="button"
            role="radio"
            aria-checked={aktiv}
            disabled={busy || (!aktiv && !!s.sperre)}
            title={!aktiv && s.sperre ? s.sperre : undefined}
            onClick={() => { if (!aktiv) onWahl(s.wert) }}
            className={`min-h-[44px] flex-1 px-2 py-2 text-xs font-semibold font-body transition-colors sm:min-h-[40px] sm:text-sm
              focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-hp-navy/70
              disabled:cursor-not-allowed ${i > 0 ? 'border-l border-gray-200' : ''}
              ${aktiv ? (rot ? 'bg-red-600 text-white' : 'bg-hp-navy text-white') : s.sperre ? 'bg-gray-50 text-gray-400' : 'text-hp-navy hover:bg-hp-cream'}`}
          >
            {s.label}
          </button>
        )
      })}
    </div>
  )
}
