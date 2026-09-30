import { Suspense, useEffect, useMemo, useRef } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../lib/auth'
import AppointmentPrepPopup from '../crm/AppointmentPrepPopup'
import TaskNotifications from '../crm/TaskNotifications'
import ContentErrorBoundary from './ContentErrorBoundary'
import ShellFrame from './ShellFrame'
import { BOTTOM_BAR_PX, ShellContext, TOP_BAR_PX, type ShellContextValue } from './ShellContext'
import { useMediaQuery } from './useMediaQuery'
import { useNavBadges } from './useNavBadges'

// Ladeanzeige im Inhaltsbereich: Navigation und Kopfzeile bleiben stehen,
// während der Code der Seite nachgeladen wird.
function ContentLoader() {
  const { t } = useTranslation()
  return (
    <div role="status" aria-label={t('shell.loading')} className="flex items-center justify-center py-24">
      <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-hp-highlight" />
    </div>
  )
}

// Die neue Navigation. Wird von der Weiche src/components/ShellGate.tsx nur
// gerendert, wenn die Shell wirklich gilt (Rolle freigeschaltet, Notschalter
// hp_shell nicht 'off', Profil geladen). Die Entscheidung selbst steht dort,
// damit dieser Chunk für alle anderen gar nicht erst geladen wird.
//   ShellContext + ShellFrame (Seitenleiste, Kopfzeile, Telefon-Leiste), die
//   Seite erscheint im Inhaltsbereich.
export default function AppShell() {
  const { profile } = useAuth()
  const { pathname } = useLocation()

  // Die Weiche rendert die Shell nur mit Profil. Fällt es weg (Abmelden), bleibt
  // bis zum Abbau nur die durchgereichte Seite.
  const active = !!profile

  // Zähler nur laden, wenn die Shell sie auch zeigt
  const { badges, refresh } = useNavBadges(active ? profile : null)
  const context = useMemo<ShellContextValue>(
    () => ({ inShell: true, badges, refreshBadges: refresh }),
    [badges, refresh],
  )

  // Seitenwechsel beginnt oben (das Dokument scrollt als Ganzes)
  useEffect(() => {
    if (active) window.scrollTo(0, 0)
  }, [active, pathname])

  // Zähler bei jedem Seitenwechsel auffrischen (nicht beim ersten Rendern, das
  // macht der Hook selbst). So verschwindet z.B. der Punkt am Posteingang beim
  // Verlassen der Seite und nicht erst mit dem nächsten 60-s-Takt.
  const lastPathRef = useRef(pathname)
  useEffect(() => {
    if (lastPathRef.current === pathname) return
    lastPathRef.current = pathname
    refresh()
  }, [pathname, refresh])

  // --hp-bottom-offset: Höhe der Telefon-Leiste, ab md 0. ShellFrame setzt den
  // Wert für seinen eigenen Bereich. Hier zusätzlich am Dokument, damit auch
  // Elemente außerhalb des Rahmens (Portale am body) ihn lesen können.
  //
  // scroll-padding: Die obere Leiste bleibt beim Scrollen stehen (die alte
  // Kopfzeile tat das nicht). Seiten, die per scrollIntoView an eine Stelle
  // springen (z.B. Reiter im Kunden-Detail), und der Tastatur-Fokus landen
  // damit unter der Leiste statt dahinter, auf dem Telefon über der unteren.
  const isMd = useMediaQuery('(min-width: 768px)')
  useEffect(() => {
    if (!active) return
    const root = document.documentElement
    root.style.setProperty(
      '--hp-bottom-offset',
      isMd ? '0px' : `calc(${BOTTOM_BAR_PX}px + env(safe-area-inset-bottom, 0px))`,
    )
    root.style.setProperty('scroll-padding-top', `${TOP_BAR_PX}px`)
    root.style.setProperty('scroll-padding-bottom', 'var(--hp-bottom-offset, 0px)')
    return () => {
      root.style.removeProperty('--hp-bottom-offset')
      root.style.removeProperty('scroll-padding-top')
      root.style.removeProperty('scroll-padding-bottom')
    }
  }, [active, isMd])

  const legacy = (
    <ShellContext.Provider value={null}>
      <Outlet />
    </ShellContext.Provider>
  )

  if (!profile) return legacy

  return (
    <ShellContext.Provider value={context}>
      {/* Fällt der Rahmen selbst aus (Seitenleiste, Kopfzeile), übernimmt die
          alte Navigation, statt dass die App weiß wird. */}
      <ContentErrorBoundary scope="Shell-Rahmen" fallback={legacy}>
        <ShellFrame profile={profile}>
          <ContentErrorBoundary key={pathname}>
            <Suspense fallback={<ContentLoader />}>
              <Outlet />
            </Suspense>
          </ContentErrorBoundary>

          {/* Wie bisher in der alten Navigation: Termin-Vorbereitung nur für
              Admin, Aufgaben-Popups für alle Mitarbeitenden (die Komponente
              prüft die Rolle selbst). hp-shell-content hebt die Popups auf dem
              Telefon über die untere Leiste. */}
          <ContentErrorBoundary scope="Popups" fallback={null}>
            <div className="hp-shell-content">
              {profile.role === 'admin' && <AppointmentPrepPopup />}
              <TaskNotifications />
            </div>
          </ContentErrorBoundary>
        </ShellFrame>
      </ContentErrorBoundary>
    </ShellContext.Provider>
  )
}
