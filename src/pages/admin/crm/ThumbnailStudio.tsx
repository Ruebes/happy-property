import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'

// ── Thumbnail-Studio ────────────────────────────────────────────────────────
// Chatfenster: Prompt eingeben → fotorealistisches Thumbnail mit Sven/Lotte
// (trainierte Soul-Charaktere) im passenden Plattform-Format. Bei YouTube kann
// das Bild direkt als Thumbnail auf ein Kanal-Video gesetzt werden — die
// Veröffentlichung/Freigabe des Videos selbst bleibt bei YouTube.

interface ThumbItem {
  id: string | null
  platform: string
  prompt: string
  persona: string
  image_url: string
  video_id: string | null
  created_at: string
}
interface YtVideo { video_id: string; title: string; published_at: string; thumb: string }

const PLATFORMS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'youtube',   label: '▶️ YouTube',     hint: '16:9' },
  { key: 'instagram', label: '📸 Instagram',   hint: '3:4' },
  { key: 'story',     label: '📱 Story/Reel',  hint: '9:16' },
  { key: 'facebook',  label: '📘 Facebook',    hint: '1:1' },
  { key: 'linkedin',  label: '💼 LinkedIn',    hint: '16:9' },
]
const PERSONAS: Array<{ key: string; label: string }> = [
  { key: 'sven',  label: '🧑 Mit Sven' },
  { key: 'lotte', label: '🐕 Mit Lotte' },
  { key: 'none',  label: '🏝️ Ohne Person' },
]

export default function ThumbnailStudio() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const basePath = '/admin/crm'
  const [items, setItems] = useState<ThumbItem[]>([])
  const [loading, setLoading] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [platform, setPlatform] = useState('youtube')
  const [persona, setPersona] = useState('sven')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [videos, setVideos] = useState<YtVideo[] | null>(null)
  const [pickFor, setPickFor] = useState<ThumbItem | null>(null)
  const [settingVid, setSettingVid] = useState('')
  const [toast, setToast] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3500) }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('social-agent', { body: { action: 'thumbnail_list' } })
      if (error) throw error
      setItems(((data as { items?: ThumbItem[] } | null)?.items ?? []))
    } catch (e) {
      console.error('[ThumbnailStudio] load:', e); setItems([])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [items.length, busy])

  const generate = async () => {
    const p = prompt.trim()
    if (!p || busy) return
    setBusy(true); setErr('')
    try {
      // Hintergrund-Job + Polling: Soul-Bilder brauchen oft >60 s und Safari
      // bricht Anfragen nach 60 s ab („Failed to send a request …", 21.8.).
      const { data, error } = await supabase.functions.invoke('social-agent', {
        body: { action: 'thumbnail_generate', prompt: p, platform, persona, user_id: profile?.id ?? null },
      })
      if (error) throw error
      const d = data as { ok?: boolean; id?: string | null; error?: string } | null
      if (!d?.ok || !d.id) throw new Error(d?.error || t('crm.thumbs.genErr', 'Generierung fehlgeschlagen.'))
      let url = ''
      for (let i = 0; i < 75; i++) {                       // bis ~5 Minuten
        await new Promise(r => setTimeout(r, 4000))
        const { data: st } = await supabase.functions.invoke('social-agent', { body: { action: 'thumbnail_status', id: d.id } })
        const sd = st as { status?: string; url?: string; error?: string } | null
        if (sd?.status === 'done' && sd.url) { url = sd.url; break }
        if (sd?.status === 'error') throw new Error(sd.error || t('crm.thumbs.genErr', 'Generierung fehlgeschlagen.'))
      }
      if (!url) throw new Error(t('crm.thumbs.genTimeout', 'Dauert ungewöhnlich lange - schau gleich in der Liste nach, das Bild erscheint dort, sobald es fertig ist.'))
      setItems(list => [...list, { id: d.id ?? null, platform, prompt: p, persona, image_url: url, video_id: null, created_at: new Date().toISOString() }])
      setPrompt('')
    } catch (e) {
      console.error('[ThumbnailStudio] generate:', e)
      setErr(e instanceof Error ? e.message : t('crm.thumbs.genErr', 'Generierung fehlgeschlagen.'))
    } finally { setBusy(false) }
  }

  const openPicker = async (item: ThumbItem) => {
    setPickFor(item)
    if (videos === null) {
      try {
        const { data, error } = await supabase.functions.invoke('social-agent', { body: { action: 'thumbnail_videos' } })
        if (error) throw error
        const d = data as { items?: YtVideo[]; error?: string } | null
        if (d?.error) throw new Error(d.error)
        setVideos(d?.items ?? [])
      } catch (e) {
        console.error('[ThumbnailStudio] videos:', e)
        setVideos([])
        showToast(t('crm.thumbs.videosErr', 'Videoliste konnte nicht geladen werden.'))
      }
    }
  }

  const setOnVideo = async (videoId: string) => {
    if (!pickFor || settingVid) return
    setSettingVid(videoId)
    try {
      const { data, error } = await supabase.functions.invoke('social-agent', {
        body: { action: 'thumbnail_set', video_id: videoId, url: pickFor.image_url, id: pickFor.id ?? undefined },
      })
      if (error) throw error
      const d = data as { ok?: boolean; error?: string } | null
      if (!d?.ok) throw new Error(d?.error || 'Fehler')
      setItems(list => list.map(x => x === pickFor ? { ...x, video_id: videoId } : x))
      setPickFor(null)
      showToast(t('crm.thumbs.setOk', '✅ Thumbnail ist auf dem Video gesetzt.'))
    } catch (e) {
      console.error('[ThumbnailStudio] set:', e)
      showToast(t('crm.thumbs.setErr', 'Setzen fehlgeschlagen: {{msg}}', { msg: e instanceof Error ? e.message : '' }))
    } finally { setSettingVid('') }
  }

  const platMeta = (key: string) => PLATFORMS.find(p => p.key === key)
  const aspectClass = (key: string) =>
    key === 'story' ? 'aspect-[9/16] max-w-[240px]' : key === 'instagram' ? 'aspect-[3/4] max-w-[300px]' : key === 'facebook' ? 'aspect-square max-w-[340px]' : 'aspect-video max-w-[440px]'

  const chip = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${active ? 'text-white border-transparent' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`

  return (
    <DashboardLayout basePath={basePath}>
      <div className="max-w-3xl mx-auto px-4 py-6 flex flex-col" style={{ minHeight: 'calc(100vh - 120px)' }}>
        <h1 className="text-xl font-bold text-gray-900 mb-1">🖼️ {t('crm.thumbs.title', 'Thumbnail-Studio')}</h1>
        <p className="text-sm text-gray-500 mb-5">
          {t('crm.thumbs.subtitle', 'Beschreibe das Motiv, wähle Plattform und Person - das Bild wird fotorealistisch mit den trainierten Charakteren erstellt. Bei YouTube kannst du es direkt aufs Video setzen.')}
        </p>

        <div className="flex-1 space-y-6">
          {loading ? (
            <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" /></div>
          ) : items.length === 0 && !busy ? (
            <div className="text-center border-2 border-dashed border-gray-200 rounded-2xl py-14 px-6">
              <p className="text-3xl mb-2">🖼️</p>
              <p className="text-sm text-gray-600 font-medium">{t('crm.thumbs.empty', 'Noch keine Thumbnails.')}</p>
              <p className="text-xs text-gray-400 mt-1">{t('crm.thumbs.emptyHint', 'Beschreib unten dein erstes Motiv, z.B. „Sven zeigt auf einen Neubau in Paphos, überraschter Blick, Meer im Hintergrund".')}</p>
            </div>
          ) : (
            items.map((it, i) => (
              <div key={it.id ?? i} className="space-y-2">
                <div className="flex justify-end">
                  <div className="bg-orange-50 border border-orange-100 rounded-2xl rounded-br-md px-4 py-2.5 max-w-[85%]">
                    <p className="text-sm text-gray-800 whitespace-pre-wrap">{it.prompt}</p>
                    <p className="text-[11px] text-gray-400 mt-1">
                      {platMeta(it.platform)?.label ?? it.platform} · {PERSONAS.find(p => p.key === it.persona)?.label.replace(/^\S+\s/, '') ?? it.persona}
                    </p>
                  </div>
                </div>
                <div className="flex flex-col items-start gap-2">
                  <div className={`${aspectClass(it.platform)} w-full overflow-hidden rounded-2xl rounded-tl-md border border-gray-200 bg-gray-100`}>
                    <img src={it.image_url} alt={it.prompt.slice(0, 60)} className="w-full h-full object-cover" loading="lazy" />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={it.image_url} target="_blank" rel="noreferrer" download
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50">
                      ⬇️ {t('crm.thumbs.download', 'Herunterladen')}
                    </a>
                    {it.platform === 'youtube' && (
                      it.video_id ? (
                        <a href={`https://youtu.be/${it.video_id}`} target="_blank" rel="noreferrer"
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-100">
                          ✅ {t('crm.thumbs.onVideo', 'Auf Video gesetzt')}
                        </a>
                      ) : (
                        <button onClick={() => void openPicker(it)}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white" style={{ backgroundColor: '#ff795d' }}>
                          📺 {t('crm.thumbs.setBtn', 'Auf YouTube-Video setzen')}
                        </button>
                      )
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
          {busy && (
            <div className="flex items-center gap-3 text-sm text-gray-500">
              <div className="w-5 h-5 border-[3px] border-orange-300 border-t-orange-500 rounded-full animate-spin" />
              {t('crm.thumbs.generating', 'Bild wird erstellt … dauert etwa eine Minute.')}
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="sticky bottom-0 bg-white/95 backdrop-blur border-t border-gray-100 pt-3 pb-2 mt-6 -mx-4 px-4">
          <div className="flex flex-wrap gap-1.5 mb-2">
            {PLATFORMS.map(p => (
              <button key={p.key} onClick={() => setPlatform(p.key)} className={chip(platform === p.key)}
                style={platform === p.key ? { backgroundColor: '#ff795d' } : undefined}
                title={p.hint}>
                {p.label} <span className="opacity-70">{p.hint}</span>
              </button>
            ))}
            <span className="w-px bg-gray-200 mx-1 self-stretch" />
            {PERSONAS.map(p => (
              <button key={p.key} onClick={() => setPersona(p.key)} className={chip(persona === p.key)}
                style={persona === p.key ? { backgroundColor: '#0f172a' } : undefined}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void generate() } }}
              rows={2}
              placeholder={t('crm.thumbs.placeholder', 'Motiv beschreiben … z.B. „Sven hält einen Schlüssel hoch, im Hintergrund ein Neubau mit Pool, dramatisches Abendlicht"')}
              className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400 resize-none"
            />
            <button onClick={() => void generate()} disabled={busy || !prompt.trim()}
              className="px-5 rounded-xl text-white text-sm font-semibold disabled:opacity-50 self-stretch" style={{ backgroundColor: '#ff795d' }}>
              {busy ? '…' : t('crm.thumbs.go', 'Erstellen')}
            </button>
          </div>
          {err && <p className="text-xs text-red-600 mt-1.5">{err}</p>}
          <p className="text-[11px] text-gray-400 mt-1.5">
            {t('crm.thumbs.textHint', 'Tipp: Text auf dem Bild lieber nachträglich im Schnittprogramm ergänzen - KI-Schrift ist oft fehlerhaft.')}
          </p>
        </div>
      </div>

      {pickFor && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={() => setPickFor(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-1">{t('crm.thumbs.pickTitle', 'Auf welches Video?')}</h2>
            <p className="text-xs text-gray-500 mb-4">{t('crm.thumbs.pickHint', 'Das Bild wird auf 1280×720 zugeschnitten und ersetzt das aktuelle Thumbnail sofort.')}</p>
            {videos === null ? (
              <div className="flex justify-center py-10"><div className="w-7 h-7 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" /></div>
            ) : videos.length === 0 ? (
              <p className="text-sm text-gray-500 py-6 text-center">{t('crm.thumbs.noVideos', 'Keine Videos gefunden.')}</p>
            ) : (
              <div className="space-y-2">
                {videos.map(v => (
                  <button key={v.video_id} onClick={() => void setOnVideo(v.video_id)} disabled={!!settingVid}
                    className="w-full flex items-center gap-3 rounded-xl border border-gray-200 hover:bg-gray-50 p-2 text-left disabled:opacity-60">
                    {v.thumb && <img src={v.thumb} alt="" className="w-20 h-[45px] object-cover rounded-lg shrink-0" />}
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-gray-800 truncate">{v.title}</span>
                      <span className="block text-[11px] text-gray-400">{v.published_at?.slice(0, 10)}</span>
                    </span>
                    {settingVid === v.video_id && <span className="w-4 h-4 border-2 border-orange-300 border-t-orange-500 rounded-full animate-spin shrink-0" />}
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-end pt-3">
              <button onClick={() => setPickFor(null)} className="px-4 py-2 rounded-xl text-sm border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-[70] bg-gray-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg">{toast}</div>
      )}
    </DashboardLayout>
  )
}
