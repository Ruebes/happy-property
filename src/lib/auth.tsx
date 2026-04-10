import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { User, Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

// ── Rollen ─────────────────────────────────────────────────────
export type UserRole = 'admin' | 'verwalter' | 'eigentuemer' | 'feriengast'

export interface Profile {
  id: string
  email: string
  full_name: string
  phone: string | null
  role: UserRole
  language: 'de' | 'en'
}

interface AuthState {
  user:               User | null
  session:            Session | null
  profile:            Profile | null
  loading:            boolean
  needsPasswordSetup: boolean
}

interface AuthContextValue extends AuthState {
  signIn:             (email: string, password: string) => Promise<{ error: string | null }>
  signOut:            () => Promise<void>
  updatePassword:     (newPassword: string) => Promise<{ error: string | null; role?: UserRole }>
  resetPasswordEmail: (email: string) => Promise<{ error: string | null }>
  clearPasswordSetup: () => void
  dashboardPath:      string
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
    default:           return '/eigentuemer/dashboard'
  }
}

// ── Rollenfarben ──────────────────────────────────────────────
export const ROLE_META: Record<UserRole, { color: string }> = {
  admin:       { color: 'bg-purple-100 text-purple-800' },
  verwalter:   { color: 'bg-blue-100   text-blue-800'   },
  eigentuemer: { color: 'bg-green-100  text-green-800'  },
  feriengast:  { color: 'bg-amber-100  text-amber-800'  },
}

// ── Context ───────────────────────────────────────────────────
const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null, session: null, profile: null, loading: true, needsPasswordSetup: false,
  })

  // Verhindert veraltete fetchProfile-Resultate bei schnell aufeinander-
  // folgenden Auth-Events (z.B. INITIAL_SESSION → SIGNED_IN).
  const fetchIdRef = useRef(0)

  // ── Profil laden ────────────────────────────────────────────
  async function fetchProfile(userId: string, attempt = 1): Promise<Profile | null> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, full_name, phone, role, language')
        .eq('id', userId)
        .single()
      if (error || !data) {
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, attempt * 800))
          return fetchProfile(userId, attempt + 1)
        }
        return null
      }
      return data as Profile
    } catch {
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 800))
        return fetchProfile(userId, attempt + 1)
      }
      return null
    }
  }

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {

        // TOKEN_REFRESHED: Session silent aktualisieren – kein Profil-Reload
        // nötig, da Supabase autoRefreshToken alles selbst handhabt.
        if (event === 'TOKEN_REFRESHED') {
          setState(s => ({ ...s, session, user: session?.user ?? null }))
          return
        }

        // SIGNED_OUT: alles leeren
        if (event === 'SIGNED_OUT') {
          fetchIdRef.current++
          setState({ user: null, session: null, profile: null, loading: false, needsPasswordSetup: false })
          return
        }

        // Alle anderen Events (INITIAL_SESSION, SIGNED_IN, PASSWORD_RECOVERY …):
        // Profil laden und State setzen. fetchIdRef verhindert Race Conditions.
        const myId = ++fetchIdRef.current
        setState(s => ({ ...s, loading: true, session, user: session?.user ?? null }))

        const profile = session?.user ? await fetchProfile(session.user.id) : null
        if (myId !== fetchIdRef.current) return   // neuerer Event hat übernommen

        const needsPasswordSetup = !!(
          session?.user?.user_metadata?.needs_password_setup === true ||
          event === 'PASSWORD_RECOVERY'
        )

        setState({
          user:               session?.user ?? null,
          session,
          profile,
          loading:            false,
          needsPasswordSetup,
        })
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  // ── Auth-Aktionen ────────────────────────────────────────────

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  async function updatePassword(newPassword: string): Promise<{ error: string | null; role?: UserRole }> {
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
      data: { needs_password_setup: false },
    })
    if (error) return { error: error.message }

    const { data: { session: fresh } } = await supabase.auth.getSession()
    if (fresh?.user) {
      const freshProfile = await fetchProfile(fresh.user.id)
      fetchIdRef.current++
      setState({
        user:               fresh.user,
        session:            fresh,
        profile:            freshProfile,
        loading:            false,
        needsPasswordSetup: false,
      })
      return { error: null, role: freshProfile?.role }
    }

    setState(s => ({ ...s, needsPasswordSetup: false }))
    return { error: null }
  }

  async function resetPasswordEmail(email: string): Promise<{ error: string | null }> {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/set-password`,
    })
    return { error: error?.message ?? null }
  }

  function clearPasswordSetup() {
    setState(s => ({ ...s, needsPasswordSetup: false }))
  }

  return (
    <AuthContext.Provider value={{
      ...state,
      signIn,
      signOut,
      updatePassword,
      resetPasswordEmail,
      clearPasswordSetup,
      dashboardPath: roleToPath(state.profile?.role),
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
