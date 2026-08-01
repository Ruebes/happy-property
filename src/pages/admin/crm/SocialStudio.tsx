import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import { CustomSelect } from '../../../components/CustomSelect'

// ── Social Media Studio ───────────────────────────────────────────────────────
// Organische Posts für Facebook/Instagram/LinkedIn. Kategorien kommen aus
// social_topics (frei erweiter-/löschbar). „Immobilie vorstellen" zieht Projekt
// ODER einzelne Wohnung samt Bildern direkt aus dem Portal (deck_assets).
// Format Einzelpost/Karussell (FB+IG; LinkedIn folgt mit der Anbindung).
// Vorausplanung: Status „geplant" + Datum → der Auto-Cron postet EINEN fälligen
// Post pro Tag (08:00 UTC) auf die gewählten Plattformen.

interface Topic { key: string; label: string; icon: string; sort: number }
interface SocialPost {
  id: string; topic: string; title: string | null; content: string | null
  platforms: string[]; image_url: string | null; image_urls: string[] | null
  format: string; status: string; scheduled_for: string | null
  project_id: string | null; unit_id: string | null; news_source: string | null
  post_results: Record<string, { ok: boolean; id?: string; error?: string }> | null
  created_at: string
}
interface ChatMsg { role: 'user' | 'assistant'; content: string }
interface ProjectOpt { id: string; name: string; deck_assets: { renders?: string[]; gallery?: string[] } | null }
interface UnitOpt { id: string; unit_number: string; price_net: number | null }

const PLATFORMS = [
  { key: 'facebook', label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'linkedin', label: 'LinkedIn' },
]
const STATUS_BADGE: Record<string, { de: string; cls: string }> = {
  entwurf: { de: 'Entwurf', cls: 'bg-gray-100 text-gray-600' },
  geplant: { de: 'Freigegeben', cls: 'bg-blue-100 text-blue-700' },
  gepostet: { de: 'Gepostet', cls: 'bg-green-100 text-green-700' },
  fehlgeschlagen: { de: 'Fehlgeschlagen', cls: 'bg-red-100 text-red-700' },
}

// ── Editor + Chat ────────────────────────────────────────────────────────────
function PostEditor({ post, topics, projects, onClose }: { post: SocialPost; topics: Topic[]; projects: ProjectOpt[]; onClose: () => void }) {
  const { t } = useTranslation()
  const [content, setContent] = useState(post.content ?? '')
  const [platforms, setPlatforms] = useState<string[]>(post.platforms)
  const [scheduled, setScheduled] = useState(post.scheduled_for ? post.scheduled_for.slice(0, 16) : '')
  const [images, setImages] = useState<string[]>(() => {
    const arr = Array.isArray(post.image_urls) ? post.image_urls.filter(Boolean) : []
    return arr.length ? arr : (post.image_url ? [post.image_url] : [])
  })
  const [format, setFormat] = useState(post.format === 'carousel' ? 'carousel' : 'single')
  const [approved, setApproved] = useState(post.status === 'geplant')
  const [projectId, setProjectId] = useState(post.project_id ?? '')
  const [unitId, setUnitId] = useState(post.unit_id ?? '')
  const [units, setUnits] = useState<UnitOpt[]>([])
  const [showGallery, setShowGallery] = useState(false)
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
  // Wohnungen des gewählten Projekts nachladen
  useEffect(() => {
    if (!projectId) { setUnits([]); return }
    void supabase.from('crm_project_units').select('id, unit_number, price_net').eq('project_id', projectId).order('unit_number')
      .then(({ data }) => setUnits(((data ?? []) as UnitOpt[])))
  }, [projectId])

  // Projekt/Wohnung sofort speichern — der Chat (Edge) liest sie aus der DB.
  const persistFocus = async (pid: string, uid: string) => {
    await supabase.from('social_posts').update({ project_id: pid || null, unit_id: uid || null, updated_at: new Date().toISOString() }).eq('id', post.id)
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput(''); setBusy('chat'); setNote('')
    setMsgs(m => [...m, { role: 'user', content: text }])
    try {
      const { data, error } = await supabase.functions.invoke('social-agent', { body: { action: 'chat', post_id: post.id, message: text } })
      const d = (data ?? {}) as { ok?: boolean; error?: string; reply?: string; content?: string | null; image_url?: string | null }
      if (error || d.error || !d.ok) throw new Error(d.error || error?.message || 'Fehler')
      setMsgs(m => [...m, { role: 'assistant', content: d.reply || 'Post aktualisiert ✓' }])
      if (d.content) setContent(d.content)
      if (d.image_url) setImages(im => [...im, d.image_url!])
    } catch (e) {
      console.error('[SocialStudio] chat:', e)
      const msg = e instanceof Error ? e.message : String(e)
      setMsgs(m => [...m, { role: 'assistant', content: `❌ ${t('crm.social.chatErr', 'Das hat nicht geklappt')}: ${msg}` }])
    } finally { setBusy('') }
  }

  const genImage = async () => {
    if (busy) return
    setBusy('image'); setNote('')
    try {
      const { data, error } = await supabase.functions.invoke('social-agent', { body: { action: 'image', post_id: post.id } })
      const d = (data ?? {}) as { ok?: boolean; error?: string; image_url?: string }
      if (error || d.error || !d.ok) throw new Error(d.error || error?.message || 'Fehler')
      if (d.image_url) setImages(im => [...im, d.image_url!])
    } catch (e) {
      setNote(`❌ ${e instanceof Error ? e.message : 'Bild fehlgeschlagen'}`)
    } finally { setBusy('') }
  }

  const save = async (silent = false) => {
    setBusy('save')
    try {
      const { error } = await supabase.from('social_posts').update({
        content: content || null, platforms, format,
        project_id: projectId || null, unit_id: unitId || null,
        image_urls: images, image_url: images[0] ?? null,
        scheduled_for: scheduled ? new Date(scheduled).toISOString() : null,
        status: post.status === 'gepostet' ? 'gepostet' : (approved ? 'geplant' : 'entwurf'),
        updated_at: new Date().toISOString(),
      }).eq('id', post.id)
      if (error) throw error
      if (!silent) setNote(`✓ ${t('crm.social.saved', 'Gespeichert')}${approved && scheduled ? ` — ${t('crm.social.savedQueue', 'in der Tages-Warteschlange')}` : !approved ? ` — ${t('crm.social.savedDraft', 'Entwurf, wird NICHT automatisch gepostet')}` : ''}`)
    } catch (e) {
      setNote(`❌ ${e instanceof Error ? e.message : 'Fehler'}`)
    } finally { setBusy('') }
  }

  const publish = async () => {
    if (!window.confirm(t('crm.social.publishConfirm', 'Diesen Post JETZT öffentlich auf {{p}} veröffentlichen?', { p: platforms.join(' + ') }) as string)) return
    setBusy('publish'); setNote('')
    try {
      await save(true)
      const { data, error } = await supabase.functions.invoke('social-agent', { body: { action: 'publish', post_id: post.id } })
      const d = (data ?? {}) as { ok?: boolean; error?: string; results?: Record<string, { ok: boolean; error?: string }> }
      if (error && !d.results) throw new Error(d.error || error.message)
      const parts = Object.entries(d.results ?? {}).map(([k, v]) => `${k}: ${v.ok ? '✓' : `❌ ${v.error}`}`)
      setNote(parts.join('  ·  ') || (d.error ?? 'Keine Plattform-Antwort'))
    } catch (e) {
      setNote(`❌ ${e instanceof Error ? e.message : 'Veröffentlichen fehlgeschlagen'}`)
    } finally { setBusy('') }
  }

  const topic = topics.find(x => x.key === post.topic)
  const selProject = projects.find(x => x.id === projectId)
  const galleryImgs = [...(selProject?.deck_assets?.renders ?? []), ...(selProject?.deck_assets?.gallery ?? [])].slice(0, 24)
  const inp = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400'

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl flex flex-col md:flex-row overflow-hidden" style={{ height: 'min(90vh, 800px)' }} onClick={e => e.stopPropagation()}>

        {/* Chat (links) */}
        <div className="md:w-1/2 flex flex-col border-r border-gray-100 min-h-0">
          <div className="px-5 py-3 border-b border-gray-100 shrink-0">
            <p className="font-semibold text-gray-900 text-sm">💬 {t('crm.social.chatTitle', 'Post-Chat')} <span className="text-gray-400 font-normal">· {topic ? `${topic.icon} ${topic.label}` : ''}</span></p>
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
            <p className="font-semibold text-gray-900 text-sm truncate">{post.title || t('crm.social.newPost', 'Neuer Post')}</p>
            <button onClick={onClose} className="w-8 h-8 rounded-lg text-gray-400 hover:bg-gray-100 shrink-0">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-5 space-y-4 min-h-0">

            {/* Projekt / Wohnung aus dem Portal */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.project', 'Projekt (aus dem Portal)')}</label>
                <CustomSelect value={projectId}
                  onChange={v => { setProjectId(v); setUnitId(''); void persistFocus(v, '') }}
                  options={[{ value: '', label: `— ${t('crm.social.noProject', 'kein Projekt')} —` }, ...projects.map(p => ({ value: p.id, label: p.name }))]} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.unit', 'Einzelne Wohnung (optional)')}</label>
                <CustomSelect value={unitId} disabled={!projectId}
                  onChange={v => { setUnitId(v); void persistFocus(projectId, v) }}
                  options={[{ value: '', label: `— ${t('crm.social.wholeProject', 'ganzes Projekt')} —` }, ...units.map(u => ({ value: u.id, label: `${u.unit_number}${u.price_net ? ` · ${u.price_net.toLocaleString('de-DE')} €` : ''}` }))]} />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.postText', 'Post-Text')}</label>
              <textarea value={content} onChange={e => setContent(e.target.value)} rows={9} className={`${inp} leading-relaxed`} />
            </div>

            {/* Bilder: generieren + aus dem Projekt wählen, Mehrfach für Karussell */}
            <div>
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <label className="text-xs font-medium text-gray-500">{t('crm.social.images', 'Bilder')} ({images.length})</label>
                <button onClick={() => void genImage()} disabled={busy === 'image'}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
                  {busy === 'image' ? t('crm.social.imageWorking', 'Bild wird erstellt (~30 s)…') : t('crm.social.imageMake', '🎨 KI-Bild erstellen')}
                </button>
                {galleryImgs.length > 0 && (
                  <button onClick={() => setShowGallery(g => !g)}
                    className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50">
                    🖼 {t('crm.social.fromProject', 'Aus dem Projekt wählen')} {showGallery ? '▴' : '▾'}
                  </button>
                )}
              </div>
              {images.length > 0 && (
                <div className="flex gap-2 flex-wrap mb-2">
                  {images.map((u, i) => (
                    <div key={u + i} className="relative">
                      <img src={u} alt="" className="w-20 h-20 rounded-xl object-cover border border-gray-100" loading="lazy" />
                      {i === 0 && <span className="absolute bottom-0.5 left-0.5 text-[9px] bg-black/60 text-white px-1 rounded">{t('crm.social.cover', 'Titel')}</span>}
                      <button onClick={() => setImages(im => im.filter((_, x) => x !== i))}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-white border border-gray-200 text-gray-500 text-xs hover:text-red-600">×</button>
                    </div>
                  ))}
                </div>
              )}
              {showGallery && (
                <div className="grid grid-cols-4 gap-1.5 p-2 bg-gray-50 rounded-xl max-h-52 overflow-y-auto">
                  {galleryImgs.map(u => {
                    const on = images.includes(u)
                    return (
                      <button key={u} onClick={() => setImages(im => on ? im.filter(x => x !== u) : [...im, u])}
                        className={`relative rounded-lg overflow-hidden border-2 ${on ? 'border-orange-500' : 'border-transparent'}`}>
                        <img src={u} alt="" className="w-full h-16 object-cover" loading="lazy" />
                        {on && <span className="absolute top-0.5 right-0.5 text-xs bg-orange-500 text-white rounded-full w-4 h-4 flex items-center justify-center">✓</span>}
                      </button>
                    )
                  })}
                </div>
              )}
              {images.length === 0 && <p className="text-xs text-gray-400">{t('crm.social.noImage', 'Noch kein Bild. Instagram braucht mindestens eins.')}</p>}
            </div>

            {/* Format + Plattformen */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.format', 'Format (FB & Insta)')}</label>
                <CustomSelect value={format} onChange={setFormat} options={[
                  { value: 'single', label: t('crm.social.formatSingle', '🖼 Einzelpost') },
                  { value: 'carousel', label: t('crm.social.formatCarousel', '🎠 Karussell (2–10 Bilder)') },
                ]} />
                {format === 'carousel' && images.length < 2 && <p className="text-[11px] text-amber-600 mt-1">{t('crm.social.carouselNeed', 'Karussell braucht mindestens 2 Bilder.')}</p>}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.platforms', 'Plattformen')}</label>
                <div className="flex gap-1.5 flex-wrap">
                  {PLATFORMS.map(pl => (
                    <label key={pl.key} className={`px-2.5 py-1.5 rounded-xl text-xs border cursor-pointer ${platforms.includes(pl.key) ? 'text-white border-transparent' : 'border-gray-200 text-gray-600'}`}
                      style={platforms.includes(pl.key) ? { backgroundColor: '#1a2332' } : undefined}>
                      <input type="checkbox" className="hidden" checked={platforms.includes(pl.key)}
                        onChange={e => setPlatforms(p => e.target.checked ? [...p, pl.key] : p.filter(x => x !== pl.key))} />
                      {pl.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {post.status !== 'gepostet' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.approval', 'Freigabe')}</label>
                <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
                  <button onClick={() => setApproved(false)}
                    className={`flex-1 px-3 py-1.5 rounded-lg text-sm font-medium ${!approved ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}>
                    📝 {t('crm.social.statusDraft', 'Entwurf')}
                  </button>
                  <button onClick={() => setApproved(true)}
                    className={`flex-1 px-3 py-1.5 rounded-lg text-sm font-medium ${approved ? 'bg-white shadow-sm text-green-700' : 'text-gray-500'}`}>
                    ✅ {t('crm.social.statusApproved', 'Freigegeben')}
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 mt-1">{t('crm.social.approveHint', 'Nur freigegebene Posts gehen automatisch raus — Entwürfe bleiben im Redaktionsplan stehen, werden aber nicht gepostet.')}</p>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.schedule', 'Geplant für')}</label>
              <input type="datetime-local" value={scheduled} onChange={e => setScheduled(e.target.value)} className={inp} />
              <p className="text-[11px] text-gray-400 mt-1">{t('crm.social.scheduleHintAuto', 'Mit Datum + Speichern landet der Post in der Warteschlange: Die Automatik veröffentlicht EINEN fälligen Post pro Tag (vormittags) auf die gewählten Plattformen.')}</p>
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
            <button onClick={() => void publish()} disabled={!!busy || !content.trim() || platforms.length === 0 || (format === 'carousel' && images.length < 2)}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
              {busy === 'publish' ? t('crm.social.publishing', 'Wird veröffentlicht…') : `🚀 ${t('crm.social.publish', 'Jetzt posten')}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Redaktionsplan: Monatskalender über Social-Posts + Newsletter ───────────
interface NlEntry { id: string; title: string; status: string; date: string | null }

// Plattform-Chips in Markenfarben (Redaktionsplan)
const PLAT_CHIP: Record<string, { txt: string; cls: string }> = {
  facebook: { txt: 'f', cls: 'bg-[#1877F2] text-white' },
  instagram: { txt: 'IG', cls: 'bg-[#E1306C] text-white' },
  linkedin: { txt: 'in', cls: 'bg-[#0A66C2] text-white' },
}

function PlanCalendar({ posts, newsletters, topics, onOpenPost, onCreateForDay }: {
  posts: SocialPost[]; newsletters: NlEntry[]; topics: Topic[]
  onOpenPost: (p: SocialPost) => void; onCreateForDay: (day: Date) => void
}) {
  const { t } = useTranslation()
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const today = new Date(); today.setHours(0, 0, 0, 0)

  // Kalender-Gitter: Montag-basiert, 6 Wochen
  const first = new Date(month)
  const offset = (first.getDay() + 6) % 7
  const start = new Date(first); start.setDate(first.getDate() - offset)
  const days: Date[] = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d })
  const sameDay = (a: Date, iso: string | null) => {
    if (!iso) return false
    const b = new Date(iso)
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  }
  const monthLabel = month.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
  const wd = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <button onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))} className="w-8 h-8 rounded-lg text-gray-500 hover:bg-gray-100">‹</button>
        <p className="font-semibold text-gray-900 capitalize">{monthLabel}</p>
        <button onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))} className="w-8 h-8 rounded-lg text-gray-500 hover:bg-gray-100">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-gray-400 mb-1">
        {wd.map(d => <div key={d}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((d, i) => {
          const inMonth = d.getMonth() === month.getMonth()
          const isToday = d.getTime() === today.getTime()
          const dayPosts = posts.filter(pp => sameDay(d, pp.scheduled_for) || (pp.status === 'gepostet' && !pp.scheduled_for && sameDay(d, pp.created_at)))
          const dayNls = newsletters.filter(n => sameDay(d, n.date))
          return (
            <div key={i} className={`group min-h-[84px] rounded-lg border p-1 text-left align-top ${inMonth ? 'border-gray-100 bg-white' : 'border-transparent bg-gray-50/60'} ${isToday ? 'ring-2 ring-orange-300' : ''}`}>
              <div className="flex items-center justify-between">
                <span className={`text-[11px] ${inMonth ? 'text-gray-500' : 'text-gray-300'} ${isToday ? 'font-bold text-orange-600' : ''}`}>{d.getDate()}</span>
                <button onClick={() => onCreateForDay(d)} title={t('crm.social.planAdd', 'Post für diesen Tag anlegen')}
                  className="opacity-0 group-hover:opacity-100 w-5 h-5 rounded text-gray-400 hover:text-orange-600 hover:bg-orange-50 text-sm leading-none">+</button>
              </div>
              <div className="space-y-0.5 mt-0.5">
                {dayPosts.map(pp => {
                  const tp = topics.find(x => x.key === pp.topic)
                  const isDraft = pp.status === 'entwurf'
                  const cls = pp.status === 'gepostet' ? 'bg-green-50 text-green-800 border-green-200'
                    : pp.status === 'fehlgeschlagen' ? 'bg-red-50 text-red-700 border-red-200'
                    : isDraft ? 'bg-gray-50 text-gray-500 border-dashed border-gray-300'
                    : 'bg-blue-50 text-blue-800 border-blue-200'
                  const stLabel = pp.status === 'gepostet' ? t('crm.social.status.gepostet', 'Gepostet')
                    : pp.status === 'fehlgeschlagen' ? t('crm.social.status.fehlgeschlagen', 'Fehlgeschlagen')
                    : isDraft ? t('crm.social.status.entwurf', 'Entwurf') : t('crm.social.planApprovedFull', 'Freigegeben — wird so gepostet')
                  return (
                    <button key={pp.id} onClick={() => onOpenPost(pp)}
                      className={`w-full text-left text-[10px] leading-tight px-1 py-0.5 rounded border flex items-center gap-0.5 ${cls}`}
                      title={`${stLabel} · ${tp?.label ?? pp.topic} · ${pp.platforms.join(', ')} · ${(pp.content ?? '').slice(0, 80)}`}>
                      <span className="shrink-0">{isDraft ? '📝' : pp.status === 'gepostet' ? '✓' : '✅'}</span>
                      {pp.platforms.map(pl => PLAT_CHIP[pl] ? (
                        <span key={pl} className={`shrink-0 rounded px-0.5 text-[8px] font-bold leading-[11px] ${PLAT_CHIP[pl].cls}`}>{PLAT_CHIP[pl].txt}</span>
                      ) : null)}
                      <span className="truncate">{(pp.title ?? pp.content ?? '').replace(/^[^A-Za-zÄÖÜäöü0-9]+/, '').slice(0, 24)}</span>
                    </button>
                  )
                })}
                {dayNls.map(n => (
                  <a key={n.id} href={`/admin/crm/newsletter?edit=${n.id}`}
                    className="w-full text-[10px] leading-tight px-1 py-0.5 rounded border flex items-center gap-0.5 bg-purple-50 text-purple-800 border-purple-200"
                    title={`Newsletter · ${n.title}`}>
                    <span className="shrink-0 rounded px-0.5 text-[8px] font-bold leading-[11px] bg-purple-600 text-white">NL</span>
                    <span className="truncate">{n.title}</span>
                  </a>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex gap-3 mt-3 text-[11px] text-gray-500 flex-wrap">
        <span>📝 <span className="inline-block w-2.5 h-2.5 rounded-sm bg-gray-50 border border-dashed border-gray-300 mr-1" />{t('crm.social.legendDraft', 'Entwurf — wird nicht gepostet')}</span>
        <span>✅ <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-100 border border-blue-200 mr-1" />{t('crm.social.legendApproved', 'freigegeben — wird so gepostet')}</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-100 border border-green-200 mr-1" />{t('crm.social.legendPosted', 'gepostet')}</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-purple-100 border border-purple-200 mr-1" />{t('crm.social.legendNewsletter', 'Newsletter')}</span>
        <span className="text-gray-400">{t('crm.social.legendPlatforms', 'f = Facebook · IG = Instagram · in = LinkedIn · NL = Newsletter')}</span>
        <span className="text-gray-400">{t('crm.social.planHint', 'Klick auf einen Eintrag öffnet ihn · „+" am Tag legt einen Post für diesen Tag an.')}</span>
      </div>
    </div>
  )
}

// ── Seite ────────────────────────────────────────────────────────────────────
export default function SocialStudio() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const [posts, setPosts] = useState<SocialPost[]>([])
  const [topics, setTopics] = useState<Topic[]>([])
  const [projects, setProjects] = useState<ProjectOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [openPost, setOpenPost] = useState<SocialPost | null>(null)
  const [newTopic, setNewTopic] = useState('')
  const [busyKey, setBusyKey] = useState('')
  const [toast, setToast] = useState('')
  const [manageTopics, setManageTopics] = useState(false)
  const [view, setView] = useState<'plan' | 'list'>('plan')
  const [newsletters, setNewsletters] = useState<NlEntry[]>([])
  const [newTopicLabel, setNewTopicLabel] = useState('')
  const [newTopicIcon, setNewTopicIcon] = useState('✨')
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 6000) }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: ps }, { data: ts }, { data: prs }] = await Promise.all([
        supabase.from('social_posts').select('*').order('created_at', { ascending: false }).limit(100),
        supabase.from('social_topics').select('*').order('sort'),
        supabase.from('crm_projects').select('id, name, deck_assets').order('name'),
      ])
      setPosts((ps as unknown as SocialPost[]) ?? [])
      const tps = (ts as unknown as Topic[]) ?? []
      setTopics(tps)
      setNewTopic(cur => cur || tps[0]?.key || '')
      setProjects((prs as unknown as ProjectOpt[]) ?? [])
      // Newsletter für den Redaktionsplan: Datum = frühester (geplanter) Versand.
      const { data: camps } = await supabase.from('newsletter_campaigns').select('id, title, status, created_at').order('created_at', { ascending: false }).limit(20)
      const cs = (camps as unknown as Array<{ id: string; title: string; status: string; created_at: string }>) ?? []
      let nl: NlEntry[] = cs.map(c => ({ id: c.id, title: c.title, status: c.status, date: c.status === 'draft' ? null : c.created_at }))
      if (cs.length) {
        const { data: sm } = await supabase.from('scheduled_messages').select('campaign_id, scheduled_at').in('campaign_id', cs.map(c => c.id)).order('scheduled_at', { ascending: true }).limit(1000)
        const firstByCamp = new Map<string, string>()
        for (const m of (sm as Array<{ campaign_id: string; scheduled_at: string }> | null) ?? []) {
          if (m.campaign_id && !firstByCamp.has(m.campaign_id)) firstByCamp.set(m.campaign_id, m.scheduled_at)
        }
        nl = nl.map(n => ({ ...n, date: firstByCamp.get(n.id) ?? n.date }))
      }
      setNewsletters(nl.filter(n => n.date))
    } catch (err) {
      console.error('[SocialStudio] fetchAll:', err)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void fetchAll() }, [fetchAll])

  const createPost = async () => {
    setBusyKey('new')
    try {
      const tp = topics.find(x => x.key === newTopic)
      const { data, error } = await supabase.from('social_posts').insert({
        topic: newTopic, title: `${tp?.icon ?? ''} ${tp?.label ?? ''} · ${new Date().toLocaleDateString('de-DE')}`,
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

  const addTopic = async () => {
    const label = newTopicLabel.trim()
    if (!label) return
    const key = label.toLowerCase().replace(/[äöüß]/g, c => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[c] ?? c)).replace(/[^a-z0-9]+/g, '_').slice(0, 30)
    const { error } = await supabase.from('social_topics').insert({ key, label, icon: newTopicIcon.trim() || '✨', sort: 90 })
    if (error) { showToast(`❌ ${error.message}`); return }
    setNewTopicLabel('')
    void fetchAll()
  }

  const deleteTopic = async (tp: Topic) => {
    if (!window.confirm(t('crm.social.topicDeleteConfirm', 'Kategorie „{{l}}" löschen? Bestehende Posts bleiben erhalten.', { l: tp.label }) as string)) return
    const { error } = await supabase.from('social_topics').delete().eq('key', tp.key)
    if (error) { showToast(`❌ ${error.message}`); return }
    void fetchAll()
  }

  // Redaktionsplan: „+" am Tag → Post direkt für diesen Tag (10:00) anlegen.
  const createForDay = async (day: Date) => {
    try {
      const tp = topics[0]
      const when = new Date(day); when.setHours(10, 0, 0, 0)
      const { data, error } = await supabase.from('social_posts').insert({
        topic: tp?.key ?? 'sonstiges',
        title: `${tp?.icon ?? ''} ${tp?.label ?? ''} · ${day.toLocaleDateString('de-DE')}`,
        platforms: ['facebook', 'instagram'], status: 'entwurf', scheduled_for: when.toISOString(),
        created_by: profile?.id ?? null,
      }).select('*').single()
      if (error) throw error
      await fetchAll()
      setOpenPost(data as unknown as SocialPost)
    } catch (err) { console.error('[SocialStudio] createForDay:', err); showToast('❌ Konnte den Post nicht anlegen') }
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
  const queued = posts.filter(p => p.status === 'geplant').length

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg max-w-md">{toast}</div>}
      <div className="p-6 space-y-5 max-w-5xl">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('crm.social.title', 'Social Media')}</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {t('crm.social.subtitle', 'Organische Posts für Facebook, Instagram & LinkedIn — mit KI-Chat, Bildern und News-Recherche.')}
              {queued > 0 && <> · <b>{t('crm.social.queueInfo', '{{n}} in der Tages-Warteschlange', { n: queued })}</b></>}
            </p>
          </div>
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
            {([['plan', t('crm.social.viewPlan', '📅 Redaktionsplan')], ['list', t('crm.social.viewList', '📋 Posts')]] as const).map(([k, lbl]) => (
              <button key={k} onClick={() => setView(k)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium ${view === k ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}>{lbl}</button>
            ))}
          </div>
          <button onClick={() => void runNewsScan()} disabled={busyKey === 'news'}
            className="px-3 py-1.5 rounded-xl text-sm font-medium border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
            {busyKey === 'news' ? t('crm.social.newsWorking', 'Recherchiert (~1 Min)…') : t('crm.social.newsBtn', '📰 News jetzt recherchieren')}
          </button>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
          <div className="flex items-end gap-2 flex-wrap">
            <div className="min-w-[240px]">
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.social.newPostTopic', 'Neuen Post starten')}</label>
              <CustomSelect value={newTopic} onChange={setNewTopic}
                options={topics.map(x => ({ value: x.key, label: `${x.icon} ${x.label}` }))} />
            </div>
            <button onClick={() => void createPost()} disabled={busyKey === 'new' || !newTopic}
              className="px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
              {busyKey === 'new' ? t('common.saving', 'lädt …') : t('crm.social.newPostBtn', '+ Post')}
            </button>
            <button onClick={() => setManageTopics(m => !m)} className="px-3 py-2 rounded-xl text-sm border border-gray-200 text-gray-600 hover:bg-gray-50">
              ⚙️ {t('crm.social.manageTopics', 'Kategorien')} {manageTopics ? '▴' : '▾'}
            </button>
          </div>
          {manageTopics && (
            <div className="border-t border-gray-100 pt-3 space-y-2">
              <div className="flex gap-1.5 flex-wrap">
                {topics.map(tp => (
                  <span key={tp.key} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-100 text-sm text-gray-700">
                    {tp.icon} {tp.label}
                    <button onClick={() => void deleteTopic(tp)} className="text-gray-400 hover:text-red-600">×</button>
                  </span>
                ))}
              </div>
              <div className="flex items-end gap-2 flex-wrap">
                <input value={newTopicIcon} onChange={e => setNewTopicIcon(e.target.value)} maxLength={4}
                  className="w-14 rounded-xl border border-gray-200 px-2 py-2 text-sm text-center" title="Emoji" />
                <input value={newTopicLabel} onChange={e => setNewTopicLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addTopic() }}
                  placeholder={t('crm.social.newTopicPh', 'Neue Kategorie, z. B. „Kundenstimmen"')}
                  className="flex-1 min-w-[200px] rounded-xl border border-gray-200 px-3 py-2 text-sm" />
                <button onClick={() => void addTopic()} disabled={!newTopicLabel.trim()}
                  className="px-3 py-2 rounded-xl text-sm border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                  + {t('crm.social.addTopic', 'Hinzufügen')}
                </button>
              </div>
            </div>
          )}
        </div>

        {!loading && view === 'plan' && (
          <PlanCalendar posts={posts} newsletters={newsletters} topics={topics}
            onOpenPost={p => setOpenPost(p)} onCreateForDay={d => void createForDay(d)} />
        )}

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : view === 'plan' ? null : posts.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-sm text-gray-500">{t('crm.social.empty', 'Noch keine Posts — starte oben deinen ersten.')}</div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {posts.map(p => {
              const tp = topics.find(x => x.key === p.topic)
              const st = STATUS_BADGE[p.status] ?? STATUS_BADGE.entwurf
              const nImgs = (Array.isArray(p.image_urls) && p.image_urls.length) || (p.image_url ? 1 : 0)
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
                        <span className="text-[11px] text-gray-400">{p.platforms.join(' · ')}{p.format === 'carousel' ? ` · 🎠 ${nImgs}` : ''}</span>
                      </div>
                      <p className="text-sm font-medium text-gray-800 mt-1 truncate">{p.title ?? tp?.label}</p>
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
      {openPost && <PostEditor post={openPost} topics={topics} projects={projects} onClose={() => { setOpenPost(null); void fetchAll() }} />}
    </DashboardLayout>
  )
}
