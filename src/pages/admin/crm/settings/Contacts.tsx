import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'
import type { BusinessContact, DeveloperContact } from '../../../../lib/crmTypes'

// ── Geschäftskontakte ───────────────────────────────────────────────────────────
// Freistehende Kontakte rund um den Deal-Prozess (Anwälte, Finanzierer, Partner,
// sonstige Ansprechpartner). Nicht an einen Developer gebunden. Wählbar als
// Empfänger für Mail/WhatsApp aus der Lead-Detailseite.

const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white'
const labelCls = 'block text-xs font-medium text-gray-500 mb-1'

// ── Modal ──────────────────────────────────────────────────────────────────────
interface ContactModalProps {
  contact: BusinessContact | null   // null = neuer Kontakt
  onClose: () => void
  onSaved: (m: string) => void
}

function ContactModal({ contact, onClose, onSaved }: ContactModalProps) {
  const { t } = useTranslation()

  const [firstName, setFirstName] = useState(contact?.first_name ?? '')
  const [lastName,  setLastName]  = useState(contact?.last_name ?? '')
  const [company,   setCompany]   = useState(contact?.company ?? '')
  const [role,      setRole]      = useState(contact?.role ?? '')
  const [email,     setEmail]     = useState(contact?.email ?? '')
  const [phone,     setPhone]     = useState(contact?.phone ?? '')
  const [whatsapp,  setWhatsapp]  = useState(contact?.whatsapp ?? '')
  const [notes,     setNotes]     = useState(contact?.notes ?? '')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')

  const handleSave = async () => {
    if (!firstName.trim()) {
      setError(t('crm.contacts.errFirstName', 'Vorname ist Pflicht')); return
    }
    setSaving(true); setError('')
    try {
      const payload = {
        first_name: firstName.trim(),
        last_name:  lastName.trim() || null,
        company:    company.trim() || null,
        role:       role.trim() || null,
        email:      email.trim() || null,
        phone:      phone.trim() || null,
        whatsapp:   whatsapp.trim() || null,
        notes:      notes.trim() || null,
        updated_at: new Date().toISOString(),
      }
      if (contact) {
        const { error: e } = await supabase.from('crm_business_contacts').update(payload).eq('id', contact.id)
        if (e) throw e
      } else {
        const { error: e } = await supabase.from('crm_business_contacts').insert(payload)
        if (e) throw e
      }
      onSaved(contact
        ? t('crm.contacts.savedEdit', '✅ Kontakt gespeichert')
        : t('crm.contacts.savedNew',  '✅ Kontakt angelegt'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-6 flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">
            {contact
              ? t('crm.contacts.editTitle', 'Kontakt bearbeiten')
              : t('crm.contacts.newTitle',  'Neuer Kontakt')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('crm.contacts.firstName', 'Vorname')} *</label>
              <input className={inputCls} value={firstName} onChange={e => setFirstName(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>{t('crm.contacts.lastName', 'Nachname')}</label>
              <input className={inputCls} value={lastName} onChange={e => setLastName(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('crm.contacts.company', 'Firma')}</label>
              <input className={inputCls} value={company} onChange={e => setCompany(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>{t('crm.contacts.role', 'Funktion')}</label>
              <input className={inputCls} value={role} onChange={e => setRole(e.target.value)}
                placeholder={t('crm.contacts.rolePh', 'z.B. Anwalt, Finanzierung, Partner')} />
            </div>
          </div>

          <div>
            <label className={labelCls}>{t('crm.contacts.email', 'E-Mail')}</label>
            <input type="email" className={inputCls} value={email} onChange={e => setEmail(e.target.value)} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('crm.contacts.phone', 'Telefon')}</label>
              <input className={inputCls} value={phone} onChange={e => setPhone(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>{t('crm.contacts.whatsapp', 'WhatsApp')}</label>
              <input className={inputCls} value={whatsapp} onChange={e => setWhatsapp(e.target.value)}
                placeholder={t('crm.contacts.whatsappPh', 'Mit Ländervorwahl, z.B. +49…')} />
            </div>
          </div>

          <div>
            <label className={labelCls}>{t('crm.contacts.notes', 'Notizen')}</label>
            <textarea rows={3} className={`${inputCls} resize-y`} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">
            {t('common.cancel', 'Abbrechen')}
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#ff795d' }}>
            {saving ? t('common.saving', 'Speichert…') : t('common.save', 'Speichern')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Hauptseite ──────────────────────────────────────────────────────────────────
export default function Contacts() {
  const { t } = useTranslation()

  const [items,   setItems]   = useState<BusinessContact[]>([])
  const [devContacts, setDevContacts] = useState<(DeveloperContact & { developer_name: string | null })[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ contact: BusinessContact | null } | null>(null)
  const [toast,   setToast]   = useState('')

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      // Eigenständige Geschäftskontakte + Developer-Ansprechpartner (read-only hier,
      // werden in den Developer-Einstellungen gepflegt) — beide Gruppen sichtbar.
      const [bcRes, dcRes, devRes] = await Promise.all([
        supabase.from('crm_business_contacts').select('*').order('first_name', { ascending: true }),
        supabase.from('crm_developer_contacts').select('*').order('name', { ascending: true }),
        supabase.from('crm_developers').select('id, name'),
      ])
      if (bcRes.error) throw bcRes.error
      setItems((bcRes.data ?? []) as BusinessContact[])
      const devMap = new Map(((devRes.data ?? []) as { id: string; name: string }[]).map(d => [d.id, d.name]))
      setDevContacts(((dcRes.data ?? []) as DeveloperContact[]).map(c => ({
        ...c,
        developer_name: devMap.get(c.developer_id) ?? null,
      })))
    } catch (err) {
      console.error('[Contacts] fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const deleteItem = async (c: BusinessContact) => {
    if (!window.confirm(t('crm.contacts.deleteConfirm', 'Diesen Kontakt löschen?'))) return
    const { error } = await supabase.from('crm_business_contacts').delete().eq('id', c.id)
    if (error) { showToast(`❌ ${error.message}`); return }
    showToast(t('crm.contacts.deleted', 'Kontakt gelöscht'))
    fetchAll()
  }

  const fullName = (c: BusinessContact) => `${c.first_name} ${c.last_name ?? ''}`.trim()

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">
          {toast}
        </div>
      )}

      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {t('crm.contacts.title', 'Geschäftskontakte')}
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {t('crm.contacts.subtitle', 'Anwälte, Finanzierer, Partner und sonstige Ansprechpartner — wählbar als Empfänger für Mail/WhatsApp.')}
            </p>
          </div>
          <button onClick={() => setEditing({ contact: null })}
            className="px-3 py-1.5 rounded-xl text-white text-sm font-medium whitespace-nowrap"
            style={{ backgroundColor: '#ff795d' }}>
            {t('crm.contacts.add', '+ Kontakt')}
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-12 bg-white rounded-2xl border border-dashed border-gray-200">
            {t('crm.contacts.empty', 'Noch keine Geschäftskontakte angelegt.')}
          </p>
        ) : (
          <div className="space-y-2">
            {items.map(c => (
              <div key={c.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
                <div className="flex items-start gap-3">
                  <span className="shrink-0 text-lg mt-0.5">👤</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-900 text-sm">{fullName(c)}</span>
                      {c.role && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{c.role}</span>
                      )}
                      {c.company && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{c.company}</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-1 truncate">
                      {[c.email, c.phone, c.whatsapp && `WA ${c.whatsapp}`].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => setEditing({ contact: c })}
                      className="text-sm text-gray-500 hover:text-gray-800 font-medium">
                      {t('common.edit', 'Bearbeiten')}
                    </button>
                    <button onClick={() => deleteItem(c)}
                      className="text-sm text-red-500 hover:text-red-700 font-medium">
                      {t('common.delete', 'Löschen')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Developer-Ansprechpartner — read-only, gepflegt in den Developer-Einstellungen */}
        {!loading && devContacts.length > 0 && (
          <div className="pt-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              {t('crm.contacts.devSection', 'Developer-Ansprechpartner')}
            </h2>
            <div className="space-y-2">
              {devContacts.map(c => (
                <div key={c.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
                  <div className="flex items-start gap-3">
                    <span className="shrink-0 text-lg mt-0.5">🏗</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-gray-900 text-sm">{c.name}</span>
                        {c.is_primary && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">★</span>
                        )}
                        {c.role && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{c.role}</span>
                        )}
                        {c.developer_name && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">🏗 {c.developer_name}</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mt-1 truncate">
                        {[c.email, c.phone, c.whatsapp && `WA ${c.whatsapp}`].filter(Boolean).join(' · ') || '—'}
                      </p>
                    </div>
                    <span className="text-xs text-gray-300 shrink-0 italic whitespace-nowrap">
                      {t('crm.contacts.managedInDeveloper', 'beim Developer')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {editing && (
        <ContactModal
          contact={editing.contact}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); showToast(m); fetchAll() }}
        />
      )}
    </DashboardLayout>
  )
}
