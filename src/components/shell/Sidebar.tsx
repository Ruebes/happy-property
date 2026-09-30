import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { groupedNav, type NavEntry, type NavGroupId } from '../../lib/navigation'
import { landingFor, type Profile } from '../../lib/permissions'
import Icon from './Icon'
import {
  LS_NAVGROUPS, badgeCount, formatBadge, readLocal, writeLocal, type NavBadges,
} from './ShellContext'

interface SidebarProps {
  profile: Profile
  badges: NavBadges
  // Id des aktiven Menüeintrags (aus matchEntry), null wenn keiner passt
  activeId: string | null
  // true = volle Breite mit Beschriftung, false = schmale Icon-Leiste
  expanded: boolean
  // Umschalter nur zeigen, wo die volle Breite möglich ist (ab xl)
  canToggle: boolean
  onToggle: () => void
}

// Gruppen mit mehr Einträgen als diesem Wert lassen sich einklappen
const COLLAPSIBLE_FROM = 5

function readCollapsedGroups(): NavGroupId[] {
  try {
    const parsed: unknown = JSON.parse(readLocal(LS_NAVGROUPS) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((g): g is NavGroupId => typeof g === 'string') : []
  } catch { return [] }
}

const FOCUS_RING = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-cream/70'

// Seitenleiste ab md: Navy-Fläche, cremefarbene Schrift. Aktiver Eintrag =
// leicht aufgehellte Fläche plus 3 px Korall-Balken links und Korall-Icon.
// Korall bleibt damit reiner Akzent, nie Fläche.
export default function Sidebar({ profile, badges, activeId, expanded, canToggle, onToggle }: SidebarProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<NavGroupId[]>(readCollapsedGroups)
  const navRef = useRef<HTMLElement>(null)
  const groups = groupedNav(profile)

  // Aktiven Eintrag in der Leiste sichtbar halten (z.B. nach Sprung über die
  // Suche). Nur die Leiste wird bewegt, nie die Seite.
  useEffect(() => {
    const nav = navRef.current
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!nav || !current) return
    const navBox = nav.getBoundingClientRect()
    const box = current.getBoundingClientRect()
    if (box.top < navBox.top) nav.scrollTop -= navBox.top - box.top + 8
    else if (box.bottom > navBox.bottom) nav.scrollTop += box.bottom - navBox.bottom + 8
  }, [activeId, expanded])

  const toggleGroup = (id: NavGroupId) => {
    setCollapsed(prev => {
      const next = prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]
      writeLocal(LS_NAVGROUPS, JSON.stringify(next))
      return next
    })
  }

  const renderItem = (entry: NavEntry) => {
    const active = entry.id === activeId
    const label = t(entry.labelKey)
    const count = badgeCount(entry, badges)
    const badgeText = entry.badge && count > 0 ? t(`shell.badges.${entry.badge}`, { count }) : ''

    if (!expanded) {
      return (
        <li key={entry.id}>
          <Link
            to={entry.path}
            title={badgeText ? `${label} (${badgeText})` : label}
            aria-label={badgeText ? `${label}, ${badgeText}` : label}
            aria-current={active ? 'page' : undefined}
            className={`relative mx-auto flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${FOCUS_RING} ${
              active ? 'bg-hp-cream/10 text-hp-highlight' : 'text-hp-cream/80 hover:bg-hp-cream/[0.06] hover:text-hp-cream'
            }`}
          >
            {active && <span aria-hidden="true" className="absolute -left-3 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-hp-highlight" />}
            <Icon name={entry.icon} size={20} />
            {count > 0 && <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-hp-cream ring-2 ring-hp-navy" />}
          </Link>
        </li>
      )
    }

    return (
      <li key={entry.id}>
        <Link
          to={entry.path}
          aria-current={active ? 'page' : undefined}
          className={`relative mx-2 flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium font-body transition-colors ${FOCUS_RING} ${
            active ? 'bg-hp-cream/10 text-hp-cream' : 'text-hp-cream/80 hover:bg-hp-cream/[0.06] hover:text-hp-cream'
          }`}
        >
          {active && <span aria-hidden="true" className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-hp-highlight" />}
          <Icon name={entry.icon} size={18} className={`shrink-0 ${active ? 'text-hp-highlight' : ''}`} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {count > 0 && (
            <span
              title={badgeText}
              aria-label={badgeText}
              className="shrink-0 rounded-full bg-hp-cream px-1.5 py-0.5 text-[10px] font-semibold leading-none text-hp-navy tabular-nums"
            >
              {formatBadge(count)}
            </span>
          )}
        </Link>
      </li>
    )
  }

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-30 hidden flex-col bg-hp-navy text-hp-cream transition-[width] duration-200 md:flex ${
        expanded ? 'w-64' : 'w-16'
      }`}
    >
      {/* Logo */}
      <div className={`flex h-14 shrink-0 items-center border-b border-hp-cream/10 ${expanded ? 'px-4' : 'justify-center'}`}>
        <Link
          to={landingFor(profile)}
          aria-label={t('shell.a11y.home')}
          title={expanded ? undefined : t('app.name')}
          className={`flex min-w-0 items-center gap-3 rounded-lg ${FOCUS_RING}`}
        >
          <img src="/logo.jpg" alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-lg object-cover" />
          {expanded && <span className="truncate font-heading text-base text-hp-cream">{t('app.name')}</span>}
        </Link>
      </div>

      {/* Menü: eigener Scroll nur in der Leiste, die Seite scrollt als Ganzes */}
      <nav
        ref={navRef}
        aria-label={t('shell.a11y.mainNav')}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain py-2 [scrollbar-color:rgba(255,252,246,0.25)_transparent] [scrollbar-width:thin]"
      >
        {groups.map(({ group, entries }, index) => {
          const groupLabel = t(group.labelKey)
          const collapsible = expanded && entries.length > COLLAPSIBLE_FROM
          const isCollapsed = collapsible && collapsed.includes(group.id)
          // Eingeklappt bleibt nur der aktive Eintrag stehen (Orientierung)
          const shown = isCollapsed ? entries.filter(e => e.id === activeId) : entries
          const listId = `hp-navgroup-${group.id}`
          // Gruppe "Start" hat genau einen Eintrag gleichen Namens: ohne Überschrift
          const showHeading = expanded && group.id !== 'start'

          return (
            <div key={group.id} className={!expanded && index > 0 ? 'mt-2 border-t border-hp-cream/10 pt-2' : ''}>
              {showHeading && (collapsible ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={!isCollapsed}
                  aria-controls={listId}
                  className={`mx-2 mt-3 flex w-[calc(100%-1rem)] items-center justify-between rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-hp-cream/60 hover:text-hp-cream ${FOCUS_RING}`}
                >
                  <span className="truncate">{groupLabel}</span>
                  <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={14} />
                </button>
              ) : (
                <div className="mx-2 mt-3 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-hp-cream/60">
                  {groupLabel}
                </div>
              ))}
              <ul id={listId} aria-label={groupLabel} className="space-y-0.5">
                {shown.map(renderItem)}
              </ul>
            </div>
          )
        })}
      </nav>

      {/* Ein- und Ausklappen (nur ab xl, darunter ist die Leiste immer schmal) */}
      {canToggle && (
        <div className="shrink-0 border-t border-hp-cream/10 p-2">
          <button
            type="button"
            onClick={onToggle}
            aria-label={t(expanded ? 'shell.sidebar.collapse' : 'shell.sidebar.expand')}
            title={expanded ? undefined : t('shell.sidebar.expand')}
            className={`flex h-10 items-center gap-3 rounded-lg text-[13px] font-medium font-body text-hp-cream/70 transition-colors hover:bg-hp-cream/[0.06] hover:text-hp-cream ${FOCUS_RING} ${
              expanded ? 'w-full px-3' : 'mx-auto w-10 justify-center'
            }`}
          >
            <Icon name={expanded ? 'sidebarCollapse' : 'sidebarExpand'} size={18} className="shrink-0" />
            {expanded && <span className="truncate">{t('shell.sidebar.collapse')}</span>}
          </button>
        </div>
      )}
    </aside>
  )
}
