import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { EmailTemplate } from '../../../lib/crmTypes'

const CATEGORIES = ['general', 'project', 'followup', 'noshow', 'lawyer', 'financing'] as const
type Category = typeof CATEGORIES[number]

const LANGUAGES = ['de', 'en'] as const
type Language = typeof LANGUAGES[number]

interface FormState {
  name: string
  subject: string
  body: string
  category: Category
  language: Language
}

const DEFAULT_FORM: FormState = {
  name: '',
  subject: '',
  body: '',
  category: 'general',
  language: 'de',
}

export default function Templates() {
  const { t } = useTranslation()
  useAuth()

  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')

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

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  const openCreate = () => {
    setEditingId(null)
    setForm(DEFAULT_FORM)
    setShowForm(true)
  }

  const openEdit = (tpl: EmailTemplate) => {
    setEditingId(tpl.id)
    setForm({
      name: tpl.name,
      subject: tpl.subject,
      body: tpl.body,
      category: tpl.category,
      language: tpl.language,
    })
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!form.name.trim() || !form.subject.trim() || !form.body.trim()) return
    setSaving(true)

    if (editingId) {
      await supabase.from('email_templates').update(form).eq('id', editingId)
    } else {
      await supabase.from('email_templates').insert(form)
    }

    await fetchTemplates()
    setShowForm(false)
    setSaving(false)
    showToast(editingId ? 'Vorlage gespeichert' : 'Vorlage erstellt')
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm('Vorlage wirklich löschen?')) return
    await supabase.from('email_templates').delete().eq('id', id)
    await fetchTemplates()
    showToast('Vorlage gelöscht')
  }

  const categoryLabel: Record<Category, string> = {
    general: 'Allgemein',
    project: 'Projekt',
    followup: 'Follow-up',
    noshow: 'No-Show',
    lawyer: 'Anwalt',
    financing: 'Finanzierung',
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
          <h1 className="text-2xl font-bold text-gray-900">{t('crm.template.title')}</h1>
          <button
            onClick={openCreate}
            className="px-4 py-2 rounded-xl text-white text-sm font-medium"
            style={{ backgroundColor: '#ff795d' }}
          >
            + Neue Vorlage
          </button>
        </div>

        {/* Template list */}
        {loading ? (
          <p className="text-gray-400 text-sm">Lädt…</p>
        ) : templates.length === 0 ? (
          <p className="text-gray-400 text-sm">Keine Vorlagen vorhanden</p>
        ) : (
          <div className="grid gap-4">
            {templates.map(tpl => (
              <div key={tpl.id} className="bg-white rounded-2xl shadow p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-semibold text-gray-900">{tpl.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                        {categoryLabel[tpl.category]}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 uppercase">
                        {tpl.language}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 truncate">{tpl.subject}</p>
                    <p className="text-xs text-gray-400 mt-1 line-clamp-2">{tpl.body}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      onClick={() => openEdit(tpl)}
                      className="text-sm text-gray-500 hover:text-gray-800 font-medium"
                    >
                      Bearbeiten
                    </button>
                    <button
                      onClick={() => handleDelete(tpl.id)}
                      className="text-sm text-red-500 hover:text-red-700 font-medium"
                    >
                      Löschen
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Form modal */}
        {showForm && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">
                {editingId ? 'Vorlage bearbeiten' : 'Neue Vorlage'}
              </h2>

              <div className="space-y-3">
                {/* Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>

                {/* Subject */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Betreff *</label>
                  <input
                    type="text"
                    value={form.subject}
                    onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>

                {/* Body */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Inhalt *</label>
                  <textarea
                    rows={8}
                    value={form.body}
                    onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 resize-y"
                  />
                  <p className="text-xs text-gray-400 mt-1">{t('crm.template.placeholders')}</p>
                </div>

                {/* Category */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Kategorie</label>
                  <select
                    value={form.category}
                    onChange={e => setForm(f => ({ ...f, category: e.target.value as Category }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white"
                  >
                    {CATEGORIES.map(c => (
                      <option key={c} value={c}>{categoryLabel[c]}</option>
                    ))}
                  </select>
                </div>

                {/* Language */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Sprache</label>
                  <select
                    value={form.language}
                    onChange={e => setForm(f => ({ ...f, language: e.target.value as Language }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white"
                  >
                    {LANGUAGES.map(l => (
                      <option key={l} value={l}>{l === 'de' ? 'Deutsch' : 'English'}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 rounded-xl border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Abbrechen
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50"
                  style={{ backgroundColor: '#ff795d' }}
                >
                  {saving ? 'Speichert…' : 'Speichern'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
