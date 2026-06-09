import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { Lead, LeadSource } from '../../../lib/crmTypes'
import { SOURCE_BADGE_STYLE } from '../../../lib/crmTypes'
import { CustomSelect } from '../../../components/CustomSelect'

const SOURCES: Array<'' | LeadSource> = ['', 'meta', 'google', 'empfehlung', 'sonstiges']
const STATUSES = ['', 'new', 'contacted', 'qualified', 'registered', 'property_selection', 'financing', 'sold', 'archived'] as const

interface NewLeadForm {
  first_name: string
  last_name: string
  email: string
  phone: string
  whatsapp: string
  country: string
  language: 'de' | 'en'
  source: LeadSource
  notes: string
  assigned_to: string
  createDeal: boolean
}

const DEFAULT_FORM: NewLeadForm = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  whatsapp: '',
  country: '',
  language: 'de',
  source: 'sonstiges',
  notes: '',
  assigned_to: '',
  createDeal: false,
}

const statusLabel: Record<string, string> = {
  new: 'Neu',
  contacted: 'Kontaktiert',
  qualified: 'Qualifiziert',
  registered: 'Registriert',
  property_selection: 'Immobilienauswahl',
  financing: 'Finanzierung',
  sold: 'Verkauft',
  archived: 'Archiviert',
}

const sourceLabel: Record<string, string> = {
  meta:       'META Werbung',
  google:     'Google',
  empfehlung: 'Empfehlung',
  sonstiges:  'Sonstiges',
}

export default function AllLeads() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  useAuth()

  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterSource, setFilterSource] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [toast, setToast] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [staff, setStaff] = useState<{ id: string; full_name: string }[]>([])
  const [newLeadForm, setNewLeadForm] = useState<NewLeadForm>(DEFAULT_FORM)
  const [creating, setCreating] = useState(false)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  // silent=true: Hintergrund-Refresh (Tab-Fokus) ohne Vollbild-Spinner.
  const fetchLeads = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('leads')
        .select('*, assignee:profiles!leads_assigned_to_fkey(full_name, email)')
        .order('created_at', { ascending: false })
        .limit(500)
      if (error) throw error
      setLeads((data ?? []) as unknown as Lead[])
    } catch (err) {
      console.error('[AllLeads] fetchLeads:', err)
      if (!silent) setLeads([])   // bei Hintergrund-Refresh alte Daten behalten
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  const fetchStaff = useCallback(async () => {
    const { data } = await supabase.from('profiles').select('id, full_name').order('full_name')
    setStaff((data ?? []) as { id: string; full_name: string }[])
  }, [])

  useEffect(() => {
    fetchLeads()
    fetchStaff()
  }, [fetchLeads, fetchStaff])

  // Re-Fetch bei Tab-Fokus — STILL, ohne Vollbild-Spinner.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchLeads(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fetchLeads])

  const filteredLeads = leads.filter(lead => {
    const fullName = `${lead.first_name} ${lead.last_name}`.toLowerCase()
    const matchSearch =
      !search ||
      fullName.includes(search.toLowerCase()) ||
      lead.email.toLowerCase().includes(search.toLowerCase())
    const matchSource = !filterSource || lead.source === filterSource
    const matchStatus = !filterStatus || lead.status === filterStatus
    return matchSearch && matchSource && matchStatus
  })

  const handleDelete = async (id: string) => {
    if (!window.confirm('Lead wirklich löschen?')) return
    const { error } = await supabase.from('leads').delete().eq('id', id)
    if (error) { showToast(`❌ Fehler: ${error.message}`); return }
    await fetchLeads()
    showToast('Lead gelöscht')
  }

  const handleCreate = async () => {
    if (!newLeadForm.first_name.trim() || !newLeadForm.last_name.trim() || !newLeadForm.email.trim()) return
    setCreating(true)
    try {
      const insertPayload = {
        first_name: newLeadForm.first_name.trim(),
        last_name: newLeadForm.last_name.trim(),
        email: newLeadForm.email.trim(),
        phone: newLeadForm.phone.trim() || null,
        whatsapp: newLeadForm.whatsapp.trim() || null,
        country: newLeadForm.country.trim() || null,
        language: newLeadForm.language,
        source: newLeadForm.source,
        notes: newLeadForm.notes.trim() || null,
        assigned_to: newLeadForm.assigned_to || null,
        status: 'new',
      }

      const { data: createdLead, error: leadErr } = await supabase
        .from('leads')
        .insert(insertPayload)
        .select('id')
        .single()
      if (leadErr) throw new Error(leadErr.message)

      if (createdLead?.id && newLeadForm.createDeal) {
        const { data: createdDeal, error: dealErr } = await supabase
          .from('deals')
          .insert({ lead_id: createdLead.id, phase: 'erstkontakt' })
          .select('id')
          .single()
        if (dealErr) throw new Error(dealErr.message)

        if (createdDeal?.id) {
          await supabase.from('activities').insert({
            lead_id: createdLead.id,
            deal_id: createdDeal.id,
            type: 'note',
            direction: 'outbound',
            subject: 'Deal erstellt',
            content: 'Deal automatisch beim Erstellen des Leads angelegt',
          })
        }
      }

      await fetchLeads()
      setShowModal(false)
      setNewLeadForm(DEFAULT_FORM)
      showToast('Lead erstellt')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler beim Erstellen')
    } finally {
      setCreating(false)
    }
  }

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="p-6 space-y-5">
        {/* Toast */}
        {toast && (
          <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">
            {toast}
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">{t('crm.allLeads.title')}</h1>
          <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 rounded-xl text-white text-sm font-medium"
            style={{ backgroundColor: '#ff795d' }}
          >
            + {t('crm.allLeads.newLead')}
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder={t('crm.allLeads.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 w-64"
          />
          <CustomSelect
            value={filterSource}
            onChange={val => setFilterSource(val)}
            className="border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
            options={[
              { value: '', label: t('crm.allLeads.allSources') },
              ...SOURCES.filter(s => s !== '').map(s => ({ value: s, label: sourceLabel[s] })),
            ]}
            placeholder={t('crm.allLeads.allSources')}
          />
          <CustomSelect
            value={filterStatus}
            onChange={val => setFilterStatus(val)}
            className="border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
            options={[
              { value: '', label: t('crm.allLeads.allStatuses') },
              ...STATUSES.filter(s => s !== '').map(s => ({ value: s, label: statusLabel[s] ?? s })),
            ]}
            placeholder={t('crm.allLeads.allStatuses')}
          />
        </div>

        {/* Table */}
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {loading ? (
            <p className="p-6 text-gray-400 text-sm">{t('common.loading')}</p>
          ) : filteredLeads.length === 0 ? (
            <p className="p-6 text-gray-400 text-sm">{t('crm.allLeads.noLeads')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {[t('users.table.name'), t('crm.lead.email'), t('crm.lead.phone'), t('crm.lead.source'), t('crm.lead.status'), t('crm.lead.assignedTo'), t('crm.lead.date'), t('common.actions')].map(col => (
                      <th key={col} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredLeads.map(lead => (
                    <tr key={lead.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/admin/crm/leads/${lead.id}`)}>
                      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                        {lead.first_name} {lead.last_name}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{lead.email}</td>
                      <td className="px-4 py-3 text-gray-600">{lead.phone ?? '–'}</td>
                      <td className="px-4 py-3">
                        <span
                          className="text-xs px-2 py-0.5 rounded-full font-medium"
                          style={SOURCE_BADGE_STYLE[lead.source] ?? SOURCE_BADGE_STYLE.sonstiges}
                        >
                          {sourceLabel[lead.source] ?? lead.source}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{statusLabel[lead.status] ?? lead.status}</td>
                      <td className="px-4 py-3 text-gray-600">{lead.assignee?.full_name ?? '–'}</td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(lead.created_at)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-3">
                          <Link
                            to={`/admin/crm/leads/${lead.id}`}
                            onClick={e => e.stopPropagation()}
                            className="text-sm font-medium hover:underline"
                            style={{ color: '#ff795d' }}
                          >
                            {t('crm.lead.details', 'Details')}
                          </Link>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(lead.id) }}
                            className="text-sm text-red-500 hover:text-red-700"
                          >
                            {t('common.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* New lead modal */}
        {showModal && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">{t('crm.allLeads.newLead')}</h2>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.lead.firstName')} *</label>
                  <input
                    type="text"
                    value={newLeadForm.first_name}
                    onChange={e => setNewLeadForm(f => ({ ...f, first_name: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.lead.lastName')} *</label>
                  <input
                    type="text"
                    value={newLeadForm.last_name}
                    onChange={e => setNewLeadForm(f => ({ ...f, last_name: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.lead.email')} *</label>
                <input
                  type="email"
                  value={newLeadForm.email}
                  onChange={e => setNewLeadForm(f => ({ ...f, email: e.target.value }))}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.lead.phone')}</label>
                  <input
                    type="tel"
                    value={newLeadForm.phone}
                    onChange={e => setNewLeadForm(f => ({ ...f, phone: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">WhatsApp</label>
                  <input
                    type="tel"
                    value={newLeadForm.whatsapp}
                    onChange={e => setNewLeadForm(f => ({ ...f, whatsapp: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.lead.country')}</label>
                  <input
                    type="text"
                    value={newLeadForm.country}
                    onChange={e => setNewLeadForm(f => ({ ...f, country: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.lead.language')}</label>
                  <CustomSelect
                    value={newLeadForm.language}
                    onChange={val => setNewLeadForm(f => ({ ...f, language: val as 'de' | 'en' }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
                    options={[
                      { value: 'de', label: 'Deutsch' },
                      { value: 'en', label: 'English' },
                    ]}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.lead.source')}</label>
                  <CustomSelect
                    value={newLeadForm.source}
                    onChange={val => setNewLeadForm(f => ({ ...f, source: val as NewLeadForm['source'] }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
                    options={SOURCES.filter(s => s !== '').map(s => ({ value: s, label: sourceLabel[s] }))}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.lead.assignedTo')}</label>
                  <CustomSelect
                    value={newLeadForm.assigned_to}
                    onChange={val => setNewLeadForm(f => ({ ...f, assigned_to: val }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
                    options={[
                      { value: '', label: t('crm.allLeads.notAssigned') },
                      ...staff.map(s => ({ value: s.id, label: s.full_name })),
                    ]}
                    placeholder={t('crm.allLeads.notAssigned')}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.lead.notes')}</label>
                <textarea
                  rows={3}
                  value={newLeadForm.notes}
                  onChange={e => setNewLeadForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 resize-y"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newLeadForm.createDeal}
                  onChange={e => setNewLeadForm(f => ({ ...f, createDeal: e.target.checked }))}
                  className="rounded"
                />
                {t('crm.allLeads.autoCreateDeal')}
              </label>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  onClick={() => { setShowModal(false); setNewLeadForm(DEFAULT_FORM) }}
                  className="px-4 py-2 rounded-xl border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleCreate}
                  disabled={creating || !newLeadForm.first_name.trim() || !newLeadForm.last_name.trim() || !newLeadForm.email.trim()}
                  className="px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50"
                  style={{ backgroundColor: '#ff795d' }}
                >
                  {creating ? t('crm.allLeads.creating') : t('crm.allLeads.create')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
