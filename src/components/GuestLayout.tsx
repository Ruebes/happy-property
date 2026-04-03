import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import LanguageSwitcher from './LanguageSwitcher'

interface NavItem {
  to:    string
  label: string
  icon:  string
}

interface Props {
  children:     ReactNode
  unreadCount?: number
}

export default function GuestLayout({ children, unreadCount = 0 }: Props) {
  const { t }        = useTranslation()
  const { profile }  = useAuth()
  const location     = useLocation()
  const [open, setOpen]       = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  const nav: NavItem[] = [
    { to: '/feriengast/dashboard',    label: t('guest.nav.booking'),       icon: '🏠' },
    { to: '/feriengast/checkin',      label: t('guest.nav.checkin'),        icon: '🔑' },
    { to: '/feriengast/hausregeln',   label: t('guest.nav.houseRules'),     icon: '📋' },
    { to: '/feriengast/buchung',      label: t('guest.nav.confirmation'),   icon: '📄' },
    { to: '/feriengast/nachrichten',  label: t('guest.nav.messages'),       icon: '💬' },
    { to: '/feriengast/profil',       label: t('guest.nav.profile'),        icon: '👤' },
  ]

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

  const Sidebar = ({ mobile = false }: { mobile?: boolean }) => (
    <aside className={`${mobile ? 'w-full' : 'w-64 shrink-0'} flex flex-col h-full`}>
      {/* Logo */}
      <div className="px-6 py-5 border-b border-gray-100 flex items-center gap-3">
        <img src="/logo.jpg" alt="Happy Property"
             className="w-10 h-10 rounded-xl object-cover" />
        <div>
          <p className="text-xs font-semibold text-hp-black font-body">Happy Property</p>
          <p className="text-xs text-gray-400 font-body">{t('guest.nav.guestPortal')}</p>
        </div>
      </div>

      {/* Guest info */}
      <div className="px-4 py-4 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
               style={{ backgroundColor: 'var(--color-highlight)' }}>
            {profile?.full_name?.charAt(0)?.toUpperCase() ?? '?'}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-hp-black font-body truncate">
              {profile?.full_name}
            </p>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-body">
              {t('roles.feriengast')}
            </span>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {nav.map(item => {
          const active = location.pathname === item.to
          return (
            <Link key={item.to} to={item.to}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-body
                              font-medium transition-colors relative
                              ${active
                                ? 'bg-orange-50 text-hp-highlight'
                                : 'text-gray-600 hover:bg-gray-100 hover:text-hp-black'}`}>
              <span className="text-base">{item.icon}</span>
              <span>{item.label}</span>
              {item.to === '/feriengast/nachrichten' && unreadCount > 0 && (
                <span className="ml-auto bg-red-500 text-white text-xs font-bold
                                 rounded-full w-5 h-5 flex items-center justify-center">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-3 py-4 border-t border-gray-100 space-y-1">
        <div className="px-3 py-2">
          <LanguageSwitcher />
        </div>
        <button onClick={handleSignOut}
                disabled={loggingOut}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm
                           font-body text-gray-500 hover:bg-gray-100 hover:text-red-500
                           transition-colors disabled:opacity-50">
          {loggingOut
            ? <span className="w-4 h-4 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
            : <span>🚪</span>}
          <span>{t('nav.logout')}</span>
        </button>
      </div>
    </aside>
  )

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: 'var(--color-bg)' }}>
      {/* Desktop Sidebar */}
      <div className="hidden md:flex flex-col bg-white border-r border-gray-100 shadow-sm"
           style={{ width: 256, minHeight: '100vh', position: 'sticky', top: 0 }}>
        <Sidebar />
      </div>

      {/* Mobile Header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-white border-b border-gray-100
                      shadow-sm flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <img src="/logo.jpg" alt="" className="w-8 h-8 rounded-lg object-cover" />
          <span className="text-sm font-semibold font-body text-hp-black">Happy Property</span>
        </div>
        <button onClick={() => setOpen(o => !o)}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-600">
          {open ? '✕' : '☰'}
        </button>
      </div>

      {/* Mobile Overlay */}
      {open && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={() => setOpen(false)}>
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-white shadow-xl flex flex-col"
               onClick={e => e.stopPropagation()}>
            <Sidebar mobile />
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 min-w-0 md:p-8 p-4 pt-16 md:pt-8">
        {children}
      </main>
    </div>
  )
}
