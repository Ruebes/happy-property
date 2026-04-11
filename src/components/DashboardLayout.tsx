import { useState, useEffect } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { useAuth, ROLE_META, type UserRole } from '../lib/auth'
import { supabase } from '../lib/supabase'
import LanguageSwitcher from './LanguageSwitcher'

interface Props {
  children: ReactNode
  basePath: string
}

type AdminView = 'crm' | 'verwaltung'

export default function DashboardLayout({ children, basePath }: Props) {
  const { t }              = useTranslation()
  const { user, profile }  = useAuth()
  const navigate           = useNavigate()
  const location           = useLocation()
  const [loggingOut, setLoggingOut] = useState(false)

  // ── Profil-Cache in localStorage ─────────────────────────────────────────
  // Wenn profile kurz null ist (Tab-Wechsel, Neuladen), bleiben Nav und
  // Avatar-Initiale korrekt angezeigt.
  if (profile?.full_name) localStorage.setItem('cached_user_name', profile.full_name)
  if (profile?.role)      localStorage.setItem('cached_user_role', profile.role)

  const effectiveRole = profile?.role
    ?? (localStorage.getItem('cached_user_role') as UserRole | null)
    ?? null

  // Initialen: zuerst vollen Namen aufteilen (AB), Fallback auf E-Mail, dann '?'
  const initials = profile?.full_name
    ?.split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    || user?.email?.[0]?.toUpperCase()
    || '?'

  const displayName = profile?.full_name
    ?? localStorage.getItem('cached_user_name')
    ?? user?.email
    ?? null

  const roleColor = effectiveRole ? ROLE_META[effectiveRole].color : ''
  const isAdmin   = effectiveRole === 'admin'

  // ── Admin view: derived from URL, saved to localStorage ──────────────────
  const adminView: AdminView = (() => {
    if (location.pathname.startsWith('/admin/crm'))          return 'crm'
    if (location.pathname.startsWith('/admin/dashboard') ||
        location.pathname.startsWith('/admin/users'))        return 'verwaltung'
    return (localStorage.getItem('admin_view') as AdminView | null) ?? 'crm'
  })()

  const switchAdminView = (view: AdminView) => {
    localStorage.setItem('admin_view', view)
    navigate(view === 'crm' ? '/admin/crm' : '/admin/dashboard')
  }

  // ── CRM Settings submenu ─────────────────────────────────────────────────
  // Settings-Bereich: /admin/crm/settings/* und /admin/crm/templates
  const isInSettings =
    location.pathname.startsWith('/admin/crm/settings') ||
    location.pathname.startsWith('/admin/crm/templates')

  const [settingsOpen, setSettingsOpen] = useState(
    () => isInSettings || localStorage.getItem('crm_settings_menu_open') === 'true'
  )

  // URL-gesteuert: auto-auf wenn in Settings, auto-zu wenn zu Pipeline/Leads/Projekte navigiert
  useEffect(() => {
    if (isInSettings) {
      setSettingsOpen(true)
    } else if (
      location.pathname === '/admin/crm' ||
      location.pathname.startsWith('/admin/crm/leads') ||
      location.pathname.startsWith('/admin/crm/projects') ||
      location.pathname.startsWith('/admin/crm/calendar')
    ) {
      setSettingsOpen(false)
      localStorage.setItem('crm_settings_menu_open', 'false')
    }
  }, [location.pathname, isInSettings])

  const toggleSettings = () => {
    if (isInSettings) return // kein Schließen wenn man gerade im Settings-Bereich ist
    setSettingsOpen(prev => {
      const next = !prev
      localStorage.setItem('crm_settings_menu_open', String(next))
      return next
    })
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  const verwaltungNavItems = [
    { to: '/admin/dashboard', key: 'nav.dashboard'       },
    { to: '/objekte',         key: 'nav.properties'      },
    { to: '/kalender',        key: 'nav.calendar'        },
    { to: '/dokumente',       key: 'nav.documents'       },
    { to: '/admin/users',     key: 'adminView.nav.users' },
  ]

  const defaultNavItems = [
    { to: basePath,    key: 'nav.dashboard'  },
    { to: '/objekte',  key: 'nav.properties' },
    { to: '/kalender', key: 'nav.calendar'   },
  ]

  // CRM-Einzel-Links (ohne Settings-Gruppe)
  const crmTopItems = [
    { to: '/admin/crm',               key: 'crm.nav.pipeline'   },
    { to: '/admin/crm/leads',         key: 'crm.nav.leads'      },
    { to: '/admin/crm/projects',      key: 'crm.nav.projects'   },
    { to: '/admin/crm/calendar',      key: 'crm.nav.calendar'   },
    { to: '/admin/crm/statistics',    key: 'crm.nav.statistics' },
  ]

  // CRM Settings-Untermenü-Einträge
  const crmSettingsItems = [
    { to: '/admin/crm/settings',             key: 'crm.nav.developers' },
    { to: '/admin/crm/templates',            key: 'crm.nav.templates'   },
    ...(isAdmin ? [
      { to: '/admin/crm/settings/whatsapp',    key: 'crm.nav.whatsapp'    },
      { to: '/admin/crm/settings/automation',  key: 'crm.nav.automation'  },
    ] : []),
  ]

  // ── Sign out ─────────────────────────────────────────────────────────────
  // Promise.race stellt sicher dass signOut() nie ewig hängt (z.B. bei
  // Netzwerkproblemen oder abgelaufener Session). Nach 2s Timeout wird
  // trotzdem sauber weitergeleitet.
  const handleSignOut = async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await Promise.race([
        supabase.auth.signOut(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ])
    } catch { /* ignorieren */ }
    finally {
      localStorage.clear()
      sessionStorage.clear()
      window.location.href = '/login'
    }
  }

  // ── Aktiv-Check für nav Links ─────────────────────────────────────────────
  const isActive = (to: string) =>
    to === '/admin/crm'
      ? location.pathname === '/admin/crm'
      : location.pathname.startsWith(to)

  const navLinkClass = (to: string) =>
    `px-3 py-1.5 rounded-lg text-sm font-medium font-body transition-colors ${
      isActive(to)
        ? 'text-white'
        : 'text-gray-600 hover:bg-gray-100 hover:text-hp-black'
    }`

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--color-bg)' }}>

      {/* ── Topbar ── */}
      <header className="bg-white border-b border-gray-100 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">

          {/* Links: Logo + Toggle + Nav */}
          <div className="flex items-center gap-5">

            {/* Logo */}
            <Link
              to={isAdmin ? (adminView === 'crm' ? '/admin/crm' : '/admin/dashboard') : basePath}
              className="shrink-0"
            >
              <img
                src="/logo.jpg"
                alt={t('app.name')}
                style={{ height: '40px', width: '40px', objectFit: 'cover', display: 'block' }}
                className="rounded-xl"
              />
            </Link>

            {/* Admin: CRM | Verwaltung Toggle */}
            {isAdmin && (
              <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5 shrink-0">
                <button
                  onClick={() => switchAdminView('crm')}
                  className="px-3 py-1 text-xs font-semibold font-body rounded-md transition-all"
                  style={adminView === 'crm'
                    ? { backgroundColor: '#ff795d', color: 'white' }
                    : { color: '#6b7280' }}
                >
                  {t('adminView.crm')}
                </button>
                <button
                  onClick={() => switchAdminView('verwaltung')}
                  className="px-3 py-1 text-xs font-semibold font-body rounded-md transition-all"
                  style={adminView === 'verwaltung'
                    ? { backgroundColor: '#ff795d', color: 'white' }
                    : { color: '#6b7280' }}
                >
                  {t('adminView.verwaltung')}
                </button>
              </div>
            )}

            {/* Navigation */}
            <nav className="hidden md:flex gap-1 items-center">

              {/* ── Admin CRM-Ansicht ── */}
              {isAdmin && adminView === 'crm' && (
                <>
                  {/* Hauptlinks: Pipeline · Alle Kunden · Projekte */}
                  {crmTopItems.map(({ to, key }) => (
                    <Link key={to} to={to}
                      className={navLinkClass(to)}
                      style={isActive(to) ? { backgroundColor: '#ff795d' } : undefined}
                    >
                      {t(key)}
                    </Link>
                  ))}

                  {/* Einstellungen (aufklappbar) */}
                  <div className="relative">
                    {/* Toggle-Button */}
                    <button
                      onClick={toggleSettings}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium font-body
                                  transition-colors flex items-center gap-1 ${
                        isInSettings
                          ? 'text-white'
                          : 'text-gray-600 hover:bg-gray-100 hover:text-hp-black'
                      }`}
                      style={isInSettings ? { backgroundColor: '#ff795d' } : undefined}
                    >
                      {t('crm.nav.settings')}
                      {/* Chevron dreht sich */}
                      <svg
                        className={`w-3 h-3 mt-0.5 transition-transform duration-200 ${settingsOpen ? 'rotate-180' : ''}`}
                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>

                    {/* Dropdown-Panel */}
                    {settingsOpen && (
                      <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200
                                      rounded-xl shadow-lg z-50 min-w-[200px] py-1.5 overflow-hidden">
                        {crmSettingsItems.map(({ to, key }) => (
                          <Link key={to} to={to}
                            className={`flex items-center gap-2.5 px-4 py-2 text-sm font-body
                                        transition-colors ${
                              isActive(to)
                                ? 'font-semibold'
                                : 'text-gray-700 hover:bg-gray-50 hover:text-hp-black'
                            }`}
                            style={isActive(to) ? { color: '#ff795d' } : undefined}
                          >
                            {/* aktiver Indikator-Balken */}
                            <span
                              className="w-1 h-4 rounded-full shrink-0"
                              style={{ backgroundColor: isActive(to) ? '#ff795d' : 'transparent' }}
                            />
                            {t(key)}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ── Admin Verwaltungs-Ansicht ── */}
              {isAdmin && adminView === 'verwaltung' && (
                <>
                  {verwaltungNavItems.map(({ to, key }) => (
                    <Link key={to} to={to}
                      className={navLinkClass(to)}
                      style={isActive(to) ? { backgroundColor: '#ff795d' } : undefined}
                    >
                      {t(key)}
                    </Link>
                  ))}
                </>
              )}

              {/* ── Nicht-Admin Rollen (Verwalter etc.) ── */}
              {!isAdmin && (
                <>
                  {defaultNavItems.map(({ to, key }) => (
                    <Link key={to} to={to}
                      className="px-3 py-1.5 rounded-lg text-sm font-medium font-body text-gray-600
                                 hover:bg-gray-100 hover:text-hp-black transition-colors">
                      {t(key)}
                    </Link>
                  ))}

                  {/* CRM-Dropdown für Verwalter */}
                  {profile?.role === 'verwalter' && (
                    <div className="relative group">
                      <button className="px-3 py-1.5 rounded-lg text-sm font-medium font-body text-gray-600
                                         hover:bg-gray-100 hover:text-hp-black transition-colors flex items-center gap-1">
                        {t('crm.title')}
                        <svg className="w-3 h-3 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg
                                      opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50
                                      min-w-[180px] py-1">
                        {[
                          { to: '/admin/crm',           key: 'crm.nav.pipeline'    },
                          { to: '/admin/crm/leads',     key: 'crm.nav.leads'       },
                          { to: '/admin/crm/projects',  key: 'crm.nav.projects'    },
                          { to: '/admin/crm/templates', key: 'crm.nav.templates'   },
                          { to: '/admin/crm/settings',  key: 'crm.nav.developers'  },
                        ].map(({ to, key }) => (
                          <Link key={to} to={to}
                            className="block px-4 py-2 text-sm font-body text-gray-700
                                       hover:bg-gray-50 hover:text-hp-black transition-colors">
                            {t(key)}
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

            </nav>
          </div>

          {/* Rechts: Sprache + Rolle-Badge + Profil + Abmelden */}
          <div className="flex items-center gap-3">
            <LanguageSwitcher />

            {effectiveRole && (
              <span className={`hidden sm:inline text-xs font-semibold font-body
                               px-2.5 py-1 rounded-full ${roleColor}`}>
                {t(`roles.${effectiveRole}`)}
              </span>
            )}

            <Link
              to="/profile"
              className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg
                         text-sm font-body text-gray-600 hover:bg-gray-100
                         hover:text-hp-black transition-colors group"
              title={t('nav.profile')}
            >
              <span
                className="w-6 h-6 rounded-full flex items-center justify-center
                           text-white text-xs font-bold font-body shrink-0"
                style={{ backgroundColor: 'var(--color-highlight)' }}
              >
                {initials}
              </span>
              <span className="max-w-[120px] truncate">
                {displayName}
              </span>
            </Link>

            <button
              onClick={handleSignOut}
              disabled={loggingOut}
              className="text-sm font-medium font-body px-3 py-1.5 rounded-lg
                         border border-gray-200 text-gray-600
                         hover:border-hp-highlight hover:text-hp-highlight
                         transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {loggingOut && (
                <span className="w-3 h-3 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
              )}
              {t('nav.logout')}
            </button>
          </div>
        </div>

        {/* ── "Du siehst gerade:" Breadcrumb (nur Admin) ── */}
        {isAdmin && (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-1.5">
            <p className="text-xs text-gray-400 font-body">
              {t('adminView.current', {
                view: t(adminView === 'crm' ? 'adminView.crm' : 'adminView.verwaltung'),
              })}
            </p>
          </div>
        )}
      </header>

      {/* ── Content ── */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 md:py-8">
        {children}
      </main>
    </div>
  )
}
