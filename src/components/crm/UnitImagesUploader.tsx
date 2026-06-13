import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { CustomSelect } from '../CustomSelect'

// ── UnitImagesUploader ──────────────────────────────────────────────────────────
// Wohnungsbilder direkt aus dem Projekt hochladen: erst Wohnung wählen, dann Bilder
// hochladen. Bilder liegen in crm_project_units.images (Bucket 'unit-images').

const UNIT_IMG_BUCKET = 'unit-images'

interface UnitRow {
  id:          string
  unit_number: string
  block:       string | null
  images:      string[] | null
}

async function uploadUnitImage(file: File, unitId: string): Promise<string | null> {
  const ext  = file.name.split('.').pop() ?? 'jpg'
  const path = `units/${unitId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const { error } = await supabase.storage
    .from(UNIT_IMG_BUCKET)
    .upload(path, file, { cacheControl: '3600', upsert: false })
  if (error) return null
  const { data } = supabase.storage.from(UNIT_IMG_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

async function removeUnitImageFile(url: string) {
  const marker = `/${UNIT_IMG_BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return
  await supabase.storage.from(UNIT_IMG_BUCKET).remove([url.slice(idx + marker.length)])
}

export default function UnitImagesUploader({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const [units,      setUnits]      = useState<UnitRow[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [uploading,  setUploading]  = useState(false)
  const [msg,        setMsg]        = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3500) }

  const fetchUnits = useCallback(async () => {
    if (!projectId) return
    const { data } = await supabase
      .from('crm_project_units')
      .select('id, unit_number, block, images')
      .eq('project_id', projectId)
      .order('block', { ascending: true, nullsFirst: true })
      .order('unit_number', { ascending: true })
    const rows = (data ?? []) as UnitRow[]
    setUnits(rows)
    setSelectedId(prev => (prev && rows.some(r => r.id === prev) ? prev : (rows[0]?.id ?? '')))
  }, [projectId])

  useEffect(() => { fetchUnits() }, [fetchUnits])

  const selected = units.find(u => u.id === selectedId)
  const images   = selected?.images ?? []

  const unitLabel = (u: UnitRow) => `${u.block ? `Block ${u.block} · ` : ''}${t('crm.unitSelect.no', 'Nr.')} ${u.unit_number}`

  async function handleUpload(files: FileList) {
    if (!selectedId || files.length === 0) return
    setUploading(true)
    try {
      const newUrls: string[] = []
      for (let i = 0; i < files.length; i++) {
        const url = await uploadUnitImage(files[i], selectedId)
        if (url) newUrls.push(url)
      }
      if (newUrls.length === 0) { showMsg('❌ Upload fehlgeschlagen'); return }
      const updated = [...images, ...newUrls]
      const { error } = await supabase.from('crm_project_units').update({ images: updated }).eq('id', selectedId)
      if (error) throw error
      showMsg(t('crm.pd.toastImagesUploaded', { count: newUrls.length }))
      if (inputRef.current) inputRef.current.value = ''
      await fetchUnits()
    } catch (err) {
      showMsg(`❌ ${err instanceof Error ? err.message : 'Fehler'}`)
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(url: string) {
    if (!selectedId) return
    if (!window.confirm(t('crm.project.confirmDeleteUnitImage', 'Dieses Wohnungsbild löschen?'))) return
    await removeUnitImageFile(url)
    const updated = images.filter(u => u !== url)
    await supabase.from('crm_project_units').update({ images: updated }).eq('id', selectedId)
    await fetchUnits()
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100">
        <h2 className="font-semibold text-gray-900">{t('crm.project.unitImages', '🏠 Wohnungsbilder')}</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          {t('crm.project.unitImagesDesc', 'Wohnung wählen, dann Bilder zu dieser Wohnung hochladen.')}
        </p>
      </div>

      {units.length === 0 ? (
        <p className="text-center text-gray-400 text-sm py-10">
          {t('crm.project.noUnitsYet', 'Noch keine Wohnungen im Projekt — zuerst unter „Wohnungen" anlegen.')}
        </p>
      ) : (
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <CustomSelect
                value={selectedId}
                onChange={setSelectedId}
                className="w-full border border-gray-200 rounded-lg text-sm"
                options={units.map(u => ({ value: u.id, label: unitLabel(u) }))}
              />
            </div>
            <label className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors whitespace-nowrap
              ${uploading ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-orange-50 text-[#ff795d] border border-[#ff795d] hover:bg-orange-100'}`}>
              {uploading ? t('crm.pd.uploading', 'Lädt…') : t('crm.pd.uploadImagesMulti', '📷 Bilder hochladen')}
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                disabled={uploading}
                className="hidden"
                onChange={e => { if (e.target.files?.length) handleUpload(e.target.files) }}
              />
            </label>
          </div>

          {msg && (
            <p className={`text-xs ${msg.startsWith('❌') ? 'text-red-600' : 'text-green-700'}`}>{msg}</p>
          )}

          {images.length === 0 ? (
            <p className="text-center text-gray-400 text-sm py-6">
              {t('crm.project.noUnitImages', 'Noch keine Bilder für diese Wohnung.')}
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {images.map((url, idx) => (
                <div key={`${url}-${idx}`} className="relative group rounded-xl overflow-hidden border border-gray-100 bg-gray-50">
                  <img
                    src={url}
                    alt=""
                    className="w-full h-28 object-cover cursor-pointer"
                    onClick={() => window.open(url, '_blank')}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                  <button
                    onClick={() => handleDelete(url)}
                    className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-red-500 text-white text-xs
                               opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    title={t('crm.pd.delete', 'Löschen')}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
