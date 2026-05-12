// UnitPickerModal – wählt eine spezifische Wohnung aus CRM-Projekten aus
// Zeigt alle Projekteinheiten mit vollständigen Parametern (m², Preis, Zimmer, etc.)
// Wird in LeadDetail im Kaufvertrag-Schritt genutzt

import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import type { CrmProject, CrmProjectUnit } from '../../lib/crmTypes'

interface Props {
  leadName:              string
  preselectedProjectId?: string | null
  onClose:               () => void
  onSelect:              (unit: CrmProjectUnit, project: Pick<CrmProject, 'id' | 'name' | 'location'>) => void
}

const STATUS_PILL: Record<string, string> = {
  under_construction: 'bg-blue-100 text-blue-700',
  active:             'bg-green-100 text-green-700',
}
const STATUS_LABEL: Record<string, string> = {
  under_construction: 'Im Bau',
  active:             'Aktiv',
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return '–'
  return new Intl.NumberFormat('de-DE', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(v)
}

function fmtDate(d: string | null): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString('de-DE')
}

export default function UnitPickerModal({ leadName, preselectedProjectId, onClose, onSelect }: Props) {
  const [projects,       setProjects]       = useState<CrmProject[]>([])
  const [loading,        setLoading]        = useState(true)
  const [search,         setSearch]         = useState('')
  const [statusFilter,   setStatusFilter]   = useState<'all' | 'active' | 'under_construction'>('all')
  const [expanded,       setExpanded]       = useState<Record<string, boolean>>({})
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null)
  const [selectedUnit,   setSelectedUnit]   = useState<{ unit: CrmProjectUnit; project: CrmProject } | null>(null)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('crm_projects')
        .select('*, units:crm_project_units(*, verwalter:verwalter_id(id,full_name))')
        .order('name')
      const projs = (data ?? []) as CrmProject[]
      setProjects(projs)
      // Auto-expand all projects (preselected project is always expanded)
      const exp: Record<string, boolean> = {}
      projs.forEach(p => { exp[p.id] = true })
      setExpanded(exp)
    } finally {
      setLoading(false)
    }
  }

  // ── Filter logic ────────────────────────────────────────────────────────────
  const q = search.toLowerCase()
  const filteredProjects = projects
    .map(p => {
      const units = (p.units ?? []).filter(u => {
        const matchesStatus = statusFilter === 'all' || u.status === statusFilter
        const matchesSearch = !q ||
          u.unit_number.toLowerCase().includes(q) ||
          (u.block ?? '').toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          (p.location ?? '').toLowerCase().includes(q)
        return matchesStatus && matchesSearch
      })
      return { ...p, units }
    })
    .filter(p => p.units.length > 0)
    // Sort: preselected project first
    .sort((a, b) => {
      if (preselectedProjectId) {
        if (a.id === preselectedProjectId) return -1
        if (b.id === preselectedProjectId) return  1
      }
      return 0
    })

  function pickUnit(unit: CrmProjectUnit, project: CrmProject) {
    if (unit.status === 'under_construction') return
    setSelectedUnitId(unit.id)
    setSelectedUnit({ unit, project })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-gray-900">🏠 Wohnung auswählen</h2>
              <p className="text-xs text-gray-400 mt-0.5">für {leadName}</p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
          </div>
        </div>

        {/* ── Search + Filter ─────────────────────────────────────────────────── */}
        <div className="px-6 py-3 border-b border-gray-50 flex-shrink-0 space-y-2.5">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Projekt, Block oder Wohnungsnummer suchen…"
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm
                       focus:outline-none focus:border-[#ff795d]"
          />
          <div className="flex gap-2">
            {([
              { v: 'all',                label: 'Alle Einheiten' },
              { v: 'active',             label: '🟢 Aktiv'        },
              { v: 'under_construction', label: '🏗 Im Bau'       },
            ] as const).map(f => (
              <button
                key={f.v}
                onClick={() => setStatusFilter(f.v)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  statusFilter === f.v
                    ? 'text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                style={statusFilter === f.v ? { backgroundColor: '#ff795d' } : {}}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Project list ───────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {loading ? (
            <div className="flex justify-center py-16">
              <span className="w-7 h-7 border-2 border-[#ff795d] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : filteredProjects.length === 0 ? (
            <p className="text-center text-gray-400 py-16 text-sm">
              {search ? 'Keine passenden Einheiten gefunden.' : 'Keine Projekte vorhanden.'}
            </p>
          ) : (
            filteredProjects.map(project => (
              <div key={project.id}
                   className="border border-gray-100 rounded-2xl overflow-hidden">

                {/* Project header (toggle) */}
                <button
                  className={`w-full flex items-center justify-between px-4 py-3 transition-colors ${
                    preselectedProjectId === project.id
                      ? 'bg-orange-50 hover:bg-orange-100'
                      : 'bg-gray-50 hover:bg-gray-100'
                  }`}
                  onClick={() => setExpanded(e => ({ ...e, [project.id]: !e[project.id] }))}
                >
                  <div className="flex items-center gap-3 text-left min-w-0">
                    <span className={`font-semibold text-sm truncate ${
                      preselectedProjectId === project.id ? 'text-[#ff795d]' : 'text-gray-900'
                    }`}>{project.name}</span>
                    {preselectedProjectId === project.id && (
                      <span className="text-[10px] font-medium text-[#ff795d] bg-orange-50 border border-orange-200
                                       px-2 py-0.5 rounded-full shrink-0">
                        Ihr Projekt
                      </span>
                    )}
                    {project.location && (
                      <span className="text-xs text-gray-400 shrink-0">📍 {project.location}</span>
                    )}
                    <span className="text-[10px] text-gray-400 bg-white border border-gray-200
                                     px-2 py-0.5 rounded-full shrink-0">
                      {project.units.length} Einh.
                    </span>
                  </div>
                  <span className="text-gray-400 text-xs ml-2 shrink-0">
                    {expanded[project.id] ? '▲' : '▼'}
                  </span>
                </button>

                {/* Unit grid */}
                {expanded[project.id] && (
                  <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {project.units.map(unit => {
                      const isSold     = unit.status === 'under_construction'
                      const isSelected = selectedUnitId === unit.id

                      return (
                        <div
                          key={unit.id}
                          onClick={() => pickUnit(unit, project)}
                          className={`rounded-xl border-2 p-3 transition-all select-none ${
                            isSelected
                              ? 'border-[#ff795d] bg-orange-50 shadow-sm'
                              : isSold
                                ? 'border-gray-100 bg-gray-50 opacity-40 cursor-not-allowed'
                                : 'border-gray-100 bg-white hover:border-orange-300 hover:shadow-sm cursor-pointer'
                          }`}
                        >
                          {/* Unit header row */}
                          <div className="flex items-start justify-between mb-2 gap-2">
                            <div className="min-w-0">
                              {unit.block && (
                                <span className="text-[10px] text-gray-400 font-medium">
                                  Block {unit.block} ·{' '}
                                </span>
                              )}
                              <span className="text-sm font-bold text-gray-900">
                                Nr. {unit.unit_number}
                              </span>
                            </div>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${STATUS_PILL[unit.status]}`}>
                              {STATUS_LABEL[unit.status] ?? unit.status}
                            </span>
                          </div>

                          {/* Parameters grid */}
                          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-gray-600">
                            <span>
                              🏢 {unit.type === 'apartment' ? 'Wohnung'
                                 : unit.type === 'villa'    ? 'Villa'
                                 :                            'Studio'}
                            </span>
                            {unit.floor != null && (
                              <span>📶 {unit.floor}. OG</span>
                            )}
                            {unit.size_sqm != null && (
                              <span>📐 {unit.size_sqm} m²</span>
                            )}
                            {unit.terrace_sqm != null && (
                              <span>🌿 {unit.terrace_sqm} m² Terr.</span>
                            )}
                            {unit.bedrooms > 0 && (
                              <span>🛏 {unit.bedrooms} SZ</span>
                            )}
                            {unit.bathrooms > 0 && (
                              <span>🚿 {unit.bathrooms} Bad</span>
                            )}
                            {unit.is_furnished && (
                              <span>🛋 Möbliert</span>
                            )}
                            {unit.rental_type && (
                              <span>
                                {unit.rental_type === 'short' ? '🏖 Kurzzeit' : '🏠 Langzeit'}
                              </span>
                            )}
                            {unit.handover_date && (
                              <span className="col-span-2">
                                📅 Übergabe: {fmtDate(unit.handover_date)}
                              </span>
                            )}
                          </div>

                          {/* Price row */}
                          {(unit.price_net != null || unit.price_gross != null) && (
                            <div className="mt-2 pt-2 border-t border-gray-100
                                            flex flex-wrap gap-x-3 text-[11px]">
                              {unit.price_net != null && (
                                <span className="text-gray-500">
                                  Netto <strong className="text-gray-700">{fmtPrice(unit.price_net)}</strong>
                                </span>
                              )}
                              {unit.price_gross != null && (
                                <span className="text-gray-700 font-medium">
                                  Brutto <strong>{fmtPrice(unit.price_gross)}</strong>
                                </span>
                              )}
                              {unit.vat_rate > 0 && (
                                <span className="text-gray-400">{unit.vat_rate}% MwSt.</span>
                              )}
                            </div>
                          )}

                          {isSelected && (
                            <p className="mt-2 text-xs text-[#ff795d] font-semibold">✓ Ausgewählt</p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────────── */}
        <div className="px-6 py-4 border-t border-gray-100 flex-shrink-0">
          {selectedUnit ? (
            <div className="flex items-center justify-between gap-4">
              <div className="text-sm text-gray-700 min-w-0 truncate">
                <span className="font-semibold text-[#ff795d]">✓</span>{' '}
                {selectedUnit.project.name}
                {selectedUnit.unit.block ? ` · Block ${selectedUnit.unit.block}` : ''}
                {` · Nr. ${selectedUnit.unit.unit_number}`}
                {selectedUnit.unit.price_gross != null
                  ? ` · ${fmtPrice(selectedUnit.unit.price_gross)}`
                  : selectedUnit.unit.price_net != null
                    ? ` · ${fmtPrice(selectedUnit.unit.price_net)} netto`
                    : ''}
              </div>
              <div className="flex gap-3 shrink-0">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-600 border border-gray-200
                             rounded-xl hover:bg-gray-50"
                >
                  Abbrechen
                </button>
                <button
                  onClick={() => onSelect(selectedUnit.unit, selectedUnit.project)}
                  className="px-5 py-2 text-sm font-medium text-white rounded-xl"
                  style={{ backgroundColor: '#ff795d' }}
                >
                  Zuweisen & Aktivieren
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400">Bitte eine Wohnung auswählen.</p>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200
                           rounded-xl hover:bg-gray-50"
              >
                Abbrechen
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
