import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { lazyWithReload } from '../lib/lazyWithReload'
import { isShellRole, readShellOff } from '../lib/shellSwitch'

// Der gesamte Shell-Code (Rahmen, Seitenleiste, Zähler, Icons) liegt in einem
// eigenen Chunk und wird nur geladen, wenn die Shell wirklich erscheint.
const AppShell = lazyWithReload(() => import('./shell/AppShell'))

// Nur im Dev-Server mit Mock-Anmeldung (src/dev/DevMockAuthProvider): jede Rolle
// bekommt die Shell, damit sich echte Seiten vor der Freischaltung ansehen
// lassen. Im Produktions-Build ist der Ausdruck fest false und fällt weg.
function devMockActive(): boolean {
  try { return sessionStorage.getItem('hp_mock_role') !== null } catch { return false }
}
const DEV_MOCK_ANY_ROLE = import.meta.env.DEV && devMockActive()

// Fällt die neue Navigation aus (Chunk nicht ladbar, Fehler im Shell-Code),
// übernimmt die alte Navigation, statt dass die App weiß wird.
class GateBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[shell] Neue Navigation ausgefallen, die alte übernimmt:', error, info.componentStack)
  }

  render(): ReactNode {
    return this.state.failed ? <Outlet /> : this.props.children
  }
}

// Weiche vor der neuen Navigation, Routen-Element um alle angemeldeten Bereiche
// (siehe src/App.tsx). Bewusst klein und ohne Importe aus ./shell: Die
// Entscheidung fällt, BEVOR Shell-Code geladen wird.
//   Shell aus:   nur <Outlet/>. DashboardLayout zeigt dann die alte Navigation,
//                alles verhält sich wie bisher (ShellContext ist ohne Provider null).
//   Shell aktiv: AppShell (eigener Chunk) hinter einer Fehlergrenze.
// Shell aus gilt bei hp_shell = 'off', bei Rollen außerhalb von SHELL_ROLES und
// solange das Profil noch lädt (dann ist die Rolle unbekannt).
//
// Bekannte Grenze: Kommt das Profil erst nach dem ersten Rendern (Sitzung ohne
// Profil-Cache, selten), erscheint die Seite kurz mit der alten Navigation und
// wird beim Wechsel in die Shell einmal neu aufgebaut. So steht es im
// Shell-Vertrag ("Profil lädt: nur Outlet"); alle anderen Rollen bleiben dadurch
// exakt beim heutigen Verhalten.
export default function ShellGate() {
  const { profile } = useAuth()
  const [shellOff] = useState(readShellOff)

  const active = !shellOff && !!profile && (DEV_MOCK_ANY_ROLE || isShellRole(profile.role))
  if (!active) return <Outlet />

  return (
    <GateBoundary>
      <AppShell />
    </GateBoundary>
  )
}
