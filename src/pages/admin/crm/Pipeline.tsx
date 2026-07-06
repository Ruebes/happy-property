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
import DeckWizard from '../../../components/crm/DeckWizard'
import RegistrationModal from '../../../components/crm/RegistrationModal'
import DepositInvoiceModal from '../../../components/crm/DepositInvoiceModal'
import PhaseRunToast from '../../../components/crm/PhaseRunToast'
import { sendWhatsApp } from '../../../lib/whatsapp'
import { CustomSelect } from '../../../components/CustomSelect'

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
        content: t('pipeline.leadCreatedActivity', 'Lead angelegt und Deal erstellt.'),
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
              <CustomSelect
                value={form.source}
                onChange={val => set('source', val)}
                className="w-full border rounded-lg text-sm bg-white"
                options={[
                  { value: 'meta', label: t('crm.sources.meta', 'META Werbung') },
                  { value: 'google', label: t('crm.sources.google', 'Google') },
                  { value: 'empfehlung', label: t('crm.sources.empfehlung', 'Empfehlung') },
                  { value: 'sonstiges', label: t('crm.sources.sonstiges', 'Sonstiges') },
                ]}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {t('crm.lead.language', 'Sprache')}
              </label>
              <CustomSelect
                value={form.language}
                onChange={val => set('language', val as 'de' | 'en')}
                className="w-full border rounded-lg text-sm bg-white"
                options={[
                  { value: 'de', label: t('pipeline.languageGerman', 'Deutsch') },
                  { value: 'en', label: t('pipeline.languageEnglish', 'English') },
                ]}
              />
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
            <CustomSelect
              value={form.assigned_to}
              onChange={val => set('assigned_to', val)}
              className="w-full border rounded-lg text-sm bg-white"
              options={[
                { value: '', label: t('crm.lead.noAssignee', '— Niemand —') },
                ...staff.map(s => ({ value: s.id, label: s.full_name })),
              ]}
            />
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
  apptDate?: string | null   // frühester kommender Termin (Folgetermin) → Kachel hervorheben
  onDragStart: (e: React.DragEvent, id: string) => void
  onClick: (leadId: string) => void
  onContextMenu: (e: React.MouseEvent, deal: Deal) => void
}

function DealCard({ deal, apptDate, onDragStart, onClick, onContextMenu }: DealCardProps) {
  const { t } = useTranslation()
  const lead = deal.lead
  const source = (lead?.source ?? 'sonstiges') as keyof typeof SOURCE_BADGE_STYLE
  const badgeStyle = SOURCE_BADGE_STYLE[source] ?? SOURCE_BADGE_STYLE.sonstiges
  // Kommender Termin → Kachel grün markieren, damit Sven Folgetermine sofort sieht.
  const apptLabel = apptDate
    ? new Date(apptDate).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null

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
      onContextMenu={e => onContextMenu(e, deal)}
      className={`border rounded-xl p-3 cursor-pointer hover:shadow-md transition-shadow select-none ${apptDate ? 'bg-emerald-50 border-emerald-300 ring-1 ring-emerald-200' : 'bg-white border-gray-200'}`}
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

      {apptLabel && (
        <p className="text-xs font-semibold text-emerald-700 mb-1 flex items-center gap-1">
          📅 {t('crm.pipeline.apptOn', 'Termin')}: {apptLabel}
        </p>
      )}

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

// ── DealModal: Deal für bestehenden Kunden anlegen ───────────────────────────
interface PickLead { id: string; first_name: string; last_name: string; email: string }

function DealModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const [leads, setLeads]       = useState<PickLead[]>([])
  const [search, setSearch]     = useState('')
  const [selected, setSelected] = useState<PickLead | null>(null)
  const [phase, setPhase]       = useState<DealPhase>('erstkontakt')
  const [existing, setExisting] = useState(0)
  const [saving, setSaving]     = useState(false)

  useEffect(() => {
    void supabase.from('leads').select('id, first_name, last_name, email')
      .order('created_at', { ascending: false }).limit(3000)
      .then(({ data }) => setLeads((data ?? []) as PickLead[]))
  }, [])

  const filtered = search.trim().length >= 2
    ? leads.filter(l => `${l.first_name} ${l.last_name} ${l.email}`.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 8)
    : []

  const pick = async (l: PickLead) => {
    setSelected(l); setSearch('')
    const { data } = await supabase.from('deals').select('phase').eq('lead_id', l.id)
    setExisting((data ?? []).filter(d => d.phase !== 'archiviert' && d.phase !== 'deal_verloren').length)
  }

  const handleSubmit = async () => {
    if (!selected) return
    setSaving(true)
    try {
      const { data: dealData, error } = await supabase.from('deals')
        .insert({ lead_id: selected.id, phase }).select('id').single()
      if (error) throw error
      await supabase.from('activities').insert({
        lead_id: selected.id, deal_id: dealData?.id ?? null, type: 'note', direction: 'outbound',
        content: t('pipeline.dealCreatedManuallyActivity', 'Deal manuell angelegt (Phase: {{phase}}).', { phase }), created_by: profile?.id ?? null,
      })
      onSaved(); onClose()
    } catch (err) {
      console.error('[DealModal] save error', err)
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-800">{t('crm.deal.newDeal', 'Neuer Deal')}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {!selected ? (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{t('crm.deal.pickCustomer', 'Kunde aus der Datenbank')}</label>
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
              placeholder={t('crm.deal.searchPlaceholder', 'Name oder E-Mail suchen…')}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
            {search.trim().length >= 2 && (
              <div className="mt-2 border rounded-lg divide-y max-h-64 overflow-y-auto">
                {filtered.length === 0 && <p className="px-3 py-2 text-sm text-gray-400">{t('crm.deal.noMatch', 'Kein Treffer')}</p>}
                {filtered.map(l => (
                  <button key={l.id} onClick={() => void pick(l)} className="w-full text-left px-3 py-2 hover:bg-orange-50">
                    <p className="text-sm font-medium text-gray-800">{l.first_name} {l.last_name}</p>
                    <p className="text-xs text-gray-500">{l.email}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mb-3 flex items-center justify-between bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-800 truncate">{selected.first_name} {selected.last_name}</p>
              <p className="text-xs text-gray-500 truncate">{selected.email}</p>
            </div>
            <button onClick={() => { setSelected(null); setExisting(0) }} className="text-xs text-orange-600 hover:underline shrink-0 ml-2">{t('crm.deal.change', 'ändern')}</button>
          </div>
        )}

        {selected && existing > 0 && (
          <p className="mb-3 text-xs text-amber-600">{t('crm.deal.hasExisting', '⚠️ Dieser Kunde hat bereits {{n}} offene(n) Deal(s).', { n: existing })}</p>
        )}

        {selected && (
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">{t('crm.deal.startPhase', 'Start-Phase')}</label>
            <select value={phase} onChange={e => setPhase(e.target.value as DealPhase)}
              className="w-full border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300">
              {DEAL_PHASES.map(p => <option key={p} value={p}>{PHASE_ICONS[p]} {t(`crm.phases.${p}`, p)}</option>)}
            </select>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 border hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
          <button onClick={() => void handleSubmit()} disabled={!selected || saving}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
            {saving ? t('crm.deal.creating', 'Wird angelegt…') : t('crm.deal.create', 'Deal anlegen')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Pipeline (main export) ───────────────────────────────────────────────────

export default function Pipeline() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { profile } = useAuth()

  const [deals, setDeals] = useState<Deal[]>([])
  const [apptByLead, setApptByLead] = useState<Record<string, string>>({})   // lead_id → frühester kommender Termin
  const [loading, setLoading] = useState(true)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<DealPhase | null>(null)
  const [showLeadModal, setShowLeadModal] = useState(false)
  const [showDealModal, setShowDealModal] = useState(false)
  const [staff, setStaff] = useState<{ id: string; full_name: string }[]>([])
  const [projectModalDeal, setProjectModalDeal] = useState<Deal | null>(null)
  const [deckDeal, setDeckDeal] = useState<Deal | null>(null)   // Angebot-Wizard (Deck + optional Berechnung + Mail)
  const [registrationDeal, setRegistrationDeal] = useState<Deal | null>(null)
  const [holdDeal,     setHoldDeal]     = useState<Deal | null>(null)
  const [handoverDeal, setHandoverDeal] = useState<Deal | null>(null)
  const [depositDeal,  setDepositDeal]  = useState<Deal | null>(null)   // Anzahlung → Rechnungs-Modal
  const [phaseRun, setPhaseRun] = useState<{ deal: Deal; phase: DealPhase; since: string } | null>(null)  // grüne Live-Meldung
  const [holdContact,  setHoldContact]  = useState(true)
  const [handoverText, setHandoverText] = useState('')
  const [financingDeal, setFinancingDeal] = useState<Deal | null>(null)   // Finanzierung DE → Bemerkung an Christof
  const [financingText, setFinancingText] = useState('')
  const [modalBusy,    setModalBusy]    = useState(false)
  const [savingReg, setSavingReg] = useState(false)
  const [filterSource, setFilterSource] = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; deal: Deal } | null>(null)

  // Kontextmenü mit Escape schließen
  useEffect(() => {
    if (!ctxMenu) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setCtxMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctxMenu])

  const showToastMsg = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  // silent=true: Hintergrund-Refresh (z.B. bei Tab-Fokus) ohne Vollbild-Spinner.
  // Verhindert, dass jede Tab-Rückkehr die Seite blankt — und dass ein evtl.
  // am Auth-Lock hängender Refresh die ganze Seite im Spinner einfriert.
  const fetchDeals = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
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
      if (!silent) setDeals([])   // bei Hintergrund-Refresh alte Daten behalten
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  // Kommende Termine je Lead laden → Kachel in der Pipeline grün markieren (Folgetermine
  // aus dem Termin-Bot sofort sichtbar). Frühester zukünftiger Termin pro Lead gewinnt.
  const fetchAppointments = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('crm_appointments')
        .select('lead_id, start_time')
        .gte('start_time', new Date().toISOString())
        .order('start_time', { ascending: true })
      const map: Record<string, string> = {}
      for (const a of (data as { lead_id: string | null; start_time: string }[]) ?? []) {
        if (a.lead_id && !map[a.lead_id]) map[a.lead_id] = a.start_time
      }
      setApptByLead(map)
    } catch (err) {
      console.error('[Pipeline] fetchAppointments:', err)
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
    fetchAppointments()
  }, [fetchDeals, fetchStaff, fetchAppointments])

  // Re-Fetch bei Tab-Fokus (behebt veraltete Daten nach Token-Refresh im
  // Hintergrund) — STILL, ohne Vollbild-Spinner.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') { fetchDeals(true); fetchAppointments() }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fetchDeals, fetchAppointments])

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

  // Zentrale Phasen-Wechsel-Logik — von Drag-Drop UND Rechtsklick-Menü genutzt.
  const changePhase = async (deal: Deal, targetPhase: DealPhase) => {
    if (deal.phase === targetPhase) return

    const oldPhase = deal.phase

    // Registrierung: show modal first, do NOT change phase yet
    if (targetPhase === 'registrierung') {
      setRegistrationDeal({ ...deal })
      return
    }
    // Hold: Popup mit Kontaktaufnahme-Häkchen
    if (targetPhase === 'hold') { setHoldDeal({ ...deal }); return }
    // Kontakt übergeben: Popup mit Freitext → sofort an Burkhard + Ioulia
    if (targetPhase === 'kontakt_uebergeben') { setHandoverDeal({ ...deal }); return }
    // Anzahlung: Rechnungs-Modal (Netto eingeben → Rechnung an Burkhard). Phase wird
    // erst nach Erstellung im Modal gesetzt.
    if (targetPhase === 'anzahlung') { setDepositDeal({ ...deal }); return }
    // Finanzierung Deutschland: Popup für Bemerkungen zum Kunden → landen zusätzlich in
    // Christofs Mail (Kundendaten + Google-Drive-Zugang). Phase erst im Modal setzen.
    if (targetPhase === 'finanzierung_de') { setFinancingDeal({ ...deal }); return }

    // Optimistic update
    setDeals(prev =>
      prev.map(d => (d.id === deal.id ? { ...d, phase: targetPhase } : d))
    )

    const { error } = await supabase
      .from('deals')
      .update({ phase: targetPhase })
      .eq('id', deal.id)

    if (error) {
      console.error('[Pipeline] phase update error', error)
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

    // Angebot-Wizard (Deck + optional Berechnung/Vergleich + Mail) automatisch öffnen
    if (targetPhase === 'immobilienauswahl') {
      setDeckDeal({ ...deal, phase: targetPhase })
    }

    // Automations-Queue befüllen + grüne Live-Meldung anzeigen
    const since = new Date(Date.now() - 5000).toISOString()
    triggerScheduleMessage(deal.lead_id, deal.id, targetPhase)
    setPhaseRun({ deal: { ...deal, phase: targetPhase }, phase: targetPhase, since })
  }

  const handleDrop = (e: React.DragEvent, targetPhase: DealPhase) => {
    e.preventDefault()
    setDragOver(null)
    if (!dragId) return
    const deal = deals.find(d => d.id === dragId)
    setDragId(null)
    if (!deal) return
    changePhase(deal, targetPhase)
  }

  // Hold bestätigen (mit/ohne Kontaktaufnahme). last_hold_msg_at=jetzt → erste 6-Wochen-Mail in 6 Wochen.
  const confirmHold = async () => {
    if (!holdDeal) return
    const deal = holdDeal
    setModalBusy(true)
    try {
      const now = new Date().toISOString()
      const { error: upErr } = await supabase.from('deals').update({ phase: 'hold', hold_contact: holdContact, last_hold_msg_at: now }).eq('id', deal.id)
      if (upErr) { showToastMsg(`❌ ${upErr.message}`); return }
      setDeals(prev => prev.map(d => d.id === deal.id ? { ...d, phase: 'hold' } : d))
      await supabase.from('activities').insert({ lead_id: deal.lead_id, deal_id: deal.id, type: 'note', direction: 'outbound',
        content: t('pipeline.holdSetActivity', 'Auf Hold gesetzt. Kontaktaufnahme alle 6 Wochen: {{yesNo}}.', { yesNo: holdContact ? t('pipeline.yes', 'JA') : t('pipeline.no', 'nein') }), created_by: profile?.id ?? null })
      setHoldDeal(null); setHoldContact(true)
      showToastMsg(t('crm.phaseSaved', 'Phase gespeichert'))
    } finally { setModalBusy(false) }
  }

  // Kontakt übergeben: Freitext speichern + sofort WhatsApp an Burkhard + Ioulia.
  // Nachrichtentext kommt aus der editierbaren Pipeline-Stufe „Kontakt übergeben"
  // (Fallback = Standardtext). Sendefehler werden SICHTBAR gemeldet, nicht verschluckt.
  const confirmHandover = async () => {
    if (!handoverDeal) return
    const deal = handoverDeal
    setModalBusy(true)
    try {
      const now = new Date().toISOString()
      const { error: upErr } = await supabase.from('deals').update({ phase: 'kontakt_uebergeben', handover_notes: handoverText.trim() || null, handover_at: now, last_handover_ping_at: now }).eq('id', deal.id)
      if (upErr) { showToastMsg(`❌ ${upErr.message}`); return }
      setDeals(prev => prev.map(d => d.id === deal.id ? { ...d, phase: 'kontakt_uebergeben' } : d))
      const { data: lead } = await supabase.from('leads').select('first_name,last_name,phone,whatsapp,email').eq('id', deal.lead_id).maybeSingle()
      const l = lead as { first_name?: string; last_name?: string; phone?: string; whatsapp?: string; email?: string } | null
      const ln = l ? `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() : ''
      const note = handoverText.trim()
      // Basis-Text aus der editierbaren Pipeline-Stufe „Kontakt übergeben" laden (sonst Standard)
      const { data: stageTpl } = await supabase.from('whatsapp_templates')
        .select('message_template').like('event_type', 'stage_kontakt_uebergeben_%').eq('active', true).limit(1).maybeSingle()
      const baseTpl = (stageTpl as { message_template?: string } | null)?.message_template?.trim() || ''
      let msg: string
      if (baseTpl) {
        const vars: Record<string, string> = {
          name: ln, vorname: l?.first_name ?? '', nachname: l?.last_name ?? '',
          phone: l?.phone || l?.whatsapp || '–', whatsapp: l?.whatsapp || l?.phone || '–',
          email: l?.email || '–', notiz: note, bemerkung: note, bemerkungen: note,
        }
        msg = baseTpl
        for (const [k, v] of Object.entries(vars)) msg = msg.split(`{{${k}}}`).join(v || '–')
        msg = msg.replace(/\{\{[^}]+\}\}/g, '–')
        if (note && !/\{\{(notiz|bemerkung|bemerkungen)\}\}/.test(baseTpl)) msg += `\n\n${note}`
      } else {
        msg = t('pipeline.handoverFallbackMessage', 'Bitte bearbeite diesen Kontakt:\n{{name}}\nTel: {{phone}}\nE-Mail: {{email}}{{noteBlock}}', {
          name: ln,
          phone: l?.phone || l?.whatsapp || '–',
          email: l?.email || '–',
          noteBlock: note ? `\n\n${note}` : '',
        })
      }
      const { data: contacts } = await supabase.from('crm_business_contacts').select('first_name, whatsapp, phone')
        .in('id', ['6c9da3ce-9826-4660-9a50-6ff9fc8e70b4', '809bbc0b-fb61-47a5-8f04-e8f7d9ab3c34'])
      const list = (contacts ?? []) as Array<{ first_name: string; whatsapp: string | null; phone: string | null }>
      const fails: string[] = []
      let sent = 0
      if (!list.length) fails.push(t('pipeline.handoverContactsNotFound', 'Burkhard/Ioulia nicht in den Geschäftskontakten gefunden'))
      for (const c of list) {
        const tel = c.whatsapp || c.phone
        if (!tel) { fails.push(t('pipeline.noPhoneOnFile', '{{name}}: keine Nummer hinterlegt', { name: c.first_name })); continue }
        try {
          const res = await sendWhatsApp({ event_type: 'no_show', override_text: msg, lead_id: deal.lead_id, lead_data: { lead_name: c.first_name, lead_phone: tel } })
          if (res.success) sent++
          else fails.push(`${c.first_name}: ${res.error || t('pipeline.unknownError', 'unbekannter Fehler')}`)
        } catch (e) { fails.push(`${c.first_name}: ${e instanceof Error ? e.message : t('pipeline.genericError', 'Fehler')}`) }
      }
      await supabase.from('activities').insert({ lead_id: deal.lead_id, deal_id: deal.id, type: 'whatsapp', direction: 'outbound',
        subject: t('pipeline.handoverActivitySubject', 'Kontakt übergeben an Burkhard + Ioulia'), content: msg, created_by: profile?.id ?? null })
      setHandoverDeal(null); setHandoverText('')
      if (fails.length) showToastMsg(`⚠️ ${t('pipeline.handoverWhatsappProblem', 'Übergeben — WhatsApp-Problem: {{details}}', { details: fails.join(' · ') })}`)
      else showToastMsg(`✅ ${t('pipeline.handoverSentWithCount', '{{status}} — WhatsApp an {{count}} gesendet', { status: t('crm.handoverSent', 'Kontakt übergeben'), count: sent })}`)
    } finally { setModalBusy(false) }
  }

  // Finanzierung Deutschland bestätigen: Bemerkung zum Kunden speichern + Phase setzen.
  // Die Bemerkung fließt über schedule-message zusätzlich in Christofs Mail
  // (Kundendaten + Google-Drive-Zugang).
  const confirmFinancing = async () => {
    if (!financingDeal) return
    const deal = financingDeal
    const oldPhase = deal.phase
    setModalBusy(true)
    try {
      const note = financingText.trim()
      const { error } = await supabase.from('deals')
        .update({ phase: 'finanzierung_de', finanzierung_de_notes: note || null }).eq('id', deal.id)
      if (error) { showToastMsg(`❌ ${error.message}`); return }
      setDeals(prev => prev.map(d => (d.id === deal.id ? { ...d, phase: 'finanzierung_de' } : d)))
      await supabase.from('activities').insert({
        lead_id: deal.lead_id, deal_id: deal.id, type: 'note', direction: 'outbound',
        content: t('crm.activity.phaseChanged', {
          from: t(`crm.phases.${oldPhase}`, oldPhase),
          to: t('crm.phases.finanzierung_de', 'Finanzierung DE'),
          defaultValue: `Phase geändert: ${oldPhase} → finanzierung_de`,
        }) + (note ? `\n\n${t('pipeline.noteForChristof', 'Bemerkung für Christof: {{note}}', { note })}` : ''),
        created_by: profile?.id ?? null,
      })
      const webhookEvent = PHASE_WEBHOOK_EVENTS['finanzierung_de']
      if (webhookEvent) await sendWebhook(webhookEvent, { ...deal, phase: 'finanzierung_de' })
      // Bemerkung ist gespeichert → schedule-message baut Christofs Mail inkl. Bemerkung
      const since = new Date(Date.now() - 5000).toISOString()
      triggerScheduleMessage(deal.lead_id, deal.id, 'finanzierung_de')
      setPhaseRun({ deal: { ...deal, phase: 'finanzierung_de' }, phase: 'finanzierung_de', since })
      setFinancingDeal(null); setFinancingText('')
      showToastMsg(`✅ ${t('crm.financing.done', 'Finanzierung DE — Bemerkung geht an Christof')}`)
    } finally { setModalBusy(false) }
  }

  // Rechtsklick-Kontextmenü auf einer Karte: alle Phasen zum schnellen Wechsel.
  // Menü ~240px breit; Höhe ist dynamisch (viele Einträge) → nur X am rechten Rand
  // einklemmen. Der vertikale Startpunkt + die scrollbare Maximalhöhe werden beim
  // Rendern aus der Klickposition berechnet, damit ALLE Einträge erreichbar bleiben.
  const openCtxMenu = (e: React.MouseEvent, deal: Deal) => {
    e.preventDefault()
    const x = Math.min(e.clientX, window.innerWidth - 248)
    setCtxMenu({ x: Math.max(8, x), y: e.clientY, deal })
  }

  const handleRegistrationConfirm = async (selectedDevelopers: string[], notes: string) => {
    if (!registrationDeal) return
    setSavingReg(true)
    const deal = registrationDeal
    const oldPhase = deal.phase
    try {
      const { error: upErr } = await supabase.from('deals').update({ phase: 'registrierung', registration_notes: notes || null }).eq('id', deal.id)
      if (upErr) throw upErr
      setDeals(prev => prev.map(d => d.id === deal.id ? { ...d, phase: 'registrierung' } : d))

      await supabase.from('activities').insert({
        lead_id:    deal.lead_id,
        deal_id:    deal.id,
        type:       'note',
        direction:  'outbound',
        content:    t('pipeline.registrationActivity', 'Phase geändert: {{from}} → registrierung. Registrierung gesendet an: {{developers}}{{noteBlock}}', {
          from: oldPhase,
          developers: selectedDevelopers.join(', '),
          noteBlock: notes ? t('pipeline.registrationNoteSuffix', '. Bemerkung: {{notes}}', { notes }) : '',
        }),
        created_by: profile?.id ?? null,
      })

      await sendWebhook('deal.registration', deal, {
        developers:  selectedDevelopers,
        bemerkungen: notes,
      })

      // KEIN direktes sendWhatsApp('registration') — dieses INTERNE Template hat
      // recipients=[] und würde über den Fallback an die KUNDEN-Nummer gehen (Datenleck).
      // Der Developer-Versand läuft korrekt über die Stage-Automatik unten
      // (triggerScheduleMessage('registrierung') → stage_registrierung-Regeln an die bc:-Kontakte).

      // Automations-Queue befüllen + grüne Live-Meldung anzeigen
      const since = new Date(Date.now() - 5000).toISOString()
      triggerScheduleMessage(deal.lead_id, deal.id, 'registrierung')
      setRegistrationDeal(null)
      setPhaseRun({ deal: { ...deal, phase: 'registrierung' }, phase: 'registrierung', since })
    } catch (err) {
      console.error('[Pipeline] registrationConfirm:', err)
      showToastMsg(`❌ ${t('pipeline.sendError', 'Fehler beim Senden')}`)
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowDealModal(true)}
              className="px-4 py-2 text-sm rounded-lg font-medium border border-orange-300 text-orange-600 hover:bg-orange-50 transition-colors"
            >
              + {t('crm.deal.newDeal', 'Neuer Deal')}
            </button>
            <button
              onClick={() => setShowLeadModal(true)}
              className="px-4 py-2 text-sm rounded-lg text-white font-medium hover:opacity-90 transition-opacity"
              style={{ backgroundColor: '#ff795d' }}
            >
              + {t('crm.pipeline.newLead', 'Neuer Lead')}
            </button>
          </div>
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
          <CustomSelect
            value={filterSource}
            onChange={val => setFilterSource(val)}
            className="border rounded-lg text-sm bg-white"
            options={[
              { value: '', label: t('crm.pipeline.allSources', 'Alle Quellen') },
              { value: 'meta', label: t('crm.sources.meta', 'META Werbung') },
              { value: 'google', label: t('crm.sources.google', 'Google') },
              { value: 'empfehlung', label: t('crm.sources.empfehlung', 'Empfehlung') },
              { value: 'sonstiges', label: t('crm.sources.sonstiges', 'Sonstiges') },
            ]}
          />
          <CustomSelect
            value={filterAssignee}
            onChange={val => setFilterAssignee(val)}
            className="border rounded-lg text-sm bg-white"
            options={[
              { value: '', label: t('crm.pipeline.allAssignees', 'Alle Zuständigen') },
              ...staff.map(s => ({ value: s.id, label: s.full_name })),
            ]}
          />
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
                            apptDate={deal.lead_id ? apptByLead[deal.lead_id] : undefined}
                            onDragStart={(e, id) => {
                              e.dataTransfer.effectAllowed = 'move'
                              setDragId(id)
                            }}
                            onClick={handleCardClick}
                            onContextMenu={openCtxMenu}
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

      {showDealModal && (
        <DealModal
          onClose={() => setShowDealModal(false)}
          onSaved={fetchDeals}
        />
      )}

      {/* Projekt-Auswahl Modal (öffnet automatisch bei immobilienauswahl) */}
      {projectModalDeal && (
        <ProjectSelectionModal
          dealId={projectModalDeal.id}
          leadName={projectModalDeal.lead
            ? `${projectModalDeal.lead.first_name} ${projectModalDeal.lead.last_name}`
            : t('pipeline.fallbackCustomerName', 'Kunde')}
          onClose={() => setProjectModalDeal(null)}
          onSaved={() => { setProjectModalDeal(null); fetchDeals() }}
        />
      )}

      {/* Angebot-Wizard: Deck + optional Berechnung/Vergleich + Mail → Postausgang */}
      {deckDeal && deckDeal.lead && (
        <DeckWizard
          lead={{ id: deckDeal.lead_id, first_name: deckDeal.lead.first_name, last_name: deckDeal.lead.last_name, email: deckDeal.lead.email ?? null }}
          onClose={() => setDeckDeal(null)}
          onDone={(msg) => { setDeckDeal(null); showToastMsg(msg) }}
        />
      )}

      {/* Registrierung Modal */}
      {depositDeal && (
        <DepositInvoiceModal
          deal={depositDeal}
          onClose={() => setDepositDeal(null)}
          onDone={(msg) => { setDepositDeal(null); showToastMsg(msg); void fetchDeals(true) }}
        />
      )}

      {/* Grüne Live-Meldung: zeigt nach Phasenwechsel jeden automatischen Schritt */}
      {phaseRun && (
        <PhaseRunToast
          deal={phaseRun.deal}
          phase={phaseRun.phase}
          since={phaseRun.since}
          onClose={() => setPhaseRun(null)}
        />
      )}

      {registrationDeal && (
        <RegistrationModal
          leadName={registrationDeal.lead
            ? `${registrationDeal.lead.first_name} ${registrationDeal.lead.last_name}`
            : t('pipeline.fallbackCustomerName', 'Kunde')}
          saving={savingReg}
          onConfirm={handleRegistrationConfirm}
          onCancel={() => setRegistrationDeal(null)}
        />
      )}

      {holdDeal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-1">⏸️ {t('crm.hold.title', 'Auf Hold setzen')}</h2>
            <p className="text-xs text-gray-500 mb-4">{holdDeal.lead ? `${holdDeal.lead.first_name} ${holdDeal.lead.last_name}` : ''}</p>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={holdContact} onChange={e => setHoldContact(e.target.checked)} className="w-4 h-4 mt-0.5 accent-orange-500" />
              <span className="text-sm text-gray-700">{t('crm.hold.contact', 'Kontaktaufnahme: alle 6 Wochen anschreiben (Mail + WhatsApp), bis ich ihn rausziehe oder er abbestellt.')}</span>
            </label>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => { setHoldDeal(null); setHoldContact(true) }} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
              <button onClick={() => void confirmHold()} disabled={modalBusy} className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>{t('common.confirm', 'Bestätigen')}</button>
            </div>
          </div>
        </div>
      )}

      {handoverDeal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-1">🤝 {t('crm.handover.title', 'Kontakt übergeben')}</h2>
            <p className="text-xs text-gray-500 mb-3">{t('crm.handover.hint', 'Geht sofort per WhatsApp an Burkhard + Ioulia. Dein Text wird angehängt.')}</p>
            <textarea rows={4} value={handoverText} onChange={e => setHandoverText(e.target.value)}
              placeholder={t('crm.handover.ph', 'Notiz für Burkhard/Ioulia (z.B. Hintergrund, Wunsch, Dringlichkeit)…')}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-orange-300" />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setHandoverDeal(null); setHandoverText('') }} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
              <button onClick={() => void confirmHandover()} disabled={modalBusy} className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>{modalBusy ? t('crm.handover.sending', 'Sende…') : t('crm.handover.send', 'Übergeben & senden')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Finanzierung Deutschland: Bemerkung zum Kunden → geht zusätzlich in Christofs Mail */}
      {financingDeal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-1">🏦 {t('crm.financing.title', 'Finanzierung Deutschland')}</h2>
            <p className="text-xs text-gray-500 mb-3">{t('crm.financing.hint', 'Christof bekommt Kundendaten + Google-Drive-Zugang. Deine Bemerkungen werden der Mail zusätzlich angehängt.')}</p>
            <textarea rows={4} value={financingText} onChange={e => setFinancingText(e.target.value)}
              placeholder={t('crm.financing.ph', 'Details zum Kunden für Christof (z.B. Einkommen, Eigenkapital, Beschäftigung, Besonderheiten)…')}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-orange-300" />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setFinancingDeal(null); setFinancingText('') }} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
              <button onClick={() => void confirmFinancing()} disabled={modalBusy} className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>{modalBusy ? t('crm.financing.sending', 'Sende…') : t('crm.financing.send', 'An Christof senden')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Rechtsklick-Kontextmenü: Phase schnell wechseln */}
      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setCtxMenu(null)}
            onContextMenu={e => { e.preventDefault(); setCtxMenu(null) }}
          />
          <div
            className="fixed z-50 w-60 overflow-y-auto bg-white rounded-xl shadow-xl border border-gray-200 py-1 animate-fade-in"
            style={{
              left: ctxMenu.x,
              // Startpunkt nie tiefer als 40% der Höhe → darunter bleibt immer genug
              // Platz; die restliche Höhe wird scrollbar (alle Einträge erreichbar).
              top: Math.min(ctxMenu.y, Math.round(window.innerHeight * 0.4)),
              maxHeight: `calc(100vh - ${Math.min(ctxMenu.y, Math.round(window.innerHeight * 0.4))}px - 12px)`,
            }}
          >
            <button
              onClick={() => { const d = ctxMenu.deal; setCtxMenu(null); setDeckDeal(d) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left font-medium text-orange-700 hover:bg-orange-50 border-b border-gray-100">
              📑 {t('crm.pipeline.createDeck', 'Deck / Angebot erstellen')}
            </button>
            <p className="px-3 py-1.5 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
              {t('crm.pipeline.moveTo', 'Verschieben nach')}
            </p>
            {DEAL_PHASES.map(p => {
              const isCurrent = ctxMenu.deal.phase === p
              return (
                <button
                  key={p}
                  disabled={isCurrent}
                  onClick={() => {
                    const d = ctxMenu.deal
                    setCtxMenu(null)
                    changePhase(d, p)
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
                    isCurrent
                      ? 'bg-orange-50 text-orange-600 font-semibold cursor-default'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <span className="text-base leading-none">{PHASE_ICONS[p]}</span>
                  <span className="flex-1 truncate">{t(`crm.phases.${p}`, p)}</span>
                  {isCurrent && (
                    <span className="text-[10px] text-orange-400">
                      {t('crm.pipeline.currentPhase', 'aktuell')}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </>
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
