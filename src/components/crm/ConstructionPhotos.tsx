import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import type { ConstructionPhoto } from '../../lib/crmTypes'

// ── ConstructionPhotos ──────────────────────────────────────────────────────────
// Baustellenbilder & -videos für ein Projekt. Eigenständig & wiederverwendbar:
// genutzt sowohl im Projekt-Bearbeiten-Dialog (Medien-Tab) als auch auf der
// Projekt-Detailseite — eine einzige Quelle der Wahrheit.

export default function ConstructionPhotos({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const { profile } = useAuth()

  const [photos,    setPhotos]    = useState<ConstructionPhoto[]>([])
  const [uploading, setUploading] = useState(false)
  const [photoDate, setPhotoDate] = useState(new Date().toISOString().slice(0, 10))
  const [photoDesc, setPhotoDesc] = useState('')
  const [msg,       setMsg]       = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3500) }

  const fetchPhotos = useCallback(async () => {
    if (!projectId) return
    const { data } = await supabase
      .from('construction_photos')
      .select('*')
      .eq('project_id', projectId)
      .order('photo_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setPhotos((data ?? []) as ConstructionPhoto[])
  }, [projectId])

  useEffect(() => { fetchPhotos() }, [fetchPhotos])

  // Eigentümer mit Wohnung in diesem Projekt per E-Mail benachrichtigen
  async function notifyOwners(fileName: string) {
    try {
      const { data: unitCustomers } = await supabase
        .from('crm_project_units')
        .select('property_id')
        .eq('project_id', projectId)
        .not('property_id', 'is', null)
      if (!unitCustomers || unitCustomers.length === 0) return
      const propIds = (unitCustomers as { property_id: string }[]).map(u => u.property_id)
      const { data: owners } = await supabase.from('properties').select('owner_id').in('id', propIds)
      if (!owners || owners.length === 0) return
      const ownerIds = (owners as { owner_id: string }[]).map(o => o.owner_id)
      const { data: profs } = await supabase.from('profiles').select('email, full_name').in('id', ownerIds)
      for (const p of (profs ?? []) as { email: string; full_name: string }[]) {
        void supabase.functions.invoke('send-email', {
          body: {
            to:      p.email,
            subject: t('constructionPhotos.notifyEmailSubject', 'Neue Datei in Ihrem Happy Property Portal'),
            html:    t('constructionPhotos.notifyEmailBody', `<p>Hallo {{firstName}},</p>
<p>es wurde ein neues <strong>Baustellenfoto</strong> für Ihre Immobilie hochgeladen: <em>{{fileName}}</em></p>
<p>Sie können es jederzeit in Ihrem persönlichen Portal einsehen.</p>
<p>Viele Grüße<br>Ihr Happy Property Team</p>`, { firstName: p.full_name.split(' ')[0], fileName }),
          },
        })
      }
    } catch (err) {
      console.warn('[ConstructionPhotos] notifyOwners failed:', err)
    }
  }

  async function handleUpload(files: FileList) {
    if (!projectId || files.length === 0) return
    setUploading(true)
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const ext  = file.name.split('.').pop() ?? 'jpg'
        const path = `${projectId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        const { error: upErr } = await supabase.storage
          .from('construction-photos')
          .upload(path, file, { upsert: false })
        if (upErr) { showMsg(`❌ ${upErr.message}`); continue }
        await supabase.from('construction_photos').insert({
          project_id:  projectId,
          file_path:   path,
          file_name:   file.name,
          file_size:   file.size,
          photo_date:  photoDate || null,
          description: photoDesc.trim() || null,
          uploaded_by: profile?.id ?? null,
        })
        void notifyOwners(file.name)
      }
      showMsg(t('crm.pd.toastConstructionUploaded', { count: files.length }))
      setPhotoDesc('')
      if (inputRef.current) inputRef.current.value = ''
      await fetchPhotos()
    } catch (err) {
      showMsg(`❌ ${err instanceof Error ? err.message : t('constructionPhotos.genericError', 'Fehler')}`)
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(photo: ConstructionPhoto) {
    if (!window.confirm(t('crm.pd.confirmDeleteConstructionPhoto'))) return
    await supabase.storage.from('construction-photos').remove([photo.file_path])
    await supabase.from('construction_photos').delete().eq('id', photo.id)
    await fetchPhotos()
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-gray-900">{t('crm.pd.constructionMedia')}</h2>
          <p className="text-xs text-gray-400 mt-0.5">{t('crm.pd.constructionMediaDesc')}</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={photoDate}
            onChange={e => setPhotoDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#ff795d]"
          />
          <input
            type="text"
            value={photoDesc}
            onChange={e => setPhotoDesc(e.target.value)}
            placeholder={t('crm.pd.descriptionOptional')}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs w-40 focus:outline-none focus:border-[#ff795d]"
          />
          <label className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors
            ${uploading ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-orange-50 text-[#ff795d] border border-[#ff795d] hover:bg-orange-100'}`}>
            {uploading ? t('crm.pd.uploading') : t('crm.pd.uploadMedia')}
            <input
              ref={inputRef}
              type="file"
              accept="image/*,video/mp4,video/quicktime,video/webm,video/mpeg"
              multiple
              disabled={uploading}
              className="hidden"
              onChange={e => { if (e.target.files?.length) handleUpload(e.target.files) }}
            />
          </label>
        </div>
      </div>

      {msg && (
        <p className={`px-6 py-2 text-xs ${msg.startsWith('❌') ? 'text-red-600 bg-red-50' : 'text-green-700 bg-green-50'}`}>{msg}</p>
      )}

      {photos.length === 0 ? (
        <p className="text-center text-gray-400 text-sm py-10">{t('crm.pd.noConstructionMedia')}</p>
      ) : (
        <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {photos.map(photo => {
            const isVideo  = /\.(mp4|mov|webm|mpeg|m4v|avi)$/i.test(photo.file_name)
            const mediaUrl = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/construction-photos/${photo.file_path}`
            return (
              <div key={photo.id} className="relative group rounded-xl overflow-hidden border border-gray-100 bg-gray-50">
                {isVideo ? (
                  <video src={mediaUrl} className="w-full h-32 object-cover" controls preload="metadata" />
                ) : (
                  <img
                    src={mediaUrl}
                    alt={photo.file_name}
                    className="w-full h-32 object-cover cursor-pointer"
                    onClick={() => window.open(mediaUrl, '_blank')}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                )}
                <div className="px-2 py-1.5">
                  {photo.photo_date && (
                    <p className="text-[10px] font-medium text-gray-600">
                      📅 {new Date(photo.photo_date).toLocaleDateString('de-DE')}
                    </p>
                  )}
                  {photo.description && (
                    <p className="text-[10px] text-gray-400 truncate">{photo.description}</p>
                  )}
                </div>
                <button
                  onClick={() => handleDelete(photo)}
                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-red-500 text-white text-xs
                             opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                  title={t('crm.pd.delete')}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
