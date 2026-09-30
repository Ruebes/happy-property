// Notschalter der neuen Navigation: reines TypeScript, ohne React und ohne
// Importe aus src/components/shell. So kann die Weiche (ShellGate) im
// Hauptbündel entscheiden, ob der Shell-Code überhaupt geladen wird, und die
// alte Navigation kann den Weg zurück anbieten.
import type { UserRole } from './permissions'

// localStorage-Schlüssel: 'off' = alte Navigation. Steht auch in
// src/lib/session.ts (LOGOUT_KEEP_KEYS) und überlebt das Abmelden.
export const LS_SHELL = 'hp_shell'

// Die neue Navigation gilt nur für diese Rollen. Alle anderen sehen unverändert
// die alte Navigation (LegacyDashboardLayout). Weitere Rollen kommen erst dazu,
// wenn sie geprüft sind.
export const SHELL_ROLES: readonly UserRole[] = ['admin']

export function isShellRole(role: UserRole | null | undefined): boolean {
  return !!role && SHELL_ROLES.includes(role)
}

// Den Knopf "Alte Navigation" (Profil-Menü, Mehr-Blatt) sehen nur diese Rollen.
// Verwalter, Funnel-Zugänge und Eigentümer bekommen ihn nicht angeboten: Für
// sie ist die alte Navigation kein Arbeitsweg, nur ein Notausgang (der
// Adress-Schalter unten bleibt für den Notfall).
export const LEGACY_SWITCH_ROLES: readonly UserRole[] = ['admin', 'mitarbeiter']

export function canSwitchToLegacyNav(role: UserRole | null | undefined): boolean {
  return !!role && LEGACY_SWITCH_ROLES.includes(role)
}

// Schalter über die Adresse, falls kein Knopf erreichbar ist:
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

// Ist die neue Navigation auf diesem Gerät abgeschaltet? Ohne Speicherzugriff
// (privater Modus) gilt der Standard: eingeschaltet.
export function isShellOff(): boolean {
  try { return localStorage.getItem(LS_SHELL) === 'off' } catch { return false }
}

// Wie isShellOff, wertet vorher den Adress-Schalter aus. Einmal beim Start der
// Weiche aufrufen.
export function readShellOff(): boolean {
  applyUrlSwitch()
  return isShellOff()
}

// Zur alten Navigation wechseln: hp_shell = 'off' und neu laden.
export function switchToLegacyNav(): void {
  try { localStorage.setItem(LS_SHELL, 'off') } catch { /* privater Modus: es bleibt bei der neuen Navigation */ }
  window.location.reload()
}

// Zurück zur neuen Navigation: Schlüssel entfernen und neu laden.
export function switchToNewNav(): void {
  try { localStorage.removeItem(LS_SHELL) } catch { /* ignorieren */ }
  window.location.reload()
}
