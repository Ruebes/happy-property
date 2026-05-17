import { useState, useEffect } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'

interface Props {
  allowedRoles?: string[]
}

export default function ProtectedRoute({ allowedRoles }: Props) {
  const { user, profile, loading } = useAuth()

  // Lokaler Spinner-Timeout: max. 12 s warten, dann Entscheidung erzwingen.
  // Länger als auth.tsx-Timeout (10 s) um Race-Conditions zu vermeiden.
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (!loading) { setTimedOut(false); return }
    const t = setTimeout(() => setTimedOut(true), 12_000)
    return () => clearTimeout(t)
  }, [loading])

  // Spinner nur wenn WEDER User noch Timeout bekannt.
  // Sobald user gesetzt ist oder Timeout abgelaufen → weiter entscheiden.
  if (loading && !user && !timedOut) {
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

  // Falsche Rolle → Dashboard (Profil muss geladen sein)
  // Wenn Profil noch lädt → Outlet zeigen (Loading-State in der Page)
  if (allowedRoles && profile && !allowedRoles.includes(profile.role)) {
    return <Navigate to="/login" replace />
  }

  // Eingeloggt und Rolle ok (oder Profil noch unterwegs) → Inhalt zeigen
  return <Outlet />
}
