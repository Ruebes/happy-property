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
      // Letzte Admin-Ansicht aus localStorage wiederherstellen
      const saved = localStorage.getItem('admin_view')
      return saved === 'verwaltung' ? '/admin/dashboard' : '/admin/crm'
    }
    case 'verwalter':   return '/verwalter/dashboard'
    case 'feriengast':  return '/feriengast/dashboard'
    default:            return '/eigentuemer/dashboard'
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
  // Verhindert, dass ein abgebrochener/veralteter fetchProfile-Call
  // einen neuen State überschreibt.
  const fetchIdRef = useRef(0)

  // ── Profil laden mit 3 Versuchen ────────────────────────────
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
    // Sicherheitsnetz: nach 5 s loading beenden, damit kein ewiger Spinner
    const timeout = setTimeout(() => {
      setState(s => s.loading ? { ...s, loading: false } : s)
    }, 5_000)

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        // Token-Refresh: nur Session/User aktualisieren, kein Profil-Reload
        if (event === 'TOKEN_REFRESHED') {
          setState(s => ({ ...s, user: session?.user ?? null, session }))
          return
        }

        // Token-Refresh fehlgeschlagen → Session ist tot, sofort abmelden.
        // 'TOKEN_REFRESH_FAILED' existiert in neueren Supabase SDK-Versionen.
        if ((event as string) === 'TOKEN_REFRESH_FAILED') {
          try { localStorage.removeItem('happy-property-auth') } catch { /* ignore */ }
          setState({ user: null, session: null, profile: null, loading: false, needsPasswordSetup: false })
          window.location.replace('/login')
          return
        }

        // Explizites Abmelden: React-State leeren + Storage-Key entfernen
        // (Supabase löscht seinen eigenen Key, wir stellen sicher dass nichts cached bleibt)
        if (event === 'SIGNED_OUT') {
          try { localStorage.removeItem('happy-property-auth') } catch { /* ignore */ }
          setState({ user: null, session: null, profile: null, loading: false, needsPasswordSetup: false })
          return
        }

        // Eigene fetch-ID merken – falls ein neuer Event kommt, werden
        // veraltete Profil-Ergebnisse verworfen.
        const myId = ++fetchIdRef.current

        // loading: true setzen während Profil geladen wird – verhindert
        // dass Login.tsx mit null-Profil zu falschem Dashboard navigiert
        setState(s => ({ ...s, loading: true, user: session?.user ?? null, session }))

        try {
          const profile = session?.user ? await fetchProfile(session.user.id) : null

          // Veralteter Call? Neuere Anfrage lief durch → ignorieren
          if (myId !== fetchIdRef.current) return

          const needsPasswordSetup = !!(
            session?.user?.user_metadata?.needs_password_setup === true ||
            event === 'PASSWORD_RECOVERY'
          )

          setState({
            user:  session?.user ?? null,
            session,
            profile,
            loading: false,
            needsPasswordSetup,
          })
        } catch {
          if (myId !== fetchIdRef.current) return
          // Bei Fehler: Session trotzdem behalten → kein unerwarteter Logout
          setState(s => ({
            ...s,
            user:    session?.user ?? null,
            session,
            loading: false,
          }))
        }
      }
    )

    return () => {
      clearTimeout(timeout)
      subscription.unsubscribe()
    }
  }, [])

  // ── Netzwerk-Reconnect ────────────────────────────────────────────────────
  // Supabase autoRefreshToken: true übernimmt Token-Refresh vollständig.
  // Manuelle Handler (visibilitychange, focus, online+refreshSession) lösen
  // TOKEN_REFRESHED aus → onAuthStateChange → loading: true → Spinner.
  // Daher: keine aktiven Handler, nur leerer online-Listener als Platzhalter.
  useEffect(() => {
    const handleOnline = () => { /* Supabase refresht automatisch */ }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [])

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  // Passwort setzen + needs_password_setup Flag löschen
  // Gibt die Rolle zurück, damit SetPassword.tsx direkt navigieren kann
  async function updatePassword(newPassword: string): Promise<{ error: string | null; role?: UserRole }> {
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
      data: { needs_password_setup: false },
    })
    if (error) return { error: error.message }

    // Session explizit neu laden – USER_UPDATED-Event ist async und könnte
    // den State zu spät oder mit Race Condition aktualisieren
    const { data: { session: fresh } } = await supabase.auth.getSession()
    if (fresh?.user) {
      const freshProfile = await fetchProfile(fresh.user.id)
      // Laufenden USER_UPDATED-Handler invalidieren, damit er nicht
      // unseren frisch gesetzten State überschreibt
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

    // Fallback falls keine Session vorhanden (sollte nicht passieren)
    setState(s => ({ ...s, needsPasswordSetup: false }))
    return { error: null }
  }

  // Passwort-Reset-E-Mail
  async function resetPasswordEmail(email: string): Promise<{ error: string | null }> {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      // Direkt auf /set-password, damit getSetupMode() 'recovery' erkennt
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
