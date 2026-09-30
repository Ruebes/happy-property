import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useMediaQuery } from '../shell/useMediaQuery'
import ActionMenu, { type ActionItem } from './ActionMenu'
import EmptyState from './EmptyState'

export interface DataTableColumn<T> {
  id: string
  // Spaltenkopf; in der Kartenansicht die Beschriftung der Zeile
  header: string
  cell: (row: T) => ReactNode
  className?: string
  // Spalte erst ab dieser Breite zeigen. Tabelle (ab md): nur 'lg' blendet aus.
  // Karten (unter md): 'md' und 'lg' fehlen ganz, 'sm' erscheint ab sm.
  hideBelow?: 'sm' | 'md' | 'lg'
  // Wird in der Kartenansicht zum Titel der Karte (sonst die erste Spalte).
  // Mit onRowClick wird der Inhalt dieser Spalte zum Knopf, der die Zeile
  // öffnet (Tastatur und Screenreader): darum dort nur Text, keine Links oder
  // Knöpfe.
  primary?: boolean
  align?: 'left' | 'right' | 'center'
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  // Inhalt, wenn es keine Zeilen gibt (Standard: EmptyState "Keine Einträge")
  empty?: ReactNode
  loading?: boolean
  rowActions?: (row: T) => ActionItem[]
  // Name der Aktionen einer Zeile (Knopf für Screenreader, auf dem Telefon
  // zugleich Titel des Blatts, z.B. "Aktionen für Anna Muster")
  rowActionsLabel?: (row: T) => string
  className?: string
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const
const SKELETON_ROWS = 4
// Knopf in der Titel-Spalte, der die Zeile öffnet
const OPEN_BUTTON = 'max-w-full rounded-sm text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/70'

// Klick auf ein Bedienelement in der Zeile (Link, Knopf, Feld) oder aus einem
// Menü/Dialog, der in React unter der Zeile hängt, ist kein Zeilen-Klick
function isRowEvent(target: EventTarget, row: HTMLElement): boolean {
  if (!(target instanceof Element) || !row.contains(target)) return false
  const control = target.closest('a, button, input, textarea, label, [role="button"], [data-no-row-click]')
  return control === null || control === row || !row.contains(control)
}

// Tabelle ohne eigene Sortier- und Blätter-Logik (der Aufrufer reicht fertige
// Zeilen herein). Ab md eine echte <table> in einem waagerecht scrollbaren
// Rahmen, darunter eine Kartenliste: die primary-Spalte wird Titel der Karte,
// die übrigen sichtbaren Spalten werden Zeilen "Beschriftung: Wert", die
// Zeilen-Aktionen stehen als Mehr-Knopf oben rechts in der Karte.
export default function DataTable<T>({
  columns, rows, rowKey, onRowClick, empty, loading = false, rowActions, rowActionsLabel, className = '',
}: DataTableProps<T>) {
  const { t } = useTranslation()
  const isTable = useMediaQuery('(min-width: 768px)')

  const clickable = onRowClick !== undefined
  // Klick irgendwo in die Zeile öffnet sie (Maus, Finger). Für Tastatur und
  // Screenreader steht in der Titel-Spalte ein echter Knopf: die Zeile selbst
  // ist kein Tab-Halt und verliert so nicht ihre Rolle als Zeile bzw. Eintrag.
  const onClick = (row: T) => (e: ReactMouseEvent<HTMLElement>) => {
    if (onRowClick && isRowEvent(e.target, e.currentTarget)) onRowClick(row)
  }
  const titleColumn = columns.find(column => column.primary) ?? columns[0]
  const titleCell = (column: DataTableColumn<T>, row: T): ReactNode => {
    if (!onRowClick) return column.cell(row)
    return <button type="button" onClick={() => onRowClick(row)} className={OPEN_BUTTON}>{column.cell(row)}</button>
  }

  const emptyContent = empty ?? <EmptyState compact title={t('ui.table.empty')} />
  const isEmpty = !loading && rows.length === 0

  if (!isTable) {
    const detailColumns = columns.filter(column => column !== titleColumn && column.hideBelow !== 'md' && column.hideBelow !== 'lg')
    return (
      <div className={className} aria-busy={loading || undefined}>
        {loading && (
          <ul className="space-y-3" aria-label={t('ui.table.loading')}>
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <li key={index} className="hp-card animate-pulse space-y-3 p-4">
                <div className="h-4 w-1/2 rounded bg-gray-100" />
                <div className="h-3 w-3/4 rounded bg-gray-100" />
                <div className="h-3 w-2/3 rounded bg-gray-100" />
              </li>
            ))}
          </ul>
        )}
        {isEmpty && <div className="hp-card">{emptyContent}</div>}
        {!loading && rows.length > 0 && (
          <ul className="space-y-3">
            {rows.map(row => {
              const actions = rowActions ? rowActions(row) : []
              return (
                <li
                  key={rowKey(row)}
                  onClick={clickable ? onClick(row) : undefined}
                  className={`hp-card p-4 ${clickable ? 'cursor-pointer transition-colors hover:border-hp-navy/20' : ''}`}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 pt-0.5 text-base font-semibold font-body text-hp-navy">
                      {titleColumn ? titleCell(titleColumn, row) : null}
                    </div>
                    {/* Mehr-Knopf oben rechts; der negative Rand gleicht die 44 px Tippfläche aus */}
                    <ActionMenu items={actions} label={rowActionsLabel?.(row)} title={rowActionsLabel?.(row)} className="-mr-2 -mt-2" />
                  </div>
                  {detailColumns.length > 0 && (
                    <dl className="mt-2 space-y-1.5">
                      {detailColumns.map(column => (
                        <div
                          key={column.id}
                          className={`grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-baseline gap-3 ${column.hideBelow === 'sm' ? 'hidden sm:grid' : 'grid'}`}
                        >
                          <dt className="text-xs font-body text-gray-500">{column.header}</dt>
                          <dd className={`min-w-0 break-words text-sm font-body text-gray-800 ${column.className ?? ''}`}>{column.cell(row)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  }

  const hasActions = rowActions !== undefined
  const columnClass = (column: DataTableColumn<T>) =>
    `${ALIGN[column.align ?? 'left']} ${column.hideBelow === 'lg' ? 'hidden lg:table-cell' : ''}`

  return (
    <div className={`hp-card overflow-hidden ${className}`} aria-busy={loading || undefined}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm font-body">
          <thead>
            <tr className="border-b border-gray-100 bg-hp-cream/60">
              {columns.map(column => (
                <th
                  key={column.id}
                  scope="col"
                  className={`whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500 ${columnClass(column)}`}
                >
                  {column.header}
                </th>
              ))}
              {hasActions && <th scope="col" className="w-12 px-2 py-3"><span className="sr-only">{t('ui.table.actions')}</span></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <tr key={index} className="animate-pulse">
                {columns.map(column => (
                  <td key={column.id} className={`px-4 py-3.5 ${columnClass(column)}`}>
                    <div className="h-3 w-3/4 rounded bg-gray-100" />
                  </td>
                ))}
                {hasActions && <td className="px-2 py-3.5" />}
              </tr>
            ))}
            {!loading && rows.map(row => {
              const actions = rowActions ? rowActions(row) : []
              return (
                <tr
                  key={rowKey(row)}
                  onClick={clickable ? onClick(row) : undefined}
                  className={clickable ? 'cursor-pointer transition-colors hover:bg-hp-cream/70 focus-within:bg-hp-cream/70' : undefined}
                >
                  {columns.map(column => (
                    <td
                      key={column.id}
                      className={`px-4 py-3 align-middle ${column.primary ? 'font-semibold text-hp-navy' : 'text-gray-800'} ${columnClass(column)} ${column.className ?? ''}`}
                    >
                      {column === titleColumn ? titleCell(column, row) : column.cell(row)}
                    </td>
                  ))}
                  {hasActions && (
                    <td className="px-2 py-1 text-right align-middle">
                      <ActionMenu items={actions} label={rowActionsLabel?.(row)} title={rowActionsLabel?.(row)} />
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {loading && <span className="sr-only" role="status">{t('ui.table.loading')}</span>}
      {isEmpty && emptyContent}
    </div>
  )
}
