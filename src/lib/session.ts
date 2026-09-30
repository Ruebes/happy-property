// Abmelden an EINER Stelle: alte und neue Navigation rufen dieselbe Funktion.
// Ablauf unverändert aus DashboardLayout.handleSignOut übernommen:
// Promise.race stellt sicher, dass signOut() nie ewig hängt (Netzwerkproblem,
// abgelaufene Session). Nach 2 s Timeout wird trotzdem sauber weitergeleitet.
import { supabase } from './supabase'

// Diese Schlüssel überleben das Abmelden (Geräte-Einstellungen, keine
// Sitzungsdaten): Alles andere im localStorage wird wie bisher geleert.
export const LOGOUT_KEEP_KEYS: readonly string[] = [
  'hp_internal_viewer',
  'crm_dashboard_widgets',
  'hp_quick_tiles_v1',
  'hp_sidebar',
  'hp_navgroups',
  'hp_shell',
]

let signingOut = false

// localStorage leeren, die Geräte-Einstellungen aber behalten
// (lesen, leeren, zurückschreiben).
function clearLocalStorageKeeping(keys: readonly string[]): void {
  const kept: [string, string][] = []
  try {
    for (const key of keys) {
      const value = localStorage.getItem(key)
      if (value !== null) kept.push([key, value])
    }
  } catch { /* localStorage blockiert: dann gibt es nichts zu retten */ }
  try { localStorage.clear() } catch { /* ignorieren */ }
  for (const [key, value] of kept) {
    try { localStorage.setItem(key, value) } catch { /* ignorieren */ }
  }
}

export async function signOutAndReset(): Promise<void> {
  if (signingOut) return
  signingOut = true
  try {
    await Promise.race([
      supabase.auth.signOut(),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ])
  } catch { /* ignorieren */ }
  finally {
    clearLocalStorageKeeping(LOGOUT_KEEP_KEYS)
    try { sessionStorage.clear() } catch { /* ignorieren */ }
    window.location.href = '/login'
  }
}
