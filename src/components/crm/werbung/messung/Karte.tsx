import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import Spinner from '../../../ui/Spinner'
import type { Ampel } from './typen'

// ── Karte für den Reiter „Messung & Konto" ───────────────────────────────────
// Gleiches Muster wie die Formulare (SPEC2): Titel, ein Satz in einfachem
// Deutsch, oben „Das Wichtigste", darunter aufklappbar „Alle Einstellungen".
// Rechts oben Ampel und Knöpfe (z. B. Aktualisieren).

const AMPEL_CLS: Record<Ampel, string> = {
  gruen: 'bg-emerald-500',
  gelb: 'bg-amber-500',
  rot: 'bg-red-500',
  grau: 'bg-gray-300',
}

export function AmpelPunkt({ ampel, label }: { ampel: Ampel; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-gray-700">
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${AMPEL_CLS[ampel]}`} />
      {label}
    </span>
  )
}

export default function Karte({ titel, erklaerung, ampel, aktionen, children, alle, laedt, id }: {
  titel: string
  /** ein Satz, was die Karte zeigt */
  erklaerung: string
  ampel?: { ampel: Ampel; label: string } | null
  aktionen?: ReactNode
  children: ReactNode
  /** Inhalt von „Alle Einstellungen" (eingeklappt) */
  alle?: ReactNode
  laedt?: boolean
  id?: string
}) {
  const { t } = useTranslation()
  const [offen, setOffen] = useState(false)
  const alleId = useId()
  return (
    <section id={id} className="flex min-w-0 scroll-mt-24 flex-col rounded-xl border border-gray-200 bg-white" aria-busy={laedt || undefined}>
      <header className="flex flex-col gap-2 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-start">
        <div className="min-w-0 sm:mr-auto">
          <h3 className="flex flex-wrap items-center gap-2 font-heading text-base text-hp-navy">
            {titel}
            {laedt && <Spinner size="sm" />}
          </h3>
          <p className="mt-0.5 text-xs leading-snug text-gray-500">{erklaerung}</p>
        </div>
        {(ampel || aktionen) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {ampel && <AmpelPunkt ampel={ampel.ampel} label={ampel.label} />}
            {aktionen}
          </div>
        )}
      </header>
      <div className="min-w-0 flex-1 space-y-3 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{t('crm.werbung.messung.dasWichtigste', 'Das Wichtigste')}</p>
        {children}
      </div>
      {alle && (
        <div className="border-t border-gray-100">
          <button type="button" onClick={() => setOffen(o => !o)} aria-expanded={offen} aria-controls={alleId}
            className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-xs font-semibold text-hp-navy hover:bg-hp-cream/60">
            <span>{t('crm.werbung.messung.alleEinstellungen', 'Alle Einstellungen')}</span>
            <span aria-hidden="true" className={`transition-transform ${offen ? 'rotate-180' : ''}`}>▾</span>
          </button>
          <div id={alleId} hidden={!offen} className="space-y-3 px-4 pb-4 pt-1">{alle}</div>
        </div>
      )}
    </section>
  )
}

/** Kennzahl: Wert groß, Beschriftung klein, optional ein Satz darunter */
export function Kennzahl({ label, wert, hilfe, ton }: { label: string; wert: ReactNode; hilfe?: string; ton?: 'gut' | 'warnung' | 'schlecht' }) {
  const farbe = ton === 'gut' ? 'text-emerald-700' : ton === 'warnung' ? 'text-amber-700' : ton === 'schlecht' ? 'text-red-700' : 'text-hp-navy'
  return (
    <div className="min-w-0 rounded-lg bg-hp-cream/60 px-3 py-2">
      <p className="truncate text-[11px] text-gray-500">{label}</p>
      <p className={`truncate text-lg font-semibold tabular-nums ${farbe}`}>{wert}</p>
      {hilfe && <p className="text-[11px] leading-snug text-gray-500">{hilfe}</p>}
    </div>
  )
}

/** Fehlerzeile in einer Karte mit „Nochmal laden" */
export function KartenFehler({ text, onNochmal }: { text: string; onNochmal?: () => void }) {
  const { t } = useTranslation()
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 sm:flex-row sm:items-center">
      <span className="min-w-0 break-words sm:mr-auto">{text}</span>
      {onNochmal && (
        <button type="button" onClick={onNochmal} className="hp-btn hp-btn-ghost min-h-0 shrink-0 px-3 py-1 text-xs">
          {t('crm.werbung.messung.nochmal', 'Nochmal laden')}
        </button>
      )}
    </div>
  )
}

/** Knopf „Aktualisieren" für den Kartenkopf */
export function AktualisierenKnopf({ onClick, laedt }: { onClick: () => void; laedt?: boolean }) {
  const { t } = useTranslation()
  return (
    <button type="button" onClick={onClick} disabled={laedt} className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs">
      {t('crm.werbung.messung.aktualisieren', 'Aktualisieren')}
    </button>
  )
}
