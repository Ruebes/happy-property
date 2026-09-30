import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { lazyWithReload } from '../../lib/lazyWithReload'
import { landingFor, type Profile } from '../../lib/permissions'
import type { NavEntry } from '../../lib/navigation'
import LanguageSwitcher from '../LanguageSwitcher'
import Icon from './Icon'
import ProfileMenu from './ProfileMenu'
import { PaletteBridgeContext } from './ShellContext'

// Die Suche wird erst beim ersten Öffnen geladen (eigener Chunk).
const CommandPalette = lazyWithReload(() => import('./CommandPalette'))

interface TopBarProps {
  profile: Profile
  // Aktiver Menüeintrag (aus matchEntry), liefert den Seitentitel
  activeEntry: NavEntry | null
}

function isApplePlatform(): boolean {
  try { return /Mac|iPhone|iPad/.test(navigator.platform) } catch { return false }
}

// Obere Leiste: weiß mit Linie unten, bleibt beim Scrollen stehen (sticky).
//   unter md: Logo + Seitentitel + Such-Icon (Navigation macht die Telefon-Leiste)
//   ab md:    Seitentitel + Suchfeld + Sprache + Profil-Menü
// Das Suchfeld ist bewusst ein Knopf im Feld-Look: Es öffnet die Suche per
// Klick, Enter oder Cmd+K / Strg+K. Ein Eingabefeld, das schon beim Fokus per
// Tab einen Dialog öffnet, wäre für Tastaturnutzer eine Falle.
export default function TopBar({ profile, activeEntry }: TopBarProps) {
  const { t } = useTranslation()
  const [paletteOpen, setPaletteOpen] = useState(false)

  const openPalette = useCallback(() => setPaletteOpen(true), [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])

  // Cmd+K (Mac) bzw. Strg+K öffnet und schließt die Suche von überall
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(prev => !prev)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const bridge = useMemo(() => ({ profile, onClose: closePalette }), [profile, closePalette])
  const title = activeEntry ? t(activeEntry.labelKey) : ''
  const shortcut = isApplePlatform() ? '⌘K' : t('shell.search.shortcutCtrl')

  return (
    <header className="sticky top-0 z-30 border-b border-gray-100 bg-white">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        {/* Telefon: Logo (ab md sitzt es in der Seitenleiste) */}
        <Link
          to={landingFor(profile)}
          aria-label={t('shell.a11y.home')}
          className="shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40 md:hidden"
        >
          <img src="/logo.jpg" alt="" width={32} height={32} className="h-8 w-8 rounded-lg object-cover" />
        </Link>

        {/* Seitentitel in Playfair. Kein h1: die Seiten bringen ihre eigene Überschrift mit. */}
        <p className="min-w-0 flex-1 truncate font-heading text-lg text-hp-navy md:text-xl">{title}</p>

        {/* Telefon: Such-Icon, 44 px Tippfläche */}
        <button
          type="button"
          onClick={openPalette}
          aria-label={t('shell.search.open')}
          aria-haspopup="dialog"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40 md:hidden"
        >
          <Icon name="search" size={22} />
        </button>

        {/* Ab md: Suchfeld */}
        <button
          type="button"
          onClick={openPalette}
          aria-label={t('shell.search.open')}
          aria-haspopup="dialog"
          aria-keyshortcuts="Meta+K Control+K"
          className="hidden h-9 w-56 shrink-0 items-center gap-2 rounded-lg border border-gray-200 bg-hp-cream px-3 text-left text-sm font-body text-gray-500 transition-colors hover:border-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40 md:flex lg:w-72"
        >
          <Icon name="search" size={16} className="shrink-0 text-gray-400" />
          <span className="min-w-0 flex-1 truncate">{t('shell.search.placeholder')}</span>
          <kbd className="shrink-0 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium font-body text-gray-400">
            {shortcut}
          </kbd>
        </button>

        <div className="hidden shrink-0 items-center gap-2 md:flex">
          <LanguageSwitcher />
          <ProfileMenu profile={profile} />
        </div>
      </div>

      {paletteOpen && (
        <PaletteBridgeContext.Provider value={bridge}>
          <Suspense fallback={null}>
            <CommandPalette />
          </Suspense>
        </PaletteBridgeContext.Provider>
      )}
    </header>
  )
}
