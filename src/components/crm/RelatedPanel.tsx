import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import EntityLink from '../EntityLink'
import Icon from '../shell/Icon'
import Badge from '../ui/Badge'
import type { LeadRelated, RelatedGroupKey } from '../../lib/relatedTypes'
import { useRelated } from '../../lib/useRelated'
import { buildRelatedSections, type RelatedFormatters, type RelatedSection } from './relatedSections'

interface RelatedPanelProps {
  leadId: string
  // 'visible': lädt, sobald die Karte im Bild ist und der Browser Luft hat;
  // 'click': lädt erst beim ersten Aufklappen
  loadMode?: 'visible' | 'click'
  // Ohne Angabe: auf dem Telefon (unter sm) zugeklappt, sonst offen;
  // bei loadMode 'click' immer zugeklappt
  defaultOpen?: boolean
  // Gruppen, die die Seite schon selbst zeigt (z.B. ['tasks'])
  exclude?: string[]
  // "alle N anzeigen": liefert die Seite true, hat sie selbst zum passenden
  // Reiter gewechselt; sonst klappt die Gruppe an Ort und Stelle auf
  onOpenTab?: (kind: RelatedGroupKey) => boolean
  // Hochzählen, wenn sich auf der Seite etwas geändert hat: lädt neu
  refreshKey?: number
  className?: string
  // Nur für die Dev-Vorschau: feste Daten, kein Aufruf der Datenbank
  mockData?: LeadRelated
}

const PREVIEW_COUNT = 3
const SMALL_LIMIT = 5
const FULL_LIMIT = 50
const SMALL_SCREEN = '(max-width: 639.98px)'

function startsCollapsed(): boolean {
  try { return window.matchMedia(SMALL_SCREEN).matches } catch { return false }
}

function makeFormatters(language: string): RelatedFormatters {
  const locale = language.startsWith('de') ? 'de-DE' : 'en-US'
  const parse = (value: string): Date | null => {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return {
    date: value => parse(value)?.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }) ?? value,
    dateTime: value => parse(value)?.toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) ?? value,
    money: (amount, currency) => {
      try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency: currency || 'EUR' }).format(amount)
      } catch {
        return `${amount} ${currency ?? ''}`.trim()
      }
    },
  }
}

// Wartet, bis die Karte (fast) im Bild ist und der Browser nichts Wichtigeres
// zu tun hat. Ohne IntersectionObserver oder requestIdleCallback gilt ein
// kurzer Timer.
function useArmedWhenVisible(target: RefObject<HTMLElement>, active: boolean): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!active || armed) return
    const node = target.current
    let timer: number | undefined
    let idle: number | undefined
    let observer: IntersectionObserver | undefined
    const arm = () => {
      if (typeof window.requestIdleCallback === 'function') {
        idle = window.requestIdleCallback(() => setArmed(true), { timeout: 1500 })
      } else {
        timer = window.setTimeout(() => setArmed(true), 200)
      }
    }
    if (!node || typeof IntersectionObserver === 'undefined') {
      arm()
    } else {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          observer?.disconnect()
          arm()
        }
      }, { rootMargin: '200px' })
      observer.observe(node)
    }
    return () => {
      observer?.disconnect()
      if (timer !== undefined) window.clearTimeout(timer)
      if (idle !== undefined && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle)
    }
  }, [target, active, armed])
  return armed
}

function Skeleton() {
  return (
    <div className="space-y-3 py-1" aria-hidden="true">
      {['w-2/3', 'w-1/2', 'w-3/5'].map(width => (
        <div key={width} className={`h-4 animate-pulse rounded-full bg-gray-100 ${width}`} />
      ))}
    </div>
  )
}

interface GroupProps {
  section: RelatedSection
  expanded: boolean
  onShowAll: () => void
  onShowLess: () => void
}

// Eine Gruppe: Überschrift mit Zahl, bis zu drei Chips, dann "alle N anzeigen"
function RelatedGroup({ section, expanded, onShowAll, onShowLess }: GroupProps) {
  const { t } = useTranslation()
  const headingId = useId()
  const visible = expanded ? section.chips : section.chips.slice(0, PREVIEW_COUNT)
  const canShowAll = section.listed && section.count > PREVIEW_COUNT && !expanded
  const notShown = expanded && section.listed ? section.count - section.chips.length : 0

  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <h3 id={headingId} className="flex items-center gap-2 text-xs font-semibold font-body uppercase tracking-wide text-gray-500">
        <span className="truncate">{t(`related.groups.${section.key}`)}</span>
        {section.listed && <span className="font-medium text-gray-500">{section.count}</span>}
      </h3>
      <ul className="mt-2 flex flex-wrap gap-2">
        {visible.map(chip => (
          <li key={chip.key} className="min-w-0 max-w-full">
            <EntityLink kind={chip.kind} id={chip.id} label={chip.label} opts={chip.opts} icon={chip.icon} variant="chip" />
          </li>
        ))}
      </ul>
      {(canShowAll || expanded) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3">
          {canShowAll && (
            <button
              type="button"
              onClick={onShowAll}
              className="inline-flex min-h-[36px] items-center rounded-sm text-sm font-body text-hp-navy underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/70"
            >
              {t('related.showAll', { count: section.count })}
            </button>
          )}
          {notShown > 0 && (
            <span className="text-sm font-body text-gray-500">{t('related.moreNotShown', { count: notShown })}</span>
          )}
          {expanded && section.listed && section.chips.length > PREVIEW_COUNT && (
            <button
              type="button"
              onClick={onShowLess}
              className="inline-flex min-h-[36px] items-center rounded-sm text-sm font-body text-gray-500 underline-offset-4 hover:text-hp-navy hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/70"
            >
              {t('related.showLess')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

// Karte "Gehört dazu": alles, was zu einem Kunden gehört, als Chips mit Links.
// Stört die Seite nie: gibt es die Funktion in der Datenbank noch nicht oder
// ist der Kunde für den Betrachter nicht sichtbar, erscheint gar nichts; ein
// Fehler zeigt nur eine Zeile mit "Erneut versuchen".
export default function RelatedPanel({
  leadId, loadMode = 'visible', defaultOpen, exclude, onOpenTab, refreshKey, className = '', mockData,
}: RelatedPanelProps) {
  const { t, i18n } = useTranslation()
  const rootRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const bodyId = useId()
  const isMock = mockData !== undefined
  const [open, setOpen] = useState(() => defaultOpen ?? (loadMode === 'click' ? false : !startsCollapsed()))
  const [openedOnce, setOpenedOnce] = useState(open)
  const [expanded, setExpanded] = useState<ReadonlySet<RelatedGroupKey>>(() => new Set())

  const armed = useArmedWhenVisible(rootRef, !isMock && loadMode === 'visible')
  const shouldLoad = !isMock && (loadMode === 'visible' ? armed : openedOnce)
  // Mehr als die ersten Einträge erst holen, wenn eine Gruppe aufgeklappt wird
  const related = useRelated(shouldLoad ? { kind: 'lead', id: leadId } : null, {
    limit: expanded.size > 0 ? FULL_LIMIT : SMALL_LIMIT,
  })
  const { reload } = related

  // refreshKey: nach Änderungen auf der Seite neu laden (nicht beim ersten Zeichnen)
  const lastRefresh = useRef(refreshKey)
  useEffect(() => {
    if (lastRefresh.current === refreshKey) return
    lastRefresh.current = refreshKey
    if (shouldLoad) reload()
  }, [refreshKey, shouldLoad, reload])

  // Anderer Kunde: aufgeklappte Gruppen zurücksetzen
  useEffect(() => {
    setExpanded(prev => (prev.size > 0 ? new Set() : prev))
  }, [leadId])

  const data = isMock ? mockData : related.data
  const status = isMock ? 'ready' : related.status
  const language = i18n.language
  const excludeKey = (exclude ?? []).join('|')
  const sections = useMemo(
    () => (data ? buildRelatedSections(data, t, makeFormatters(language), excludeKey ? excludeKey.split('|') : []) : []),
    [data, t, language, excludeKey],
  )
  // Gesamtzahl im Kopf: verknüpfte Datensätze; eine Zusammenfassung (Dokumente,
  // Drive-Dateien, Portal ...) zählt als ein Eintrag, damit 40 Dateien die Zahl
  // nicht aufblähen
  const total = sections.reduce((sum, section) => sum + (section.listed ? section.count : 1), 0)

  // Kein Kunde, Funktion fehlt (Migration nicht eingespielt) oder Kunde nicht sichtbar
  if ((!leadId && !isMock) || status === 'unavailable' || (status === 'ready' && !data)) return null

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) setOpenedOnce(true)
  }
  const showAll = (key: RelatedGroupKey) => {
    if (onOpenTab?.(key)) return
    setExpanded(prev => new Set(prev).add(key))
  }
  const showLess = (key: RelatedGroupKey) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  let body
  if (data) {
    body = sections.length === 0 ? (
      <p className="text-sm font-body text-gray-500">{t('related.empty')}</p>
    ) : (
      <div className="grid gap-5 lg:grid-cols-2 lg:gap-x-8">
        {sections.map(section => (
          <RelatedGroup
            key={section.key}
            section={section}
            expanded={expanded.has(section.key)}
            onShowAll={() => showAll(section.key)}
            onShowLess={() => showLess(section.key)}
          />
        ))}
      </div>
    )
  } else if (status === 'error') {
    body = (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-body text-gray-600">
        <Icon name="alert" size={16} className="shrink-0 text-gray-400" />
        <span>{t('related.error')}</span>
        <button
          type="button"
          onClick={reload}
          className="inline-flex min-h-[36px] items-center rounded-sm font-medium text-hp-navy underline underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/70"
        >
          {t('related.retry')}
        </button>
      </p>
    )
  } else {
    body = (
      <div role="status">
        <span className="sr-only">{t('related.loading')}</span>
        <Skeleton />
      </div>
    )
  }

  return (
    <section ref={rootRef} aria-labelledby={titleId} className={`hp-card p-4 sm:p-5 ${className}`}>
      <h2 id={titleId} className="m-0">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-h-[44px] w-full items-center gap-3 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/70"
        >
          <Icon name="link" size={18} className="shrink-0 text-hp-navy/60" />
          <span className="font-heading text-lg text-hp-navy">{t('related.title')}</span>
          {data && total > 0 && <Badge tone="info">{total}</Badge>}
          {!open && !data && loadMode === 'click' && (
            <span className="hidden min-w-0 truncate text-xs font-body text-gray-500 sm:inline">{t('related.loadHint')}</span>
          )}
          <Icon
            name="chevronDown"
            size={18}
            className={`ml-auto shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </h2>
      <div id={bodyId} hidden={!open} className="mt-3">
        {open && body}
      </div>
    </section>
  )
}
