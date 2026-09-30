// NUR FÜR DEN DEV-SERVER. Dieser Ordner (src/dev) wird ausschließlich über
// dynamische Importe hinter import.meta.env.DEV geladen und landet nicht im
// Produktions-Build (Prüfung: grep nach hp_mock_role in dist/assets ist leer).
//
// Mock-Profile für die Shell-Vorschau (/__dev/shell/:role) und für die
// Mock-Anmeldung (DevMockAuthProvider). Es gibt keine echte Sitzung: Abfragen
// an Supabase laufen ohne Anmeldung und liefern leer oder einen Fehler.
import { PERMISSION_AREAS, type PermissionArea, type Profile, type UserRole } from '../lib/permissions'

// sessionStorage-Schlüssel der Mock-Anmeldung. App.tsx und AppShell.tsx fragen
// hp_mock_role direkt ab (hinter import.meta.env.DEV), weil sie diesen Ordner
// nicht statisch importieren dürfen.
export const MOCK_ROLE_KEY = 'hp_mock_role'
export const MOCK_PERMS_KEY = 'hp_mock_perms'

// Rollen, für die es die Shell geben wird (Feriengäste behalten ihr eigenes Layout)
export const MOCK_ROLES: readonly UserRole[] = ['admin', 'verwalter', 'mitarbeiter', 'funnel', 'eigentuemer']

// Mitarbeiter-Rechte: Standard und zweite Variante (?perms=funnel,werbung,thumbnails)
export const DEFAULT_STAFF_PERMS: readonly PermissionArea[] = ['pipeline', 'contacts']
export const ALT_STAFF_PERMS: readonly PermissionArea[] = ['funnel', 'werbung', 'thumbnails']

const MOCK_NAMES: Record<UserRole, string> = {
  admin: 'Vorschau Admin',
  verwalter: 'Vorschau Verwalter',
  mitarbeiter: 'Vorschau Mitarbeiter',
  funnel: 'Vorschau Funnel',
  eigentuemer: 'Vorschau Eigentümer',
  feriengast: 'Vorschau Feriengast',
}

export function parseRole(value: string | null | undefined): UserRole | null {
  return MOCK_ROLES.find(role => role === value) ?? null
}

// "funnel,werbung" -> ['funnel', 'werbung']. Unbekannte Namen fallen weg,
// null bedeutet: keine Angabe (dann gelten die Standard-Rechte).
export function parsePerms(value: string | null | undefined): PermissionArea[] | null {
  if (value === null || value === undefined) return null
  const known = PERMISSION_AREAS.map(area => area.key)
  return value.split(',').map(part => part.trim()).flatMap(part => known.filter(key => key === part))
}

export function mockProfile(role: UserRole, perms?: readonly PermissionArea[] | null): Profile {
  const permissions: Partial<Record<PermissionArea, boolean>> = {}
  if (role === 'mitarbeiter') {
    for (const key of perms ?? DEFAULT_STAFF_PERMS) permissions[key] = true
  }
  return {
    id: '00000000-0000-4000-8000-000000000000',
    email: `${role}@vorschau.test`,
    full_name: MOCK_NAMES[role],
    phone: null,
    role,
    language: 'de',
    verwaltung_id: null,
    permissions,
  }
}

// Aktive Mock-Anmeldung aus dem sessionStorage (null = keine)
export function readMock(): { role: UserRole; perms: PermissionArea[] | null } | null {
  try {
    const role = parseRole(sessionStorage.getItem(MOCK_ROLE_KEY))
    if (!role) return null
    return { role, perms: parsePerms(sessionStorage.getItem(MOCK_PERMS_KEY)) }
  } catch { return null }
}

export function startMock(role: UserRole, perms: readonly PermissionArea[] | null): void {
  try {
    sessionStorage.setItem(MOCK_ROLE_KEY, role)
    if (perms) sessionStorage.setItem(MOCK_PERMS_KEY, perms.join(','))
    else sessionStorage.removeItem(MOCK_PERMS_KEY)
  } catch { /* ohne sessionStorage gibt es keine Mock-Anmeldung */ }
}

export function stopMock(): void {
  try {
    sessionStorage.removeItem(MOCK_ROLE_KEY)
    sessionStorage.removeItem(MOCK_PERMS_KEY)
  } catch { /* ignorieren */ }
}
