// ── Portal-Vorschau („Ansicht als") ───────────────────────────────────────────
// Der Admin kann sich das Eigentümer-, Verwaltungs- oder Feriengast-Portal so
// ansehen, wie es eine bestimmte Person sieht. Die Anmeldung bleibt die des
// Admins; nur das Profil, nach dem die Seiten filtern, wird ausgetauscht
// (AuthProvider liefert dann dieses Profil als `profile`).
//
// Sicherheit: Solange die Vorschau läuft, lässt lib/supabase.ts nur lesende
// Anfragen durch (GET/HEAD auf Datenbank und Storage, signierte Download-Links).
// Jede schreibende Anfrage und jeder Function-Aufruf wird im Browser abgewiesen,
// es kann also nichts gespeichert, verschickt oder gelöscht werden.
//
// Gespeichert in sessionStorage: gilt nur für diesen Tab und endet mit ihm.
import type { Profile, UserRole } from './permissions'

export type PreviewRole = Extract<UserRole, 'eigentuemer' | 'verwalter' | 'feriengast'>
export interface PortalPreview {
  role: PreviewRole
  profile: Profile
  label: string          // z.B. „Michael Decker" oder „Muster-Feriengast"
}

const KEY = 'hp_portal_preview'

export function getPreview(): PortalPreview | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as PortalPreview
    return p?.profile?.id && p.role ? p : null
  } catch { return null }
}

export function setPreview(p: PortalPreview | null): void {
  try {
    if (p) sessionStorage.setItem(KEY, JSON.stringify(p))
    else sessionStorage.removeItem(KEY)
  } catch { /* privater Modus: Vorschau geht dann nicht */ }
  window.dispatchEvent(new Event('hp-preview-change'))
}

export const isPreviewActive = () => getPreview() !== null

// Lesende Anfragen, die in der Vorschau erlaubt sind (alles andere wird abgewiesen).
export function previewAllows(url: string, method: string): boolean {
  const m = method.toUpperCase()
  if (url.includes('/auth/v1/')) return true                       // Token-Refresh des Admins
  if (m === 'GET' || m === 'HEAD') return url.includes('/rest/v1/') || url.includes('/storage/v1/')
  if (m === 'POST' && /\/storage\/v1\/object\/sign\//.test(url)) return true // Download-Link erzeugen
  return false
}
