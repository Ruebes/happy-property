import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { useAuth, ROLE_META, hasPerm, type UserRole, type PermissionArea } from '../lib/auth'
import { supabase } from '../lib/supabase'
import LanguageSwitcher from './LanguageSwitcher'
import AppointmentPrepPopup from './crm/AppointmentPrepPopup'
import TaskNotifications from './crm/TaskNotifications'

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
  const [mobileNavOpen, setMobileNavOpen] = useState(false)   // Hamburger-Menü (Admin, Mobil)

  // ── Profil-Cache in localStorage ─────────────────────────────────────────
  // Wenn profile kurz null ist (Tab-Wechsel, Neuladen), bleiben Nav und
  // Avatar-Initiale korrekt angezeigt.
  // Writes sind in useEffect, damit sie nicht im Render-Body passieren.
  useEffect(() => {
    if (profile?.full_name) localStorage.setItem('cached_user_name', profile.full_name)
    if (profile?.role)      localStorage.setItem('cached_user_role', profile.role)
  }, [profile?.full_name, profile?.role])

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
        location.pathname.startsWith('/admin/users')      ||
        location.pathname.startsWith('/admin/verwaltungen')) return 'verwaltung'
    return (localStorage.getItem('admin_view') as AdminView | null) ?? 'crm'
  })()

  const switchAdminView = (view: AdminView) => {
    localStorage.setItem('admin_view', view)
    navigate(view === 'crm' ? '/admin/crm' : '/admin/dashboard')
  }

  // ── CRM Settings submenu ─────────────────────────────────────────────────
  // Settings-Bereich: /admin/crm/settings/* und /admin/crm/templates
  // (nur für die Button-Hervorhebung — steuert NICHT den Auf/Zu-Zustand)
  const isInSettings =
    location.pathname.startsWith('/admin/crm/settings') ||
    location.pathname.startsWith('/admin/crm/templates')

  // Reines Klick-Dropdown: öffnet/schließt per Klick, schließt bei Klick
  // außerhalb, bei Escape und bei jeder Navigation (z.B. Auswahl eines Eintrags).
  const settingsRef = useRef<HTMLDivElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const [moreOpen, setMoreOpen] = useState(false)

  useEffect(() => {
    if (!settingsOpen && !moreOpen) return
    const onPointerDown = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSettingsOpen(false); setMoreOpen(false) } }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [settingsOpen, moreOpen])

  // Jede Navigation schließt das Menü (Auswahl eines Eintrags oder Wechsel woanders hin)
  useEffect(() => { setSettingsOpen(false); setMoreOpen(false); setMobileNavOpen(false) }, [location.pathname])

  const toggleSettings = () => setSettingsOpen(prev => !prev)

  // ── Navigation ────────────────────────────────────────────────────────────
  const verwaltungNavItems = [
    { to: '/admin/dashboard',    key: 'nav.dashboard'       },
    { to: '/objekte',            key: 'nav.properties'      },
    { to: '/kalender',           key: 'nav.calendar'        },
    { to: '/dokumente',          key: 'nav.documents'       },
    { to: '/admin/users',        key: 'adminView.nav.users' },
    { to: '/admin/verwaltungen', key: 'adminView.nav.verwaltungen' },
  ]

  const defaultNavItems = [
    { to: basePath,    key: 'nav.dashboard'  },
    { to: '/objekte',  key: 'nav.properties' },
    { to: '/kalender', key: 'nav.calendar'   },
  ]

  // CRM-Einzel-Links oben: nur die täglichen Arbeits-Seiten (Sven) —
  // alles andere wandert ins „Mehr"-Dropdown.
  const crmTopItems = [
    { to: '/admin/crm/pipeline',      key: 'crm.nav.pipeline'   },
    { to: '/admin/crm/leads',         key: 'crm.nav.leads'      },
    { to: '/admin/crm/postausgang',   key: 'crm.nav.outbox'     },
    { to: '/admin/crm/calendar',      key: 'crm.nav.calendar'   },
  ]
  const crmMoreItems = [
    { to: '/admin/crm',               key: 'crm.nav.dashboard'    },
    { to: '/admin/crm/tasks',         key: 'crm.nav.tasks'        },
    { to: '/admin/crm/projects',      key: 'crm.nav.projects'     },
    { to: '/admin/crm/invoices',      key: 'crm.nav.invoices'     },
    { to: '/admin/crm/statistics',    key: 'crm.nav.statistics'   },
    { to: '/admin/crm/funnel',        key: 'crm.nav.funnel'       },
    { to: '/admin/crm/funnel-editor', key: 'crm.nav.funnelEditor' },
    { to: '/admin/crm/newsletter',    key: 'crm.nav.newsletter'   },
  ]

  // Rolle 'funnel' (Legacy-Mitarbeiter): sieht NUR den Termin-Funnel.
  const isFunnelUser = profile?.role === 'funnel'
  const funnelNavItems = [
    { to: '/admin/crm/funnel',        key: 'crm.nav.funnel'       },
    { to: '/admin/crm/funnel-editor', key: 'crm.nav.funnelEditor' },
  ]

  // Rolle 'mitarbeiter': flache, nach freigeschalteten Rechten gefilterte CRM-Nav —
  // „schön übersichtlich, nur was sie brauchen". Admin/Verwalter haben ihre eigene Nav.
  const isStaff = profile?.role === 'mitarbeiter'
  const staffNavItemsAll: { to: string; key: string; perm: PermissionArea }[] = [
    { to: '/admin/crm',                key: 'crm.nav.dashboard',   perm: 'pipeline' },
    { to: '/admin/crm/pipeline',       key: 'crm.nav.pipeline',    perm: 'pipeline' },
    { to: '/admin/crm/leads',          key: 'crm.nav.leads',       perm: 'pipeline' },
    { to: '/admin/crm/postausgang',    key: 'crm.nav.outbox',      perm: 'pipeline' },
    { to: '/admin/crm/calendar',       key: 'crm.nav.calendar',    perm: 'pipeline' },
    { to: '/admin/crm/projects',       key: 'crm.nav.projects',    perm: 'pipeline' },
    { to: '/admin/crm/funnel',         key: 'crm.nav.funnel',      perm: 'funnel'   },
    { to: '/admin/crm/funnel-editor',  key: 'crm.nav.funnelEditor',perm: 'funnel'   },
    { to: '/admin/crm/newsletter',     key: 'crm.nav.newsletter',  perm: 'funnel'   },
    { to: '/admin/crm/invoices',       key: 'crm.nav.invoices',    perm: 'invoices' },
    { to: '/admin/crm/settings/contacts', key: 'crm.nav.contacts', perm: 'contacts' },
  ]
  // Startseite + Aufgaben stehen JEDEM Mitarbeiter offen (kein Bereichs-Recht),
  // davor die rechte-gefilterten Bereiche.
  const staffNavItems: { to: string; key: string }[] = [
    { to: '/admin/crm/home',  key: 'crm.nav.home'  },
    { to: '/admin/crm/tasks', key: 'crm.nav.tasks' },
    ...staffNavItemsAll.filter(i => hasPerm(profile, i.perm)).map(({ to, key }) => ({ to, key })),
  ]

  // CRM Settings-Untermenü-Einträge
  // Nachrichten je Stage (stages) ersetzt die alten Einzelseiten
  // „E-Mail Vorlagen" / „WhatsApp" / „Automation" (Routen bleiben registriert).
  const crmSettingsItems: ({ to: string; key: string } | { heading: string })[] = [
    { to: '/admin/crm/settings/stages',      key: 'crm.nav.stages'      },
    { to: '/admin/crm/settings/ai',          key: 'crm.nav.ai'          },
    { to: '/admin/crm/settings/documents',   key: 'crm.nav.documents'   },
    { to: '/admin/crm/settings/contacts',    key: 'crm.nav.contacts'    },
    { to: '/admin/crm/settings/invoices',    key: 'crm.nav.invoiceSettings' },
    { to: '/admin/crm/settings',             key: 'crm.nav.developers'  },
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
      // Kalender-Verbindung liegt inzwischen server-seitig (Service-Account) —
      // localStorage darf beim Logout bedenkenlos komplett geleert werden.
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
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">

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

            {/* Admin: CRM | Verwaltung Toggle – immer sichtbar für Admin */}
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

            {/* Navigation — erst ab xl (≥1280px) horizontal; darunter Hamburger.
                Die volle CRM-Admin-Leiste (Pipeline · Kunden · Projekte · Einstellungen
                + Sprache/Rolle/Profil) überläuft bei lg sonst → „Einstellungen" ragt in „EN". */}
            <nav className="hidden xl:flex gap-1 items-center">

              {/* ── Admin CRM-Ansicht ── */}
              {isAdmin && adminView === 'crm' && (
                <>
                  {/* Hauptlinks: Pipeline · Kontakte · Postausgang · Kalender */}
                  {crmTopItems.map(({ to, key }) => (
                    <Link key={to} to={to}
                      className={navLinkClass(to)}
                      style={isActive(to) ? { backgroundColor: '#ff795d' } : undefined}
                    >
                      {t(key)}
                    </Link>
                  ))}

                  {/* Mehr (aufklappbar): Dashboard, Projekte, Rechnungen, Statistiken, Funnel */}
                  <div className="relative" ref={moreRef}>
                    <button
                      onClick={() => setMoreOpen(prev => !prev)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium font-body
                                  transition-colors flex items-center gap-1 ${
                        crmMoreItems.some(i => isActive(i.to))
                          ? 'text-white'
                          : 'text-gray-600 hover:bg-gray-100 hover:text-hp-black'
                      }`}
                      style={crmMoreItems.some(i => isActive(i.to)) ? { backgroundColor: '#ff795d' } : undefined}
                    >
                      {t('crm.nav.more', 'Mehr')}
                      <svg
                        className={`w-3 h-3 mt-0.5 transition-transform duration-200 ${moreOpen ? 'rotate-180' : ''}`}
                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {moreOpen && (
                      <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200
                                      rounded-xl shadow-lg z-50 min-w-[200px] py-1.5 overflow-hidden">
                        {crmMoreItems.map(({ to, key }) => (
                          <Link key={to} to={to}
                            className={`flex items-center gap-2.5 px-4 py-2 text-sm font-body
                                        transition-colors ${
                              isActive(to)
                                ? 'font-semibold'
                                : 'text-gray-700 hover:bg-gray-50 hover:text-hp-black'
                            }`}
                            style={isActive(to) ? { color: '#ff795d' } : undefined}
                          >
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

                  {/* Einstellungen (aufklappbar) */}
                  <div className="relative" ref={settingsRef}>
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
                        {crmSettingsItems.map((item) => (
                          'heading' in item ? (
                            <div key={item.heading}
                              className="px-4 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 select-none">
                              {t(item.heading)}
                            </div>
                          ) : (
                            <Link key={item.to} to={item.to}
                              className={`flex items-center gap-2.5 px-4 py-2 text-sm font-body
                                          transition-colors ${
                                isActive(item.to)
                                  ? 'font-semibold'
                                  : 'text-gray-700 hover:bg-gray-50 hover:text-hp-black'
                              }`}
                              style={isActive(item.to) ? { color: '#ff795d' } : undefined}
                            >
                              {/* aktiver Indikator-Balken */}
                              <span
                                className="w-1 h-4 rounded-full shrink-0"
                                style={{ backgroundColor: isActive(item.to) ? '#ff795d' : 'transparent' }}
                              />
                              {t(item.key)}
                            </Link>
                          )
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
              {/* ── Funnel-Mitarbeiter: nur Statistik + Editor ── */}
              {isFunnelUser && (
                <>
                  {funnelNavItems.map(({ to, key }) => (
                    <Link key={to} to={to}
                      className={navLinkClass(to)}
                      style={isActive(to) ? { backgroundColor: '#ff795d' } : undefined}
                    >
                      {t(key)}
                    </Link>
                  ))}
                </>
              )}

              {/* ── Mitarbeiter: nur freigeschaltete Bereiche ── */}
              {isStaff && (
                <>
                  {staffNavItems.map(({ to, key }) => (
                    <Link key={to} to={to}
                      className={navLinkClass(to)}
                      style={isActive(to) ? { backgroundColor: '#ff795d' } : undefined}
                    >
                      {t(key)}
                    </Link>
                  ))}
                </>
              )}

              {!isAdmin && !isFunnelUser && !isStaff && (
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
                          { to: '/admin/crm',           key: 'crm.nav.dashboard'   },
                          { to: '/admin/crm/pipeline',  key: 'crm.nav.pipeline'    },
                          { to: '/admin/crm/leads',     key: 'crm.nav.leads'       },
                          { to: '/admin/crm/projects',  key: 'crm.nav.projects'    },
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
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Hamburger — Admin hat auf Mobil sonst keine Navigation */}
            {isAdmin && (
              <button
                onClick={() => setMobileNavOpen(o => !o)}
                aria-label={t('nav.menu', 'Menü')}
                aria-expanded={mobileNavOpen}
                className="xl:hidden p-2 -ml-1 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  {mobileNavOpen
                    ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    : <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />}
                </svg>
              </button>
            )}
            <LanguageSwitcher />

            {effectiveRole && (
              <span className={`hidden sm:inline text-xs font-semibold font-body
                               px-2.5 py-1 rounded-full ${roleColor}`}>
                {t(`roles.${effectiveRole}`)}
              </span>
            )}

            <Link
              to="/profile"
              className="hidden xl:flex items-center gap-2 px-3 py-1.5 rounded-lg
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

        {/* ── Mobiles Admin-Menü (Hamburger-Inhalt) ── */}
        {isAdmin && mobileNavOpen && (
          <nav className="xl:hidden border-t border-gray-100 bg-white px-3 py-2 space-y-0.5">
            {(adminView === 'crm' ? [...crmTopItems, ...crmMoreItems] : verwaltungNavItems).map(({ to, key }) => (
              <Link key={to} to={to}
                className={`block px-3 py-2.5 rounded-lg text-sm font-medium font-body transition-colors ${
                  isActive(to) ? 'text-white' : 'text-gray-700 hover:bg-gray-100'}`}
                style={isActive(to) ? { backgroundColor: '#ff795d' } : undefined}>
                {t(key)}
              </Link>
            ))}

            {adminView === 'crm' && (
              <>
                <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 select-none">
                  {t('crm.nav.settings')}
                </div>
                {crmSettingsItems.map((item) => (
                  'heading' in item ? null : (
                    <Link key={item.to} to={item.to}
                      className={`block px-3 py-2.5 rounded-lg text-sm font-body transition-colors ${
                        isActive(item.to) ? 'font-semibold' : 'text-gray-700 hover:bg-gray-100'}`}
                      style={isActive(item.to) ? { color: '#ff795d' } : undefined}>
                      {t(item.key)}
                    </Link>
                  )
                ))}
              </>
            )}

            <div className="border-t border-gray-100 my-1.5" />
            <Link to="/profile"
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-body text-gray-700 hover:bg-gray-100 transition-colors">
              <span className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold font-body shrink-0"
                style={{ backgroundColor: 'var(--color-highlight)' }}>{initials}</span>
              {displayName ?? t('nav.profile')}
            </Link>
          </nav>
        )}
      </header>

      {/* ── Content ── */}
      {/* pb-24 = Platz für die mobile Bottom-Nav (md:pb-8 = kein Bottom-Nav sichtbar) */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 md:py-8 pb-24 md:pb-8">
        {children}
      </main>

      {/* Termin-Vorbereitung: poppt ~2 Min vor einem Termin auf (nur Admin) */}
      {isAdmin && <AppointmentPrepPopup />}
      <TaskNotifications />

      {/* ── Mobile Bottom Navigation: Funnel-Mitarbeiter (2 Seiten + Profil) ── */}
      {isFunnelUser && (
        <nav
          className="fixed bottom-0 left-0 right-0 xl:hidden z-50 bg-white border-t border-gray-100"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          <div className="flex items-stretch justify-around">
            <Link to="/admin/crm/funnel"
              className={`flex flex-col items-center gap-0.5 px-3 py-2.5 flex-1 transition-colors
                          ${isActive('/admin/crm/funnel') ? 'text-hp-highlight' : 'text-gray-400'}`}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <span className="text-[10px] font-medium font-body">{t('crm.nav.funnel', 'Termin-Funnel')}</span>
            </Link>
            <Link to="/admin/crm/funnel-editor"
              className={`flex flex-col items-center gap-0.5 px-3 py-2.5 flex-1 transition-colors
                          ${isActive('/admin/crm/funnel-editor') ? 'text-hp-highlight' : 'text-gray-400'}`}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              <span className="text-[10px] font-medium font-body">{t('crm.nav.funnelEditor', 'Funnel-Editor')}</span>
            </Link>
            <Link to="/profile"
              className={`flex flex-col items-center gap-0.5 px-3 py-2.5 flex-1 transition-colors
                          ${isActive('/profile') ? 'text-hp-highlight' : 'text-gray-400'}`}>
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold font-body shrink-0"
                style={{ backgroundColor: isActive('/profile') ? 'var(--color-highlight)' : '#9ca3af' }}>
                {initials}
              </span>
              <span className="text-[10px] font-medium font-body">{t('nav.profile')}</span>
            </Link>
          </div>
        </nav>
      )}

      {/* ── Mobile Bottom Navigation: Mitarbeiter (freigeschaltete Bereiche + Profil) ── */}
      {isStaff && (
        <nav
          className="fixed bottom-0 left-0 right-0 xl:hidden z-50 bg-white border-t border-gray-100"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          <div className="flex items-stretch justify-around">
            {staffNavItems.slice(0, 4).map(({ to, key }) => (
              <Link key={to} to={to}
                className={`flex flex-col items-center gap-0.5 px-2 py-2.5 flex-1 transition-colors
                            ${isActive(to) ? 'text-hp-highlight' : 'text-gray-400'}`}>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
                <span className="text-[10px] font-medium font-body truncate max-w-[64px]">{t(key)}</span>
              </Link>
            ))}
            <Link to="/profile"
              className={`flex flex-col items-center gap-0.5 px-2 py-2.5 flex-1 transition-colors
                          ${isActive('/profile') ? 'text-hp-highlight' : 'text-gray-400'}`}>
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold font-body shrink-0"
                style={{ backgroundColor: isActive('/profile') ? 'var(--color-highlight)' : '#9ca3af' }}>
                {initials}
              </span>
              <span className="text-[10px] font-medium font-body">{t('nav.profile')}</span>
            </Link>
          </div>
        </nav>
      )}

      {/* ── Mobile Bottom Navigation (nur für Nicht-Admin, nur auf kleinen Screens) ── */}
      {!isAdmin && !isFunnelUser && !isStaff && (
        <nav
          className="fixed bottom-0 left-0 right-0 xl:hidden z-50 bg-white border-t border-gray-100"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          <div className="flex items-stretch justify-around">

            {/* Dashboard */}
            <Link to={basePath}
              className={`flex flex-col items-center gap-0.5 px-3 py-2.5 flex-1 transition-colors
                          ${isActive(basePath) ? 'text-hp-highlight' : 'text-gray-400'}`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
              <span className="text-[10px] font-medium font-body">{t('nav.dashboard')}</span>
            </Link>

            {/* Objekte */}
            <Link to="/objekte"
              className={`flex flex-col items-center gap-0.5 px-3 py-2.5 flex-1 transition-colors
                          ${isActive('/objekte') ? 'text-hp-highlight' : 'text-gray-400'}`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              <span className="text-[10px] font-medium font-body">{t('nav.properties')}</span>
            </Link>

            {/* Kalender */}
            <Link to="/kalender"
              className={`flex flex-col items-center gap-0.5 px-3 py-2.5 flex-1 transition-colors
                          ${isActive('/kalender') ? 'text-hp-highlight' : 'text-gray-400'}`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="text-[10px] font-medium font-body">{t('nav.calendar')}</span>
            </Link>

            {/* Dokumente */}
            <Link to="/dokumente"
              className={`flex flex-col items-center gap-0.5 px-3 py-2.5 flex-1 transition-colors
                          ${isActive('/dokumente') ? 'text-hp-highlight' : 'text-gray-400'}`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="text-[10px] font-medium font-body">{t('nav.documents')}</span>
            </Link>

            {/* Profil */}
            <Link to="/profile"
              className={`flex flex-col items-center gap-0.5 px-3 py-2.5 flex-1 transition-colors
                          ${isActive('/profile') ? 'text-hp-highlight' : 'text-gray-400'}`}
            >
              <span
                className="w-5 h-5 rounded-full flex items-center justify-center
                           text-white text-[10px] font-bold font-body shrink-0"
                style={{ backgroundColor: isActive('/profile') ? 'var(--color-highlight)' : '#9ca3af' }}
              >
                {initials}
              </span>
              <span className="text-[10px] font-medium font-body">{t('nav.profile')}</span>
            </Link>

          </div>
        </nav>
      )}

    </div>
  )
}
