import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { groupedNav, type NavEntry } from '../../lib/navigation'
import type { Profile } from '../../lib/permissions'
import { signOutAndReset } from '../../lib/session'
import LanguageSwitcher from '../LanguageSwitcher'
import Icon from './Icon'
import { readBuildId, switchToLegacyNav } from './ProfileMenu'
import { badgeCount, formatBadge, type NavBadges } from './ShellContext'
import { searchPages } from './navSearch'
import { useOverlay } from './useOverlay'

interface MoreSheetProps {
  profile: Profile
  badges: NavBadges
  // Id des aktiven Menüeintrags (aus matchEntry), null wenn keiner passt
  activeId: string | null
  onClose: () => void
}

const ROW =
  'relative flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-body transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40'
const ROW_IDLE = 'text-gray-700 hover:bg-gray-50'
const ROW_ACTIVE = 'bg-hp-navy/5 font-semibold text-hp-navy'

// "Mehr"-Blatt auf dem Telefon: schiebt sich von unten herein und zeigt ALLE
// Seiten, die das Profil sehen darf, dazu Profil, Sprache und Abmelden.
//
// Ebene z-40: über der Telefon-Leiste und der oberen Leiste (beide z-30).
// Seiten-Dialoge liegen bei z-40 bis z-120, werden aber von der Seite geöffnet
// und nie aus dem Blatt heraus; beide sind also nie gleichzeitig offen.
export default function MoreSheet({ profile, badges, activeId, onClose }: MoreSheetProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  const [query, setQuery] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const buildId = readBuildId()

  // Escape, Fokus-Falle, Scroll-Sperre der Seite, Fokus zurück beim Schließen
  useOverlay(panelRef, onClose)

  // Hereinschieben nach dem ersten Rendern; Fokus auf das Blatt (nicht auf das
  // Suchfeld, sonst springt auf dem Telefon sofort die Tastatur auf).
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    panelRef.current?.focus({ preventScroll: true })
    return () => cancelAnimationFrame(frame)
  }, [])

  const handleSignOut = () => {
    if (loggingOut) return
    setLoggingOut(true)
    void signOutAndReset()
  }

  const renderRow = (entry: NavEntry, label: string, sublabel?: string) => {
    const active = entry.id === activeId
    const count = badgeCount(entry, badges)
    const badgeText = entry.badge && count > 0 ? t(`shell.badges.${entry.badge}`, { count }) : ''
    return (
      <li key={entry.id}>
        <Link
          to={entry.path}
          onClick={onClose}
          aria-current={active ? 'page' : undefined}
          className={`${ROW} ${active ? ROW_ACTIVE : ROW_IDLE}`}
        >
          {active && <span aria-hidden="true" className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-hp-highlight" />}
          <Icon name={entry.icon} size={20} className={`shrink-0 ${active ? 'text-hp-highlight' : 'text-gray-400'}`} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {sublabel && <span className="shrink-0 text-xs font-normal text-gray-400">{sublabel}</span>}
          {count > 0 && (
            <span
              title={badgeText}
              aria-label={badgeText}
              className="shrink-0 rounded-full bg-hp-navy px-1.5 py-0.5 text-[10px] font-semibold leading-none text-hp-cream tabular-nums"
            >
              {formatBadge(count)}
            </span>
          )}
        </Link>
      </li>
    )
  }

  // Profil steht unten als eigene Zeile, darum hier ohne die Gruppe "Konto"
  const groups = groupedNav(profile).filter(g => g.group.id !== 'konto')
  const filtering = query.trim().length > 0
  const hits = filtering ? searchPages(profile, query, key => t(key)) : []

  return (
    <div className="fixed inset-0 z-40 md:hidden">
      {/* Hintergrund: Tippen schließt */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`absolute inset-0 bg-hp-navy/40 transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.sheet.title')}
        tabIndex={-1}
        className={`absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl transition-transform duration-200 ease-out focus:outline-none ${
          shown ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        {/* Kopf: Titel + Schließen */}
        <div className="flex shrink-0 items-center justify-between pl-5 pr-2 pt-2">
          <p className="font-heading text-lg text-hp-navy">{t('shell.sheet.title')}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('shell.a11y.close')}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40"
          >
            <Icon name="close" size={22} />
          </button>
        </div>

        {/* Suchfeld: filtert die Seitenliste */}
        <div className="shrink-0 px-4 pb-2">
          <label className="flex h-11 items-center gap-2 rounded-lg border border-gray-200 bg-hp-cream px-3 focus-within:border-hp-navy/40">
            <Icon name="search" size={18} className="shrink-0 text-gray-400" />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('shell.search.filterPages')}
              aria-label={t('shell.search.filterPages')}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-base font-body text-hp-black placeholder:text-gray-400 focus:outline-none"
            />
          </label>
        </div>

        {/* Liste: scrollt im Blatt, die Seite dahinter ist gesperrt */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {filtering ? (
            hits.length > 0 ? (
              <ul className="space-y-0.5">{hits.map(h => renderRow(h.entry, h.label, h.groupLabel))}</ul>
            ) : (
              <p className="px-3 py-6 text-center text-sm font-body text-gray-500">{t('shell.search.noResults')}</p>
            )
          ) : (
            groups.map(({ group, entries }) => (
              <section key={group.id} aria-label={t(group.labelKey)}>
                {group.id !== 'start' && (
                  <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400">
                    {t(group.labelKey)}
                  </p>
                )}
                <ul className="space-y-0.5">{entries.map(e => renderRow(e, t(e.labelKey)))}</ul>
              </section>
            ))
          )}

          {/* Konto: Profil, Sprache, alte Navigation, Abmelden */}
          <div className="mt-3 space-y-0.5 border-t border-gray-100 pt-2">
            <Link to="/profile" onClick={onClose} className={`${ROW} ${activeId === 'profile' ? ROW_ACTIVE : ROW_IDLE}`}>
              <Icon name="user" size={20} className="shrink-0 text-gray-400" />
              <span className="min-w-0 flex-1 truncate">{t('shell.profile.profile')}</span>
              <span className="min-w-0 max-w-[50%] truncate text-xs font-normal text-gray-400">{profile.full_name || profile.email}</span>
            </Link>
            <div className="flex min-h-[44px] items-center gap-3 px-3 text-sm font-body text-gray-700">
              <Icon name="globe" size={20} className="shrink-0 text-gray-400" />
              <span className="flex-1">{t('shell.profile.language')}</span>
              <LanguageSwitcher />
            </div>
            <button type="button" onClick={switchToLegacyNav} title={t('shell.profile.legacyNavHint')} className={`${ROW} ${ROW_IDLE}`}>
              <Icon name="menu" size={20} className="shrink-0 text-gray-400" />
              <span className="flex-1">{t('shell.profile.legacyNav')}</span>
            </button>
            <button type="button" onClick={handleSignOut} disabled={loggingOut} className={`${ROW} ${ROW_IDLE} disabled:opacity-60`}>
              <Icon name="logout" size={20} className="shrink-0 text-gray-400" />
              <span className="flex-1">{loggingOut ? t('shell.profile.loggingOut') : t('shell.profile.logout')}</span>
            </button>
            {buildId && (
              <p className="px-3 pt-2 text-[10px] font-body tabular-nums text-gray-400 select-all" title={t('nav.buildIdTitle')}>
                {t('shell.profile.buildId')} {buildId}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
