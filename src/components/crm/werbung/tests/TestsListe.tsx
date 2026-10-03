import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StudiesListResponse, TestStatus, TestUebersicht } from '../../../../lib/werbeSteuerung'
import Badge from '../../../ui/Badge'
import DataTable, { type DataTableColumn } from '../../../ui/DataTable'
import EmptyState from '../../../ui/EmptyState'
import Spinner from '../../../ui/Spinner'
import { useWerbeFormat } from '../format'
import { Hinweis } from '../zielgruppen/Bausteine'
import TestAssistent from './TestAssistent'
import TestErgebnis from './TestErgebnis'
import { steuerungCall, steuerungFehlerText } from './steuerungApi'
import { datumKurz, kennzahlLabel, testStatusEtikett, typLabel } from './texte'

// ── A/B-Tests: Liste, Assistent, Ergebnis ────────────────────────────────────
// Liste über meta-steuerung studies_list (Tests des Werbekontos und des
// Business, laufende zuerst). Klick öffnet das Ergebnis. Tests, die nicht im
// CRM angelegt wurden, tragen das Etikett „In Meta angelegt".

type Filter = 'alle' | TestStatus

const STATUS: readonly TestStatus[] = ['laeuft', 'geplant', 'beendet', 'abgebrochen']

export default function TestsListe({ schreibSperre, pruefSperre, aktiv }: { schreibSperre: string | null; pruefSperre: string | null; aktiv: boolean }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [ergebnis, setErgebnis] = useState<StudiesListResponse | null>(null)
  const [laden, setLaden] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('alle')
  const [nurHp, setNurHp] = useState(false)
  const [neu, setNeu] = useState(false)
  const [offenId, setOffenId] = useState<string | null>(null)
  const [gestartet, setGestartet] = useState(false)

  const lade = useCallback(async () => {
    setLaden(true)
    try {
      setErgebnis(await steuerungCall('studies_list', {}))
      setFehler(null)
    } catch (err) {
      console.error('[Tests] Liste:', err)
      setFehler(steuerungFehlerText(err, t))
    } finally {
      setLaden(false)
    }
  }, [t])

  // Erst laden, wenn der Unterreiter offen ist (ein Meta-Abruf je Öffnen)
  useEffect(() => {
    if (!aktiv || gestartet) return
    setGestartet(true)
    void lade()
  }, [aktiv, gestartet, lade])

  const zeilen = useMemo(() => (ergebnis?.items ?? []).filter(z => !nurHp || z.von_hp), [ergebnis, nurHp])
  const zaehler = useMemo(() => {
    const m: Record<string, number> = { alle: zeilen.length }
    for (const z of zeilen) m[z.status] = (m[z.status] ?? 0) + 1
    return m
  }, [zeilen])
  // Reihenfolge kommt vom Server (laufende zuerst, dann nach Start)
  const sichtbar = useMemo(() => zeilen.filter(z => filter === 'alle' || z.status === filter), [zeilen, filter])

  const spalten: DataTableColumn<TestUebersicht>[] = [
    {
      id: 'name', header: t('crm.werbung.tests.spalte.name', 'Test'), primary: true,
      cell: z => (
        <span className="block min-w-0">
          <span className="block truncate">{z.name}</span>
          <span className="block truncate text-[11px] font-normal text-gray-500">
            {typLabel(t, z.typ)}{z.kennzahl ? ` · ${kennzahlLabel(t, z.kennzahl)}` : ''}
          </span>
        </span>
      ),
    },
    {
      id: 'status', header: t('crm.werbung.tests.spalte.status', 'Status'),
      cell: z => {
        const e = testStatusEtikett(t, z.status)
        return (
          <span className="flex flex-wrap items-center gap-1">
            <Badge tone={e.ton} dot>{e.text}</Badge>
            {!z.von_hp && <Badge tone="neutral">{t('crm.werbung.tests.ausMeta', 'In Meta angelegt')}</Badge>}
          </span>
        )
      },
    },
    {
      id: 'zeitraum', header: t('crm.werbung.tests.spalte.zeitraum', 'Laufzeit'), hideBelow: 'sm',
      cell: z => <span className="whitespace-nowrap tabular-nums">{datumKurz(fmt.locale, z.start)} - {datumKurz(fmt.locale, z.ende)}</span>,
    },
    {
      id: 'ergebnisse', header: t('crm.werbung.tests.spalte.ergebnisse', 'Ergebnisse ab'), hideBelow: 'md',
      cell: z => <span className="tabular-nums">{z.ergebnisse_ab ? datumKurz(fmt.locale, z.ergebnisse_ab) : '-'}</span>,
    },
  ]

  const filterKnoepfe: Array<{ id: Filter; label: string }> = [
    { id: 'alle', label: t('crm.werbung.tests.filter.alle', 'Alle') },
    ...STATUS.map(s => ({ id: s, label: testStatusEtikett(t, s).text })),
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <p className="min-w-0 text-sm text-gray-600 sm:mr-auto">
          {t('crm.werbung.tests.listeText', 'Meta teilt die Zielgruppe auf, jede Person sieht nur eine Variante. So ist der Vergleich fair, anders als zwei Anzeigen in derselben Gruppe.')}
        </p>
        <div className="flex shrink-0 gap-2 whitespace-nowrap">
          <button type="button" onClick={() => void lade()} disabled={laden} className="hp-btn hp-btn-ghost">
            {laden && <Spinner size="sm" />}
            {t('crm.werbung.tests.aktualisieren', 'Aktualisieren')}
          </button>
          <button type="button" onClick={() => setNeu(true)} className="hp-btn hp-btn-primary">
            + {t('crm.werbung.tests.neu', 'Neuer A/B-Test')}
          </button>
        </div>
      </div>

      {(ergebnis?.warnings ?? []).map((w, i) => <Hinweis key={i} ton="warnung">{w}</Hinweis>)}

      {(ergebnis?.items.length ?? 0) > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5" role="group" aria-label={t('crm.werbung.tests.filter.aria', 'Nach Status filtern')}>
            {filterKnoepfe.filter(f => f.id === 'alle' || (zaehler[f.id] ?? 0) > 0).map(f => (
              <button key={f.id} type="button" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === f.id ? 'border-hp-navy bg-hp-navy text-white' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}>
                {f.label} <span className="tabular-nums opacity-70">{zaehler[f.id] ?? 0}</span>
              </button>
            ))}
          </div>
          <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-gray-600">
            <input type="checkbox" checked={nurHp} onChange={e => setNurHp(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-hp-navy" />
            {t('crm.werbung.tests.nurHp', 'Nur im CRM angelegte')}
          </label>
        </div>
      )}

      {fehler ? (
        <div className="hp-card">
          <EmptyState icon="alert" title={t('crm.werbung.tests.ladeFehler', 'A/B-Tests konnten nicht geladen werden')}
            text={<span className="break-words">{fehler}</span>}
            action={<button type="button" onClick={() => void lade()} className="hp-btn hp-btn-ghost">{t('crm.werbung.tests.nochmal', 'Nochmal laden')}</button>} />
        </div>
      ) : (
        <DataTable
          columns={spalten}
          rows={sichtbar}
          rowKey={z => z.id}
          loading={laden && !ergebnis}
          onRowClick={z => setOffenId(z.id)}
          rowActionsLabel={z => t('crm.werbung.tests.aktionenFuer', 'Aktionen für {{name}}', { name: z.name })}
          rowActions={z => [
            { id: 'ergebnis', label: t('crm.werbung.tests.ergebnisZeigen', 'Ergebnis ansehen'), icon: 'statistics', onClick: () => setOffenId(z.id) },
          ]}
          empty={(
            <EmptyState icon="statistics"
              title={zeilen.length ? t('crm.werbung.tests.keinTreffer', 'Kein Test passt zum Filter') : t('crm.werbung.tests.leer', 'Noch keine A/B-Tests')}
              text={zeilen.length ? undefined : t('crm.werbung.tests.leerText', 'Starte mit einem Test der Anzeigengestaltung: 2 bis 5 Werbemittel gegeneinander, Gewinner nach Kosten pro Lead.')}
              action={zeilen.length ? undefined : <button type="button" onClick={() => setNeu(true)} className="hp-btn hp-btn-primary">+ {t('crm.werbung.tests.neu', 'Neuer A/B-Test')}</button>} />
          )}
        />
      )}

      <TestAssistent offen={neu} onClose={() => setNeu(false)} onFertig={() => void lade()} schreibSperre={schreibSperre} pruefSperre={pruefSperre} />
      <TestErgebnis id={offenId} onClose={() => setOffenId(null)} onGeaendert={() => void lade()} schreibSperre={schreibSperre} />
    </div>
  )
}
