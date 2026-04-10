import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'

interface Props {
  allowedRoles?: string[]
}

export default function ProtectedRoute({ allowedRoles }: Props) {
  const { user, profile, loading } = useAuth()

  // Absolutes Erstladen: noch keine Session bekannt → Spinner
  if (loading && !user) {
    return (
      <div className="flex items-center justify-center h-screen"
           style={{ backgroundColor: 'var(--color-bg)' }}>
        <div className="animate-spin rounded-full h-8 w-8
                        border-b-2 border-orange-500" />
      </div>
    )
  }

  // Nicht eingeloggt → Login
  if (!user) {
    return <Navigate to="/login" replace />
  }

  // Falsche Rolle → Login (Profil muss geladen sein für den Check)
  if (allowedRoles && profile && !allowedRoles.includes(profile.role)) {
    return <Navigate to="/login" replace />
  }

  // Eingeloggt – Inhalt immer zeigen (auch wenn Profil noch lädt)
  return <Outlet />
}
