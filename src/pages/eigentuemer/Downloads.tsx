import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import { OWNER_DOC_FOLDERS, folderOf } from '../../lib/ownerDocFolders'

// ── Downloadportal ────────────────────────────────────────────────────────────
// Alles, was Sven über den Upload-Button fürs Eigentümerportal bereitstellt
// (Steuer-Guides, Videos, Leitfäden): allgemeine Inhalte + Inhalte zu den
// eigenen Wohnungen. Sichtbarkeit regelt die Datenbank (RLS od_read):
// property_id NULL = für alle, sonst nur der Eigentümer der Wohnung.
// Gegliedert in Ordner (owner_documents.category, Liste in lib/ownerDocFolders).
// ?ordner=<key> öffnet direkt einen Ordner (Link in Lottes Nachricht).

interface DownloadDoc {
  id: string
  title: string
  description: string | null
  kind: string           // 'video' | 'document'
  file_url: string
  property_id: string | null
  category: string | null
  created_at: string
}
const NEW_MS = 14 * 86400000
const isVideoUrl = (d: DownloadDoc) =>
  d.kind === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(d.file_url)

export default function EigentuemerDownloads() {
  const { t, i18n } = useTranslation()
  const { profile, preview } = useAuth()
  const [docs, setDocs] = useState<DownloadDoc[]>([])
  const [propLabels, setPropLabels] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const openKey = params.get('ordner')
  const en = i18n.language === 'en'
  const openFolder = (key: string | null) => {
    const next = new URLSearchParams(params)
    if (key) next.set('ordner', key); else next.delete('ordner')
    setParams(next)
    window.scrollTo({ top: 0 })
  }

  useEffect(() => {
    if (!profile?.id) return
    let cancelled = false
    const safety = setTimeout(() => { if (!cancelled) setLoading(false) }, 12_000)
    void (async () => {
      try {
        const { data, error } = await supabase.from('owner_documents')
          .select('id, title, description, kind, file_url, property_id, category, created_at')
          .order('created_at', { ascending: false })
        if (error) throw error
        let rows = (data as DownloadDoc[]) ?? []
        // Portal-Vorschau des Admins: RLS zeigt ihm alles, deshalb hier auf das
        // beschränken, was dieser Eigentümer sieht (allgemein + eigene Wohnungen).
        if (preview) {
          const [{ data: own }, { data: co }] = await Promise.all([
            supabase.from('properties').select('id').eq('owner_id', profile.id),
            supabase.from('property_co_owners').select('property_id').eq('profile_id', profile.id),
          ])
          const mineIds = new Set([...((own ?? []) as Array<{ id: string }>).map(x => x.id), ...((co ?? []) as Array<{ property_id: string }>).map(x => x.property_id)])
          rows = rows.filter(d => !d.property_id || mineIds.has(d.property_id))
        }
        if (cancelled) return
        setDocs(rows)
        const propIds = [...new Set(rows.map(d => d.property_id).filter(Boolean))] as string[]
        if (propIds.length) {
          const { data: pr, error: pe } = await supabase.from('properties')
            .select('id, project_name, unit_number').in('id', propIds)
          if (pe) throw pe
          const map: Record<string, string> = {}
          for (const p of (pr ?? []) as Array<{ id: string; project_name: string | null; unit_number: string | null }>) {
            map[p.id] = [p.project_name, p.unit_number].filter(Boolean).join(' ')
          }
          if (!cancelled) setPropLabels(map)
        }
      } catch (err) {
        console.error('[Eigentuemer/Downloads] load:', err)
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
        clearTimeout(safety)
      }
    })()
    return () => { cancelled = true; clearTimeout(safety) }
  }, [profile?.id, preview])

  const isNew = (d: DownloadDoc) => Date.now() - Date.parse(d.created_at) < NEW_MS
  const folders = OWNER_DOC_FOLDERS
    .map(f => ({ ...f, docs: docs.filter(d => folderOf(d.category).key === f.key) }))
    .filter(f => f.docs.length > 0)
  const current = openKey ? folders.find(f => f.key === openKey) ?? null : null

  const card = (d: DownloadDoc) => {
    const video = isVideoUrl(d)
    return (
      <div key={d.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-start gap-3">
          <span className="text-3xl shrink-0">{video ? '🎬' : '📄'}</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-gray-900">
              {d.title}
              {isNew(d) && <span className="ml-2 align-middle text-[10px] font-bold uppercase tracking-wide text-white px-1.5 py-0.5 rounded" style={{ backgroundColor: '#ff795d' }}>{t('eigentuemer.downloads.new', 'Neu')}</span>}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              {d.property_id
                ? `🏠 ${propLabels[d.property_id] ?? t('eigentuemer.downloads.yourUnit', 'Deine Wohnung')}`
                : t('eigentuemer.downloads.forAll', 'Für alle Eigentümer')}
              {' · '}{new Date(d.created_at).toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'de-DE')}
            </p>
            {d.description && (
              <p className="text-sm text-gray-600 mt-2 whitespace-pre-line">{d.description}</p>
            )}
          </div>
          <div className="shrink-0 flex flex-col gap-2">
            {video ? (
              <button onClick={() => setPlaying(p => p === d.id ? null : d.id)}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white"
                style={{ backgroundColor: '#ff795d' }}>
                {playing === d.id ? t('eigentuemer.downloads.close', 'Schließen') : `▶ ${t('eigentuemer.downloads.play', 'Ansehen')}`}
              </button>
            ) : (
              <a href={d.file_url} target="_blank" rel="noreferrer"
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white text-center"
                style={{ backgroundColor: '#ff795d' }}>
                ⬇️ {t('eigentuemer.downloads.open', 'Öffnen')}
              </a>
            )}
          </div>
        </div>
        {video && playing === d.id && (
          <video src={d.file_url} controls autoPlay playsInline className="w-full rounded-xl mt-3 bg-black max-h-[420px]" />
        )}
      </div>
    )
  }

  return (
    <DashboardLayout basePath="/eigentuemer/dashboard">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold font-heading text-hp-black">📥 {t('eigentuemer.downloads.title', 'Downloads')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('eigentuemer.downloads.subtitle', 'Guides, Dokumente und Videos von Happy Property - für dich bereitgestellt.')}
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : loadError ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-6 text-center">
            <p className="text-sm text-gray-500">{t('eigentuemer.downloads.loadError', 'Konnte nicht geladen werden. Bitte Seite neu laden.')}</p>
          </div>
        ) : docs.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center">
            <p className="text-3xl mb-2">🐾</p>
            <p className="text-sm text-gray-500">{t('eigentuemer.downloads.empty', 'Noch keine Inhalte - sobald etwas Neues für dich bereitliegt, sagt Lotte dir Bescheid.')}</p>
          </div>
        ) : current ? (
          <div className="space-y-3">
            <button onClick={() => openFolder(null)} className="text-sm font-medium text-gray-500 hover:text-gray-800">
              ← {t('eigentuemer.downloads.allFolders', 'Alle Ordner')}
            </button>
            <div className="flex items-center gap-3">
              <span className="text-3xl">{current.icon}</span>
              <div>
                <h2 className="text-lg font-bold text-gray-900">{en ? current.en : current.de}</h2>
                <p className="text-xs text-gray-400">{en ? current.hintEn : current.hintDe}</p>
              </div>
            </div>
            {current.docs.map(card)}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {folders.map(f => {
              const fresh = f.docs.filter(isNew).length
              return (
                <button key={f.key} onClick={() => openFolder(f.key)}
                  className="text-left bg-white rounded-2xl border border-gray-100 shadow-sm p-4 hover:border-orange-200 hover:shadow transition flex items-start gap-3">
                  <span className="text-3xl shrink-0">{f.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900">
                      {en ? f.en : f.de}
                      {fresh > 0 && <span className="ml-2 align-middle text-[10px] font-bold uppercase tracking-wide text-white px-1.5 py-0.5 rounded" style={{ backgroundColor: '#ff795d' }}>{fresh} {t('eigentuemer.downloads.new', 'Neu')}</span>}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">{en ? f.hintEn : f.hintDe}</p>
                    <p className="text-xs text-gray-500 mt-1.5">{t('eigentuemer.downloads.count', '{{n}} Einträge', { n: f.docs.length })}</p>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
