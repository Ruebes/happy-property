import { createContext, useContext } from 'react'
import { landingFor, type Profile } from '../../lib/permissions'

// Zähler an Menüeinträgen (NavEntry.badge). Eine Quelle für Sidebar,
// Telefon-Leiste und Mehr-Blatt: der Hook useNavBadges, verteilt über den
// ShellContext.
export interface NavBadges {
  tasksOpen: number
  inboxUnread: number
}

export const ZERO_BADGES: NavBadges = { tasksOpen: 0, inboxUnread: 0 }

// Wert des ShellContext. Ist er null, läuft die Seite NICHT in der neuen Shell
// (Notschalter hp_shell = 'off', Rolle noch nicht freigeschaltet, Profil lädt):
// dann zeigt DashboardLayout die alte Navigation.
export interface ShellContextValue {
  inShell: true
  badges: NavBadges
  // Zähler sofort neu laden (z.B. nach Erledigen einer Aufgabe)
  refreshBadges: () => void
}

export const ShellContext = createContext<ShellContextValue | null>(null)

export function useShell(): ShellContextValue | null {
  return useContext(ShellContext)
}

// Brücke zur lazy geladenen CommandPalette: lazyWithReload nimmt nur
// Komponenten ohne Pflicht-Props, darum reicht die TopBar Profil und
// Schließen-Funktion über diesen Context hinein.
export interface PaletteBridge {
  profile: Profile
  onClose: () => void
}

export const PaletteBridgeContext = createContext<PaletteBridge | null>(null)

// ── Geräte-Einstellungen der Shell (localStorage) ────────────────────────────
// Schlüssel stehen auch in src/lib/session.ts (LOGOUT_KEEP_KEYS), damit sie
// das Abmelden überleben.
export const LS_SIDEBAR = 'hp_sidebar'      // 'rail' | 'full'
export const LS_NAVGROUPS = 'hp_navgroups'  // JSON-Liste eingeklappter Gruppen
// Der Notschalter hp_shell ('off' = alte Navigation) steht in
// src/lib/shellSwitch.ts, damit die Weiche (ShellGate) und die alte Navigation
// ihn ohne Shell-Code kennen.

export function readLocal(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

export function writeLocal(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* privater Modus: ohne Merken weiter */ }
}

// Höhe der Telefon-Leiste ohne Safe-Area (Tailwind h-14). ShellFrame setzt
// daraus --hp-bottom-offset, globals.css schiebt Toasts um diesen Wert hoch.
export const BOTTOM_BAR_PX = 56

// Höhe der oberen Leiste (Tailwind h-14). Die AppShell setzt daraus
// scroll-padding-top, damit Sprungziele nicht unter der Leiste landen.
export const TOP_BAR_PX = 56

// Ziel des Logos in der Shell. Für Admin fest die CRM-Übersicht: roleToPath
// liest noch 'admin_view' (Umschalter CRM | Verwaltung der alten Navigation),
// den es in der Shell nicht mehr gibt. Ein alter Wert würde das Logo sonst
// dauerhaft auf die Portal-Übersicht legen.
export function shellHome(profile: Profile): string {
  return profile.role === 'admin' ? '/admin/crm' : landingFor(profile)
}

// Zähler eines Menüeintrags (0, wenn der Eintrag kein Badge trägt)
export function badgeCount(entry: { badge?: keyof NavBadges }, badges: NavBadges): number {
  return entry.badge ? badges[entry.badge] : 0
}

// Anzeige im Zähler-Kreis: ab 100 gekürzt
export function formatBadge(count: number): string {
  return count > 99 ? '99+' : String(count)
}
