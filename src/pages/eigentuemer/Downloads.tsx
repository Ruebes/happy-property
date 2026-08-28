import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../components/DashboardLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

// ── Downloadportal ────────────────────────────────────────────────────────────
// Alles, was Sven über den Upload-Button fürs Eigentümerportal bereitstellt
// (Steuer-Guides, Videos, Leitfäden): allgemeine Inhalte + Inhalte zu den
// eigenen Wohnungen. Sichtbarkeit regelt die Datenbank (RLS od_read):
// property_id NULL = für alle, sonst nur der Eigentümer der Wohnung.

interface DownloadDoc {
  id: string
  title: string
  description: string | null
  kind: string           // 'video' | 'document'
  file_url: string
  property_id: string | null
  created_at: string
}
const isVideoUrl = (d: DownloadDoc) =>
  d.kind === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(d.file_url)

export default function EigentuemerDownloads() {
  const { t, i18n } = useTranslation()
  const { profile } = useAuth()
  const [docs, setDocs] = useState<DownloadDoc[]>([])
  const [propLabels, setPropLabels] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)

  useEffect(() => {
    if (!profile?.id) return
    let cancelled = false
    const safety = setTimeout(() => { if (!cancelled) setLoading(false) }, 12_000)
    void (async () => {
      try {
        const { data, error } = await supabase.from('owner_documents')
          .select('id, title, description, kind, file_url, property_id, created_at')
          .order('created_at', { ascending: false })
        if (error) throw error
        const rows = (data as DownloadDoc[]) ?? []
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
  }, [profile?.id])

  const general = docs.filter(d => !d.property_id)
  const mine = docs.filter(d => d.property_id)

  const card = (d: DownloadDoc) => {
    const video = isVideoUrl(d)
    return (
      <div key={d.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-start gap-3">
          <span className="text-3xl shrink-0">{video ? '🎬' : '📄'}</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-gray-900">{d.title}</p>
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
        ) : (
          <>
            {mine.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">{t('eigentuemer.downloads.mine', 'Zu deinen Wohnungen')}</h2>
                {mine.map(card)}
              </div>
            )}
            {general.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">{t('eigentuemer.downloads.general', 'Für alle Eigentümer')}</h2>
                {general.map(card)}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
