import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import { CustomSelect } from '../../../components/CustomSelect'

// ── YouTube-Center ──────────────────────────────────────────────────────────
// Videos wie im YouTube Studio vorbereiten: Datei wählen (Upload läuft DIREKT
// Browser → YouTube, kein Größenlimit des Portals), Titel/Beschreibung/Tags,
// Playlist, Thumbnail, Sichtbarkeit. KI-Assistent textet Titel, Beschreibung,
// Tags und einen angepinnten Kommentar aus einem kurzen Briefing.
// Freigabe: Mitarbeiter laden privat hoch und schicken das Video zur Freigabe
// an Sven (Aufgabe + Link). Sven veröffentlicht sofort oder zur geplanten Zeit.
// Edge: yt-center (alle YouTube-Aufrufe), Tabelle yt_videos (RLS Recht youtube).

interface YtRow {
  id: string; video_id: string | null; title: string; description: string; tags: string[]; category_id: string
  language: string; privacy: string; publish_at: string | null; playlist_id: string | null; playlist_title: string | null
  thumbnail_url: string | null; yt_thumbnail: string | null; duration_sec: number | null; notify_subscribers: boolean
  made_for_kids: boolean; status: string; brief: string | null; ai: AiTexts | null; ai_pending: boolean; ai_error: string | null
  upload_size: number | null; upload_name: string | null; published_at: string | null; last_error: string | null; created_at: string
  remote?: Remote | null
}
interface Remote { video_id: string; yt_title: string; yt_privacy: string | null; yt_publish_at: string | null; yt_published_at: string | null; yt_thumbnail: string | null; duration_sec: number | null; views: number; likes: number; comments: number }
interface External extends Remote { description: string; tags: string[]; category_id: string; language: string }
interface AiTexts { titles?: string[]; description?: string; tags?: string[]; hashtags?: string[]; pinned_comment?: string; social_hook?: string }
interface Channel { id: string; title: string; url: string; avatar: string | null; subscribers: number; videos: number; views: number }
interface Playlist { id: string; title: string; count: number }
interface Upload { loaded: number; total: number; speed: number; status: 'laeuft' | 'fertig' | 'fehler'; error?: string; startedAt: number }
interface ThumbItem { id: string | null; platform: string; image_url: string; prompt: string }

const CATEGORIES = [
  { value: '26', label: 'Praktische Tipps & Stil (Howto)' },
  { value: '27', label: 'Bildung' },
  { value: '22', label: 'Menschen & Blogs' },
  { value: '25', label: 'Nachrichten & Politik' },
  { value: '19', label: 'Reisen & Events' },
  { value: '24', label: 'Unterhaltung' },
  { value: '28', label: 'Wissenschaft & Technik' },
]
const CHUNK = 8 * 1024 * 1024   // Vielfaches von 256 KiB (YouTube-Vorgabe)

const fmtBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`
const fmtDur = (s: number | null | undefined) => s == null ? '' : s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const fmtDate = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : ''
const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const tagChars = (tags: string[]) => tags.reduce((n, t) => n + t.length + (t.includes(' ') ? 2 : 0) + 1, 0)

async function call<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T & { ok?: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('yt-center', { body })
  const d = (data ?? {}) as T & { ok?: boolean; error?: string }
  if (error && !d.error) throw new Error(error.message)
  if (d.error) throw new Error(d.error)
  return d
}

// ── Status-Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ row, t }: { row: YtRow; t: (k: string, d: string, o?: Record<string, unknown>) => string }) {
  const map: Record<string, { txt: string; cls: string }> = {
    entwurf: { txt: t('crm.yt.stDraft', '📝 Entwurf'), cls: 'bg-gray-100 text-gray-600' },
    laedt: { txt: t('crm.yt.stUploading', '⬆️ Lädt hoch'), cls: 'bg-blue-50 text-blue-700' },
    hochgeladen: { txt: row.privacy === 'unlisted' ? t('crm.yt.stUnlisted', '🔗 Nicht gelistet') : t('crm.yt.stPrivate', '🔒 Privat'), cls: 'bg-amber-50 text-amber-700' },
    freigabe: { txt: t('crm.yt.stReview', '📨 Wartet auf Freigabe'), cls: 'bg-purple-50 text-purple-700' },
    freigegeben: { txt: t('crm.yt.stScheduled', '🗓 Geplant {{d}}', { d: fmtDate(row.publish_at) }), cls: 'bg-blue-50 text-blue-700' },
    veroeffentlicht: { txt: t('crm.yt.stPublic', '🌍 Öffentlich'), cls: 'bg-green-50 text-green-700' },
    fehler: { txt: t('crm.yt.stError', '❌ Fehler'), cls: 'bg-red-50 text-red-700' },
  }
  const m = map[row.status] ?? map.entwurf
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${m.cls}`}>{m.txt}</span>
}

export default function YouTubeCenter() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const [params, setParams] = useSearchParams()
  const isAdmin = profile?.role === 'admin' || profile?.role === 'verwalter'
  const [channel, setChannel] = useState<Channel | null>(null)
  const [connErr, setConnErr] = useState('')
  const [rows, setRows] = useState<YtRow[]>([])
  const [external, setExternal] = useState<External[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [settings, setSettings] = useState<{ footer: string; default_tags: string }>({ footer: '', default_tags: '' })
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'alle' | 'offen' | 'geplant' | 'live'>('alle')
  const [editId, setEditId] = useState<string | null>(null)
  const [uploads, setUploads] = useState<Record<string, Upload>>({})
  const [toast, setToast] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const [st, vids] = await Promise.all([call<{ channel?: Channel }>({ action: 'status' }).catch(e => ({ ok: false, error: (e as Error).message, channel: undefined })), call<{ items?: YtRow[]; external?: External[]; yt_error?: string | null }>({ action: 'videos' })])
      if (st.ok && st.channel) { setChannel(st.channel); setConnErr('') } else setConnErr(st.error ?? 'YouTube nicht verbunden')
      setRows(vids.items ?? []); setExternal(vids.external ?? [])
    } catch (e) { showToast(`❌ ${(e as Error).message}`) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void call<{ items?: Playlist[] }>({ action: 'playlists' }).then(d => setPlaylists(d.items ?? [])).catch(() => setPlaylists([]))
    void call<{ footer?: string; default_tags?: string }>({ action: 'settings_get' }).then(d => setSettings({ footer: d.footer ?? '', default_tags: d.default_tags ?? '' })).catch(() => undefined)
  }, [])
  // Deep-Link aus der Freigabe-Aufgabe: ?v=<id>
  useEffect(() => {
    const v = params.get('v')
    if (v && !loading && rows.some(r => r.id === v)) { setEditId(v); const n = new URLSearchParams(params); n.delete('v'); setParams(n, { replace: true }) }
  }, [params, rows, loading, setParams])
  // Warnung beim Verlassen, solange ein Upload läuft
  useEffect(() => {
    const running = Object.values(uploads).some(u => u.status === 'laeuft')
    if (!running) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h)
  }, [uploads])

  // ── Upload: Datei → Entwurf → Resumable-Session → Chunks direkt zu YouTube ──
  const uploadFile = async (row: YtRow, file: File) => {
    const setU = (patch: Partial<Upload>) => setUploads(u => ({ ...u, [row.id]: { ...(u[row.id] ?? { loaded: 0, total: file.size, speed: 0, status: 'laeuft', startedAt: Date.now() }), ...patch } }))
    setU({ loaded: 0, total: file.size, status: 'laeuft', startedAt: Date.now(), error: undefined })
    try {
      const init = await call<{ session_uri?: string; cors_ok?: boolean }>({ action: 'upload_init', id: row.id, size: file.size, mime: file.type || 'video/mp4', name: file.name })
      const session = init.session_uri ?? ''
      if (!session) throw new Error('Keine Upload-Session.')
      setRows(rs => rs.map(r => r.id === row.id ? { ...r, status: 'laedt', upload_name: file.name, upload_size: file.size } : r))
      let offset = 0, attempts = 0
      const t0 = Date.now()
      let videoId = ''
      while (offset < file.size) {
        const end = Math.min(offset + CHUNK, file.size)
        const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('PUT', session, true)
          xhr.setRequestHeader('Content-Range', `bytes ${offset}-${end - 1}/${file.size}`)
          xhr.setRequestHeader('Content-Type', file.type || 'video/mp4')
          xhr.upload.onprogress = ev => { const loaded = offset + ev.loaded; setU({ loaded, speed: loaded / Math.max(1, (Date.now() - t0) / 1000) }) }
          xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText })
          xhr.onerror = () => reject(new Error('Netzwerkfehler'))
          xhr.send(file.slice(offset, end))
        }).catch((e: Error) => ({ status: 0, text: e.message }))
        if (res.status === 308) { offset = end; attempts = 0; continue }
        if (res.status === 200 || res.status === 201) {
          videoId = (JSON.parse(res.text || '{}') as { id?: string }).id ?? ''
          offset = file.size; break
        }
        // Abbruch/Netzfehler: Offset vom Server holen und weitermachen (max. 8 Versuche)
        if (++attempts > 8) throw new Error(`Upload abgebrochen (${res.status || 'Netz'}): ${res.text.slice(0, 120)}`)
        await new Promise(r => setTimeout(r, Math.min(20000, 1000 * 2 ** attempts)))
        const st = await call<{ offset?: number; done?: boolean; video_id?: string | null; lost?: boolean }>({ action: 'upload_status', id: row.id }).catch(() => ({ ok: false, lost: true, offset: undefined, done: undefined, video_id: undefined }))
        if (st.lost) throw new Error('Upload-Session verloren - bitte Datei erneut wählen.')
        if (st.done) { videoId = st.video_id ?? ''; offset = file.size; break }
        offset = st.offset ?? offset
      }
      if (!videoId) throw new Error('YouTube hat keine Video-ID geliefert.')
      const done = await call<{ url?: string; notes?: string[] }>({ action: 'upload_done', id: row.id, video_id: videoId })
      setU({ loaded: file.size, status: 'fertig' })
      showToast(`✅ ${t('crm.yt.uploadDone', 'Video ist auf YouTube (privat). Jetzt Texte prüfen und freigeben.')}${done.notes?.length ? ` · ${done.notes.join(' · ')}` : ''}`)
      await load(true)
    } catch (e) {
      const msg = (e as Error).message
      setU({ status: 'fehler', error: msg })
      await supabase.from('yt_videos').update({ status: 'fehler', last_error: msg }).eq('id', row.id)
      setRows(rs => rs.map(r => r.id === row.id ? { ...r, status: 'fehler', last_error: msg } : r))
    }
  }

  // Neues Video: Datei wählen → Entwurf mit Dateinamen als Titel → Editor + Upload
  const startNew = async (file: File | null) => {
    const baseTitle = file ? file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() : ''
    const defTags = settings.default_tags.split(',').map(x => x.trim()).filter(Boolean)
    const { data, error } = await supabase.from('yt_videos').insert({
      title: baseTitle.slice(0, 100), description: settings.footer ? `\n\n${settings.footer}` : '', tags: defTags,
      uploaded_by: profile?.id ?? null, upload_name: file?.name ?? null, upload_size: file?.size ?? null,
    }).select('*').single()
    if (error || !data) { showToast(`❌ ${error?.message ?? 'Fehler'}`); return }
    const row = { ...(data as YtRow), remote: null }
    setRows(rs => [row, ...rs])
    setEditId(row.id)
    if (file) void uploadFile(row, file)
  }
  const adopt = async (v: External) => {
    try {
      const d = await call<{ id?: string }>({ action: 'adopt', video_id: v.video_id })
      await load(true)
      if (d.id) setEditId(d.id)
    } catch (e) { showToast(`❌ ${(e as Error).message}`) }
  }

  const visible = rows.filter(r => filter === 'alle' ? true : filter === 'offen' ? ['entwurf', 'laedt', 'hochgeladen', 'freigabe', 'fehler'].includes(r.status) : filter === 'geplant' ? r.status === 'freigegeben' : r.status === 'veroeffentlicht')
  const reviewCount = rows.filter(r => r.status === 'freigabe').length
  const editRow = rows.find(r => r.id === editId) ?? null
  const chip = (on: boolean) => `px-3 py-1.5 rounded-full text-xs font-medium border ${on ? 'text-white border-transparent' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Kopf: Kanal + Aktionen */}
        <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">▶️ {t('crm.yt.title', 'YouTube-Center')}</h1>
            <p className="text-sm text-gray-500 mt-0.5">{t('crm.yt.subtitle', 'Videos hochladen, Titel/Beschreibung/Tags vorbereiten, Thumbnail setzen und zur Freigabe schicken - wie im YouTube Studio, nur direkt im Portal.')}</p>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && <button onClick={() => setShowSettings(true)} className="px-3 py-2 rounded-xl text-sm border border-gray-200 text-gray-700 hover:bg-gray-50">⚙️ {t('crm.yt.settings', 'Vorlagen')}</button>}
            <input ref={fileInput} type="file" accept="video/*,.mp4,.mov,.m4v,.webm" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void startNew(f) }} />
            <button onClick={() => fileInput.current?.click()} disabled={!channel} className="px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
              ⬆️ {t('crm.yt.newVideo', 'Video hochladen')}
            </button>
          </div>
        </div>

        {channel ? (
          <div className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-white p-3 mb-5">
            {channel.avatar && <img src={channel.avatar} alt="" className="w-11 h-11 rounded-full" />}
            <div className="flex-1 min-w-0">
              <a href={channel.url} target="_blank" rel="noreferrer" className="font-semibold text-gray-900 hover:underline">{channel.title}</a>
              <p className="text-xs text-gray-500">{channel.subscribers.toLocaleString('de-DE')} {t('crm.yt.subs', 'Abonnenten')} · {channel.videos} {t('crm.yt.videos', 'Videos')} · {channel.views.toLocaleString('de-DE')} {t('crm.yt.views', 'Aufrufe')}</p>
            </div>
            {reviewCount > 0 && isAdmin && <span className="text-xs font-semibold bg-purple-50 text-purple-700 px-3 py-1.5 rounded-full">📨 {t('crm.yt.reviewCount', '{{n}} zur Freigabe', { n: reviewCount })}</span>}
          </div>
        ) : !loading && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 mb-5 text-sm text-amber-800">
            ⚠️ {connErr || t('crm.yt.notConnected', 'YouTube ist nicht verbunden.')} {isAdmin && <a href="/admin/crm/settings/connectors" className="underline font-medium">{t('crm.yt.connect', 'Zu den Connectoren')}</a>}
          </div>
        )}

        {/* Drop-Zone */}
        <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && f.type.startsWith('video/')) void startNew(f) }}
          onClick={() => fileInput.current?.click()}
          className="rounded-2xl border-2 border-dashed border-gray-200 hover:border-orange-300 bg-white/60 p-5 text-center cursor-pointer mb-6">
          <p className="text-sm text-gray-600 font-medium">🎬 {t('crm.yt.drop', 'Video hier ablegen oder klicken')}</p>
          <p className="text-xs text-gray-400 mt-1">{t('crm.yt.dropHint', 'MP4/MOV, beliebige Größe. Der Upload geht direkt zu YouTube (privat) - währenddessen kannst du schon Titel, Beschreibung und Tags ausfüllen.')}</p>
        </div>

        {/* Filter */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {([['alle', t('crm.yt.fAll', 'Alle')], ['offen', t('crm.yt.fOpen', 'In Arbeit')], ['geplant', t('crm.yt.fScheduled', 'Geplant')], ['live', t('crm.yt.fLive', 'Veröffentlicht')]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={chip(filter === k)} style={filter === k ? { backgroundColor: '#1a2332' } : undefined}>{l}</button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-10">{t('crm.yt.empty', 'Noch keine Videos im Center. Lade oben dein erstes hoch.')}</p>
        ) : (
          <div className="space-y-2">
            {visible.map(r => {
              const up = uploads[r.id]
              const thumb = r.thumbnail_url ?? r.remote?.yt_thumbnail ?? r.yt_thumbnail
              return (
                <button key={r.id} onClick={() => setEditId(r.id)} className="w-full text-left rounded-2xl border border-gray-100 bg-white hover:border-orange-200 p-3 flex gap-3 items-start">
                  <div className="w-32 h-[72px] rounded-xl bg-gray-100 overflow-hidden shrink-0 flex items-center justify-center text-2xl">
                    {thumb ? <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" /> : '🎬'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge row={r} t={t} />
                      {r.duration_sec != null && <span className="text-[11px] text-gray-400">{fmtDur(r.duration_sec)}</span>}
                      {r.playlist_title && <span className="text-[11px] text-gray-400">📂 {r.playlist_title}</span>}
                    </div>
                    <p className="font-medium text-gray-900 truncate mt-1">{r.title || r.upload_name || t('crm.yt.untitled', 'Ohne Titel')}</p>
                    {up && up.status === 'laeuft' && (
                      <div className="mt-1.5">
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.round(up.loaded / up.total * 100)}%` }} /></div>
                        <p className="text-[11px] text-gray-500 mt-0.5">{Math.round(up.loaded / up.total * 100)} % · {fmtBytes(up.loaded)} / {fmtBytes(up.total)} · {fmtBytes(up.speed)}/s · {t('crm.yt.eta', 'noch ~{{m}} Min', { m: Math.max(1, Math.round((up.total - up.loaded) / Math.max(1, up.speed) / 60)) })}</p>
                      </div>
                    )}
                    {r.remote && r.status === 'veroeffentlicht' && <p className="text-[11px] text-gray-400 mt-0.5">👁 {r.remote.views.toLocaleString('de-DE')} · 👍 {r.remote.likes} · 💬 {r.remote.comments} · {fmtDate(r.remote.yt_published_at)}</p>}
                    {(r.last_error || up?.error) && <p className="text-[11px] text-red-600 mt-0.5 truncate">⚠️ {up?.error ?? r.last_error}</p>}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {/* Weitere Kanal-Videos (noch nicht im Center) */}
        {external.length > 0 && filter === 'alle' && (
          <details className="mt-8">
            <summary className="cursor-pointer text-sm font-semibold text-gray-700">📺 {t('crm.yt.external', 'Weitere Videos auf dem Kanal')} ({external.length})</summary>
            <p className="text-xs text-gray-400 mt-1 mb-2">{t('crm.yt.externalHint', 'Zum Bearbeiten von Titel, Beschreibung, Tags oder Thumbnail anklicken - das Video wird ins Center geholt.')}</p>
            <div className="grid sm:grid-cols-2 gap-2">
              {external.map(v => (
                <button key={v.video_id} onClick={() => void adopt(v)} className="text-left rounded-xl border border-gray-100 bg-white hover:border-orange-200 p-2 flex gap-2 items-center">
                  {v.yt_thumbnail && <img src={v.yt_thumbnail} alt="" className="w-20 h-[45px] object-cover rounded-lg shrink-0" loading="lazy" />}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-gray-800 truncate">{v.yt_title}</span>
                    <span className="block text-[11px] text-gray-400">{v.yt_privacy === 'public' ? '🌍' : v.yt_privacy === 'unlisted' ? '🔗' : '🔒'} {fmtDate(v.yt_published_at)} · 👁 {v.views.toLocaleString('de-DE')}</span>
                  </span>
                </button>
              ))}
            </div>
          </details>
        )}
      </div>

      {editRow && (
        <VideoEditor row={editRow} upload={uploads[editRow.id]} playlists={playlists} settings={settings} isAdmin={isAdmin}
          onClose={() => setEditId(null)}
          onChanged={(patch) => setRows(rs => rs.map(r => r.id === editRow.id ? { ...r, ...patch } : r))}
          onReload={() => load(true)}
          onPickFile={(f) => void uploadFile(editRow, f)}
          onDeleted={() => { setRows(rs => rs.filter(r => r.id !== editRow.id)); setEditId(null) }}
          toast={showToast} />
      )}
      {showSettings && <SettingsModal settings={settings} onClose={() => setShowSettings(false)} onSaved={s => { setSettings(s); setShowSettings(false) }} />}
      {toast && <div className="fixed bottom-6 right-6 z-[80] bg-gray-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg max-w-md">{toast}</div>}
    </DashboardLayout>
  )
}

// ── Editor ───────────────────────────────────────────────────────────────────
function VideoEditor({ row, upload, playlists, settings, isAdmin, onClose, onChanged, onReload, onPickFile, onDeleted, toast }: {
  row: YtRow; upload?: Upload; playlists: Playlist[]; settings: { footer: string; default_tags: string }; isAdmin: boolean
  onClose: () => void; onChanged: (p: Partial<YtRow>) => void; onReload: () => Promise<void>; onPickFile: (f: File) => void; onDeleted: () => void; toast: (m: string) => void
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(row.title)
  const [desc, setDesc] = useState(row.description)
  const [tags, setTags] = useState<string[]>(row.tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const [category, setCategory] = useState(row.category_id || '26')
  const [language, setLanguage] = useState(row.language || 'de')
  const [privacy, setPrivacy] = useState(row.privacy || 'private')
  const [publishAt, setPublishAt] = useState(toLocalInput(row.publish_at))
  const [playlist, setPlaylist] = useState(row.playlist_id ?? '')
  const [notify, setNotify] = useState(row.notify_subscribers)
  const [kids, setKids] = useState(row.made_for_kids)
  const [brief, setBrief] = useState(row.brief ?? '')
  const [ai, setAi] = useState<AiTexts | null>(row.ai)
  const [aiBusy, setAiBusy] = useState(row.ai_pending)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [thumbs, setThumbs] = useState<ThumbItem[] | null>(null)
  const [showThumbs, setShowThumbs] = useState(false)
  const thumbInput = useRef<HTMLInputElement>(null)
  const videoInput = useRef<HTMLInputElement>(null)
  const inp = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400'
  const uploaded = !!row.video_id
  const thumb = row.thumbnail_url ?? row.remote?.yt_thumbnail ?? row.yt_thumbnail

  const addTag = (raw: string) => {
    const parts = raw.split(/[,\n]/).map(x => x.trim()).filter(Boolean)
    if (!parts.length) return
    setTags(ts => { const out = [...ts]; for (const p of parts) if (!out.some(x => x.toLowerCase() === p.toLowerCase())) out.push(p.slice(0, 100)); return out })
    setTagInput('')
  }
  const appendFooter = () => { if (settings.footer && !desc.includes(settings.footer.slice(0, 40))) setDesc(d => `${d.trimEnd()}\n\n${settings.footer}`) }

  // Lokal speichern (RLS) + bei hochgeladenem Video auf YouTube schreiben
  const persist = async (): Promise<boolean> => {
    const patch = {
      title: title.slice(0, 100), description: desc.slice(0, 5000), tags, category_id: category, language,
      privacy: !isAdmin && privacy === 'public' ? 'private' : privacy,
      publish_at: publishAt ? new Date(publishAt).toISOString() : null,
      playlist_id: playlist || null, playlist_title: playlists.find(p => p.id === playlist)?.title ?? null,
      notify_subscribers: notify, made_for_kids: kids, brief: brief || null, updated_at: new Date().toISOString(),
    }
    const { error } = await supabase.from('yt_videos').update(patch).eq('id', row.id)
    if (error) { setNote(`❌ ${error.message}`); return false }
    onChanged(patch)
    return true
  }
  const save = async () => {
    if (busy) return
    setBusy('save'); setNote('')
    try {
      if (!(await persist())) return
      if (uploaded) {
        const d = await call<{ notes?: string[]; privacy?: string }>({ action: 'update_video', id: row.id })
        toast(`✅ ${t('crm.yt.savedYt', 'Auf YouTube gespeichert.')}${d.notes?.length ? ` · ${d.notes.join(' · ')}` : ''}`)
        await onReload()
      } else toast(`💾 ${t('crm.yt.savedLocal', 'Gespeichert - wird beim Upload übernommen.')}`)
      onClose()
    } catch (e) { setNote(`❌ ${(e as Error).message}`) } finally { setBusy('') }
  }
  const requestApproval = async () => {
    if (busy || !uploaded) return
    if (!window.confirm(t('crm.yt.reviewConfirm', 'Video jetzt zur Freigabe an Sven schicken? Er bekommt eine Aufgabe mit Vorschau-Link.') as string)) return
    setBusy('review'); setNote('')
    try {
      if (!(await persist())) return
      await call({ action: 'update_video', id: row.id })
      await call({ action: 'request_approval', id: row.id })
      toast(`📨 ${t('crm.yt.reviewSent', 'Zur Freigabe geschickt - Sven wurde benachrichtigt.')}`)
      await onReload(); onClose()
    } catch (e) { setNote(`❌ ${(e as Error).message}`) } finally { setBusy('') }
  }
  const approve = async (mode: 'now' | 'at') => {
    if (busy || !uploaded) return
    const when = mode === 'at' ? new Date(publishAt) : null
    if (mode === 'at' && (!publishAt || isNaN(when!.getTime()) || when!.getTime() < Date.now())) { setNote(`❌ ${t('crm.yt.needFuture', 'Bitte einen Zeitpunkt in der Zukunft setzen.')}`); return }
    const msg = mode === 'now' ? t('crm.yt.publishNowConfirm', 'Video JETZT öffentlich schalten? Das ist für alle sichtbar.') : t('crm.yt.publishAtConfirm', 'Video am {{d}} automatisch veröffentlichen?', { d: when!.toLocaleString('de-DE') })
    if (!window.confirm(msg as string)) return
    setBusy(mode); setNote('')
    try {
      if (!(await persist())) return
      await call({ action: 'approve', id: row.id, mode, publish_at: when?.toISOString() })
      toast(mode === 'now' ? `🌍 ${t('crm.yt.published', 'Veröffentlicht!')}` : `🗓 ${t('crm.yt.scheduled', 'Eingeplant - YouTube veröffentlicht automatisch.')}`)
      await onReload(); onClose()
    } catch (e) { setNote(`❌ ${(e as Error).message}`) } finally { setBusy('') }
  }
  const socialPosts = async () => {
    if (busy || !uploaded) return
    if (!window.confirm(t('crm.yt.socialConfirm', 'Social-Post-Entwürfe (Facebook/Instagram + LinkedIn) zu diesem Video anlegen? Freigabe danach im Social Studio.') as string)) return
    setBusy('social'); setNote('')
    try {
      await persist()
      const d = await call<{ skipped?: string }>({ action: 'social_posts', id: row.id })
      toast(d.skipped ? `ℹ️ ${d.skipped}` : `📣 ${t('crm.yt.socialDone', 'Entwürfe liegen im Social Studio (Posts-Reiter).')}`)
    } catch (e) { setNote(`❌ ${(e as Error).message}`) } finally { setBusy('') }
  }
  const runAi = async () => {
    if (aiBusy) return
    if (!brief.trim() && !title.trim()) { setNote(`❌ ${t('crm.yt.aiNeedBrief', 'Bitte kurz beschreiben, worum es im Video geht.')}`); return }
    setAiBusy(true); setNote('')
    try {
      await supabase.from('yt_videos').update({ title, description: desc, brief }).eq('id', row.id)
      await call({ action: 'ai_texts', id: row.id, brief })
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000))
        const { data } = await supabase.from('yt_videos').select('ai, ai_pending, ai_error').eq('id', row.id).maybeSingle()
        const d = data as { ai: AiTexts | null; ai_pending: boolean; ai_error: string | null } | null
        if (d && !d.ai_pending) {
          if (d.ai_error) throw new Error(d.ai_error)
          setAi(d.ai); onChanged({ ai: d.ai, ai_pending: false, brief })
          break
        }
      }
    } catch (e) { setNote(`❌ ${(e as Error).message}`) } finally { setAiBusy(false) }
  }
  const setThumb = async (url: string) => {
    setBusy('thumb'); setNote('')
    try {
      const d = await call<{ pushed?: boolean }>({ action: 'set_thumbnail', id: row.id, url })
      onChanged({ thumbnail_url: url })
      toast(d.pushed ? `✅ ${t('crm.yt.thumbSet', 'Thumbnail ist auf dem Video.')}` : `🖼 ${t('crm.yt.thumbSaved', 'Thumbnail gemerkt - wird nach dem Upload gesetzt.')}`)
      setShowThumbs(false)
    } catch (e) { setNote(`❌ ${(e as Error).message}`) } finally { setBusy('') }
  }
  const uploadThumb = async (f: File) => {
    if (f.size > 8 * 1024 * 1024) { setNote(`❌ ${t('crm.yt.thumbTooBig', 'Bild größer als 8 MB.')}`); return }
    setBusy('thumb')
    const ext = (f.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `youtube-thumbs/${row.id}-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('ad-creatives').upload(path, f, { contentType: f.type || 'image/jpeg' })
    if (error) { setNote(`❌ ${error.message}`); setBusy(''); return }
    await setThumb(supabase.storage.from('ad-creatives').getPublicUrl(path).data.publicUrl)
  }
  const openThumbs = async () => {
    setShowThumbs(s => !s)
    if (thumbs === null) {
      const { data } = await supabase.functions.invoke('social-agent', { body: { action: 'thumbnail_list' } })
      setThumbs((((data as { items?: ThumbItem[] } | null)?.items) ?? []).filter(x => x.platform === 'youtube' || x.platform === 'linkedin'))
    }
  }
  const deleteDraft = async () => {
    if (uploaded || !window.confirm(t('crm.yt.deleteConfirm', 'Diesen Entwurf löschen?') as string)) return
    await supabase.from('yt_videos').delete().eq('id', row.id)
    onDeleted()
  }
  // Admin: nicht-öffentliches Video samt YouTube-Eintrag löschen (Upload-Leichen)
  const deleteVideo = async () => {
    if (!isAdmin || busy) return
    if (!window.confirm(t('crm.yt.deleteVideoConfirm', 'Dieses Video endgültig von YouTube löschen? Das lässt sich nicht rückgängig machen.') as string)) return
    setBusy('delete'); setNote('')
    try { await call({ action: 'delete_video', id: row.id }); toast(`🗑 ${t('crm.yt.deleted', 'Video gelöscht.')}`); onDeleted() }
    catch (e) { setNote(`❌ ${(e as Error).message}`) } finally { setBusy('') }
  }
  const copy = (s: string) => { void navigator.clipboard?.writeText(s); toast(`📋 ${t('crm.yt.copied', 'Kopiert.')}`) }

  const tagLen = tagChars(tags)
  const privacyOpts = [
    { value: 'private', label: `🔒 ${t('crm.yt.pvPrivate', 'Privat')}`, hint: t('crm.yt.pvPrivateHint', 'nur der Kanal sieht es') },
    { value: 'unlisted', label: `🔗 ${t('crm.yt.pvUnlisted', 'Nicht gelistet')}`, hint: t('crm.yt.pvUnlistedHint', 'nur mit Link erreichbar') },
    { value: 'public', label: `🌍 ${t('crm.yt.pvPublic', 'Öffentlich')}`, hint: isAdmin ? t('crm.yt.pvPublicHint', 'für alle sichtbar') : t('crm.yt.pvPublicStaff', 'nur über Svens Freigabe'), disabled: !isAdmin },
  ]

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-3" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-6xl flex flex-col overflow-hidden" style={{ height: 'min(92vh, 860px)' }} onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0 flex items-center gap-2">
            <StatusBadge row={row} t={t} />
            <p className="font-semibold text-gray-900 text-sm truncate">{title || row.upload_name || t('crm.yt.newVideoTitle', 'Neues Video')}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {uploaded && <a href={`https://youtu.be/${row.video_id}`} target="_blank" rel="noreferrer" className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">▶ {t('crm.yt.openYt', 'Auf YouTube ansehen')}</a>}
            <button onClick={onClose} className="w-8 h-8 rounded-lg text-gray-400 hover:bg-gray-100">✕</button>
          </div>
        </div>

        <div className="flex-1 min-h-0 grid md:grid-cols-5 overflow-y-auto md:overflow-hidden">
          {/* Links: Metadaten */}
          <div className="md:col-span-3 md:overflow-y-auto p-5 space-y-4 md:border-r border-gray-100">
            {/* Video / Upload */}
            <div className="rounded-xl bg-gray-50 p-3">
              {upload && upload.status === 'laeuft' ? (
                <div>
                  <div className="flex justify-between text-xs text-gray-600 mb-1"><span>⬆️ {t('crm.yt.uploading', 'Lädt zu YouTube hoch …')} {row.upload_name}</span><span>{Math.round(upload.loaded / upload.total * 100)} %</span></div>
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden"><div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.round(upload.loaded / upload.total * 100)}%` }} /></div>
                  <p className="text-[11px] text-gray-500 mt-1">{fmtBytes(upload.loaded)} / {fmtBytes(upload.total)} · {fmtBytes(upload.speed)}/s · {t('crm.yt.keepOpen', 'Fenster/Tab offen lassen. Du kannst währenddessen alles ausfüllen und speichern.')}</p>
                </div>
              ) : uploaded ? (
                <div className="flex items-center gap-3">
                  <div className="w-28 h-16 rounded-lg bg-black overflow-hidden shrink-0">{thumb && <img src={thumb} alt="" className="w-full h-full object-cover" />}</div>
                  <div className="text-xs text-gray-600">
                    <p className="font-medium text-gray-800">✅ {t('crm.yt.onYt', 'Video liegt auf YouTube')} {row.duration_sec != null && `· ${fmtDur(row.duration_sec)}`}</p>
                    <p className="text-gray-400 mt-0.5">{row.upload_name ?? row.video_id}{row.upload_size ? ` · ${fmtBytes(row.upload_size)}` : ''}</p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 flex-wrap">
                  <input ref={videoInput} type="file" accept="video/*,.mp4,.mov,.m4v,.webm" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPickFile(f) }} />
                  <button onClick={() => videoInput.current?.click()} className="px-3 py-2 rounded-xl text-sm font-medium border border-dashed border-gray-300 text-gray-600 hover:border-orange-300 hover:text-orange-600">
                    ⬆️ {upload?.status === 'fehler' ? t('crm.yt.retryUpload', 'Upload erneut starten') : t('crm.yt.pickVideo', 'Videodatei wählen')}
                  </button>
                  <span className="text-[11px] text-gray-400">{t('crm.yt.pickHint', 'Geht direkt zu YouTube (privat). Beliebige Größe.')}</span>
                  {upload?.error && <span className="text-[11px] text-red-600">⚠️ {upload.error}</span>}
                </div>
              )}
            </div>

            <div>
              <div className="flex justify-between"><label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.yt.fTitle', 'Titel')}</label><span className={`text-[11px] ${title.length > 100 ? 'text-red-600' : 'text-gray-400'}`}>{title.length}/100</span></div>
              <input value={title} onChange={e => setTitle(e.target.value.slice(0, 100))} className={inp} placeholder={t('crm.yt.fTitlePh', 'Keyword vorne, max. 60-70 Zeichen sichtbar')} />
            </div>
            <div>
              <div className="flex justify-between items-end mb-1">
                <label className="block text-xs font-medium text-gray-500">{t('crm.yt.fDesc', 'Beschreibung')}</label>
                <div className="flex items-center gap-2">
                  {settings.footer && <button onClick={appendFooter} className="text-[11px] px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">📎 {t('crm.yt.addFooter', 'Standard-Footer anhängen')}</button>}
                  <span className={`text-[11px] ${desc.length > 5000 ? 'text-red-600' : 'text-gray-400'}`}>{desc.length}/5000</span>
                </div>
              </div>
              <textarea value={desc} onChange={e => setDesc(e.target.value.slice(0, 5000))} rows={12} className={`${inp} leading-relaxed font-mono text-[13px]`} placeholder={t('crm.yt.fDescPh', 'Zeile 1-2 erscheinen in der Suche. Dann: Was lernt der Zuschauer? Kapitel mit Zeitstempeln (00:00 Intro …). Links.')} />
            </div>
            <div>
              <div className="flex justify-between"><label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.yt.fTags', 'Tags')} ({tags.length})</label><span className={`text-[11px] ${tagLen > 500 ? 'text-red-600' : 'text-gray-400'}`}>{tagLen}/500</span></div>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {tags.map((tg, i) => (
                  <span key={tg + i} className="inline-flex items-center gap-1 text-xs bg-gray-100 rounded-full pl-2.5 pr-1.5 py-1">{tg}<button onClick={() => setTags(ts => ts.filter((_, x) => x !== i))} className="text-gray-400 hover:text-red-500">×</button></span>
                ))}
              </div>
              <input value={tagInput} onChange={e => setTagInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput) } }} onBlur={() => addTag(tagInput)} className={inp} placeholder={t('crm.yt.fTagsPh', 'Tag eingeben, Enter oder Komma')} />
              {settings.default_tags && <button onClick={() => addTag(settings.default_tags)} className="text-[11px] text-gray-500 hover:text-gray-800 mt-1">+ {t('crm.yt.addDefaultTags', 'Standard-Tags ergänzen')}</button>}
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">📂 {t('crm.yt.fPlaylist', 'Playlist')}</label>
                <CustomSelect value={playlist} onChange={setPlaylist} options={[{ value: '', label: `— ${t('crm.yt.noPlaylist', 'keine')} —` }, ...playlists.map(p => ({ value: p.id, label: p.title, hint: `${p.count} Videos` }))]} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.yt.fCategory', 'Kategorie')}</label>
                <CustomSelect value={category} onChange={setCategory} options={CATEGORIES} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.yt.fLang', 'Sprache')}</label>
                <CustomSelect value={language} onChange={setLanguage} options={[{ value: 'de', label: 'Deutsch' }, { value: 'en', label: 'English' }]} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.yt.fPrivacy', 'Sichtbarkeit')}</label>
                <CustomSelect value={privacy} onChange={setPrivacy} options={privacyOpts} />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">🗓 {isAdmin ? t('crm.yt.fPublishAt', 'Veröffentlichung planen (optional)') : t('crm.yt.fPublishWish', 'Wunschtermin für die Veröffentlichung (optional)')}</label>
                <input type="datetime-local" value={publishAt} onChange={e => setPublishAt(e.target.value)} className={inp} />
                <p className="text-[11px] text-gray-400 mt-1">{isAdmin ? t('crm.yt.publishAtHint', 'Video bleibt bis dahin privat, YouTube schaltet es automatisch öffentlich.') : t('crm.yt.publishWishHint', 'Sven sieht den Wunschtermin in der Freigabe-Aufgabe und plant das Video entsprechend ein.')}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-sm text-gray-700">
              <label className="inline-flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} className="accent-orange-500" /> 🔔 {t('crm.yt.fNotify', 'Abonnenten benachrichtigen')}</label>
              <label className="inline-flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={kids} onChange={e => setKids(e.target.checked)} className="accent-orange-500" /> 🧒 {t('crm.yt.fKids', 'Für Kinder gemacht')}</label>
            </div>
            {!uploaded && <p className="text-[11px] text-gray-400">{t('crm.yt.notifyHint', 'Benachrichtigung und Sichtbarkeit gelten beim Upload-Start - danach änderbar über Speichern.')}</p>}
          </div>

          {/* Rechts: Thumbnail + KI-Assistent */}
          <div className="md:col-span-2 md:overflow-y-auto p-5 space-y-5 bg-gray-50/60">
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1.5">🖼 {t('crm.yt.thumb', 'Thumbnail')}</p>
              <div className="aspect-video rounded-xl bg-gray-200 overflow-hidden mb-2 flex items-center justify-center text-gray-400 text-xs">
                {thumb ? <img src={thumb} alt="" className="w-full h-full object-cover" /> : t('crm.yt.noThumb', 'Noch kein Thumbnail')}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <input ref={thumbInput} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadThumb(f) }} />
                <button onClick={() => thumbInput.current?.click()} disabled={busy === 'thumb'} className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50">⬆️ {t('crm.yt.thumbUpload', 'Eigenes Bild')}</button>
                <button onClick={() => void openThumbs()} className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50">🎨 {t('crm.yt.thumbStudio', 'Aus Thumbnail-Studio')} {showThumbs ? '▴' : '▾'}</button>
                <a href="/admin/crm/thumbnails" target="_blank" rel="noreferrer" className="text-xs px-2.5 py-1.5 rounded-lg text-gray-500 hover:text-gray-800">✨ {t('crm.yt.thumbNew', 'Neues erstellen')} ↗</a>
              </div>
              {showThumbs && (
                <div className="grid grid-cols-3 gap-1.5 mt-2 max-h-48 overflow-y-auto p-1.5 bg-white rounded-xl border border-gray-100">
                  {thumbs === null ? <p className="col-span-3 text-xs text-gray-400 p-2">…</p> : thumbs.length === 0 ? <p className="col-span-3 text-xs text-gray-400 p-2">{t('crm.yt.noStudioThumbs', 'Noch keine YouTube-Thumbnails im Studio.')}</p> : thumbs.map((x, i) => (
                    <button key={x.id ?? i} onClick={() => void setThumb(x.image_url)} disabled={busy === 'thumb'} className={`rounded-lg overflow-hidden border-2 ${row.thumbnail_url === x.image_url ? 'border-orange-500' : 'border-transparent hover:border-gray-300'}`} title={x.prompt}>
                      <img src={x.image_url} alt="" className="w-full aspect-video object-cover" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-gray-400 mt-1">{t('crm.yt.thumbHint', 'Wird auf 1280×720 zugeschnitten und direkt aufs Video gesetzt.')}</p>
            </div>

            <div className="rounded-xl border border-orange-100 bg-white p-3">
              <p className="text-xs font-semibold text-gray-800 mb-1">✨ {t('crm.yt.ai', 'KI-Assistent')}</p>
              <p className="text-[11px] text-gray-400 mb-2">{t('crm.yt.aiHint', 'Worum geht es im Video? 2-5 Sätze reichen: Thema, Kernaussagen, Zielgruppe, Zahlen. Daraus entstehen Titelvarianten, Beschreibung mit Kapitel-Vorlage, Tags und ein angepinnter Kommentar.')}</p>
              <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={4} className={`${inp} text-[13px]`} placeholder={t('crm.yt.aiPh', 'z.B. Sven erklärt, warum die Mietrendite in Paphos 2026 bei 5-6 % liegt, vergleicht mit Berlin, zeigt Projekt Emerald und rechnet ein Beispiel mit 250.000 € durch.')} />
              <button onClick={() => void runAi()} disabled={aiBusy} className="mt-2 w-full px-3 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: '#1a2332' }}>
                {aiBusy ? t('crm.yt.aiWorking', 'Texte entstehen … (~30 s)') : `✨ ${t('crm.yt.aiGo', 'Titel, Beschreibung & Tags vorschlagen')}`}
              </button>
              {ai && (
                <div className="mt-3 space-y-3 text-sm">
                  {!!ai.titles?.length && (
                    <div>
                      <p className="text-[11px] font-medium text-gray-500 mb-1">{t('crm.yt.aiTitles', 'Titelvarianten - anklicken zum Übernehmen')}</p>
                      <div className="space-y-1">{ai.titles.map((x, i) => <button key={i} onClick={() => setTitle(x.slice(0, 100))} className={`block w-full text-left text-[13px] px-2.5 py-1.5 rounded-lg border ${title === x ? 'border-orange-400 bg-orange-50' : 'border-gray-100 hover:bg-gray-50'}`}>{x}</button>)}</div>
                    </div>
                  )}
                  {ai.description && (
                    <div>
                      <div className="flex justify-between items-center mb-1"><p className="text-[11px] font-medium text-gray-500">{t('crm.yt.aiDesc', 'Beschreibung')}</p><button onClick={() => { setDesc(`${ai.description}${ai.hashtags?.length ? `\n\n${ai.hashtags.join(' ')}` : ''}${settings.footer ? `\n\n${settings.footer}` : ''}`) }} className="text-[11px] px-2 py-1 rounded-lg bg-gray-900 text-white">{t('crm.yt.take', 'Übernehmen')}</button></div>
                      <p className="text-[12px] text-gray-600 whitespace-pre-wrap max-h-40 overflow-y-auto bg-gray-50 rounded-lg p-2">{ai.description}</p>
                    </div>
                  )}
                  {!!ai.tags?.length && (
                    <div>
                      <div className="flex justify-between items-center mb-1"><p className="text-[11px] font-medium text-gray-500">{t('crm.yt.aiTags', 'Tags')} ({ai.tags.length})</p><button onClick={() => addTag(ai.tags!.join(','))} className="text-[11px] px-2 py-1 rounded-lg bg-gray-900 text-white">{t('crm.yt.take', 'Übernehmen')}</button></div>
                      <p className="text-[12px] text-gray-600">{ai.tags.join(' · ')}</p>
                    </div>
                  )}
                  {ai.pinned_comment && (
                    <div>
                      <div className="flex justify-between items-center mb-1"><p className="text-[11px] font-medium text-gray-500">📌 {t('crm.yt.aiPinned', 'Angepinnter Kommentar (nach Veröffentlichung auf YouTube einfügen)')}</p><button onClick={() => copy(ai.pinned_comment!)} className="text-[11px] px-2 py-1 rounded-lg border border-gray-200">📋</button></div>
                      <p className="text-[12px] text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-2">{ai.pinned_comment}</p>
                    </div>
                  )}
                  {ai.social_hook && <p className="text-[12px] text-gray-500">💬 {t('crm.yt.aiHook', 'Social-Hook')}: {ai.social_hook}</p>}
                </div>
              )}
            </div>

            {uploaded && (
              <div className="rounded-xl border border-gray-100 bg-white p-3">
                <p className="text-xs font-semibold text-gray-800 mb-1">📣 {t('crm.yt.social', 'Social Media')}</p>
                <p className="text-[11px] text-gray-400 mb-2">{t('crm.yt.socialHint', 'Legt Post-Entwürfe für Facebook/Instagram und LinkedIn mit Thumbnail und Video-Link an - zur Freigabe im Social Studio.')}</p>
                <button onClick={() => void socialPosts()} disabled={!!busy} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50">{busy === 'social' ? '…' : t('crm.yt.socialGo', 'Social-Post-Entwürfe anlegen')}</button>
              </div>
            )}
            {row.remote && row.status === 'veroeffentlicht' && (
              <div className="rounded-xl border border-gray-100 bg-white p-3 text-xs text-gray-600">
                <p className="font-semibold text-gray-800 mb-1">📊 {t('crm.yt.stats', 'Statistik')}</p>
                <p>👁 {row.remote.views.toLocaleString('de-DE')} {t('crm.yt.views', 'Aufrufe')} · 👍 {row.remote.likes} · 💬 {row.remote.comments}</p>
                <p className="text-gray-400 mt-0.5">{t('crm.yt.publishedOn', 'Veröffentlicht')} {fmtDate(row.remote.yt_published_at)}</p>
              </div>
            )}
          </div>
        </div>

        {note && <p className="mx-5 mb-2 text-sm rounded-lg px-3 py-2 bg-gray-50 text-gray-700 whitespace-pre-wrap">{note}</p>}
        <div className="p-4 border-t border-gray-100 shrink-0 flex items-center gap-2 flex-wrap">
          {!uploaded && <button onClick={() => void deleteDraft()} className="px-3 py-2 rounded-xl text-sm text-gray-400 hover:text-red-600">🗑 {t('crm.yt.deleteDraft', 'Entwurf löschen')}</button>}
          {uploaded && isAdmin && row.status !== 'veroeffentlicht' && <button onClick={() => void deleteVideo()} disabled={!!busy} className="px-3 py-2 rounded-xl text-sm text-gray-400 hover:text-red-600 disabled:opacity-50">🗑 {t('crm.yt.deleteVideo', 'Video löschen')}</button>}
          <div className="flex-1" />
          <button onClick={() => void save()} disabled={!!busy} className="px-4 py-2 rounded-xl text-sm border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50">{busy === 'save' ? t('common.saving', 'Speichert…') : `💾 ${t('common.save', 'Speichern')}`}</button>
          {!isAdmin && uploaded && row.status !== 'veroeffentlicht' && row.status !== 'freigegeben' && (
            <button onClick={() => void requestApproval()} disabled={!!busy || !title.trim()} className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
              {busy === 'review' ? '…' : `📨 ${row.status === 'freigabe' ? t('crm.yt.reviewAgain', 'Erneut zur Freigabe') : t('crm.yt.review', 'Zur Freigabe an Sven')}`}
            </button>
          )}
          {isAdmin && uploaded && row.status !== 'veroeffentlicht' && (
            <>
              <button onClick={() => void approve('at')} disabled={!!busy || !publishAt || !title.trim()} className="px-4 py-2 rounded-xl text-sm font-semibold border border-gray-900 text-gray-900 hover:bg-gray-50 disabled:opacity-40">{busy === 'at' ? '…' : `🗓 ${t('crm.yt.approveAt', 'Zur geplanten Zeit veröffentlichen')}`}</button>
              <button onClick={() => void approve('now')} disabled={!!busy || !title.trim()} className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>{busy === 'now' ? '…' : `🌍 ${t('crm.yt.approveNow', 'Jetzt veröffentlichen')}`}</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Vorlagen (Admin): Beschreibungs-Footer + Standard-Tags ───────────────────
function SettingsModal({ settings, onClose, onSaved }: { settings: { footer: string; default_tags: string }; onClose: () => void; onSaved: (s: { footer: string; default_tags: string }) => void }) {
  const { t } = useTranslation()
  const [footer, setFooter] = useState(settings.footer)
  const [tags, setTags] = useState(settings.default_tags)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const save = async () => {
    setBusy(true); setErr('')
    try { await call({ action: 'settings_set', footer, default_tags: tags }); onSaved({ footer, default_tags: tags }) }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const inp = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400'
  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <h2 className="font-bold text-gray-900">⚙️ {t('crm.yt.settingsTitle', 'Vorlagen für alle Videos')}</h2>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.yt.footerLabel', 'Standard-Footer der Beschreibung (Links, Hinweise)')}</label>
          <textarea value={footer} onChange={e => setFooter(e.target.value)} rows={9} className={`${inp} font-mono text-[12px]`} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.yt.defTagsLabel', 'Standard-Tags (kommagetrennt)')}</label>
          <textarea value={tags} onChange={e => setTags(e.target.value)} rows={3} className={inp} />
        </div>
        {err && <p className="text-xs text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
          <button onClick={() => void save()} disabled={busy} className="px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>{busy ? '…' : t('common.save', 'Speichern')}</button>
        </div>
      </div>
    </div>
  )
}
