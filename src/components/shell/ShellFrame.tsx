import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { matchEntry } from '../../lib/navigation'
import type { Profile } from '../../lib/permissions'
import BottomBar from './BottomBar'
import MoreSheet from './MoreSheet'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import { LS_SIDEBAR, ZERO_BADGES, readLocal, useShell, writeLocal, type NavBadges } from './ShellContext'
import { useMediaQuery } from './useMediaQuery'

interface ShellFrameProps {
  profile: Profile
  // Zähler an Menüeinträgen. Ohne Angabe kommen sie aus dem ShellContext
  // (AppShell), ohne Context sind sie 0 (z.B. Dev-Vorschau).
  badges?: NavBadges
  children: ReactNode
}

type SidebarMode = 'rail' | 'full'

// Rahmen der neuen Navigation, reine Darstellung:
//   unter md:  obere Leiste + Inhalt + Telefon-Leiste unten (mit "Mehr"-Blatt)
//   md bis xl: schmale Icon-Leiste links + obere Leiste + Inhalt. Die Leiste
//              lässt sich vorübergehend ÜBER den Inhalt ausklappen (nicht
//              gemerkt; schließt bei Seitenwechsel, Escape, Klick daneben).
//   ab xl:     volle Seitenleiste links (einklappbar, gemerkt in hp_sidebar)
// Seitenleiste (fixed), obere Leiste (sticky) und Telefon-Leiste (fixed) liegen
// auf z-30, die übergelegte Leiste samt Hintergrund auf z-40 (wie das
// Mehr-Blatt: Seiten-Dialoge sind dann nie gleichzeitig offen). Das Dokument
// scrollt als Ganzes, der Inhalt hat KEINEN eigenen Scroll-Container (Anker,
// scrollTo und fixierte Seiten-Elemente bleiben wie bisher).
//
// --hp-bottom-offset: Höhe der Telefon-Leiste (56 px = BOTTOM_BAR_PX plus
// Safe-Area), ab md 0. globals.css schiebt damit Toasts im Shell-Inhalt hoch.
// --hp-top-offset: Höhe der oberen Leiste (56 px = TOP_BAR_PX, Tailwind h-14).
// globals.css schiebt damit Toasts oben rechts unter die Leiste.
export default function ShellFrame({ profile, badges, children }: ShellFrameProps) {
  const { t } = useTranslation()
  const location = useLocation()
  const shell = useShell()
  const navBadges = badges ?? shell?.badges ?? ZERO_BADGES

  const isXl = useMediaQuery('(min-width: 1280px)')
  const isMd = useMediaQuery('(min-width: 768px)')
  const [mode, setMode] = useState<SidebarMode>(() => (readLocal(LS_SIDEBAR) === 'rail' ? 'rail' : 'full'))
  const [moreOpen, setMoreOpen] = useState(false)
  // md bis xl: Leiste vorübergehend über dem Inhalt ausgeklappt
  const [flyout, setFlyout] = useState(false)
  // Ab xl steht die volle Leiste neben dem Inhalt
  const docked = isXl && mode === 'full'
  const flyoutOpen = isMd && !isXl && flyout
  const expanded = docked || flyoutOpen

  const activeEntry = matchEntry(location.pathname, profile)
  const activeId = activeEntry?.id ?? null

  const toggleSidebar = useCallback(() => {
    if (!isXl) {
      setFlyout(prev => !prev)
      return
    }
    setMode(prev => {
      const next: SidebarMode = prev === 'full' ? 'rail' : 'full'
      writeLocal(LS_SIDEBAR, next)
      return next
    })
  }, [isXl])
  const closeFlyout = useCallback(() => setFlyout(false), [])

  const openMore = useCallback(() => setMoreOpen(prev => !prev), [])
  const closeMore = useCallback(() => setMoreOpen(false), [])

  // Jede Navigation schließt das Blatt und die übergelegte Leiste; ab md gibt
  // es das Blatt nicht, die übergelegte Leiste nur von md bis xl
  useEffect(() => {
    setMoreOpen(false)
    setFlyout(false)
  }, [location.pathname])
  useEffect(() => { if (isMd) setMoreOpen(false) }, [isMd])
  useEffect(() => { if (isXl || !isMd) setFlyout(false) }, [isXl, isMd])

  // Escape schließt die übergelegte Leiste
  useEffect(() => {
    if (!flyoutOpen) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setFlyout(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [flyoutOpen])

  return (
    <div className="min-h-screen bg-hp-cream font-body text-hp-black [--hp-top-offset:56px] [--hp-bottom-offset:calc(56px+env(safe-area-inset-bottom,0px))] md:[--hp-bottom-offset:0px]">
      {/* Sprungmarke für Tastatur und Screenreader. Ohne Hash in der Adresse,
          damit der Router keinen Seitenwechsel sieht. */}
      <a
        href="#hp-shell-main"
        onClick={e => {
          e.preventDefault()
          document.getElementById('hp-shell-main')?.focus()
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-40 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-hp-navy focus:shadow-lg"
      >
        {t('shell.a11y.skip')}
      </a>

      {/* Hintergrund der übergelegten Leiste: Klick daneben schließt. Steht vor
          der Leiste im Dokument, beide auf z-40, die Leiste liegt also oben. */}
      {flyoutOpen && <div aria-hidden="true" onClick={closeFlyout} className="fixed inset-0 z-40 bg-hp-navy/40" />}

      <Sidebar
        profile={profile}
        badges={navBadges}
        activeId={activeId}
        expanded={expanded}
        overlay={flyoutOpen}
        onToggle={toggleSidebar}
        onNavigate={closeFlyout}
      />

      {/* Abstand links = Breite der Leiste neben dem Inhalt plus Safe-Area */}
      <div
        className={`transition-[padding] duration-200 ${
          docked ? 'md:pl-[calc(16rem+env(safe-area-inset-left))]' : 'md:pl-[calc(4rem+env(safe-area-inset-left))]'
        }`}
      >
        <TopBar profile={profile} activeEntry={activeEntry} />
        <main id="hp-shell-main" tabIndex={-1} className="pb-[var(--hp-bottom-offset)] focus:outline-none">
          {children}
        </main>
      </div>

      <BottomBar profile={profile} badges={navBadges} activeId={activeId} moreOpen={moreOpen} onMore={openMore} />
      {moreOpen && <MoreSheet profile={profile} badges={navBadges} activeId={activeId} onClose={closeMore} />}
    </div>
  )
}
