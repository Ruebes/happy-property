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

// ── Profil-Cache ──────────────────────────────────────────────────────────────
// Speichert das zuletzt geladene Profil im localStorage, damit beim Reload
// kein Spinner erscheint (sofortige Anzeige aus Cache, stille Hintergrund-
// Aktualisierung von Supabase).
const PROFILE_CACHE_KEY = 'hp_profile_cache'

function getCachedProfile(userId: string): Profile | null {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Profile
    if (p.id !== userId) return null  // anderer User – Cache nicht verwenden
    return p
  } catch { return null }
}

function setCachedProfile(profile: Profile | null) {
  if (profile) {
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile))
  } else {
    localStorage.removeItem(PROFILE_CACHE_KEY)
  }
}

// ── Rollen ─────────────────────────────────────────────────────
export type UserRole = 'admin' | 'verwalter' | 'eigentuemer' | 'feriengast' | 'funnel' | 'mitarbeiter'

// Einzeln zuschaltbare Mitarbeiter-Rechte (Bereiche). Admin/Verwalter haben immer alles.
export type PermissionArea = 'pipeline' | 'funnel' | 'decks' | 'invoices' | 'contacts'
export const PERMISSION_AREAS: { key: PermissionArea; label: string }[] = [
  { key: 'pipeline', label: 'Pipeline & Leads' },
  { key: 'funnel',   label: 'Funnel & Newsletter' },
  { key: 'decks',    label: 'Sales-Decks erstellen' },
  { key: 'invoices', label: 'Rechnungen' },
  { key: 'contacts', label: 'Kontakte' },
]

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
export function hasPerm(profile: Profile | null | undefined, area: PermissionArea): boolean {
  if (!profile) return false
  if (profile.role === 'admin' || profile.role === 'verwalter') return true
  if (profile.role === 'mitarbeiter') return !!profile.permissions?.[area]
  return false
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

// Passwort-Setzen-Kontext: sind wir auf /set-password oder kam der Nutzer über
// einen Recovery-Link (#type=recovery)? Dann darf die Sofort-Init / ein SIGNED_IN
// den needsPasswordSetup-Zustand NICHT auf false ziehen — sonst wird der Nutzer
// vom Passwort-Formular weggeleitet, bevor er ein neues Passwort setzen kann.
function isPwSetupContext(): boolean {
  try {
    return window.location.pathname === '/set-password'
      || window.location.hash.includes('type=recovery')
  } catch { return false }
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

  // ── Sofort-Init aus gespeicherter Session ───────────────────
  // Liest die Supabase-Session direkt aus localStorage – kein Warten auf
  // onAuthStateChange nötig. Wenn eine gecachte Session + Profil vorhanden
  // sind, erscheint die App sofort ohne Spinner.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) return
      const cached = getCachedProfile(session.user.id)
      if (!cached) return
      setState(s => s.profile ? s : {
        ...s,
        loading:  false,
        session,
        user:     session.user,
        profile:  cached,
        needsPasswordSetup: !!(session.user.user_metadata?.needs_password_setup) || isPwSetupContext(),
      })
    }).catch(() => {})
  }, [])

  // ── Timeout-Fallback ─────────────────────────────────────────
  // Falls weder getSession noch onAuthStateChange rechtzeitig feuert
  // (PWA-Kaltstart, Offline), loading nach 10 s auf false setzen.
  useEffect(() => {
    const t = setTimeout(() => {
      setState(s => s.loading ? { ...s, loading: false } : s)
    }, 10_000)
    return () => clearTimeout(t)
  }, [])

  // ── Profil laden ────────────────────────────────────────────
  // Retry mit reduziertem Delay (400ms × Versuch) für schnellere Reaktion.
  async function fetchProfile(userId: string, attempt = 1): Promise<Profile | null> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, full_name, phone, role, language, verwaltung_id, permissions')
        .eq('id', userId)
        .single()
      if (error || !data) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 300))
          return fetchProfile(userId, attempt + 1)
        }
        return null
      }
      const p = data as Profile
      return { ...p, permissions: p.permissions ?? {} }
    } catch {
      // fetch timed out (AbortError) oder Netzwerkfehler → einmal retry
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 300))
        return fetchProfile(userId, attempt + 1)
      }
      return null
    }
  }

  useEffect(() => {
    // WICHTIG (Spinner-Deadlock-Fix): Der onAuthStateChange-Callback ist
    // bewusst SYNCHRON (nicht async) und ruft NIE direkt eine Supabase-Methode
    // (.from / .auth …) auf. supabase-js feuert diese Events teilweise WÄHREND
    // es den internen Auth-Lock (navigator.locks) hält. Ein Supabase-Aufruf im
    // Callback würde denselben Lock erneut anfragen → Deadlock → Spinner hängt,
    // nur Reload hilft. INITIAL_SESSION feuert bei JEDEM Laden, daher trat das
    // "von Anfang an / fast immer" auf. Lösung (offizielle Supabase-Empfehlung):
    // alle Supabase-Calls per setTimeout(…,0) aus dem Callback herauslösen,
    // damit der Lock zuerst freigegeben wird.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {

        // TOKEN_REFRESHED: Session silent aktualisieren – kein Profil-Reload
        // nötig, da Supabase autoRefreshToken alles selbst handhabt.
        if (event === 'TOKEN_REFRESHED') {
          setState(s => ({ ...s, session, user: session?.user ?? null }))
          return
        }

        // SIGNED_OUT: alles leeren und Cache invalidieren
        if (event === 'SIGNED_OUT') {
          fetchIdRef.current++
          setCachedProfile(null)
          setState({ user: null, session: null, profile: null, loading: false, needsPasswordSetup: false })
          return
        }

        // Alle anderen Events (INITIAL_SESSION, SIGNED_IN, PASSWORD_RECOVERY …):
        // 1. Sofort aus Cache setzen → kein Spinner bei bekanntem User
        // 2. Profil im Hintergrund (nach Lock-Freigabe) frisch laden
        const cachedProfile = session?.user ? getCachedProfile(session.user.id) : null
        const needsPasswordSetup = !!(
          session?.user?.user_metadata?.needs_password_setup === true ||
          event === 'PASSWORD_RECOVERY' ||
          isPwSetupContext()
        )
        const myId = ++fetchIdRef.current

        // loading nur auf true wenn weder Cache noch laufendes Profil vorhanden.
        // Bei Fenster-Fokus-Events (SIGNED_IN nach Token-Refresh) niemals
        // loading=true setzen wenn bereits ein Profil im State ist.
        setState(s => ({
          ...s,
          loading:            !cachedProfile && !s.profile,
          session,
          user:               session?.user ?? null,
          profile:            cachedProfile ?? s.profile,
          needsPasswordSetup,
        }))

        const sessionUser = session?.user
        if (!sessionUser) {
          // Kein User → loading sicher beenden, kein Profil-Load nötig
          setState(s => ({ ...s, loading: false }))
          return
        }

        // Profil-Load NACH Lock-Freigabe (setTimeout 0). NIE synchron hier!
        setTimeout(() => {
          void (async () => {
            const freshProfile = await fetchProfile(sessionUser.id)
            if (myId !== fetchIdRef.current) return   // neuerer Event hat übernommen

            // Cache nur bei Erfolg aktualisieren – nie löschen bei Netzwerk-
            // fehler/Timeout (sonst fehlt beim nächsten Load der Cache und der
            // Spinner erscheint erneut).
            if (freshProfile) setCachedProfile(freshProfile)

            setState(s => ({
              ...s,
              user:               sessionUser,
              session,
              profile:            freshProfile ?? s.profile,
              loading:            false,
              needsPasswordSetup,
            }))

            // Portal-Login tracken: nur bei echtem Login (nicht Reload/Refresh)
            if (event === 'SIGNED_IN' && freshProfile?.role === 'eigentuemer') {
              supabase.from('portal_logins').insert({ profile_id: sessionUser.id })
                .then(() => {}) // fire-and-forget, Fehler ignorieren
            }
          })()
        }, 0)
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  // ── Auth-Aktionen ────────────────────────────────────────────

  async function signIn(email: string, password: string) {
    // E-Mail normalisieren — sonst führt " Foo@X.de" vs. "foo@x.de" zu „kein Konto".
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
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
      setCachedProfile(freshProfile)
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
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
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
      dashboardPath: landingFor(state.profile),
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
