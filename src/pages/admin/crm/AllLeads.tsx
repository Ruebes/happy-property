import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { Lead, LeadSource } from '../../../lib/crmTypes'
import { SOURCE_BADGE_STYLE, adChannelLabel } from '../../../lib/crmTypes'
import { CustomSelect } from '../../../components/CustomSelect'
import LeadQuickSend, { type QuickSendMode } from '../../../components/crm/LeadQuickSend'

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

const STATUS_LABEL_KEYS: Record<string, { key: string; fallback: string }> = {
  new: { key: 'allLeads.statusNew', fallback: 'Neu' },
  contacted: { key: 'allLeads.statusContacted', fallback: 'Kontaktiert' },
  qualified: { key: 'allLeads.statusQualified', fallback: 'Qualifiziert' },
  registered: { key: 'allLeads.statusRegistered', fallback: 'Registriert' },
  property_selection: { key: 'allLeads.statusPropertySelection', fallback: 'Immobilienauswahl' },
  financing: { key: 'allLeads.statusFinancing', fallback: 'Finanzierung' },
  sold: { key: 'allLeads.statusSold', fallback: 'Verkauft' },
  archived: { key: 'allLeads.statusArchived', fallback: 'Archiviert' },
}

const SOURCE_LABEL_KEYS: Record<string, { key: string; fallback: string }> = {
  meta:       { key: 'allLeads.sourceMeta', fallback: 'META Werbung' },
  google:     { key: 'allLeads.sourceGoogle', fallback: 'Google' },
  empfehlung: { key: 'allLeads.sourceEmpfehlung', fallback: 'Empfehlung' },
  sonstiges:  { key: 'allLeads.sourceSonstiges', fallback: 'Sonstiges' },
}

const getStatusLabel = (t: TFunction, status: string): string => {
  const entry = STATUS_LABEL_KEYS[status]
  return entry ? t(entry.key, entry.fallback) : status
}

const getSourceLabel = (t: TFunction, source: string): string => {
  const entry = SOURCE_LABEL_KEYS[source]
  return entry ? t(entry.key, entry.fallback) : source
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
  // Qualitaets-Ansicht: nur Leads, deren Gespraech vorbei ist und die noch keine
  // Bewertung haben. Genau diese Bewertung geht als QualifiedLead an Meta zurueck.
  const [onlyRate, setOnlyRate] = useState(false)
  // leadId → id des juengsten vergangenen Termins (fuer AppointmentHeld).
  const [pastAppt, setPastAppt] = useState<Record<string, string>>({})
  const [rating, setRating] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [staff, setStaff] = useState<{ id: string; full_name: string }[]>([])
  const [newLeadForm, setNewLeadForm] = useState<NewLeadForm>(DEFAULT_FORM)
  const [creating, setCreating] = useState(false)
  const [view, setView] = useState<'list' | 'tiles'>('list')
  const [leadCtx, setLeadCtx] = useState<{ x: number; y: number; lead: Lead } | null>(null)
  const [quickSend, setQuickSend] = useState<{ lead: Lead; mode: QuickSendMode } | null>(null)

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
      // Vergangene Kundentermine — daraus ergibt sich, wer ueberhaupt bewertbar ist.
      const { data: appts } = await supabase.from('crm_appointments')
        .select('id, lead_id, start_time')
        .eq('internal', false).not('lead_id', 'is', null)
        .lt('start_time', new Date().toISOString())
        .order('start_time', { ascending: false })
      const map: Record<string, string> = {}
      for (const a of ((appts ?? []) as { id: string; lead_id: string }[])) {
        if (!map[a.lead_id]) map[a.lead_id] = a.id   // juengster gewinnt
      }
      setPastAppt(map)
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

  // Wie viele warten auf eine Bewertung — steht als Zahl am Umschalter.
  const toRateCount = leads.filter(l => !l.quality_rating && !!pastAppt[l.id]).length

  const filteredLeads = leads.filter(lead => {
    const fullName = `${lead.first_name} ${lead.last_name}`.toLowerCase()
    const matchSearch =
      !search ||
      fullName.includes(search.toLowerCase()) ||
      lead.email.toLowerCase().includes(search.toLowerCase())
    const matchSource = !filterSource || lead.source === filterSource
    const matchStatus = !filterStatus || lead.status === filterStatus
    // „Zu bewerten" = Gespraech war, Bewertung fehlt.
    const matchRate = !onlyRate || (!lead.quality_rating && !!pastAppt[lead.id])
    return matchSearch && matchSource && matchStatus && matchRate
  })

  // Bewerten direkt aus der Liste. Wichtig: es wird AUCH outcome='completed' am
  // zugehoerigen Termin gesetzt. Ohne das entsteht nie ein AppointmentHeld-Signal —
  // dieser Status wurde bisher ausschliesslich vom Termin-Popup geschrieben, weshalb
  // er in der gesamten Datenbank kein einziges Mal vorkam.
  const rateLead = async (lead: Lead, value: 'gut' | 'schlecht') => {
    setRating(lead.id)
    const prev = leads
    const ratedAt = new Date().toISOString()
    setLeads(ls => ls.map(l => l.id === lead.id ? { ...l, quality_rating: value, quality_rated_at: ratedAt } : l))
    try {
      const { error } = await supabase.from('leads')
        .update({ quality_rating: value, quality_rated_at: ratedAt }).eq('id', lead.id)
      if (error) throw error
      const apptId = pastAppt[lead.id]
      if (apptId) {
        await supabase.from('crm_appointments').update({ outcome: 'completed' }).eq('id', apptId)
      }
      await supabase.from('activities').insert({
        lead_id: lead.id, type: 'note', direction: 'outbound',
        subject: value === 'gut' ? '👍 Guter Lead' : '👎 Schlechter Lead',
        content: t('crm.lead.ratedInList', 'Bewertet in der Kontaktliste'),
        completed_at: ratedAt,
      })
      showToast(value === 'gut'
        ? t('crm.lead.ratedGood', '👍 Als guter Lead bewertet — geht heute Nacht an Meta zurück.')
        : t('crm.lead.ratedBad', '👎 Als schwacher Lead vermerkt.'))
    } catch (err) {
      console.error('[AllLeads] rateLead:', err)
      setLeads(prev)
      showToast(t('common.error', 'Fehler'))
    } finally { setRating(null) }
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('allLeads.confirmDeleteLead', 'Lead wirklich löschen?'))) return
    const { error } = await supabase.from('leads').delete().eq('id', id)
    if (error) { showToast(t('allLeads.errorGeneric', '❌ Fehler: {{message}}', { message: error.message })); return }
    await fetchLeads()
    showToast(t('allLeads.leadDeleted', 'Lead gelöscht'))
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
            subject: t('allLeads.activityDealCreatedSubject', 'Deal erstellt'),
            content: t('allLeads.activityDealCreatedContent', 'Deal automatisch beim Erstellen des Leads angelegt'),
          })
        }
      }

      await fetchLeads()
      setShowModal(false)
      setNewLeadForm(DEFAULT_FORM)
      showToast(t('allLeads.leadCreated', 'Lead erstellt'))
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('allLeads.errorCreating', 'Fehler beim Erstellen'))
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
          <button
            type="button" onClick={() => setOnlyRate(v => !v)}
            className={`px-3 py-2 rounded-xl text-sm font-medium whitespace-nowrap border transition-colors ${onlyRate ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}
            style={onlyRate ? { backgroundColor: '#ff795d' } : undefined}
          >
            ⭐ {t('crm.allLeads.quality', 'Qualität')}
            {toRateCount > 0 && (
              <span className={`ml-1.5 text-xs ${onlyRate ? 'text-white/80' : 'text-gray-400'}`}>{toRateCount}</span>
            )}
          </button>
          <CustomSelect
            value={filterSource}
            onChange={val => setFilterSource(val)}
            className="border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
            options={[
              { value: '', label: t('crm.allLeads.allSources') },
              ...SOURCES.filter(s => s !== '').map(s => ({ value: s, label: getSourceLabel(t, s) })),
            ]}
            placeholder={t('crm.allLeads.allSources')}
          />
          <CustomSelect
            value={filterStatus}
            onChange={val => setFilterStatus(val)}
            className="border border-gray-300 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
            options={[
              { value: '', label: t('crm.allLeads.allStatuses') },
              ...STATUSES.filter(s => s !== '').map(s => ({ value: s, label: getStatusLabel(t, s) })),
            ]}
            placeholder={t('crm.allLeads.allStatuses')}
          />
          <div className="ml-auto flex rounded-xl border border-gray-200 overflow-hidden h-fit">
            <button onClick={() => setView('list')} className={`px-3 py-2 text-sm ${view === 'list' ? 'text-white' : 'text-gray-600 hover:bg-gray-50'}`} style={view === 'list' ? { backgroundColor: '#ff795d' } : undefined}>☰ {t('crm.allLeads.viewList', 'Liste')}</button>
            <button onClick={() => setView('tiles')} className={`px-3 py-2 text-sm ${view === 'tiles' ? 'text-white' : 'text-gray-600 hover:bg-gray-50'}`} style={view === 'tiles' ? { backgroundColor: '#ff795d' } : undefined}>▦ {t('crm.allLeads.viewTiles', 'Kacheln')}</button>
          </div>
        </div>

        {/* Liste oder Kacheln */}
        {loading ? (
          <p className="bg-white rounded-2xl shadow-sm p-6 text-gray-400 text-sm">{t('common.loading')}</p>
        ) : filteredLeads.length === 0 ? (
          <p className="bg-white rounded-2xl shadow-sm p-6 text-gray-400 text-sm">{t('crm.allLeads.noLeads')}</p>
        ) : view === 'tiles' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredLeads.map(lead => (
              <div key={lead.id}
                onClick={() => navigate(`/admin/crm/leads/${lead.id}`)}
                onContextMenu={e => { e.preventDefault(); setLeadCtx({ x: e.clientX, y: e.clientY, lead }) }}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-gray-900 text-sm">{lead.first_name} {lead.last_name}</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0" style={SOURCE_BADGE_STYLE[lead.source] ?? SOURCE_BADGE_STYLE.sonstiges}>{getSourceLabel(t, lead.source)}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1.5 truncate">✉ {lead.email || '–'}</p>
                <p className="text-xs text-gray-500 truncate">📞 {lead.phone || lead.whatsapp || '–'}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-gray-400">{getStatusLabel(t, lead.status)}</span>
                  <span className="text-[11px] text-gray-300">{formatDate(lead.created_at)}</span>
                </div>
                <p className="text-[10px] text-gray-300 mt-1.5">{t('crm.allLeads.rightClickHint', '↳ Rechtsklick zum Senden')}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {[t('users.table.name'), t('crm.lead.email'), t('crm.lead.phone'), t('crm.lead.source'), t('crm.lead.status'), t('crm.lead.assignedTo'), t('crm.lead.date'),
                      ...(onlyRate ? [t('crm.allLeads.quality', 'Qualität')] : []), t('common.actions')].map(col => (
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
                          {getSourceLabel(t, lead.source)}
                        </span>
                        {adChannelLabel(lead.utm_source) && (
                          <span className="block text-[11px] text-gray-400 mt-0.5">{adChannelLabel(lead.utm_source)}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{getStatusLabel(t, lead.status)}</td>
                      <td className="px-4 py-3 text-gray-600">{lead.assignee?.full_name ?? '–'}</td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(lead.created_at)}</td>
                      {onlyRate && (
                        <td className="px-4 py-3 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => void rateLead(lead, 'gut')} disabled={rating === lead.id}
                              title={t('crm.allLeads.rateGood', 'Guter Lead — Meta lernt daraus')}
                              className="w-9 h-9 rounded-lg border border-green-200 bg-green-50 hover:bg-green-100 disabled:opacity-40 text-base leading-none"
                            >👍</button>
                            <button
                              onClick={() => void rateLead(lead, 'schlecht')} disabled={rating === lead.id}
                              title={t('crm.allLeads.rateBad', 'Schwacher Lead')}
                              className="w-9 h-9 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 disabled:opacity-40 text-base leading-none"
                            >👎</button>
                          </div>
                        </td>
                      )}
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
          </div>
        )}

        {/* Rechtsklick-Kontextmenü auf einer Lead-Kachel */}
        {leadCtx && (
          <>
            <div className="fixed inset-0 z-[65]" onClick={() => setLeadCtx(null)} onContextMenu={e => { e.preventDefault(); setLeadCtx(null) }} />
            <div className="fixed z-[66] bg-white rounded-xl shadow-2xl border border-gray-100 py-1 min-w-[200px]" style={{ top: leadCtx.y, left: leadCtx.x }}>
              <button onClick={() => { setQuickSend({ lead: leadCtx.lead, mode: 'whatsapp' }); setLeadCtx(null) }}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">📱 {t('crm.quick.menuWa', 'WhatsApp an Kunden')}</button>
              <button onClick={() => { setQuickSend({ lead: leadCtx.lead, mode: 'mail' }); setLeadCtx(null) }}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">📧 {t('crm.quick.menuMail', 'Mail an Kunden')}</button>
              <button onClick={() => { setQuickSend({ lead: leadCtx.lead, mode: 'forward' }); setLeadCtx(null) }}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">↗ {t('crm.quick.menuFwd', 'Versenden (an Partner/Developer)')}</button>
            </div>
          </>
        )}

        {quickSend && (
          <LeadQuickSend lead={quickSend.lead} mode={quickSend.mode}
            onClose={() => setQuickSend(null)}
            onSent={(m) => { setQuickSend(null); setToast(m); setTimeout(() => setToast(''), 3500) }} />
        )}

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
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('allLeads.whatsapp', 'WhatsApp')}</label>
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
                      { value: 'de', label: t('allLeads.languageGerman', 'Deutsch') },
                      { value: 'en', label: t('allLeads.languageEnglish', 'English') },
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
                    options={SOURCES.filter(s => s !== '').map(s => ({ value: s, label: getSourceLabel(t, s) }))}
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
