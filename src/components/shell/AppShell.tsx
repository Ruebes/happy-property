import { Suspense, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../lib/auth'
import type { UserRole } from '../../lib/permissions'
import AppointmentPrepPopup from '../crm/AppointmentPrepPopup'
import TaskNotifications from '../crm/TaskNotifications'
import ContentErrorBoundary from './ContentErrorBoundary'
import ShellFrame from './ShellFrame'
import { BOTTOM_BAR_PX, LS_SHELL, ShellContext, readLocal, type ShellContextValue } from './ShellContext'
import { useMediaQuery } from './useMediaQuery'
import { useNavBadges } from './useNavBadges'

// ── Notschalter ──────────────────────────────────────────────────────────────
// Die neue Navigation gilt nur für diese Rollen. Alle anderen sehen unverändert
// die alte Navigation (LegacyDashboardLayout). Weitere Rollen kommen erst dazu,
// wenn sie geprüft sind.
const SHELL_ROLES: UserRole[] = ['admin']

// Nur im Dev-Server mit Mock-Anmeldung (src/dev/DevMockAuthProvider): jede Rolle
// bekommt die Shell, damit sich echte Seiten vor der Freischaltung ansehen
// lassen. Im Produktions-Build ist der Ausdruck fest false und fällt weg.
function devMockActive(): boolean {
  try { return sessionStorage.getItem('hp_mock_role') !== null } catch { return false }
}
const DEV_MOCK_ANY_ROLE = import.meta.env.DEV && devMockActive()

// Schalter über die Adresse, falls das Profil-Menü nicht erreichbar ist:
//   ?hp_shell=off  alte Navigation (wie "Alte Navigation" im Profil-Menü)
//   ?hp_shell=on   zurück zur neuen Navigation
// Der Parameter wird übernommen und gleich wieder aus der Adresse entfernt,
// damit ein späteres Neuladen die Wahl nicht überschreibt.
function applyUrlSwitch(): void {
  try {
    const url = new URL(window.location.href)
    const value = url.searchParams.get(LS_SHELL)
    if (value !== 'on' && value !== 'off') return
    if (value === 'off') localStorage.setItem(LS_SHELL, 'off')
    else localStorage.removeItem(LS_SHELL)
    url.searchParams.delete(LS_SHELL)
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  } catch { /* ohne Speicherzugriff bleibt es beim Standard */ }
}

function readShellOff(): boolean {
  applyUrlSwitch()
  return readLocal(LS_SHELL) === 'off'
}

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

// Routen-Element um alle angemeldeten Bereiche (siehe src/App.tsx).
//   Shell aktiv:  ShellContext + ShellFrame (Seitenleiste, Kopfzeile,
//                 Telefon-Leiste), die Seite erscheint im Inhaltsbereich.
//   Shell aus:    nur <Outlet/> mit Context null. DashboardLayout zeigt dann
//                 die alte Navigation, alles verhält sich wie bisher.
// Shell aus gilt bei hp_shell = 'off', bei Rollen außerhalb von SHELL_ROLES und
// solange das Profil noch lädt (dann ist die Rolle unbekannt).
export default function AppShell() {
  const { profile } = useAuth()
  const { pathname } = useLocation()
  const [shellOff] = useState(readShellOff)

  const active = !shellOff && !!profile && (DEV_MOCK_ANY_ROLE || SHELL_ROLES.includes(profile.role))

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

  // --hp-bottom-offset: Höhe der Telefon-Leiste, ab md 0. ShellFrame setzt den
  // Wert für seinen eigenen Bereich. Hier zusätzlich am Dokument, damit auch
  // Elemente außerhalb des Rahmens (Portale am body) ihn lesen können.
  const isMd = useMediaQuery('(min-width: 768px)')
  useEffect(() => {
    if (!active) return
    const root = document.documentElement
    root.style.setProperty(
      '--hp-bottom-offset',
      isMd ? '0px' : `calc(${BOTTOM_BAR_PX}px + env(safe-area-inset-bottom, 0px))`,
    )
    return () => { root.style.removeProperty('--hp-bottom-offset') }
  }, [active, isMd])

  const legacy = (
    <ShellContext.Provider value={null}>
      <Outlet />
    </ShellContext.Provider>
  )

  if (!active || !profile) return legacy

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
