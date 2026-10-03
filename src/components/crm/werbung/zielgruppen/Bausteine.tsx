import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'

// ── Bausteine für Zielgruppen und Sofortformulare ────────────────────────────
// „Übersichtlicher als Meta": jeder Abschnitt beginnt mit „Das Wichtigste"
// (HP-Empfehlung vorbelegt, ein Satz Erklärung je Einstellung), darunter
// aufklappbar „Alle Einstellungen". Was Wohnen verbietet, steht grau mit Grund
// da. Vor jedem Schreiben zeigt MetaAenderungDialog, was sich bei Meta ändert.

export const EINGABE = 'hp-input w-full text-sm'
export const EINGABE_KLEIN = 'w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-200 disabled:bg-gray-50 disabled:text-gray-500'

/** Badge „Empfohlen für Happy Property" */
export function Empfohlen() {
  const { t } = useTranslation()
  return <Badge tone="success" className="shrink-0">{t('crm.werbung.zielgruppen.empfohlen', 'Empfohlen für Happy Property')}</Badge>
}

/** Abschnitt mit Titel; oben das Wichtigste, optional aufklappbar „Alle Einstellungen". */
export function Abschnitt({ titel, untertitel, children, alle, alleOffen = false, nummer }: {
  titel: string
  untertitel?: string
  children: ReactNode
  /** Inhalt von „Alle Einstellungen" (eingeklappt) */
  alle?: ReactNode
  alleOffen?: boolean
  nummer?: number
}) {
  const { t } = useTranslation()
  const [offen, setOffen] = useState(alleOffen)
  const id = useId()
  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <header className="flex items-start gap-2 border-b border-gray-100 px-4 py-3">
        {nummer != null && (
          <span aria-hidden="true" className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hp-navy text-xs font-semibold text-white">{nummer}</span>
        )}
        <div className="min-w-0">
          <h3 className="font-heading text-base text-hp-navy">{titel}</h3>
          {untertitel && <p className="text-xs text-gray-500">{untertitel}</p>}
        </div>
      </header>
      <div className="space-y-4 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{t('crm.werbung.zielgruppen.dasWichtigste', 'Das Wichtigste')}</p>
        {children}
      </div>
      {alle && (
        <div className="border-t border-gray-100">
          <button type="button" onClick={() => setOffen(o => !o)} aria-expanded={offen} aria-controls={id}
            className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-xs font-semibold text-hp-navy hover:bg-hp-cream/60">
            <span>{t('crm.werbung.zielgruppen.alleEinstellungen', 'Alle Einstellungen')}</span>
            <span aria-hidden="true" className={`transition-transform ${offen ? 'rotate-180' : ''}`}>▾</span>
          </button>
          <div id={id} hidden={!offen} className="space-y-4 px-4 pb-4 pt-1">{alle}</div>
        </div>
      )}
    </section>
  )
}

/** Eine Einstellung: Beschriftung, Badge, ein Satz Erklärung, Eingabe. gesperrt = Grund (grau, nicht änderbar). */
export function Einstellung({ label, erklaerung, empfohlen, gesperrt, children, fuer }: {
  label: string
  erklaerung?: ReactNode
  empfohlen?: boolean
  gesperrt?: string | null
  children?: ReactNode
  /** id des Eingabefelds (für das label) */
  fuer?: string
}) {
  return (
    <div className={gesperrt ? 'opacity-70' : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        {fuer
          ? <label htmlFor={fuer} className="text-sm font-semibold text-gray-800">{gesperrt ? '🔒 ' : ''}{label}</label>
          : <span className="text-sm font-semibold text-gray-800">{gesperrt ? '🔒 ' : ''}{label}</span>}
        {empfohlen && !gesperrt && <Empfohlen />}
      </div>
      {erklaerung && <p className="mt-0.5 text-xs leading-snug text-gray-500">{erklaerung}</p>}
      {gesperrt && <p className="mt-1 rounded-md bg-gray-50 px-2 py-1 text-xs leading-snug text-gray-600">{gesperrt}</p>}
      {children && <div className="mt-1.5">{children}</div>}
    </div>
  )
}

/** Hinweis-Kasten (Info, Warnung, Sperre) */
export function Hinweis({ ton = 'info', titel, children }: { ton?: 'info' | 'warnung' | 'sperre' | 'fehler'; titel?: string; children: ReactNode }) {
  const cls = ton === 'warnung'
    ? 'border-amber-200 bg-amber-50 text-amber-900'
    : ton === 'fehler'
      ? 'border-red-200 bg-red-50 text-red-800'
      : 'border-hp-navy/15 bg-hp-cream text-hp-navy'
  const icon = ton === 'sperre' ? '🔒' : ton === 'warnung' ? '⚠' : ton === 'fehler' ? '⛔' : 'ℹ'
  return (
    <div role="note" className={`flex gap-2 rounded-lg border px-3 py-2 text-xs leading-snug ${cls}`}>
      <span aria-hidden="true" className="shrink-0">{icon}</span>
      <div className="min-w-0">
        {titel && <p className="font-semibold">{titel}</p>}
        <div>{children}</div>
      </div>
    </div>
  )
}

/** Auswahl als Kacheln (Radio-Gruppe) */
export function Kacheln<V extends string>({ wert, optionen, onChange, name, spalten = 2 }: {
  wert: V
  optionen: Array<{ wert: V; titel: string; text?: string; empfohlen?: boolean; gesperrt?: string | null }>
  onChange: (v: V) => void
  name: string
  spalten?: 1 | 2 | 3
}) {
  const grid = spalten === 3 ? 'sm:grid-cols-3' : spalten === 2 ? 'sm:grid-cols-2' : ''
  return (
    <div role="radiogroup" className={`grid gap-2 ${grid}`}>
      {optionen.map(o => {
        const aktiv = o.wert === wert
        return (
          <label key={o.wert}
            className={`flex cursor-pointer gap-2 rounded-lg border px-3 py-2 text-left text-sm ${
              o.gesperrt ? 'cursor-not-allowed border-gray-200 bg-gray-50 opacity-70'
                : aktiv ? 'border-hp-navy bg-hp-cream ring-1 ring-hp-navy' : 'border-gray-200 bg-white hover:border-hp-navy/40'}`}>
            <input type="radio" name={name} value={o.wert} checked={aktiv} disabled={!!o.gesperrt}
              onChange={() => onChange(o.wert)} className="mt-1 h-4 w-4 shrink-0 text-hp-navy focus:ring-hp-navy/40" />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5 font-semibold text-gray-800">
                {o.gesperrt ? '🔒 ' : ''}{o.titel}
                {o.empfohlen && !o.gesperrt && <Empfohlen />}
              </span>
              {o.text && <span className="block text-xs leading-snug text-gray-500">{o.text}</span>}
              {o.gesperrt && <span className="block text-xs leading-snug text-gray-600">{o.gesperrt}</span>}
            </span>
          </label>
        )
      })}
    </div>
  )
}

/** Kontrollkästchen mit Erklärung */
export function Haken({ checked, onChange, label, hilfe, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hilfe?: ReactNode; disabled?: boolean
}) {
  return (
    <label className={`flex items-start gap-2 text-sm text-gray-700 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-hp-navy focus:ring-hp-navy/40" />
      <span className="min-w-0">
        {label}
        {hilfe && <span className="block text-xs leading-snug text-gray-500">{hilfe}</span>}
      </span>
    </label>
  )
}

/** Zeichenzähler unter Textfeldern */
export function Zaehler({ wert, max }: { wert: string; max: number }) {
  const n = wert.length
  return <span className={`block text-right text-[10px] tabular-nums ${n > max ? 'font-semibold text-red-600' : 'text-gray-400'}`}>{n}/{max}</span>
}

/** Sperre für Schreib-Knöpfe: Grund oder null */
export function SchreibSperre({ grund }: { grund: string | null }) {
  const { t } = useTranslation()
  if (!grund) return null
  return (
    <Hinweis ton="sperre" titel={t('crm.werbung.zielgruppen.sperre.titel', 'Anlegen bei Meta ist gerade nicht möglich')}>
      {grund}
    </Hinweis>
  )
}

export interface AenderungPunkt {
  text: string
  /** 'neu' = wird angelegt, 'gleich' = bleibt unverändert, 'achtung' = Folge beachten */
  art?: 'neu' | 'gleich' | 'achtung'
}

/** „Das ändert sich bei Meta": Zusammenfassung vor jedem Schreiben. */
export function MetaAenderungDialog({ offen, titel, punkte, lernphase, warnungen, bestaetigen, busy, gesperrt, onBestaetigen, onClose, zusatz }: {
  offen: boolean
  titel?: string
  punkte: AenderungPunkt[]
  /** Satz zur Lernphase (startet neu oder nicht) */
  lernphase: string
  warnungen?: string[]
  bestaetigen: string
  busy?: boolean
  /** Grund, warum nicht bestätigt werden kann */
  gesperrt?: string | null
  onBestaetigen: () => void
  onClose: () => void
  zusatz?: ReactNode
}) {
  const { t } = useTranslation()
  const symbol = (a: AenderungPunkt['art']) => (a === 'gleich' ? '=' : a === 'achtung' ? '!' : '+')
  const farbe = (a: AenderungPunkt['art']) => (a === 'gleich' ? 'bg-gray-100 text-gray-600' : a === 'achtung' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800')
  return (
    <Modal open={offen} onClose={busy ? () => undefined : onClose} size="md" closeOnBackdrop={!busy}
      title={titel ?? t('crm.werbung.zielgruppen.aenderung.titel', 'Das ändert sich bei Meta')}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={busy} className="hp-btn hp-btn-ghost">
            {t('crm.werbung.zielgruppen.abbrechen', 'Abbrechen')}
          </button>
          <button type="button" onClick={onBestaetigen} disabled={busy || !!gesperrt} className="hp-btn hp-btn-primary">
            {busy && <Spinner size="sm" />}
            {bestaetigen}
          </button>
        </>
      )}>
      <ul className="space-y-2">
        {punkte.map((p, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
            <span aria-hidden="true" className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${farbe(p.art)}`}>{symbol(p.art)}</span>
            <span className="min-w-0">{p.text}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 space-y-2">
        <Hinweis ton="info" titel={t('crm.werbung.zielgruppen.aenderung.lernphase', 'Lernphase')}>{lernphase}</Hinweis>
        {(warnungen ?? []).map((w, i) => <Hinweis key={i} ton="warnung">{w}</Hinweis>)}
        {gesperrt && <Hinweis ton="sperre">{gesperrt}</Hinweis>}
        {zusatz}
      </div>
    </Modal>
  )
}
