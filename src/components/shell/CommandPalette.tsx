import { useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { Profile } from '../../lib/permissions'
import Icon from './Icon'
import type { IconId } from './iconPaths'
import { PaletteBridgeContext } from './ShellContext'
import { searchPages } from './navSearch'
import { useMediaQuery } from './useMediaQuery'
import { useOverlay } from './useOverlay'

// ── ERWEITERUNGSPUNKT: Datenquellen der Suche ────────────────────────────────
// Heute durchsucht die Suche nur die Seiten aus der Navigations-Registry
// (synchron). Kunden, Projekte, Wohnungen usw. kommen in einer späteren Etappe:
// dafür hier einen SearchProvider eintragen. Jeder Provider liefert einen
// eigenen Abschnitt in der Trefferliste, wird erst ab 2 Zeichen und mit 200 ms
// Verzögerung gefragt und muss das AbortSignal beachten. Supabase-Zugriffe nur
// über src/lib/supabase.ts, Fehler im Provider abfangen.
export interface SearchResult {
  id: string
  label: string
  sublabel?: string
  icon: IconId
  path: string
}

export interface SearchProvider {
  id: string
  // i18n-Schlüssel der Abschnittsüberschrift (de.json und en.json)
  sectionKey: string
  search: (query: string, profile: Profile, signal: AbortSignal) => Promise<SearchResult[]>
}

export const searchProviders: SearchProvider[] = []
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_MIN_CHARS = 2
const PROVIDER_DELAY_MS = 200
const LIST_ID = 'hp-palette-list'
// Abstand des Dialogs zum oberen und unteren Rand auf dem Telefon (2 x 12 px)
const PHONE_MARGIN_PX = 24
const PHONE_MIN_HEIGHT_PX = 160

// Höhe des sichtbaren Bereichs. Auf dem iPhone verkleinert die Bildschirm-
// Tastatur nur den sichtbaren Ausschnitt (visualViewport), nicht das Layout:
// Ohne diesen Wert läge der untere Teil der Trefferliste hinter der Tastatur.
function useVisibleHeight(): number | null {
  const read = () => {
    try { return window.visualViewport?.height ?? null } catch { return null }
  }
  const [height, setHeight] = useState<number | null>(read)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const onResize = () => setHeight(viewport.height)
    onResize()
    viewport.addEventListener('resize', onResize)
    return () => viewport.removeEventListener('resize', onResize)
  }, [])
  return height
}

interface Section {
  id: string
  title: string
  rows: SearchResult[]
}

interface PaletteDialogProps {
  profile: Profile
  onClose: () => void
}

function PaletteDialog({ profile, onClose }: PaletteDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [providerSections, setProviderSections] = useState<Section[]>([])
  const [loading, setLoading] = useState(false)

  // Escape, Fokus-Falle, Scroll-Sperre der Seite, Fokus zurück beim Schließen
  useOverlay(panelRef, onClose)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Telefon: Dialog so hoch wie der sichtbare Bereich über der Tastatur. Ab md
  // bleibt es bei max-h-[70vh] aus der Klasse.
  const isMd = useMediaQuery('(min-width: 768px)')
  const visibleHeight = useVisibleHeight()
  const phoneMaxHeight = !isMd && visibleHeight !== null
    ? Math.max(PHONE_MIN_HEIGHT_PX, Math.round(visibleHeight - PHONE_MARGIN_PX))
    : null

  // Seiten: synchron aus der Registry
  const pageSection = useMemo<Section>(() => ({
    id: 'pages',
    title: t('shell.search.pages'),
    rows: searchPages(profile, query, key => t(key)).map(hit => ({
      id: `page-${hit.entry.id}`,
      label: hit.label,
      sublabel: hit.groupLabel,
      icon: hit.entry.icon,
      path: hit.entry.path,
    })),
  }), [profile, query, t])

  // Datenquellen: verzögert und abbrechbar (heute leer, siehe searchProviders)
  useEffect(() => {
    if (searchProviders.length === 0) return
    const text = query.trim()
    if (text.length < PROVIDER_MIN_CHARS) {
      setProviderSections([])
      setLoading(false)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      void Promise.all(searchProviders.map(async provider => {
        try {
          return { id: provider.id, title: t(provider.sectionKey), rows: await provider.search(text, profile, controller.signal) }
        } catch {
          return { id: provider.id, title: t(provider.sectionKey), rows: [] }
        }
      })).then(sections => {
        if (controller.signal.aborted) return
        setProviderSections(sections.filter(s => s.rows.length > 0))
        setLoading(false)
      })
    }, PROVIDER_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query, profile, t])

  const sections = useMemo(
    () => [pageSection, ...providerSections].filter(s => s.rows.length > 0),
    [pageSection, providerSections])
  const flat = useMemo(() => sections.flatMap(s => s.rows), [sections])
  const activeRow = flat[Math.min(activeIndex, flat.length - 1)] ?? null
  const optionId = (row: SearchResult) => `hp-palette-${row.id}`

  // Neue Eingabe: Auswahl zurück auf den ersten Treffer
  useEffect(() => { setActiveIndex(0) }, [query])

  // Ausgewählten Treffer sichtbar halten
  useEffect(() => {
    if (!activeRow) return
    document.getElementById(`hp-palette-${activeRow.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeRow])

  const open = (row: SearchResult) => {
    onClose()
    navigate(row.path)
  }

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (flat.length > 0) setActiveIndex(i => (Math.min(i, flat.length - 1) + 1) % flat.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length > 0) setActiveIndex(i => (Math.min(i, flat.length - 1) - 1 + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeRow) open(activeRow)
    }
  }

  // Portal an den body: Die TopBar ist sticky mit eigener Ebene (z-30); ohne
  // Portal bliebe die Suche in dieser Ebene gefangen. z-[130] liegt über allen
  // Seiten-Dialogen (bis z-[120]), weil die Suche von überall geöffnet wird.
  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-start justify-center px-3 pt-3 md:pt-[12vh]">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-hp-navy/40" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.search.title')}
        style={phoneMaxHeight !== null ? { maxHeight: phoneMaxHeight } : undefined}
        className="relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 pl-4 pr-1.5">
          <Icon name="search" size={20} className="shrink-0 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={LIST_ID}
            aria-activedescendant={activeRow ? optionId(activeRow) : undefined}
            aria-autocomplete="list"
            aria-label={t('shell.search.placeholder')}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t('shell.search.placeholder')}
            autoComplete="off"
            spellCheck={false}
            className="h-14 min-w-0 flex-1 bg-transparent text-base font-body text-hp-black placeholder:text-gray-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('shell.a11y.close')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40"
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        <div
          id={LIST_ID}
          role="listbox"
          aria-label={t('shell.search.title')}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
        >
          {sections.map(section => (
            <div key={section.id} role="group" aria-label={section.title}>
              <p aria-hidden="true" className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-500">
                {section.title}
              </p>
              {section.rows.map(row => {
                const active = row === activeRow
                return (
                  <div
                    key={row.id}
                    id={optionId(row)}
                    role="option"
                    aria-selected={active}
                    onClick={() => open(row)}
                    onMouseMove={() => { if (!active) setActiveIndex(flat.indexOf(row)) }}
                    className={`relative flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg px-3 text-sm font-body ${
                      active ? 'bg-hp-navy/5 text-hp-navy' : 'text-gray-700'
                    }`}
                  >
                    {active && <span aria-hidden="true" className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-hp-highlight" />}
                    <Icon name={row.icon} size={18} className={`shrink-0 ${active ? 'text-hp-highlight' : 'text-gray-400'}`} />
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    {row.sublabel && <span className="shrink-0 text-xs text-gray-500">{row.sublabel}</span>}
                    {active && <Icon name="enter" size={14} className="hidden shrink-0 text-gray-400 md:block" />}
                  </div>
                )
              })}
            </div>
          ))}

          {flat.length === 0 && !loading && (
            <p className="px-3 py-8 text-center text-sm font-body text-gray-500">{t('shell.search.noResults')}</p>
          )}
          {loading && (
            <p role="status" className="px-3 py-2 text-xs font-body text-gray-500">{t('shell.search.loading')}</p>
          )}
        </div>

        <p className="hidden shrink-0 border-t border-gray-100 px-4 py-2 text-[11px] font-body text-gray-500 md:block">
          {t('shell.search.hint')}
        </p>
      </div>
    </div>,
    document.body,
  )
}

// Standard-Export ohne Props (lazyWithReload): Profil und Schließen kommen über
// den PaletteBridgeContext aus der TopBar.
export default function CommandPalette() {
  const bridge = useContext(PaletteBridgeContext)
  if (!bridge) return null
  return <PaletteDialog profile={bridge.profile} onClose={bridge.onClose} />
}
