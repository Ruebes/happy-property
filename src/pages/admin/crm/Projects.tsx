import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import type { CrmProject, ProjectStatus } from '../../../lib/crmTypes'
import { PROJECT_STATUS_COLORS } from '../../../lib/crmTypes'

const STORAGE_BUCKET = 'crm-project-images'

// ── Image Upload Helpers ─────────────────────────────────────────────────────

async function uploadImages(files: File[]): Promise<string[]> {
  const urls: string[] = []
  for (const file of files) {
    const ext = file.name.split('.').pop() ?? 'jpg'
    const path = `projects/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, file, { cacheControl: '3600', upsert: false })
    if (!error) {
      const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path)
      urls.push(data.publicUrl)
    }
  }
  return urls
}

async function deleteStorageImage(url: string) {
  // Extract storage path from public URL
  const marker = `/${STORAGE_BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return
  const path = url.slice(idx + marker.length)
  await supabase.storage.from(STORAGE_BUCKET).remove([path])
}

// ── Project Modal ────────────────────────────────────────────────────────────

interface ProjectForm {
  name:           string
  developer:      string
  status:         ProjectStatus
  completion_date: string
  description_de: string
  description_en: string
  location:       string
  equipment_list: string
  video_url:      string
}

interface ProjectModalProps {
  project: CrmProject | null   // null = new
  onClose: () => void
  onSaved: () => void
}

function parseGoogleMapsLocation(input: string): string {
  const coordMatch = input.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
  if (coordMatch) return `${coordMatch[1]},${coordMatch[2]}`
  const qMatch = input.match(/[?&]q=([^&]+)/)
  if (qMatch) return decodeURIComponent(qMatch[1])
  if (input.startsWith('http')) return input
  return input
}

function ProjectModal({ project, onClose, onSaved }: ProjectModalProps) {
  const { t } = useTranslation()
  const [saving, setSaving]       = useState(false)
  const [developers, setDevelopers] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    supabase.from('crm_developers').select('id, name').order('name')
      .then(({ data }) => setDevelopers(data ?? []))
  }, [])
  const [activeTab, setActiveTab] = useState<'basic' | 'location' | 'media'>('basic')
  const [form, setForm] = useState<ProjectForm>({
    name:            project?.name ?? '',
    developer:       project?.developer ?? '',
    status:          project?.status ?? 'available',
    completion_date: project?.completion_date ?? '',
    description_de:  project?.description_de ?? '',
    description_en:  project?.description_en ?? '',
    location:        project?.location ?? '',
    equipment_list:  project?.equipment_list ?? '',
    video_url:       project?.video_url ?? '',
  })
  const [images, setImages]     = useState<string[]>(project?.images ?? [])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver]   = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const up = (k: keyof ProjectForm, v: string) => setForm(prev => ({ ...prev, [k]: v }))

  // ── Image upload ──────────────────────────────────────────────
  const handleImageFiles = async (files: File[]) => {
    if (!files.length) return
    setUploading(true)
    try {
      const urls = await uploadImages(files)
      setImages(prev => [...prev, ...urls])
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'))
    await handleImageFiles(files)
  }

  const handleDeleteImage = async (url: string) => {
    await deleteStorageImage(url)
    setImages(prev => prev.filter(u => u !== url))
  }

  // ── Save project ──────────────────────────────────────────────
  const handleSave = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const payload = {
        name:            form.name.trim(),
        developer:       form.developer.trim() || null,
        status:          form.status,
        completion_date: form.completion_date || null,
        description_de:  form.description_de.trim() || null,
        description_en:  form.description_en.trim() || null,
        location:        form.location.trim() || null,
        equipment_list:  form.equipment_list.trim() || null,
        video_url:       form.video_url.trim() || null,
        images,
      }
      if (project?.id) {
        await supabase.from('crm_projects').update(payload).eq('id', project.id)
      } else {
        await supabase.from('crm_projects').insert(payload)
      }
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const tabs: { id: typeof activeTab; label: string }[] = [
    { id: 'basic',    label: t('crm.project.tabs.basic',    'Grunddaten') },
    { id: 'location', label: t('crm.project.tabs.location', 'Lage') },
    { id: 'media',    label: t('crm.project.tabs.media',    'Medien') + (images.length ? ` (${images.length})` : '') },
  ]

  // Video embed URL helper
  const getEmbedUrl = (url: string) => {
    const ytMatch    = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/)
    const vimeoMatch = url.match(/vimeo\.com\/(\d+)/)
    if (ytMatch)    return `https://www.youtube.com/embed/${ytMatch[1]}`
    if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`
    return null
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">
            {project
              ? t('crm.project.edit', 'Projekt bearbeiten')
              : t('crm.project.new', '+ Neues Projekt')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 px-6 flex-shrink-0">
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-orange-500 text-orange-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* ── Grunddaten ── */}
          {activeTab === 'basic' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.name', 'Projektname')} *
                </label>
                <input value={form.name} onChange={e => up('name', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                  placeholder="z.B. Infinity" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('crm.project.developer', 'Entwickler / Developer')}
                  </label>
                  <select value={form.developer} onChange={e => up('developer', e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 bg-white">
                    <option value="">— Developer wählen —</option>
                    {developers.map(d => (
                      <option key={d.id} value={d.name}>{d.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('crm.project.status', 'Status')}
                  </label>
                  <select value={form.status} onChange={e => up('status', e.target.value as ProjectStatus)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400">
                    {(['available', 'under_construction', 'sold_out', 'completed'] as ProjectStatus[]).map(s => (
                      <option key={s} value={s}>{t(`crm.project.statuses.${s}`, s)}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.completion', 'Geplante Fertigstellung')}
                </label>
                <input type="date" value={form.completion_date} onChange={e => up('completion_date', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.descriptionDe', 'Beschreibung (Deutsch)')}
                </label>
                <textarea rows={4} value={form.description_de} onChange={e => up('description_de', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.descriptionEn', 'Beschreibung (Englisch)')}
                </label>
                <textarea rows={4} value={form.description_en} onChange={e => up('description_en', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.equipment', 'Ausstattungsliste')}
                </label>
                <textarea rows={4} value={form.equipment_list} onChange={e => up('equipment_list', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none"
                  placeholder="z.B. Klimaanlage, Pool, Smart Home, Tiefgarage…" />
              </div>
            </>
          )}

          {/* ── Lage ── */}
          {activeTab === 'location' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.location', 'Standort / Adresse')}
                </label>
                <input value={form.location} onChange={e => up('location', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                  placeholder="z.B. Paphos, Zypern" />
                <p className="text-xs text-gray-400 mt-1">
                  {t('crm.project.locationHint', 'Adresse oder Google Maps Link eingeben.')}
                </p>
              </div>

              {form.location && (
                <>
                  <div className="rounded-xl overflow-hidden border border-gray-200">
                    <iframe
                      title="map"
                      width="100%"
                      height="280"
                      loading="lazy"
                      src={`https://maps.google.com/maps?q=${encodeURIComponent(parseGoogleMapsLocation(form.location))}&output=embed&z=14`}
                      style={{ border: 0 }}
                    />
                  </div>
                  <a
                    href={`https://maps.google.com/?q=${encodeURIComponent(form.location)}`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-orange-500 hover:underline font-medium"
                  >
                    🗺 {t('crm.project.openInMaps', 'In Google Maps öffnen')}
                  </a>
                </>
              )}

              {!form.location && (
                <p className="text-sm text-gray-400 text-center py-8">
                  {t('crm.project.enterLocationFirst', 'Standort eingeben um Karte anzuzeigen.')}
                </p>
              )}
            </>
          )}

          {/* ── Medien ── */}
          {activeTab === 'media' && (
            <>
              {/* Drop zone */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('crm.project.images', 'Bilder')}
                </label>
                <div
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                    dragOver
                      ? 'border-orange-400 bg-orange-50'
                      : 'border-gray-200 hover:border-orange-300 hover:bg-orange-50/30'
                  }`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className="text-3xl mb-2">🖼</div>
                  <p className="text-sm font-medium text-gray-600">
                    {uploading
                      ? t('crm.project.uploading', 'Lädt hoch…')
                      : t('crm.project.dropImages', 'Bilder hierher ziehen oder klicken')}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">PNG, JPG, WEBP — mehrere möglich</p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={e => handleImageFiles(Array.from(e.target.files ?? []))}
                />
              </div>

              {/* Gallery */}
              {images.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">
                    {images.length} {t('crm.project.imagesUploaded', 'Bilder')}
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {images.map((url, idx) => (
                      <div key={idx} className="relative group aspect-video rounded-lg overflow-hidden border border-gray-100">
                        <img src={url} alt="" className="w-full h-full object-cover" />
                        <button
                          onClick={() => handleDeleteImage(url)}
                          className="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full text-xs
                                     flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity
                                     hover:bg-red-600"
                          title={t('crm.project.deleteImage', 'Bild löschen')}
                        >
                          ✕
                        </button>
                        {idx === 0 && (
                          <span className="absolute bottom-1 left-1 text-xs bg-black/60 text-white px-1.5 py-0.5 rounded">
                            {t('crm.project.mainImage', 'Hauptbild')}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Video URL */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('crm.project.videoUrl', 'Video URL (YouTube / Vimeo)')}
                </label>
                <input value={form.video_url} onChange={e => up('video_url', e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                  placeholder="https://youtube.com/watch?v=…" />
              </div>

              {form.video_url && (() => {
                const embedUrl = getEmbedUrl(form.video_url)
                if (!embedUrl) return (
                  <p className="text-xs text-red-500">
                    {t('crm.project.invalidVideoUrl', 'Ungültige Video-URL (YouTube oder Vimeo)')}
                  </p>
                )
                return (
                  <div className="rounded-xl overflow-hidden border border-gray-200">
                    <iframe
                      title="video"
                      width="100%"
                      height="240"
                      src={embedUrl}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      style={{ border: 0 }}
                    />
                  </div>
                )
              })()}
            </>
          )}

        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-gray-600 hover:text-gray-800 border border-gray-200"
          >
            {t('common.cancel', 'Abbrechen')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !form.name.trim() || uploading}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#ff795d' }}
          >
            {saving
              ? t('common.saving', 'Speichert…')
              : t('crm.project.save', 'Projekt speichern')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Projects Page ───────────────────────────────────────────────────────

export default function Projects() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [projects, setProjects]         = useState<CrmProject[]>([])
  const [loading, setLoading]           = useState(true)
  const [filterStatus, setFilterStatus] = useState('')
  const [search, setSearch]             = useState('')
  const [editProject, setEditProject]   = useState<CrmProject | null | undefined>(undefined)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('crm_projects')
        .select('*, units:crm_project_units(id,status)')
        .order('created_at', { ascending: false })
      if (error) throw error
      setProjects((data ?? []) as unknown as CrmProject[])
    } catch (err) {
      console.error('[Projects]', err)
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const filtered = projects.filter(p => {
    if (filterStatus && p.status !== filterStatus) return false
    if (search) {
      const q = search.toLowerCase()
      if (!p.name.toLowerCase().includes(q) &&
          !(p.developer ?? '').toLowerCase().includes(q) &&
          !(p.location ?? '').toLowerCase().includes(q)) return false
    }
    return true
  })

  const handleDelete = async (id: string) => {
    if (!confirm(t('crm.project.confirmDelete', 'Projekt wirklich löschen?'))) return
    await supabase.from('crm_projects').delete().eq('id', id)
    await fetchAll()
  }

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">
            {t('crm.project.title', 'Projekte')}
          </h1>
          <button
            onClick={() => setEditProject(null)}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90 transition-opacity"
            style={{ backgroundColor: '#ff795d' }}
          >
            + {t('crm.project.new', 'Neues Projekt')}
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex gap-3 flex-wrap">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('crm.project.search', 'Suchen nach Name, Developer, Ort…')}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 min-w-[220px]"
          />
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
          >
            <option value="">— {t('crm.project.allStatuses', 'Alle Status')} —</option>
            {(['available', 'under_construction', 'sold_out', 'completed'] as ProjectStatus[]).map(s => (
              <option key={s} value={s}>{t(`crm.project.statuses.${s}`, s)}</option>
            ))}
          </select>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-gray-400 text-center py-16">
            {t('crm.project.noProjects', 'Noch keine Projekte angelegt.')}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map(p => {
              const totalUnits     = p.units?.length ?? 0
              const availableUnits = p.units?.filter((u: { status: string }) => u.status === 'available').length ?? 0
              const mainImage      = p.images?.[0]

              return (
                <div
                  key={p.id}
                  className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => setEditProject(p)}
                >
                  {/* Image */}
                  <div className="h-44 bg-gradient-to-br from-gray-100 to-gray-200 overflow-hidden">
                    {mainImage
                      ? <img src={mainImage} alt={p.name} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center text-5xl">🏗</div>
                    }
                  </div>

                  <div className="p-4 space-y-2">
                    {/* Name + Status */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="font-semibold text-gray-900 truncate">{p.name}</h3>
                        {p.developer && (
                          <p className="text-xs text-gray-500 truncate">{p.developer}</p>
                        )}
                      </div>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${PROJECT_STATUS_COLORS[p.status]}`}>
                        {t(`crm.project.statuses.${p.status}`, p.status)}
                      </span>
                    </div>

                    {/* Location */}
                    {p.location && (
                      <p className="text-xs text-gray-500">📍 {p.location}</p>
                    )}

                    {/* Stats */}
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      <span>{totalUnits} Units</span>
                      {availableUnits > 0 && (
                        <span className="text-green-600 font-medium">{availableUnits} verfügbar</span>
                      )}
                      {p.completion_date && (
                        <span>
                          {new Date(p.completion_date).toLocaleDateString('de-DE', { month: 'short', year: 'numeric' })}
                        </span>
                      )}
                      {p.images?.length > 0 && (
                        <span className="text-gray-400">🖼 {p.images.length}</span>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); navigate(`/admin/crm/projects/${p.id}`) }}
                        className="flex-1 text-center text-xs py-1.5 rounded-lg font-medium text-white transition-colors"
                        style={{ backgroundColor: '#ff795d' }}
                      >
                        🏠 Wohnungen
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditProject(p) }}
                        className="text-xs py-1.5 px-3 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        ✏️
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(p.id) }}
                        className="text-xs py-1.5 px-3 rounded-lg border border-red-100 text-red-400 hover:bg-red-50 transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Project Modal */}
      {editProject !== undefined && (
        <ProjectModal
          project={editProject}
          onClose={() => setEditProject(undefined)}
          onSaved={fetchAll}
        />
      )}
    </DashboardLayout>
  )
}
