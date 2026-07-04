import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import type { Developer, DeveloperContact } from '../../lib/crmTypes'

// Ansprechpartner-Verwaltung pro Developer: anlegen / bearbeiten / löschen +
// Direkt-Compose per Mail (mailto) und WhatsApp (wa.me). Es wird NICHTS
// automatisch versendet — die Buttons öffnen nur das jeweilige Compose-Fenster.

interface FormState {
  name:       string
  role:       string
  email:      string
  phone:      string
  whatsapp:   string
  is_primary: boolean
  notes:      string
  language:   'de' | 'en'
}

const EMPTY_FORM: FormState = {
  name: '', role: '', email: '', phone: '', whatsapp: '', is_primary: false, notes: '', language: 'de',
}

// wa.me erwartet die Nummer ohne +, Leerzeichen oder Sonderzeichen.
function waLink(num: string | null): string {
  const digits = (num ?? '').replace(/[^0-9]/g, '')
  return digits ? `https://wa.me/${digits}` : ''
}

export default function DeveloperContactsModal({
  developer, onClose,
}: { developer: Developer; onClose: () => void }) {
  const { t } = useTranslation()
  const [contacts, setContacts]   = useState<DeveloperContact[]>([])
  const [loading, setLoading]     = useState(true)
  const [showForm, setShowForm]   = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null) // null = Neu-Anlage
  const [form, setForm]           = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

  const fetchContacts = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error: err } = await supabase
        .from('crm_developer_contacts')
        .select('*')
        .eq('developer_id', developer.id)
        .order('is_primary', { ascending: false })
        .order('name')
      if (err) throw err
      setContacts((data ?? []) as DeveloperContact[])
    } catch (err) {
      console.error('[DeveloperContactsModal] fetchContacts:', err)
      setContacts([])
    } finally {
      setLoading(false)
    }
  }, [developer.id])

  useEffect(() => { fetchContacts() }, [fetchContacts])

  const openNew = () => {
    setForm(EMPTY_FORM); setEditingId(null); setError(''); setShowForm(true)
  }
  const openEdit = (c: DeveloperContact) => {
    setForm({
      name: c.name, role: c.role ?? '', email: c.email ?? '',
      phone: c.phone ?? '', whatsapp: c.whatsapp ?? '',
      is_primary: c.is_primary, notes: c.notes ?? '',
      language: (c.language as 'de' | 'en') ?? 'de',
    })
    setEditingId(c.id); setError(''); setShowForm(true)
  }

  const handleSave = async () => {
    const name = form.name.trim()
    if (!name) { setError(t('crm.devContacts.nameRequired', 'Name ist erforderlich.')); return }
    setSaving(true); setError('')
    try {
      const payload = {
        developer_id: developer.id,
        name,
        role:       form.role.trim()     || null,
        email:      form.email.trim()    || null,
        phone:      form.phone.trim()    || null,
        whatsapp:   form.whatsapp.trim() || null,
        is_primary: form.is_primary,
        notes:      form.notes.trim()    || null,
        language:   form.language,
      }
      const { error: err } = editingId
        ? await supabase.from('crm_developer_contacts').update(payload).eq('id', editingId)
        : await supabase.from('crm_developer_contacts').insert(payload)
      if (err) throw err
      setShowForm(false); setEditingId(null); setForm(EMPTY_FORM)
      await fetchContacts()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (c: DeveloperContact) => {
    if (!window.confirm(t('crm.devContacts.deleteConfirm', '{{name}} wirklich löschen?', { name: c.name }))) return
    try {
      const { error: err } = await supabase.from('crm_developer_contacts').delete().eq('id', c.id)
      if (err) throw err
      await fetchContacts()
    } catch (err) {
      console.error('[DeveloperContactsModal] delete:', err)
    }
  }

  const inputCls =
    'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {t('crm.devContacts.title', 'Ansprechpartner')} · {developer.name}
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {t('crm.devContacts.subtitle',
                'Kontakte für Mail/WhatsApp und Reservierungs-Benachrichtigungen.')}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 overflow-y-auto space-y-3">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
            </div>
          ) : contacts.length === 0 && !showForm ? (
            <p className="text-sm text-gray-400 text-center py-6">
              {t('crm.devContacts.empty', 'Noch keine Ansprechpartner. Lege den ersten an.')}
            </p>
          ) : (
            contacts.map(c => (
              <div key={c.id} className="border border-gray-100 rounded-xl p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-900 text-sm">{c.name}</span>
                      {c.is_primary && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-orange-100 text-orange-700">
                          {t('crm.devContacts.primary', 'Hauptkontakt')}
                        </span>
                      )}
                      {c.language === 'en' && (
                        <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-blue-100 text-blue-700">EN</span>
                      )}
                      {c.role && <span className="text-xs text-gray-500">· {c.role}</span>}
                    </div>
                    <div className="mt-1 space-y-0.5 text-xs text-gray-500">
                      {c.email    && <p>✉️ {c.email}</p>}
                      {c.phone    && <p>📞 {c.phone}</p>}
                      {c.whatsapp && <p>💬 {c.whatsapp}</p>}
                      {c.notes    && <p className="text-gray-400 italic">{c.notes}</p>}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <div className="flex gap-1.5">
                      {c.email && (
                        <a
                          href={`mailto:${c.email}`}
                          className="px-2.5 py-1 text-xs rounded-lg border border-gray-200 text-gray-600
                                     hover:border-blue-200 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                        >
                          {t('crm.devContacts.mail', 'Mail')}
                        </a>
                      )}
                      {waLink(c.whatsapp || c.phone) && (
                        <a
                          href={waLink(c.whatsapp || c.phone)}
                          target="_blank"
                          rel="noreferrer"
                          className="px-2.5 py-1 text-xs rounded-lg border border-gray-200 text-gray-600
                                     hover:border-green-200 hover:text-green-600 hover:bg-green-50 transition-colors"
                        >
                          {t('crm.devContacts.whatsapp', 'WhatsApp')}
                        </a>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => openEdit(c)}
                        className="px-2.5 py-1 text-xs rounded-lg text-gray-400 hover:text-gray-700"
                      >
                        {t('common.edit', 'Bearbeiten')}
                      </button>
                      <button
                        onClick={() => handleDelete(c)}
                        className="px-2.5 py-1 text-xs rounded-lg text-gray-400 hover:text-red-500"
                      >
                        {t('common.delete', 'Löschen')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}

          {/* Inline form */}
          {showForm && (
            <div className="border border-orange-100 bg-orange-50/40 rounded-xl p-4 space-y-3">
              <p className="text-sm font-semibold text-gray-900">
                {editingId
                  ? t('crm.devContacts.editTitle', 'Ansprechpartner bearbeiten')
                  : t('crm.devContacts.newTitle', 'Neuer Ansprechpartner')}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {t('crm.devContacts.name', 'Name')} *
                  </label>
                  <input autoFocus value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    className={inputCls} placeholder="z.B. Maria Sales" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {t('crm.devContacts.role', 'Rolle / Abteilung')}
                  </label>
                  <input value={form.role}
                    onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                    className={inputCls} placeholder="z.B. Sales, Reservierungen" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {t('crm.devContacts.email', 'E-Mail')}
                  </label>
                  <input type="email" value={form.email}
                    onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                    className={inputCls} placeholder="name@developer.com" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {t('crm.devContacts.phone', 'Telefon')}
                  </label>
                  <input value={form.phone}
                    onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                    className={inputCls} placeholder="+357 …" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {t('crm.devContacts.whatsappNum', 'WhatsApp-Nummer')}
                  </label>
                  <input value={form.whatsapp}
                    onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))}
                    className={inputCls} placeholder="+357 …" />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-xs font-medium text-gray-600 pb-2 cursor-pointer">
                    <input type="checkbox" checked={form.is_primary}
                      onChange={e => setForm(f => ({ ...f, is_primary: e.target.checked }))}
                      className="rounded border-gray-300 text-orange-500 focus:ring-orange-400" />
                    {t('crm.devContacts.isPrimary', 'Hauptkontakt')}
                  </label>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {t('crm.devContacts.notes', 'Notizen')}
                  </label>
                  <textarea value={form.notes} rows={2}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    className={`${inputCls} resize-none`} />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {t('crm.devContacts.language', 'Kontaktsprache')}
                  </label>
                  <select value={form.language}
                    onChange={e => setForm(f => ({ ...f, language: e.target.value as 'de' | 'en' }))}
                    className={inputCls}>
                    <option value="de">{t('crm.devContacts.langDe', 'Deutsch')}</option>
                    <option value="en">{t('crm.devContacts.langEn', 'Englisch')}</option>
                  </select>
                  <p className="mt-1 text-[11px] text-gray-400">
                    {t('crm.devContacts.langHint', 'Automatische Mails & WhatsApp an diesen Kontakt in dieser Sprache.')}
                  </p>
                </div>
              </div>
              {error && <p className="text-xs text-red-500">{error}</p>}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => { setShowForm(false); setEditingId(null); setError('') }}
                  className="px-3 py-1.5 text-xs text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
                >
                  {t('common.cancel', 'Abbrechen')}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !form.name.trim()}
                  className="px-4 py-1.5 rounded-lg text-white text-xs font-medium disabled:opacity-50"
                  style={{ backgroundColor: '#ff795d' }}
                >
                  {saving ? t('common.saving', 'Speichert…') : t('common.save', 'Speichern')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
          {!showForm && (
            <button
              onClick={openNew}
              className="px-4 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90 transition-opacity"
              style={{ backgroundColor: '#ff795d' }}
            >
              + {t('crm.devContacts.add', 'Ansprechpartner')}
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-auto px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            {t('common.close', 'Schließen')}
          </button>
        </div>
      </div>
    </div>
  )
}
