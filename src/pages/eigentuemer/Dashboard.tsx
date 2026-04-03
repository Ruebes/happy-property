import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

// ── Types ──────────────────────────────────────────────────────
interface PropertyCard {
  id:           string
  project_name: string
  unit_number:  string | null
  type:         'villa' | 'apartment' | 'studio'
  city:         string | null
  images:       string[]
  rental_type:  'longterm' | 'shortterm'
}

// ── Helpers ────────────────────────────────────────────────────
const TYPE_ICON: Record<string, string> = { villa: '🏡', apartment: '🏢', studio: '🛋️' }

export default function EigentuemerDashboard() {
  const { t }       = useTranslation()
  const { profile } = useAuth()

  const [properties,    setProperties]    = useState<PropertyCard[]>([])
  const [bookingCount,  setBookingCount]  = useState<number | null>(null)
  const [docCount,      setDocCount]      = useState<number | null>(null)
  const [loading,       setLoading]       = useState(true)

  // ── Fetch ──────────────────────────────────────────────────
  useEffect(() => {
    if (!profile?.id) return
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        // 1. Eigene Immobilien laden
        const { data: props } = await supabase
          .from('properties')
          .select('id, project_name, unit_number, type, city, images, rental_type')
          .eq('owner_id', profile!.id)
          .order('project_name')

        if (cancelled) return
        const propList = (props ?? []) as PropertyCard[]
        setProperties(propList)

        if (propList.length === 0) {
          setBookingCount(0)
          setDocCount(0)
          return
        }

        const propIds = propList.map(p => p.id)

        // 2. Buchungen + Dokumente parallel zählen
        const [bookRes, docRes] = await Promise.all([
          supabase
            .from('bookings')
            .select('*', { count: 'exact', head: true })
            .in('property_id', propIds),
          supabase
            .from('documents')
            .select('*', { count: 'exact', head: true })
            .in('property_id', propIds),
        ])

        if (cancelled) return
        setBookingCount(bookRes.count ?? 0)
        setDocCount(docRes.count ?? 0)
      } catch (err) {
        console.error('[Eigentuemer/Dashboard] load:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [profile?.id])

  // ── Stat Cards ─────────────────────────────────────────────
  const statCards = [
    {
      key:   'myProperties',
      icon:  '🏠',
      value: loading ? null : properties.length,
      href:  '/eigentuemer/properties',
      clickable: true,
    },
    {
      key:   'bookings',
      icon:  '📅',
      value: loading ? null : bookingCount,
      href:  null,   // Seite noch nicht vorhanden
      clickable: false,
    },
    {
      key:   'documents',
      icon:  '📄',
      value: loading ? null : docCount,
      href:  null,   // Seite noch nicht vorhanden
      clickable: false,
    },
    {
      key:        'avgReturn',
      icon:       '📈',
      value:      null,
      comingSoon: true,
      href:       null,
      clickable:  false,
    },
  ]

  return (
    <DashboardLayout basePath="/eigentuemer/dashboard">

      {/* ── Begrüßung ─────────────────────────────────────── */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-hp-black"
            style={{ fontFamily: 'var(--font-heading)' }}>
          {t('dashboard.greeting')}, {profile?.full_name?.split(' ')[0] || t('roles.eigentuemer')} 👋
        </h1>
        <p className="mt-1 text-sm text-gray-500 font-body">
          {t('dashboard.eigentuemer.subtitle')}
        </p>
      </div>

      {/* ── Stat-Karten ───────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {statCards.map(({ key, icon, value, comingSoon, href, clickable }) => {
          const inner = (
            <div className={`bg-white rounded-2xl border border-gray-100 p-5 shadow-sm h-full
              ${clickable ? 'hover:border-hp-highlight hover:shadow-md transition-all cursor-pointer' : ''}`}>
              <div className="text-2xl mb-2">{icon}</div>
              {comingSoon ? (
                <>
                  <div className="text-sm font-semibold font-body text-gray-400">
                    {t('dashboard.eigentuemer.returnComingSoon')}
                  </div>
                  <div className="text-xs text-gray-400 font-body mt-0.5">
                    {t('stats.' + key)}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-2xl font-bold font-body text-hp-black">
                    {loading ? (
                      <span className="inline-block w-8 h-6 bg-gray-100 rounded animate-pulse" />
                    ) : (value ?? 0)}
                  </div>
                  <div className="text-xs text-gray-500 font-body mt-0.5">
                    {t('stats.' + key)}
                  </div>
                </>
              )}
            </div>
          )
          return clickable && href ? (
            <Link key={key} to={href} className="block">{inner}</Link>
          ) : (
            <div key={key}>{inner}</div>
          )
        })}
      </div>

      {/* ── Meine Immobilien ──────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-6">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-50">
          <h2 className="font-semibold text-hp-black font-body">
            {t('dashboard.eigentuemer.allPropertiesTitle')}
          </h2>
          {properties.length > 0 && (
            <Link
              to="/eigentuemer/properties"
              className="text-xs font-medium font-body transition-colors"
              style={{ color: 'var(--color-highlight)' }}>
              {t('dashboard.eigentuemer.viewAll')} →
            </Link>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 justify-center py-10 text-gray-400 font-body text-sm">
            <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
            {t('common.loading')}
          </div>
        ) : properties.length === 0 ? (
          <div className="text-center py-10 px-6">
            <div className="text-4xl mb-3">🏠</div>
            <p className="text-sm font-semibold text-gray-500 font-body">
              {t('dashboard.eigentuemer.noProperties')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {properties.slice(0, 5).map(p => (
              <Link
                key={p.id}
                to={`/eigentuemer/properties/${p.id}`}
                className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50/70 transition-colors">

                {/* Thumbnail oder Placeholder */}
                <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 bg-gray-100 flex items-center justify-center">
                  {p.images?.[0] ? (
                    <img src={p.images[0]} alt={p.project_name}
                         className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-xl">{TYPE_ICON[p.type] ?? '🏠'}</span>
                  )}
                </div>

                {/* Name + Ort */}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-hp-black font-body text-sm truncate">
                    {p.project_name}
                    {p.unit_number && (
                      <span className="ml-1 text-gray-400 font-normal">· {p.unit_number}</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-400 font-body mt-0.5">
                    {p.city || '—'} ·{' '}
                    {t(`properties.rental.${p.rental_type}`)}
                  </p>
                </div>

                <span className="text-gray-300 text-sm">›</span>
              </Link>
            ))}

            {properties.length > 5 && (
              <Link
                to="/eigentuemer/properties"
                className="block px-5 py-3 text-center text-xs font-medium font-body text-gray-400 hover:text-hp-black transition-colors">
                + {properties.length - 5} {t('common.noResults').replace('Keine Einträge vorhanden.', 'weitere …')}
                &nbsp;{t('dashboard.eigentuemer.viewAll')}
              </Link>
            )}
          </div>
        )}
      </div>

      {/* ── Datenschutz-Banner ────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="text-3xl">🔒</div>
          <div>
            <h3 className="font-semibold font-body text-hp-black mb-1">
              {t('dashboard.eigentuemer.privacyTitle')}
            </h3>
            <p className="text-sm text-gray-500 font-body">
              {t('dashboard.eigentuemer.privacyDesc')}
            </p>
          </div>
        </div>
      </div>

    </DashboardLayout>
  )
}
