import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

// ── Types ──────────────────────────────────────────────────────
interface PropertyCard {
  id:              string
  project_name:    string
  unit_number:     string | null
  type:            'villa' | 'apartment' | 'studio'
  city:            string | null
  images:          string[]
  rental_type:     'longterm' | 'shortterm'
  property_status: 'under_construction' | 'active' | null
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
  const [crmImages,     setCrmImages]     = useState<Record<string, string>>({}) // property_id → first CRM project image

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
          .select('id, project_name, unit_number, type, city, images, rental_type, property_status')
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

        // 2a. CRM-Projektbilder für Properties ohne eigene Bilder holen
        const noImgIds = propList.filter(p => !p.images?.length).map(p => p.id)
        if (noImgIds.length > 0) {
          const { data: unitData } = await supabase
            .from('crm_project_units')
            .select('property_id, project:crm_projects(images)')
            .in('property_id', noImgIds)
          if (!cancelled && unitData) {
            const imgMap: Record<string, string> = {}
            for (const u of unitData) {
              const imgs = (u.project as { images?: string[] } | null)?.images
              if (imgs?.length && u.property_id && !imgMap[u.property_id]) {
                imgMap[u.property_id] = imgs[0]
              }
            }
            setCrmImages(imgMap)
          }
        }

        // 2b. Unit-IDs für CRM-Dokumente ermitteln
        const { data: unitRows } = await supabase
          .from('crm_project_units')
          .select('id')
          .in('property_id', propIds)
        const unitIds = (unitRows ?? []).map((u: { id: string }) => u.id)

        // 2c. Buchungen + Dokumente parallel zählen
        const [bookRes, docRes, crmDocRes] = await Promise.all([
          supabase
            .from('bookings')
            .select('*', { count: 'exact', head: true })
            .in('property_id', propIds),
          supabase
            .from('documents')
            .select('*', { count: 'exact', head: true })
            .in('property_id', propIds),
          unitIds.length > 0
            ? supabase
                .from('crm_unit_documents')
                .select('*', { count: 'exact', head: true })
                .in('unit_id', unitIds)
            : Promise.resolve({ count: 0 }),
        ])

        if (cancelled) return
        setBookingCount(bookRes.count ?? 0)
        setDocCount((docRes.count ?? 0) + (crmDocRes.count ?? 0))
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
      key:       'bookings',
      icon:      '📅',
      value:     loading ? null : bookingCount,
      href:      '/kalender',
      clickable: true,
    },
    {
      key:       'documents',
      icon:      '📄',
      value:     loading ? null : docCount,
      href:      '/dokumente',
      clickable: true,
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
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-50">
          <h2 className="font-semibold text-hp-black font-body text-base">
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
          <div className="flex items-center gap-2 justify-center py-16 text-gray-400 font-body text-sm">
            <span className="w-4 h-4 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
            {t('common.loading')}
          </div>
        ) : properties.length === 0 ? (
          <div className="text-center py-16 px-6">
            <div className="text-5xl mb-4">🏠</div>
            <p className="text-sm font-semibold text-gray-500 font-body">
              {t('dashboard.eigentuemer.noProperties')}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-5">
              {properties.slice(0, 4).map(p => {
                const imgSrc = p.images?.[0] ?? crmImages[p.id] ?? null
                return (
                  <Link
                    key={p.id}
                    to={`/eigentuemer/properties/${p.id}`}
                    className="group rounded-2xl border border-gray-100 overflow-hidden
                               hover:border-hp-highlight hover:shadow-md transition-all">
                    {/* Bild */}
                    <div className="relative h-44 bg-gray-100 overflow-hidden">
                      {imgSrc ? (
                        <img src={imgSrc} alt={p.project_name}
                             className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="text-5xl text-gray-300">{TYPE_ICON[p.type] ?? '🏠'}</span>
                        </div>
                      )}
                      {/* Status-Badge oben links */}
                      {(p.property_status === 'active') ? (
                        <span className="absolute top-2 left-2 text-[10px] font-semibold px-2 py-0.5
                                         rounded-full bg-green-500 text-white shadow-sm flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-white inline-block" />
                          Aktiv
                        </span>
                      ) : (
                        <span className="absolute top-2 left-2 text-[10px] font-semibold px-2 py-0.5
                                         rounded-full bg-amber-500 text-white shadow-sm">
                          🏗 Im Bau
                        </span>
                      )}
                      {/* Miettyp-Badge oben rechts */}
                      <span className="absolute top-2 right-2 text-[10px] font-semibold px-2 py-0.5
                                       rounded-full bg-white/90 backdrop-blur-sm text-gray-600 shadow-sm">
                        {t(`properties.rental.${p.rental_type}`)}
                      </span>
                    </div>
                    {/* Info */}
                    <div className="p-3">
                      <p className="font-semibold text-hp-black font-body text-sm truncate">
                        {p.project_name}
                        {p.unit_number && (
                          <span className="ml-1.5 text-gray-400 font-normal text-xs">· {p.unit_number}</span>
                        )}
                      </p>
                      <p className="text-xs text-gray-400 font-body mt-0.5">📍 {p.city || '—'}</p>
                    </div>
                  </Link>
                )
              })}
            </div>
            {properties.length > 4 && (
              <div className="px-5 pb-5">
                <Link
                  to="/eigentuemer/properties"
                  className="block w-full py-2.5 text-center text-xs font-medium font-body
                             rounded-xl border border-gray-200 text-gray-500
                             hover:border-hp-highlight hover:text-hp-black transition-colors">
                  + {properties.length - 4} weitere anzeigen
                </Link>
              </div>
            )}
          </>
        )}
      </div>

    </DashboardLayout>
  )
}
