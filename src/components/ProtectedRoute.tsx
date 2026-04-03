import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth, roleToPath, type UserRole } from '../lib/auth'

interface Props {
  children:     ReactNode
  allowedRoles: UserRole[]
  /** Wenn true, wird der Passwort-Setup-Redirect übersprungen (nur für /set-password) */
  skipPasswordCheck?: boolean
}

export default function ProtectedRoute({ children, allowedRoles, skipPasswordCheck }: Props) {
  const { session, profile, loading, needsPasswordSetup } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center"
           style={{ backgroundColor: 'var(--color-bg)' }}>
        <div className="w-8 h-8 border-4 rounded-full animate-spin"
             style={{ borderColor: '#e5e7eb', borderTopColor: 'var(--color-highlight)' }} />
      </div>
    )
  }

  // Nicht eingeloggt → Login
  if (!session) return <Navigate to="/login" replace />

  // Passwort-Setup erzwingen (Einladungsflow)
  if (needsPasswordSetup && !skipPasswordCheck && location.pathname !== '/set-password') {
    return <Navigate to="/set-password" replace />
  }

  // Falsche Rolle → eigenes Dashboard
  if (profile && !allowedRoles.includes(profile.role)) {
    return <Navigate to={roleToPath(profile.role)} replace />
  }

  return <>{children}</>
}
