import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import FunnelIcon, { OptionVisual } from '../../../components/FunnelIcon'
import {
  loadFunnelConfig, normalizeFunnelConfig, FUNNEL_ICONS, FUNNEL_HERO_DEFAULT,
  type FunnelConfig, type FunnelOption,
} from '../../../lib/funnelConfig'

// ── Funnel-Editor (/admin/crm/funnel-editor) ─────────────────────────────────
// Inhalte des öffentlichen Termin-Funnels (/termin) pflegen: Startseite, Fragen
// (anlegen/löschen/umordnen, Optionen mit Piktogramm/Emoji/Bild), Kontakt-Schritt,
// Danke-Seite. Zugriff: Rollen admin + funnel. Der Frage-Key bleibt nach dem
// Anlegen stabil — er ist der Anker fürs Tracking (funnel_events/Statistik).

const RESERVED_KEYS = new Set(['view', 'start', 'contact_view', 'contact_submitted', 'meeting_type', 'slots_view', 'slot_picked', 'booked'])

function slugify(title: string, taken: Set<string>): string {
  const base = title.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'frage'
  let key = base, i = 2
  while (taken.has(key) || RESERVED_KEYS.has(key)) key = `${base}-${i++}`
  return key
}

async function uploadImage(file: File): Promise<string | null> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const path = `funnel/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const { error } = await supabase.storage.from('deck-assets').upload(path, file, { cacheControl: '3600', upsert: false })
  if (error) { console.error('[FunnelEditor] Upload:', error.message); return null }
  return supabase.storage.from('deck-assets').getPublicUrl(path).data.publicUrl
}

// ── Options-Zeile ─────────────────────────────────────────────────────────────
interface OptionRowProps {
  opt: FunnelOption
  showVisual: boolean
  onChange: (o: FunnelOption) => void
  onRemove: () => void
}
function OptionRow({ opt, showVisual, onChange, onRemove }: OptionRowProps) {
  const { t } = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const pickImage = async (file: File) => {
    setUploading(true)
    const url = await uploadImage(file)
    setUploading(false)
    if (url) onChange({ ...opt, image_url: url, icon: undefined, emoji: undefined })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 bg-gray-50 rounded-lg p-2.5">
      {showVisual && (
        <div className="shrink-0 w-12 h-12 flex items-center justify-center overflow-hidden">
          <OptionVisual icon={opt.icon} emoji={opt.emoji} image_url={opt.image_url} />
        </div>
      )}
      <input value={opt.label} onChange={e => onChange({ ...opt, label: e.target.value })}
        placeholder={t('crm.funnelEditor.optionLabel', 'Antwort-Text')}
        className="flex-1 min-w-[160px] border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 bg-white" />
      {showVisual && (
        <>
          <select
            value={opt.image_url ? '__image' : opt.icon ? `icon:${opt.icon}` : opt.emoji ? '__emoji' : ''}
            onChange={e => {
              const v = e.target.value
              if (v.startsWith('icon:')) onChange({ ...opt, icon: v.slice(5), emoji: undefined, image_url: undefined })
              else if (v === '__emoji') onChange({ ...opt, icon: undefined, image_url: undefined, emoji: opt.emoji || '🏠' })
              else if (v === '__image') fileRef.current?.click()
              else onChange({ ...opt, icon: undefined, emoji: undefined, image_url: undefined })
            }}
            className="border border-gray-200 rounded-lg px-2 py-2 text-sm bg-white">
            <option value="">{t('crm.funnelEditor.visualNone', 'Ohne Bild')}</option>
            {FUNNEL_ICONS.map(i => <option key={i} value={`icon:${i}`}>{t('crm.funnelEditor.icon', 'Piktogramm')}: {i}</option>)}
            <option value="__emoji">{t('crm.funnelEditor.emoji', 'Emoji')}</option>
            <option value="__image">{uploading ? t('crm.funnelEditor.uploading', 'Lädt hoch…') : t('crm.funnelEditor.ownImage', 'Eigenes Bild…')}</option>
          </select>
          {opt.emoji !== undefined && !opt.icon && !opt.image_url && (
            <input value={opt.emoji} onChange={e => onChange({ ...opt, emoji: e.target.value.slice(0, 4) })}
              className="w-14 border border-gray-200 rounded-lg px-2 py-2 text-lg text-center bg-white" />
          )}
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void pickImage(f); e.target.value = '' }} />
        </>
      )}
      <button onClick={onRemove} title={t('crm.funnelEditor.removeOption', 'Antwort entfernen') as string}
        className="shrink-0 w-8 h-8 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors">✕</button>
    </div>
  )
}

// ── Eingabefeld mit Label ─────────────────────────────────────────────────────
function Field({ label, value, onChange, textarea }: { label: string; value: string; onChange: (v: string) => void; textarea?: boolean }) {
  const cls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40'
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 mb-1">{label}</label>
      {textarea
        ? <textarea value={value} onChange={e => onChange(e.target.value)} rows={2} className={cls} />
        : <input value={value} onChange={e => onChange(e.target.value)} className={cls} />}
    </div>
  )
}

export default function FunnelEditor() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const [cfg, setCfg] = useState<FunnelConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [toast, setToast] = useState('')
  const [heroUploading, setHeroUploading] = useState(false)
  const heroRef = useRef<HTMLInputElement>(null)
  const [doneImgUploading, setDoneImgUploading] = useState(false)
  const doneImgRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void loadFunnelConfig().then(c => { setCfg(c); setLoading(false) })
  }, [])

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3000) }
  const update = useCallback((fn: (c: FunnelConfig) => FunnelConfig) => {
    setCfg(prev => prev ? fn(prev) : prev)
    setDirty(true)
  }, [])

  const save = async () => {
    if (!cfg) return
    const bad = cfg.questions.find(q => !q.title.trim() || q.options.length < 2 || q.options.some(o => !o.label.trim()))
    if (bad) { showToast(t('crm.funnelEditor.invalid', 'Jede Frage braucht einen Titel und mindestens 2 ausgefüllte Antworten.')); return }
    setSaving(true)
    try {
      const clean = normalizeFunnelConfig(cfg)
      const { error } = await supabase.from('funnel_config').upsert({
        id: 'default', config: clean as unknown as Record<string, unknown>,
        updated_at: new Date().toISOString(), updated_by: profile?.id ?? null,
      })
      if (error) throw error
      setDirty(false)
      showToast(t('crm.funnelEditor.saved', '✓ Gespeichert — der Funnel ist sofort aktuell.'))
    } catch (err) {
      console.error('[FunnelEditor] save:', err)
      showToast(t('crm.funnelEditor.saveError', 'Speichern fehlgeschlagen — bitte noch einmal versuchen.'))
    } finally { setSaving(false) }
  }

  const moveQuestion = (idx: number, dir: -1 | 1) => update(c => {
    const qs = [...c.questions]
    const to = idx + dir
    if (to < 0 || to >= qs.length) return c
    ;[qs[idx], qs[to]] = [qs[to], qs[idx]]
    return { ...c, questions: qs }
  })

  const addQuestion = () => update(c => {
    const taken = new Set(c.questions.map(q => q.key))
    return {
      ...c,
      questions: [...c.questions, {
        key: slugify(`frage ${c.questions.length + 1}`, taken),
        title: '',
        options: [{ key: 'a', label: '' }, { key: 'b', label: '' }],
      }],
    }
  })

  const card = 'bg-white rounded-2xl shadow-sm border border-gray-100 p-5'

  if (loading || !cfg) {
    return (
      <DashboardLayout basePath="/admin/crm">
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="space-y-6 pb-24">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('crm.funnelEditor.title', 'Funnel-Editor')}</h1>
            <p className="text-sm text-gray-500 mt-1">{t('crm.funnelEditor.subtitle', 'Inhalte des Termin-Funnels (/termin) bearbeiten — Änderungen sind nach dem Speichern sofort live.')}</p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/termin" target="_blank" rel="noreferrer"
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors">
              {t('crm.funnelEditor.preview', '👁 Vorschau öffnen')}
            </a>
            <button onClick={() => void save()} disabled={saving || !dirty}
              className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-40"
              style={{ backgroundColor: '#ff795d' }}>
              {saving ? t('crm.funnelEditor.saving', 'Speichert…') : t('crm.funnelEditor.save', 'Speichern')}
            </button>
          </div>
        </div>

        {/* ── Startseite ── */}
        <div className={card}>
          <h2 className="text-sm font-semibold text-gray-700 mb-4">{t('crm.funnelEditor.welcome', '1 · Startseite')}</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <Field label={t('crm.funnelEditor.headline', 'Überschrift')} value={cfg.welcome.title} onChange={v => update(c => ({ ...c, welcome: { ...c.welcome, title: v } }))} />
              <Field label={t('crm.funnelEditor.subline', 'Untertitel')} textarea value={cfg.welcome.subtitle} onChange={v => update(c => ({ ...c, welcome: { ...c.welcome, subtitle: v } }))} />
              <Field label={t('crm.funnelEditor.buttonText', 'Button-Text')} value={cfg.welcome.cta} onChange={v => update(c => ({ ...c, welcome: { ...c.welcome, cta: v } }))} />
              <Field label={t('crm.funnelEditor.footnote', 'Fußnote')} value={cfg.welcome.footnote} onChange={v => update(c => ({ ...c, welcome: { ...c.welcome, footnote: v } }))} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.heroImage', 'Bild (Startseite)')}</label>
              <img src={cfg.welcome.hero_url || FUNNEL_HERO_DEFAULT} alt="" className="w-full h-40 object-cover rounded-xl border border-gray-100" />
              <div className="flex gap-2 mt-2">
                <button onClick={() => heroRef.current?.click()} disabled={heroUploading}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                  {heroUploading ? t('crm.funnelEditor.uploading', 'Lädt hoch…') : t('crm.funnelEditor.changeImage', '📷 Bild ändern')}
                </button>
                {cfg.welcome.hero_url && (
                  <button onClick={() => update(c => ({ ...c, welcome: { ...c.welcome, hero_url: '' } }))}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                    {t('crm.funnelEditor.resetImage', 'Standard (Sven-Foto)')}
                  </button>
                )}
              </div>
              <input ref={heroRef} type="file" accept="image/*" className="hidden"
                onChange={async e => {
                  const f = e.target.files?.[0]; e.target.value = ''
                  if (!f) return
                  setHeroUploading(true)
                  const url = await uploadImage(f)
                  setHeroUploading(false)
                  if (url) update(c => ({ ...c, welcome: { ...c.welcome, hero_url: url } }))
                  else showToast(t('crm.funnelEditor.uploadError', 'Upload fehlgeschlagen.'))
                }} />
            </div>
          </div>
        </div>

        {/* ── Fragen ── */}
        <div className={card}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-700">{t('crm.funnelEditor.questions', '2 · Fragen')}</h2>
            <button onClick={addQuestion}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white" style={{ backgroundColor: '#1a2332' }}>
              {t('crm.funnelEditor.addQuestion', '+ Frage hinzufügen')}
            </button>
          </div>
          <div className="space-y-4">
            {cfg.questions.map((q, qi) => (
              <div key={q.key} className="border border-gray-200 rounded-xl p-4">
                <div className="flex flex-wrap items-start gap-2">
                  <span className="mt-2 shrink-0 w-7 h-7 rounded-full text-white text-xs font-bold flex items-center justify-center" style={{ backgroundColor: '#ff795d' }}>{qi + 1}</span>
                  <div className="flex-1 min-w-[220px] space-y-2">
                    <input value={q.title} onChange={e => update(c => { const qs = [...c.questions]; qs[qi] = { ...q, title: e.target.value }; return { ...c, questions: qs } })}
                      placeholder={t('crm.funnelEditor.questionTitle', 'Frage-Text')}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
                    <input value={q.sub ?? ''} onChange={e => update(c => { const qs = [...c.questions]; qs[qi] = { ...q, sub: e.target.value || undefined }; return { ...c, questions: qs } })}
                      placeholder={t('crm.funnelEditor.questionSub', 'Untertitel (optional)')}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 mr-2 select-none">
                      <input type="checkbox" checked={!!q.tiles}
                        onChange={e => update(c => { const qs = [...c.questions]; qs[qi] = { ...q, tiles: e.target.checked }; return { ...c, questions: qs } })} />
                      {t('crm.funnelEditor.tiles', 'Kacheln mit Bild')}
                    </label>
                    <button onClick={() => moveQuestion(qi, -1)} disabled={qi === 0} className="w-7 h-7 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30">↑</button>
                    <button onClick={() => moveQuestion(qi, 1)} disabled={qi === cfg.questions.length - 1} className="w-7 h-7 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30">↓</button>
                    <button onClick={() => { if (confirm(t('crm.funnelEditor.confirmDelete', 'Frage wirklich löschen?') as string)) update(c => ({ ...c, questions: c.questions.filter((_, i) => i !== qi) })) }}
                      className="w-7 h-7 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">🗑</button>
                  </div>
                </div>
                <div className="mt-3 space-y-2 pl-9">
                  {q.options.map((o, oi) => (
                    <OptionRow key={oi} opt={o} showVisual={!!q.tiles}
                      onChange={no => update(c => {
                        const qs = [...c.questions]
                        const os = [...q.options]; os[oi] = no
                        qs[qi] = { ...q, options: os }
                        return { ...c, questions: qs }
                      })}
                      onRemove={() => update(c => {
                        const qs = [...c.questions]
                        qs[qi] = { ...q, options: q.options.filter((_, i) => i !== oi) }
                        return { ...c, questions: qs }
                      })} />
                  ))}
                  <button onClick={() => update(c => {
                    const qs = [...c.questions]
                    const takenOpt = new Set(q.options.map(o => o.key))
                    let k = 'a'.charCodeAt(0)
                    while (takenOpt.has(String.fromCharCode(k))) k++
                    qs[qi] = { ...q, options: [...q.options, { key: String.fromCharCode(k), label: '' }] }
                    return { ...c, questions: qs }
                  })}
                    className="text-xs font-medium text-gray-500 hover:text-gray-800 transition-colors">
                    {t('crm.funnelEditor.addOption', '+ Antwort hinzufügen')}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-3">
            {t('crm.funnelEditor.iconHint', 'Piktogramme: ')}
            <span className="inline-flex items-center gap-1 align-middle">
              {FUNNEL_ICONS.map(i => <FunnelIcon key={i} kind={i} className="w-5 h-5 inline-block" />)}
            </span>
            {' '}{t('crm.funnelEditor.iconHint2', '— laden ohne Wartezeit. Eigene Bilder bitte klein halten (unter 300 KB).')}
          </p>
        </div>

        {/* ── Kontakt-Schritt ── */}
        <div className={card}>
          <h2 className="text-sm font-semibold text-gray-700 mb-4">{t('crm.funnelEditor.contact', '3 · Kontaktdaten-Schritt')}</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <Field label={t('crm.funnelEditor.headline', 'Überschrift')} value={cfg.contact.title} onChange={v => update(c => ({ ...c, contact: { ...c.contact, title: v } }))} />
            <Field label={t('crm.funnelEditor.subline', 'Untertitel')} value={cfg.contact.subtitle} onChange={v => update(c => ({ ...c, contact: { ...c.contact, subtitle: v } }))} />
            <Field label={t('crm.funnelEditor.buttonText', 'Button-Text')} value={cfg.contact.cta} onChange={v => update(c => ({ ...c, contact: { ...c.contact, cta: v } }))} />
            <Field label={t('crm.funnelEditor.privacy', 'Datenschutz-Hinweis')} textarea value={cfg.contact.privacy} onChange={v => update(c => ({ ...c, contact: { ...c.contact, privacy: v } }))} />
          </div>
        </div>

        {/* ── Danke-Seite ── */}
        <div className={card}>
          <h2 className="text-sm font-semibold text-gray-700 mb-4">{t('crm.funnelEditor.done', '4 · Danke-Seite (nach Buchung)')}</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <Field label={t('crm.funnelEditor.headline', 'Überschrift')} value={cfg.done.title} onChange={v => update(c => ({ ...c, done: { ...c.done, title: v } }))} />
              <Field label={t('crm.funnelEditor.doneNote', 'Hinweistext (unter dem Termin)')} textarea value={cfg.done.note} onChange={v => update(c => ({ ...c, done: { ...c.done, note: v } }))} />
              <Field label={t('crm.funnelEditor.doneCta', 'Haupt-Button: Text')} value={cfg.done.cta} onChange={v => update(c => ({ ...c, done: { ...c.done, cta: v } }))} />
              <Field label={t('crm.funnelEditor.thanksUrl', 'Haupt-Button: Link (Tipps & Blog)')} value={cfg.done.thanks_url} onChange={v => update(c => ({ ...c, done: { ...c.done, thanks_url: v } }))} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.doneVisual', 'Symbol oben (Emoji oder Bild)')}</label>
              <div className="flex items-center gap-3">
                {cfg.done.image_url
                  ? <img src={cfg.done.image_url} alt="" className="w-16 h-16 object-cover rounded-full border border-gray-100" />
                  : <span className="text-4xl">{cfg.done.emoji || '🎉'}</span>}
                <div className="space-y-2">
                  {!cfg.done.image_url && (
                    <input value={cfg.done.emoji} onChange={e => update(c => ({ ...c, done: { ...c.done, emoji: e.target.value.slice(0, 4) } }))}
                      className="w-20 border border-gray-200 rounded-lg px-2 py-2 text-xl text-center" />
                  )}
                  <div className="flex gap-2">
                    <button onClick={() => doneImgRef.current?.click()} disabled={doneImgUploading}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                      {doneImgUploading ? t('crm.funnelEditor.uploading', 'Lädt hoch…') : t('crm.funnelEditor.changeImage', '📷 Bild ändern')}
                    </button>
                    {cfg.done.image_url && (
                      <button onClick={() => update(c => ({ ...c, done: { ...c.done, image_url: '' } }))}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                        {t('crm.funnelEditor.useEmoji', 'Emoji statt Bild')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <input ref={doneImgRef} type="file" accept="image/*" className="hidden"
                onChange={async e => {
                  const f = e.target.files?.[0]; e.target.value = ''
                  if (!f) return
                  setDoneImgUploading(true)
                  const url = await uploadImage(f)
                  setDoneImgUploading(false)
                  if (url) update(c => ({ ...c, done: { ...c.done, image_url: url } }))
                  else showToast(t('crm.funnelEditor.uploadError', 'Upload fehlgeschlagen.'))
                }} />

              <label className="block text-xs font-semibold text-gray-500 mt-5 mb-2">{t('crm.funnelEditor.socials', 'Kanal-Buttons (Icon · Name · Link)')}</label>
              <div className="space-y-2">
                {cfg.done.socials.map((s, si) => (
                  <div key={si} className="flex items-center gap-2 bg-gray-50 rounded-lg p-2">
                    <input value={s.icon} onChange={e => update(c => { const so = [...c.done.socials]; so[si] = { ...s, icon: e.target.value.slice(0, 3) }; return { ...c, done: { ...c.done, socials: so } } })}
                      className="w-11 border border-gray-200 rounded-lg px-1 py-1.5 text-center text-sm bg-white" />
                    <input value={s.label} onChange={e => update(c => { const so = [...c.done.socials]; so[si] = { ...s, label: e.target.value }; return { ...c, done: { ...c.done, socials: so } } })}
                      placeholder={t('crm.funnelEditor.socialLabel', 'Name') as string}
                      className="w-28 border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white" />
                    <input value={s.url} onChange={e => update(c => { const so = [...c.done.socials]; so[si] = { ...s, url: e.target.value }; return { ...c, done: { ...c.done, socials: so } } })}
                      placeholder="https://…"
                      className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white" />
                    <button onClick={() => update(c => ({ ...c, done: { ...c.done, socials: c.done.socials.filter((_, i) => i !== si) } }))}
                      className="shrink-0 w-7 h-7 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">✕</button>
                  </div>
                ))}
                <button onClick={() => update(c => ({ ...c, done: { ...c.done, socials: [...c.done.socials, { icon: '★', label: '', url: '' }] } }))}
                  className="text-xs font-medium text-gray-500 hover:text-gray-800 transition-colors">
                  {t('crm.funnelEditor.addSocial', '+ Kanal hinzufügen')}
                </button>
              </div>
            </div>
          </div>
        </div>

        {dirty && (
          <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-40 bg-white border border-gray-200 rounded-full shadow-lg px-4 py-2 flex items-center gap-3">
            <span className="text-sm text-gray-600">{t('crm.funnelEditor.unsaved', 'Ungespeicherte Änderungen')}</span>
            <button onClick={() => void save()} disabled={saving}
              className="px-4 py-1.5 rounded-full text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
              {saving ? t('crm.funnelEditor.saving', 'Speichert…') : t('crm.funnelEditor.save', 'Speichern')}
            </button>
          </div>
        )}

        {toast && (
          <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg">{toast}</div>
        )}
      </div>
    </DashboardLayout>
  )
}
