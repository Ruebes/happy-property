// NUR FÜR DEN DEV-SERVER (siehe devMock.ts). App.tsx lädt diese Datei nur, wenn
// import.meta.env.DEV gilt UND sessionStorage.hp_mock_role gesetzt ist.
//
// Stellt den ECHTEN AuthContext mit einem erfundenen Profil bereit, damit sich
// echte Routen (/admin/crm/pipeline usw.) ohne Login in der neuen Shell ansehen
// lassen. Der AuthProvider läuft dabei nicht: keine Sitzung, kein
// onAuthStateChange. Datenabfragen der Seiten schlagen fehl oder bleiben leer,
// das ist für die Sichtprüfung so gewollt.
import { useMemo, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { AuthContext, type AuthContextValue } from '../lib/auth'
import { landingFor } from '../lib/permissions'
import { mockProfile, readMock, stopMock } from './devMock'

interface Props {
  children?: ReactNode
}

const NOT_AVAILABLE = 'In der Mock-Anmeldung nicht verfügbar'

export default function DevMockAuthProvider({ children }: Props) {
  const value = useMemo<AuthContextValue>(() => {
    const mock = readMock()
    const profile = mock ? mockProfile(mock.role, mock.perms) : null
    const user: User | null = profile
      ? {
          id: profile.id,
          email: profile.email,
          aud: 'authenticated',
          app_metadata: {},
          user_metadata: {},
          created_at: new Date(0).toISOString(),
        }
      : null
    const session: Session | null = user
      ? { access_token: 'dev-mock', refresh_token: 'dev-mock', expires_in: 3600, token_type: 'bearer', user }
      : null

    return {
      user,
      session,
      profile,
      loading: false,
      needsPasswordSetup: false,
      signIn: async () => ({ error: NOT_AVAILABLE }),
      signOut: async () => { stopMock() },
      updatePassword: async () => ({ error: NOT_AVAILABLE }),
      resetPasswordEmail: async () => ({ error: NOT_AVAILABLE }),
      clearPasswordSetup: () => {},
      dashboardPath: landingFor(profile),
      realProfile: profile,
      preview: null,
      startPreview: () => {},
      endPreview: () => {},
    }
  }, [])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
