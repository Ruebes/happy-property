// Rollen, Rechte und Rollen-Pfade: reines TypeScript ohne React und ohne
// Supabase-Import. Aus auth.tsx hierher verschoben (Shell-Etappe), damit die
// Navigations-Registry (src/lib/navigation.ts) und Node-Skripte
// (scripts/verify-nav.mjs) sie ohne Browser-Umgebung laden können.
// auth.tsx re-exportiert alles, bestehende Importe bleiben unverändert.
//
// Hinweis roleToPath: liest weiterhin 'admin_view' aus dem localStorage, weil die
// alte Navigation (LegacyDashboardLayout) den CRM|Verwaltung-Umschalter noch
// dort speichert. Erst wenn der Umschalter weg ist, darf die Zeile fallen.

// ── Rollen ─────────────────────────────────────────────────────
export type UserRole = 'admin' | 'verwalter' | 'eigentuemer' | 'feriengast' | 'funnel' | 'mitarbeiter'

// Einzeln zuschaltbare Mitarbeiter-Rechte (Bereiche). Admin/Verwalter haben immer alles.
export type PermissionArea = 'pipeline' | 'funnel' | 'decks' | 'invoices' | 'contacts' | 'thumbnails' | 'youtube'
  | 'werbung' | 'werbung_meta' | 'werbung_youtube' | 'werbung_google'
export const PERMISSION_AREAS: { key: PermissionArea; label: string }[] = [
  { key: 'pipeline', label: 'Pipeline & Leads' },
  { key: 'funnel',   label: 'Funnel, Newsletter & Empfängerlisten' },
  { key: 'decks',    label: 'Sales-Decks erstellen' },
  { key: 'invoices', label: 'Rechnungen' },
  { key: 'contacts', label: 'Kontakte' },
  { key: 'thumbnails', label: 'Thumbnail-Studio (YouTube & Social)' },
  { key: 'youtube',    label: 'YouTube-Center (Videos hochladen & vorbereiten)' },
  { key: 'werbung',         label: 'Werbemanager (alle Kanäle)' },
  { key: 'werbung_meta',    label: 'Werbemanager: nur Meta' },
  { key: 'werbung_youtube', label: 'Werbemanager: nur YouTube' },
  { key: 'werbung_google',  label: 'Werbemanager: nur Google' },
]

// Werbe-Segmente (Kanäle) im Werbemanager: 'werbung' schaltet alle frei,
// alternativ einzelne 'werbung_<segment>'-Rechte.
export const AD_SEGMENTS = ['meta', 'youtube', 'google'] as const
export type AdSegment = typeof AD_SEGMENTS[number]

export interface Profile {
  id: string
  email: string
  full_name: string
  phone: string | null
  role: UserRole
  language: 'de' | 'en'
  verwaltung_id: string | null
  permissions: Partial<Record<PermissionArea, boolean>>
}

// Zugriff auf einen Bereich? Admin/Verwalter immer; Mitarbeiter nur bei gesetztem Recht.
// Sonderfall 'werbung': auch ein einzelnes Segment-Recht öffnet den Werbemanager
// (die Seite filtert dann selbst auf die freigegebenen Kanäle).
export function hasPerm(profile: Profile | null | undefined, area: PermissionArea): boolean {
  if (!profile) return false
  if (profile.role === 'admin' || profile.role === 'verwalter') return true
  if (profile.role === 'mitarbeiter') {
    if (profile.permissions?.[area]) return true
    if (area === 'werbung') return AD_SEGMENTS.some(s => !!profile.permissions?.[`werbung_${s}` as PermissionArea])
    return false
  }
  return false
}

// Darf dieser Nutzer ein bestimmtes Werbe-Segment (meta/youtube/google) sehen?
export function hasAdSegment(profile: Profile | null | undefined, segment: AdSegment): boolean {
  if (!profile) return false
  if (profile.role === 'admin' || profile.role === 'verwalter') return true
  if (profile.role !== 'mitarbeiter') return false
  return !!profile.permissions?.werbung || !!profile.permissions?.[`werbung_${segment}` as PermissionArea]
}

// ── Rolle → Dashboard-Pfad ─────────────────────────────────────
export function roleToPath(role: UserRole | undefined): string {
  switch (role) {
    case 'admin': {
      const saved = localStorage.getItem('admin_view')
      return saved === 'verwaltung' ? '/admin/dashboard' : '/admin/crm'
    }
    case 'verwalter':  return '/verwalter/dashboard'
    case 'feriengast': return '/feriengast/dashboard'
    case 'funnel':     return '/admin/crm/funnel'
    case 'mitarbeiter': return '/admin/crm/home'
    default:           return '/eigentuemer/dashboard'
  }
}

// Landeseite für Mitarbeiter = persönliche Startseite (Aufgaben + Widgets),
// unabhängig von den freigeschalteten Bereichen.
export function landingFor(profile: Profile | null | undefined): string {
  if (profile?.role !== 'mitarbeiter') return roleToPath(profile?.role)
  return '/admin/crm/home'
}

// ── Rollenfarben ──────────────────────────────────────────────
export const ROLE_META: Record<UserRole, { color: string }> = {
  admin:       { color: 'bg-purple-100 text-purple-800' },
  verwalter:   { color: 'bg-blue-100   text-blue-800'   },
  eigentuemer: { color: 'bg-green-100  text-green-800'  },
  feriengast:  { color: 'bg-amber-100  text-amber-800'  },
  funnel:      { color: 'bg-rose-100   text-rose-800'   },
  mitarbeiter: { color: 'bg-teal-100   text-teal-800'   },
}
