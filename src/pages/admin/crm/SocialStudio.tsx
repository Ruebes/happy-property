import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import { CustomSelect } from '../../../components/CustomSelect'

// ── Social Media Studio ───────────────────────────────────────────────────────
// Organische Posts für Facebook/Instagram/LinkedIn: Posting-Plan je Thema
// (Objekt vorstellen, Wissenswertes, Lottes Weisheit der Woche, Aktuelles/News),
// hochwertiges Chatfenster (social-agent: bestes Claude-Modell + Firmenwissen),
// Bilder via OpenAI, News-Recherche legt Fundstücke als Aufgabe auf die Startseite.

interface SocialPost {
  id: string; topic: string; title: string | null; content: string | null
  platforms: string[]; image_url: string | null; status: string
  scheduled_for: string | null; news_source: string | null
  post_results: Record<string, { ok: boolean; id?: string; error?: string }> | null
  created_at: string
}
interface ChatMsg { role: 'user' | 'assistant'; content: string }

const TOPICS = [
  { key: 'objekt', icon: '🏠', de: 'Immobilie vorstellen' },
  { key: 'wissen', icon: '💡', de: 'Wissenswertes' },
  { key: 'weisheit', icon: '🐾', de: 'Weisheit der Woche (Lotte)' },
  { key: 'news', icon: '📰', de: 'Aktuelles' },
  { key: 'sonstiges', icon: '✏️', de: 'Sonstiges' },
]
const PLATFORMS = [
  { key: 'facebook', label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'linkedin', label: 'LinkedIn' },
]
const STATUS_BADGE: Record<string, { de: string; cls: string }> = {
  entwurf: { de: 'Entwurf', cls: 'bg-gray-100 text-gray-600' },
  geplant: { de: 'Geplant', cls: 'bg-blue-100 text-blue-700' },
  gepostet: { de: 'Gepostet', cls: 'bg-green-100 text-green-700' },
  fehlgeschlagen: { de: 'Fehlgeschlagen', cls: 'bg-red-100 text-red-700' },
}

// ── Editor + Chat ────────────────────────────────────────────────────────────
function PostEditor({ post, onClose, onChanged }: { post: SocialPost; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation()
  const [content, setContent] = useState(post.content ?? '')
  const [platforms, setPlatforms] = useState<string[]>(post.platforms)
  const [scheduled, setScheduled] = useState(post.scheduled_for ? post.scheduled_for.slice(0, 16) : '')
  const [imageUrl, setImageUrl] = useState(post.image_url)
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<'' | 'chat' | 'image' | 'save' | 'publish'>('')
  const [note, setNote] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void supabase.from('social_post_messages').select('role, content').eq('post_id', post.id).order('created_at').limit(40)
      .then(({ data }) => setMsgs(((data ?? []) as ChatMsg[])))
  }, [post.id])
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [msgs, busy])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput(''); setBusy('chat'); setNote('')
    setMsgs(m => [...m, { role: 'user', content: text }])
    try {
      const { data, error } = await supabase.functions.invoke('social-agent', { body: { action: 'chat', post_id: post.id, message: text } })
      const d = (data ?? {}) as { ok?: boolean; error?: string; reply?: string; content?: string | null }
      if (error || d.error || !d.ok) throw new Error(d.error || error?.message || 'Fehler')
      setMsgs(m => [...m, { role: 'assistant', content: d.reply || 'Post aktualisiert ✓' }])
      if (d.content) setContent(d.content)
    } catch (e) {
      console.error('[SocialStudio] chat:', e)
      setMsgs(m => [...m, { role: 'assistant', content: `❌ ${t('crm.social.chatErr', 'Das hat nicht geklappt — bitte nochmal.')}` }])
    } finally { setBusy('') }
  }

  const genImage = async () => {
    if (busy) return
    setBusy('image'); setNote('')
    try {
      const { data, error } = await supabase.functions.invoke('social-agent', { body: { action: 'image', post_id: post.id } })
      const d = (data ?? {}) as { ok?: boolean; error?: string; image_url?: string }
      if (error || d.error || !d.ok) throw new Error(d.error || error?.message || 'Fehler')
      setImageUrl(d.image_url ?? null)
    } catch (e) {
      setNote(`❌ ${e instanceof Error ? e.message : 'Bild fehlgeschlagen'}`)
    } finally { setBusy('') }
  }

  const save = async (statusOverride?: string) => {
    setBusy('save')
    try {
      const { error } = await supabase.from('social_posts').update({
        content: content || null, platforms,
        scheduled_for: scheduled ? new Date(scheduled).toISOString() : null,
        status: statusOverride ?? (scheduled ? 'geplant' : post.status === 'gepostet' ? 'gepostet' : 'entwurf'),
        updated_at: new Date().toISOString(),
      }).eq('id', post.id)
      if (error) throw error
      onChanged()
      if (!statusOverride) setNote(`✓ ${t('crm.social.saved', 'Gespeichert')}`)
    } catch (e) {
      setNote(`❌ ${e instanceof Error ? e.message : 'Fehler'}`)
    } finally { setBusy('') }
  }

  const publish = async () => {
    if (!window.confirm(t('crm.social.publishConfirm', 'Diesen Post JETZT öffentlich auf {{p}} veröffentlichen?', { p: platforms.join(' + ') }) as string)) return
    setBusy('publish'); setNote('')
    try {
      await save('') // aktuellen Stand sichern (Status unangetastet)
      const { data, error } = await supabase.functions.invoke('social-agent', { body: { action: 'publish', post_id: post.id } })
      const d = (data ?? {}) as { ok?: boolean; error?: string; results?: Record<string, { ok: boolean; error?: string }> }
      if (error && !d.results) throw new Error(d.error || error.message)
      const parts = Object.entries(d.results ?? {}).map(([k, v]) => `${k}: ${v.ok ? '✓' : `❌ ${v.error}`}`)
      setNote(parts.join('  ·  ') || (d.error ?? 'Keine Plattform-Antwort'))
      onChanged()
    } catch (e) {
      setNote(`❌ ${e instanceof Error ? e.message : 'Veröffentlichen fehlgeschlagen'}`)
    } finally { setBusy('') }
  }

  const topic = TOPICS.find(x => x.key === post.topic)
  const inp = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400'

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl flex flex-col md:flex-row overflow-hidden" style={{ height: 'min(88vh, 760px)' }} onClick={e => e.stopPropagation()}>

        {/* Chat (links) */}
        <div className="md:w-1/2 flex flex-col border-r border-gray-100 min-h-0">
          <div className="px-5 py-3 border-b border-gray-100 shrink-0 flex items-center justify-between">
            <p className="font-semibold text-gray-900 text-sm">💬 {t('crm.social.chatTitle', 'Post-Chat')} <span className="text-gray-400 font-normal">· {topic?.icon} {topic ? t(`crm.social.topic.${topic.key}`, topic.de) : ''}</span></p>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50/60 min-h-0">
            {msgs.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-6">{t('crm.social.chatEmpty', 'Sag mir, worum es gehen soll — ich texte den Post und du siehst ihn rechts sofort.')}</p>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap ${m.role === 'user' ? 'text-white rounded-br-sm' : 'bg-white border border-gray-100 text-gray-800 rounded-bl-sm'}`}
                  style={m.role === 'user' ? { backgroundColor: '#ff795d' } : undefined}>{m.content}</div>
              </div>
            ))}
            {busy === 'chat' && (
              <div className="flex justify-start"><div className="bg-white border border-gray-100 rounded-2xl rounded-bl-sm px-3.5 py-2.5">
                <span className="inline-flex gap-1"><span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" /><span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: '150ms' }} /><span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: '300ms' }} /></span>
              </div></div>
            )}
          </div>
          <div className="p-3 border-t border-gray-100 shrink-0 flex items-end gap-2">
            <textarea rows={1} value={input} onChange={e => setInput(e.target.value)} disabled={busy === 'chat'}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
              placeholder={t('crm.social.chatPh', 'Nachricht … (Enter zum Senden)')}
              className="flex-1 resize-none border border-gray-200 rounded-xl px-3 py-2 text-sm max-h-28 focus:outline-none focus:ring-2 focus:ring-orange-300" />
            <button onClick={() => void send()} disabled={busy === 'chat' || !input.trim()}
              className="px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-40 shrink-0" style={{ backgroundColor: '#ff795d' }}>
              {t('crm.social.send', 'Senden')}
            </button>
          </div>
        </div>

        {/* Post (rechts) */}
        <div className="md:w-1/2 flex flex-col min-h-0">
          <div className="px-5 py-3 border-b border-gray-100 shrink-0 flex items-center justify-between">
            <p className="font-semibold text-gray-900 text-sm">{post.title || t('crm.social.newPost', 'Neuer Post')}</p>
            <button onClick={onClose} className="w-8 h-8 rounded-lg text-gray-400 hover:bg-gray-100">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-5 space-y-4 min-h-0">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.postText', 'Post-Text')}</label>
              <textarea value={content} onChange={e => setContent(e.target.value)} rows={10} className={`${inp} leading-relaxed`} />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <label className="text-xs font-medium text-gray-500">{t('crm.social.image', 'Bild')}</label>
                <button onClick={() => void genImage()} disabled={busy === 'image'}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
                  {busy === 'image' ? t('crm.social.imageWorking', 'Bild wird erstellt (~30 s)…') : imageUrl ? t('crm.social.imageRedo', '🎨 Neues Bild erstellen') : t('crm.social.imageMake', '🎨 Bild erstellen')}
                </button>
              </div>
              {imageUrl ? <img src={imageUrl} alt="" className="rounded-xl w-full max-w-xs border border-gray-100" /> : <p className="text-xs text-gray-400">{t('crm.social.noImage', 'Noch kein Bild. Instagram braucht eins.')}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.platforms', 'Plattformen')}</label>
              <div className="flex gap-2 flex-wrap">
                {PLATFORMS.map(pl => (
                  <label key={pl.key} className={`px-3 py-1.5 rounded-xl text-sm border cursor-pointer ${platforms.includes(pl.key) ? 'text-white border-transparent' : 'border-gray-200 text-gray-600'}`}
                    style={platforms.includes(pl.key) ? { backgroundColor: '#1a2332' } : undefined}>
                    <input type="checkbox" className="hidden" checked={platforms.includes(pl.key)}
                      onChange={e => setPlatforms(p => e.target.checked ? [...p, pl.key] : p.filter(x => x !== pl.key))} />
                    {pl.label}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.schedule', 'Geplant für (optional)')}</label>
              <input type="datetime-local" value={scheduled} onChange={e => setScheduled(e.target.value)} className={inp} />
              <p className="text-[11px] text-gray-400 mt-1">{t('crm.social.scheduleHint', 'Nur zur Planung im Kalender — veröffentlicht wird per Klick auf „Jetzt posten".')}</p>
            </div>
            {post.post_results && (
              <div className="text-xs text-gray-500 space-y-0.5">
                {Object.entries(post.post_results).map(([k, v]) => (
                  <p key={k}>{k}: {v.ok ? '✓ gepostet' : `❌ ${v.error}`}</p>
                ))}
              </div>
            )}
            {note && <p className="text-sm rounded-lg px-3 py-2 bg-gray-50 text-gray-700 whitespace-pre-wrap">{note}</p>}
          </div>
          <div className="p-4 border-t border-gray-100 shrink-0 flex items-center gap-2 flex-wrap">
            <button onClick={() => void save()} disabled={!!busy} className="px-4 py-2 rounded-xl text-sm border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              {busy === 'save' ? t('common.saving', 'Speichert…') : `💾 ${t('common.save', 'Speichern')}`}
            </button>
            <button onClick={() => void publish()} disabled={!!busy || !content.trim() || platforms.length === 0}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
              {busy === 'publish' ? t('crm.social.publishing', 'Wird veröffentlicht…') : `🚀 ${t('crm.social.publish', 'Jetzt posten')}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Seite ────────────────────────────────────────────────────────────────────
export default function SocialStudio() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const [posts, setPosts] = useState<SocialPost[]>([])
  const [loading, setLoading] = useState(true)
  const [openPost, setOpenPost] = useState<SocialPost | null>(null)
  const [newTopic, setNewTopic] = useState('weisheit')
  const [busyKey, setBusyKey] = useState('')
  const [toast, setToast] = useState('')
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 6000) }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.from('social_posts').select('*').order('created_at', { ascending: false }).limit(100)
      if (error) throw error
      setPosts((data as unknown as SocialPost[]) ?? [])
    } catch (err) {
      console.error('[SocialStudio] fetchAll:', err)
      setPosts([])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void fetchAll() }, [fetchAll])

  const createPost = async () => {
    setBusyKey('new')
    try {
      const tp = TOPICS.find(x => x.key === newTopic)
      const { data, error } = await supabase.from('social_posts').insert({
        topic: newTopic, title: `${tp?.icon ?? ''} ${tp ? t(`crm.social.topic.${tp.key}`, tp.de) : ''} · ${new Date().toLocaleDateString('de-DE')}`,
        platforms: newTopic === 'weisheit' ? ['facebook', 'instagram'] : ['facebook', 'instagram', 'linkedin'],
        created_by: profile?.id ?? null,
      }).select('*').single()
      if (error) throw error
      await fetchAll()
      setOpenPost(data as unknown as SocialPost)
    } catch (err) {
      console.error('[SocialStudio] createPost:', err)
      showToast('❌ Post konnte nicht angelegt werden')
    } finally { setBusyKey('') }
  }

  const runNewsScan = async () => {
    setBusyKey('news')
    try {
      const { data, error } = await supabase.functions.invoke('social-agent', { body: { action: 'news_scan' } })
      const d = (data ?? {}) as { ok?: boolean; error?: string }
      if (error || d.error || !d.ok) throw new Error(d.error || error?.message || 'Fehler')
      showToast(t('crm.social.newsDone', '📰 Recherche fertig — die Fundstücke liegen als Aufgabe auf deiner Startseite.'))
    } catch (e) {
      showToast(`❌ ${e instanceof Error ? e.message : 'Recherche fehlgeschlagen'}`)
    } finally { setBusyKey('') }
  }

  const deletePost = async (p: SocialPost) => {
    if (!window.confirm(t('crm.social.deleteConfirm', 'Diesen Post-Entwurf löschen?') as string)) return
    const { error } = await supabase.from('social_posts').delete().eq('id', p.id)
    if (error) { showToast(`❌ ${error.message}`); return }
    void fetchAll()
  }

  const d2 = (s: string | null) => s ? new Date(s).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg max-w-md">{toast}</div>}
      <div className="p-6 space-y-5 max-w-5xl">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('crm.social.title', 'Social Media')}</h1>
            <p className="text-sm text-gray-500 mt-0.5">{t('crm.social.subtitle', 'Organische Posts für Facebook, Instagram & LinkedIn — mit KI-Chat, Bildern und News-Recherche.')}</p>
          </div>
          <button onClick={() => void runNewsScan()} disabled={busyKey === 'news'}
            className="px-3 py-1.5 rounded-xl text-sm font-medium border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
            {busyKey === 'news' ? t('crm.social.newsWorking', 'Recherchiert (~1 Min)…') : t('crm.social.newsBtn', '📰 News jetzt recherchieren')}
          </button>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-end gap-2 flex-wrap">
          <div className="min-w-[240px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.newPostTopic', 'Neuen Post starten')}</label>
            <CustomSelect value={newTopic} onChange={setNewTopic}
              options={TOPICS.map(x => ({ value: x.key, label: `${x.icon} ${t(`crm.social.topic.${x.key}`, x.de)}` }))} />
          </div>
          <button onClick={() => void createPost()} disabled={busyKey === 'new'}
            className="px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
            {busyKey === 'new' ? t('common.saving', 'lädt …') : t('crm.social.newPostBtn', '+ Post')}
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : posts.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-sm text-gray-500">{t('crm.social.empty', 'Noch keine Posts — starte oben deinen ersten.')}</div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {posts.map(p => {
              const tp = TOPICS.find(x => x.key === p.topic)
              const st = STATUS_BADGE[p.status] ?? STATUS_BADGE.entwurf
              return (
                <div key={p.id} onClick={() => setOpenPost(p)}
                  className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 cursor-pointer hover:border-orange-200 transition-colors">
                  <div className="flex items-start gap-3">
                    {p.image_url
                      ? <img src={p.image_url} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0" loading="lazy" />
                      : <div className="w-16 h-16 rounded-xl bg-gray-100 flex items-center justify-center text-2xl shrink-0">{tp?.icon ?? '✏️'}</div>}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${st.cls}`}>{t(`crm.social.status.${p.status}`, st.de)}</span>
                        <span className="text-[11px] text-gray-400">{p.platforms.join(' · ')}</span>
                      </div>
                      <p className="text-sm font-medium text-gray-800 mt-1 truncate">{p.title ?? tp?.de}</p>
                      <p className="text-xs text-gray-500 truncate">{(p.content ?? '').replace(/\s+/g, ' ').slice(0, 80) || t('crm.social.noText', '(noch kein Text)')}</p>
                      {p.scheduled_for && <p className="text-[11px] text-gray-400 mt-0.5">🗓 {d2(p.scheduled_for)}</p>}
                    </div>
                    {p.status !== 'gepostet' && (
                      <button onClick={e => { e.stopPropagation(); void deletePost(p) }} className="text-gray-300 hover:text-red-500 shrink-0">🗑</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {openPost && <PostEditor post={openPost} onClose={() => { setOpenPost(null); void fetchAll() }} onChanged={() => void fetchAll()} />}
    </DashboardLayout>
  )
}
