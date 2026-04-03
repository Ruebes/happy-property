import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import type { CrmProject } from '../../lib/crmTypes'
import { PROJECT_STATUS_COLORS } from '../../lib/crmTypes'

interface SelectedProjectEntry {
  project: CrmProject
  unit_numbers: string
  price_net: string
  notes: string
}

interface ProjectSelectionModalProps {
  dealId:    string
  leadName:  string
  onClose:   () => void
  onSaved:   () => void
}

export default function ProjectSelectionModal({
  dealId, leadName, onClose, onSaved
}: ProjectSelectionModalProps) {
  const { t } = useTranslation()
  const [projects, setProjects]   = useState<CrmProject[]>([])
  const [selected, setSelected]   = useState<SelectedProjectEntry[]>([])
  const [loading, setLoading]     = useState(true)
  const [saving, setSaving]       = useState(false)
  const [search, setSearch]       = useState('')

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      const [projRes, existRes] = await Promise.all([
        supabase
          .from('crm_projects')
          .select('*, units:crm_project_units(id,unit_number,price_net,status)')
          .neq('status', 'sold_out')
          .order('name'),
        supabase
          .from('deal_projects')
          .select('*, project:crm_projects(id,name,images,location)')
          .eq('deal_id', dealId),
      ])
      const projs = (projRes.data ?? []) as unknown as CrmProject[]
      setProjects(projs)

      const existingEntries = (existRes.data ?? []) as Array<{
        project_id: string; unit_numbers: string | null; price_net: number | null; notes: string | null
      }>

      // Pre-select already linked projects
      const preSelected: SelectedProjectEntry[] = existingEntries
        .map(e => {
          const project = projs.find(p => p.id === e.project_id)
          if (!project) return null
          return {
            project,
            unit_numbers: e.unit_numbers ?? '',
            price_net:    e.price_net?.toString() ?? '',
            notes:        e.notes ?? '',
          }
        })
        .filter((e): e is SelectedProjectEntry => e !== null)
      setSelected(preSelected)
    } finally {
      setLoading(false)
    }
  }

  const toggleProject = (project: CrmProject) => {
    setSelected(prev => {
      const exists = prev.find(e => e.project.id === project.id)
      if (exists) return prev.filter(e => e.project.id !== project.id)
      return [...prev, { project, unit_numbers: '', price_net: '', notes: '' }]
    })
  }

  const updateEntry = (projectId: string, field: 'unit_numbers' | 'price_net' | 'notes', value: string) => {
    setSelected(prev => prev.map(e =>
      e.project.id === projectId ? { ...e, [field]: value } : e
    ))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Delete all existing deal_projects for this deal
      await supabase.from('deal_projects').delete().eq('deal_id', dealId)

      // Insert new selections
      if (selected.length > 0) {
        await supabase.from('deal_projects').insert(
          selected.map(e => ({
            deal_id:      dealId,
            project_id:   e.project.id,
            unit_numbers: e.unit_numbers.trim() || null,
            price_net:    e.price_net ? parseFloat(e.price_net) : null,
            notes:        e.notes.trim() || null,
          }))
        )
      }
      onSaved()
      onClose()
    } catch (err) {
      console.error('[ProjectSelectionModal]', err)
    } finally {
      setSaving(false)
    }
  }

  const filtered = projects.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.location ?? '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {t('crm.dealProject.modal.title', 'Welche Projekte interessieren {{name}}?', { name: leadName })}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">{selected.length} ausgewählt</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        {/* Search */}
        <div className="px-6 py-3 border-b border-gray-50 flex-shrink-0">
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Projekt suchen…"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-8">Keine Projekte gefunden.</p>
          ) : (
            filtered.map(project => {
              const isSelected = selected.some(e => e.project.id === project.id)
              const entry = selected.find(e => e.project.id === project.id)
              const availableUnits = (project.units ?? []).filter((u: {status: string}) => u.status === 'available')

              return (
                <div key={project.id}
                  className={`border-2 rounded-xl transition-colors ${
                    isSelected ? 'border-orange-400 bg-orange-50' : 'border-gray-200 bg-white'
                  }`}>
                  {/* Project header row */}
                  <div className="flex items-center gap-3 p-3 cursor-pointer" onClick={() => toggleProject(project)}>
                    <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${
                      isSelected ? 'border-orange-500 bg-orange-500' : 'border-gray-300'
                    }`}>
                      {isSelected && <span className="text-white text-xs font-bold">✓</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-gray-900">{project.name}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded-full ${PROJECT_STATUS_COLORS[project.status]}`}>
                          {t(`crm.project.statuses.${project.status}`, project.status)}
                        </span>
                      </div>
                      <div className="flex gap-3 text-xs text-gray-500 mt-0.5">
                        {project.location && <span>📍 {project.location}</span>}
                        <span>{availableUnits.length} Units verfügbar</span>
                      </div>
                    </div>
                  </div>

                  {/* Expanded form when selected */}
                  {isSelected && entry && (
                    <div className="px-3 pb-3 space-y-2 border-t border-orange-200 pt-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">
                            {t('crm.dealProject.modal.units', 'Unit(s)')}
                          </label>
                          <input
                            value={entry.unit_numbers}
                            onChange={e => updateEntry(project.id, 'unit_numbers', e.target.value)}
                            placeholder="z.B. 302, 303"
                            className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-orange-400"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">
                            {t('crm.dealProject.modal.priceNet', 'Preis Netto (€)')}
                          </label>
                          <input
                            type="number"
                            value={entry.price_net}
                            onChange={e => updateEntry(project.id, 'price_net', e.target.value)}
                            placeholder="0"
                            className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-orange-400"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 block mb-1">
                          {t('crm.dealProject.modal.notes', 'Bemerkungen')}
                        </label>
                        <textarea
                          value={entry.notes}
                          onChange={e => updateEntry(project.id, 'notes', e.target.value)}
                          rows={2}
                          placeholder="z.B. Payment Plan 40/60, Einrichtungspaket inklusive"
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-orange-400"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">
            {t('crm.dealProject.modal.cancel', 'Abbrechen')}
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#ff795d' }}>
            {saving ? 'Speichert…' : t('crm.dealProject.modal.save', 'Speichern')}
          </button>
        </div>
      </div>
    </div>
  )
}
