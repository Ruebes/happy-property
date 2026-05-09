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
  bedrooms:     number
  size_sqm:     number | null
  city:         string | null
  zip:          string | null
  street:       string | null
  images:       string[]
  rental_type:  'longterm' | 'shortterm'
  is_furnished: boolean
}

// ── Helpers ────────────────────────────────────────────────────
const TYPE_ICON: Record<string, string> = { villa: '🏡', apartment: '🏢', studio: '🛋️' }

export default function EigentuemerProperties() {
  const { t }       = useTranslation()
  const { profile } = useAuth()

  const [properties, setProperties] = useState<PropertyCard[]>([])
  const [loading,    setLoading]    = useState(true)
  const [search,     setSearch]     = useState('')
  const [crmImages,  setCrmImages]  = useState<Record<string, string>>({}) // property_id → first CRM project image

  // ── Fetch ──────────────────────────────────────────────────
  useEffect(() => {
    if (!profile?.id) return
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const { data } = await supabase
          .from('properties')
          .select('id, project_name, unit_number, type, bedrooms, size_sqm, city, zip, street, images, rental_type, is_furnished')
          .eq('owner_id', profile!.id)
          .order('project_name')

        if (cancelled) return
        const propList = (data ?? []) as PropertyCard[]
        setProperties(propList)

        // Fetch CRM project images for properties without own images
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
      } catch (err) {
        console.error('[Eigentuemer/Properties] load:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [profile?.id])

  // ── Filter ─────────────────────────────────────────────────
  const filtered = properties.filter(p => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      p.project_name.toLowerCase().includes(q) ||
      (p.city ?? '').toLowerCase().includes(q) ||
      (p.unit_number ?? '').toLowerCase().includes(q)
    )
  })

  return (
    <DashboardLayout basePath="/eigentuemer/dashboard">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-hp-black"
              style={{ fontFamily: 'var(--font-heading)' }}>
            {t('eigentuemer.propertiesTitle')}
          </h1>
          <p className="text-sm text-gray-400 font-body mt-0.5">
            {properties.length} {t('stats.properties').toLowerCase()}
          </p>
        </div>

        {/* Suche */}
        {properties.length > 0 && (
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('common.search') + ' …'}
            className="px-3 py-2 text-sm border border-gray-200 rounded-xl font-body
                       focus:outline-none focus:border-hp-highlight w-full sm:w-64" />
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center gap-2 justify-center py-16 text-gray-400 font-body text-sm">
          <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      ) : filtered.length === 0 && properties.length === 0 ? (
        <div className="text-center py-16 px-6">
          <div className="text-5xl mb-4">🏠</div>
          <p className="text-base font-semibold text-gray-500 font-body mb-1">
            {t('eigentuemer.propertiesEmpty')}
          </p>
          <p className="text-sm text-gray-400 font-body">
            {t('eigentuemer.propertiesHint')}
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400 font-body text-sm">
          {t('common.noResults')}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(p => (
            <Link
              key={p.id}
              to={`/eigentuemer/properties/${p.id}`}
              className="group bg-white rounded-2xl border border-gray-100 shadow-sm
                         hover:border-hp-highlight hover:shadow-md transition-all overflow-hidden">

              {/* Bild */}
              <div className="relative h-44 bg-gray-100 overflow-hidden">
                {(p.images?.[0] || crmImages[p.id]) ? (
                  <img
                    src={p.images?.[0] ?? crmImages[p.id]}
                    alt={p.project_name}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-5xl text-gray-300">
                    {TYPE_ICON[p.type] ?? '🏠'}
                  </div>
                )}
                {/* Rental badge */}
                <span className="absolute top-3 right-3 text-xs font-semibold px-2.5 py-1
                                 rounded-full bg-white/90 backdrop-blur-sm text-gray-600 shadow-sm">
                  {t(`properties.rental.${p.rental_type}`)}
                </span>
              </div>

              {/* Info */}
              <div className="p-4">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <h3 className="font-semibold text-hp-black font-body leading-tight">
                      {p.project_name}
                    </h3>
                    {p.unit_number && (
                      <span className="text-xs text-gray-400 font-body">{p.unit_number}</span>
                    )}
                  </div>
                  <span className="text-xl shrink-0">{TYPE_ICON[p.type] ?? '🏠'}</span>
                </div>

                {/* Adresse */}
                {p.city && (
                  <p className="text-xs text-gray-400 font-body mb-3">
                    📍 {[p.zip, p.city].filter(Boolean).join(' ')}
                  </p>
                )}

                {/* Meta */}
                <div className="flex items-center gap-3 text-xs text-gray-500 font-body">
                  {p.bedrooms > 0 && (
                    <span>🛏️ {p.bedrooms}</span>
                  )}
                  {p.size_sqm && (
                    <span>📐 {p.size_sqm} m²</span>
                  )}
                  <span>{p.is_furnished ? '🛋️' : '🏠'} {t(p.is_furnished ? 'properties.furnishedYes' : 'properties.furnishedNo')}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

    </DashboardLayout>
  )
}
