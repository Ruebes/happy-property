import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import { BTN_KLEIN } from '../felder'
import { neueId } from './ansichten'
import { FORMEL_FEHLER_TEXT, parseFormel } from './formel'
import {
  EIGEN_PREFIX, FORMEL_SPALTEN, SPALTE, SPALTEN, SPALTEN_GRUPPEN, type EigeneKennzahl,
} from './spalten'

// ── Spalten anpassen + eigene Kennzahlen ─────────────────────────────────────
// Wie bei Meta: Spalten nach Kategorien an-/abwählen, Reihenfolge ändern, eigene
// Kennzahl als Formel über vorhandene Spalten anlegen (z. B. ausgaben / termine).
// Gespeichert wird beim Übernehmen (nur in diesem Browser).

const MAX_SPALTEN = 25

interface Props {
  offen: boolean
  spalten: string[]
  kennzahlen: EigeneKennzahl[]
  crmSichtbar: boolean
  onClose: () => void
  onUebernehmen: (spalten: string[], kennzahlen: EigeneKennzahl[]) => void
}

export default function SpaltenDialog({ offen, spalten, kennzahlen, crmSichtbar, onClose, onUebernehmen }: Props) {
  const { t } = useTranslation()
  const [auswahl, setAuswahl] = useState<string[]>(spalten)
  const [eigene, setEigene] = useState<EigeneKennzahl[]>(kennzahlen)
  const [name, setName] = useState('')
  const [formel, setFormel] = useState('')
  const [format, setFormat] = useState<EigeneKennzahl['format']>('eur')

  // Beim Öffnen den aktuellen Stand übernehmen
  useEffect(() => {
    if (!offen) return
    setAuswahl(spalten); setEigene(kennzahlen); setName(''); setFormel(''); setFormat('eur')
  }, [offen, spalten, kennzahlen])

  const erlaubt = useMemo(() => new Set(FORMEL_SPALTEN), [])
  const pruefung = useMemo(() => (formel.trim() ? parseFormel(formel, erlaubt) : null), [formel, erlaubt])

  const label = (key: string): string => {
    if (key.startsWith(EIGEN_PREFIX)) return eigene.find(e => EIGEN_PREFIX + e.id === key)?.name ?? key
    const d = SPALTE.get(key)
    return d ? t(d.label.k, d.label.d) : key
  }

  const umschalten = (key: string) => setAuswahl(prev =>
    prev.includes(key) ? prev.filter(k => k !== key) : prev.length >= MAX_SPALTEN ? prev : [...prev, key])

  const verschieben = (i: number, d: -1 | 1) => setAuswahl(prev => {
    const j = i + d
    if (j < 0 || j >= prev.length) return prev
    const n = [...prev]; [n[i], n[j]] = [n[j], n[i]]; return n
  })

  const einfuegen = (key: string) => setFormel(f => (f && !/[\s(+\-*/]$/.test(f) ? `${f} ${key}` : `${f}${key}`))

  const hinzufuegen = () => {
    if (!name.trim() || !pruefung?.ok) return
    const k: EigeneKennzahl = { id: neueId(), name: name.trim().slice(0, 60), formel: formel.trim(), format }
    setEigene(prev => [...prev, k].slice(0, 20))
    setAuswahl(prev => (prev.length >= MAX_SPALTEN ? prev : [...prev, EIGEN_PREFIX + k.id]))
    setName(''); setFormel('')
  }

  const entfernen = (id: string) => {
    setEigene(prev => prev.filter(e => e.id !== id))
    setAuswahl(prev => prev.filter(k => k !== EIGEN_PREFIX + id))
  }

  const fehlerText = pruefung && !pruefung.ok
    ? t(FORMEL_FEHLER_TEXT[pruefung.fehler.code].k, FORMEL_FEHLER_TEXT[pruefung.fehler.code].d, { x: pruefung.fehler.x ?? '' })
    : null

  return (
    <Modal open={offen} onClose={onClose} size="xl" title={t('crm.werbung.zentrale.spalten.titel', 'Spalten anpassen')}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="hp-btn hp-btn-ghost" onClick={onClose}>{t('common.cancel', 'Abbrechen')}</button>
          <button type="button" className="hp-btn hp-btn-primary" disabled={auswahl.length === 0}
            onClick={() => onUebernehmen(auswahl, eigene)}>
            {t('crm.werbung.zentrale.spalten.uebernehmen', 'Übernehmen')}
          </button>
        </div>
      }>
      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4 min-w-0">
          {SPALTEN_GRUPPEN.map(g => {
            const liste = SPALTEN.filter(c => c.gruppe === g.id)
            return (
              <fieldset key={g.id}>
                <legend className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">{t(g.label.k, g.label.d)}</legend>
                {g.id === 'crm' && !crmSichtbar && (
                  <p className="text-[11px] text-amber-700 mb-1">{t('crm.werbung.zentrale.spalten.crmGesperrt', 'CRM-Spalten siehst du nur mit dem Pipeline-Recht.')}</p>
                )}
                <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
                  {liste.map(c => (
                    <label key={c.key} className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer min-w-0">
                      <input type="checkbox" className="mt-0.5" checked={auswahl.includes(c.key)} onChange={() => umschalten(c.key)} />
                      <span className="min-w-0">
                        <span className="block">{t(c.label.k, c.label.d)}{c.quelle === 'meta' && <span className="ml-1 text-[10px] text-gray-400">{t('crm.werbung.zentrale.spalten.vonMeta', '(von Meta)')}</span>}</span>
                        <span className="block text-[11px] text-gray-400">{t(c.hilfe.k, c.hilfe.d)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )
          })}

          {/* Eigene Kennzahlen */}
          <fieldset className="rounded-xl border border-gray-200 p-3">
            <legend className="text-xs font-bold uppercase tracking-wide text-gray-500 px-1">{t('crm.werbung.zentrale.spalten.eigene', 'Eigene Kennzahlen')}</legend>
            {eigene.length > 0 && (
              <ul className="mb-3 space-y-1">
                {eigene.map(e => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="flex items-center gap-2 min-w-0">
                      <input type="checkbox" checked={auswahl.includes(EIGEN_PREFIX + e.id)} onChange={() => umschalten(EIGEN_PREFIX + e.id)} />
                      <span className="font-semibold text-gray-800 truncate">{e.name}</span>
                    </label>
                    <code className="text-[11px] text-gray-500 truncate max-w-full">{e.formel}</code>
                    <button type="button" onClick={() => entfernen(e.id)} className="ml-auto text-xs text-gray-500 underline hover:text-red-600">
                      {t('crm.werbung.zentrale.spalten.entfernen', 'Entfernen')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
              <label className="text-[11px] text-gray-500 flex flex-col gap-0.5">
                {t('crm.werbung.zentrale.spalten.name', 'Name')}
                <input value={name} onChange={e => setName(e.target.value)} maxLength={60}
                  placeholder={t('crm.werbung.zentrale.spalten.namePlatzhalter', 'z. B. Kosten pro Gespräch')}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
              </label>
              <label className="text-[11px] text-gray-500 flex flex-col gap-0.5">
                {t('crm.werbung.zentrale.spalten.format', 'Format')}
                <select value={format} onChange={e => setFormat(e.target.value as EigeneKennzahl['format'])}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm">
                  <option value="eur">{t('crm.werbung.zentrale.spalten.formatEur', 'Euro')}</option>
                  <option value="zahl">{t('crm.werbung.zentrale.spalten.formatZahl', 'Zahl')}</option>
                  <option value="prozent">{t('crm.werbung.zentrale.spalten.formatProzent', 'Prozent')}</option>
                </select>
              </label>
              <button type="button" className={BTN_KLEIN} disabled={!name.trim() || !pruefung?.ok} onClick={hinzufuegen}>
                {t('crm.werbung.zentrale.spalten.hinzufuegen', 'Kennzahl hinzufügen')}
              </button>
            </div>
            <label className="mt-2 text-[11px] text-gray-500 flex flex-col gap-0.5">
              {t('crm.werbung.zentrale.spalten.formel', 'Formel')}
              <input value={formel} onChange={e => setFormel(e.target.value)} spellCheck={false}
                placeholder="ausgaben / (termine + stattgefunden)"
                className={`border rounded-lg px-2 py-1.5 text-sm font-mono ${fehlerText ? 'border-red-300' : 'border-gray-200'}`} />
            </label>
            <p className={`mt-1 text-[11px] ${fehlerText ? 'text-red-600' : 'text-gray-400'}`}>
              {fehlerText ?? t('crm.werbung.zentrale.spalten.formelHilfe', 'Erlaubt sind Spaltennamen, Zahlen, + - * / und Klammern. Prozentwerte rechnen als Anteil (0,05 = 5 %). Teilen durch 0 ergibt „-".')}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {FORMEL_SPALTEN.map(k => (
                <button key={k} type="button" onClick={() => einfuegen(k)} title={label(k)}
                  className="px-1.5 py-0.5 rounded border border-gray-200 text-[11px] font-mono text-gray-600 hover:border-orange-300 hover:text-orange-700">
                  {k}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        {/* Reihenfolge */}
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5">
            {t('crm.werbung.zentrale.spalten.reihenfolge', 'Ausgewählt ({{n}} von max. {{max}})', { n: auswahl.length, max: MAX_SPALTEN })}
          </p>
          <ol className="space-y-1 rounded-xl border border-gray-200 p-2 lg:max-h-[60vh] lg:overflow-y-auto">
            {auswahl.map((k, i) => (
              <li key={k} className="flex items-center gap-1 text-sm">
                <span className="w-5 text-[11px] text-gray-400 tabular-nums">{i + 1}</span>
                <span className="flex-1 truncate" title={label(k)}>{label(k)}</span>
                <button type="button" onClick={() => verschieben(i, -1)} disabled={i === 0}
                  aria-label={t('crm.werbung.zentrale.spalten.hoch', 'Nach oben')} className="px-1.5 text-gray-500 disabled:opacity-30">↑</button>
                <button type="button" onClick={() => verschieben(i, 1)} disabled={i === auswahl.length - 1}
                  aria-label={t('crm.werbung.zentrale.spalten.runter', 'Nach unten')} className="px-1.5 text-gray-500 disabled:opacity-30">↓</button>
                <button type="button" onClick={() => umschalten(k)}
                  aria-label={t('crm.werbung.zentrale.spalten.abwaehlen', 'Spalte entfernen')} className="px-1.5 text-gray-400 hover:text-red-600">×</button>
              </li>
            ))}
            {auswahl.length === 0 && <li className="text-xs text-gray-400 px-1 py-2">{t('crm.werbung.zentrale.spalten.keine', 'Keine Spalte gewählt.')}</li>}
          </ol>
        </div>
      </div>
    </Modal>
  )
}
