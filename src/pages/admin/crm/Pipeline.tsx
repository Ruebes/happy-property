import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { Deal, DealPhase } from '../../../lib/crmTypes'
import {
  DEAL_PHASES,
  PHASE_ICONS,
  SOURCE_BADGE_STYLE,
  PHASE_WEBHOOK_EVENTS,
} from '../../../lib/crmTypes'
import ProjectSelectionModal from '../../../components/crm/ProjectSelectionModal'
import RegistrationModal from '../../../components/crm/RegistrationModal'
import { sendWhatsApp } from '../../../lib/whatsapp'

// ── LeadModal ───────────────────────────────────────────────────────────────

interface LeadForm {
  first_name: string
  last_name: string
  email: string
  phone: string
  whatsapp: string
  country: string
  language: 'de' | 'en'
  source: string
  notes: string
  assigned_to: string
  createDeal: boolean
}

interface LeadModalProps {
  onClose: () => void
  onSaved: () => void
  staff: { id: string; full_name: string }[]
}

function LeadModal({ onClose, onSaved, staff }: LeadModalProps) {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<LeadForm>({
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
    createDeal: true,
  })

  const set = (field: keyof LeadForm, value: string | boolean) =>
    setForm(prev => ({ ...prev, [field]: value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const { data: leadData, error: leadError } = await supabase
        .from('leads')
        .insert({
          first_name: form.first_name,
          last_name: form.last_name,
          email: form.email,
          phone: form.phone || null,
          whatsapp: form.whatsapp || null,
          country: form.country || null,
          language: form.language,
          source: form.source,
          notes: form.notes || null,
          assigned_to: form.assigned_to || null,
          status: 'new',
        })
        .select('id')
        .single()

      if (leadError || !leadData) throw leadError

      const newLeadId: string = leadData.id

      let newDealId: string | null = null
      if (form.createDeal) {
        const { data: dealData, error: dealError } = await supabase
          .from('deals')
          .insert({ lead_id: newLeadId, phase: 'erstkontakt' })
          .select('id')
          .single()
        if (dealError) throw dealError
        newDealId = dealData?.id ?? null
      }

      await supabase.from('activities').insert({
        lead_id: newLeadId,
        deal_id: newDealId,
        type: 'note',
        direction: 'outbound',
        content: 'Lead angelegt und Deal erstellt.',
        created_by: profile?.id ?? null,
      })

      // Automations-Queue: lead_created (fire-and-forget)
      supabase.functions.invoke('schedule-message', {
        body: { lead_id: newLeadId, deal_id: newDealId, event_type: 'lead_created' },
      }).catch(e => console.warn('[LeadModal] schedule-message failed:', e))

      onSaved()
      onClose()
    } catch (err) {
      console.error('[LeadModal] save error', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-800">
            {t('crm.lead.newLead', 'Neuer Lead')}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {t('crm.lead.firstName', 'Vorname')} *
              </label>
              <input
                required
                value={form.first_name}
                onChange={e => set('first_name', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {t('crm.lead.lastName', 'Nachname')} *
              </label>
              <input
                required
                value={form.last_name}
                onChange={e => set('last_name', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              {t('crm.lead.email', 'E-Mail')} *
            </label>
            <input
              required
              type="email"
              value={form.email}
              onChange={e => set('email', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {t('crm.lead.phone', 'Telefon')}
              </label>
              <input
                value={form.phone}
                onChange={e => set('phone', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {t('crm.lead.whatsapp', 'WhatsApp')}
              </label>
              <input
                value={form.whatsapp}
                onChange={e => set('whatsapp', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {t('crm.lead.source', 'Quelle')}
              </label>
              <select
                value={form.source}
                onChange={e => set('source', e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white"
              >
                <option value="meta">{t('crm.sources.meta', 'META Werbung')}</option>
                <option value="google">{t('crm.sources.google', 'Google')}</option>
                <option value="empfehlung">{t('crm.sources.empfehlung', 'Empfehlung')}</option>
                <option value="sonstiges">{t('crm.sources.sonstiges', 'Sonstiges')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {t('crm.lead.language', 'Sprache')}
              </label>
              <select
                value={form.language}
                onChange={e => set('language', e.target.value as 'de' | 'en')}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white"
              >
                <option value="de">Deutsch</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              {t('crm.lead.country', 'Land')}
            </label>
            <input
              value={form.country}
              onChange={e => set('country', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              {t('crm.lead.assignedTo', 'Zuständig')}
            </label>
            <select
              value={form.assigned_to}
              onChange={e => set('assigned_to', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white"
            >
              <option value="">{t('crm.lead.noAssignee', '— Niemand —')}</option>
              {staff.map(s => (
                <option key={s.id} value={s.id}>{s.full_name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              {t('crm.lead.notes', 'Notizen')}
            </label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 resize-none"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.createDeal}
              onChange={e => set('createDeal', e.target.checked)}
              className="rounded accent-orange-500"
            />
            {t('crm.lead.createDeal', 'Sofort Deal anlegen?')}
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
            >
              {t('common.cancel', 'Abbrechen')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg text-white font-medium disabled:opacity-60"
              style={{ backgroundColor: '#ff795d' }}
            >
              {saving
                ? t('common.saving', 'Speichern…')
                : t('common.save', 'Speichern')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── DealCard ────────────────────────────────────────────────────────────────

interface DealCardProps {
  deal: Deal
  onDragStart: (e: React.DragEvent, id: string) => void
  onClick: (leadId: string) => void
}

function DealCard({ deal, onDragStart, onClick }: DealCardProps) {
  const { t } = useTranslation()
  const lead = deal.lead
  const source = (lead?.source ?? 'sonstiges') as keyof typeof SOURCE_BADGE_STYLE
  const badgeStyle = SOURCE_BADGE_STYLE[source] ?? SOURCE_BADGE_STYLE.sonstiges

  const updatedDate = new Date(deal.updated_at).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  })

  // Current-phase note preview
  const phaseNoteMap: Partial<Record<string, string | null | undefined>> = {
    registrierung:      deal.registration_notes,
    finanzierung_de:    deal.finanzierung_de_notes,
    finanzierung_cy:    deal.finanzierung_cy_notes,
    immobilienauswahl:  deal.immobilien_notes,
    kaufvertrag:        deal.kaufvertrag_notes,
    provision_erhalten: deal.provision_notes,
  }
  const phaseNote = phaseNoteMap[deal.phase] ?? null

  return (
    <div
      draggable
      onDragStart={e => onDragStart(e, deal.id)}
      onClick={() => lead?.id && onClick(lead.id)}
      className="bg-white border border-gray-200 rounded-xl p-3 cursor-pointer hover:shadow-md transition-shadow select-none"
    >
      <div className="flex items-start justify-between gap-1 mb-2">
        <p className="text-sm font-medium text-gray-800 leading-tight">
          {lead ? `${lead.first_name} ${lead.last_name}` : '—'}
        </p>
        <span
          className="text-xs px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap"
          style={badgeStyle}
        >
          {t(`crm.sources.${source}`, source)}
        </span>
      </div>

      {lead?.assignee?.full_name && (
        <p className="text-xs text-gray-500 mb-1">
          👤 {lead.assignee.full_name}
        </p>
      )}

      {deal.property && (
        <p className="text-xs text-gray-500 mb-1 truncate">
          🏠 {deal.property.project_name}
          {deal.property.unit_number ? ` #${deal.property.unit_number}` : ''}
        </p>
      )}

      {phaseNote && (
        <p className="text-xs text-gray-500 mt-1 italic line-clamp-2">
          💬 {phaseNote.length > 60 ? phaseNote.slice(0, 60) + '…' : phaseNote}
        </p>
      )}

      <p className="text-xs text-gray-400 mt-1">{updatedDate}</p>
    </div>
  )
}

// ── Pipeline (main export) ───────────────────────────────────────────────────

export default function Pipeline() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { profile } = useAuth()

  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<DealPhase | null>(null)
  const [showLeadModal, setShowLeadModal] = useState(false)
  const [staff, setStaff] = useState<{ id: string; full_name: string }[]>([])
  const [projectModalDeal, setProjectModalDeal] = useState<Deal | null>(null)
  const [registrationDeal, setRegistrationDeal] = useState<Deal | null>(null)
  const [savingReg, setSavingReg] = useState(false)
  const [filterSource, setFilterSource] = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState('')

  const showToastMsg = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  const fetchDeals = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('deals')
        .select(`
          id, lead_id, property_id, phase, developer, created_at, updated_at,
          registration_notes, finanzierung_de_notes, finanzierung_cy_notes,
          immobilien_notes, kaufvertrag_notes, provision_notes,
          lead:leads(id, first_name, last_name, email, phone, whatsapp, source, assigned_to,
            assignee:profiles!leads_assigned_to_fkey(full_name, email)
          ),
          property:properties(id, project_name, unit_number)
        `)
        .neq('phase', 'archiviert')
        .order('updated_at', { ascending: false })
      if (error) throw error
      setDeals((data as unknown as Deal[]) ?? [])
    } catch (err) {
      console.error('[Pipeline] fetchDeals:', err)
      setDeals([])
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchStaff = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('role', ['admin', 'verwalter'])
        .order('full_name')
      setStaff((data as { id: string; full_name: string }[]) ?? [])
    } catch (err) {
      console.error('[Pipeline] fetchStaff:', err)
    }
  }, [])

  useEffect(() => {
    fetchDeals()
    fetchStaff()
  }, [fetchDeals, fetchStaff])

  // ── Automation: schedule-message auslösen (fire-and-forget) ────────────────
  const triggerScheduleMessage = (lead_id: string, deal_id: string | null, event_type: string) => {
    supabase.functions.invoke('schedule-message', {
      body: { lead_id, deal_id, event_type },
    }).catch(e => console.warn('[Pipeline] schedule-message failed:', e))
  }

  const sendWebhook = async (
    event: string,
    deal: Deal,
    extra?: Record<string, unknown>
  ) => {
    const lead = deal.lead
    if (!lead) return
    try {
      await supabase.functions.invoke('crm-webhook-sender', {
        body: {
          event,
          lead: {
            name: `${lead.first_name} ${lead.last_name}`,
            email: lead.email,
            phone: lead.phone,
            whatsapp: lead.whatsapp,
          },
          deal_id: deal.id,
          timestamp: new Date().toISOString(),
          ...extra,
        },
      })
    } catch (e) {
      console.warn('[CRM webhook]', e)
    }
  }

  const handleDrop = async (e: React.DragEvent, targetPhase: DealPhase) => {
    e.preventDefault()
    setDragOver(null)
    if (!dragId) return

    const deal = deals.find(d => d.id === dragId)
    if (!deal || deal.phase === targetPhase) {
      setDragId(null)
      return
    }

    const oldPhase = deal.phase

    // Registrierung: show modal first, do NOT change phase yet
    if (targetPhase === 'registrierung') {
      setDragId(null)
      setRegistrationDeal({ ...deal })
      return
    }

    // Optimistic update
    setDeals(prev =>
      prev.map(d => (d.id === dragId ? { ...d, phase: targetPhase } : d))
    )
    setDragId(null)

    const { error } = await supabase
      .from('deals')
      .update({ phase: targetPhase })
      .eq('id', dragId)

    if (error) {
      console.error('[Pipeline] drop update error', error)
      // Roll back
      setDeals(prev =>
        prev.map(d => (d.id === deal.id ? { ...d, phase: oldPhase } : d))
      )
      return
    }

    await supabase.from('activities').insert({
      lead_id: deal.lead_id,
      deal_id: deal.id,
      type: 'note',
      direction: 'outbound',
      content: t('crm.activity.phaseChanged', {
        from: t(`crm.phases.${oldPhase}`, oldPhase),
        to: t(`crm.phases.${targetPhase}`, targetPhase),
        defaultValue: `Phase geändert: ${oldPhase} → ${targetPhase}`,
      }),
      created_by: profile?.id ?? null,
    })

    const webhookEvent = PHASE_WEBHOOK_EVENTS[targetPhase]
    if (webhookEvent) {
      const updatedDeal: Deal = { ...deal, phase: targetPhase }
      await sendWebhook(webhookEvent, updatedDeal)
    }

    // Projektauswahl-Modal automatisch öffnen
    if (targetPhase === 'immobilienauswahl') {
      setProjectModalDeal({ ...deal, phase: targetPhase })
    }

    // Automations-Queue befüllen (fire-and-forget)
    triggerScheduleMessage(deal.lead_id, deal.id, targetPhase)

    showToastMsg(t('crm.phaseSaved', 'Phase gespeichert'))
  }

  const handleRegistrationConfirm = async (selectedDevelopers: string[], notes: string) => {
    if (!registrationDeal) return
    setSavingReg(true)
    const deal = registrationDeal
    const oldPhase = deal.phase
    try {
      await supabase.from('deals').update({ phase: 'registrierung', registration_notes: notes || null }).eq('id', deal.id)
      setDeals(prev => prev.map(d => d.id === deal.id ? { ...d, phase: 'registrierung' } : d))

      await supabase.from('activities').insert({
        lead_id:    deal.lead_id,
        deal_id:    deal.id,
        type:       'note',
        direction:  'outbound',
        content:    `Phase geändert: ${oldPhase} → registrierung. Registrierung gesendet an: ${selectedDevelopers.join(', ')}${notes ? `. Bemerkung: ${notes}` : ''}`,
        created_by: profile?.id ?? null,
      })

      await sendWebhook('deal.registration', deal, {
        developers:  selectedDevelopers,
        bemerkungen: notes,
      })

      // WhatsApp an Registrierungs-Empfänger (fire-and-forget)
      sendWhatsApp({
        event_type: 'registration',
        lead_data: {
          lead_name:    `${deal.lead?.first_name ?? ''} ${deal.lead?.last_name ?? ''}`.trim(),
          lead_phone:   deal.lead?.phone     ?? '',
          lead_email:   deal.lead?.email     ?? '',
          lead_whatsapp: deal.lead?.whatsapp ?? '',
        },
        extra_data: {
          developers: selectedDevelopers.join(', '),
          notes:      notes ?? '',
        },
        lead_id: deal.lead_id,
      }).catch(e => console.warn('[WhatsApp] registration failed:', e))

      // Automations-Queue befüllen (fire-and-forget)
      triggerScheduleMessage(deal.lead_id, deal.id, 'registrierung')

      setRegistrationDeal(null)
      showToastMsg(t('crm.registrationSent', 'Registrierung gesendet'))
    } catch (err) {
      console.error('[Pipeline] registrationConfirm:', err)
      showToastMsg('❌ Fehler beim Senden')
    } finally {
      setSavingReg(false)
    }
  }

  const filteredDeals = deals.filter(deal => {
    const lead = deal.lead
    if (search) {
      const q = search.toLowerCase()
      const name = lead
        ? `${lead.first_name} ${lead.last_name}`.toLowerCase()
        : ''
      const email = lead?.email?.toLowerCase() ?? ''
      if (!name.includes(q) && !email.includes(q)) return false
    }
    if (filterSource && lead?.source !== filterSource) return false
    if (filterAssignee && deal.lead?.assigned_to !== filterAssignee) return false
    return true
  })

  // CRM-Pipeline ist für admin UND verwalter über /admin/crm erreichbar
  const basePath = '/admin/crm'

  const handleCardClick = (leadId: string) => {
    navigate(`/admin/crm/leads/${leadId}`)
  }

  return (
    <DashboardLayout basePath={basePath}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <h1 className="text-xl font-bold text-gray-800">
            {t('crm.pipeline.title', 'Pipeline')}
          </h1>
          <button
            onClick={() => setShowLeadModal(true)}
            className="px-4 py-2 text-sm rounded-lg text-white font-medium hover:opacity-90 transition-opacity"
            style={{ backgroundColor: '#ff795d' }}
          >
            + {t('crm.pipeline.newLead', 'Neuer Lead')}
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-2 mb-4 flex-shrink-0">
          <input
            type="text"
            placeholder={t('crm.pipeline.search', 'Name oder E-Mail suchen…')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 min-w-[180px]"
          />
          <select
            value={filterSource}
            onChange={e => setFilterSource(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
          >
            <option value="">{t('crm.pipeline.allSources', 'Alle Quellen')}</option>
            <option value="meta">{t('crm.sources.meta', 'META Werbung')}</option>
            <option value="google">{t('crm.sources.google', 'Google')}</option>
            <option value="empfehlung">{t('crm.sources.empfehlung', 'Empfehlung')}</option>
            <option value="sonstiges">{t('crm.sources.sonstiges', 'Sonstiges')}</option>
          </select>
          <select
            value={filterAssignee}
            onChange={e => setFilterAssignee(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
          >
            <option value="">{t('crm.pipeline.allAssignees', 'Alle Zuständigen')}</option>
            {staff.map(s => (
              <option key={s.id} value={s.id}>{s.full_name}</option>
            ))}
          </select>
        </div>

        {/* Loading */}
        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <div className="w-8 h-8 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : (
          /* Kanban board */
          <div className="overflow-x-auto flex-1 pb-4">
            <div className="flex gap-3 min-w-max h-full">
              {DEAL_PHASES.map(phase => {
                const phaseDeals = filteredDeals.filter(d => d.phase === phase)
                const isOver = dragOver === phase

                return (
                  <div
                    key={phase}
                    className={`w-60 min-h-[400px] rounded-2xl border-2 flex flex-col transition-colors ${
                      phase === 'deal_verloren'
                        ? isOver
                          ? 'border-red-400 bg-red-100'
                          : 'border-red-200 bg-red-50'
                        : isOver
                          ? 'border-orange-400 bg-orange-50'
                          : 'border-gray-200 bg-gray-50'
                    }`}
                    onDragOver={e => {
                      e.preventDefault()
                      setDragOver(phase)
                    }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={e => handleDrop(e, phase)}
                  >
                    {/* Column header */}
                    <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-gray-200 flex-shrink-0">
                      <span className="text-base leading-none">
                        {PHASE_ICONS[phase]}
                      </span>
                      <span className="text-xs font-semibold text-gray-700 flex-1 truncate">
                        {t(`crm.phases.${phase}`, phase)}
                      </span>
                      <span className="text-xs font-bold text-white bg-gray-400 rounded-full w-5 h-5 flex items-center justify-center flex-shrink-0">
                        {phaseDeals.length}
                      </span>
                    </div>

                    {/* Cards */}
                    <div className="flex-1 overflow-y-auto max-h-[calc(100vh-280px)] p-2 space-y-2">
                      {phaseDeals.length === 0 ? (
                        <p className="text-xs text-gray-400 text-center mt-4 px-2">
                          {t(
                            'crm.pipeline.noDeals',
                            'Keine Deals in dieser Phase.'
                          )}
                        </p>
                      ) : (
                        phaseDeals.map(deal => (
                          <DealCard
                            key={deal.id}
                            deal={deal}
                            onDragStart={(e, id) => {
                              e.dataTransfer.effectAllowed = 'move'
                              setDragId(id)
                            }}
                            onClick={handleCardClick}
                          />
                        ))
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Lead Modal */}
      {showLeadModal && (
        <LeadModal
          staff={staff}
          onClose={() => setShowLeadModal(false)}
          onSaved={fetchDeals}
        />
      )}

      {/* Projekt-Auswahl Modal (öffnet automatisch bei immobilienauswahl) */}
      {projectModalDeal && (
        <ProjectSelectionModal
          dealId={projectModalDeal.id}
          leadName={projectModalDeal.lead
            ? `${projectModalDeal.lead.first_name} ${projectModalDeal.lead.last_name}`
            : 'Kunde'}
          onClose={() => setProjectModalDeal(null)}
          onSaved={() => { setProjectModalDeal(null); fetchDeals() }}
        />
      )}

      {/* Registrierung Modal */}
      {registrationDeal && (
        <RegistrationModal
          leadName={registrationDeal.lead
            ? `${registrationDeal.lead.first_name} ${registrationDeal.lead.last_name}`
            : 'Kunde'}
          saving={savingReg}
          onConfirm={handleRegistrationConfirm}
          onCancel={() => setRegistrationDeal(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-800 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg animate-fade-in">
          {toast}
        </div>
      )}
    </DashboardLayout>
  )
}
