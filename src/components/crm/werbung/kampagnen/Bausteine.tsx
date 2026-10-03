import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { CustomSelect, type SelectOption } from '../../../CustomSelect'
import type { EnumOption } from '../../../../lib/metaSpec'
import { INPUT_CLS, UsdEurHinweis, parseDollar, toLocalInput } from '../felder'
import { useWerbeFormat } from '../format'
import { FeldHinweise } from './PruefPanel'
import { EmpfohlenBadge } from './bearbeitenHelfer'

// ── Formularbausteine des Kampagnen-Assistenten ──────────────────────────────
// Abschnitt mit „Das Wichtigste" oben und aufklappbaren „Alle Einstellungen",
// Feldrahmen mit Erklärsatz, Badge „Empfohlen für Happy Property" (oder
// Empfehlung zum Übernehmen) und Sperrgrund (🔒, Bearbeiten-Modus und Wohnen),
// dazu TextFeld, AuswahlFeld, GeldFeld (USD mit EUR-Hinweis), ZeitFeld, Schalter.
// data-einstellung trägt den Feldnamen für „Einstellung finden".

/** DOM-Id eines Formularfelds (Sprungziel aus der Prüfliste) */
export const feldId = (feld: string): string => `kf-${feld.replace(/[^a-zA-Z0-9]+/g, '-')}`

/** Beschriftung eines Feldes aus metaSpec (crm.werbung.meta.field.*) */
export const feldLabel = (t: TFunction, feld: string, ersatz: string): string =>
  t(`crm.werbung.meta.field.${feld.replace(/\./g, '_')}`, ersatz)

export function optionenFuer<V extends string>(t: TFunction, liste: readonly EnumOption<V>[]): SelectOption[] {
  return liste.map(o => ({
    value: o.value,
    label: t(o.labelKey, o.value),
    disabled: !!o.unsupported,
    hint: o.unsupported
      ? t('crm.werbung.builder.form.nichtImAssistenten', 'Im Assistenten nicht verfügbar')
      : o.deprecated
        ? t('crm.werbung.builder.form.abgekuendigt', 'Von Meta abgekündigt')
        : o.recommended ? t('crm.werbung.bearbeiten.empfohlen', 'Empfohlen für Happy Property') : undefined,
  }))
}

/** HP-Empfehlung eines Feldes: aktiv = der aktuelle Wert ist die Empfehlung */
export interface Empfehlung {
  aktiv: boolean
  /** Text der Empfehlung (gezeigt, wenn nicht aktiv) */
  text?: string
  /** Empfehlung übernehmen */
  uebernehmen?: () => void
}

// ── Abschnitt ────────────────────────────────────────────────────────────────

export function Abschnitt({ titel, hilfe, aktion, children, id, alle, alleOffen }: {
  titel: string
  hilfe?: ReactNode
  aktion?: ReactNode
  /** „Das Wichtigste" */
  children: ReactNode
  id?: string
  /** Inhalt von „Alle Einstellungen" (aufklappbar) */
  alle?: ReactNode
  /** „Alle Einstellungen" geöffnet anzeigen (z. B. weil dort ein Hinweis steht) */
  alleOffen?: boolean
}) {
  const { t } = useTranslation()
  const [offen, setOffen] = useState(!!alleOffen)
  useEffect(() => { if (alleOffen) setOffen(true) }, [alleOffen])
  return (
    <section id={id} className="hp-card scroll-mt-4 space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-2">
        <h3 className="mr-auto font-heading text-base text-hp-navy">{titel}</h3>
        {aktion}
      </div>
      {hilfe && <div className="-mt-1 text-[11px] leading-snug text-gray-500">{hilfe}</div>}
      {alle ? (
        <p className="text-[10px] font-semibold uppercase tracking-wide text-hp-navy/60">{t('crm.werbung.bearbeiten.wichtigste', 'Das Wichtigste')}</p>
      ) : null}
      {children}
      {alle ? (
        <details open={offen} onToggle={ev => setOffen((ev.currentTarget as HTMLDetailsElement).open)}
          className="group rounded-lg border border-gray-200 bg-gray-50/60">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-hp-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/50 [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">›</span>
            {t('crm.werbung.bearbeiten.alleEinstellungen', 'Alle Einstellungen')}
          </summary>
          <div className="space-y-3 border-t border-gray-200 bg-white px-3 py-3">{alle}</div>
        </details>
      ) : null}
    </section>
  )
}

// ── Feldrahmen ───────────────────────────────────────────────────────────────

export interface Basis {
  node: string
  feld: string
  /** weitere FieldSpec-Keys, deren Meldungen hier erscheinen */
  auch?: readonly string[]
  label: string
  /** Ein Satz Erklärung in einfachem Deutsch */
  hilfe?: string
  disabled?: boolean
  /** Sperrgrund: Feld ist gesperrt, der Grund steht darunter */
  sperre?: string
  empfehlung?: Empfehlung
}

export function FeldRahmen({ node, feld, auch, label, hilfe, sperre, empfehlung, disabled, children }: Basis & { children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div id={feldId(feld)} data-einstellung={label} className="scroll-mt-24">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-gray-500">{sperre ? '🔒 ' : ''}{label}</span>
        {empfehlung?.aktiv && <EmpfohlenBadge />}
      </div>
      {children}
      {hilfe && <span className="mt-0.5 block text-[10px] leading-snug text-gray-500">{hilfe}</span>}
      {sperre && <span className="mt-0.5 block text-[10px] leading-snug text-hp-navy/80">{sperre}</span>}
      {empfehlung && !empfehlung.aktiv && empfehlung.text && !sperre && (
        <span className="mt-0.5 block text-[10px] leading-snug text-gray-500">
          {t('crm.werbung.bearbeiten.hpEmpfehlung', 'Empfehlung für Happy Property: {{text}}', { text: empfehlung.text })}
          {empfehlung.uebernehmen && !disabled && (
            <button type="button" onClick={empfehlung.uebernehmen} className="ml-1 font-semibold text-hp-navy underline">
              {t('crm.werbung.bearbeiten.uebernehmen', 'Übernehmen')}
            </button>
          )}
        </span>
      )}
      <FeldHinweise node={node} felder={[feld, ...(auch ?? [])]} />
    </div>
  )
}

export function TextFeld({ value, onChange, onBlur, maxLen, zaehler, mehrzeilig, placeholder, ...b }: Basis & {
  value: string
  onChange: (v: string) => void
  /** beim Verlassen des Felds (z. B. Telefonnummer vereinheitlichen) */
  onBlur?: () => void
  maxLen?: number
  /** Zähler „n / zaehler" (HP-Grenze, z. B. Überschrift 40) */
  zaehler?: number
  mehrzeilig?: boolean
  placeholder?: string
}) {
  const aus = !!b.disabled || !!b.sperre
  const zu = zaehler !== undefined && value.trim().length > zaehler
  return (
    <FeldRahmen {...b}>
      {mehrzeilig ? (
        <textarea value={value} disabled={aus} maxLength={maxLen} placeholder={placeholder} rows={4} aria-label={b.label}
          onChange={e => onChange(e.target.value)} onBlur={onBlur} className={`${INPUT_CLS} resize-y`} />
      ) : (
        <input value={value} disabled={aus} maxLength={maxLen} placeholder={placeholder} aria-label={b.label}
          onChange={e => onChange(e.target.value)} onBlur={onBlur} className={INPUT_CLS} />
      )}
      {zaehler !== undefined && (
        <span className={`mt-0.5 block text-right text-[10px] tabular-nums ${zu ? 'font-semibold text-red-600' : 'text-gray-400'}`}>
          {value.trim().length} / {zaehler}
        </span>
      )}
    </FeldRahmen>
  )
}

export function AuswahlFeld<V extends string>({ value, optionen, onChange, leer, ...b }: Basis & {
  value: V | undefined
  optionen: readonly EnumOption<V>[]
  onChange: (v: V | undefined) => void
  /** Text der Leer-Option (nur wenn das Feld leer bleiben darf) */
  leer?: string
}) {
  const { t } = useTranslation()
  const opts = optionenFuer(t, optionen)
  const alle = leer ? [{ value: '', label: leer }, ...opts] : opts
  return (
    <FeldRahmen {...b}>
      <div className="mt-0.5">
        <CustomSelect value={value ?? ''} disabled={!!b.disabled || !!b.sperre} options={alle}
          onChange={v => onChange(v ? optionen.find(o => o.value === v)?.value : undefined)} />
      </div>
    </FeldRahmen>
  )
}

/** Betrag in USD (Kontowährung, Cent auf dem Draht) mit EUR-Gegenwert daneben */
export function GeldFeld({ cents, onChange, kurs, entfernbar, ...b }: Basis & {
  cents: number | undefined
  onChange: (c: number | undefined) => void
  kurs: number
  /** Knopf „Entfernen" (z. B. Ausgabenlimit aufheben) */
  entfernbar?: string
}) {
  const fmt = useWerbeFormat()
  const aus = !!b.disabled || !!b.sperre
  const zeige = (c: number | undefined) => (c && c > 0 ? (c / 100).toLocaleString(fmt.locale, { maximumFractionDigits: 2, useGrouping: false }) : '')
  const [txt, setTxt] = useState(() => zeige(cents))
  // Von außen geändert (z. B. Budgets synchron): Anzeige nachziehen
  useEffect(() => {
    const p = parseDollar(txt)
    const lokal = p != null && p > 0 ? Math.round(p * 100) : undefined
    const aussen = cents && cents > 0 ? cents : undefined
    if (lokal !== aussen) setTxt(zeige(cents))
    // nur auf Änderungen von außen reagieren
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents])
  return (
    <FeldRahmen {...b}>
      <div className="mt-0.5 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">$</span>
          <input inputMode="decimal" value={txt} disabled={aus} aria-label={b.label}
            onChange={e => {
              setTxt(e.target.value)
              const p = parseDollar(e.target.value)
              onChange(p != null && p > 0 ? Math.round(p * 100) : undefined)
            }}
            className={`${INPUT_CLS} mt-0 pl-5 tabular-nums`} />
        </div>
        {entfernbar && !aus && (cents ?? 0) > 0 && (
          <button type="button" onClick={() => { setTxt(''); onChange(undefined) }}
            className="shrink-0 rounded px-2 py-1 text-[11px] font-semibold text-hp-navy hover:bg-gray-100">{entfernbar}</button>
        )}
      </div>
      <UsdEurHinweis usd={txt} kurs={kurs} />
    </FeldRahmen>
  )
}

export function ZeitFeld({ value, onChange, ...b }: Basis & { value: string | undefined; onChange: (iso: string | undefined) => void }) {
  return (
    <FeldRahmen {...b}>
      <input type="datetime-local" value={toLocalInput(value)} disabled={!!b.disabled || !!b.sperre} aria-label={b.label}
        onChange={e => {
          const v = e.target.value
          const d = v ? new Date(v) : null
          onChange(d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined)
        }}
        className={INPUT_CLS} />
    </FeldRahmen>
  )
}

export function Schalter({ checked, onChange, label, hilfe, disabled, sperre, empfohlen }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hilfe?: string; disabled?: boolean
  /** Sperrgrund (grau mit 🔒 und Grund) */
  sperre?: string
  /** aktueller Zustand ist die HP-Empfehlung */
  empfohlen?: boolean
}) {
  const aus = !!disabled || !!sperre
  return (
    <label data-einstellung={label} className={`flex items-start gap-2 text-xs text-gray-700 ${aus ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={aus} onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-hp-navy focus:ring-hp-navy/40" />
      <span>
        <span className="inline-flex flex-wrap items-center gap-1.5">{sperre ? '🔒 ' : ''}{label}{empfohlen && <EmpfohlenBadge />}</span>
        {hilfe && <span className="block text-[10px] leading-snug text-gray-500">{hilfe}</span>}
        {sperre && <span className="block text-[10px] leading-snug text-hp-navy/80">{sperre}</span>}
      </span>
    </label>
  )
}

/** Sperr-Hinweis der Sonderkategorie Wohnen */
export function SperrBanner({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="flex gap-2 rounded-lg border border-hp-navy/15 bg-hp-cream px-3 py-2 text-[11px] leading-snug text-hp-navy">
      <span aria-hidden="true">🔒</span>
      <div>{children}</div>
    </div>
  )
}

/** Gesperrte Einstellung, grau mit Grund (statt sie zu verstecken) */
export function GesperrteEinstellung({ label, grund, wert }: { label: string; grund: string; wert?: string }) {
  return (
    <div data-einstellung={label} className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-2.5 py-1.5 opacity-80">
      <p className="text-[11px] text-gray-500">🔒 {label}{wert ? <span className="ml-1 text-gray-700">{wert}</span> : null}</p>
      <p className="text-[10px] leading-snug text-gray-500">{grund}</p>
    </div>
  )
}

/** Status Aktiv/Pausiert (Bearbeiten-Modus) */
export function StatusFeld({ node, feld, value, onChange, disabled, hilfe }: {
  node: string; feld: string; value: string | undefined; onChange: (v: 'ACTIVE' | 'PAUSED') => void; disabled?: boolean; hilfe?: string
}) {
  const { t } = useTranslation()
  const label = t('crm.werbung.bearbeiten.statusLabel', 'Status')
  const optionen: Array<['ACTIVE' | 'PAUSED', string]> = [
    ['ACTIVE', t('crm.werbung.bearbeiten.status.ACTIVE', 'Aktiv')],
    ['PAUSED', t('crm.werbung.bearbeiten.status.PAUSED', 'Pausiert')],
  ]
  return (
    <FeldRahmen node={node} feld={feld} label={label} disabled={disabled}
      hilfe={hilfe ?? t('crm.werbung.bearbeiten.hilfe.status', 'Aktiv: Meta liefert aus und es entstehen Kosten. Pausiert: keine Auslieferung, alle Einstellungen bleiben.')}>
      <div role="radiogroup" aria-label={label} className="mt-0.5 inline-flex overflow-hidden rounded-lg border border-gray-200">
        {optionen.map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled} onClick={() => onChange(v)}
            className={`px-3 py-1.5 text-xs ${value === v ? (v === 'ACTIVE' ? 'bg-emerald-600 text-white' : 'bg-hp-navy text-white') : 'bg-white text-gray-700 hover:bg-gray-50'} disabled:opacity-60`}>
            {l}
          </button>
        ))}
      </div>
      {!value && <span className="ml-2 text-[10px] text-gray-400">{t('crm.werbung.bearbeiten.statusUnbekannt', 'Status unbekannt')}</span>}
    </FeldRahmen>
  )
}

/** Auswahl aus festen Werten als Liste (Radio), z. B. Budgetart */
export function RadioReihe<V extends string>({ name, value, optionen, onChange, disabled, label }: {
  name: string; value: V; optionen: ReadonlyArray<[V, string]>; onChange: (v: V) => void; disabled?: boolean; label: string
}) {
  return (
    <div className="flex flex-wrap gap-3 text-xs" role="radiogroup" aria-label={label}>
      {optionen.map(([v, l]) => (
        <label key={v} className="flex items-center gap-1.5">
          <input type="radio" name={name} checked={value === v} disabled={disabled} onChange={() => onChange(v)} />
          {l}
        </label>
      ))}
    </div>
  )
}
