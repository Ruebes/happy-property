import { useState, useEffect } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'

interface Props {
  allowedRoles?: string[]
}

export default function ProtectedRoute({ allowedRoles }: Props) {
  const { user, profile, loading } = useAuth()

  // Lokaler Timeout: falls loading nach 10 s noch true ist (Netzwerkausfall,
  // iOS-PWA-Kaltstart), erzwingen wir einen Weitersprung. Der Auth-Timeout in
  // auth.tsx greift nach 8 s – dieser hier ist ein zweiter Sicherheitsring.
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (!loading) { setTimedOut(false); return }
    const t = setTimeout(() => setTimedOut(true), 10_000)
    return () => clearTimeout(t)
  }, [loading])

  // Absolutes Erstladen: noch keine Session bekannt → Spinner
  // (aber max. 10 Sekunden – danach weiterleiten)
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

  // Falsche Rolle → Login (Profil muss geladen sein für den Check)
  if (allowedRoles && profile && !allowedRoles.includes(profile.role)) {
    return <Navigate to="/login" replace />
  }

  // Eingeloggt – Inhalt immer zeigen (auch wenn Profil noch lädt)
  return <Outlet />
}
