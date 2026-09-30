import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import Icon, { type IconId } from '../shell/Icon'

export interface TabItem {
  id: string
  label: string
  icon?: IconId
  // Zähler hinter der Beschriftung (0 wird angezeigt, undefined nicht)
  count?: number
  hidden?: boolean
}

interface TabsProps {
  tabs: TabItem[]
  value: string
  onChange: (id: string) => void
  // Name des Adress-Parameters (true = 'tab'). Gesetzt: der aktive Reiter steht
  // in der Adresse (?tab=...) und wird von dort gelesen; Neuladen und Links
  // behalten den Reiter. Geschrieben wird mit replace (kein Verlaufs-Eintrag).
  urlParam?: string | boolean
  // Name der Reiterleiste für Screenreader
  ariaLabel?: string
  // Mit idBase bekommen die Reiter Ids (`${idBase}-tab-${id}`) und verweisen auf
  // ihr Feld (`${idBase}-panel-${id}`), siehe tabPanelProps
  idBase?: string
  className?: string
}

export const DEFAULT_TAB_PARAM = 'tab'

// Startwert für useState, damit nach dem Neuladen sofort das richtige Feld
// erscheint: const [tab, setTab] = useState(() => initialTabFromUrl(['a', 'b'], 'a'))
export function initialTabFromUrl(ids: readonly string[], fallback: string, param: string = DEFAULT_TAB_PARAM): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(param)
    return fromUrl !== null && ids.includes(fromUrl) ? fromUrl : fallback
  } catch { return fallback }
}

// Attribute für das Feld eines Reiters: <div {...tabPanelProps('lead', 'tasks')}>
export function tabPanelProps(idBase: string, id: string) {
  return { role: 'tabpanel' as const, id: `${idBase}-panel-${id}`, 'aria-labelledby': `${idBase}-tab-${id}`, tabIndex: 0 }
}

// Ohne -mb-px: die Grundlinie der Leiste ist ein Schatten nach innen (siehe
// unten), die 2 px Korall-Linie des aktiven Reiters liegt darüber und wird
// nicht vom Scroll-Rahmen der Leiste abgeschnitten.
const TAB =
  'relative inline-flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-body ' +
  'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-hp-navy/70 sm:px-4'
const TAB_ACTIVE = 'border-hp-highlight font-semibold text-hp-navy'
const TAB_IDLE = 'border-transparent font-medium text-gray-500 hover:border-gray-200 hover:text-hp-navy'

// Reiterleiste. Aktiv = Navy-Text mit 2 px Korall-Linie. Auf dem Telefon
// waagerecht scrollbar, der aktive Reiter wird in die Sicht geholt.
// Pfeiltasten wechseln den Reiter, Pos1 und Ende springen an die Ränder.
export default function Tabs({ tabs, value, onChange, urlParam, ariaLabel, idBase, className = '' }: TabsProps) {
  const [search, setSearch] = useSearchParams()
  const location = useLocation()
  const listRef = useRef<HTMLDivElement>(null)
  const param = urlParam === true ? DEFAULT_TAB_PARAM : urlParam || null
  const shown = tabs.filter(tab => !tab.hidden)

  // Aktiver Reiter: mit urlParam gewinnt die Adresse, wenn sie einen sichtbaren
  // Reiter nennt; sonst gilt value.
  const fromUrl = param ? search.get(param) : null
  const urlTab = fromUrl !== null && shown.some(tab => tab.id === fromUrl) ? fromUrl : null
  const active = urlTab ?? value
  const hasActive = shown.some(tab => tab.id === active)

  // Der Aufrufer hält value. Nennt die Adresse einen anderen Reiter (Neuladen,
  // Link, Zurück-Taste), wird value nachgezogen: einmal je Änderung der
  // Adresse, nicht bei jedem Unterschied (sonst könnten sich Adresse und value
  // gegenseitig zurücksetzen).
  const changeRef = useRef(onChange)
  const valueRef = useRef(value)
  useEffect(() => { changeRef.current = onChange; valueRef.current = value })
  const seenUrlTab = useRef<string | null>(null)
  useEffect(() => {
    if (urlTab === seenUrlTab.current) return
    seenUrlTab.current = urlTab
    if (urlTab !== null && urlTab !== valueRef.current) changeRef.current(urlTab)
  }, [urlTab])

  // Den Reiter in die Adresse schreiben (replace). Baut auf der aktuellen
  // Adresse auf, nicht auf dem Stand beim Zeichnen (sonst setzte ein zweiter
  // Schreiber im selben Durchgang einen gerade entfernten Parameter zurück),
  // und behält location.state (z.B. "from" aus EntityLink für den Zurück-Weg).
  const writeUrl = (id: string) => {
    if (!param) return
    const next = new URLSearchParams(window.location.search)
    if (next.get(param) === id) return
    next.set(param, id)
    setSearch(next, { replace: true, state: location.state })
  }

  // Wechselt der Aufrufer den Reiter selbst (z.B. "alle N anzeigen" in der
  // Karte "Gehört dazu"), zieht die Adresse nach. Sonst bliebe dort der alte
  // Reiter stehen, er bliebe markiert und käme nach dem Neuladen zurück.
  // Kommt die Änderung aus der Adresse (Effekt oben), steht sie dort schon:
  // dann wird nichts geschrieben, es entsteht kein Hin und Her.
  const lastValue = useRef(value)
  useEffect(() => {
    if (value === lastValue.current) return
    lastValue.current = value
    if (param && search.get(param) !== value && shown.some(tab => tab.id === value)) writeUrl(value)
    // Nur bei einem neuen value; Adresse und Reiterliste gelten wie gezeichnet
  }, [value])

  // Aktiven Reiter in die Mitte der Leiste holen. Nur die Leiste scrollt
  // (scrollIntoView würde auch die Seite bewegen), und ohne weiches Scrollen:
  // das hinge in gedrosselten Tabs auf halbem Weg fest.
  useEffect(() => {
    const list = listRef.current
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !tab) return
    list.scrollLeft = Math.max(0, tab.offsetLeft - (list.clientWidth - tab.offsetWidth) / 2)
  }, [active])

  const select = (id: string) => {
    writeUrl(id)
    if (id !== value) onChange(id)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = shown.findIndex(tab => tab.id === active)
    let next = -1
    if (e.key === 'ArrowRight') next = index < 0 ? 0 : (index + 1) % shown.length
    else if (e.key === 'ArrowLeft') next = index < 0 ? shown.length - 1 : (index - 1 + shown.length) % shown.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = shown.length - 1
    if (next < 0 || !shown[next]) return
    e.preventDefault()
    select(shown[next].id)
    // Fokus folgt dem aktiven Reiter
    const buttons = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')
    buttons?.[next]?.focus()
  }

  // Grundlinie als Schatten nach innen statt border-b: nichts ragt über den
  // Rahmen hinaus, die Leiste scrollt nicht senkrecht. Bildlaufleiste auf dem
  // Telefon versteckt (Wischen), ab md schmal sichtbar: mit der Maus sind
  // überzählige Reiter sonst nicht erreichbar.
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`relative flex overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_#e5e7eb] max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden md:[scrollbar-width:thin] ${className}`}
    >
      {shown.map(tab => {
        const isActive = tab.id === active
        // Per Tab erreichbar ist der aktive Reiter; gibt es keinen, der erste
        const focusable = hasActive ? isActive : tab.id === shown[0]?.id
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={idBase ? `${idBase}-tab-${tab.id}` : undefined}
            aria-controls={idBase ? `${idBase}-panel-${tab.id}` : undefined}
            aria-selected={isActive}
            tabIndex={focusable ? 0 : -1}
            onClick={() => select(tab.id)}
            className={`${TAB} ${isActive ? TAB_ACTIVE : TAB_IDLE}`}
          >
            {tab.icon && <Icon name={tab.icon} size={16} className={`shrink-0 ${isActive ? 'text-hp-navy' : 'text-gray-400'}`} />}
            <span>{tab.label}</span>
            {tab.count !== undefined && (
              <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums ${isActive ? 'bg-hp-navy text-hp-cream' : 'bg-gray-100 text-gray-600'}`}>
                {tab.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
