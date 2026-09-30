import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ROLE_META, type Profile } from '../../lib/permissions'
import { signOutAndReset } from '../../lib/session'
import Icon from './Icon'
import { LS_SHELL, writeLocal } from './ShellContext'

interface ProfileMenuProps {
  profile: Profile
}

// Initialen aus dem vollen Namen (höchstens zwei Buchstaben), sonst aus der E-Mail
export function initialsOf(profile: Profile): string {
  const fromName = (profile.full_name ?? '')
    .split(' ')
    .filter(Boolean)
    .map(part => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return fromName || profile.email?.[0]?.toUpperCase() || '?'
}

// Bau-Kennung aus <meta name="hp-build"> (setzt vite.config.ts, im Dev-Server
// ist es die Startzeit des Servers). Fehlt das Meta-Tag, wird nichts angezeigt.
export function readBuildId(): string {
  try {
    return document.querySelector('meta[name="hp-build"]')?.getAttribute('content') ?? ''
  } catch { return '' }
}

// Notschalter: zurück zur alten Navigation. Setzt hp_shell = 'off' und lädt neu.
export function switchToLegacyNav(): void {
  writeLocal(LS_SHELL, 'off')
  window.location.reload()
}

const ITEM =
  'flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-body text-gray-700 hover:bg-gray-50 ' +
  'focus:outline-none focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-hp-navy/40'

const PANEL_ID = 'hp-profile-menu'

// Profil-Menü oben rechts (ab md). Auf dem Telefon stehen dieselben Punkte im
// Mehr-Blatt. Bewusst ein einfaches Aufklapp-Feld (aria-expanded) statt
// role="menu": So bleibt die normale Tab-Reihenfolge erhalten.
export default function ProfileMenu({ profile }: ProfileMenuProps) {
  const { t } = useTranslation()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const buildId = readBuildId()

  // Klick außerhalb und Escape schließen das Menü
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Jede Navigation schließt das Menü
  useEffect(() => { setOpen(false) }, [location.pathname])

  const handleSignOut = () => {
    if (loggingOut) return
    setLoggingOut(true)
    void signOutAndReset()
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={t('shell.a11y.profileMenu')}
        className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm font-body text-gray-700 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-hp-navy text-xs font-semibold text-hp-cream">
          {initialsOf(profile)}
        </span>
        <span className="hidden max-w-[140px] truncate lg:inline">{profile.full_name || profile.email}</span>
        <Icon name="chevronDown" size={14} className="hidden text-gray-400 lg:block" />
      </button>

      {open && (
        <div
          id={PANEL_ID}
          className="absolute right-0 top-full z-30 mt-2 w-64 overflow-hidden rounded-xl border border-gray-100 bg-white py-1 shadow-lg"
        >
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="truncate text-sm font-semibold font-body text-hp-black">{profile.full_name || profile.email}</p>
            <p className="truncate text-xs font-body text-gray-500">{profile.email}</p>
            <span className={`mt-2 inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold font-body ${ROLE_META[profile.role].color}`}>
              {t(`roles.${profile.role}`)}
            </span>
          </div>

          <Link to="/profile" className={ITEM}>
            <Icon name="user" size={16} className="text-gray-400" />
            {t('shell.profile.profile')}
          </Link>
          <button type="button" onClick={switchToLegacyNav} title={t('shell.profile.legacyNavHint')} className={ITEM}>
            <Icon name="menu" size={16} className="text-gray-400" />
            {t('shell.profile.legacyNav')}
          </button>
          <button type="button" onClick={handleSignOut} disabled={loggingOut} className={`${ITEM} disabled:opacity-60`}>
            <Icon name="logout" size={16} className="text-gray-400" />
            {loggingOut ? t('shell.profile.loggingOut') : t('shell.profile.logout')}
          </button>

          {buildId && (
            <p
              className="border-t border-gray-100 px-4 pb-1.5 pt-2 text-[10px] font-body tabular-nums text-gray-400 select-all"
              title={t('nav.buildIdTitle')}
            >
              {t('shell.profile.buildId')} {buildId}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
