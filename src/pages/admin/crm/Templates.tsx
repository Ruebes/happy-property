import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { EmailTemplate } from '../../../lib/crmTypes'

const CATEGORIES = ['general', 'project', 'followup', 'noshow', 'lawyer', 'financing', 'portal'] as const
type Category = typeof CATEGORIES[number]

const LANGUAGES = ['de', 'en'] as const
type Language = typeof LANGUAGES[number]

interface FormState {
  name:      string
  subject:   string
  body:      string
  html_body: string
  category:  Category
  language:  Language
}

const DEFAULT_FORM: FormState = {
  name:      '',
  subject:   '',
  body:      '',
  html_body: '',
  category:  'general',
  language:  'de',
}

// Alle verfügbaren Platzhalter
const PLACEHOLDERS = [
  { key: '{{vorname}}',       label: 'Vorname' },
  { key: '{{nachname}}',      label: 'Nachname' },
  { key: '{{name}}',          label: 'Vollständiger Name' },
  { key: '{{email}}',         label: 'E-Mail' },
  { key: '{{telefon}}',       label: 'Telefon' },
  { key: '{{betreff}}',       label: 'Betreff' },
  { key: '{{projekt}}',       label: 'Projektname' },
  { key: '{{termin_datum}}',  label: 'Termindatum' },
  { key: '{{termin_link}}',   label: 'Zoom-Link' },
  { key: '{{berater}}',       label: 'Berater' },
  { key: '{{firma}}',         label: 'Firma (Happy Property)' },
  { key: '{{password}}',      label: 'Temporäres Passwort' },
  { key: '{{login_url}}',     label: 'Portal-Login-URL' },
]

export default function Templates() {
  const { t } = useTranslation()
  useAuth()

  const [templates, setTemplates]   = useState<EmailTemplate[]>([])
  const [loading, setLoading]       = useState(true)
  const [editingId, setEditingId]   = useState<string | null>(null)
  const [showForm, setShowForm]     = useState(false)
  const [form, setForm]             = useState<FormState>(DEFAULT_FORM)
  const [saving, setSaving]         = useState(false)
  const [toast, setToast]           = useState('')
  const [bodyTab, setBodyTab]       = useState<'text' | 'html'>('text')
  const [showPreview, setShowPreview] = useState(false)
  const [copiedKey, setCopiedKey]   = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('email_templates')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      setTemplates((data ?? []) as EmailTemplate[])
    } catch (err) {
      console.error('[Templates] fetchTemplates:', err)
      setTemplates([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  const openCreate = () => {
    setEditingId(null)
    setForm(DEFAULT_FORM)
    setBodyTab('text')
    setShowPreview(false)
    setShowForm(true)
  }

  const openEdit = (tpl: EmailTemplate) => {
    setEditingId(tpl.id)
    setForm({
      name:      tpl.name,
      subject:   tpl.subject,
      body:      tpl.body,
      html_body: tpl.html_body ?? '',
      category:  tpl.category,
      language:  tpl.language,
    })
    setBodyTab(tpl.html_body ? 'html' : 'text')
    setShowPreview(false)
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!form.name.trim() || !form.subject.trim() || !form.body.trim()) return
    setSaving(true)
    try {
      const payload = {
        name:      form.name.trim(),
        subject:   form.subject.trim(),
        body:      form.body.trim(),
        html_body: form.html_body.trim() || null,
        category:  form.category,
        language:  form.language,
      }
      if (editingId) {
        const { error } = await supabase.from('email_templates').update(payload).eq('id', editingId)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await supabase.from('email_templates').insert(payload)
        if (error) throw new Error(error.message)
      }
      await fetchTemplates()
      setShowForm(false)
      showToast('✅ ' + t(editingId ? 'crm.template.savedToast' : 'crm.template.createdToast'))
    } catch (err) {
      showToast(`❌ Fehler: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('crm.template.confirmDelete'))) return
    const { error } = await supabase.from('email_templates').delete().eq('id', id)
    if (error) { showToast(`❌ Fehler: ${error.message}`); return }
    await fetchTemplates()
    showToast(t('crm.template.deletedToast'))
  }

  const copyPlaceholder = (key: string) => {
    navigator.clipboard.writeText(key).catch(() => {})
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  // HTML-Vorschau: Platzhalter durch Beispielwerte ersetzen
  const previewHtml = (html: string) => html
    .replace(/\{\{vorname\}\}/g,      'Max')
    .replace(/\{\{nachname\}\}/g,     'Mustermann')
    .replace(/\{\{name\}\}/g,         'Max Mustermann')
    .replace(/\{\{email\}\}/g,        'max@beispiel.de')
    .replace(/\{\{telefon\}\}/g,      '+49 151 12345678')
    .replace(/\{\{betreff\}\}/g,      form.subject || 'Betreff')
    .replace(/\{\{projekt\}\}/g,      'Sunrise Residences')
    .replace(/\{\{termin_datum\}\}/g, '15. Juni 2026, 14:00 Uhr')
    .replace(/\{\{termin_link\}\}/g,  'https://zoom.us/j/123456')
    .replace(/\{\{berater\}\}/g,      'Sven Müller')
    .replace(/\{\{firma\}\}/g,        'Happy Property')
    .replace(/\{\{password\}\}/g,     'TempPass123!')
    .replace(/\{\{login_url\}\}/g,    'https://portal.happy-property.com/login')

  const categoryLabel: Record<Category, string> = {
    general:   'Allgemein',
    project:   'Projekt',
    followup:  'Follow-up',
    noshow:    'No-Show',
    lawyer:    'Anwalt',
    financing: 'Finanzierung',
    portal:    '🔑 Portal-Zugang',
  }

  const categoryColor: Record<Category, string> = {
    general:   'bg-gray-100 text-gray-600',
    project:   'bg-blue-100 text-blue-700',
    followup:  'bg-orange-100 text-orange-700',
    noshow:    'bg-red-100 text-red-700',
    lawyer:    'bg-purple-100 text-purple-700',
    financing: 'bg-green-100 text-green-700',
    portal:    'bg-yellow-100 text-yellow-700',
  }

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="p-6 space-y-6">
        {/* Toast */}
        {toast && (
          <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">
            {toast}
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">{t('crm.template.title', 'E-Mail Vorlagen')}</h1>
          <button
            onClick={openCreate}
            className="px-4 py-2 rounded-xl text-white text-sm font-medium"
            style={{ backgroundColor: '#ff795d' }}
          >
            {t('crm.template.new')}
          </button>
        </div>

        {/* Template list */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : templates.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-16">{t('crm.template.empty')}</p>
        ) : (
          <div className="grid gap-3">
            {templates.map(tpl => (
              <div key={tpl.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-semibold text-gray-900">{tpl.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${categoryColor[tpl.category]}`}>
                        {t(`crm.template.categories.${tpl.category}`)}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 uppercase">
                        {tpl.language}
                      </span>
                      {tpl.html_body && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">
                          HTML ✓
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-600 truncate">{tpl.subject}</p>
                    <p className="text-xs text-gray-400 mt-1 line-clamp-1">{tpl.body}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      onClick={() => openEdit(tpl)}
                      className="text-sm text-gray-500 hover:text-gray-800 font-medium"
                    >
                      {t('crm.template.edit')}
                    </button>
                    <button
                      onClick={() => handleDelete(tpl.id)}
                      className="text-sm text-red-500 hover:text-red-700 font-medium"
                    >
                      {t('crm.template.delete')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Form modal ──────────────────────────────────────────────────── */}
        {showForm && (
          <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-6 p-6 space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">
                {editingId ? t('crm.template.editTemplate') : t('crm.template.newTemplate')}
              </h2>

              <div className="space-y-4">
                {/* Name + Kategorie + Sprache in einer Zeile */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">{t('crm.template.name')} *</label>
                    <input
                      type="text"
                      value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                      placeholder={t('crm.template.namePlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{t('crm.template.category')}</label>
                    <select
                      value={form.category}
                      onChange={e => setForm(f => ({ ...f, category: e.target.value as Category }))}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white"
                    >
                      {CATEGORIES.map(c => (
                        <option key={c} value={c}>{t(`crm.template.categories.${c}`)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{t('crm.template.language')}</label>
                    <select
                      value={form.language}
                      onChange={e => setForm(f => ({ ...f, language: e.target.value as Language }))}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white"
                    >
                      <option value="de">Deutsch</option>
                      <option value="en">English</option>
                    </select>
                  </div>
                </div>

                {/* Betreff */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">{t('crm.template.subject')} *</label>
                  <input
                    type="text"
                    value={form.subject}
                    onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                    placeholder={t('crm.template.subjectPlaceholder')}
                  />
                </div>

                {/* Platzhalter-Referenz */}
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs font-semibold text-gray-500 mb-2">{t('crm.template.clickToCopy')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {PLACEHOLDERS.map(p => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => copyPlaceholder(p.key)}
                        title={p.label}
                        className={`text-xs px-2 py-1 rounded-lg border transition-all ${
                          copiedKey === p.key
                            ? 'bg-green-100 border-green-300 text-green-700'
                            : 'bg-white border-gray-200 text-gray-600 hover:border-orange-300 hover:text-orange-600'
                        }`}
                      >
                        {copiedKey === p.key ? t('crm.template.copied') : p.key}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Text / HTML Tabs */}
                <div>
                  <div className="flex gap-1 mb-2 border-b border-gray-200">
                    <button
                      type="button"
                      onClick={() => setBodyTab('text')}
                      className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                        bodyTab === 'text'
                          ? 'border-orange-500 text-orange-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {t('crm.template.textContent')} *
                    </button>
                    <button
                      type="button"
                      onClick={() => setBodyTab('html')}
                      className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
                        bodyTab === 'html'
                          ? 'border-orange-500 text-orange-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {t('crm.template.htmlTemplate')}
                      {form.html_body && (
                        <span className="w-2 h-2 rounded-full bg-indigo-500 inline-block" />
                      )}
                    </button>
                  </div>

                  {bodyTab === 'text' && (
                    <div>
                      <textarea
                        rows={7}
                        value={form.body}
                        onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 resize-y font-mono"
                        placeholder={t('crm.template.textPlaceholder')}
                      />
                      <p className="text-xs text-gray-400 mt-1">
                        {t('crm.template.textHint')}
                      </p>
                    </div>
                  )}

                  {bodyTab === 'html' && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-gray-500">
                          {t('crm.template.htmlHint')}
                        </p>
                        <button
                          type="button"
                          onClick={() => setShowPreview(!showPreview)}
                          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
                        >
                          {showPreview ? t('crm.template.closePreview') : t('crm.template.preview')}
                        </button>
                      </div>

                      <textarea
                        rows={10}
                        value={form.html_body}
                        onChange={e => setForm(f => ({ ...f, html_body: e.target.value }))}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-y font-mono"
                        placeholder={'<!DOCTYPE html>\n<html>\n<body>\n  <p>Hallo {{vorname}},</p>\n  …\n</body>\n</html>'}
                      />

                      {showPreview && form.html_body && (
                        <div className="border border-gray-200 rounded-xl overflow-hidden">
                          <div className="bg-gray-50 px-3 py-2 text-xs text-gray-500 border-b border-gray-200">
                            {t('crm.template.previewLabel')}
                          </div>
                          <iframe
                            srcDoc={previewHtml(form.html_body)}
                            className="w-full"
                            style={{ height: '400px', border: 'none' }}
                            sandbox="allow-same-origin"
                            title="E-Mail Vorschau"
                          />
                        </div>
                      )}

                      {!form.html_body && (
                        <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 text-sm text-indigo-700 space-y-2">
                          <p className="font-semibold">{t('crm.template.claudeTitle')}</p>
                          <p className="text-xs">{t('crm.template.claudeIntro')}</p>
                          <div className="bg-white border border-indigo-100 rounded-lg p-3 text-xs font-mono text-gray-700 select-all">
                            {`Erstelle ein professionelles HTML-E-Mail-Template für eine deutsche Immobilien-Investment-Firma (Happy Property, Zypern). Kategorie: ${categoryLabel[form.category]}. Farbe: #ff795d (Orange). Design: modern, seriös, responsiv. Betreff: "${form.subject || '[Betreff]'}". Nutze diese Platzhalter wo sinnvoll: {{vorname}}, {{name}}, {{termin_datum}}, {{berater}}, {{firma}}. Liefere nur den HTML-Code ohne Erklärungen.`}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const prompt = `Erstelle ein professionelles HTML-E-Mail-Template für eine deutsche Immobilien-Investment-Firma (Happy Property, Zypern). Kategorie: ${categoryLabel[form.category]}. Farbe: #ff795d (Orange). Design: modern, seriös, responsiv. Betreff: "${form.subject || '[Betreff]'}". Nutze diese Platzhalter wo sinnvoll: {{vorname}}, {{name}}, {{termin_datum}}, {{berater}}, {{firma}}. Liefere nur den HTML-Code ohne Erklärungen.`
                              navigator.clipboard.writeText(prompt).catch(() => {})
                              showToast('✅ ' + t('crm.template.promptCopied'))
                            }}
                            className="mt-1 text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                          >
                            {t('crm.template.copyPrompt')}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
                <button
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 rounded-xl border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
                >
                  {t('crm.template.cancel')}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !form.name.trim() || !form.subject.trim() || !form.body.trim()}
                  className="px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: '#ff795d' }}
                >
                  {saving ? t('crm.template.saving') : t('crm.template.save')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
