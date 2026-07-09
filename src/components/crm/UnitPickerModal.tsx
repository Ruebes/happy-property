// UnitPickerModal – wählt eine spezifische Wohnung aus CRM-Projekten aus
// Zeigt alle Projekteinheiten mit vollständigen Parametern (m², Preis, Zimmer, etc.)
// Genutzt in LeadDetail (Zuweisung) und Pipeline (Reservierung/Kaufvertrag).
// Verfügbarkeits-Regel (Sven): Was im Sales-Deck anbietbar ist, ist auch hier
// wählbar — d.h. NICHT verkauft, NICHT fremd-reserviert, NICHT an fremdem
// aktiven Deal. Die Einheit des EIGENEN Kunden (currentLeadId) bleibt immer wählbar.

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import type { CrmProject, CrmProjectUnit } from '../../lib/crmTypes'

interface Props {
  leadName:              string
  preselectedProjectId?: string | null
  currentLeadId?:        string | null
  confirmLabel?:         string
  onClose:               () => void
  onSelect:              (unit: CrmProjectUnit, project: Pick<CrmProject, 'id' | 'name' | 'location' | 'developer'>) => void
}

interface UnitHolder { lead_id: string; name: string }

const STATUS_PILL: Record<string, string> = {
  under_construction: 'bg-blue-100 text-blue-700',
  active:             'bg-green-100 text-green-700',
  proposal:           'bg-amber-100 text-amber-700',
  reserved:           'bg-purple-100 text-purple-700',
  sold:               'bg-red-100 text-red-700',
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

export default function UnitPickerModal({ leadName, preselectedProjectId, currentLeadId, confirmLabel, onClose, onSelect }: Props) {
  const { t } = useTranslation()
  const STATUS_LABEL: Record<string, string> = {
    under_construction: t('unitPickerModal.statusUnderConstruction', 'Im Bau'),
    active:             t('unitPickerModal.statusActive', 'Aktiv'),
    proposal:           t('unitPickerModal.statusProposal', 'Angeboten'),
    reserved:           t('unitPickerModal.statusReserved', 'Reserviert'),
    sold:               t('unitPickerModal.statusSold', 'Verkauft'),
  }
  const [projects,       setProjects]       = useState<CrmProject[]>([])
  const [loading,        setLoading]        = useState(true)
  const [search,         setSearch]         = useState('')
  const [statusFilter,   setStatusFilter]   = useState<'all' | 'active' | 'under_construction'>('all')
  const [expanded,       setExpanded]       = useState<Record<string, boolean>>({})
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null)
  const [selectedUnit,   setSelectedUnit]   = useState<{ unit: CrmProjectUnit; project: CrmProject } | null>(null)
  const [unitHolders,    setUnitHolders]    = useState<Record<string, UnitHolder>>({})

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const [{ data }, { data: dealRows, error: dealErr }] = await Promise.all([
        supabase
          .from('crm_projects')
          .select('*, units:crm_project_units(*, verwalter:verwalter_id(id,full_name))')
          .order('name'),
        // Aktive Deals mit verknüpfter Einheit → "vergeben an"
        supabase
          .from('deals')
          .select('unit_id, lead_id, leads(first_name, last_name)')
          .is('archived_from_phase', null)
          .neq('phase', 'deal_verloren')
          .not('unit_id', 'is', null),
      ])
      if (dealErr) console.error('[UnitPickerModal] deals:', dealErr.message)
      const holders: Record<string, UnitHolder> = {}
      for (const r of (dealRows ?? []) as unknown as Array<{ unit_id: string; lead_id: string; leads: { first_name: string | null; last_name: string | null } | null }>) {
        holders[r.unit_id] = { lead_id: r.lead_id, name: `${r.leads?.first_name ?? ''} ${r.leads?.last_name ?? ''}`.trim() }
      }
      setUnitHolders(holders)
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

  // Verfügbarkeit — gleiche Regel wie im Sales-Deck-Wizard, plus "eigene" Einheit
  function availability(u: CrmProjectUnit): { selectable: boolean; reason?: string; mine?: boolean } {
    const holder = unitHolders[u.id]
    const mine = !!currentLeadId && holder?.lead_id === currentLeadId
    if (mine) return { selectable: true, mine: true }
    if (u.status === 'sold') return { selectable: false, reason: t('unitPickerModal.reasonSold', 'Verkauft') }
    if (holder) return { selectable: false, reason: t('unitPickerModal.reasonTaken', 'Vergeben · {{name}}', { name: holder.name }) }
    if (u.status === 'reserved') return { selectable: false, reason: t('unitPickerModal.statusReserved', 'Reserviert') }
    return { selectable: true }
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
    if (!availability(unit).selectable) return
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
              <h2 className="text-lg font-bold text-gray-900">🏠 {t('unitPickerModal.title', 'Wohnung auswählen')}</h2>
              <p className="text-xs text-gray-400 mt-0.5">{t('unitPickerModal.forLead', 'für {{leadName}}', { leadName })}</p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
          </div>
        </div>

        {/* ── Search + Filter ─────────────────────────────────────────────────── */}
        <div className="px-6 py-3 border-b border-gray-50 flex-shrink-0 space-y-2.5">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('unitPickerModal.searchPlaceholder', 'Projekt, Block oder Wohnungsnummer suchen…')}
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm
                       focus:outline-none focus:border-[#ff795d]"
          />
          <div className="flex gap-2">
            {([
              { v: 'all',                label: t('unitPickerModal.filterAll', 'Alle Einheiten') },
              { v: 'active',             label: `🟢 ${t('unitPickerModal.filterActive', 'Aktiv')}` },
              { v: 'under_construction', label: `🏗 ${t('unitPickerModal.filterUnderConstruction', 'Im Bau')}` },
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
              {search ? t('unitPickerModal.noMatchingUnits', 'Keine passenden Einheiten gefunden.') : t('unitPickerModal.noProjects', 'Keine Projekte vorhanden.')}
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
                        {t('unitPickerModal.yourProject', 'Ihr Projekt')}
                      </span>
                    )}
                    {project.location && (
                      <span className="text-xs text-gray-400 shrink-0">📍 {project.location}</span>
                    )}
                    <span className="text-[10px] text-gray-400 bg-white border border-gray-200
                                     px-2 py-0.5 rounded-full shrink-0">
                      {t('unitPickerModal.unitsCount', '{{count}} Einh.', { count: project.units.length })}
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
                      const isSelected = selectedUnitId === unit.id
                      const avail = availability(unit)

                      return (
                        <div
                          key={unit.id}
                          onClick={() => pickUnit(unit, project)}
                          className={`rounded-xl border-2 p-3 transition-all select-none ${
                            !avail.selectable
                              ? 'border-gray-100 bg-gray-50 opacity-55 cursor-not-allowed'
                              : isSelected
                                ? 'border-[#ff795d] bg-orange-50 shadow-sm cursor-pointer'
                                : 'border-gray-100 bg-white hover:border-orange-300 hover:shadow-sm cursor-pointer'
                          }`}
                        >
                          {/* Unit header row */}
                          <div className="flex items-start justify-between mb-2 gap-2">
                            <div className="min-w-0">
                              {unit.block && (
                                <span className="text-[10px] text-gray-400 font-medium">
                                  {t('unitPickerModal.blockLabel', 'Block {{block}}', { block: unit.block })} ·{' '}
                                </span>
                              )}
                              <span className="text-sm font-bold text-gray-900">
                                {t('unitPickerModal.unitNumberLabel', 'Nr. {{number}}', { number: unit.unit_number })}
                              </span>
                            </div>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${STATUS_PILL[unit.status] ?? 'bg-gray-100 text-gray-600'}`}>
                              {STATUS_LABEL[unit.status] ?? unit.status}
                            </span>
                          </div>

                          {(avail.mine || avail.reason) && (
                            <p className={`-mt-1 mb-2 text-[10px] font-semibold ${avail.mine ? 'text-[#ff795d]' : 'text-gray-500'}`}>
                              {avail.mine
                                ? `★ ${t('unitPickerModal.mineBadge', 'Einheit dieses Kunden')}`
                                : `🔒 ${avail.reason}`}
                            </p>
                          )}

                          {/* Parameters grid */}
                          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-gray-600">
                            <span>
                              🏢 {unit.type === 'apartment' ? t('unitPickerModal.typeApartment', 'Wohnung')
                                 : unit.type === 'villa'    ? t('unitPickerModal.typeVilla', 'Villa')
                                 :                            t('unitPickerModal.typeStudio', 'Studio')}
                            </span>
                            {unit.floor != null && (
                              <span>📶 {t('unitPickerModal.floorLabel', '{{floor}}. OG', { floor: unit.floor })}</span>
                            )}
                            {unit.size_sqm != null && (
                              <span>📐 {unit.size_sqm} m²</span>
                            )}
                            {unit.terrace_sqm != null && (
                              <span>🌿 {t('unitPickerModal.terraceLabel', '{{size}} m² Terr.', { size: unit.terrace_sqm })}</span>
                            )}
                            {unit.bedrooms > 0 && (
                              <span>🛏 {t('unitPickerModal.bedroomsLabel', '{{count}} SZ', { count: unit.bedrooms })}</span>
                            )}
                            {unit.bathrooms > 0 && (
                              <span>🚿 {t('unitPickerModal.bathroomsLabel', '{{count}} Bad', { count: unit.bathrooms })}</span>
                            )}
                            {unit.is_furnished && (
                              <span>🛋 {t('unitPickerModal.furnished', 'Möbliert')}</span>
                            )}
                            {unit.rental_type && (
                              <span>
                                {unit.rental_type === 'short' ? `🏖 ${t('unitPickerModal.rentalShort', 'Kurzzeit')}` : `🏠 ${t('unitPickerModal.rentalLong', 'Langzeit')}`}
                              </span>
                            )}
                            {unit.handover_date && (
                              <span className="col-span-2">
                                📅 {t('unitPickerModal.handoverLabel', 'Übergabe: {{date}}', { date: fmtDate(unit.handover_date) })}
                              </span>
                            )}
                          </div>

                          {/* Price row */}
                          {(unit.price_net != null || unit.price_gross != null) && (
                            <div className="mt-2 pt-2 border-t border-gray-100
                                            flex flex-wrap gap-x-3 text-[11px]">
                              {unit.price_net != null && (
                                <span className="text-gray-500">
                                  {t('unitPickerModal.priceNetLabel', 'Netto')} <strong className="text-gray-700">{fmtPrice(unit.price_net)}</strong>
                                </span>
                              )}
                              {unit.price_gross != null && (
                                <span className="text-gray-700 font-medium">
                                  {t('unitPickerModal.priceGrossLabel', 'Brutto')} <strong>{fmtPrice(unit.price_gross)}</strong>
                                </span>
                              )}
                              {unit.vat_rate > 0 && (
                                <span className="text-gray-400">{t('unitPickerModal.vatLabel', '{{rate}}% MwSt.', { rate: unit.vat_rate })}</span>
                              )}
                            </div>
                          )}

                          {isSelected && (
                            <p className="mt-2 text-xs text-[#ff795d] font-semibold">✓ {t('unitPickerModal.selected', 'Ausgewählt')}</p>
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
                {selectedUnit.unit.block ? ` · ${t('unitPickerModal.blockLabel', 'Block {{block}}', { block: selectedUnit.unit.block })}` : ''}
                {` · ${t('unitPickerModal.unitNumberLabel', 'Nr. {{number}}', { number: selectedUnit.unit.unit_number })}`}
                {selectedUnit.unit.price_gross != null
                  ? ` · ${fmtPrice(selectedUnit.unit.price_gross)}`
                  : selectedUnit.unit.price_net != null
                    ? ` · ${t('unitPickerModal.priceNetSuffix', '{{price}} netto', { price: fmtPrice(selectedUnit.unit.price_net) })}`
                    : ''}
              </div>
              <div className="flex gap-3 shrink-0">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-600 border border-gray-200
                             rounded-xl hover:bg-gray-50"
                >
                  {t('unitPickerModal.cancel', 'Abbrechen')}
                </button>
                <button
                  onClick={() => onSelect(selectedUnit.unit, selectedUnit.project)}
                  className="px-5 py-2 text-sm font-medium text-white rounded-xl"
                  style={{ backgroundColor: '#ff795d' }}
                >
                  {confirmLabel ?? t('unitPickerModal.assignAndActivate', 'Zuweisen & Aktivieren')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400">{t('unitPickerModal.selectUnitPrompt', 'Bitte eine Wohnung auswählen.')}</p>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200
                           rounded-xl hover:bg-gray-50"
              >
                {t('unitPickerModal.cancel', 'Abbrechen')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
