import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { Lead, Deal, Activity, EmailTemplate, DealPhase, DealProject, ScheduledMessage, CrmProject, CrmProjectUnit, CrmUnitDocument, UnitDocType, AiReplyExample, BusinessContact, DeveloperContact } from '../../../lib/crmTypes'
import { PHASE_ICONS, SOURCE_BADGE_STYLE, PHASE_WEBHOOK_EVENTS, adChannelLabel } from '../../../lib/crmTypes'
import ProjectSelectionModal from '../../../components/crm/ProjectSelectionModal'
import UnitPickerModal from '../../../components/crm/UnitPickerModal'
import RegistrationModal from '../../../components/crm/RegistrationModal'
import { deleteGoogleEvent } from '../../../lib/googleCalendar'
import AppointmentModal from '../../../components/crm/AppointmentModal'
import DeckWizard from '../../../components/crm/DeckWizard'
import RechnerWizard from '../../../components/crm/RechnerWizard'
import LeadAngebote from '../../../components/crm/LeadAngebote'
import LeadRegistrations from '../../../components/crm/LeadRegistrations'
import { sendWhatsApp } from '../../../lib/whatsapp'
import type { CrmAppointment } from '../../../lib/crmTypes'
import { CustomSelect } from '../../../components/CustomSelect'

type TabId = 'overview' | 'notes' | 'activities' | 'ai' | 'emails' | 'tasks' | 'documents' | 'appointments' | 'scheduled' | 'portal' | 'wohnung'

const ACTIVITY_ICONS: Record<string, string> = {
  call: '📞',
  email: '📧',
  whatsapp: '📱',
  note: '📝',
  meeting: '🤝',
  task: '✅',
}

// WhatsApp „Click to chat": Nummer auf internationales Format bringen (ohne + / ohne
// führende 0, DE-Default 49) und wa.me-Link bilden — öffnet WhatsApp Desktop/Web/iPhone
// mit dem Chat des Kontakts. Was Sven dort sendet, synct TimelinesAI zurück ins CRM.
function waLink(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = raw.replace(/[^\d+]/g, '')
  if (d.startsWith('+'))       d = d.slice(1)
  else if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0'))  d = '49' + d.slice(1)
  d = d.replace(/\D/g, '')
  return d.length >= 8 ? `https://wa.me/${d}` : null
}

// KI-Antwort: Badge-Farben je Status (Label kommt aus i18n: crm.ai.st_<status>)
const AI_STATUS_CLS: Record<string, string> = {
  approved:  'bg-green-100 text-green-700',
  edited:    'bg-blue-100 text-blue-700',
  auto_sent: 'bg-purple-100 text-purple-700',
  discarded: 'bg-gray-100 text-gray-500',
  pending:   'bg-amber-100 text-amber-700',
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { profile } = useAuth()

  // Core data
  const [lead, setLead] = useState<Lead | null>(null)

  // ── Sales-Deck-Wizard (personalisierte Decks → Postausgang) ──────────────────
  const [showWizard, setShowWizard] = useState(false)
  const [showRechner, setShowRechner] = useState(false)

  // ── Google-Drive-Kundenordner anlegen / öffnen ───────────────────────────────
  const [driveBusy, setDriveBusy] = useState(false)
  const createDriveFolder = async () => {
    if (!lead || driveBusy) return
    setDriveBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('create-client-drive-folder', {
        body: { lead_id: lead.id, extra_emails: [] },
      })
      if (error) throw new Error(error.message)
      const d = data as { folder_id?: string; folder_url?: string; error?: string }
      if (d?.error) throw new Error(d.error)
      if (d.folder_url) setLead({ ...lead, drive_folder_id: d.folder_id ?? null, drive_folder_url: d.folder_url })
    } catch (e) {
      alert(t('crm.lead.driveError', 'Drive-Ordner konnte nicht erstellt werden') + ': ' + (e instanceof Error ? e.message : ''))
    } finally {
      setDriveBusy(false)
    }
  }
  const [deal, setDeal] = useState<Deal | null>(null)
  const [activities, setActivities] = useState<Activity[]>([])
  const [tasks, setTasks] = useState<Activity[]>([])
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [staff, setStaff] = useState<{ id: string; full_name: string }[]>([])
  const [dealProjects, setDealProjects] = useState<DealProject[]>([])
  // Ref für stabile Lesbarkeit in Effects ohne dealProjects als Dependency
  const dealProjectsRef = useRef<DealProject[]>([])
  const [showProjectModal, setShowProjectModal] = useState(false)
  const [showRegistrationModal, setShowRegistrationModal] = useState(false)
  const [savingReg, setSavingReg] = useState(false)
  const [appointments, setAppointments] = useState<CrmAppointment[]>([])
  const [showApptModal, setShowApptModal] = useState(false)
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([])
  const [cancellingMsg, setCancellingMsg] = useState<string | null>(null)

  // Portal-Login-Historie
  const [portalLoginLog, setPortalLoginLog] = useState<{ id: string; created_at: string }[]>([])

  // Unit-Dokumente + Bilder (Tab „Wohnung")
  const [unitDocs,         setUnitDocs]         = useState<CrmUnitDocument[]>([])
  const [unitImages,       setUnitImages]        = useState<string[]>([])
  const [uploadingUnitDoc, setUploadingUnitDoc]  = useState(false)
  const [uploadingUnitImg, setUploadingUnitImg]  = useState(false)
  const [unitDocForm,      setUnitDocForm]       = useState({ name: '', doc_type: 'sonstiges' as UnitDocType, notes: '' })
  const [unitDocFile,      setUnitDocFile]       = useState<File | null>(null)
  const unitDocFileRef  = useRef<HTMLInputElement>(null)
  const unitImgFileRef  = useRef<HTMLInputElement>(null)

  // WhatsApp preview (no_show)
  const [showWaPreview, setShowWaPreview] = useState(false)
  const [waMsg, setWaMsg]               = useState('')
  const [sendingWa, setSendingWa]       = useState(false)

  // ── KI-Antwort-Agent (nur Entwurf — sendet NICHTS) ──────────────
  const [aiExamples,      setAiExamples]      = useState<AiReplyExample[]>([])
  const [aiInbound,       setAiInbound]        = useState('')   // Kunden-Nachricht (Basis für Entwurf)
  const [aiChannel,       setAiChannel]        = useState<'whatsapp' | 'email'>('whatsapp')
  const [aiDraft,         setAiDraft]          = useState('')   // editierbarer Entwurf
  const [aiDraftOriginal, setAiDraftOriginal]  = useState('')   // unveränderter KI-Vorschlag (für approved/edited)
  const [aiExamplesUsed,  setAiExamplesUsed]   = useState<number | null>(null)
  const [aiGenerating,    setAiGenerating]     = useState(false)
  const [aiSaving,        setAiSaving]         = useState(false)
  const [aiUnavailable,   setAiUnavailable]    = useState(false) // Edge Function noch nicht deployt
  const [aiCopied,        setAiCopied]         = useState(false)

  // UI state
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const tabsRef = useRef<HTMLDivElement | null>(null)
  // Tab wechseln UND hinscrollen — sonst wechselt der Tab unsichtbar weit unten
  // (Direkt-Aktions-Kacheln „Mail/WhatsApp/Notiz/Aufgabe" wirkten dadurch tot).
  const goTab = (tab: TabId) => {
    setActiveTab(tab)
    setTimeout(() => tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [saving, setSaving] = useState(false)

  // Stammdaten edit
  const [editingLead, setEditingLead] = useState(false)
  const [leadForm, setLeadForm] = useState({
    first_name: '', last_name: '', email: '', phone: '', whatsapp: '',
    alt_emails: '', alt_phones: '',
    country: '', source: 'sonstiges', language: 'de', notes: '', assigned_to: '',
  })
  const [savingLead, setSavingLead] = useState(false)

  // Activity form
  const [actForm, setActForm] = useState({ type: 'note', direction: 'outbound', subject: '', content: '' })
  const [savingAct, setSavingAct] = useState(false)

  // Task form
  const [taskForm, setTaskForm] = useState({ subject: '', content: '', scheduled_at: '', assigned_to: '' })
  const [savingTask, setSavingTask] = useState(false)

  // Email / Nachrichten-Composer
  const [emailForm, setEmailForm] = useState({ templateId: '', subject: '', body: '' })
  const [sendingEmail, setSendingEmail] = useState(false)
  // Empfängerauswahl + Kanal + Objekt-Bemerkungen
  const [composeChannel, setComposeChannel] = useState<'email' | 'whatsapp'>('email')
  const [composeTo,      setComposeTo]      = useState('client')   // 'client' | `bc:<id>` | `dc:<id>`
  const [bemerkungen,    setBemerkungen]    = useState('')
  const [businessContacts, setBusinessContacts] = useState<BusinessContact[]>([])
  const [devContacts,      setDevContacts]      = useState<(DeveloperContact & { developer_name: string | null })[]>([])

  // Deal action form fields
  const [driveUrl, setDriveUrl] = useState('')
  const [commissionAmount, setCommissionAmount] = useState('')
  const [depositDate, setDepositDate] = useState('')
  const [financingRequired, setFinancingRequired] = useState(false)

  // Phase-specific notes
  const [regNotes, setRegNotes]         = useState('')
  const [finDENotes, setFinDENotes]     = useState('')
  const [finCYNotes, setFinCYNotes]     = useState('')
  const [immoNotes, setImmoNotes]       = useState('')
  const [kaufNotes, setKaufNotes]       = useState('')
  const [provNotes, setProvNotes]       = useState('')

  // Unit picker + assignment
  const [showUnitPicker, setShowUnitPicker] = useState(false)
  const [pickedUnit, setPickedUnit] = useState<{
    unit: CrmProjectUnit
    projectName: string
  } | null>(null)

  // Unit edit modal
  const [showUnitEdit,        setShowUnitEdit]        = useState(false)
  const [unitEditData,        setUnitEditData]        = useState<CrmProjectUnit | null>(null)
  const [savingUnit,          setSavingUnit]          = useState(false)
  const [unitEditForm,        setUnitEditForm]        = useState({
    unit_number: '', block: '', type: 'apartment', floor: '',
    bedrooms: '', bathrooms: '', size_sqm: '', terrace_sqm: '',
    price_net: '', price_gross: '', vat_rate: '0',
    status: 'active', is_furnished: false, rental_type: '',
    handover_date: '', notes: '',
  })
  // Portal-Zugangs-Check (wird beim Öffnen des Unit-Edit-Modals geprüft)
  const [portalAccessChecked, setPortalAccessChecked] = useState(false)
  const [customerHasAccess,   setCustomerHasAccess]   = useState(false)
  const [checkingAccess,      setCheckingAccess]      = useState(false)

  // Auto-created owner password modal
  const [showNewOwnerPwModal,  setShowNewOwnerPwModal]  = useState(false)
  const [newOwnerPassword,     setNewOwnerPassword]     = useState('')
  const [newOwnerPasswordEmail,setNewOwnerPasswordEmail]= useState('')
  const [newOwnerPwCopied,     setNewOwnerPwCopied]     = useState(false)
  const [resendingPortal,      setResendingPortal]      = useState(false)

  // Portal access (always accessible)
  // (Portalzugang-Modal entfernt — Versand läuft jetzt direkt per Klick, siehe openPortal)

  // Unit picker project pre-filter (when activated from a deal_project card)
  const [unitPickerProjectId, setUnitPickerProjectId] = useState<string | null>(null)

  // Unit edit: project context for CREATE mode (when no crm_project_unit exists yet)
  const [unitEditProjectId, setUnitEditProjectId] = useState<string | null>(null)

  // Unit selection step (choose existing unit or create new)
  const [showUnitSelect, setShowUnitSelect]       = useState(false)
  const [unitSelectProjectId, setUnitSelectProjectId] = useState<string | null>(null)
  const [unitSelectUnits, setUnitSelectUnits]     = useState<CrmProjectUnit[]>([])
  const [unitSelectProject, setUnitSelectProject] = useState<{ id: string; name: string; location: string | null } | null>(null)

  // ── Toast helper ────────────────────────────────────────────────
  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  // ── Notizen-Reiter: freies Notizfeld (lead.notes) + Gesprächsnotizen-Historie ──
  const [notesDraft, setNotesDraft] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  useEffect(() => { setNotesDraft(lead?.notes ?? '') }, [lead?.id])   // beim Laden übernehmen
  const saveNotes = async () => {
    if (!lead) return
    setSavingNotes(true)
    const { error } = await supabase.from('leads').update({ notes: notesDraft.trim() || null, updated_at: new Date().toISOString() }).eq('id', lead.id)
    setSavingNotes(false)
    if (error) { showToast(`❌ ${error.message}`); return }
    setLead({ ...lead, notes: notesDraft.trim() || null })
    showToast(t('crm.notesSaved', '✅ Notizen gespeichert'))
  }

  // ── KI-Antwort-Agent: Daten + Aktionen (sendet NICHTS) ──────────
  // Lädt die zuletzt für diesen Lead erzeugten/freigegebenen Entwürfe (Audit + „gelernt").
  const loadAiExamples = useCallback(async () => {
    if (!id) return
    const { data } = await supabase
      .from('ai_reply_examples')
      .select('*')
      .eq('lead_id', id)
      .order('created_at', { ascending: false })
      .limit(20)
    setAiExamples((data ?? []) as AiReplyExample[])
  }, [id])

  useEffect(() => { loadAiExamples() }, [loadAiExamples])

  // Letzte eingehende Kundennachricht (WhatsApp/E-Mail) als Entwurfs-Basis übernehmen.
  const adoptLatestInbound = () => {
    const latest = activities.find(
      (a) => a.direction === 'inbound' && (a.type === 'whatsapp' || a.type === 'email'),
    )
    if (!latest) { showToast(t('crm.ai.noInbound', 'Keine eingehende Nachricht gefunden')); return }
    setAiInbound(latest.content ?? '')
    setAiChannel(latest.type === 'email' ? 'email' : 'whatsapp')
    setAiDraft(''); setAiDraftOriginal(''); setAiExamplesUsed(null)
  }

  // Entwurf von der Edge Function holen. Bei nicht-deployter Funktion → „nicht aktiviert"-Hinweis.
  const handleGenerateDraft = async () => {
    if (!id || !aiInbound.trim()) return
    setAiGenerating(true); setAiUnavailable(false)
    try {
      const { data, error } = await supabase.functions.invoke('ai-draft-reply', {
        body: { lead_id: id, inbound_text: aiInbound.trim(), channel: aiChannel },
      })
      if (error) {
        // Funktion (noch) nicht erreichbar/deployt → freundlicher „nicht aktiviert"-Hinweis.
        // FunctionsFetchError = Netzwerk/nicht erreichbar; HTTP 404 = Funktion nicht deployt.
        const ctx = (error as { context?: Response }).context
        const notDeployed =
          (error as { name?: string }).name === 'FunctionsFetchError' ||
          (ctx && ctx.status === 404)
        if (notDeployed) {
          setAiUnavailable(true)
        } else {
          let msg = (error as { message?: string }).message ?? 'Fehler'
          try {
            if (ctx && typeof ctx.json === 'function') {
              const errBody = await ctx.json() as { error?: string }
              if (errBody?.error) msg = errBody.error
            }
          } catch { /* ignore */ }
          showToast(`${t('crm.ai.errGen', 'KI-Fehler')}: ${msg}`)
        }
        return
      }
      const resp = data as { draft?: string; examples_used?: number; error?: string } | null
      if (resp?.error) { showToast(`${t('crm.ai.errGen', 'KI-Fehler')}: ${resp.error}`); return }
      const draft = (resp?.draft ?? '').trim()
      if (!draft) { showToast(t('crm.ai.errEmpty', 'KI hat keinen Entwurf geliefert')); return }
      setAiDraft(draft)
      setAiDraftOriginal(draft)
      setAiExamplesUsed(typeof resp?.examples_used === 'number' ? resp.examples_used : null)
    } catch {
      setAiUnavailable(true)
    } finally {
      setAiGenerating(false)
    }
  }

  // Freigeben: speichert das Paar (inbound → final) als gelerntes Beispiel und kopiert den Text.
  // status 'approved' wenn 1:1 übernommen, 'edited' wenn Sven korrigiert hat. Sendet NICHTS.
  const handleApproveDraft = async () => {
    if (!id || !aiDraft.trim()) return
    setAiSaving(true)
    try {
      const edited = aiDraft.trim() !== aiDraftOriginal.trim()
      const { error } = await supabase.from('ai_reply_examples').insert({
        lead_id:      id,
        channel:      aiChannel,
        inbound_text: aiInbound.trim() || null,
        ai_draft:     aiDraftOriginal || null,
        final_text:   aiDraft.trim(),
        status:       edited ? 'edited' : 'approved',
        is_learning:  true,
      })
      if (error) { showToast(`${t('crm.ai.errSave', 'Konnte nicht speichern')}: ${error.message}`); return }
      try {
        await navigator.clipboard.writeText(aiDraft.trim())
        setAiCopied(true)
        setTimeout(() => setAiCopied(false), 2500)
      } catch { /* Zwischenablage optional */ }
      showToast(edited
        ? t('crm.ai.savedEdited', 'Freigegeben (korrigiert) & kopiert – das System lernt daraus')
        : t('crm.ai.savedApproved', 'Freigegeben & kopiert – das System lernt daraus'))
      setAiDraft(''); setAiDraftOriginal(''); setAiExamplesUsed(null)
      await loadAiExamples()
    } finally {
      setAiSaving(false)
    }
  }

  // Verwerfen: optionaler Audit-Eintrag (is_learning=false), wird NICHT gelernt.
  const handleDiscardDraft = async () => {
    if (!id) { setAiDraft(''); setAiDraftOriginal(''); setAiExamplesUsed(null); return }
    if (!aiDraftOriginal) { setAiDraft(''); setAiDraftOriginal(''); setAiExamplesUsed(null); return }
    setAiSaving(true)
    try {
      await supabase.from('ai_reply_examples').insert({
        lead_id:      id,
        channel:      aiChannel,
        inbound_text: aiInbound.trim() || null,
        ai_draft:     aiDraftOriginal || null,
        final_text:   null,
        status:       'discarded',
        is_learning:  false,
      })
      showToast(t('crm.ai.discarded', 'Entwurf verworfen'))
      setAiDraft(''); setAiDraftOriginal(''); setAiExamplesUsed(null)
      await loadAiExamples()
    } finally {
      setAiSaving(false)
    }
  }

  // ── Data fetching ───────────────────────────────────────────────
  const fetchAll = useCallback(async (silent = false) => {
    if (!id) return
    if (!silent) setLoading(true)
    try {
      const [
        { data: leadData },
        { data: dealData },
        { data: actData },
        { data: taskData },
        { data: tplData },
        { data: staffData },
      ] = await Promise.all([
        supabase
          .from('leads')
          .select('*, assignee:profiles!leads_assigned_to_fkey(full_name, email)')
          .eq('id', id)
          .single(),
        supabase
          .from('deals')
          .select('*, property:properties(id, project_name, unit_number)')
          .eq('lead_id', id)
          .neq('phase', 'archiviert')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('activities')
          .select('*, creator:profiles!activities_created_by_fkey(full_name)')
          .eq('lead_id', id)
          .not('type', 'eq', 'task')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('activities')
          .select('*, creator:profiles!activities_created_by_fkey(full_name)')
          .eq('lead_id', id)
          .eq('type', 'task')
          .is('completed_at', null)
          .order('scheduled_at', { ascending: true })
          .limit(100),
        supabase.from('email_templates').select('*').order('name'),
        supabase
          .from('profiles')
          .select('id, full_name')
          .in('role', ['admin', 'verwalter'])
          .order('full_name'),
      ])

      setLead(leadData as unknown as Lead)
      const dealResult = dealData as unknown as Deal | null
      setDeal(dealResult)
      setActivities((actData ?? []) as unknown as Activity[])
      setTasks((taskData ?? []) as unknown as Activity[])
      setTemplates((tplData ?? []) as unknown as EmailTemplate[])
      setStaff((staffData ?? []) as { id: string; full_name: string }[])

      if (dealResult) {
        setDriveUrl(dealResult.google_drive_url ?? '')
        setFinancingRequired(dealResult.financing_required ?? false)
        setRegNotes(dealResult.registration_notes ?? '')
        setFinDENotes(dealResult.finanzierung_de_notes ?? '')
        setFinCYNotes(dealResult.finanzierung_cy_notes ?? '')
        setImmoNotes(dealResult.immobilien_notes ?? '')
        setKaufNotes(dealResult.kaufvertrag_notes ?? '')
        setProvNotes(dealResult.provision_notes ?? '')
      }

      // ── Batch 2: alle sekundären Queries parallel ─────────────────────────────
      const [
        { data: dpData },
        { data: apptData },
        { data: schedData },
        { data: loginData },
        { data: docsData },
        { data: unitImgData },
      ] = await Promise.all([
        // deal_projects
        dealResult?.id
          ? supabase.from('deal_projects')
              .select('*, project:crm_projects(id,name,images,location)')
              .eq('deal_id', dealResult.id)
              .order('created_at')
          : Promise.resolve({ data: [] }),
        // appointments
        supabase.from('crm_appointments')
          .select('*')
          .eq('lead_id', id)
          .order('start_time', { ascending: true }),
        // scheduled messages
        supabase.from('scheduled_messages')
          .select('*')
          .eq('lead_id', id)
          .order('scheduled_at', { ascending: true }),
        // portal login log
        leadData?.profile_id
          ? supabase.from('portal_logins')
              .select('id, created_at')
              .eq('profile_id', leadData.profile_id)
              .order('created_at', { ascending: false })
              .limit(50)
          : Promise.resolve({ data: [] }),
        // unit documents
        dealResult?.unit_id
          ? supabase.from('crm_unit_documents')
              .select('*')
              .eq('unit_id', dealResult.unit_id)
              .order('created_at', { ascending: false })
          : Promise.resolve({ data: [] }),
        // unit images
        dealResult?.unit_id
          ? supabase.from('crm_project_units')
              .select('images')
              .eq('id', dealResult.unit_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ])

      const dp = (dpData ?? []) as unknown as DealProject[]
      dealProjectsRef.current = dp
      setDealProjects(dp)
      setAppointments((apptData ?? []) as unknown as CrmAppointment[])
      setScheduledMessages((schedData ?? []) as unknown as ScheduledMessage[])
      setPortalLoginLog((loginData ?? []) as { id: string; created_at: string }[])
      setUnitDocs((docsData ?? []) as CrmUnitDocument[])
      setUnitImages((unitImgData as { images: string[] } | null)?.images ?? [])
    } catch (err) {
      console.error('[LeadDetail] fetchAll:', err)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  // ── pickedUnit aus deal.unit_id wiederherstellen (nach Reload / Navigation) ──
  // Läuft nur wenn deal.unit_id sich ändert. dealProjectsRef statt State-Dep
  // verhindert Re-Fetch-Loop bei jedem fetchAll (dealProjects erzeugt neue Referenz).
  useEffect(() => {
    if (!deal?.unit_id) return
    let cancelled = false
    supabase
      .from('crm_project_units')
      .select('*')
      .eq('id', deal.unit_id)
      .maybeSingle()
      .then(({ data: unitData }) => {
        if (cancelled || !unitData) return
        const unit = unitData as CrmProjectUnit
        setPickedUnit(prev => {
          if (prev?.unit.id === unit.id) return prev
          const dp = dealProjectsRef.current.find(d => d.project_id === unit.project_id)
          return { unit, projectName: dp?.project?.name ?? '' }
        })
      })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal?.unit_id])

  // ── Selbstheilender Properties-Sync ─────────────────────────────────────────
  // Wenn die zugewiesene Unit bereits ein Portal-Objekt hat, aber deal.property_id
  // fehlt → nur neu VERKNÜPFEN. KEIN automatisches Neu-Anlegen, sonst tauchen
  // bewusst gelöschte Portal-Objekte beim nächsten Öffnen wieder auf.
  // Läuft nur einmal (sobald deal.property_id gesetzt ist, greift die Bedingung nicht mehr).
  useEffect(() => {
    if (!lead?.profile_id || !deal?.unit_id || deal?.property_id) return
    async function repairPropertiesEntry() {
      if (!lead?.profile_id || !deal?.unit_id) return
      try {
        const { data: unitData } = await supabase
          .from('crm_project_units')
          .select('property_id')
          .eq('id', deal.unit_id!)
          .maybeSingle()
        if (!unitData) return
        const unit = unitData as { property_id: string | null }
        // Nur verknüpfen, wenn die Unit bereits ein Portal-Objekt besitzt.
        // Bewusst KEIN Neu-Anlegen → gelöschte Objekte bleiben gelöscht.
        if (unit.property_id) {
          await supabase.from('deals').update({ property_id: unit.property_id }).eq('id', deal.id)
          fetchAll(true)
        }
      } catch (err) {
        console.error('[LeadDetail] repairPropertiesEntry:', err)
      }
    }
    void repairPropertiesEntry()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.profile_id, deal?.unit_id, deal?.property_id])

  // ── Empfänger-Kontakte laden (einmalig) ──────────────────────────────────────
  // Geschäftskontakte + Developer-Ansprechpartner als wählbare Empfänger im
  // Nachrichten-Composer. Robust ohne FK-Embed: Developer-Namen separat mappen.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [bcRes, dcRes, devRes] = await Promise.all([
          supabase.from('crm_business_contacts').select('*').order('first_name'),
          supabase.from('crm_developer_contacts').select('*').order('name'),
          supabase.from('crm_developers').select('id, name'),
        ])
        if (cancelled) return
        if (bcRes.data) setBusinessContacts(bcRes.data as BusinessContact[])
        if (dcRes.data) {
          const devMap = new Map(((devRes.data ?? []) as { id: string; name: string }[]).map(d => [d.id, d.name]))
          setDevContacts((dcRes.data as DeveloperContact[]).map(c => ({
            ...c,
            developer_name: devMap.get(c.developer_id) ?? null,
          })))
        }
      } catch (err) {
        console.error('[LeadDetail] load recipient contacts:', err)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // ── E-Mail-Benachrichtigung beim Upload ──────────────────────────────────────
  const notifyCustomerUpload = (fileName: string, kind: 'Dokument' | 'Bild') => {
    if (!lead?.email) return
    const firstName = lead.first_name
    const kindLabel = kind === 'Bild' ? t('leadDetail.uploadMailKindImage', 'Bild') : t('leadDetail.uploadMailKindDocument', 'Dokument')
    supabase.functions.invoke('send-email', {
      body: {
        to:      lead.email,
        lead_id: id,
        subject: t('leadDetail.uploadMailSubject', 'Neue Datei in Ihrem Happy Property Portal'),
        html:    t('leadDetail.uploadMailBody', '<p>Hallo {{firstName}},</p>\n<p>es wurde ein neues <strong>{{kind}}</strong> für Ihre Immobilie hochgeladen: <em>{{fileName}}</em></p>\n<p>Sie können es jederzeit in Ihrem persönlichen Portal einsehen.</p>\n<p>Viele Grüße<br>Ihr Happy Property Team</p>', { firstName, kind: kindLabel, fileName }),
      },
    }).catch(err => console.warn('[LeadDetail] notifyCustomerUpload failed:', err))
  }

  // ── Unit-Dokument hochladen ───────────────────────────────────────────────────
  const handleUploadUnitDoc = async () => {
    if (!deal?.unit_id || !unitDocFile || !unitDocForm.name.trim()) return
    setUploadingUnitDoc(true)
    try {
      const ext  = unitDocFile.name.split('.').pop() ?? 'pdf'
      const path = `unit-documents/${deal.unit_id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('unit-documents').upload(path, unitDocFile, { upsert: false })
      if (upErr) throw upErr
      const { data: unitForProject } = await supabase
        .from('crm_project_units').select('project_id').eq('id', deal.unit_id).maybeSingle()
      await supabase.from('crm_unit_documents').insert({
        unit_id:     deal.unit_id,
        project_id:  (unitForProject as { project_id: string } | null)?.project_id ?? null,
        name:        unitDocForm.name.trim(),
        file_path:   path,
        file_name:   unitDocFile.name,
        file_size:   unitDocFile.size,
        doc_type:    unitDocForm.doc_type,
        notes:       unitDocForm.notes.trim() || null,
        uploaded_by: profile?.id ?? null,
      })
      setUnitDocFile(null)
      setUnitDocForm({ name: '', doc_type: 'sonstiges', notes: '' })
      if (unitDocFileRef.current) unitDocFileRef.current.value = ''
      notifyCustomerUpload(unitDocForm.name.trim(), 'Dokument')
      showToast(t('leadDetail.toastDocUploaded', '✅ Dokument hochgeladen'))
      await fetchAll(true)
    } catch (err) {
      showToast(`❌ ${err instanceof Error ? err.message : t('leadDetail.errUploadFailed', 'Fehler beim Upload')}`)
    } finally {
      setUploadingUnitDoc(false)
    }
  }

  // ── Unit-Dokument öffnen ──────────────────────────────────────────────────────
  const handleOpenUnitDoc = async (doc: CrmUnitDocument) => {
    const { data } = await supabase.storage
      .from('unit-documents').createSignedUrl(doc.file_path, 300)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  // ── Unit-Dokument löschen ─────────────────────────────────────────────────────
  const handleDeleteUnitDoc = async (doc: CrmUnitDocument) => {
    if (!window.confirm(t('leadDetail.confirmDeleteDoc', 'Dokument wirklich löschen?'))) return
    await supabase.storage.from('unit-documents').remove([doc.file_path])
    await supabase.from('crm_unit_documents').delete().eq('id', doc.id)
    await fetchAll(true)
  }

  // ── Unit-Bilder hochladen ─────────────────────────────────────────────────────
  const handleUploadUnitImages = async (files: FileList) => {
    if (!deal?.unit_id || files.length === 0) return
    setUploadingUnitImg(true)
    try {
      const newUrls: string[] = []
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const ext  = file.name.split('.').pop() ?? 'jpg'
        const path = `units/${deal.unit_id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        const { error } = await supabase.storage
          .from('unit-images').upload(path, file, { upsert: false })
        if (error) continue
        const { data } = supabase.storage.from('unit-images').getPublicUrl(path)
        if (data?.publicUrl) newUrls.push(data.publicUrl)
      }
      if (newUrls.length === 0) { showToast(`❌ ${t('leadDetail.uploadFailed', 'Upload fehlgeschlagen')}`); return }
      const updated = [...unitImages, ...newUrls]
      await supabase.from('crm_project_units').update({ images: updated }).eq('id', deal.unit_id)
      setUnitImages(updated)
      const imageCountLabel = newUrls.length > 1
        ? t('leadDetail.newImagesCountPlural', '{{count}} neue Bilder', { count: newUrls.length })
        : t('leadDetail.newImagesCountSingular', '{{count}} neues Bild', { count: newUrls.length })
      notifyCustomerUpload(imageCountLabel, 'Bild')
      showToast(newUrls.length > 1
        ? t('leadDetail.toastImagesUploadedPlural', '✅ {{count}} Bilder hochgeladen', { count: newUrls.length })
        : t('leadDetail.toastImagesUploadedSingular', '✅ {{count}} Bild hochgeladen', { count: newUrls.length }))
    } catch (err) {
      showToast(`❌ ${err instanceof Error ? err.message : t('leadDetail.genericError', 'Fehler')}`)
    } finally {
      setUploadingUnitImg(false)
      if (unitImgFileRef.current) unitImgFileRef.current.value = ''
    }
  }

  // ── Unit-Bild löschen ─────────────────────────────────────────────────────────
  const handleDeleteUnitImage = async (url: string) => {
    if (!deal?.unit_id) return
    const marker = '/unit-images/'
    const idx    = url.indexOf(marker)
    if (idx !== -1) {
      await supabase.storage.from('unit-images').remove([url.slice(idx + marker.length)])
    }
    const updated = unitImages.filter(u => u !== url)
    await supabase.from('crm_project_units').update({ images: updated }).eq('id', deal.unit_id)
    setUnitImages(updated)
  }

  // ── Automation: schedule-message auslösen (fire-and-forget) ────────────────
  const triggerScheduleMessage = (event_type: string) => {
    if (!id) return
    supabase.functions.invoke('schedule-message', {
      body: { lead_id: id, deal_id: deal?.id ?? null, event_type },
    }).catch(e => console.warn('[LeadDetail] schedule-message failed:', e))
  }

  // ── Webhook ─────────────────────────────────────────────────────
  const sendWebhook = async (event: string, extra?: Record<string, unknown>) => {
    if (!lead || !deal) return
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
      console.warn('[webhook]', e)
    }
  }

  // ── Update deal phase ───────────────────────────────────────────
  const updateDealPhase = async (phase: DealPhase) => {
    if (!deal) return
    // Registrierung: open modal, do NOT change phase yet
    if (phase === 'registrierung') {
      setShowRegistrationModal(true)
      return
    }
    setSaving(true)
    const oldPhase = deal.phase
    try {
      await supabase.from('deals').update({ phase }).eq('id', deal.id).throwOnError()
      await supabase.from('activities').insert({
        lead_id: id,
        deal_id: deal.id,
        type: 'note',
        direction: 'outbound',
        subject: null,
        content: t('leadDetail.logPhaseChanged', 'Phase geändert: {{oldPhase}} → {{newPhase}}', { oldPhase, newPhase: phase }),
        created_by: profile?.id ?? null,
      }).throwOnError()
      if (PHASE_WEBHOOK_EVENTS[phase]) {
        await sendWebhook(PHASE_WEBHOOK_EVENTS[phase]!)
      }
      triggerScheduleMessage(phase)
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] updateDealPhase:', err)
      showToast(`❌ ${t('leadDetail.errPrefix', 'Fehler')}: ${err instanceof Error ? err.message : t('leadDetail.errUnknown', 'Unbekannter Fehler')}`)
    } finally {
      setSaving(false)
    }
  }

  // ── Registration confirm (from modal) ───────────────────────────
  const handleRegistrationConfirm = async (selectedDevelopers: string[], notes: string) => {
    if (!deal) return
    setSavingReg(true)
    const oldPhase = deal.phase
    try {
      await supabase.from('deals').update({ phase: 'registrierung', registration_notes: notes || null, developer: selectedDevelopers.join(', ') || null }).eq('id', deal.id).throwOnError()
      await supabase.from('activities').insert({
        lead_id:    id,
        deal_id:    deal.id,
        type:       'note',
        direction:  'outbound',
        subject:    null,
        content:    notes
          ? t('leadDetail.logRegistrationSentWithNote', 'Phase geändert: {{oldPhase}} → registrierung. Registrierung gesendet an: {{developers}}. Bemerkung: {{note}}', { oldPhase, developers: selectedDevelopers.join(', '), note: notes })
          : t('leadDetail.logRegistrationSent', 'Phase geändert: {{oldPhase}} → registrierung. Registrierung gesendet an: {{developers}}', { oldPhase, developers: selectedDevelopers.join(', ') }),
        created_by: profile?.id ?? null,
      }).throwOnError()
      await sendWebhook('deal.registration', {
        developers:  selectedDevelopers,
        bemerkungen: notes,
      })

      // Registrierung an die Developer läuft über die Stage-Automatik (Path B):
      // triggerScheduleMessage → stage_registrierung-Regeln an die bc:-Kontakte.
      // KEIN direktes sendWhatsApp('registration') mehr — dieses interne Template hat
      // recipients=[] und ginge sonst an die KUNDEN-Nummer zurück (Datenleck, bestätigt).
      triggerScheduleMessage('registrierung')

      setShowRegistrationModal(false)
      showToast(t('crm.registrationSent', 'Registrierung gesendet'))
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] registrationConfirm:', err)
      showToast(`❌ ${t('leadDetail.errSendFailed', 'Fehler beim Senden')}`)
    } finally {
      setSavingReg(false)
    }
  }

  // ── Activity ────────────────────────────────────────────────────
  const handleSaveActivity = async () => {
    if (!actForm.content.trim()) return
    setSavingAct(true)
    try {
      await supabase.from('activities').insert({
        lead_id: id,
        deal_id: deal?.id ?? null,
        type: actForm.type,
        direction: actForm.direction,
        subject: actForm.subject || null,
        content: actForm.content,
        created_by: profile?.id ?? null,
      })
      setActForm({ type: 'note', direction: 'outbound', subject: '', content: '' })
      await fetchAll(true)
      showToast(t('crm.activitySaved', 'Aktivität gespeichert'))
    } catch (err) {
      console.error('[LeadDetail] saveActivity:', err)
      showToast(`❌ ${t('leadDetail.errSaveFailed', 'Fehler beim Speichern')}`)
    } finally {
      setSavingAct(false)
    }
  }

  // ── Task ────────────────────────────────────────────────────────
  const handleSaveTask = async () => {
    if (!taskForm.subject.trim()) return
    setSavingTask(true)
    try {
      await supabase.from('activities').insert({
        lead_id: id,
        deal_id: deal?.id ?? null,
        type: 'task',
        direction: 'outbound',
        subject: taskForm.subject,
        content: taskForm.content || null,
        scheduled_at: taskForm.scheduled_at || null,
        created_by: profile?.id ?? null,
      })
      setTaskForm({ subject: '', content: '', scheduled_at: '', assigned_to: '' })
      await fetchAll(true)
      showToast(t('crm.taskSaved', 'Aufgabe gespeichert'))
    } catch (err) {
      console.error('[LeadDetail] saveTask:', err)
      showToast(`❌ ${t('leadDetail.errSaveFailed', 'Fehler beim Speichern')}`)
    } finally {
      setSavingTask(false)
    }
  }

  const handleCompleteTask = async (taskId: string) => {
    try {
      await supabase.from('activities').update({ completed_at: new Date().toISOString() }).eq('id', taskId)
      await fetchAll(true)
      showToast(t('crm.taskCompleted', 'Aufgabe erledigt'))
    } catch (err) {
      console.error('[LeadDetail] completeTask:', err)
      showToast(`❌ ${t('leadDetail.genericError', 'Fehler')}`)
    }
  }

  // ── Email / Nachrichten-Composer ────────────────────────────────
  // Objekt-Infos zum gekauften/zu kaufenden Objekt — als Referenz im Composer
  // und als Platzhalter ({{developer}} {{projekt}} {{wohnung}} {{preis}}).
  const objectInfo = () => {
    const developer = deal?.developer ?? ''
    const projekt   = dealProjects[0]?.project?.name ?? deal?.property?.project_name ?? ''
    const wohnung   = pickedUnit?.unit.unit_number ?? deal?.property?.unit_number ?? ''
    const preisNum  = pickedUnit?.unit.price_gross ?? null
    const preis     = preisNum != null
      ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(preisNum)
      : ''
    return { developer, projekt, wohnung, preis }
  }

  const replacePlaceholders = (text: string): string => {
    if (!lead) return text
    const o = objectInfo()
    return text
      .replace(/\{\{vorname\}\}/g, lead.first_name)
      .replace(/\{\{nachname\}\}/g, lead.last_name)
      .replace(/\{\{email\}\}/g, lead.email)
      .replace(/\{\{phone\}\}/g, lead.phone ?? '')
      .replace(/\{\{developer\}\}/g, o.developer)
      .replace(/\{\{projekt\}\}/g, o.projekt)
      .replace(/\{\{wohnung\}\}/g, o.wohnung)
      .replace(/\{\{preis\}\}/g, o.preis)
    // {{bemerkungen}} wird erst beim Senden ersetzt (dynamisches Feld)
  }

  // Empfänger auflösen: Klient (Standard) oder gewählter Geschäfts-/Developer-Kontakt.
  const resolveRecipient = (): { name: string; email: string | null; phone: string | null; whatsapp: string | null } | null => {
    if (!lead) return null
    if (composeTo.startsWith('bc:')) {
      const c = businessContacts.find(x => x.id === composeTo.slice(3))
      if (c) return { name: `${c.first_name} ${c.last_name ?? ''}`.trim(), email: c.email, phone: c.phone, whatsapp: c.whatsapp }
    }
    if (composeTo.startsWith('dc:')) {
      const c = devContacts.find(x => x.id === composeTo.slice(3))
      if (c) return { name: c.name, email: c.email, phone: c.phone, whatsapp: c.whatsapp }
    }
    return { name: `${lead.first_name} ${lead.last_name}`, email: lead.email, phone: lead.phone, whatsapp: lead.whatsapp }
  }

  const handleTemplateSelect = (templateId: string) => {
    const tpl = templates.find((t) => t.id === templateId)
    if (!tpl) {
      setEmailForm({ templateId: '', subject: '', body: '' })
      return
    }
    setEmailForm({
      templateId,
      subject: replacePlaceholders(tpl.subject),
      body: replacePlaceholders(tpl.body),
    })
  }

  const handleSendEmail = async () => {
    if (!lead || !emailForm.subject.trim() || !emailForm.body.trim()) return
    const recipient = resolveRecipient()
    const toEmail   = recipient?.email
    if (!toEmail) { showToast(t('crm.compose.errNoEmail', '❌ Dieser Empfänger hat keine E-Mail-Adresse')); return }
    const isClient  = composeTo === 'client'
    setSendingEmail(true)
    try {
      const resolvedBody    = replacePlaceholders(emailForm.body).replace(/\{\{bemerkungen\}\}/g, bemerkungen)
      const resolvedSubject = replacePlaceholders(emailForm.subject).replace(/\{\{bemerkungen\}\}/g, bemerkungen)

      console.log('[send-email] Rufe Edge Function auf …', { to: toEmail, subject: resolvedSubject })

      const { data: fnData, error: fnErr } = await supabase.functions.invoke('send-email', {
        body: {
          to:      toEmail,
          subject: resolvedSubject,
          html:    resolvedBody,
          lead_id: id ?? null,
          deal_id: deal?.id ?? null,
        },
      })

      console.log('[send-email] Response data:', fnData)
      console.log('[send-email] Response error:', fnErr)

      if (fnErr) {
        // Supabase FunctionsHttpError hat ein context-Objekt mit mehr Details
        let detail = fnErr.message
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (fnErr as any).context
          if (ctx) {
            const text = typeof ctx.text === 'function' ? await ctx.text() : JSON.stringify(ctx)
            console.error('[send-email] Fehler-Body der Function:', text)
            detail = text || detail
          }
        } catch { /* ignorieren */ }
        throw new Error(detail)
      }

      // Aktivität immer loggen — auch wenn E-Mail-Provider nicht konfiguriert
      await supabase.from('activities').insert({
        lead_id:    id,
        deal_id:    deal?.id ?? null,
        type:       'email',
        direction:  'outbound',
        subject:    isClient ? resolvedSubject : `${resolvedSubject} → ${recipient?.name} <${toEmail}>`,
        content:    resolvedBody.replace(/<[^>]+>/g, '').slice(0, 500),
        created_by: profile?.id ?? null,
      })

      showToast(t('crm.email.sent', 'E-Mail gesendet! ✓'))
      setEmailForm({ templateId: '', subject: '', body: '' })
      setBemerkungen(''); setComposeTo('client')
      await fetchAll(true)
    } catch (err) {
      console.error('[send-email] Kompletter Fehler:', err)
      console.error('[send-email] Details:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
      showToast(`❌ ${t('leadDetail.errEmailPrefix', 'E-Mail Fehler')}: ${err instanceof Error ? err.message : t('leadDetail.errUnknown', 'Unbekannter Fehler')}`)
    } finally {
      setSendingEmail(false)
    }
  }

  // Composer-WhatsApp: freie Nachricht an gewählten Empfänger (Klient/Kontakt).
  // Routet über die no_show-Override-Schiene (Template ohne feste Empfänger →
  // Nummer kommt aus lead_data.lead_whatsapp).
  const handleSendComposerWhatsapp = async () => {
    if (!lead || !emailForm.body.trim()) return
    const recipient = resolveRecipient()
    const phone = recipient?.whatsapp || recipient?.phone
    if (!phone) { showToast(t('crm.compose.errNoPhone', '❌ Dieser Empfänger hat keine WhatsApp-/Telefonnummer')); return }
    const body = replacePlaceholders(emailForm.body).replace(/\{\{bemerkungen\}\}/g, bemerkungen)
    setSendingEmail(true)
    try {
      const res = await sendWhatsApp({
        event_type: 'no_show',
        lead_data: {
          lead_name:     recipient?.name ?? '',
          lead_phone:    recipient?.phone ?? '',
          lead_whatsapp: phone,
          lead_email:    recipient?.email ?? '',
        },
        lead_id:       null,            // Edge nicht loggen lassen — wir loggen selbst mit korrektem Empfänger
        override_text: body,
      })
      if (!res.success) throw new Error(res.error || t('leadDetail.errWhatsapp', 'WhatsApp Fehler'))
      await supabase.from('activities').insert({
        lead_id:    id,
        deal_id:    deal?.id ?? null,
        type:       'whatsapp',
        direction:  'outbound',
        subject:    `WhatsApp → ${recipient?.name} (${phone})`,
        content:    body.slice(0, 500),
        created_by: profile?.id ?? null,
        completed_at: new Date().toISOString(),
      })
      showToast(t('crm.whatsappSent', '📱 WhatsApp gesendet'))
      setEmailForm({ templateId: '', subject: '', body: '' })
      setBemerkungen(''); setComposeTo('client')
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] composerWhatsapp:', err)
      showToast(`❌ ${err instanceof Error ? err.message : t('leadDetail.errWhatsapp', 'WhatsApp Fehler')}`)
    } finally {
      setSendingEmail(false)
    }
  }

  // ── WhatsApp handlers ───────────────────────────────────────────
  const openWaPreview = async () => {
    if (!lead) return
    // Template aus DB laden und Platzhalter ersetzen
    try {
      const { data: tpl } = await supabase
        .from('whatsapp_templates')
        .select('message_template')
        .eq('event_type', 'no_show')
        .eq('active', true)
        .single()
      let msg = tpl?.message_template ?? ''
      const data: Record<string, string> = {
        lead_name:    `${lead.first_name} ${lead.last_name}`,
        lead_phone:   lead.phone     ?? '–',
        lead_email:   lead.email     ?? '–',
        lead_whatsapp: lead.whatsapp ?? '–',
        lead_country: lead.country   ?? '–',
      }
      for (const [k, v] of Object.entries(data)) {
        msg = msg.split(`{{${k}}}`).join(v)
      }
      setWaMsg(msg || t('leadDetail.noShowFallbackMsg', 'Hallo {{name}} 👋\n\nDu hattest heute einen Termin mit uns.', { name: lead.first_name }))
    } catch {
      setWaMsg(t('leadDetail.noShowFallbackMsg', 'Hallo {{name}} 👋\n\nDu hattest heute einen Termin mit uns.', { name: lead.first_name }))
    }
    setShowWaPreview(true)
  }

  const handleSendWhatsappNoShow = async () => {
    if (!lead) return
    setSendingWa(true)
    try {
      await sendWhatsApp({
        event_type: 'no_show',
        lead_data: {
          lead_name:    `${lead.first_name} ${lead.last_name}`,
          lead_phone:   lead.phone     ?? '',
          lead_email:   lead.email     ?? '',
          lead_whatsapp: lead.whatsapp ?? '',
          lead_country: lead.country   ?? '',
        },
        lead_id:       id,
        override_text: waMsg,   // user-edited preview text
      })
      setShowWaPreview(false)
      showToast(t('crm.whatsappSent', '📱 WhatsApp gesendet'))
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] sendWhatsappNoShow:', err)
      showToast(`❌ ${t('leadDetail.errWhatsapp', 'WhatsApp Fehler')}`)
    } finally {
      setSendingWa(false)
    }
  }

  const handleCommissionWhatsapp = async () => {
    if (!deal || !lead) return
    const projectName = dealProjects[0]?.project?.name ?? deal.property?.project_name ?? '—'
    const amount = commissionAmount ? `€ ${commissionAmount}` : '—'
    setSaving(true)
    try {
      // INTERNE Provisions-Anfrage → an Burkhard (Buchhaltung), NICHT an den Kunden.
      // (Vorher ging event_type 'commission' mit recipients=[] über den Fallback an die Kundennummer = Leck.)
      const { data: bk } = await supabase.from('crm_business_contacts')
        .select('first_name, whatsapp, phone').eq('id', '6c9da3ce-9826-4660-9a50-6ff9fc8e70b4').maybeSingle()
      const b = bk as { first_name?: string; whatsapp?: string | null; phone?: string | null } | null
      const tel = b?.whatsapp || b?.phone
      if (!tel) { showToast(`❌ ${t('leadDetail.errBurkhardNoPhone', 'Burkhard hat keine WhatsApp-/Telefonnummer hinterlegt')}`); return }
      const msg = t('leadDetail.commissionMsgToBurkhard', '🎉 Deal abgeschlossen!\nKunde: {{customer}}\nProjekt: {{project}}\nProvision: {{amount}}\n\nBitte Provision veranlassen.', { customer: `${lead.first_name} ${lead.last_name}`, project: projectName, amount })
      const res = await sendWhatsApp({
        event_type: 'no_show', override_text: msg, lead_id: id,
        lead_data: { lead_name: b?.first_name ?? 'Burkhard', lead_phone: tel },
      })
      if (!res.success) throw new Error(res.error || t('leadDetail.errWhatsapp', 'WhatsApp Fehler'))
      await supabase.from('activities').insert({
        lead_id: id, deal_id: deal.id, type: 'whatsapp', direction: 'outbound',
        subject: t('leadDetail.logCommissionRequestSubject', 'Provisions-Anfrage an Burkhard'), content: msg, created_by: profile?.id ?? null,
      })
      showToast(t('crm.commissionSentBurkhard', '📱 Provisions-Anfrage an Burkhard gesendet'))
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] commissionWhatsapp:', err)
      showToast(`❌ ${err instanceof Error ? err.message : t('leadDetail.errWhatsapp', 'WhatsApp Fehler')}`)
    } finally {
      setSaving(false)
    }
  }

  // ── Phase action handlers ───────────────────────────────────────
  const handleFinancingToggle = async (val: boolean) => {
    if (!deal) return
    setFinancingRequired(val)
    try {
      await supabase.from('deals').update({ financing_required: val }).eq('id', deal.id)
    } catch (err) {
      console.error('[LeadDetail] financingToggle:', err)
    }
  }

  const handleFinancingNotify = async () => {
    if (!deal) return
    setSaving(true)
    try {
      const notesField = deal.phase === 'finanzierung_de' ? 'finanzierung_de_notes' : 'finanzierung_cy_notes'
      const notesValue = deal.phase === 'finanzierung_de' ? finDENotes : finCYNotes
      await supabase.from('deals').update({
        financing_partner_notified_at: new Date().toISOString(),
        [notesField]: notesValue || null,
      }).eq('id', deal.id).throwOnError()
      await supabase.from('activities').insert({
        lead_id: id, deal_id: deal.id, type: 'note', direction: 'outbound',
        subject: null, content: t('leadDetail.logFinancingPartnerNotified', 'Finanzierungspartner informiert'), created_by: profile?.id ?? null,
      }).throwOnError()
      await sendWebhook('deal.financing')
      showToast(t('crm.financingNotified', 'Partner informiert'))
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] financingNotify:', err)
      showToast(`❌ ${t('leadDetail.genericError', 'Fehler')}`)
    } finally {
      setSaving(false)
    }
  }

  const handleLawyerNotify = async () => {
    if (!deal) return
    setSaving(true)
    try {
      await supabase.from('deals').update({
        google_drive_url:    driveUrl,
        lawyer_notified_at:  new Date().toISOString(),
        kaufvertrag_notes:   kaufNotes || null,
      }).eq('id', deal.id).throwOnError()
      await supabase.from('activities').insert({
        lead_id: id, deal_id: deal.id, type: 'note', direction: 'outbound',
        subject: null, content: t('leadDetail.logLawyerNotified', 'Anwalt informiert. Drive: {{driveUrl}}', { driveUrl }), created_by: profile?.id ?? null,
      }).throwOnError()
      await sendWebhook('deal.contract', { google_drive_url: driveUrl })
      showToast(t('crm.lawyerNotified', 'Anwalt informiert'))
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] lawyerNotify:', err)
      showToast(`❌ ${t('leadDetail.genericError', 'Fehler')}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDepositCommission = async () => {
    if (!deal) return
    setSaving(true)
    try {
      await supabase.from('deals').update({ deposit_paid_at: depositDate || new Date().toISOString() }).eq('id', deal.id).throwOnError()
      await supabase.from('activities').insert({
        lead_id: id, deal_id: deal.id, type: 'note', direction: 'outbound',
        subject: null, content: t('leadDetail.logCommissionRequestedDepositPaid', 'Provision angefordert – Anzahlung bezahlt'), created_by: profile?.id ?? null,
      }).throwOnError()
      await sendWebhook('deal.deposit_paid')
      showToast(t('crm.commissionRequested', 'Provision angefordert'))
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] depositCommission:', err)
      showToast(`❌ ${t('leadDetail.genericError', 'Fehler')}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDealClose = async () => {
    if (!deal) return
    setSaving(true)
    try {
      await supabase.from('deals').update({
        commission_amount:  parseFloat(commissionAmount) || null,
        commission_paid_at: new Date().toISOString(),
        provision_notes:    provNotes || null,
      }).eq('id', deal.id).throwOnError()
      await supabase.from('activities').insert({
        lead_id: id, deal_id: deal.id, type: 'note', direction: 'outbound',
        subject: null, content: t('leadDetail.logDealClosedCommission', 'Deal abgeschlossen. Provision: {{amount}}', { amount: commissionAmount }), created_by: profile?.id ?? null,
      }).throwOnError()
      await sendWebhook('deal.commission_paid', { commission_amount: commissionAmount })
      showToast(t('crm.dealClosed', 'Deal abgeschlossen'))
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] dealClose:', err)
      showToast(`❌ ${t('leadDetail.genericError', 'Fehler')}`)
    } finally {
      setSaving(false)
    }
  }

  // ── Cancel scheduled message ────────────────────────────────────
  const handleCancelScheduledMsg = async (msgId: string) => {
    setCancellingMsg(msgId)
    try {
      await supabase
        .from('scheduled_messages')
        .update({ status: 'cancelled' })
        .eq('id', msgId)
        .eq('status', 'pending')
      setScheduledMessages(prev =>
        prev.map(m => m.id === msgId ? { ...m, status: 'cancelled' } : m)
      )
      showToast(`✋ ${t('leadDetail.toastMessageCancelled', 'Nachricht abgebrochen')}`)
    } catch (err) {
      console.error('[LeadDetail] cancelScheduledMsg:', err)
      showToast(`❌ ${t('leadDetail.genericError', 'Fehler')}`)
    } finally {
      setCancellingMsg(null)
    }
  }

  const handleArchive = async () => {
    if (!deal) return
    setSaving(true)
    try {
      await supabase.from('deals').update({ phase: 'archiviert' }).eq('id', deal.id).throwOnError()
      await supabase.from('activities').insert({
        lead_id: id, deal_id: deal.id, type: 'note', direction: 'outbound',
        subject: null, content: t('leadDetail.logDealArchived', 'Deal archiviert'), created_by: profile?.id ?? null,
      }).throwOnError()
      showToast(t('crm.archivedSuccess', 'Archiviert'))
      navigate('/admin/crm')
    } catch (err) {
      console.error('[LeadDetail] archive:', err)
      showToast(`❌ ${t('leadDetail.errArchiveFailed', 'Fehler beim Archivieren')}`)
    } finally {
      setSaving(false)
    }
  }

  // Deal endgültig löschen (z.B. versehentlich mehrfach angelegt). Der Kontakt/Lead
  // bleibt erhalten; nur dieser Deal + seine geplanten Nachrichten/Projekt-Verknüpfungen
  // verschwinden (FKs: activities/Termine→SET NULL, deal_projects/scheduled_messages→CASCADE).
  const handleDeleteDeal = async () => {
    if (!deal) return
    if (!window.confirm(t('crm.deleteDealConfirm', 'Diesen Deal wirklich löschen? Der Deal und seine geplanten Nachrichten werden unwiderruflich entfernt. Der Kontakt selbst bleibt erhalten.'))) return
    setSaving(true)
    try {
      await supabase.from('deals').delete().eq('id', deal.id).throwOnError()
      showToast(t('crm.deleteDealSuccess', 'Deal gelöscht'))
      navigate('/admin/crm')
    } catch (err) {
      console.error('[LeadDetail] delete deal:', err)
      showToast('❌ ' + t('crm.deleteDealError', 'Löschen fehlgeschlagen'))
      setSaving(false)
    }
  }

  const handleSaveDriveUrl = async () => {
    if (!deal) return
    try {
      await supabase.from('deals').update({ google_drive_url: driveUrl }).eq('id', deal.id).throwOnError()
      showToast(t('crm.driveSaved', 'Drive-Link gespeichert'))
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] saveDriveUrl:', err)
      showToast(`❌ ${t('leadDetail.genericError', 'Fehler')}`)
    }
  }

  const handleSaveImmoNotes = async () => {
    if (!deal) return
    try {
      await supabase.from('deals').update({ immobilien_notes: immoNotes || null }).eq('id', deal.id)
      showToast(t('crm.notesSaved', 'Notiz gespeichert'))
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] saveImmoNotes:', err)
      showToast(`❌ ${t('leadDetail.genericError', 'Fehler')}`)
    }
  }

  // ── Stammdaten speichern ────────────────────────────────────────
  const openLeadEdit = () => {
    if (!lead) return
    setLeadForm({
      first_name:  lead.first_name,
      last_name:   lead.last_name,
      email:       lead.email,
      phone:       lead.phone       ?? '',
      whatsapp:    lead.whatsapp    ?? '',
      alt_emails:  (lead.alt_emails ?? []).join(', '),
      alt_phones:  (lead.alt_phones ?? []).join(', '),
      country:     lead.country     ?? '',
      source:      lead.source,
      language:    lead.language,
      notes:       lead.notes       ?? '',
      assigned_to: lead.assigned_to ?? '',
    })
    setEditingLead(true)
  }

  const handleSaveLead = async () => {
    if (!lead || !leadForm.first_name.trim() || !leadForm.email.trim()) return
    setSavingLead(true)
    try {
      const { error } = await supabase.from('leads').update({
        first_name:  leadForm.first_name.trim(),
        last_name:   leadForm.last_name.trim(),
        email:       leadForm.email.trim(),
        phone:       leadForm.phone.trim()     || null,
        whatsapp:    leadForm.whatsapp.trim()  || null,
        alt_emails:  leadForm.alt_emails.split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
        alt_phones:  leadForm.alt_phones.split(',').map(x => x.replace(/[^\d+]/g, '')).filter(Boolean),
        country:     leadForm.country.trim()   || null,
        source:      leadForm.source,
        language:    leadForm.language,
        notes:       leadForm.notes.trim()     || null,
        assigned_to: leadForm.assigned_to      || null,
      }).eq('id', lead.id)
      if (error) throw error
      setEditingLead(false)
      showToast(t('leadDetail.toastMasterDataSaved', '✅ Stammdaten gespeichert'))
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] saveLead:', err)
      showToast(`❌ ${t('leadDetail.errSaveFailed', 'Fehler beim Speichern')}`)
    } finally {
      setSavingLead(false)
    }
  }

  const handleSaveRegNotes = async () => {
    if (!deal) return
    try {
      await supabase.from('deals').update({ registration_notes: regNotes || null }).eq('id', deal.id)
      showToast(t('crm.notesSaved', 'Notiz gespeichert'))
      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] saveRegNotes:', err)
      showToast(`❌ ${t('leadDetail.genericError', 'Fehler')}`)
    }
  }

  // ── Deal-Project löschen ────────────────────────────────────────
  async function handleDeleteDealProject(dpId: string) {
    await supabase.from('deal_projects').delete().eq('id', dpId)
    showToast(t('leadDetail.toastProjectRemoved', 'Projekt entfernt'))
    await fetchAll(true)
  }

  // ── Zugewiesene Wohnung vom Kunden entfernen ─────────────────────
  // Löscht das verknüpfte Portal-Objekt (properties) und hebt die Zuordnung im
  // Deal auf (unit_id + property_id). Verhindert „Geister-Objekte" beim Kunden.
  async function handleRemoveWohnung() {
    if (!deal?.unit_id) return
    if (!window.confirm(
      t('leadDetail.confirmRemoveUnit', 'Wohnung wirklich aus diesem Kunden entfernen?\n\nDas verknüpfte Objekt im Eigentümer-Portal wird gelöscht. Die Wohnung im Projekt selbst bleibt erhalten.')
    )) return
    try {
      // 1. Portal-Objekt löschen (das taucht beim Kunden in der Verwaltung auf)
      if (deal.property_id) {
        await supabase.from('properties').delete().eq('id', deal.property_id)
      }
      // 2. Unit vom Portal-Objekt entkoppeln
      await supabase.from('crm_project_units').update({ property_id: null }).eq('id', deal.unit_id)
      // 3. Zuordnung im Deal aufheben → Sync legt nichts mehr neu an
      await supabase.from('deals').update({ unit_id: null, property_id: null }).eq('id', deal.id)
      // 4. Aktivität protokollieren
      await supabase.from('activities').insert({
        lead_id:      id,
        deal_id:      deal.id,
        type:         'note',
        direction:    'outbound',
        subject:      t('leadDetail.logUnitRemovedSubject', 'Wohnung entfernt'),
        content:      t('leadDetail.logUnitRemovedContent', 'Die zugewiesene Wohnung wurde vom Kunden entfernt und das Portal-Objekt gelöscht.'),
        created_by:   profile?.id ?? null,
        completed_at: new Date().toISOString(),
      })
      setPickedUnit(null)
      setActiveTab('overview')
      showToast(t('leadDetail.toastUnitRemoved', '✅ Wohnung entfernt'))
      await fetchAll(true)
    } catch (err) {
      showToast(`❌ ${err instanceof Error ? err.message : t('leadDetail.errRemoveFailed', 'Fehler beim Entfernen')}`)
    }
  }

  async function handleSaveUnit() {
    if (!unitEditForm.unit_number.trim()) return
    setSavingUnit(true)
    try {
      const unitPayload = {
        unit_number:   unitEditForm.unit_number.trim(),
        block:         unitEditForm.block.trim()       || null,
        type:          unitEditForm.type as CrmProjectUnit['type'],
        floor:         unitEditForm.floor              ? parseInt(unitEditForm.floor)          : null,
        bedrooms:      parseInt(unitEditForm.bedrooms) || 0,
        bathrooms:     parseInt(unitEditForm.bathrooms)|| 0,
        size_sqm:      unitEditForm.size_sqm           ? parseFloat(unitEditForm.size_sqm)     : null,
        terrace_sqm:   unitEditForm.terrace_sqm        ? parseFloat(unitEditForm.terrace_sqm)  : null,
        price_net:     unitEditForm.price_net          ? parseFloat(unitEditForm.price_net)    : null,
        price_gross:   unitEditForm.price_gross        ? parseFloat(unitEditForm.price_gross)  : null,
        vat_rate:      parseFloat(unitEditForm.vat_rate) || 0,
        status:        unitEditForm.status as CrmProjectUnit['status'],
        is_furnished:  unitEditForm.is_furnished,
        rental_type:   (unitEditForm.rental_type || null) as CrmProjectUnit['rental_type'],
        handover_date: unitEditForm.handover_date      || null,
        notes:         unitEditForm.notes.trim()       || null,
      }

      let savedUnitId: string | null = null
      let existingPropertyId: string | null = null

      if (unitEditData) {
        // ── UPDATE existing unit ────────────────────────────────────
        const { error } = await supabase
          .from('crm_project_units')
          .update(unitPayload)
          .eq('id', unitEditData.id)
        if (error) throw error
        savedUnitId = unitEditData.id
        existingPropertyId = unitEditData.property_id ?? null
        // update pickedUnit in-memory so card refreshes immediately
        if (pickedUnit?.unit.id === unitEditData.id) {
          setPickedUnit(prev => prev ? { ...prev, unit: { ...prev.unit, ...unitPayload } } : null)
        }
      } else {
        // ── CREATE new unit (Aktivieren ohne bestehende crm_project_unit) ──
        if (!unitEditProjectId) throw new Error('Kein Projekt ausgewählt')
        const { data: newUnit, error } = await supabase
          .from('crm_project_units')
          .insert({ ...unitPayload, project_id: unitEditProjectId })
          .select()
          .single()
        if (error) throw error
        savedUnitId = (newUnit as CrmProjectUnit).id
        existingPropertyId = (newUnit as CrmProjectUnit).property_id ?? null
        if (newUnit && deal) {
          const dealUpdate: Record<string, unknown> = { unit_id: savedUnitId }
          if (existingPropertyId) dealUpdate.property_id = existingPropertyId
          await supabase.from('deals').update(dealUpdate).eq('id', deal.id)
          const projectName = dealProjects.find(dp => dp.project_id === unitEditProjectId)?.project?.name ?? ''
          setPickedUnit({ unit: newUnit as CrmProjectUnit, projectName })
        }
        // Aktivität loggen
        await supabase.from('activities').insert({
          lead_id:      id,
          deal_id:      deal?.id ?? null,
          type:         'note',
          direction:    'outbound',
          subject:      t('leadDetail.logUnitCreatedSubject', 'Einheit angelegt & aktiviert'),
          content:      t('leadDetail.logUnitCreatedContent', 'Neue Einheit Nr. {{number}} wurde angelegt und dem Lead zugewiesen.', { number: unitEditForm.unit_number.trim() }),
          created_by:   profile?.id ?? null,
          completed_at: new Date().toISOString(),
        })
        await fetchAll(true)
      }

      // ── Sync properties-Eintrag für Eigentümer-Portal ─────────────
      if (savedUnitId && profile?.id) {
        const ownerProfile = await getEigentuemerProfile()
        if (ownerProfile) {
          const projectId  = unitEditData?.project_id ?? unitEditProjectId
          const dp         = dealProjects.find(d => d.project_id === projectId)
          const projectName = dp?.project?.name ?? ''
          const location   = dp?.project?.location ?? null
          // rental_type NOT NULL in DB → 'longterm' als Fallback
          const rentalType: 'shortterm' | 'longterm' =
            unitEditForm.rental_type === 'long' ? 'longterm'
            : unitEditForm.rental_type === 'short' ? 'shortterm'
            : 'longterm'

          const propData = {
            project_name:  projectName,
            unit_number:   unitEditForm.unit_number.trim() || null,
            type:          unitEditForm.type as 'villa' | 'apartment' | 'studio',
            bedrooms:      parseInt(unitEditForm.bedrooms) || 0,
            size_sqm:      unitEditForm.size_sqm ? parseFloat(unitEditForm.size_sqm) : null,
            is_furnished:  unitEditForm.is_furnished,
            rental_type:   rentalType,
            city:          location,
            purchase_price_net:  unitEditForm.price_net   ? parseFloat(unitEditForm.price_net)   : null,
            purchase_price_gross: unitEditForm.price_gross ? parseFloat(unitEditForm.price_gross) : null,
          }

          if (existingPropertyId) {
            // Bestehenden properties-Eintrag aktualisieren
            await supabase.from('properties').update(propData).eq('id', existingPropertyId)
          } else {
            // Neuen properties-Eintrag anlegen + verknüpfen
            const { data: newProp } = await supabase
              .from('properties')
              .insert({ ...propData, owner_id: ownerProfile.id, created_by: profile.id, images: [] })
              .select('id')
              .single()
            if (newProp) {
              const newPropId = (newProp as { id: string }).id
              await supabase.from('crm_project_units')
                .update({ property_id: newPropId })
                .eq('id', savedUnitId)
              if (deal) {
                await supabase.from('deals')
                  .update({ property_id: newPropId })
                  .eq('id', deal.id)
              }
            }
          }
        }
      }
      // ──────────────────────────────────────────────────────────────

      showToast(t('leadDetail.toastUnitSaved', '✅ Einheit gespeichert'))
      setShowUnitEdit(false)

      // Kein Portalzugang → Eigentümer-Account automatisch anlegen
      if (portalAccessChecked && !customerHasAccess && lead?.email) {
        try {
          const fullName = `${lead.first_name} ${lead.last_name}`.trim()
          const { data, error: fnError } = await supabase.functions.invoke('admin-user-ops', {
            body: {
              action:   'create',
              email:    lead.email,
              full_name: fullName,
              role:     'eigentuemer',
              language: lead.language ?? 'de',
              phone:    lead.phone ?? undefined,
            },
          })
          if (!fnError && !data?.error && data?.password) {
            // Properties-Eintrag für Portal anlegen (jetzt hat der Eigentümer eine userId)
            if (savedUnitId && data.userId && profile?.id) {
              const projectId   = unitEditData?.project_id ?? unitEditProjectId
              const dp          = dealProjects.find(d => d.project_id === projectId)
              const projectName = dp?.project?.name ?? ''
              const location    = dp?.project?.location ?? null
              // rental_type NOT NULL in DB → 'longterm' als Fallback
              const rentalType: 'shortterm' | 'longterm' =
                unitEditForm.rental_type === 'long' ? 'longterm'
                : unitEditForm.rental_type === 'short' ? 'shortterm'
                : 'longterm'
              const propData = {
                project_name:         projectName,
                unit_number:          unitEditForm.unit_number.trim() || null,
                type:                 unitEditForm.type as 'villa' | 'apartment' | 'studio',
                bedrooms:             parseInt(unitEditForm.bedrooms) || 0,
                size_sqm:             unitEditForm.size_sqm ? parseFloat(unitEditForm.size_sqm) : null,
                is_furnished:         unitEditForm.is_furnished,
                rental_type:          rentalType,
                city:                 location,
                purchase_price_net:   unitEditForm.price_net   ? parseFloat(unitEditForm.price_net)   : null,
                purchase_price_gross: unitEditForm.price_gross ? parseFloat(unitEditForm.price_gross) : null,
                property_status:      unitEditForm.status === 'under_construction' ? 'under_construction' : 'active',
              }
              if (existingPropertyId) {
                await supabase.from('properties').update(propData).eq('id', existingPropertyId)
              } else {
                const { data: newProp } = await supabase
                  .from('properties')
                  .insert({ ...propData, owner_id: data.userId, created_by: profile.id, images: [] })
                  .select('id')
                  .single()
                if (newProp) {
                  const newPropId = (newProp as { id: string }).id
                  await supabase.from('crm_project_units')
                    .update({ property_id: newPropId })
                    .eq('id', savedUnitId)
                  if (deal) {
                    await supabase.from('deals')
                      .update({ property_id: newPropId })
                      .eq('id', deal.id)
                  }
                }
              }
            }

            // Lead mit dem neuen Eigentümer-Profil verknüpfen + Zeitstempel setzen
            if (id && data.userId) {
              await supabase.from('leads').update({
                profile_id: data.userId,
                portal_access_sent_at: new Date().toISOString(),
              }).eq('id', id)
            }

            // Passwort-Modal anzeigen
            setNewOwnerPassword(data.password)
            setNewOwnerPasswordEmail(lead.email)
            setNewOwnerPwCopied(false)
            setShowNewOwnerPwModal(true)
            setCustomerHasAccess(true)
          } else {
            const errMsg = data?.error ?? fnError?.message ?? t('leadDetail.genericError', 'Fehler')
            console.error('[LeadDetail] Auto-create eigentuemer:', errMsg)
            showToast(`⚠️ ${t('leadDetail.ownerCreateFailed', 'Eigentümer-Account konnte nicht angelegt werden')}: ${errMsg}`)
          }
        } catch (err) {
          console.error('[LeadDetail] Auto-create eigentuemer:', err)
          showToast(`⚠️ ${t('leadDetail.ownerAutoCreateFailed', 'Eigentümer-Account konnte nicht automatisch angelegt werden')}`)
        }
      }
    } catch (err) {
      console.error('[LeadDetail] saveUnit:', err)
      showToast(`❌ ${t('leadDetail.errSaveFailed', 'Fehler beim Speichern')}`)
    } finally {
      setSavingUnit(false)
    }
  }

  // ── Eigentümer-Profil des Kunden abrufen ─────────────────────────
  async function getEigentuemerProfile(): Promise<{ id: string } | null> {
    if (!lead?.email) return null
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', lead.email)
      .eq('role', 'eigentuemer')
      .maybeSingle()
    return data as { id: string } | null
  }

  // ── Portal-Zugangs-Check ─────────────────────────────────────────
  async function checkCustomerPortalAccess(): Promise<boolean> {
    return !!(await getEigentuemerProfile())
  }

  // ── Unit-Edit öffnen + Portal-Check im Hintergrund ───────────────
  function openUnitEdit(unit: CrmProjectUnit) {
    setUnitEditData(unit)
    setUnitEditForm({
      unit_number:   unit.unit_number,
      block:         unit.block         ?? '',
      type:          unit.type,
      floor:         unit.floor         != null ? String(unit.floor)        : '',
      bedrooms:      String(unit.bedrooms),
      bathrooms:     String(unit.bathrooms),
      size_sqm:      unit.size_sqm      != null ? String(unit.size_sqm)     : '',
      terrace_sqm:   unit.terrace_sqm   != null ? String(unit.terrace_sqm)  : '',
      price_net:     unit.price_net     != null ? String(unit.price_net)    : '',
      price_gross:   unit.price_gross   != null ? String(unit.price_gross)  : '',
      vat_rate:      String(unit.vat_rate ?? 0),
      status:        unit.status,
      is_furnished:  unit.is_furnished,
      rental_type:   unit.rental_type   ?? '',
      handover_date: unit.handover_date ? unit.handover_date.slice(0, 10)  : '',
      notes:         unit.notes         ?? '',
    })
    setPortalAccessChecked(false)
    setCustomerHasAccess(false)
    setShowUnitEdit(true)
    // Portal-Zugangs-Check asynchron im Hintergrund
    setCheckingAccess(true)
    checkCustomerPortalAccess().then(hasAccess => {
      setCustomerHasAccess(hasAccess)
      setPortalAccessChecked(true)
      setCheckingAccess(false)
    })
  }

  // ── Aktivieren: unit_id → edit; sonst picker ─────────────────────
  async function handleActivateProject(projectId: string) {
    // 1. deal.unit_id (persistiert nach Reload — zuverlässigste Quelle)
    if (deal?.unit_id) {
      const { data } = await supabase
        .from('crm_project_units')
        .select('*')
        .eq('id', deal.unit_id)
        .maybeSingle()
      if (data) { openUnitEdit(data as CrmProjectUnit); return }
    }
    // 2. in-memory pickedUnit (nur solange Seite nicht neu geladen)
    if (pickedUnit) {
      openUnitEdit(pickedUnit.unit)
      return
    }
    // 3. deal.property_id Fallback
    if (deal?.property_id) {
      const { data } = await supabase
        .from('crm_project_units')
        .select('*')
        .eq('property_id', deal.property_id)
        .eq('project_id', projectId)
        .maybeSingle()
      if (data) { openUnitEdit(data as CrmProjectUnit); return }
    }
    // 4. Noch keine Einheit → Alle Units im Projekt anzeigen (inkl. Im-Bau)
    const { data: availableUnits } = await supabase
      .from('crm_project_units')
      .select('*')
      .eq('project_id', projectId)
      .order('unit_number')
    if (availableUnits && availableUnits.length > 0) {
      // Vorhandene verfügbare Units zur Auswahl anbieten
      const dp = dealProjects.find(d => d.project_id === projectId)
      setUnitSelectProjectId(projectId)
      setUnitSelectUnits(availableUnits as CrmProjectUnit[])
      setUnitSelectProject({
        id:       dp?.project?.id       ?? projectId,
        name:     dp?.project?.name     ?? 'Projekt',
        location: dp?.project?.location ?? null,
      })
      setShowUnitSelect(true)
      return
    }
    // Keine verfügbaren Units → direkt CREATE-Modus öffnen
    const dp = dealProjects.find(d => d.project_id === projectId)
    setUnitEditData(null)
    setUnitEditProjectId(projectId)
    setUnitEditForm({
      unit_number:   dp?.unit_numbers ?? '',
      block:         '',
      type:          'apartment',
      floor:         '',
      bedrooms:      '0',
      bathrooms:     '0',
      size_sqm:      '',
      terrace_sqm:   '',
      price_net:     dp?.price_net != null ? String(dp.price_net) : '',
      price_gross:   '',
      vat_rate:      '0',
      status:        'active',
      is_furnished:  false,
      rental_type:   '',
      handover_date: '',
      notes:         dp?.notes ?? '',
    })
    setPortalAccessChecked(false)
    setCustomerHasAccess(false)
    setShowUnitEdit(true)
    setCheckingAccess(true)
    checkCustomerPortalAccess().then(hasAccess => {
      setCustomerHasAccess(hasAccess)
      setPortalAccessChecked(true)
      setCheckingAccess(false)
    })
  }

  // ── Unit assignment ──────────────────────────────────────────────
  async function handleUnitAssign(unit: CrmProjectUnit, project: Pick<CrmProject, 'id' | 'name' | 'location'>) {
    setShowUnitPicker(false)
    setPickedUnit({ unit, projectName: project.name })

    try {
      // 1. Einheit als zugewiesen/aktiv markieren
      await supabase.from('crm_project_units').update({ status: 'active' }).eq('id', unit.id)

      // 2. unit_id immer speichern; property_id wenn vorhanden
      if (deal) {
        const dealUpdate: Record<string, unknown> = { unit_id: unit.id }
        if (unit.property_id) dealUpdate.property_id = unit.property_id
        await supabase.from('deals').update(dealUpdate).eq('id', deal.id)
      }

      // 3. Aktivität loggen
      const unitLabel = `${project.name}${unit.block ? ` · ${t('crm.unitEdit.block', 'Block')} ${unit.block}` : ''} · ${t('crm.unitSelect.no', 'Nr.')} ${unit.unit_number}`
      await supabase.from('activities').insert({
        lead_id:      id,
        deal_id:      deal?.id ?? null,
        type:         'note',
        direction:    'outbound',
        subject:      t('leadDetail.logUnitAssignedSubject', 'Wohnung zugewiesen'),
        content:      t('leadDetail.logUnitAssignedContent', '{{unitLabel}} wurde dem Lead zugewiesen.', { unitLabel }),
        created_by:   profile?.id ?? null,
        completed_at: new Date().toISOString(),
      })

      // 4. Portal-Eintrag synchronisieren (wenn Eigentümer-Profil bereits vorhanden)
      const ownerProfile = await getEigentuemerProfile()
      if (ownerProfile && profile?.id) {
        // rental_type NOT NULL in DB → 'longterm' als Fallback
        const rentalType: 'shortterm' | 'longterm' =
          unit.rental_type === 'long' ? 'longterm'
          : unit.rental_type === 'short' ? 'shortterm'
          : 'longterm'
        const propData = {
          project_name:         project.name,
          unit_number:          unit.unit_number || null,
          type:                 (unit.type ?? 'apartment') as 'villa' | 'apartment' | 'studio',
          bedrooms:             unit.bedrooms ?? 0,
          size_sqm:             unit.size_sqm ?? null,
          is_furnished:         unit.is_furnished ?? false,
          rental_type:          rentalType,
          city:                 project.location ?? null,
          purchase_price_net:   unit.price_net   ?? null,
          purchase_price_gross: unit.price_gross ?? null,
          property_status:      unit.status === 'under_construction' ? 'under_construction' : 'active',
        }
        if (unit.property_id) {
          await supabase.from('properties').update(propData).eq('id', unit.property_id)
        } else {
          const { data: newProp } = await supabase
            .from('properties')
            .insert({ ...propData, owner_id: ownerProfile.id, created_by: profile.id, images: [] })
            .select('id')
            .single()
          if (newProp) {
            const newPropId = (newProp as { id: string }).id
            await supabase.from('crm_project_units').update({ property_id: newPropId }).eq('id', unit.id)
            if (deal) await supabase.from('deals').update({ property_id: newPropId }).eq('id', deal.id)
          }
        }
      }

      await fetchAll(true)
    } catch (err) {
      console.error('[LeadDetail] handleUnitAssign:', err)
    }

    // 5. Unit-Edit öffnen (Portal-Check läuft darin automatisch)
    openUnitEdit(unit)
  }

  // ── Portal access send ───────────────────────────────────────────
  // Portalzugang direkt senden (KEIN Dialog): Eigentümer-Account anlegen und die
  // gestaltete HTML-Vorlage „Portalzugang" per E-Mail an den Kunden. Ohne
  // custom_message nutzt create-eigentuemer-access die DB-Vorlage (mit Sicherheitsnetz).
  async function openPortal() {
    if (!lead?.email) { showToast(`❌ ${t('leadDetail.noEmailOnLead', 'Keine E-Mail am Lead hinterlegt')}`); return }
    setResendingPortal(true)
    try {
      const fullName = `${lead.first_name} ${lead.last_name}`.trim()
      const { data, error: fnError } = await supabase.functions.invoke('create-eigentuemer-access', {
        body: { email: lead.email, full_name: fullName },
      })
      if (fnError || data?.error) throw new Error(data?.error ?? fnError?.message ?? t('leadDetail.genericError', 'Fehler'))
      await supabase.from('activities').insert({
        lead_id:      id,
        deal_id:      deal?.id ?? null,
        type:         'email',
        direction:    'outbound',
        subject:      t('leadDetail.logPortalAccessSentSubject', 'Portalzugang gesendet'),
        content:      t('leadDetail.logPortalAccessSentContent', 'Eigentümer-Portalzugang an {{email}} erstellt und per E-Mail gesendet.', { email: lead.email }),
        created_by:   profile?.id ?? null,
        completed_at: new Date().toISOString(),
      })
      if (id) await supabase.from('leads').update({ portal_access_sent_at: new Date().toISOString() }).eq('id', id)
      showToast(t('leadDetail.toastPortalAccessSent', '✅ Portalzugang an den Kunden gesendet'))
      await fetchAll(true)
    } catch (err) {
      showToast(`❌ ${err instanceof Error ? err.message : t('leadDetail.errSendFailed', 'Fehler beim Senden')}`)
    } finally {
      setResendingPortal(false)
    }
  }

  // ── Portal-Zugang nochmal verschicken (neues Passwort + E-Mail an Kunden) ─────
  async function resendPortalAccess() {
    if (!lead) return
    if (!lead.profile_id) { openPortal(); return }
    if (!window.confirm(
      t('leadDetail.confirmResendPortalAccess', 'Neues Passwort erstellen und per E-Mail an {{email}} senden?\n\nDas bisherige Passwort des Kunden wird dabei ungültig.', { email: lead.email })
    )) return
    setResendingPortal(true)
    try {
      // create-eigentuemer-access setzt für bestehende Nutzer ein neues Passwort
      // UND verschickt die Zugangsdaten-E-Mail an den Kunden.
      const fullName = `${lead.first_name} ${lead.last_name}`.trim()
      const { data, error: fnError } = await supabase.functions.invoke('create-eigentuemer-access', {
        body: { email: lead.email, full_name: fullName },
      })
      if (fnError || data?.error) throw new Error(data?.error ?? fnError?.message ?? t('leadDetail.genericError', 'Fehler'))

      await supabase.from('activities').insert({
        lead_id:      id,
        deal_id:      deal?.id ?? null,
        type:         'email',
        direction:    'outbound',
        subject:      t('leadDetail.logPortalAccessResentSubject', 'Portal-Zugangsdaten erneut gesendet'),
        content:      t('leadDetail.logPortalAccessResentContent', 'Neues Passwort erstellt und per E-Mail an {{email}} gesendet.', { email: lead.email }),
        created_by:   profile?.id ?? null,
        completed_at: new Date().toISOString(),
      })

      if (id) {
        await supabase.from('leads').update({ portal_access_sent_at: new Date().toISOString() }).eq('id', id)
      }
      showToast(t('leadDetail.toastNewAccessSent', '✅ Neuer Zugang per E-Mail an den Kunden gesendet'))
      await fetchAll(true)
    } catch (err) {
      showToast(`❌ ${err instanceof Error ? err.message : t('leadDetail.errResendFailed', 'Fehler beim erneuten Senden')}`)
    } finally {
      setResendingPortal(false)
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────
  const initials = lead ? `${lead.first_name[0] ?? ''}${lead.last_name[0] ?? ''}`.toUpperCase() : ''

  const isOverdue = (act: Activity) => {
    if (!act.scheduled_at) return false
    return new Date(act.scheduled_at) < new Date()
  }

  const formatDate = (iso: string | null) => {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  // ── Loading ─────────────────────────────────────────────────────
  if (loading) {
    return (
      <DashboardLayout basePath={'/admin/crm'}>
        <div className="flex items-center justify-center h-64">
          <div className="w-8 h-8 border-4 border-orange-400 border-t-transparent rounded-full animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  if (!lead) {
    return (
      <DashboardLayout basePath={'/admin/crm'}>
        <div className="p-8 text-center text-gray-500">{t('crm.leadNotFound', 'Lead nicht gefunden')}</div>
      </DashboardLayout>
    )
  }

  // ── Composer: abgeleitete Render-Werte (lead ist hier garantiert) ──────────
  const composeObjInfo = objectInfo()
  const composeRecipientOptions = [
    { value: 'client', label: `👤 ${t('crm.compose.client', 'Klient')}: ${lead.first_name} ${lead.last_name}` },
    ...businessContacts
      .filter(c => (composeChannel === 'email' ? !!c.email : !!(c.whatsapp || c.phone)))
      .map(c => ({
        value: `bc:${c.id}`,
        label: `📇 ${`${c.first_name} ${c.last_name ?? ''}`.trim()}${c.company ? ` · ${c.company}` : ''}${c.role ? ` (${c.role})` : ''}`,
      })),
    ...devContacts
      .filter(c => (composeChannel === 'email' ? !!c.email : !!(c.whatsapp || c.phone)))
      .map(c => ({
        value: `dc:${c.id}`,
        label: `🏗 ${c.name}${c.developer_name ? ` · ${c.developer_name}` : ''}${c.role ? ` (${c.role})` : ''}`,
      })),
  ]
  const composeSel  = resolveRecipient()
  const composeAddr = composeChannel === 'email'
    ? (composeSel?.email ?? '—')
    : (composeSel?.whatsapp || composeSel?.phone || '—')

  // ── Render ──────────────────────────────────────────────────────
  return (
    <DashboardLayout basePath={'/admin/crm'}>
      <div className="min-h-screen bg-gray-50 pb-16">
        {/* Toast */}
        {toast && (
          <div className="fixed top-4 right-4 z-50 bg-green-600 text-white px-4 py-2 rounded-xl shadow-lg text-sm">
            {toast}
          </div>
        )}

        <div className="max-w-5xl mx-auto px-4 pt-6 space-y-4">

          {/* Back */}
          <button
            onClick={() => navigate('/admin/crm')}
            className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
          >
            ← {t('crm.backToList', 'Zurück zur Übersicht')}
          </button>

          {/* ── Lead Header Card ──────────────────────────────────── */}
          <div className="bg-white rounded-2xl shadow p-6">
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
              {/* Avatar */}
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center text-white text-xl font-bold flex-shrink-0"
                style={{ backgroundColor: '#ff795d' }}
              >
                {initials}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-2xl font-bold text-gray-900 truncate">
                    {lead.first_name} {lead.last_name}
                  </h1>
                  {lead.profile_id && (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700 shrink-0">
                      🏠 {t('leadDetail.ownerBadge', 'Eigentümer')}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-3 mt-1 text-sm text-gray-600">
                  <a href={`mailto:${lead.email}`} className="hover:text-orange-500 truncate">
                    {lead.email}
                  </a>
                  {lead.phone && (
                    <a href={`tel:${lead.phone}`} className="hover:text-orange-500">
                      {lead.phone}
                    </a>
                  )}
                  {lead.whatsapp && (
                    <a
                      href={`https://wa.me/${lead.whatsapp.replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-green-600"
                    >
                      📱 {lead.whatsapp}
                    </a>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {/* Source badge */}
                  <span
                    className="px-2 py-0.5 rounded-full text-xs font-medium"
                    style={SOURCE_BADGE_STYLE[lead.source] ?? SOURCE_BADGE_STYLE.sonstiges}
                  >
                    {t(`crm.sources.${lead.source}`, lead.source)}
                  </span>
                  {/* Phase badge */}
                  {deal && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700">
                      {PHASE_ICONS[deal.phase]} {deal.phase}
                    </span>
                  )}
                  {/* Assignee */}
                  {lead.assignee && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                      👤 {lead.assignee.full_name}
                    </span>
                  )}
                </div>
              </div>

            </div>

            {/* ── Direkt-Aktionen (große Felder) ────────────────────── */}
            <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {([
                { key: 'mail', icon: '📧', label: t('crm.action.mail', 'Mail senden'),         cls: 'bg-orange-50 text-orange-700 hover:bg-orange-100',  on: () => { setComposeChannel('email'); setComposeTo('client'); goTab('emails') } },
                { key: 'wa',   icon: '📱', label: t('crm.action.whatsapp', 'WhatsApp öffnen'),  cls: 'bg-green-50 text-green-700 hover:bg-green-100',     on: () => { const link = waLink(lead.whatsapp || lead.phone); if (link) window.open(link, '_blank', 'noopener'); else showToast(t('crm.compose.errNoPhone', '❌ Dieser Kontakt hat keine WhatsApp-/Telefonnummer')); } },
                { key: 'note', icon: '📝', label: t('crm.action.note', 'Notiz erstellen'),      cls: 'bg-slate-100 text-slate-700 hover:bg-slate-200',   on: () => goTab('activities') },
                { key: 'task', icon: '✅', label: t('crm.action.task', 'Aufgabe erstellen'),    cls: 'bg-blue-50 text-blue-700 hover:bg-blue-100',       on: () => goTab('tasks') },
                { key: 'appt', icon: '📅', label: t('crm.action.appt', 'Termin erstellen'),     cls: 'bg-violet-50 text-violet-700 hover:bg-violet-100', on: () => setShowApptModal(true) },
                { key: 'deck', icon: '📑', label: t('crm.action.deck', 'Sales Deck erstellen'), cls: 'bg-rose-50 text-rose-700 hover:bg-rose-100',       on: () => setShowWizard(true) },
                { key: 'calc', icon: '📊', label: t('crm.action.calc', 'Rechnung erstellen'),   cls: 'bg-teal-50 text-teal-700 hover:bg-teal-100',       on: () => setShowRechner(true) },
              ] as const).map(a => (
                <button key={a.key} onClick={a.on}
                  className={`flex flex-col items-center justify-center gap-1.5 py-4 px-2 rounded-xl font-medium text-sm transition-colors ${a.cls}`}>
                  <span className="text-2xl leading-none">{a.icon}</span>
                  <span className="text-center leading-tight">{a.label}</span>
                </button>
              ))}
              {/* Drive: öffnen wenn vorhanden, sonst anlegen */}
              {lead.drive_folder_url ? (
                <a href={lead.drive_folder_url} target="_blank" rel="noreferrer"
                  className="flex flex-col items-center justify-center gap-1.5 py-4 px-2 rounded-xl font-medium text-sm transition-colors bg-amber-50 text-amber-700 hover:bg-amber-100">
                  <span className="text-2xl leading-none">📁</span>
                  <span className="text-center leading-tight">{t('crm.action.driveOpen', 'Drive öffnen')}</span>
                </a>
              ) : (
                <button onClick={createDriveFolder} disabled={driveBusy}
                  className="flex flex-col items-center justify-center gap-1.5 py-4 px-2 rounded-xl font-medium text-sm transition-colors bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-50">
                  <span className="text-2xl leading-none">📁</span>
                  <span className="text-center leading-tight">{driveBusy ? t('crm.action.driveCreating', 'Erstelle…') : t('crm.action.driveCreate', 'Drive erstellen')}</span>
                </button>
              )}
              {/* Portalzugang */}
              <button onClick={lead?.portal_access_sent_at ? resendPortalAccess : openPortal} disabled={resendingPortal}
                className="flex flex-col items-center justify-center gap-1.5 py-4 px-2 rounded-xl font-medium text-sm transition-colors text-white disabled:opacity-60"
                style={{ backgroundColor: lead?.portal_access_sent_at ? '#16a34a' : '#ff795d' }}>
                <span className="text-2xl leading-none">{resendingPortal ? '⏳' : '🔑'}</span>
                <span className="text-center leading-tight">{lead?.portal_access_sent_at ? t('crm.action.portalResend', 'Zugang erneut') : t('crm.action.portal', 'Portalzugang')}</span>
              </button>
              {/* Deal löschen (z.B. versehentlich mehrfach angelegt) — Kontakt bleibt erhalten */}
              {deal && (
                <button onClick={handleDeleteDeal} disabled={saving}
                  className="flex flex-col items-center justify-center gap-1.5 py-4 px-2 rounded-xl font-medium text-sm transition-colors bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50">
                  <span className="text-2xl leading-none">🗑</span>
                  <span className="text-center leading-tight">{t('crm.action.deleteDeal', 'Deal löschen')}</span>
                </button>
              )}
            </div>
          </div>

          {/* ── Phase Actions Card ────────────────────────────────── */}
          {deal && (
            <div className="bg-white rounded-2xl shadow p-6">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">
                {t('crm.phaseActions', 'Phasen-Aktionen')} — {PHASE_ICONS[deal.phase]} {deal.phase}
              </h2>

              {/* Pipeline phase selector */}
              <div className="flex flex-wrap gap-2 mb-4">
                {(['erstkontakt','termin_gebucht','no_show','finanzierung_de','finanzierung_cy','registrierung','immobilienauswahl','kaufvertrag','anzahlung','provision_erhalten','deal_verloren'] as DealPhase[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => updateDealPhase(p)}
                    disabled={saving || deal.phase === p}
                    className={`px-2 py-1 text-xs rounded-lg border transition-colors ${
                      deal.phase === p
                        ? 'border-orange-400 bg-orange-50 text-orange-600 font-semibold'
                        : 'border-gray-200 text-gray-500 hover:border-orange-300 hover:text-orange-500'
                    }`}
                  >
                    {PHASE_ICONS[p]} {p}
                  </button>
                ))}
              </div>

              {/* Phase-specific actions */}
              <div className="border-t pt-4 space-y-3">

                {/* no_show */}
                {deal.phase === 'no_show' && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => {
                          setActiveTab('emails')
                          const noshowTpl = templates.find((tpl) => tpl.category === 'noshow')
                          if (noshowTpl) handleTemplateSelect(noshowTpl.id)
                          sendWebhook('deal.no_show')
                        }}
                        className="px-4 py-2 rounded-lg text-white text-sm font-medium"
                        style={{ backgroundColor: '#ff795d' }}
                      >
                        📅 {t('crm.requestNewAppointment', 'Neuen Termin anfragen')}
                      </button>
                      <button
                        onClick={openWaPreview}
                        disabled={!lead.whatsapp && !lead.phone}
                        className="px-4 py-2 rounded-lg text-sm font-medium border-2 border-green-500
                                   text-green-700 hover:bg-green-50 disabled:opacity-40 transition-colors"
                      >
                        📱 {t('crm.sendWhatsapp', 'WhatsApp senden')}
                      </button>
                    </div>

                    {/* WhatsApp Vorschau */}
                    {showWaPreview && (
                      <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">
                            📱 {t('crm.whatsappPreview', 'WhatsApp Vorschau')}
                          </p>
                          <span className="text-xs text-gray-500">
                            {lead.whatsapp ?? lead.phone}
                          </span>
                        </div>
                        <textarea
                          value={waMsg}
                          onChange={e => setWaMsg(e.target.value)}
                          rows={8}
                          className="w-full border border-green-200 rounded-lg px-3 py-2 text-sm
                                     focus:outline-none focus:border-green-400 resize-none bg-white
                                     font-mono leading-relaxed"
                        />
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => setShowWaPreview(false)}
                            className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                          >
                            {t('common.cancel', 'Abbrechen')}
                          </button>
                          <button
                            onClick={handleSendWhatsappNoShow}
                            disabled={sendingWa || !waMsg.trim()}
                            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50
                                       flex items-center gap-2 bg-green-600 hover:bg-green-700"
                          >
                            {sendingWa && (
                              <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                            )}
                            📱 {sendingWa
                              ? t('crm.sending', 'Sendet…')
                              : t('crm.sendNow', 'Jetzt senden')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* registrierung */}
                {deal.phase === 'registrierung' && (
                  <div className="space-y-3">
                    <button
                      onClick={() => setShowRegistrationModal(true)}
                      disabled={saving}
                      className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                      style={{ backgroundColor: '#ff795d' }}
                    >
                      📋 {t('crm.sendRegistration', 'Registrierung senden')}
                    </button>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">
                        {t('crm.phaseNote.registration', 'Bemerkungen zur Registrierung')}
                      </label>
                      <div className="flex gap-2">
                        <textarea
                          value={regNotes}
                          onChange={e => setRegNotes(e.target.value)}
                          rows={2}
                          placeholder={t('crm.phaseNote.registrationPlaceholder', 'z.B. Bevorzugte Unit, besondere Wünsche…')}
                          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm
                                     focus:outline-none focus:border-orange-400 resize-none"
                        />
                        <button
                          onClick={handleSaveRegNotes}
                          className="px-3 py-1 text-xs rounded-lg border border-gray-200 text-gray-600
                                     hover:bg-gray-50 self-end whitespace-nowrap"
                        >
                          {t('common.save', 'Speichern')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* finanzierung_de / finanzierung_cy */}
                {(deal.phase === 'finanzierung_de' || deal.phase === 'finanzierung_cy') && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-4 items-center">
                      <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={financingRequired}
                          onChange={(e) => handleFinancingToggle(e.target.checked)}
                          className="w-4 h-4 rounded"
                        />
                        {t('crm.financingRequired', 'Finanzierung benötigt')}
                      </label>
                      <button
                        onClick={handleFinancingNotify}
                        disabled={saving}
                        className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                        style={{ backgroundColor: '#ff795d' }}
                      >
                        💰 {t('crm.notifyPartner', 'Partner informieren')}
                      </button>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">
                        {deal.phase === 'finanzierung_de'
                          ? t('crm.phaseNote.finanzierungDE', 'Bemerkungen Finanzierung DE')
                          : t('crm.phaseNote.finanzierungCY', 'Bemerkungen Finanzierung CY')}
                      </label>
                      <textarea
                        value={deal.phase === 'finanzierung_de' ? finDENotes : finCYNotes}
                        onChange={e =>
                          deal.phase === 'finanzierung_de'
                            ? setFinDENotes(e.target.value)
                            : setFinCYNotes(e.target.value)
                        }
                        rows={2}
                        placeholder={t('crm.phaseNote.finanzierungPlaceholder', 'z.B. Finanzierungspartner, Betrag, Konditionen…')}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm
                                   focus:outline-none focus:border-orange-400 resize-none"
                      />
                      <p className="text-xs text-gray-400 mt-1">
                        {t('crm.phaseNote.saveWithAction', 'Wird beim Klick auf „Partner informieren" gespeichert.')}
                      </p>
                    </div>
                  </div>
                )}

                {/* immobilienauswahl */}
                {deal.phase === 'immobilienauswahl' && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">
                        {t('crm.phaseNote.immobilien', 'Bemerkungen zur Immobilienauswahl')}
                      </label>
                      <div className="flex gap-2">
                        <textarea
                          value={immoNotes}
                          onChange={e => setImmoNotes(e.target.value)}
                          rows={2}
                          placeholder={t('crm.phaseNote.immobilienPlaceholder', 'z.B. Interessiert an Nordturm, Unit ab 3. OG, Meerblick…')}
                          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm
                                     focus:outline-none focus:border-orange-400 resize-none"
                        />
                        <button
                          onClick={handleSaveImmoNotes}
                          className="px-3 py-1 text-xs rounded-lg border border-gray-200 text-gray-600
                                     hover:bg-gray-50 self-end whitespace-nowrap"
                        >
                          {t('common.save', 'Speichern')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* kaufvertrag */}
                {deal.phase === 'kaufvertrag' && (
                  <div className="space-y-4">

                    {/* Google Drive + Anwalt */}
                    <div className="flex flex-wrap gap-3 items-end">
                      <div className="flex-1 min-w-[260px]">
                        <label className="block text-xs text-gray-500 mb-1">{t('crm.googleDriveUrl', 'Google Drive URL')}</label>
                        <input
                          type="url"
                          value={driveUrl}
                          onChange={(e) => setDriveUrl(e.target.value)}
                          placeholder="https://drive.google.com/..."
                          className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400"
                        />
                      </div>
                      <button
                        onClick={handleLawyerNotify}
                        disabled={saving}
                        className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                        style={{ backgroundColor: '#ff795d' }}
                      >
                        📝 {t('crm.notifyLawyer', 'Anwalt informieren')}
                      </button>
                    </div>

                    {/* ── Wohnungszuweisung ──────────────────────────── */}
                    <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold text-gray-800">{t('crm.assignUnit.title')}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {t('crm.assignUnit.subtitle')}
                          </p>
                        </div>
                        <button
                          onClick={() => setShowUnitPicker(true)}
                          className="px-3 py-1.5 text-xs font-medium text-white rounded-lg shrink-0"
                          style={{ backgroundColor: '#ff795d' }}
                        >
                          {pickedUnit ?? deal.property ? t('crm.assignUnit.change') : t('crm.assignUnit.select')}
                        </button>
                      </div>

                      {/* Show assigned property from deal (already saved in DB) */}
                      {deal.property && !pickedUnit && (
                        <div className="bg-white rounded-lg px-3 py-2 text-sm flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-green-500">✅</span>
                            <span className="font-medium text-gray-800 truncate">{deal.property.project_name}</span>
                            {deal.property.unit_number && (
                              <span className="text-gray-400 shrink-0">· {t('crm.unitSelect.no')} {deal.property.unit_number}</span>
                            )}
                          </div>
                          <button
                            onClick={async () => {
                              const { data } = await supabase
                                .from('crm_project_units')
                                .select('*')
                                .eq('property_id', deal.property_id!)
                                .maybeSingle()
                              if (data) openUnitEdit(data as CrmProjectUnit)
                              else showToast(t('crm.assignUnit.noLinkedUnit'))
                            }}
                            className="shrink-0 text-[11px] px-2.5 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
                          >
                            ✏️ {t('common.edit')}
                          </button>
                        </div>
                      )}

                      {/* Show freshly picked unit (before page reload) */}
                      {pickedUnit && (
                        <div className="bg-white rounded-xl p-3 space-y-2 border border-orange-100">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-[#ff795d] uppercase tracking-wide">
                              {t('crm.assignUnit.assignedUnit')}
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => navigate(`/admin/crm/projects/${unitSelectProjectId ?? dealProjects.find(dp => dp.project?.name === pickedUnit?.projectName)?.project_id ?? ''}`)}
                                className="text-[10px] text-gray-400 hover:text-[#ff795d] transition-colors"
                              >
                                {t('crm.assignUnit.toProject')}
                              </button>
                              <span className="text-[10px] text-green-600 font-medium bg-green-50 px-2 py-0.5 rounded-full">
                                {t('crm.assignUnit.markedSold')}
                              </span>
                              <button
                                onClick={() => openUnitEdit(pickedUnit.unit)}
                                className="text-[11px] px-2.5 py-0.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
                              >
                                ✏️ {t('common.edit')}
                              </button>
                            </div>
                          </div>
                          <p className="text-sm font-bold text-gray-900">
                            {pickedUnit.projectName}
                            {pickedUnit.unit.block ? ` · Block ${pickedUnit.unit.block}` : ''}
                            {` · Nr. ${pickedUnit.unit.unit_number}`}
                          </p>
                          <div className="grid grid-cols-3 gap-x-4 gap-y-0.5 text-[11px] text-gray-600">
                            {pickedUnit.unit.size_sqm != null && (
                              <span>📐 {pickedUnit.unit.size_sqm} m²</span>
                            )}
                            {pickedUnit.unit.bedrooms > 0 && (
                              <span>🛏 {pickedUnit.unit.bedrooms} {t('crm.unitSelect.bedroomsAbbr')}</span>
                            )}
                            {pickedUnit.unit.bathrooms > 0 && (
                              <span>🚿 {pickedUnit.unit.bathrooms} {t('crm.assignUnit.bathAbbr')}</span>
                            )}
                            {pickedUnit.unit.price_gross != null && (
                              <span className="font-semibold text-gray-800 col-span-3">
                                💶{' '}
                                {new Intl.NumberFormat('de-DE', {
                                  style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
                                }).format(pickedUnit.unit.price_gross)} {t('crm.assignUnit.gross')}
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Portal access button */}
                      <button
                        onClick={lead?.portal_access_sent_at ? resendPortalAccess : openPortal}
                        disabled={resendingPortal}
                        className="w-full py-2 text-xs font-medium text-white rounded-lg disabled:opacity-60 transition-colors"
                        style={{ backgroundColor: lead?.portal_access_sent_at ? '#16a34a' : '#ff795d' }}
                      >
                        {resendingPortal
                          ? t('crm.portalBtn.resetting')
                          : lead?.portal_access_sent_at
                            ? t('crm.portalBtn.sentResend')
                            : t('crm.portalBtn.createSend')}
                      </button>
                    </div>

                    {/* Kaufvertrag notes */}
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">
                        {t('crm.phaseNote.kaufvertrag', 'Bemerkungen zum Kaufvertrag')}
                      </label>
                      <textarea
                        value={kaufNotes}
                        onChange={e => setKaufNotes(e.target.value)}
                        rows={2}
                        placeholder={t('crm.phaseNote.kaufvertragPlaceholder', 'z.B. Anwalt beauftragt, besondere Klauseln, Fristen…')}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm
                                   focus:outline-none focus:border-orange-400 resize-none"
                      />
                      <p className="text-xs text-gray-400 mt-1">
                        {t('crm.phaseNote.saveWithAction', 'Wird beim Klick auf „Anwalt informieren" gespeichert.')}
                      </p>
                    </div>
                  </div>
                )}

                {/* anzahlung */}
                {deal.phase === 'anzahlung' && (
                  <div className="flex flex-wrap gap-3 items-end">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('crm.depositDate', 'Anzahlungsdatum')}</label>
                      <input
                        type="date"
                        value={depositDate}
                        onChange={(e) => setDepositDate(e.target.value)}
                        className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400"
                      />
                    </div>
                    <button
                      onClick={handleDepositCommission}
                      disabled={saving}
                      className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                      style={{ backgroundColor: '#ff795d' }}
                    >
                      ✅ {t('crm.requestCommission', 'Provision anfordern')}
                    </button>
                  </div>
                )}

                {/* provision_erhalten */}
                {deal.phase === 'provision_erhalten' && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-3 items-end">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">{t('crm.commissionAmount', 'Provision (€)')}</label>
                        <input
                          type="number"
                          value={commissionAmount}
                          onChange={(e) => setCommissionAmount(e.target.value)}
                          placeholder="0.00"
                          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400 w-40"
                        />
                      </div>
                      <button
                        onClick={handleDealClose}
                        disabled={saving}
                        className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50 bg-orange-500 hover:bg-orange-600"
                      >
                        🎉 {t('crm.closeDeal', 'Deal abschließen')}
                      </button>
                      <button
                        onClick={handleCommissionWhatsapp}
                        disabled={saving}
                        className="px-4 py-2 rounded-lg text-sm font-medium border-2 border-green-500
                                   text-green-700 hover:bg-green-50 disabled:opacity-50 transition-colors"
                      >
                        📱 {t('crm.commissionWhatsapp', 'Provision via WhatsApp')}
                      </button>
                      <button
                        onClick={lead?.portal_access_sent_at ? resendPortalAccess : openPortal}
                        disabled={resendingPortal}
                        className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-60 transition-colors"
                        style={{ backgroundColor: lead?.portal_access_sent_at ? '#16a34a' : '#ff795d' }}
                      >
                        {resendingPortal
                          ? '⏳ …'
                          : lead?.portal_access_sent_at
                            ? t('crm.portalBtn.sentResend')
                            : `🔑 ${t('crm.sendPortalAccess', 'Portalzugang senden')}`}
                      </button>
                      <button
                        onClick={handleArchive}
                        disabled={saving}
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 disabled:opacity-50"
                      >
                        📦 {t('crm.archive', 'Archivieren')}
                      </button>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">
                        {t('crm.phaseNote.provision', 'Bemerkungen zur Provision')}
                      </label>
                      <textarea
                        value={provNotes}
                        onChange={e => setProvNotes(e.target.value)}
                        rows={2}
                        placeholder={t('crm.phaseNote.provisionPlaceholder', 'z.B. Zahlungseingang bestätigt, Besonderheiten…')}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm
                                   focus:outline-none focus:border-orange-400 resize-none"
                      />
                      <p className="text-xs text-gray-400 mt-1">
                        {t('crm.phaseNote.saveWithDealClose', 'Wird beim Klick auf „Deal abschließen" gespeichert.')}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Tabs ─────────────────────────────────────────────── */}
          <div ref={tabsRef} className="bg-white rounded-2xl shadow overflow-hidden scroll-mt-4">
            {/* Tab bar */}
            <div className="flex border-b border-gray-100 overflow-x-auto">
              {([
                { id: 'overview',     label: t('crm.tab.overview',      'Übersicht') },
                { id: 'notes',        label: `📝 ${t('crm.tab.notes', 'Notizen')}` },
                { id: 'appointments', label: t('crm.tab.appointments',  `📅 Termine${appointments.length ? ` (${appointments.length})` : ''}`) },
                { id: 'activities',   label: t('crm.tab.activities',    'Aktivitäten') },
                { id: 'ai',           label: `🤖 ${t('crm.tab.ai',      'KI-Antwort')}` },
                { id: 'emails',       label: t('crm.tab.emails',        'E-Mails') },
                { id: 'tasks',        label: t('crm.tab.tasks',         'Aufgaben') },
                { id: 'documents',    label: t('crm.tab.documents',     'Dokumente') },
                {
                  id: 'scheduled',
                  label: `⚡ ${t('crm.tab.scheduled', 'Geplant')}${scheduledMessages.filter(m => m.status === 'pending').length ? ` (${scheduledMessages.filter(m => m.status === 'pending').length})` : ''}`,
                },
                {
                  id: 'portal',
                  label: `🔑 ${t('crm.tab.portal', 'Portal')}${portalLoginLog.length ? ` (${portalLoginLog.length})` : ''}`,
                },
                ...(deal?.unit_id ? [{
                  id: 'wohnung' as TabId,
                  label: `🏠 ${t('crm.tab.wohnung', 'Wohnung')}${unitDocs.length ? ` (${unitDocs.length})` : ''}`,
                }] : []),
              ] as { id: TabId; label: string }[]).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                    activeTab === tab.id
                      ? 'border-b-2 border-orange-400 text-orange-500'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ── Tab: Overview ─────────────────────────────────── */}
            {activeTab === 'overview' && (
              <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-6">
                {/* Registrierungen bei Developern (Provisionsschutz) */}
                <div className="sm:col-span-2"><LeadRegistrations leadId={lead.id} /></div>
                {/* Gesendete Angebote (Decks/Berechnungen/Mails) — dauerhafte Historie */}
                <div className="sm:col-span-2"><LeadAngebote leadId={lead.id} /></div>
                {/* Stammdaten */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                      {t('crm.masterData', 'Stammdaten')}
                    </h3>
                    {!editingLead && (
                      <button
                        onClick={openLeadEdit}
                        className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                      >
                        ✏️ {t('common.edit')}
                      </button>
                    )}
                  </div>

                  {/* ── Ansichtsmodus ── */}
                  {!editingLead && (
                    <dl className="space-y-2 text-sm">
                      <div className="flex gap-2">
                        <dt className="text-gray-500 w-28 flex-shrink-0">{t('crm.name', 'Name')}</dt>
                        <dd className="text-gray-900 font-medium">{lead.first_name} {lead.last_name}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-gray-500 w-28 flex-shrink-0">{t('crm.lead.email', 'E-Mail')}</dt>
                        <dd><a href={`mailto:${lead.email}`} className="text-orange-500 hover:underline">{lead.email}</a></dd>
                      </div>
                      {lead.phone && (
                        <div className="flex gap-2">
                          <dt className="text-gray-500 w-28 flex-shrink-0">{t('crm.phone', 'Telefon')}</dt>
                          <dd><a href={`tel:${lead.phone}`} className="text-orange-500 hover:underline">{lead.phone}</a></dd>
                        </div>
                      )}
                      {lead.whatsapp && (
                        <div className="flex gap-2">
                          <dt className="text-gray-500 w-28 flex-shrink-0">WhatsApp</dt>
                          <dd className="text-gray-900">{lead.whatsapp}</dd>
                        </div>
                      )}
                      {lead.country && (
                        <div className="flex gap-2">
                          <dt className="text-gray-500 w-28 flex-shrink-0">{t('crm.country', 'Land')}</dt>
                          <dd className="text-gray-900">{lead.country}</dd>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <dt className="text-gray-500 w-28 flex-shrink-0">{t('crm.source', 'Quelle')}</dt>
                        <dd>
                          <span
                            className="px-2 py-0.5 rounded-full text-xs font-medium"
                            style={SOURCE_BADGE_STYLE[lead.source] ?? SOURCE_BADGE_STYLE.sonstiges}
                          >
                            {t(`crm.sources.${lead.source}`, lead.source)}
                          </span>
                        </dd>
                      </div>
                      {(lead.utm_source || lead.utm_campaign || lead.utm_content) && (
                        <div className="flex gap-2">
                          <dt className="text-gray-500 w-28 flex-shrink-0">{t('crm.lead.channel', 'Kanal')}</dt>
                          <dd className="text-gray-900">
                            {adChannelLabel(lead.utm_source) && (
                              <span className="font-medium">{adChannelLabel(lead.utm_source)}</span>
                            )}
                            {lead.utm_campaign && <span className="text-gray-500">{adChannelLabel(lead.utm_source) ? ' · ' : ''}{lead.utm_campaign}</span>}
                            {lead.utm_content && <span className="text-gray-400"> · {lead.utm_content}</span>}
                          </dd>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <dt className="text-gray-500 w-28 flex-shrink-0">{t('crm.language', 'Sprache')}</dt>
                        <dd className="text-gray-900">{lead.language.toUpperCase()}</dd>
                      </div>
                      {lead.assignee && (
                        <div className="flex gap-2">
                          <dt className="text-gray-500 w-28 flex-shrink-0">{t('crm.assignedTo', 'Zuständig')}</dt>
                          <dd className="text-gray-900">{lead.assignee.full_name}</dd>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <dt className="text-gray-500 w-28 flex-shrink-0">{t('crm.createdAt', 'Erstellt')}</dt>
                        <dd className="text-gray-900">{formatDate(lead.created_at)}</dd>
                      </div>
                      {lead.notes && (
                        <div className="flex gap-2">
                          <dt className="text-gray-500 w-28 flex-shrink-0">{t('crm.notes', 'Notizen')}</dt>
                          <dd className="text-gray-900 whitespace-pre-wrap">{lead.notes}</dd>
                        </div>
                      )}
                    </dl>
                  )}

                  {/* ── Bearbeitungsmodus ── */}
                  {editingLead && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.firstName')} *</label>
                          <input
                            value={leadForm.first_name}
                            onChange={e => setLeadForm(f => ({ ...f, first_name: e.target.value }))}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.lastName')}</label>
                          <input
                            value={leadForm.last_name}
                            onChange={e => setLeadForm(f => ({ ...f, last_name: e.target.value }))}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.email')} *</label>
                        <input
                          type="email"
                          value={leadForm.email}
                          onChange={e => setLeadForm(f => ({ ...f, email: e.target.value }))}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.phone')}</label>
                          <input
                            value={leadForm.phone}
                            onChange={e => setLeadForm(f => ({ ...f, phone: e.target.value }))}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                            placeholder="+43 …"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.whatsapp')}</label>
                          <input
                            value={leadForm.whatsapp}
                            onChange={e => setLeadForm(f => ({ ...f, whatsapp: e.target.value }))}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                            placeholder="+43 …"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.altEmails', 'Weitere E-Mails (Komma-getrennt)')}</label>
                          <input
                            value={leadForm.alt_emails}
                            onChange={e => setLeadForm(f => ({ ...f, alt_emails: e.target.value }))}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                            placeholder="privat@gmail.com, buero@firma.de"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.altPhones', 'Weitere Nummern (Komma-getrennt)')}</label>
                          <input
                            value={leadForm.alt_phones}
                            onChange={e => setLeadForm(f => ({ ...f, alt_phones: e.target.value }))}
                            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                            placeholder="+49 …, +357 …"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.country')}</label>
                        <input
                          value={leadForm.country}
                          onChange={e => setLeadForm(f => ({ ...f, country: e.target.value }))}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                          placeholder={t('crm.lead.countryPlaceholder', 'z.B. Deutschland')}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.source')}</label>
                          <CustomSelect
                            value={leadForm.source}
                            onChange={val => setLeadForm(f => ({ ...f, source: val }))}
                            className="w-full border border-gray-200 rounded-lg text-sm bg-white"
                            options={[
                              { value: 'meta', label: t('crm.sources.meta') },
                              { value: 'google', label: t('crm.sources.google') },
                              { value: 'empfehlung', label: t('crm.sources.empfehlung') },
                              { value: 'sonstiges', label: t('crm.sources.sonstiges') },
                            ]}
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.language')}</label>
                          <CustomSelect
                            value={leadForm.language}
                            onChange={val => setLeadForm(f => ({ ...f, language: val }))}
                            className="w-full border border-gray-200 rounded-lg text-sm bg-white"
                            options={[
                              { value: 'de', label: 'Deutsch' },
                              { value: 'en', label: 'English' },
                            ]}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.assignedTo')}</label>
                        <CustomSelect
                          value={leadForm.assigned_to}
                          onChange={val => setLeadForm(f => ({ ...f, assigned_to: val }))}
                          className="w-full border border-gray-200 rounded-lg text-sm bg-white"
                          options={[
                            { value: '', label: t('crm.allLeads.notAssigned') },
                            ...staff.map(s => ({ value: s.id, label: s.full_name })),
                          ]}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">{t('crm.lead.notes')}</label>
                        <textarea
                          rows={3}
                          value={leadForm.notes}
                          onChange={e => setLeadForm(f => ({ ...f, notes: e.target.value }))}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none"
                        />
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={() => setEditingLead(false)}
                          className="flex-1 py-2 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          onClick={handleSaveLead}
                          disabled={savingLead || !leadForm.first_name.trim() || !leadForm.email.trim()}
                          className="flex-1 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50"
                          style={{ backgroundColor: '#ff795d' }}
                        >
                          {savingLead ? t('common.saving') : '✓ ' + t('common.save')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Deal + Tasks + Property */}
                <div className="space-y-4">
                  {deal && (
                    <div>
                      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                        {t('crm.dealTitle', 'Deal')}
                      </h3>
                      <dl className="space-y-2 text-sm">
                        <div className="flex gap-2">
                          <dt className="text-gray-500 w-36 flex-shrink-0">{t('crm.phase', 'Phase')}</dt>
                          <dd className="text-gray-900">{PHASE_ICONS[deal.phase]} {deal.phase}</dd>
                        </div>
                        {deal.property && (
                          <div className="flex gap-2">
                            <dt className="text-gray-500 w-36 flex-shrink-0">{t('crm.property', 'Immobilie')}</dt>
                            <dd>
                              <Link
                                to={`/admin/properties/${deal.property.id}`}
                                className="text-orange-500 hover:underline"
                              >
                                {deal.property.project_name}
                                {deal.property.unit_number ? ` – ${deal.property.unit_number}` : ''}
                              </Link>
                            </dd>
                          </div>
                        )}
                        {deal.developer && (
                          <div className="flex gap-2">
                            <dt className="text-gray-500 w-36 flex-shrink-0">{t('crm.developer', 'Entwickler')}</dt>
                            <dd className="text-gray-900">{deal.developer}</dd>
                          </div>
                        )}
                        {deal.commission_amount != null && (
                          <div className="flex gap-2">
                            <dt className="text-gray-500 w-36 flex-shrink-0">{t('crm.commission', 'Provision')}</dt>
                            <dd className="text-gray-900 font-medium">€ {deal.commission_amount.toLocaleString('de-AT')}</dd>
                          </div>
                        )}
                        {deal.registration_sent_at && (
                          <div className="flex gap-2">
                            <dt className="text-gray-500 w-36 flex-shrink-0">{t('crm.registrationSentAt', 'Reg. gesendet')}</dt>
                            <dd className="text-gray-900">{formatDate(deal.registration_sent_at)}</dd>
                          </div>
                        )}
                      </dl>
                    </div>
                  )}

                  {/* Ausgewählte Projekte */}
                  {deal && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                          {t('crm.dealProject.title', 'Ausgewählte Projekte')}
                          {dealProjects.length > 0 && ` (${dealProjects.length})`}
                        </h3>
                        <button
                          onClick={() => setShowProjectModal(true)}
                          className="text-xs px-2.5 py-1 rounded-lg border border-orange-200 text-orange-600 hover:bg-orange-50"
                        >
                          {t('crm.dealProject.select', 'Projekte auswählen')}
                        </button>
                      </div>
                      {dealProjects.length === 0 ? (
                        <p className="text-xs text-gray-400">{t('crm.dealProject.empty', 'Noch keine Projekte ausgewählt.')}</p>
                      ) : (
                        <div className="space-y-2">
                          {dealProjects.map(dp => (
                            <div key={dp.id} className="border border-gray-100 rounded-xl p-3 bg-gray-50 text-sm">
                              <div className="flex items-start justify-between gap-2 mb-1">
                                <div className="font-medium text-gray-900 truncate min-w-0">
                                  {dp.project ? (
                                    <button
                                      onClick={() => navigate(`/admin/crm/projects/${dp.project_id}`)}
                                      className="hover:text-[#ff795d] hover:underline text-left truncate"
                                    >
                                      🏗 {dp.project.name}
                                    </button>
                                  ) : '–'}
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    onClick={() => handleActivateProject(dp.project_id)}
                                    className="text-[11px] px-2.5 py-1 rounded-lg font-medium text-white"
                                    style={{ backgroundColor: '#ff795d' }}
                                    title={t('leadDetail.activateProjectTitle', 'Wohnung auswählen und Käufer aktivieren')}
                                  >
                                    🔑 {t('leadDetail.activate', 'Aktivieren')}
                                  </button>
                                  <button
                                    onClick={() => handleDeleteDealProject(dp.id)}
                                    className="text-[11px] px-2 py-1 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 border border-gray-200"
                                    title={t('leadDetail.removeProjectTitle', 'Projekt aus Auswahl entfernen')}
                                  >
                                    ✕
                                  </button>
                                </div>
                              </div>
                              {dp.project?.location && (
                                <div className="text-xs text-gray-500 mb-1">📍 {dp.project.location}</div>
                              )}
                              <dl className="space-y-0.5 text-xs text-gray-600">
                                {dp.unit_numbers && (
                                  <div className="flex gap-2">
                                    <dt className="text-gray-400 w-16">{t('leadDetail.unitsLabel', 'Units')}</dt>
                                    <dd>{dp.unit_numbers}</dd>
                                  </div>
                                )}
                                {dp.price_net != null && (
                                  <div className="flex gap-2">
                                    <dt className="text-gray-400 w-16">{t('leadDetail.priceLabel', 'Preis')}</dt>
                                    <dd className="font-medium">€ {dp.price_net.toLocaleString('de-AT')}</dd>
                                  </div>
                                )}
                                {dp.notes && (
                                  <div className="flex gap-2">
                                    <dt className="text-gray-400 w-16">{t('leadDetail.noteLabel', 'Notiz')}</dt>
                                    <dd className="text-gray-600">{dp.notes}</dd>
                                  </div>
                                )}
                              </dl>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Phasen-Notizen */}
                  {deal && (() => {
                    const phaseNoteEntries: { label: string; value: string | null; phase: string }[] = [
                      { label: t('crm.phases.registrierung',      'Registrierung'),     value: deal.registration_notes,    phase: 'registrierung'      },
                      { label: t('crm.phases.finanzierung_de',    'Finanzierung DE'),   value: deal.finanzierung_de_notes, phase: 'finanzierung_de'    },
                      { label: t('crm.phases.finanzierung_cy',    'Finanzierung CY'),   value: deal.finanzierung_cy_notes, phase: 'finanzierung_cy'    },
                      { label: t('crm.phases.immobilienauswahl',  'Immobilienauswahl'), value: deal.immobilien_notes,      phase: 'immobilienauswahl'  },
                      { label: t('crm.phases.kaufvertrag',        'Kaufvertrag'),       value: deal.kaufvertrag_notes,     phase: 'kaufvertrag'        },
                      { label: t('crm.phases.provision_erhalten', 'Provision'),         value: deal.provision_notes,       phase: 'provision_erhalten' },
                    ].filter(n => n.value)
                    if (!phaseNoteEntries.length) return null
                    return (
                      <div>
                        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                          {t('crm.phaseNotes', 'Phasen-Notizen')}
                        </h3>
                        <div className="space-y-2">
                          {phaseNoteEntries.map(n => (
                            <div key={n.phase} className="flex gap-2 text-sm items-start">
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700 whitespace-nowrap shrink-0">
                                {PHASE_ICONS[n.phase as DealPhase]} {n.label}
                              </span>
                              <span className="text-gray-700 whitespace-pre-wrap">{n.value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })()}

                  {/* Open tasks */}
                  {tasks.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                        {t('crm.openTasks', 'Offene Aufgaben')} ({tasks.length})
                      </h3>
                      <ul className="space-y-2">
                        {tasks.slice(0, 3).map((task) => (
                          <li
                            key={task.id}
                            className={`text-sm px-3 py-2 rounded-lg border ${
                              isOverdue(task) ? 'border-red-200 bg-red-50' : 'border-gray-100 bg-gray-50'
                            }`}
                          >
                            <div className="font-medium text-gray-800">{task.subject}</div>
                            {task.scheduled_at && (
                              <div className={`text-xs mt-0.5 ${isOverdue(task) ? 'text-red-500' : 'text-gray-400'}`}>
                                {formatDate(task.scheduled_at)}
                                {isOverdue(task) && ` — ${t('leadDetail.overdueSuffix', 'Überfällig')}`}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: Aktivitäten ──────────────────────────────── */}
            {activeTab === 'notes' && (
              <div className="p-6 space-y-6">
                {/* Freies Notizfeld (lead.notes) */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-gray-700">{t('crm.notesTab.title', 'Notizen zum Kunden')}</h3>
                    <button onClick={() => void saveNotes()} disabled={savingNotes || notesDraft === (lead?.notes ?? '')}
                      className="px-4 py-1.5 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
                      {savingNotes ? t('common.saving', 'Speichern…') : t('common.save', 'Speichern')}
                    </button>
                  </div>
                  <textarea value={notesDraft} onChange={e => setNotesDraft(e.target.value)} rows={8}
                    placeholder={t('crm.notesTab.placeholder', 'Notizen zum Kunden — Wünsche, Budget, Gesprächsergebnisse…')}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-y" />
                  <p className="text-xs text-gray-400 mt-1">{t('crm.notesTab.hint', 'Hier landen auch die Antworten aus dem Formular (Typeform).')}</p>
                </div>

                {/* Gesprächsnotizen-Historie (aus dem Termin-Vorbereitungs-Popup) */}
                <div className="border-t pt-4">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">{t('crm.notesTab.callNotes', 'Gesprächsnotizen')}</h3>
                  {activities.filter(a => a.type === 'note').length === 0 ? (
                    <p className="text-sm text-gray-400 py-4">{t('crm.notesTab.noCallNotes', 'Noch keine Gesprächsnotizen. Notizen aus dem Termin-Popup erscheinen hier.')}</p>
                  ) : (
                    <ol className="space-y-3">
                      {activities.filter(a => a.type === 'note').map(act => (
                        <li key={act.id} className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="font-medium text-sm text-gray-800">{act.subject ?? t('crm.notesTab.note', 'Notiz')}</span>
                            <span className="text-xs text-gray-400">{formatDate(act.created_at)}</span>
                          </div>
                          {act.content && <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{act.content}</p>}
                          {act.creator && <p className="text-xs text-gray-400 mt-1">— {act.creator.full_name}</p>}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'activities' && (
              <div className="p-6">
                {/* Timeline */}
                {activities.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">
                    {t('crm.noActivities', 'Noch keine Aktivitäten')}
                  </p>
                ) : (
                  <ol className="relative border-l border-gray-200 space-y-6 mb-8">
                    {activities.map((act) => (
                      <li key={act.id} className="ml-4">
                        <div className="absolute -left-2 mt-1 w-4 h-4 rounded-full bg-white border-2 border-orange-300 flex items-center justify-center text-xs">
                          {ACTIVITY_ICONS[act.type] ?? '📌'}
                        </div>
                        <div className={`rounded-xl px-4 py-3 ${
                          act.type === 'whatsapp'
                            ? act.direction === 'outbound'
                              ? 'bg-green-50 border border-green-100'
                              : 'bg-gray-100 border border-gray-200'
                            : 'bg-gray-50'
                        }`}>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className={`font-medium text-sm ${
                              act.type === 'whatsapp'
                                ? act.direction === 'outbound' ? 'text-green-800' : 'text-gray-700'
                                : 'text-gray-800'
                            }`}>
                              {act.subject ?? act.type}
                            </span>
                            <span className="text-xs text-gray-400">{formatDate(act.created_at)}</span>
                          </div>
                          {act.content && (
                            <p className={`text-sm mt-1 whitespace-pre-wrap ${
                              act.type === 'whatsapp' ? 'text-green-900 font-mono text-xs leading-relaxed' : 'text-gray-600'
                            }`}>{act.content}</p>
                          )}
                          {act.creator && (
                            <p className="text-xs text-gray-400 mt-1">— {act.creator.full_name}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}

                {/* Add activity form */}
                <div className="border-t pt-4 space-y-3">
                  <h3 className="text-sm font-semibold text-gray-700">{t('crm.addActivity', 'Aktivität hinzufügen')}</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('crm.type', 'Typ')}</label>
                      <CustomSelect
                        value={actForm.type}
                        onChange={val => setActForm({ ...actForm, type: val })}
                        className="w-full border border-gray-200 rounded-lg text-sm"
                        options={[
                          { value: 'call', label: `📞 ${t('crm.actType.call', 'Anruf')}` },
                          { value: 'email', label: `📧 ${t('crm.actType.email', 'E-Mail')}` },
                          { value: 'whatsapp', label: '📱 WhatsApp' },
                          { value: 'note', label: `📝 ${t('crm.actType.note', 'Notiz')}` },
                          { value: 'meeting', label: `🤝 ${t('crm.actType.meeting', 'Meeting')}` },
                        ]}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('crm.direction', 'Richtung')}</label>
                      <CustomSelect
                        value={actForm.direction}
                        onChange={val => setActForm({ ...actForm, direction: val })}
                        className="w-full border border-gray-200 rounded-lg text-sm"
                        options={[
                          { value: 'outbound', label: t('crm.outbound', 'Ausgehend') },
                          { value: 'inbound', label: t('crm.inbound', 'Eingehend') },
                        ]}
                      />
                    </div>
                  </div>
                  <input
                    type="text"
                    value={actForm.subject}
                    onChange={(e) => setActForm({ ...actForm, subject: e.target.value })}
                    placeholder={t('crm.subjectOptional', 'Betreff (optional)')}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400"
                  />
                  <textarea
                    value={actForm.content}
                    onChange={(e) => setActForm({ ...actForm, content: e.target.value })}
                    placeholder={t('crm.content', 'Inhalt *')}
                    rows={3}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none"
                  />
                  <button
                    onClick={handleSaveActivity}
                    disabled={savingAct || !actForm.content.trim()}
                    className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                    style={{ backgroundColor: '#ff795d' }}
                  >
                    {savingAct ? t('crm.saving', 'Speichert…') : t('crm.save', 'Speichern')}
                  </button>
                </div>
              </div>
            )}

            {/* ── Tab: KI-Antwort (nur Entwurf — sendet NICHTS) ─── */}
            {activeTab === 'ai' && (
              <div className="p-6 space-y-5">
                {/* Sicherheits-Hinweis */}
                <div className="flex gap-2 items-start bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <span className="text-amber-500 text-lg leading-none">🛟</span>
                  <p className="text-xs text-amber-800 leading-relaxed">
                    {t('crm.ai.safety', 'Die KI erstellt nur Entwürfe. Es wird nichts automatisch gesendet. Du prüfst, korrigierst und gibst frei – kopierst den Text und schickst ihn wie gewohnt. Aus deinen Freigaben und Korrekturen lernt das System.')}
                  </p>
                </div>

                {/* Eingabe: Kundennachricht + Kanal */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <label className="block text-xs font-medium text-gray-500">
                      {t('crm.ai.inboundLabel', 'Eingehende Kundennachricht')}
                    </label>
                    <button
                      onClick={adoptLatestInbound}
                      className="text-xs font-medium px-2.5 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                    >
                      {t('crm.ai.adoptLatest', '↧ Letzte Kundennachricht übernehmen')}
                    </button>
                  </div>
                  <div className="flex gap-2">
                    {(['whatsapp', 'email'] as const).map((ch) => (
                      <button
                        key={ch}
                        onClick={() => setAiChannel(ch)}
                        className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                          aiChannel === ch
                            ? 'border-transparent text-white'
                            : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                        }`}
                        style={aiChannel === ch ? { backgroundColor: '#ff795d' } : undefined}
                      >
                        {ch === 'whatsapp' ? t('crm.ai.chWhatsapp', '📱 WhatsApp') : t('crm.ai.chEmail', '📧 E-Mail')}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={aiInbound}
                    onChange={(e) => setAiInbound(e.target.value)}
                    placeholder={t('crm.ai.inboundPh', 'Was hat der Kunde geschrieben? Hier einfügen oder oben übernehmen…')}
                    rows={4}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none"
                  />
                  <button
                    onClick={handleGenerateDraft}
                    disabled={aiGenerating || !aiInbound.trim()}
                    className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                    style={{ backgroundColor: '#ff795d' }}
                  >
                    {aiGenerating ? t('crm.ai.generating', 'KI denkt nach…') : t('crm.ai.generate', '✨ KI-Entwurf erstellen')}
                  </button>
                </div>

                {/* KI noch nicht aktiviert (Edge Function nicht deployt) */}
                {aiUnavailable && (
                  <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm text-gray-600 space-y-1">
                    <p className="font-medium text-gray-700">{t('crm.ai.unavailableTitle', 'KI-Funktion noch nicht aktiviert')}</p>
                    <p className="text-xs leading-relaxed">
                      {t('crm.ai.unavailableBody', 'Der KI-Entwurfs-Generator ist angelegt, aber noch nicht scharf geschaltet. Sobald du grünes Licht gibst, wird er aktiviert – danach funktioniert dieser Button. Bis dahin bleibt alles ein reiner Entwurf-Workflow.')}
                    </p>
                  </div>
                )}

                {/* Entwurf-Editor */}
                {(aiDraft || aiDraftOriginal) && (
                  <div className="border border-gray-200 rounded-xl p-4 space-y-3 bg-white">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-medium text-gray-500">
                        {t('crm.ai.draftLabel', 'KI-Entwurf (bearbeitbar)')}
                      </label>
                      {aiExamplesUsed !== null && (
                        <span className="text-[11px] text-gray-400">
                          {t('crm.ai.examplesUsed', 'Gelernte Beispiele genutzt')}: {aiExamplesUsed}
                        </span>
                      )}
                    </div>
                    <textarea
                      value={aiDraft}
                      onChange={(e) => setAiDraft(e.target.value)}
                      rows={6}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none"
                    />
                    {aiDraft.trim() !== aiDraftOriginal.trim() && aiDraftOriginal && (
                      <p className="text-[11px] text-blue-600">
                        {t('crm.ai.editedHint', '✏️ Korrigiert – wird als „korrigiert" gelernt.')}
                      </p>
                    )}
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={handleApproveDraft}
                        disabled={aiSaving || !aiDraft.trim()}
                        className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                        style={{ backgroundColor: '#ff795d' }}
                      >
                        {aiCopied
                          ? t('crm.ai.copied', '✓ Kopiert')
                          : aiSaving
                            ? t('crm.saving', 'Speichert…')
                            : t('crm.ai.approve', '✓ Freigeben & kopieren')}
                      </button>
                      <button
                        onClick={handleDiscardDraft}
                        disabled={aiSaving}
                        className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
                      >
                        {t('crm.ai.discard', 'Verwerfen')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Historie / gelernte Beispiele */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {t('crm.ai.historyTitle', 'Bisherige KI-Antworten zu diesem Lead')}
                  </h4>
                  {aiExamples.length === 0 ? (
                    <p className="text-sm text-gray-400">{t('crm.ai.historyEmpty', 'Noch keine KI-Entwürfe für diesen Lead.')}</p>
                  ) : (
                    <div className="space-y-2">
                      {aiExamples.map((ex) => (
                        <div key={ex.id} className="border border-gray-100 rounded-lg p-3 text-sm">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${AI_STATUS_CLS[ex.status] ?? 'bg-gray-100 text-gray-500'}`}>
                              {t(`crm.ai.st_${ex.status}`, ex.status)}
                            </span>
                            <span className="text-[11px] text-gray-400">{formatDate(ex.created_at)}</span>
                          </div>
                          {ex.inbound_text && (
                            <p className="text-xs text-gray-500 mb-1">
                              <span className="font-medium">{t('crm.ai.histInbound', 'Kunde')}:</span> {ex.inbound_text}
                            </p>
                          )}
                          {ex.final_text && (
                            <p className="text-xs text-gray-700 whitespace-pre-wrap">
                              <span className="font-medium">{t('crm.ai.histReply', 'Antwort')}:</span> {ex.final_text}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: E-Mails ──────────────────────────────────── */}
            {activeTab === 'emails' && (
              <div className="p-6 space-y-4">
                {/* Kanal-Umschalter */}
                <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                  <button
                    onClick={() => { setComposeChannel('email'); setComposeTo('client') }}
                    className={`px-4 py-1.5 font-medium transition-colors ${composeChannel === 'email' ? 'bg-orange-50 text-orange-600' : 'bg-white text-gray-500 hover:text-gray-700'}`}
                  >
                    📧 {t('crm.compose.email', 'E-Mail')}
                  </button>
                  <button
                    onClick={() => { setComposeChannel('whatsapp'); setComposeTo('client') }}
                    className={`px-4 py-1.5 font-medium border-l border-gray-200 transition-colors ${composeChannel === 'whatsapp' ? 'bg-green-50 text-green-700' : 'bg-white text-gray-500 hover:text-gray-700'}`}
                  >
                    📱 {t('crm.compose.whatsapp', 'WhatsApp')}
                  </button>
                </div>

                {/* Empfänger */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.compose.recipient', 'Empfänger')}</label>
                  <CustomSelect
                    value={composeTo}
                    onChange={setComposeTo}
                    className="w-full border border-gray-200 rounded-lg text-sm"
                    options={composeRecipientOptions}
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    {composeChannel === 'email' ? '✉️' : '📱'} {composeAddr}
                  </p>
                </div>

                {/* Objekt-Infos + Bemerkungen (Referenz beim Schreiben) */}
                <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {t('crm.compose.objectInfo', 'Klient & Objekt')}
                  </p>
                  <div className="space-y-1 text-xs">
                    <div className="flex gap-2">
                      <span className="w-24 text-gray-400 shrink-0">{t('crm.compose.client', 'Klient')}</span>
                      <span className="text-gray-700">
                        {lead.first_name} {lead.last_name}
                        {lead.email ? ` · ${lead.email}` : ''}
                        {lead.phone ? ` · ${lead.phone}` : ''}
                      </span>
                    </div>
                    {composeObjInfo.developer && (
                      <div className="flex gap-2">
                        <span className="w-24 text-gray-400 shrink-0">{t('crm.developer', 'Entwickler')}</span>
                        <span className="text-gray-700">{composeObjInfo.developer}</span>
                      </div>
                    )}
                    {composeObjInfo.projekt && (
                      <div className="flex gap-2">
                        <span className="w-24 text-gray-400 shrink-0">{t('crm.compose.project', 'Projekt')}</span>
                        <span className="text-gray-700">{composeObjInfo.projekt}</span>
                      </div>
                    )}
                    {composeObjInfo.wohnung && (
                      <div className="flex gap-2">
                        <span className="w-24 text-gray-400 shrink-0">{t('crm.compose.unit', 'Wohnung')}</span>
                        <span className="text-gray-700">{composeObjInfo.wohnung}</span>
                      </div>
                    )}
                    {composeObjInfo.preis && (
                      <div className="flex gap-2">
                        <span className="w-24 text-gray-400 shrink-0">{t('crm.compose.price', 'Preis')}</span>
                        <span className="text-gray-700">{composeObjInfo.preis}</span>
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">{t('crm.compose.remarks', 'Bemerkungen (frei)')}</label>
                    <textarea
                      value={bemerkungen}
                      onChange={(e) => setBemerkungen(e.target.value)}
                      rows={2}
                      placeholder={t('crm.compose.remarksPh', 'Freitext — einsetzbar als {{bemerkungen}}')}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-y bg-white"
                    />
                  </div>
                </div>

                {/* Vorlage + Betreff: nur E-Mail */}
                {composeChannel === 'email' && (
                  <>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('crm.emailTemplate', 'Vorlage')}</label>
                      <CustomSelect
                        value={emailForm.templateId}
                        onChange={val => handleTemplateSelect(val)}
                        className="w-full border border-gray-200 rounded-lg text-sm"
                        options={[
                          { value: '', label: t('crm.selectTemplate', '– Vorlage wählen –') },
                          ...templates.map(tpl => ({ value: tpl.id, label: `${tpl.name} (${tpl.language.toUpperCase()})` })),
                        ]}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('crm.subject', 'Betreff')}</label>
                      <input
                        type="text"
                        value={emailForm.subject}
                        onChange={(e) => setEmailForm({ ...emailForm, subject: e.target.value })}
                        placeholder={t('crm.subjectPlaceholder', 'Betreff eingeben…')}
                        className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400"
                      />
                    </div>
                  </>
                )}

                {/* Nachricht */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.body', 'Nachricht')}</label>
                  <textarea
                    value={emailForm.body}
                    onChange={(e) => setEmailForm({ ...emailForm, body: e.target.value })}
                    rows={10}
                    placeholder={t('crm.bodyPlaceholder', 'E-Mail-Text…')}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-y font-mono"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    {t('crm.placeholders', 'Platzhalter: {{vorname}}, {{nachname}}, {{email}}, {{phone}}, {{developer}}, {{projekt}}, {{wohnung}}, {{preis}}, {{bemerkungen}}')}
                  </p>
                </div>

                {/* Senden */}
                {composeChannel === 'email' ? (
                  <button
                    onClick={handleSendEmail}
                    disabled={sendingEmail || !emailForm.subject.trim() || !emailForm.body.trim()}
                    className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                    style={{ backgroundColor: '#ff795d' }}
                  >
                    {sendingEmail ? t('crm.sending', 'Sendet…') : `📧 ${t('crm.sendEmail', 'E-Mail senden')} → ${composeAddr}`}
                  </button>
                ) : (
                  <button
                    onClick={handleSendComposerWhatsapp}
                    disabled={sendingEmail || !emailForm.body.trim()}
                    className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50 bg-green-600 hover:bg-green-700"
                  >
                    {sendingEmail ? t('crm.sending', 'Sendet…') : `📱 ${t('crm.sendWhatsapp', 'WhatsApp senden')} → ${composeAddr}`}
                  </button>
                )}
              </div>
            )}

            {/* ── Tab: Aufgaben ─────────────────────────────────── */}
            {activeTab === 'tasks' && (
              <div className="p-6">
                {/* Task list */}
                {tasks.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6">
                    {t('crm.noTasks', 'Keine offenen Aufgaben')}
                  </p>
                ) : (
                  <ul className="space-y-3 mb-6">
                    {tasks.map((task) => (
                      <li
                        key={task.id}
                        className={`flex items-start justify-between gap-3 px-4 py-3 rounded-xl border ${
                          isOverdue(task) ? 'border-red-200 bg-red-50' : 'border-gray-100 bg-gray-50'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-gray-800 text-sm">{task.subject}</span>
                            {isOverdue(task) && (
                              <span className="px-1.5 py-0.5 text-xs rounded bg-red-100 text-red-600 font-medium">
                                {t('crm.overdue', 'Überfällig')}
                              </span>
                            )}
                          </div>
                          {task.content && (
                            <p className="text-xs text-gray-500 mt-0.5">{task.content}</p>
                          )}
                          {task.scheduled_at && (
                            <p className={`text-xs mt-0.5 ${isOverdue(task) ? 'text-red-500' : 'text-gray-400'}`}>
                              {formatDate(task.scheduled_at)}
                            </p>
                          )}
                          {task.creator && (
                            <p className="text-xs text-gray-400 mt-0.5">— {task.creator.full_name}</p>
                          )}
                        </div>
                        <button
                          onClick={() => handleCompleteTask(task.id)}
                          className="flex-shrink-0 px-3 py-1.5 text-xs rounded-lg bg-green-50 text-green-600 hover:bg-green-100 font-medium"
                        >
                          {t('crm.markDone', 'Als erledigt ✓')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Add task form */}
                <div className="border-t pt-4 space-y-3">
                  <h3 className="text-sm font-semibold text-gray-700">{t('crm.addTask', 'Aufgabe anlegen')}</h3>
                  <input
                    type="text"
                    value={taskForm.subject}
                    onChange={(e) => setTaskForm({ ...taskForm, subject: e.target.value })}
                    placeholder={`${t('crm.title', 'Titel')} *`}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400"
                  />
                  <textarea
                    value={taskForm.content}
                    onChange={(e) => setTaskForm({ ...taskForm, content: e.target.value })}
                    placeholder={t('crm.description', 'Beschreibung (optional)')}
                    rows={2}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('crm.dueDate', 'Fällig am')}</label>
                      <input
                        type="datetime-local"
                        value={taskForm.scheduled_at}
                        onChange={(e) => setTaskForm({ ...taskForm, scheduled_at: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('crm.assignTo', 'Zuweisen an')}</label>
                      <CustomSelect
                        value={taskForm.assigned_to}
                        onChange={val => setTaskForm({ ...taskForm, assigned_to: val })}
                        className="w-full border border-gray-200 rounded-lg text-sm"
                        options={[
                          { value: '', label: `— ${t('crm.nobody', 'Niemand')} —` },
                          ...staff.map(s => ({ value: s.id, label: s.full_name })),
                        ]}
                      />
                    </div>
                  </div>
                  <button
                    onClick={handleSaveTask}
                    disabled={savingTask || !taskForm.subject.trim()}
                    className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                    style={{ backgroundColor: '#ff795d' }}
                  >
                    {savingTask ? t('crm.saving', 'Speichert…') : t('crm.saveTask', 'Aufgabe speichern')}
                  </button>
                </div>
              </div>
            )}

            {/* ── Tab: Termine ──────────────────────────────────── */}
            {activeTab === 'appointments' && (
              <div className="p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-gray-900">
                    {t('crm.tab.appointments', 'Termine')}
                  </h3>
                  <button
                    onClick={() => setShowApptModal(true)}
                    className="px-3 py-1.5 text-sm font-medium rounded-lg text-white"
                    style={{ backgroundColor: '#ff795d' }}
                  >
                    + {t('crm.calendar.newAppointment', 'Termin anlegen')}
                  </button>
                </div>

                {appointments.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">
                    <div className="text-3xl mb-2">📅</div>
                    <p className="text-sm">{t('crm.calendar.noAppointments', 'Noch keine Termine')}</p>
                    <button
                      onClick={() => setShowApptModal(true)}
                      className="mt-3 text-sm font-medium"
                      style={{ color: '#ff795d' }}
                    >
                      + {t('crm.calendar.newAppointment', 'Termin anlegen')}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {appointments.map(appt => {
                      const isPast = new Date(appt.start_time) < new Date()
                      const start  = new Date(appt.start_time)
                      const end    = new Date(appt.end_time)
                      const typeColors: Record<string, string> = {
                        zoom:     '#8b5cf6',
                        inperson: '#f59e0b',
                        phone:    '#9ca3af',
                        whatsapp: '#25d366',
                      }
                      const typeLabels: Record<string, string> = {
                        zoom:     '📹 Zoom',
                        inperson: `📍 ${t('leadDetail.apptTypeInPerson', 'Vor Ort')}`,
                        phone:    `📞 ${t('leadDetail.apptTypePhone', 'Telefon')}`,
                        whatsapp: '💬 WhatsApp',
                      }
                      return (
                        <div
                          key={appt.id}
                          className={`p-4 rounded-xl border transition-colors ${
                            isPast ? 'border-gray-100 bg-gray-50 opacity-60' : 'border-gray-200 bg-white hover:border-orange-200'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span
                                  className="text-xs font-medium px-2 py-0.5 rounded-full text-white"
                                  style={{ backgroundColor: typeColors[appt.type] ?? '#9ca3af' }}
                                >
                                  {typeLabels[appt.type] ?? appt.type}
                                </span>
                                {isPast && (
                                  <span className="text-xs text-gray-400">
                                    {t('crm.calendar.past', 'Vergangen')}
                                  </span>
                                )}
                              </div>
                              <p className="font-medium text-gray-900 text-sm truncate">{appt.title}</p>
                              <p className="text-xs text-gray-500 mt-0.5">
                                {start.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
                                {' · '}
                                {start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
                                {' – '}
                                {end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
                              </p>
                              {appt.zoom_link && (
                                <a
                                  href={appt.zoom_link}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs text-purple-600 hover:underline mt-1 inline-block"
                                >
                                  🔗 {t('crm.calendar.joinZoom', 'Zoom beitreten')}
                                </a>
                              )}
                              {appt.location && (
                                <p className="text-xs text-gray-500 mt-0.5">📍 {appt.location}</p>
                              )}
                              {appt.phone_number && (
                                <p className="text-xs text-gray-500 mt-0.5">
                                  {appt.type === 'whatsapp' ? '💬' : '📞'} {appt.phone_number}
                                </p>
                              )}
                            </div>
                            <button
                              onClick={async () => {
                                // Google-Event zuerst löschen — sonst taucht der Termin als
                                // verwaistes Google-Event im Kalender wieder auf.
                                if (appt.google_event_id) {
                                  try { await deleteGoogleEvent(appt.google_event_id, appt.google_calendar_id ?? undefined) }
                                  catch (err) { console.warn('[LeadDetail] Google-Event löschen fehlgeschlagen:', err) }
                                }
                                await supabase.from('crm_appointments').delete().eq('id', appt.id)
                                setAppointments(prev => prev.filter(a => a.id !== appt.id))
                              }}
                              className="text-gray-300 hover:text-red-400 transition-colors text-xs shrink-0"
                              title={t('common.delete', 'Löschen')}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── Tab: Dokumente ────────────────────────────────── */}
            {activeTab === 'documents' && (
              <div className="p-6 space-y-4 max-w-lg">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('crm.googleDriveUrl', 'Google Drive URL')}
                  </label>
                  <input
                    type="url"
                    value={driveUrl}
                    onChange={(e) => setDriveUrl(e.target.value)}
                    placeholder="https://drive.google.com/drive/folders/..."
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                  />
                </div>
                <button
                  onClick={handleSaveDriveUrl}
                  disabled={!deal}
                  className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                  style={{ backgroundColor: '#ff795d' }}
                >
                  {t('crm.save', 'Speichern')}
                </button>
                {driveUrl && (
                  <a
                    href={driveUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-sm text-orange-500 hover:underline"
                  >
                    🔗 {t('crm.openDrive', 'Google Drive öffnen')}
                  </a>
                )}
                <p className="text-xs text-gray-400">
                  {t('crm.driveNote', 'Für Dokument-Uploads bitte Google Drive nutzen.')}
                </p>
              </div>
            )}

            {/* ── Tab: Geplante Nachrichten ─────────────────────────────── */}
            {activeTab === 'scheduled' && (
              <div className="p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800">
                      ⚡ {t('crm.tab.scheduled', 'Geplante Nachrichten')}
                    </h3>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {t('crm.scheduledHint', 'Automatisch geplante E-Mails und WhatsApp-Nachrichten.')}
                    </p>
                  </div>
                  <button
                    onClick={() => triggerScheduleMessage('lead_created')}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
                    title={t('leadDetail.triggerAutomationTitle', 'Automationsregeln für diesen Lead manuell auslösen')}
                  >
                    ▶ {t('leadDetail.triggerManually', 'Manuell auslösen')}
                  </button>
                </div>

                {scheduledMessages.length === 0 ? (
                  <div className="text-center py-12 text-gray-400 text-sm">
                    {t('crm.noScheduled', 'Keine geplanten Nachrichten.')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {scheduledMessages.map(msg => {
                      const statusStyle: Record<string, string> = {
                        pending:    'bg-yellow-100 text-yellow-700',
                        processing: 'bg-blue-100  text-blue-700',
                        sent:       'bg-green-100 text-green-700',
                        cancelled:  'bg-gray-100  text-gray-500',
                        failed:     'bg-red-100   text-red-700',
                      }
                      const statusLabel: Record<string, string> = {
                        pending:    t('leadDetail.schedStatusPending', 'Ausstehend'),
                        processing: t('leadDetail.schedStatusProcessing', 'Wird gesendet'),
                        sent:       t('leadDetail.schedStatusSent', 'Gesendet'),
                        cancelled:  t('leadDetail.schedStatusCancelled', 'Abgebrochen'),
                        failed:     t('leadDetail.schedStatusFailed', 'Fehlgeschlagen'),
                      }
                      const typeLabel: Record<string, string> = {
                        email:    `📧 ${t('leadDetail.schedTypeEmail', 'E-Mail')}`,
                        whatsapp: `📱 ${t('leadDetail.schedTypeWhatsapp', 'WhatsApp')}`,
                        both:     `📧 + 📱`,
                      }
                      return (
                        <div
                          key={msg.id}
                          className="bg-gray-50 rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3"
                        >
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${statusStyle[msg.status] ?? 'bg-gray-100 text-gray-600'}`}>
                            {statusLabel[msg.status] ?? msg.status}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-xs text-gray-600">
                              <span>{typeLabel[msg.type]}</span>
                              <span className="text-gray-300">·</span>
                              <span>
                                📅 {new Date(msg.scheduled_at).toLocaleString('de-DE', {
                                  day: '2-digit', month: '2-digit', year: 'numeric',
                                  hour: '2-digit', minute: '2-digit',
                                })}
                              </span>
                              {msg.sent_at && (
                                <>
                                  <span className="text-gray-300">·</span>
                                  <span className="text-green-600">
                                    ✓ {new Date(msg.sent_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                </>
                              )}
                            </div>
                            {msg.email_subject && (
                              <p className="text-xs text-gray-500 mt-0.5 truncate">
                                {msg.email_subject}
                              </p>
                            )}
                            {msg.whatsapp_text && (
                              <p className="text-xs text-gray-400 mt-0.5 truncate">
                                💬 {msg.whatsapp_text.slice(0, 80)}{msg.whatsapp_text.length > 80 ? '…' : ''}
                              </p>
                            )}
                            {msg.error_message && (
                              <p className="text-xs text-red-500 mt-0.5">⚠ {msg.error_message}</p>
                            )}
                          </div>
                          {msg.status === 'pending' && (
                            <button
                              onClick={() => handleCancelScheduledMsg(msg.id)}
                              disabled={cancellingMsg === msg.id}
                              className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg border border-gray-200
                                         text-gray-500 hover:border-red-300 hover:text-red-500
                                         transition-colors disabled:opacity-50"
                            >
                              {cancellingMsg === msg.id ? '…' : t('leadDetail.cancelScheduled', 'Abbrechen')}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── Tab: Wohnung (Dokumente & Bilder) ───────────────────────── */}
            {activeTab === 'wohnung' && deal?.unit_id && (
              <div className="p-6 space-y-8">

                {/* ── Wohnung-Kopf + Entfernen ── */}
                <div className="flex items-center justify-between gap-3 pb-2 border-b border-gray-100">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-gray-700 truncate">
                      🏠 {pickedUnit ? t('leadDetail.unitHeaderWithNumber', 'Wohnung {{number}}', { number: pickedUnit.unit.unit_number }) : t('leadDetail.unitHeaderFallback', 'Wohnung')}
                      {pickedUnit?.projectName ? ` · ${pickedUnit.projectName}` : ''}
                    </h3>
                    <p className="text-xs text-gray-400">{t('leadDetail.unitTabSubtitle', 'Dokumente und Bilder dieser Wohnung.')}</p>
                  </div>
                  <button
                    onClick={handleRemoveWohnung}
                    className="text-xs px-3 py-1.5 rounded-lg text-red-600 border border-red-200 hover:bg-red-50 flex-shrink-0"
                    title={t('leadDetail.removeUnitTitle', 'Wohnung vom Kunden entfernen und Portal-Objekt löschen')}
                  >
                    🗑 {t('leadDetail.removeUnit', 'Wohnung entfernen')}
                  </button>
                </div>

                {/* ── Dokumente ── */}
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-4">📄 {t('leadDetail.documentsHeading', 'Dokumente')}</h3>

                  {/* Upload-Formular */}
                  <div className="bg-gray-50 rounded-xl border border-gray-100 p-4 mb-4 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input
                        type="text"
                        placeholder={t('leadDetail.docNamePlaceholder', 'Dokumentname *')}
                        value={unitDocForm.name}
                        onChange={e => setUnitDocForm(f => ({ ...f, name: e.target.value }))}
                        className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                      />
                      <CustomSelect
                        value={unitDocForm.doc_type}
                        onChange={val => setUnitDocForm(f => ({ ...f, doc_type: val as UnitDocType }))}
                        className="border border-gray-200 rounded-lg text-sm"
                        options={[
                          { value: 'kaufvertrag', label: t('leadDetail.docTypeKaufvertrag', 'Kaufvertrag') },
                          { value: 'mietvertrag', label: t('leadDetail.docTypeMietvertrag', 'Mietvertrag') },
                          { value: 'zahlungsbeleg', label: t('leadDetail.docTypeZahlungsbeleg', 'Zahlungsbeleg') },
                          { value: 'grundriss', label: t('leadDetail.docTypeGrundriss', 'Grundriss') },
                          { value: 'sonstiges', label: t('leadDetail.docTypeSonstiges', 'Sonstiges') },
                        ]}
                      />
                    </div>
                    <input
                      type="text"
                      placeholder={t('leadDetail.docNotePlaceholder', 'Notiz (optional)')}
                      value={unitDocForm.notes}
                      onChange={e => setUnitDocForm(f => ({ ...f, notes: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#ff795d]"
                    />
                    <div className="flex items-center gap-3">
                      <label className="flex-1 flex items-center gap-2 border border-dashed border-gray-300 rounded-lg px-3 py-2 cursor-pointer hover:border-[#ff795d] transition-colors">
                        <span className="text-sm text-gray-500">{unitDocFile ? unitDocFile.name : t('leadDetail.chooseFile', '📎 Datei auswählen (PDF, Word, Bild)')}</span>
                        <input
                          ref={unitDocFileRef}
                          type="file"
                          accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                          className="hidden"
                          onChange={e => setUnitDocFile(e.target.files?.[0] ?? null)}
                        />
                      </label>
                      <button
                        onClick={handleUploadUnitDoc}
                        disabled={uploadingUnitDoc || !unitDocFile || !unitDocForm.name.trim()}
                        className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40 transition-opacity"
                        style={{ backgroundColor: '#ff795d' }}
                      >
                        {uploadingUnitDoc ? '⏳ …' : t('leadDetail.upload', 'Hochladen')}
                      </button>
                    </div>
                    <p className="text-xs text-gray-400">
                      💡 {t('leadDetail.docUploadNotice', 'Der Kunde erhält automatisch eine E-Mail wenn ein Dokument hochgeladen wird.')}
                    </p>
                  </div>

                  {/* Dok-Liste */}
                  {unitDocs.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-6">{t('leadDetail.noDocsYet', 'Noch keine Dokumente hochgeladen.')}</p>
                  ) : (
                    <div className="space-y-2">
                      {unitDocs.map(doc => {
                        const DOC_PILL: Record<string, string> = {
                          kaufvertrag: 'bg-purple-100 text-purple-700',
                          mietvertrag: 'bg-blue-100 text-blue-700',
                          zahlungsbeleg: 'bg-green-100 text-green-700',
                          grundriss: 'bg-amber-100 text-amber-700',
                          sonstiges: 'bg-gray-100 text-gray-600',
                        }
                        const DOC_LABEL: Record<string, string> = {
                          kaufvertrag: t('leadDetail.docTypeKaufvertrag', 'Kaufvertrag'),
                          mietvertrag: t('leadDetail.docTypeMietvertrag', 'Mietvertrag'),
                          zahlungsbeleg: t('leadDetail.docTypeZahlungsbeleg', 'Zahlungsbeleg'),
                          grundriss: t('leadDetail.docTypeGrundriss', 'Grundriss'),
                          sonstiges: t('leadDetail.docTypeSonstiges', 'Sonstiges'),
                        }
                        return (
                          <div key={doc.id} className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-gray-50 border border-gray-100">
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${DOC_PILL[doc.doc_type] ?? 'bg-gray-100 text-gray-600'}`}>
                              {DOC_LABEL[doc.doc_type] ?? doc.doc_type}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-800 truncate">{doc.name}</p>
                              {doc.notes && <p className="text-xs text-gray-400 truncate">{doc.notes}</p>}
                              <p className="text-[10px] text-gray-300">
                                {new Date(doc.created_at).toLocaleDateString('de-DE')} · {doc.file_name}
                              </p>
                            </div>
                            <button
                              onClick={() => handleOpenUnitDoc(doc)}
                              className="text-xs text-[#ff795d] hover:underline flex-shrink-0"
                            >
                              {t('leadDetail.open', 'Öffnen')}
                            </button>
                            <button
                              onClick={() => handleDeleteUnitDoc(doc)}
                              className="text-xs text-gray-400 hover:text-red-500 flex-shrink-0"
                            >
                              {t('leadDetail.delete', 'Löschen')}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* ── Bilder ── */}
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-700">🖼️ {t('leadDetail.unitImagesHeading', 'Bilder der Wohnung')}</h3>
                    <label className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors
                      ${uploadingUnitImg ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-orange-50 text-[#ff795d] border border-[#ff795d] hover:bg-orange-100'}`}>
                      {uploadingUnitImg ? t('leadDetail.uploadingImages', '⏳ Wird hochgeladen…') : t('leadDetail.uploadImages', '📷 Bilder hochladen')}
                      <input
                        ref={unitImgFileRef}
                        type="file"
                        accept="image/*"
                        multiple
                        disabled={uploadingUnitImg}
                        className="hidden"
                        onChange={e => { if (e.target.files?.length) handleUploadUnitImages(e.target.files) }}
                      />
                    </label>
                  </div>
                  <p className="text-xs text-gray-400 mb-3">
                    💡 {t('leadDetail.imgUploadNotice', 'Der Kunde erhält automatisch eine E-Mail wenn Bilder hochgeladen werden.')}
                  </p>
                  {unitImages.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-6">{t('leadDetail.noImagesYet', 'Noch keine Bilder hochgeladen.')}</p>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {unitImages.map((url, idx) => (
                        <div key={url} className="relative group rounded-xl overflow-hidden border border-gray-100">
                          <img src={url} alt={t('leadDetail.unitImageAlt', 'Bild {{n}}', { n: idx + 1 })} className="w-full h-28 object-cover" />
                          <button
                            onClick={() => handleDeleteUnitImage(url)}
                            className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-red-500 text-white text-xs
                                       opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: Portal ──────────────────────────────────────────────── */}
            {activeTab === 'portal' && (
              <div className="p-6 space-y-6">
                {/* Status-Karte */}
                <div className="bg-gray-50 rounded-xl border border-gray-100 p-4">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">🔑 {t('leadDetail.portalAccessHeading', 'Portal-Zugang')}</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      {lead?.profile_id ? (
                        <span className="inline-flex items-center gap-1.5 bg-green-50 text-green-700 border border-green-200 px-2.5 py-1 rounded-full text-xs font-medium">
                          ✓ {t('leadDetail.accessActive', 'Zugang aktiv')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 bg-gray-100 text-gray-500 border border-gray-200 px-2.5 py-1 rounded-full text-xs font-medium">
                          {t('leadDetail.noAccess', 'Kein Zugang')}
                        </span>
                      )}
                    </div>
                    {lead?.portal_access_sent_at ? (
                      <p className="text-gray-600 text-xs">
                        {t('leadDetail.accessSentOn', 'Zugang verschickt am')}{' '}
                        <span className="font-medium">
                          {new Date(lead.portal_access_sent_at).toLocaleString('de-DE', {
                            day: '2-digit', month: '2-digit', year: 'numeric',
                            hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
                      </p>
                    ) : (
                      <p className="text-gray-400 text-xs">{t('leadDetail.noAccessSentYet', 'Noch kein Portalzugang versendet.')}</p>
                    )}
                    {lead?.email && lead?.profile_id && (
                      <p className="text-gray-500 text-xs">{t('leadDetail.portalEmailLabel', 'Portal-E-Mail')}: <span className="font-mono">{lead.email}</span></p>
                    )}
                  </div>
                </div>

                {/* Login-Historie */}
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">
                    📋 {t('leadDetail.loginHistoryHeading', 'Login-Verlauf')}
                    {portalLoginLog.length > 0 && (
                      <span className="ml-2 text-xs font-normal text-gray-400">
                        ({portalLoginLog.length} {portalLoginLog.length === 1 ? t('leadDetail.loginSingular', 'Login') : t('leadDetail.loginPlural', 'Logins')})
                      </span>
                    )}
                  </h3>
                  {!lead?.profile_id ? (
                    <p className="text-gray-400 text-sm text-center py-8">
                      {t('leadDetail.noPortalAccessYet', 'Kein Portal-Zugang — noch keine Login-Daten vorhanden.')}
                    </p>
                  ) : portalLoginLog.length === 0 ? (
                    <p className="text-gray-400 text-sm text-center py-8">
                      {t('leadDetail.noLoginYet', 'Noch kein Login im Portal.')}
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {portalLoginLog.map((entry, idx) => (
                        <div
                          key={entry.id}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50 border border-gray-100"
                        >
                          <span className="text-gray-300 text-xs w-5 text-right flex-shrink-0">{idx + 1}.</span>
                          <span className="text-gray-500 text-xs">
                            🟢 {new Date(entry.created_at).toLocaleString('de-DE', {
                              day: '2-digit', month: '2-digit', year: 'numeric',
                              hour: '2-digit', minute: '2-digit',
                              weekday: 'short',
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Projekt-Auswahl Modal */}
      {showProjectModal && deal && lead && (
        <ProjectSelectionModal
          dealId={deal.id}
          leadName={`${lead.first_name} ${lead.last_name}`}
          onClose={() => setShowProjectModal(false)}
          onSaved={() => { setShowProjectModal(false); fetchAll(true) }}
        />
      )}

      {showRegistrationModal && lead && (
        <RegistrationModal
          leadName={`${lead.first_name} ${lead.last_name}`}
          saving={savingReg}
          onConfirm={handleRegistrationConfirm}
          onCancel={() => setShowRegistrationModal(false)}
        />
      )}

      {showApptModal && lead && (
        <AppointmentModal
          leadId={lead.id}
          leadName={`${lead.first_name} ${lead.last_name}`}
          leadPhone={lead.phone}
          onClose={() => setShowApptModal(false)}
          onCreated={() => { setShowApptModal(false); fetchAll(true) }}
        />
      )}

      {/* ── Wohnungs-Picker ─────────────────────────────────────────── */}
      {showUnitPicker && lead && (
        <UnitPickerModal
          leadName={`${lead.first_name} ${lead.last_name}`}
          currentLeadId={lead.id}
          preselectedProjectId={unitPickerProjectId}
          onClose={() => { setShowUnitPicker(false); setUnitPickerProjectId(null) }}
          onSelect={handleUnitAssign}
        />
      )}

      {/* ── Sales-Deck-Wizard ────────────────────────────────────────── */}
      {showWizard && lead && (
        <DeckWizard
          lead={{ id: lead.id, first_name: lead.first_name, last_name: lead.last_name, email: lead.email }}
          onClose={() => setShowWizard(false)}
          onDone={(msg) => { setShowWizard(false); showToast(msg) }}
        />
      )}

      {/* ── Rechner-/Vergleichs-Wizard ───────────────────────────────── */}
      {showRechner && lead && (
        <RechnerWizard
          lead={{ id: lead.id, first_name: lead.first_name, last_name: lead.last_name }}
          onClose={() => setShowRechner(false)}
          onDone={(msg) => { setShowRechner(false); showToast(msg) }}
        />
      )}

      {/* ── Portal-Zugang Dialog ─────────────────────────────────────── */}
      {/* Portalzugang-Modal entfernt — „Zugang senden" sendet jetzt direkt (HTML-Vorlage) */}

      {/* ── Einheit-Auswahl Modal (vorhandene Units bei Aktivieren) ── */}
      {showUnitSelect && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 pt-5 pb-3 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{t('crm.unitSelect.title')}</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {dealProjects.find(dp => dp.project_id === unitSelectProjectId)?.project?.name ?? t('crm.unitSelect.projectFallback')}
                  {' – '}{t('crm.unitSelect.availableUnits')}
                </p>
              </div>
              <button
                onClick={() => setShowUnitSelect(false)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
              >✕</button>
            </div>

            {/* Unit list */}
            <div className="px-4 py-3 space-y-2 max-h-72 overflow-y-auto">
              {unitSelectUnits.map(unit => (
                <button
                  key={unit.id}
                  onClick={() => {
                    setShowUnitSelect(false)
                    // unitSelectProject wird beim Öffnen gesetzt — kein Nachschlagen nötig
                    const proj = unitSelectProject ?? dealProjects.find(dp => dp.project_id === unitSelectProjectId)?.project
                    handleUnitAssign(unit, {
                      id:       proj?.id       ?? unitSelectProjectId ?? '',
                      name:     proj?.name     ?? 'Projekt',
                      location: (proj as { location?: string | null } | null)?.location ?? null,
                    })
                  }}
                  className="w-full text-left border border-gray-200 rounded-xl px-4 py-3
                             hover:border-[#ff795d] hover:bg-orange-50 transition-colors"
                >
                  <div className="font-semibold text-gray-900 text-sm">
                    {unit.block ? `${t('crm.unitEdit.block')} ${unit.block} · ` : ''}{t('crm.unitSelect.no')} {unit.unit_number}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-3">
                    {unit.size_sqm != null && <span>📐 {unit.size_sqm} m²</span>}
                    {unit.bedrooms > 0 && <span>🛏 {unit.bedrooms} {t('crm.unitSelect.bedroomsAbbr')}</span>}
                    {unit.floor != null && <span>{t('crm.unit.floor')} {unit.floor}</span>}
                    {(unit.price_gross ?? unit.price_net) != null && (
                      <span className="font-semibold text-gray-700">
                        💶 {new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(unit.price_gross ?? unit.price_net ?? 0)}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
              <button
                onClick={() => {
                  setShowUnitSelect(false)
                  const dp = dealProjects.find(d => d.project_id === unitSelectProjectId)
                  setUnitEditData(null)
                  setUnitEditProjectId(unitSelectProjectId)
                  setUnitEditForm({
                    unit_number:   dp?.unit_numbers ?? '',
                    block:         '',
                    type:          'apartment',
                    floor:         '',
                    bedrooms:      '0',
                    bathrooms:     '0',
                    size_sqm:      '',
                    terrace_sqm:   '',
                    price_net:     dp?.price_net != null ? String(dp.price_net) : '',
                    price_gross:   '',
                    vat_rate:      '0',
                    status:        'active',
                    is_furnished:  false,
                    rental_type:   '',
                    handover_date: '',
                    notes:         dp?.notes ?? '',
                  })
                  setPortalAccessChecked(false)
                  setCustomerHasAccess(false)
                  setShowUnitEdit(true)
                  setCheckingAccess(true)
                  checkCustomerPortalAccess().then(hasAccess => {
                    setCustomerHasAccess(hasAccess)
                    setPortalAccessChecked(true)
                    setCheckingAccess(false)
                  })
                }}
                className="flex-1 py-2.5 text-sm font-medium border border-gray-200 rounded-xl text-gray-700 hover:bg-gray-50"
              >
                {t('crm.unitSelect.newUnit')}
              </button>
              <button
                onClick={() => setShowUnitSelect(false)}
                className="px-4 py-2.5 text-sm text-gray-500 rounded-xl hover:bg-gray-50"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Einheit bearbeiten Modal ─────────────────────────────────── */}
      {/* ── Eigentümer-Account angelegt: Passwort anzeigen ── */}
      {showNewOwnerPwModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
             onClick={() => setShowNewOwnerPwModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4"
               onClick={e => e.stopPropagation()}>
            <div className="text-center">
              <div className="text-4xl mb-2">🔑</div>
              <h3 className="text-base font-bold text-hp-black font-body">{t('crm.owner.created')}</h3>
              <p className="text-xs text-gray-500 font-body mt-1">
                {t('crm.owner.nowVisible', { name: `${lead?.first_name ?? ''} ${lead?.last_name ?? ''}`.trim() })}
              </p>
            </div>

            <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm font-body">
              <div className="flex justify-between">
                <span className="text-gray-500">{t('crm.lead.email')}:</span>
                <span className="font-medium text-gray-800">{newOwnerPasswordEmail}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500">{t('crm.owner.password')}:</span>
                <span className="font-mono font-bold text-hp-black tracking-wide">{newOwnerPassword}</span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      `E-Mail: ${newOwnerPasswordEmail}\nPasswort: ${newOwnerPassword}`
                    )
                    setNewOwnerPwCopied(true)
                    setTimeout(() => setNewOwnerPwCopied(false), 2000)
                  } catch { /* ignore */ }
                }}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold font-body border transition-colors"
                style={newOwnerPwCopied
                  ? { backgroundColor: 'var(--color-highlight)', borderColor: 'var(--color-highlight)', color: 'white' }
                  : { borderColor: 'var(--color-highlight)', color: 'var(--color-highlight)' }}>
                {newOwnerPwCopied ? t('crm.owner.copied') : t('crm.owner.copyCredentials')}
              </button>
              <button
                type="button"
                onClick={() => setShowNewOwnerPwModal(false)}
                className="py-2.5 px-4 rounded-xl text-sm font-semibold font-body border border-gray-200 text-gray-600 hover:bg-gray-50">
                {t('common.close')}
              </button>
            </div>

            <p className="text-[11px] text-amber-600 text-center font-body">
              {t('crm.owner.passwordWarning')}
            </p>
          </div>
        </div>
      )}

      {showUnitEdit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

            {/* Header */}
            <div className="px-6 pt-5 pb-3 flex-shrink-0 border-b border-gray-100">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">
                    {unitEditData ? t('crm.unitEdit.editTitle') : t('crm.unitEdit.newTitle')}
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {unitEditData
                      ? `${t('crm.unitEdit.unitNoPrefix')} ${unitEditData.unit_number}${unitEditData.block ? ` · ${t('crm.unitEdit.block')} ${unitEditData.block}` : ''}`
                      : (dealProjects.find(dp => dp.project_id === unitEditProjectId)?.project?.name ?? t('crm.unitSelect.projectFallback'))}
                  </p>
                </div>
                <button onClick={() => setShowUnitEdit(false)}
                  className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
              </div>
            </div>

            {/* Body */}
            <div className="px-6 py-4 overflow-y-auto flex-1 space-y-4">

              {/* Basis */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unitEdit.unitNumber')} *</label>
                  <input value={unitEditForm.unit_number}
                    onChange={e => setUnitEditForm(f => ({ ...f, unit_number: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unitEdit.block')}</label>
                  <input value={unitEditForm.block}
                    onChange={e => setUnitEditForm(f => ({ ...f, block: e.target.value }))}
                    placeholder={t('crm.unitEdit.blockPlaceholder')}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unit.type')}</label>
                  <CustomSelect
                    value={unitEditForm.type}
                    onChange={val => setUnitEditForm(f => ({ ...f, type: val }))}
                    className="w-full border border-gray-200 rounded-lg text-sm bg-white"
                    options={[
                      { value: 'apartment', label: t('crm.unit.types.apartment') },
                      { value: 'villa', label: t('crm.unit.types.villa') },
                      { value: 'studio', label: t('crm.unit.types.studio') },
                    ]}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unit.status')}</label>
                  <CustomSelect
                    value={unitEditForm.status}
                    onChange={val => setUnitEditForm(f => ({ ...f, status: val }))}
                    className="w-full border border-gray-200 rounded-lg text-sm bg-white"
                    options={[
                      { value: 'active', label: t('crm.unitEdit.statusActive') },
                      { value: 'under_construction', label: t('crm.unit.statuses.under_construction') },
                    ]}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unit.floor')}</label>
                  <input type="number" value={unitEditForm.floor}
                    onChange={e => setUnitEditForm(f => ({ ...f, floor: e.target.value }))}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
              </div>

              {/* Flächen */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unitEdit.livingArea')}</label>
                  <input type="number" value={unitEditForm.size_sqm}
                    onChange={e => setUnitEditForm(f => ({ ...f, size_sqm: e.target.value }))}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unitEdit.terraceArea')}</label>
                  <input type="number" value={unitEditForm.terrace_sqm}
                    onChange={e => setUnitEditForm(f => ({ ...f, terrace_sqm: e.target.value }))}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
              </div>

              {/* Zimmer */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unitEdit.bedrooms')}</label>
                  <input type="number" value={unitEditForm.bedrooms}
                    onChange={e => setUnitEditForm(f => ({ ...f, bedrooms: e.target.value }))}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unitEdit.bathrooms')}</label>
                  <input type="number" value={unitEditForm.bathrooms}
                    onChange={e => setUnitEditForm(f => ({ ...f, bathrooms: e.target.value }))}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
              </div>

              {/* Preise */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unitEdit.priceNet')}</label>
                  <input type="number" value={unitEditForm.price_net}
                    onChange={e => setUnitEditForm(f => ({ ...f, price_net: e.target.value }))}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unitEdit.priceGross')}</label>
                  <input type="number" value={unitEditForm.price_gross}
                    onChange={e => setUnitEditForm(f => ({ ...f, price_gross: e.target.value }))}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unitEdit.vat')}</label>
                  <input type="number" value={unitEditForm.vat_rate}
                    onChange={e => setUnitEditForm(f => ({ ...f, vat_rate: e.target.value }))}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
              </div>

              {/* Extras */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unitEdit.rentalType')}</label>
                  <CustomSelect
                    value={unitEditForm.rental_type}
                    onChange={val => setUnitEditForm(f => ({ ...f, rental_type: val }))}
                    className="w-full border border-gray-200 rounded-lg text-sm bg-white"
                    options={[
                      { value: '', label: t('crm.unitEdit.rentalNone') },
                      { value: 'short', label: t('crm.unitEdit.rentalShort') },
                      { value: 'long', label: t('crm.unitEdit.rentalLong') },
                    ]}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.unitEdit.handoverDate')}</label>
                  <input type="date" value={unitEditForm.handover_date}
                    onChange={e => setUnitEditForm(f => ({ ...f, handover_date: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input type="checkbox" id="is_furnished" checked={unitEditForm.is_furnished}
                  onChange={e => setUnitEditForm(f => ({ ...f, is_furnished: e.target.checked }))}
                  className="w-4 h-4 rounded" />
                <label htmlFor="is_furnished" className="text-sm text-gray-700 cursor-pointer">
                  {t('crm.unitEdit.furnished')}
                </label>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('crm.unit.notes')}</label>
                <textarea rows={2} value={unitEditForm.notes}
                  onChange={e => setUnitEditForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400 resize-none" />
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 pb-4 border-t border-gray-100 flex-shrink-0 space-y-3 pt-4">

              {/* Portal-Zugangs-Status */}
              {checkingAccess && (
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-[#ff795d] rounded-full animate-spin" />
                  {t('crm.unitEdit.checkingAccess')}
                </div>
              )}
              {portalAccessChecked && customerHasAccess && (
                <div className="bg-green-50 border border-green-100 rounded-xl px-4 py-2.5 text-xs text-green-700 flex items-center gap-2">
                  <span>✅</span>
                  <span><strong>{lead?.first_name}</strong> {t('crm.unitEdit.alreadyHasAccess')}</span>
                </div>
              )}
              {portalAccessChecked && !customerHasAccess && (
                <div className="bg-orange-50 border border-orange-100 rounded-xl px-4 py-2.5 text-xs text-orange-700 flex items-center gap-2">
                  <span>🔑</span>
                  <span>{t('crm.unitEdit.willCreateOwner')}</span>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={() => setShowUnitEdit(false)}
                  className="flex-1 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50">
                  {t('common.cancel')}
                </button>
                <button onClick={handleSaveUnit} disabled={savingUnit || !unitEditForm.unit_number.trim()}
                  className="flex-1 py-2.5 text-sm font-medium text-white rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{ backgroundColor: '#ff795d' }}>
                  {savingUnit && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                  {savingUnit ? t('common.saving')
                    : portalAccessChecked && !customerHasAccess
                      ? t('crm.unitEdit.saveAndCreateOwner')
                      : '✓ ' + t('common.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}
