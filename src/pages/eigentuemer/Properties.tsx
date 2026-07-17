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
  const [imgError,   setImgError]   = useState<Set<string>>(new Set())     // property_ids mit kaputter Bild-URL

  // ── Fetch ──────────────────────────────────────────────────
  useEffect(() => {
    if (!profile?.id) return
    let cancelled = false
    // Sicherheits-Timeout: Spinner nie ewig hängen lassen (Safari/Query-Timing)
    const safety = setTimeout(() => { if (!cancelled) setLoading(false) }, 12_000)

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
        setLoading(false)   // Objekte da → Spinner sofort weg; Rest lädt im Hintergrund nach

        if (propList.length === 0) return
        const propIds = propList.map(p => p.id)

        // Kanonische Unit-Daten (Name/Zimmer/Größe/Ort/Bild) aus der ZENTRALEN Tabelle
        // ziehen und über die (evtl. leere/veraltete) properties-Kopie legen. Single source.
        const { data: unitData } = await supabase
          .from('crm_project_units')
          .select('property_id, bedrooms, size_sqm, project:crm_projects(name, images, location)')
          .in('property_id', propIds)
        if (!cancelled && unitData) {
          const metaMap: Record<string, { name?: string; bedrooms?: number; size?: number | null; city?: string; img?: string }> = {}
          for (const u of unitData) {
            const pid = (u as { property_id?: string | null }).property_id
            if (!pid) continue
            const proj = (u as { project?: { name?: string; images?: string[]; location?: string } | null }).project
            const loc = proj?.location
            metaMap[pid] = {
              name:     proj?.name || undefined,
              bedrooms: (u as { bedrooms?: number }).bedrooms ?? undefined,
              size:     (u as { size_sqm?: number | null }).size_sqm ?? undefined,
              city:     (typeof loc === 'string' && !loc.startsWith('http')) ? loc : undefined,
              img:      proj?.images?.[0],
            }
          }
          setProperties(propList.map(p => ({
            ...p,
            project_name: metaMap[p.id]?.name || p.project_name,
            bedrooms:     metaMap[p.id]?.bedrooms ?? p.bedrooms,
            size_sqm:     metaMap[p.id]?.size ?? p.size_sqm,
            city:         p.city || metaMap[p.id]?.city || null,
          })))
          const imgMap: Record<string, string> = {}
          for (const p of propList) if (!p.images?.length && metaMap[p.id]?.img) imgMap[p.id] = metaMap[p.id]!.img!
          setCrmImages(imgMap)
        }
      } catch (err) {
        console.error('[Eigentuemer/Properties] load:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true; clearTimeout(safety) }
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
                {(p.images?.[0] || crmImages[p.id]) && !imgError.has(p.id) ? (
                  <img
                    src={p.images?.[0] ?? crmImages[p.id]}
                    alt={p.project_name}
                    onError={() => setImgError(s => new Set(s).add(p.id))}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-5xl text-gray-300">
                    {TYPE_ICON[p.type] ?? '🏠'}
                  </div>
                )}
                {/* Rental badge — nur bei gesetztem Vermietungstyp (sonst roher i18n-Key) */}
                {p.rental_type && (
                  <span className="absolute top-3 right-3 text-xs font-semibold px-2.5 py-1
                                   rounded-full bg-white/90 backdrop-blur-sm text-gray-600 shadow-sm">
                    {t(`properties.rental.${p.rental_type}`)}
                  </span>
                )}
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
