import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth'
import LegacyDashboardLayout from './LegacyDashboardLayout'
import { useShell } from './shell/ShellContext'

interface Props {
  children: ReactNode
  // Nur die alte Navigation braucht den Pfad (Logo-Link, Start-Eintrag). In der
  // neuen Shell kommt die Navigation aus der Registry (src/lib/navigation.ts).
  basePath?: string
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
  const { dashboardPath } = useAuth()

  if (shell) {
    return (
      <div className="hp-shell-content max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 md:py-8">
        {children}
      </div>
    )
  }

  return <LegacyDashboardLayout basePath={basePath ?? dashboardPath}>{children}</LegacyDashboardLayout>
}
