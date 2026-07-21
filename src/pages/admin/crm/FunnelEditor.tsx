import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import FunnelIcon, { OptionVisual } from '../../../components/FunnelIcon'
import {
  loadFunnelConfig, normalizeFunnelConfig, FUNNEL_ICONS, FUNNEL_HERO_DEFAULT,
  buildFunnelLinkUrl, type FunnelConfig, type FunnelOption, type FunnelLink,
} from '../../../lib/funnelConfig'
import { CHANNEL_BADGES, channelBadgeFor } from '../../../lib/crmTypes'

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

// Vorschau, wie die Quelle als Badge in der Pipeline-Kachel erscheint.
function SourcePreview({ source }: { source: string }) {
  const b = channelBadgeFor(source)
  if (!b) return <span className="text-xs text-gray-400 italic">— (Werbe-Quelle des Leads)</span>
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap" style={b.badge}>
      {b.icon} {b.label}
    </span>
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

  // ── Fragebogen-Varianten: '' = Standard, sonst Slug aus cfg.questionnaires ──
  // Alle Fragen-Operationen laufen über getQs/setQs und wirken damit auf den
  // gerade aktiven Fragebogen.
  const [activeQn, setActiveQn] = useState('')
  const getQs = useCallback((c: FunnelConfig) =>
    activeQn ? (c.questionnaires.find(x => x.slug === activeQn)?.questions ?? []) : c.questions, [activeQn])
  const setQs = useCallback((c: FunnelConfig, qs: FunnelConfig['questions']): FunnelConfig =>
    activeQn
      ? { ...c, questionnaires: c.questionnaires.map(x => x.slug === activeQn ? { ...x, questions: qs } : x) }
      : { ...c, questions: qs }, [activeQn])

  const save = async () => {
    if (!cfg) return
    const invalid = (qs: FunnelConfig['questions']) => qs.find(q => !q.title.trim() || q.options.length < 2 || q.options.some(o => !o.label.trim()))
    if (cfg.questions.length === 0) {
      // Sonst wuerde normalizeFunnelConfig still die Default-Fragen reanimieren.
      showToast(t('crm.funnelEditor.mainEmpty', 'Der Standard-Fragebogen braucht mindestens 1 Frage. Für „ohne Fragebogen" nutze den Link „Nur Termin" unten.') as string)
      return
    }
    const badMain = invalid(cfg.questions)
    // Leere Varianten sind erlaubt (frisch angelegt) — nur halbfertige Fragen nicht.
    const badQn = cfg.questionnaires.find(x => invalid(x.questions))
    if (badMain || badQn) {
      showToast(badQn
        ? (t('crm.funnelEditor.invalidQn', 'Fragebogen „{{name}}": jede Frage braucht Titel + mindestens 2 ausgefüllte Antworten.', { name: badQn.name }) as string)
        : (t('crm.funnelEditor.invalid', 'Jede Frage braucht einen Titel und mindestens 2 ausgefüllte Antworten.') as string))
      return
    }
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
    const qs = [...getQs(c)]
    const to = idx + dir
    if (to < 0 || to >= qs.length) return c
    ;[qs[idx], qs[to]] = [qs[to], qs[idx]]
    return setQs(c, qs)
  })

  const addQuestion = () => update(c => {
    const qs = getQs(c)
    const taken = new Set(qs.map(q => q.key))
    return setQs(c, [...qs, {
      key: slugify(`frage ${qs.length + 1}`, taken),
      title: '',
      options: [{ key: 'a', label: '' }, { key: 'b', label: '' }],
    }])
  })

  // Neuer Fragebogen: startet leer. Im Anlege-Fenster lassen sich einzelne Fragen
  // aus einem bestehenden Fragebogen übernehmen (Kopie — danach unabhängig).
  const [qnDraft, setQnDraft] = useState<{ name: string; from: string; picked: string[] } | null>(null)
  const qnSourceQuestions = useCallback((c: FunnelConfig, from: string) =>
    from ? (c.questionnaires.find(x => x.slug === from)?.questions ?? []) : c.questions, [])

  const createQuestionnaire = () => {
    if (!cfg || !qnDraft) return
    const name = qnDraft.name.trim()
    if (!name) { showToast(t('crm.funnelEditor.qnNeedsName', 'Bitte gib dem Fragebogen einen Namen.') as string); return }
    const taken = new Set(['none', ...cfg.questionnaires.map(x => x.slug)])
    const slug = slugify(name, taken)
    const questions = qnSourceQuestions(cfg, qnDraft.from)
      .filter(q => qnDraft.picked.includes(q.key))
      .map(q => ({ ...q, options: q.options.map(o => ({ ...o })) }))
    update(c => ({ ...c, questionnaires: [...c.questionnaires, { slug, name, questions }] }))
    setActiveQn(slug)
    setQnDraft(null)
  }
  const renameQuestionnaire = () => {
    if (!cfg || !activeQn) return
    const cur = cfg.questionnaires.find(x => x.slug === activeQn)
    const name = (window.prompt(t('crm.funnelEditor.qnRenamePrompt', 'Neuer Name:') as string, cur?.name ?? '') ?? '').trim()
    if (!name) return
    update(c => ({ ...c, questionnaires: c.questionnaires.map(x => x.slug === activeQn ? { ...x, name } : x) }))
  }
  const removeQuestionnaire = () => {
    if (!activeQn) return
    if (!confirm(t('crm.funnelEditor.qnDeleteConfirm', 'Diesen Fragebogen löschen? Links darauf zeigen danach den Standard-Fragebogen.') as string)) return
    update(c => ({ ...c, questionnaires: c.questionnaires.filter(x => x.slug !== activeQn) }))
    setActiveQn('')
  }
  const copyLink = (url: string) => {
    void navigator.clipboard.writeText(url).then(() => showToast(t('crm.funnelEditor.linkCopied', '✓ Link kopiert') as string))
  }

  // ── Kampagnen-/Quellen-Links ───────────────────────────────────────────────
  // dest bestimmt das Ziel (Fragebogen vs. Kalender); questionnaire (bei Fragebogen)
  // bzw. calMode (bei Kalender) ist die zweite Ebene und wird beim Anlegen auf das
  // gespeicherte FunnelLink.questionnaire ('standard'|<slug>|'buchen'|'direkt') gemappt.
  const [linkForm, setLinkForm] = useState({ name: '', source: 'youtube', sourceCustom: '', dest: 'fragebogen', questionnaire: 'standard', calMode: 'buchen' })
  const resetLinkForm = () => setLinkForm({ name: '', source: 'youtube', sourceCustom: '', dest: 'fragebogen', questionnaire: 'standard', calMode: 'buchen' })
  const formQn = () => linkForm.dest === 'kalender' ? linkForm.calMode : linkForm.questionnaire
  const formSource = () => (linkForm.source === 'custom' ? linkForm.sourceCustom : linkForm.source).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
  const addLink = () => {
    if (!cfg) return
    const name = linkForm.name.trim()
    if (!name) { showToast(t('crm.funnelEditor.linkNeedsName', 'Bitte gib dem Link einen Namen.') as string); return }
    const source = formSource()
    const customLabel = linkForm.source === 'custom' ? linkForm.sourceCustom.trim() : ''
    const taken = new Set((cfg.links ?? []).map(l => l.code))
    const code = slugify(name, taken)
    update(c => {
      // Über „Neue Quelle …" getippte Quelle dauerhaft in die Quellenliste aufnehmen,
      // damit sie künftig im Dropdown steht.
      let sources = c.sources ?? []
      if (source && customLabel && !CHANNEL_BADGES[source] && !sources.some(s => s.key === source)) {
        sources = [...sources, { key: source, label: customLabel }]
      }
      return { ...c, sources, links: [...(c.links ?? []), { code, name, source, questionnaire: formQn(), created_at: new Date().toISOString() }] }
    })
    resetLinkForm()
  }
  const removeLink = (code: string) => update(c => ({ ...c, links: (c.links ?? []).filter(l => l.code !== code) }))

  // ── Bestehenden Link bearbeiten ─────────────────────────────────────────────
  // Der Code bleibt FEST: er ist die Identität des Links, steckt als utm_campaign in
  // bereits veröffentlichten URLs (Insta-Bio, YouTube-Beschreibung) und ist der Anker
  // der Statistik. Änderbar sind Name, Quelle und Ziel/Fragebogen — die URL bleibt
  // dabei gleich, nur wohin sie führt ändert sich.
  const [editCode, setEditCode] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: '', source: '', sourceCustom: '', dest: 'fragebogen', questionnaire: 'standard', calMode: 'buchen' })
  const startEdit = (l: FunnelLink) => {
    const isCal = l.questionnaire === 'buchen' || l.questionnaire === 'direkt'
    setEditForm({
      name: l.name,
      source: l.source,
      sourceCustom: '',
      dest: isCal ? 'kalender' : 'fragebogen',
      questionnaire: isCal ? 'standard' : (l.questionnaire || 'standard'),
      calMode: isCal ? l.questionnaire : 'buchen',
    })
    setEditCode(l.code)
  }
  const saveEdit = () => {
    if (!cfg || !editCode) return
    const name = editForm.name.trim()
    if (!name) { showToast(t('crm.funnelEditor.linkNeedsName', 'Bitte gib dem Link einen Namen.') as string); return }
    const source = (editForm.source === 'custom' ? editForm.sourceCustom : editForm.source).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const customLabel = editForm.source === 'custom' ? editForm.sourceCustom.trim() : ''
    const qn = editForm.dest === 'kalender' ? editForm.calMode : editForm.questionnaire
    update(c => {
      let sources = c.sources ?? []
      if (source && customLabel && !CHANNEL_BADGES[source] && !sources.some(s => s.key === source)) {
        sources = [...sources, { key: source, label: customLabel }]
      }
      return { ...c, sources, links: (c.links ?? []).map(l => l.code === editCode ? { ...l, name, source, questionnaire: qn } : l) }
    })
    setEditCode(null)
  }

  // ── Leadquellen (Kategorien) verwalten ──────────────────────────────────────
  const [newSourceName, setNewSourceName] = useState('')
  const addSource = () => {
    if (!cfg) return
    const label = newSourceName.trim()
    if (!label) return
    const taken = new Set([...Object.keys(CHANNEL_BADGES), ...(cfg.sources ?? []).map(s => s.key)])
    const key = slugify(label, taken)
    update(c => (c.sources ?? []).some(s => s.key === key)
      ? c
      : { ...c, sources: [...(c.sources ?? []), { key, label }] })
    setNewSourceName('')
  }
  const removeSource = (key: string) => {
    const used = (cfg?.links ?? []).filter(l => l.source === key).length
    if (used && !confirm(t('crm.funnelEditor.sourceInUse', 'Diese Quelle wird von {{n}} Link(s) genutzt. Trotzdem löschen? Die Links bleiben bestehen, zeigen die Quelle dann nur noch als einfachen Namen.', { n: used }) as string)) return
    update(c => ({ ...c, sources: (c.sources ?? []).filter(s => s.key !== key) }))
  }
  // Klartext-Bezeichnung des Ziel-/Fragebogen-Modus eines Links
  const qnLabel = (mode: string): string => {
    if (mode === 'standard') return t('crm.funnelEditor.qnStandard', 'Standard-Fragebogen') as string
    if (mode === 'none') return t('crm.funnelEditor.linkNone', 'Nur Termin (ohne Fragebogen)') as string
    if (mode === 'buchen') return t('crm.funnelEditor.qnBuchenShort', 'Kalender · mit Kontaktabfrage') as string
    if (mode === 'direkt') return t('crm.funnelEditor.qnDirektShort', 'Kalender · ohne Kontaktabfrage') as string
    return t('crm.funnelEditor.qnPrefix', 'Fragebogen: ') + (cfg?.questionnaires.find(x => x.slug === mode)?.name ?? mode)
  }

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

          {/* Fragebogen-Auswahl: Standard + Varianten + Neu/Umbenennen/Löschen */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <button onClick={() => setActiveQn('')}
              className="px-3 py-1.5 rounded-full text-xs font-semibold border-2 transition"
              style={activeQn === '' ? { background: '#ff795d', color: '#fff', borderColor: '#ff795d' } : { background: '#fff', color: '#374151', borderColor: '#e5e7eb' }}>
              {t('crm.funnelEditor.qnDefault', 'Standard')}
            </button>
            {cfg.questionnaires.map(x => (
              <button key={x.slug} onClick={() => setActiveQn(x.slug)}
                className="px-3 py-1.5 rounded-full text-xs font-semibold border-2 transition"
                style={activeQn === x.slug ? { background: '#ff795d', color: '#fff', borderColor: '#ff795d' } : { background: '#fff', color: '#374151', borderColor: '#e5e7eb' }}>
                {x.name}
              </button>
            ))}
            <button onClick={() => setQnDraft({ name: '', from: '', picked: [] })}
              className="px-3 py-1.5 rounded-full text-xs font-semibold border-2 border-dashed border-gray-300 text-gray-500 hover:border-gray-400 hover:text-gray-700 transition">
              {t('crm.funnelEditor.qnAdd', '+ Neuer Fragebogen')}
            </button>
            {activeQn && (
              <span className="flex items-center gap-1 ml-1">
                <button onClick={renameQuestionnaire} title={t('crm.funnelEditor.qnRename', 'Umbenennen') as string}
                  className="w-7 h-7 rounded-lg text-gray-400 hover:bg-gray-100">✏️</button>
                <button onClick={removeQuestionnaire} title={t('crm.funnelEditor.qnDelete', 'Fragebogen löschen') as string}
                  className="w-7 h-7 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">🗑</button>
              </span>
            )}
          </div>
          {activeQn && getQs(cfg).length === 0 && (
            <div className="mb-4 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5">
              {t('crm.funnelEditor.qnEmpty', 'Dieser Fragebogen ist noch leer. Lege oben rechts Fragen an — solange er leer bleibt, zeigt sein Link nur den Termin-Teil.')}
            </div>
          )}
          <div className="space-y-4">
            {getQs(cfg).map((q, qi) => (
              <div key={q.key} className="border border-gray-200 rounded-xl p-4">
                <div className="flex flex-wrap items-start gap-2">
                  <span className="mt-2 shrink-0 w-7 h-7 rounded-full text-white text-xs font-bold flex items-center justify-center" style={{ backgroundColor: '#ff795d' }}>{qi + 1}</span>
                  <div className="flex-1 min-w-[220px] space-y-2">
                    <input value={q.title} onChange={e => update(c => { const qs = [...getQs(c)]; qs[qi] = { ...q, title: e.target.value }; return setQs(c, qs) })}
                      placeholder={t('crm.funnelEditor.questionTitle', 'Frage-Text')}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
                    <input value={q.sub ?? ''} onChange={e => update(c => { const qs = [...getQs(c)]; qs[qi] = { ...q, sub: e.target.value || undefined }; return setQs(c, qs) })}
                      placeholder={t('crm.funnelEditor.questionSub', 'Untertitel (optional)')}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 mr-2 select-none">
                      <input type="checkbox" checked={!!q.tiles}
                        onChange={e => update(c => { const qs = [...getQs(c)]; qs[qi] = { ...q, tiles: e.target.checked }; return setQs(c, qs) })} />
                      {t('crm.funnelEditor.tiles', 'Kacheln mit Bild')}
                    </label>
                    <button onClick={() => moveQuestion(qi, -1)} disabled={qi === 0} className="w-7 h-7 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30">↑</button>
                    <button onClick={() => moveQuestion(qi, 1)} disabled={qi === getQs(cfg).length - 1} className="w-7 h-7 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30">↓</button>
                    <button onClick={() => { if (confirm(t('crm.funnelEditor.confirmDelete', 'Frage wirklich löschen?') as string)) update(c => setQs(c, getQs(c).filter((_, i) => i !== qi))) }}
                      className="w-7 h-7 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">🗑</button>
                  </div>
                </div>
                <div className="mt-3 space-y-2 pl-9">
                  {q.options.map((o, oi) => (
                    <OptionRow key={oi} opt={o} showVisual={!!q.tiles}
                      onChange={no => update(c => {
                        const qs = [...getQs(c)]
                        const os = [...q.options]; os[oi] = no
                        qs[qi] = { ...q, options: os }
                        return setQs(c, qs)
                      })}
                      onRemove={() => update(c => {
                        const qs = [...getQs(c)]
                        qs[qi] = { ...q, options: q.options.filter((_, i) => i !== oi) }
                        return setQs(c, qs)
                      })} />
                  ))}
                  <button onClick={() => update(c => {
                    const qs = [...getQs(c)]
                    const takenOpt = new Set(q.options.map(o => o.key))
                    let k = 'a'.charCodeAt(0)
                    while (takenOpt.has(String.fromCharCode(k))) k++
                    qs[qi] = { ...q, options: [...q.options, { key: String.fromCharCode(k), label: '' }] }
                    return setQs(c, qs)
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

          {/* Links je Fragebogen — inkl. „nur Termin" ganz ohne Fragen */}
          <div className="mt-4 border-t border-gray-100 pt-4">
            <p className="text-xs font-semibold text-gray-500 mb-2">{t('crm.funnelEditor.links', 'Links zum Teilen')}</p>
            <div className="space-y-1.5">
              {[
                { label: t('crm.funnelEditor.linkDefault', 'Standard-Fragebogen') as string, url: 'https://portal.happy-property.com/termin' },
                ...cfg.questionnaires.map(x => ({ label: x.name, url: `https://portal.happy-property.com/termin?f=${x.slug}` })),
                { label: t('crm.funnelEditor.linkNone', 'Nur Termin (ohne Fragebogen)') as string, url: 'https://portal.happy-property.com/termin?f=none' },
              ].map(l => (
                <div key={l.url} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="w-56 shrink-0 font-medium text-gray-600">{l.label}</span>
                  <code className="px-2 py-1 rounded bg-gray-50 border border-gray-100 text-gray-500 break-all">{l.url}</code>
                  <button onClick={() => copyLink(l.url)}
                    className="px-2 py-1 rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 font-medium">
                    {t('crm.funnelEditor.copy', 'Kopieren')}
                  </button>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">{t('crm.funnelEditor.linksHint', 'Der Newsletter hängt an seinen Termin-Button automatisch den persönlichen Direkteinstieg an (ohne Fragebogen UND ohne Kontaktformular) — dafür musst du hier nichts tun.')}</p>
          </div>
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

        {/* ── Links & Quellen ── */}
        <div className={card}>
          <h2 className="text-sm font-semibold text-gray-700">{t('crm.funnelEditor.linksTitle', '5 · Links & Quellen')}</h2>
          <p className="text-xs text-gray-500 mt-1 mb-4">
            {t('crm.funnelEditor.linksIntro', 'Lege pro Kanal oder Kampagne einen eigenen Link an. Wer darüber einen Termin bucht, bekommt automatisch die gewählte Quelle in der Pipeline-Kachel — und du kannst die Links später einzeln auswerten.')}
          </p>

          {/* Meine Leadquellen (Kategorien) — feste Kanäle + eigene */}
          <div className="mb-6">
            <p className="text-xs font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.sourcesTitle', 'Meine Leadquellen')}</p>
            <p className="text-[11px] text-gray-400 mb-2">{t('crm.funnelEditor.sourcesHint', 'Kategorien, die in der Pipeline-Kachel als Quelle erscheinen (z. B. „Steuerberater", „Affiliate"). Feste Kanäle wie YouTube sind schon da — eigene legst du hier an, danach stehen sie unten im Quellen-Dropdown.')}</p>
            <div className="flex flex-wrap gap-2 mb-2">
              {Object.keys(CHANNEL_BADGES).filter(k => k !== 'newsletter').map(k => (
                <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold" style={CHANNEL_BADGES[k].badge}>{CHANNEL_BADGES[k].icon} {CHANNEL_BADGES[k].label}</span>
              ))}
              {cfg.sources.map(s => (
                <span key={s.key} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                  🔗 {s.label}
                  <button type="button" onClick={() => removeSource(s.key)} className="w-4 h-4 rounded-full text-slate-400 hover:text-red-600 hover:bg-red-100 leading-none">×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={newSourceName} onChange={e => setNewSourceName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSource() } }}
                placeholder={t('crm.funnelEditor.sourceNamePh', 'Neue Quelle, z. B. Steuerberater') as string}
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
              <button type="button" onClick={addSource} className="px-4 py-2 rounded-lg text-sm font-semibold text-white shrink-0" style={{ backgroundColor: '#ff795d' }}>{t('crm.funnelEditor.sourceAdd', '+ Quelle')}</button>
            </div>
          </div>

          {/* Feste Einstiege (Referenz, nicht editierbar) */}
          <p className="text-xs font-semibold text-gray-500 mb-2">{t('crm.funnelEditor.linksBuiltin', 'Feste Einstiege')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs mb-6">
              <thead>
                <tr className="text-left text-gray-400">
                  <th className="font-medium py-1 pr-3">{t('crm.funnelEditor.linkColName', 'Was')}</th>
                  <th className="font-medium py-1 pr-3">{t('crm.funnelEditor.linkColSource', 'Quelle in der Kachel')}</th>
                  <th className="font-medium py-1">{t('crm.funnelEditor.linkColUrl', 'Link')}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: t('crm.funnelEditor.linkDefault', 'Standard-Fragebogen') as string, url: 'https://portal.happy-property.com/termin', source: '' },
                  { label: t('crm.funnelEditor.linkNone', 'Nur Termin (ohne Fragebogen)') as string, url: 'https://portal.happy-property.com/termin?f=none', source: '' },
                  { label: t('crm.funnelEditor.qnBuchen', 'Schnellbuchung (direkt Terminart)') as string, url: 'https://portal.happy-property.com/termin?buchen=1', source: '' },
                  { label: t('crm.funnelEditor.linkNewsletterAuto', 'Newsletter-Button (automatisch)') as string, url: '—', source: 'newsletter' },
                ].map(l => (
                  <tr key={l.label} className="border-t border-gray-100 align-middle">
                    <td className="py-2 pr-3 font-medium text-gray-600 whitespace-nowrap">{l.label}</td>
                    <td className="py-2 pr-3"><SourcePreview source={l.source} /></td>
                    <td className="py-2">
                      {l.url === '—'
                        ? <span className="text-gray-400">{t('crm.funnelEditor.linkAutoHint', 'wird je Empfänger erzeugt')}</span>
                        : <span className="inline-flex items-center gap-2">
                            <code className="px-2 py-1 rounded bg-gray-50 border border-gray-100 text-gray-500 break-all">{l.url}</code>
                            <button onClick={() => copyLink(l.url)} className="px-2 py-1 rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 font-medium shrink-0">{t('crm.funnelEditor.copy', 'Kopieren')}</button>
                          </span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Eigene Kampagnen-Links */}
          <p className="text-xs font-semibold text-gray-500 mb-2">{t('crm.funnelEditor.linksYours', 'Deine Kampagnen-Links')}</p>
          {cfg.links.length === 0 ? (
            <p className="text-xs text-gray-400 mb-4">{t('crm.funnelEditor.linksEmpty', 'Noch keine eigenen Links. Leg unten den ersten an — z. B. für deine YouTube-Videobeschreibung.')}</p>
          ) : (
            <div className="space-y-2 mb-4">
              {cfg.links.map(link => {
                const url = buildFunnelLinkUrl(link)
                return (
                  <div key={link.code} className="text-xs bg-gray-50 rounded-lg p-2.5 border border-gray-100">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-44 shrink-0 font-semibold text-gray-700 truncate">{link.name}</span>
                      <SourcePreview source={link.source} />
                      <span className="text-gray-400">{qnLabel(link.questionnaire)}</span>
                      <code className="px-2 py-1 rounded bg-white border border-gray-200 text-gray-500 break-all flex-1 min-w-[12rem]">{url}</code>
                      <button onClick={() => copyLink(url)} className="px-2 py-1 rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 font-medium">{t('crm.funnelEditor.copy', 'Kopieren')}</button>
                      <button onClick={() => editCode === link.code ? setEditCode(null) : startEdit(link)}
                        className="px-2 py-1 rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 font-medium">
                        {editCode === link.code ? t('crm.funnelEditor.linkEditClose', 'Schließen') : t('crm.funnelEditor.linkEdit', 'Bearbeiten')}
                      </button>
                      <button onClick={() => removeLink(link.code)} className="w-7 h-7 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">✕</button>
                    </div>

                    {editCode === link.code && (
                      <div className="mt-3 pt-3 border-t border-gray-200">
                        <div className="grid md:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.linkFormName', 'Name (nur für dich)')}</label>
                            <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.linkFormSource', 'Quelle (Badge in der Kachel)')}</label>
                            <select value={editForm.source} onChange={e => setEditForm(f => ({ ...f, source: e.target.value }))}
                              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40">
                              <optgroup label={t('crm.funnelEditor.sourceGroupChannels', 'Kanäle') as string}>
                                {Object.keys(CHANNEL_BADGES).filter(k => k !== 'newsletter').map(k => (
                                  <option key={k} value={k}>{CHANNEL_BADGES[k].icon} {CHANNEL_BADGES[k].label}</option>
                                ))}
                              </optgroup>
                              {cfg.sources.length > 0 && (
                                <optgroup label={t('crm.funnelEditor.sourceGroupMine', 'Meine Quellen') as string}>
                                  {cfg.sources.map(s => <option key={s.key} value={s.key}>🔗 {s.label}</option>)}
                                </optgroup>
                              )}
                              <option value="custom">{t('crm.funnelEditor.linkSourceNew', '➕ Neue Quelle …')}</option>
                            </select>
                            {editForm.source === 'custom' && (
                              <input value={editForm.sourceCustom} onChange={e => setEditForm(f => ({ ...f, sourceCustom: e.target.value }))}
                                placeholder={t('crm.funnelEditor.linkSourceNewPh', 'Name der neuen Quelle, z. B. Steuerberater') as string}
                                className="w-full mt-2 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
                            )}
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.linkDest', 'Wohin führt der Link?')}</label>
                            <select value={editForm.dest} onChange={e => setEditForm(f => ({ ...f, dest: e.target.value }))}
                              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40">
                              <option value="fragebogen">{t('crm.funnelEditor.destFragebogen', '📋 Zum Fragebogen')}</option>
                              <option value="kalender">{t('crm.funnelEditor.destKalender', '📅 Direkt zum Kalender')}</option>
                            </select>
                          </div>
                          <div>
                            {editForm.dest === 'fragebogen' ? (
                              <>
                                <label className="block text-[11px] font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.linkWhichForm', 'Welcher Fragebogen?')}</label>
                                <select value={editForm.questionnaire} onChange={e => setEditForm(f => ({ ...f, questionnaire: e.target.value }))}
                                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40">
                                  <option value="standard">{t('crm.funnelEditor.qnStandard', 'Standard-Fragebogen')}</option>
                                  {cfg.questionnaires.map(x => <option key={x.slug} value={x.slug}>{x.name}</option>)}
                                  <option value="none">{t('crm.funnelEditor.linkNone', 'Nur Termin (ohne Fragebogen)')}</option>
                                </select>
                              </>
                            ) : (
                              <>
                                <label className="block text-[11px] font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.linkContactMode', 'Kontaktdaten')}</label>
                                <select value={editForm.calMode} onChange={e => setEditForm(f => ({ ...f, calMode: e.target.value }))}
                                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40">
                                  <option value="buchen">{t('crm.funnelEditor.calWithContact', 'Mit Kontaktabfrage (öffentlicher Link)')}</option>
                                  <option value="direkt">{t('crm.funnelEditor.calNoContact', 'Ohne Kontaktabfrage (nur bekannte Empfänger)')}</option>
                                </select>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className="text-[11px] text-gray-500">
                            {editForm.dest === 'fragebogen'
                              ? t('crm.funnelEditor.linkEditStable', 'Der Link bleibt unverändert — du kannst den Fragebogen wechseln, ohne ihn neu zu verteilen.')
                              : t('crm.funnelEditor.linkEditChanges', 'Achtung: Beim Wechsel auf den Kalender ändert sich die URL — dieser Link muss neu verteilt werden.')}
                          </span>
                          <button onClick={saveEdit}
                            className="ml-auto px-4 py-2 rounded-lg text-sm font-semibold text-white" style={{ backgroundColor: '#ff795d' }}>
                            {t('crm.funnelEditor.linkEditApply', 'Übernehmen')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Neuen Link anlegen */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-xs font-semibold text-gray-500 mb-3">{t('crm.funnelEditor.linksNew', 'Neuen Link anlegen')}</p>
            <div className="grid md:grid-cols-2 gap-3">
              {/* Name */}
              <div>
                <label className="block text-[11px] font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.linkFormName', 'Name (nur für dich)')}</label>
                <input value={linkForm.name} onChange={e => setLinkForm(f => ({ ...f, name: e.target.value }))}
                  placeholder={t('crm.funnelEditor.linkFormNamePh', 'z. B. YouTube Videobeschreibung') as string}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
              </div>
              {/* Quelle */}
              <div>
                <label className="block text-[11px] font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.linkFormSource', 'Quelle (Badge in der Kachel)')}</label>
                <select value={linkForm.source} onChange={e => setLinkForm(f => ({ ...f, source: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40">
                  <optgroup label={t('crm.funnelEditor.sourceGroupChannels', 'Kanäle') as string}>
                    {Object.keys(CHANNEL_BADGES).filter(k => k !== 'newsletter').map(k => (
                      <option key={k} value={k}>{CHANNEL_BADGES[k].icon} {CHANNEL_BADGES[k].label}</option>
                    ))}
                  </optgroup>
                  {cfg.sources.length > 0 && (
                    <optgroup label={t('crm.funnelEditor.sourceGroupMine', 'Meine Quellen') as string}>
                      {cfg.sources.map(s => <option key={s.key} value={s.key}>🔗 {s.label}</option>)}
                    </optgroup>
                  )}
                  <option value="custom">{t('crm.funnelEditor.linkSourceNew', '➕ Neue Quelle …')}</option>
                </select>
                {linkForm.source === 'custom' && (
                  <input value={linkForm.sourceCustom} onChange={e => setLinkForm(f => ({ ...f, sourceCustom: e.target.value }))}
                    placeholder={t('crm.funnelEditor.linkSourceNewPh', 'Name der neuen Quelle, z. B. Steuerberater') as string}
                    className="w-full mt-2 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40" />
                )}
              </div>
              {/* Ziel: Fragebogen vs. Kalender */}
              <div>
                <label className="block text-[11px] font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.linkDest', 'Wohin führt der Link?')}</label>
                <select value={linkForm.dest} onChange={e => setLinkForm(f => ({ ...f, dest: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40">
                  <option value="fragebogen">{t('crm.funnelEditor.destFragebogen', '📋 Zum Fragebogen')}</option>
                  <option value="kalender">{t('crm.funnelEditor.destKalender', '📅 Direkt zum Kalender')}</option>
                </select>
              </div>
              {/* Zweite Ebene */}
              <div>
                {linkForm.dest === 'fragebogen' ? (
                  <>
                    <label className="block text-[11px] font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.linkWhichForm', 'Welcher Fragebogen?')}</label>
                    <select value={linkForm.questionnaire} onChange={e => setLinkForm(f => ({ ...f, questionnaire: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40">
                      <option value="standard">{t('crm.funnelEditor.qnStandard', 'Standard-Fragebogen')}</option>
                      {cfg.questionnaires.map(x => <option key={x.slug} value={x.slug}>{x.name}</option>)}
                      <option value="none">{t('crm.funnelEditor.linkNone', 'Nur Termin (ohne Fragebogen)')}</option>
                    </select>
                  </>
                ) : (
                  <>
                    <label className="block text-[11px] font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.linkContactMode', 'Kontaktdaten')}</label>
                    <select value={linkForm.calMode} onChange={e => setLinkForm(f => ({ ...f, calMode: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40">
                      <option value="buchen">{t('crm.funnelEditor.calWithContact', 'Mit Kontaktabfrage (öffentlicher Link)')}</option>
                      <option value="direkt">{t('crm.funnelEditor.calNoContact', 'Ohne Kontaktabfrage (nur bekannte Empfänger)')}</option>
                    </select>
                  </>
                )}
              </div>
            </div>

            {/* Hinweis für „ohne Kontaktabfrage" */}
            {linkForm.dest === 'kalender' && linkForm.calMode === 'direkt' && (
              <div className="mt-3 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {t('crm.funnelEditor.calNoContactHint', 'Ohne Kontaktabfrage klappt nur, wenn wir den Empfänger kennen: häng pro Person „&d=<Deck-Token>" an den Link. Der Newsletter macht das automatisch. Klickt jemand ohne Token, fragt der Link einmalig die Kontaktdaten ab (aber nie den Fragebogen).')}
              </div>
            )}

            {/* Vorschau + Anlegen */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {linkForm.name.trim() && (
                <>
                  <span className="text-xs font-semibold text-gray-500">{t('crm.funnelEditor.linkPreview', 'Vorschau:')}</span>
                  <SourcePreview source={formSource()} />
                  <span className="text-xs text-gray-400">{qnLabel(formQn())}</span>
                  <code className="px-2 py-1 rounded bg-gray-50 border border-gray-100 break-all text-xs text-gray-500">
                    {buildFunnelLinkUrl({ code: slugify(linkForm.name.trim(), new Set(cfg.links.map(l => l.code))), source: formSource(), questionnaire: formQn() })}
                  </code>
                </>
              )}
              <button onClick={addLink}
                className="ml-auto px-4 py-2 rounded-lg text-sm font-semibold text-white" style={{ backgroundColor: '#ff795d' }}>
                {t('crm.funnelEditor.linkAdd', '+ Link anlegen')}
              </button>
            </div>
            <p className="text-[11px] text-gray-400 mt-3">{t('crm.funnelEditor.linksStatHint', 'Jeder Link trägt einen eindeutigen Code (utm_campaign) — damit lassen sich die Links später in der Statistik einzeln auswerten. Speichern nicht vergessen.')}</p>
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

        {/* ── Neuer Fragebogen: Name + optionale Übernahme einzelner Fragen ── */}
        {qnDraft && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center p-0 md:p-4" onClick={() => setQnDraft(null)}>
            <div className="bg-white rounded-t-2xl md:rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-xl" onClick={e => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-800">{t('crm.funnelEditor.qnNewTitle', 'Neuer Fragebogen')}</h3>
                <p className="text-[11px] text-gray-400 mt-0.5">{t('crm.funnelEditor.qnNewHint', 'Der Fragebogen startet leer. Du kannst hier einzelne Fragen aus einem bestehenden Fragebogen übernehmen — Kopien, die du danach frei bearbeitest.')}</p>
              </div>

              <div className="px-5 py-4 space-y-4 overflow-y-auto">
                <Field label={t('crm.funnelEditor.qnNewName', 'Name (z. B. „Ärzte-Kampagne“)') as string}
                  value={qnDraft.name} onChange={v => setQnDraft({ ...qnDraft, name: v })} />

                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">{t('crm.funnelEditor.qnCopyFrom', 'Fragen übernehmen aus')}</label>
                  <select value={qnDraft.from} onChange={e => setQnDraft({ ...qnDraft, from: e.target.value, picked: [] })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40">
                    <option value="">{t('crm.funnelEditor.qnDefault', 'Standard')}</option>
                    {cfg.questionnaires.map(x => <option key={x.slug} value={x.slug}>{x.name}</option>)}
                  </select>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-gray-500">
                      {t('crm.funnelEditor.qnPickQuestions', 'Fragen zum Übernehmen ({{n}} ausgewählt)', { n: qnDraft.picked.length })}
                    </span>
                    <button
                      onClick={() => {
                        const all = qnSourceQuestions(cfg, qnDraft.from).map(q => q.key)
                        setQnDraft({ ...qnDraft, picked: qnDraft.picked.length === all.length ? [] : all })
                      }}
                      className="text-xs font-semibold text-gray-500 hover:text-gray-700">
                      {qnDraft.picked.length === qnSourceQuestions(cfg, qnDraft.from).length && qnDraft.picked.length > 0
                        ? t('crm.funnelEditor.qnPickNone', 'Keine')
                        : t('crm.funnelEditor.qnPickAll', 'Alle')}
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {qnSourceQuestions(cfg, qnDraft.from).map(q => (
                      <label key={q.key} className="flex items-start gap-2 p-2.5 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer">
                        <input type="checkbox" className="mt-0.5" checked={qnDraft.picked.includes(q.key)}
                          onChange={e => setQnDraft({
                            ...qnDraft,
                            picked: e.target.checked ? [...qnDraft.picked, q.key] : qnDraft.picked.filter(k => k !== q.key),
                          })} />
                        <span className="min-w-0">
                          <span className="block text-sm text-gray-700">{q.title || <em className="text-gray-400">{t('crm.funnelEditor.qnNoTitle', 'ohne Titel')}</em>}</span>
                          <span className="block text-[11px] text-gray-400 truncate">{q.options.map(o => o.label).filter(Boolean).join(' · ')}</span>
                        </span>
                      </label>
                    ))}
                    {qnSourceQuestions(cfg, qnDraft.from).length === 0 && (
                      <p className="text-xs text-gray-400 italic">{t('crm.funnelEditor.qnSourceEmpty', 'Dieser Fragebogen hat noch keine Fragen.')}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-end gap-2">
                <button onClick={() => setQnDraft(null)}
                  className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">
                  {t('crm.funnelEditor.cancel', 'Abbrechen')}
                </button>
                <button onClick={createQuestionnaire}
                  className="px-4 py-2 rounded-lg text-sm font-semibold text-white" style={{ backgroundColor: '#ff795d' }}>
                  {t('crm.funnelEditor.qnCreate', 'Fragebogen anlegen')}
                </button>
              </div>
            </div>
          </div>
        )}

        {toast && (
          <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg">{toast}</div>
        )}
      </div>
    </DashboardLayout>
  )
}
