import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { Lead, LeadSource } from '../../../lib/crmTypes'
import { SOURCE_BADGE_STYLE } from '../../../lib/crmTypes'

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

  const fetchLeads = useCallback(async () => {
    setLoading(true)
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
      setLeads([])
    } finally {
      setLoading(false)
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
    await supabase.from('leads').delete().eq('id', id)
    await fetchLeads()
    showToast('Lead gelöscht')
  }

  const handleCreate = async () => {
    if (!newLeadForm.first_name.trim() || !newLeadForm.email.trim()) return
    setCreating(true)

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

    const { data: createdLead } = await supabase
      .from('leads')
      .insert(insertPayload)
      .select('id')
      .single()

    if (createdLead?.id && newLeadForm.createDeal) {
      const { data: createdDeal } = await supabase
        .from('deals')
        .insert({ lead_id: createdLead.id, phase: 'erstkontakt' })
        .select('id')
        .single()

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
    setCreating(false)
    showToast('Lead erstellt')
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
            + Neuer Lead
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="Name oder E-Mail suchen…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 w-64"
          />
          <select
            value={filterSource}
            onChange={e => setFilterSource(e.target.value)}
            className="border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
          >
            <option value="">Alle Quellen</option>
            {SOURCES.filter(s => s !== '').map(s => (
              <option key={s} value={s}>{sourceLabel[s]}</option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
          >
            <option value="">Alle Status</option>
            {STATUSES.filter(s => s !== '').map(s => (
              <option key={s} value={s}>{statusLabel[s] ?? s}</option>
            ))}
          </select>
        </div>

        {/* Table */}
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {loading ? (
            <p className="p-6 text-gray-400 text-sm">Lädt…</p>
          ) : filteredLeads.length === 0 ? (
            <p className="p-6 text-gray-400 text-sm">{t('crm.allLeads.noLeads')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {['Name', 'E-Mail', 'Telefon', 'Quelle', 'Status', 'Zuständig', 'Datum', 'Aktionen'].map(col => (
                      <th key={col} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredLeads.map(lead => (
                    <tr key={lead.id} className="hover:bg-gray-50">
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
                            className="text-sm font-medium hover:underline"
                            style={{ color: '#ff795d' }}
                          >
                            Details
                          </Link>
                          <button
                            onClick={() => handleDelete(lead.id)}
                            className="text-sm text-red-500 hover:text-red-700"
                          >
                            Löschen
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
              <h2 className="text-lg font-semibold text-gray-900">Neuer Lead</h2>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Vorname *</label>
                  <input
                    type="text"
                    value={newLeadForm.first_name}
                    onChange={e => setNewLeadForm(f => ({ ...f, first_name: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Nachname</label>
                  <input
                    type="text"
                    value={newLeadForm.last_name}
                    onChange={e => setNewLeadForm(f => ({ ...f, last_name: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">E-Mail *</label>
                <input
                  type="email"
                  value={newLeadForm.email}
                  onChange={e => setNewLeadForm(f => ({ ...f, email: e.target.value }))}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Telefon</label>
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Land</label>
                  <input
                    type="text"
                    value={newLeadForm.country}
                    onChange={e => setNewLeadForm(f => ({ ...f, country: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Sprache</label>
                  <select
                    value={newLeadForm.language}
                    onChange={e => setNewLeadForm(f => ({ ...f, language: e.target.value as 'de' | 'en' }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
                  >
                    <option value="de">Deutsch</option>
                    <option value="en">English</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Quelle</label>
                  <select
                    value={newLeadForm.source}
                    onChange={e => setNewLeadForm(f => ({ ...f, source: e.target.value as NewLeadForm['source'] }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
                  >
                    {SOURCES.filter(s => s !== '').map(s => (
                      <option key={s} value={s}>{sourceLabel[s]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Zuständig</label>
                  <select
                    value={newLeadForm.assigned_to}
                    onChange={e => setNewLeadForm(f => ({ ...f, assigned_to: e.target.value }))}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
                  >
                    <option value="">Nicht zugewiesen</option>
                    {staff.map(s => (
                      <option key={s.id} value={s.id}>{s.full_name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notizen</label>
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
                Deal automatisch erstellen
              </label>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  onClick={() => { setShowModal(false); setNewLeadForm(DEFAULT_FORM) }}
                  className="px-4 py-2 rounded-xl border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Abbrechen
                </button>
                <button
                  onClick={handleCreate}
                  disabled={creating}
                  className="px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50"
                  style={{ backgroundColor: '#ff795d' }}
                >
                  {creating ? 'Erstellt…' : 'Erstellen'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
