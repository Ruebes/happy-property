import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../lib/auth'
import { isShellOff, isShellRole, switchToNewNav } from '../lib/shellSwitch'
import LegacyDashboardLayout from './LegacyDashboardLayout'
import { useShell } from './shell/ShellContext'

interface Props {
  children: ReactNode
  // Nur die alte Navigation braucht den Pfad (Logo-Link, Start-Eintrag). In der
  // neuen Shell kommt die Navigation aus der Registry (src/lib/navigation.ts).
  basePath?: string
}

// Weg zurück zur neuen Navigation. Erscheint als schmale Zeile über der alten
// Navigation, aber nur wenn jemand mit freigeschalteter Rolle die neue
// Navigation selbst abgeschaltet hat (hp_shell = 'off'). Ohne diese Zeile gäbe
// es nach "Alte Navigation" keinen sichtbaren Rückweg, auch nicht nach dem
// Abmelden (der Schlüssel überlebt es).
function NewNavBar() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-end gap-3 bg-hp-navy px-4 py-1.5 text-xs font-body text-hp-cream sm:px-6">
      <span className="truncate text-hp-cream/70">{t('shell.profile.legacyActive')}</span>
      <button
        type="button"
        onClick={switchToNewNav}
        className="shrink-0 rounded-md border border-hp-cream/40 px-3 py-1.5 font-semibold transition-colors hover:bg-hp-cream/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-cream/70"
      >
        {t('shell.profile.newNav')}
      </button>
    </div>
  )
}

// Durchreicher: Jede Seite umschließt ihren Inhalt weiter mit <DashboardLayout>.
//   In der neuen Shell (AppShell liefert einen ShellContext) bleibt davon nur
//   der Inhaltsrahmen übrig, Navigation und Kopfzeile stellt die Shell.
//   Ohne Shell (Notschalter hp_shell = 'off', Rolle noch nicht freigeschaltet,
//   Profil lädt noch) erscheint unverändert die alte Navigation.
// Breite und Abstände des Inhaltsrahmens entsprechen dem <main> der alten
// Navigation, damit die Seiten innen gleich aussehen. Die Klasse
// hp-shell-content braucht globals.css, um Hinweise am unteren Rand über die
// Telefon-Leiste zu schieben.
export default function DashboardLayout({ children, basePath }: Props) {
  const shell = useShell()
  const { dashboardPath, profile } = useAuth()
  const [shellOff] = useState(isShellOff)

  if (shell) {
    return (
      <div className="hp-shell-content max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 md:py-8">
        {children}
      </div>
    )
  }

  // Die alte Navigation steht immer an derselben Stelle im Baum, mit oder ohne
  // Zeile darüber: Kommt das Profil erst später, wird die Seite nicht neu aufgebaut.
  const showNewNavBar = shellOff && isShellRole(profile?.role)
  return (
    <>
      {showNewNavBar && <NewNavBar />}
      <LegacyDashboardLayout basePath={basePath ?? dashboardPath}>{children}</LegacyDashboardLayout>
    </>
  )
}
