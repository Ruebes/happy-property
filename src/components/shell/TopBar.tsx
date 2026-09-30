import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { lazyWithReload } from '../../lib/lazyWithReload'
import type { Profile } from '../../lib/permissions'
import type { NavEntry } from '../../lib/navigation'
import LanguageSwitcher from '../LanguageSwitcher'
import ContentErrorBoundary from './ContentErrorBoundary'
import Icon from './Icon'
import ProfileMenu from './ProfileMenu'
import { PaletteBridgeContext, shellHome } from './ShellContext'

// Die Suche liegt in einem eigenen Chunk. Er wird kurz nach dem Start der Shell
// im Hintergrund geholt (siehe PRELOAD_MS), nicht erst beim ersten Öffnen.
const CommandPalette = lazyWithReload(() => import('./CommandPalette'))

// Wartezeit, bis der Such-Chunk im Hintergrund geladen wird. Gründe fürs
// Vorladen: (1) In einem lange offenen Tab gäbe es den Chunk nach einem Deploy
// nicht mehr; lazyWithReload würde dann beim Öffnen der Suche die Seite neu
// laden und ungespeicherte Eingaben verwerfen. (2) Auf dem iPhone öffnet sich
// die Tastatur nur, wenn das Feld direkt im Tipp den Fokus bekommt; dafür muss
// der Code schon da sein.
const PRELOAD_MS = 1500

interface TopBarProps {
  profile: Profile
  // Aktiver Menüeintrag (aus matchEntry), liefert den Seitentitel
  activeEntry: NavEntry | null
}

function isApplePlatform(): boolean {
  try { return /Mac|iPhone|iPad/.test(navigator.platform) } catch { return false }
}

// Obere Leiste: weiß mit Linie unten, bleibt beim Scrollen stehen (sticky).
//   unter md: Logo + Seitentitel + Upload (nur Admin) + Such-Icon
//             (Navigation macht die Telefon-Leiste)
//   ab md:    Suchfeld + Sprache + Profil-Menü (den Titel zeigt die Seite selbst)
// Das Suchfeld ist bewusst ein Knopf im Feld-Look: Es öffnet die Suche per
// Klick, Enter oder Cmd+K / Strg+K. Ein Eingabefeld, das schon beim Fokus per
// Tab einen Dialog öffnet, wäre für Tastaturnutzer eine Falle.
export default function TopBar({ profile, activeEntry }: TopBarProps) {
  const { t } = useTranslation()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteReady, setPaletteReady] = useState(false)

  // Such-Chunk im Hintergrund vorladen: Die CommandPalette wird ohne Brücke
  // gerendert (zeigt dann nichts), das lädt ihren Code über lazyWithReload.
  useEffect(() => {
    const id = window.setTimeout(() => setPaletteReady(true), PRELOAD_MS)
    return () => window.clearTimeout(id)
  }, [])

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
  const uploadLabel = t('shell.nav.ownerContent')
  const shortcut = isApplePlatform() ? '⌘K' : t('shell.search.shortcutCtrl')

  return (
    <header className="sticky top-0 z-30 border-b border-gray-100 bg-white">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        {/* Telefon: Logo (ab md sitzt es in der Seitenleiste) */}
        <Link
          to={shellHome(profile)}
          aria-label={t('shell.a11y.home')}
          className="shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40 md:hidden"
        >
          <img src="/logo.jpg" alt="" width={32} height={32} className="h-8 w-8 rounded-lg object-cover" />
        </Link>

        {/* Telefon: Seitentitel in Playfair. Kein h1: die Seiten bringen ihre
            eigene Überschrift mit. Ab md steht hier nur ein Abstandhalter, sonst
            stünde der Name der Seite zweimal untereinander. */}
        <p className="min-w-0 flex-1 truncate font-heading text-lg text-hp-navy md:hidden">{title}</p>
        <div className="hidden flex-1 md:block" />

        {/* Telefon, nur Admin: Upload für die Eigentümer mit einem Tipp, wie in
            der alten Kopfzeile (Wunsch vom 15.8.26). Ab md liegt die Seite einen
            Klick entfernt in der Seitenleiste. */}
        {profile.role === 'admin' && (
          <Link
            to="/admin/crm/owner-content"
            aria-label={uploadLabel}
            title={uploadLabel}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-hp-navy hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/40 md:hidden"
          >
            <Icon name="upload" size={22} />
          </Link>
        )}

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
          <kbd className="shrink-0 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium font-body text-gray-500">
            {shortcut}
          </kbd>
        </button>

        <div className="hidden shrink-0 items-center gap-2 md:flex">
          <LanguageSwitcher tone="shell" />
          <ProfileMenu profile={profile} />
        </div>
      </div>

      {/* Suche. Ohne Brücke (geschlossen) rendert die CommandPalette nichts, ihr
          Code ist dann aber schon geladen. Eigene Fehlergrenze: Lässt sich die
          Suche nicht laden, fällt nur sie aus, nicht der ganze Rahmen. */}
      {(paletteOpen || paletteReady) && (
        <ContentErrorBoundary scope="Suche" fallback={null}>
          <PaletteBridgeContext.Provider value={paletteOpen ? bridge : null}>
            <Suspense fallback={null}>
              <CommandPalette />
            </Suspense>
          </PaletteBridgeContext.Provider>
        </ContentErrorBoundary>
      )}
    </header>
  )
}
