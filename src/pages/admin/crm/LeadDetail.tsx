import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { Lead, Deal, Activity, EmailTemplate, DealPhase, DealProject, ScheduledMessage } from '../../../lib/crmTypes'
import { PHASE_ICONS, SOURCE_BADGE_STYLE, PHASE_WEBHOOK_EVENTS } from '../../../lib/crmTypes'
import ProjectSelectionModal from '../../../components/crm/ProjectSelectionModal'
import RegistrationModal from '../../../components/crm/RegistrationModal'
import AppointmentModal from '../../../components/crm/AppointmentModal'
import { sendWhatsApp } from '../../../lib/whatsapp'
import type { CrmAppointment } from '../../../lib/crmTypes'

type TabId = 'overview' | 'activities' | 'emails' | 'tasks' | 'documents' | 'appointments' | 'scheduled'

const ACTIVITY_ICONS: Record<string, string> = {
  call: '📞',
  email: '📧',
  whatsapp: '📱',
  note: '📝',
  meeting: '🤝',
  task: '✅',
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { profile } = useAuth()

  // Core data
  const [lead, setLead] = useState<Lead | null>(null)
  const [deal, setDeal] = useState<Deal | null>(null)
  const [activities, setActivities] = useState<Activity[]>([])
  const [tasks, setTasks] = useState<Activity[]>([])
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [staff, setStaff] = useState<{ id: string; full_name: string }[]>([])
  const [dealProjects, setDealProjects] = useState<DealProject[]>([])
  const [showProjectModal, setShowProjectModal] = useState(false)
  const [showRegistrationModal, setShowRegistrationModal] = useState(false)
  const [savingReg, setSavingReg] = useState(false)
  const [appointments, setAppointments] = useState<CrmAppointment[]>([])
  const [showApptModal, setShowApptModal] = useState(false)
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([])
  const [cancellingMsg, setCancellingMsg] = useState<string | null>(null)

  // WhatsApp preview (no_show)
  const [showWaPreview, setShowWaPreview] = useState(false)
  const [waMsg, setWaMsg]               = useState('')
  const [sendingWa, setSendingWa]       = useState(false)

  // UI state
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [saving, setSaving] = useState(false)

  // Activity form
  const [actForm, setActForm] = useState({ type: 'note', direction: 'outbound', subject: '', content: '' })
  const [savingAct, setSavingAct] = useState(false)

  // Task form
  const [taskForm, setTaskForm] = useState({ subject: '', content: '', scheduled_at: '', assigned_to: '' })
  const [savingTask, setSavingTask] = useState(false)

  // Email form
  const [emailForm, setEmailForm] = useState({ templateId: '', subject: '', body: '' })
  const [sendingEmail, setSendingEmail] = useState(false)

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

  // ── Toast helper ────────────────────────────────────────────────
  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  // ── Data fetching ───────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!id) return
    setLoading(true)
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
          .order('created_at', { ascending: false }),
        supabase
          .from('activities')
          .select('*, creator:profiles!activities_created_by_fkey(full_name)')
          .eq('lead_id', id)
          .eq('type', 'task')
          .is('completed_at', null)
          .order('scheduled_at', { ascending: true }),
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

      // Fetch deal_projects when deal exists
      if (dealResult?.id) {
        const { data: dpData } = await supabase
          .from('deal_projects')
          .select('*, project:crm_projects(id,name,images,location)')
          .eq('deal_id', dealResult.id)
          .order('created_at')
        setDealProjects((dpData ?? []) as unknown as DealProject[])
      } else {
        setDealProjects([])
      }

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

      // Fetch appointments for this lead
      const { data: apptData } = await supabase
        .from('crm_appointments')
        .select('*')
        .eq('lead_id', id)
        .order('start_time', { ascending: true })
      setAppointments((apptData ?? []) as unknown as CrmAppointment[])

      // Fetch scheduled messages for this lead
      const { data: schedData } = await supabase
        .from('scheduled_messages')
        .select('*')
        .eq('lead_id', id)
        .order('scheduled_at', { ascending: true })
      setScheduledMessages((schedData ?? []) as unknown as ScheduledMessage[])
    } catch (err) {
      console.error('[LeadDetail] fetchAll:', err)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

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
    await supabase.from('deals').update({ phase }).eq('id', deal.id)
    await supabase.from('activities').insert({
      lead_id: id,
      deal_id: deal.id,
      type: 'note',
      direction: 'outbound',
      subject: null,
      content: `Phase geändert: ${oldPhase} → ${phase}`,
      created_by: profile?.id ?? null,
    })
    if (PHASE_WEBHOOK_EVENTS[phase]) {
      await sendWebhook(PHASE_WEBHOOK_EVENTS[phase]!)
    }
    // Automations-Queue befüllen (fire-and-forget)
    triggerScheduleMessage(phase)
    setSaving(false)
    await fetchAll()
  }

  // ── Registration confirm (from modal) ───────────────────────────
  const handleRegistrationConfirm = async (selectedDevelopers: string[], notes: string) => {
    if (!deal) return
    setSavingReg(true)
    const oldPhase = deal.phase
    try {
      await supabase.from('deals').update({ phase: 'registrierung', registration_notes: notes || null }).eq('id', deal.id)
      await supabase.from('activities').insert({
        lead_id:    id,
        deal_id:    deal.id,
        type:       'note',
        direction:  'outbound',
        subject:    null,
        content:    `Phase geändert: ${oldPhase} → registrierung. Registrierung gesendet an: ${selectedDevelopers.join(', ')}${notes ? `. Bemerkung: ${notes}` : ''}`,
        created_by: profile?.id ?? null,
      })
      await sendWebhook('deal.registration', {
        developers:  selectedDevelopers,
        bemerkungen: notes,
      })

      // WhatsApp an Registrierungs-Empfänger (fire-and-forget)
      sendWhatsApp({
        event_type: 'registration',
        lead_data: {
          lead_name:    `${lead?.first_name ?? ''} ${lead?.last_name ?? ''}`.trim(),
          lead_phone:   lead?.phone     ?? '',
          lead_email:   lead?.email     ?? '',
          lead_whatsapp: lead?.whatsapp ?? '',
        },
        extra_data: {
          developers: selectedDevelopers.join(', '),
          notes:      notes ?? '',
        },
        lead_id: id,
      }).catch(e => console.warn('[WhatsApp] registration failed:', e))

      // Automations-Queue befüllen (fire-and-forget)
      triggerScheduleMessage('registrierung')

      setShowRegistrationModal(false)
      showToast(t('crm.registrationSent', 'Registrierung gesendet'))
      await fetchAll()
    } catch (err) {
      console.error('[LeadDetail] registrationConfirm:', err)
      showToast('❌ Fehler beim Senden')
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
      await fetchAll()
      showToast(t('crm.activitySaved', 'Aktivität gespeichert'))
    } catch (err) {
      console.error('[LeadDetail] saveActivity:', err)
      showToast('❌ Fehler beim Speichern')
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
      await fetchAll()
      showToast(t('crm.taskSaved', 'Aufgabe gespeichert'))
    } catch (err) {
      console.error('[LeadDetail] saveTask:', err)
      showToast('❌ Fehler beim Speichern')
    } finally {
      setSavingTask(false)
    }
  }

  const handleCompleteTask = async (taskId: string) => {
    try {
      await supabase.from('activities').update({ completed_at: new Date().toISOString() }).eq('id', taskId)
      await fetchAll()
      showToast(t('crm.taskCompleted', 'Aufgabe erledigt'))
    } catch (err) {
      console.error('[LeadDetail] completeTask:', err)
      showToast('❌ Fehler')
    }
  }

  // ── Email ───────────────────────────────────────────────────────
  const replacePlaceholders = (text: string): string => {
    if (!lead) return text
    return text
      .replace(/\{\{vorname\}\}/g, lead.first_name)
      .replace(/\{\{nachname\}\}/g, lead.last_name)
      .replace(/\{\{email\}\}/g, lead.email)
      .replace(/\{\{phone\}\}/g, lead.phone ?? '')
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
    setSendingEmail(true)
    try {
      const resolvedBody    = replacePlaceholders(emailForm.body)
      const resolvedSubject = replacePlaceholders(emailForm.subject)

      console.log('[send-email] Rufe Edge Function auf …', { to: lead.email, subject: resolvedSubject })

      const { data: fnData, error: fnErr } = await supabase.functions.invoke('send-email', {
        body: {
          to:      lead.email,
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
        subject:    resolvedSubject,
        content:    resolvedBody.replace(/<[^>]+>/g, '').slice(0, 500),
        created_by: profile?.id ?? null,
      })

      showToast(t('crm.email.sent', 'E-Mail gesendet! ✓'))
      setEmailForm({ templateId: '', subject: '', body: '' })
      await fetchAll()
    } catch (err) {
      console.error('[send-email] Kompletter Fehler:', err)
      console.error('[send-email] Details:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
      showToast(`❌ E-Mail Fehler: ${err instanceof Error ? err.message : 'Unbekannter Fehler'}`)
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
      setWaMsg(msg || `Hallo ${lead.first_name} 👋\n\nDu hattest heute einen Termin mit uns.`)
    } catch {
      setWaMsg(`Hallo ${lead.first_name} 👋\n\nDu hattest heute einen Termin mit uns.`)
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
      await fetchAll()
    } catch (err) {
      console.error('[LeadDetail] sendWhatsappNoShow:', err)
      showToast('❌ WhatsApp Fehler')
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
      await sendWhatsApp({
        event_type: 'commission',
        lead_data: {
          lead_name:  `${lead.first_name} ${lead.last_name}`,
          lead_phone: lead.phone ?? '',
          lead_email: lead.email ?? '',
        },
        extra_data: {
          project_name:      projectName,
          commission_amount: amount,
        },
        lead_id: id,
      })
      showToast(t('crm.whatsappSent', '📱 WhatsApp gesendet'))
      await fetchAll()
    } catch (err) {
      console.error('[LeadDetail] commissionWhatsapp:', err)
      showToast('❌ WhatsApp Fehler')
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
      }).eq('id', deal.id)
      await supabase.from('activities').insert({
        lead_id: id, deal_id: deal.id, type: 'note', direction: 'outbound',
        subject: null, content: 'Finanzierungspartner informiert', created_by: profile?.id ?? null,
      })
      await sendWebhook('deal.financing')
      showToast(t('crm.financingNotified', 'Partner informiert'))
      await fetchAll()
    } catch (err) {
      console.error('[LeadDetail] financingNotify:', err)
      showToast('❌ Fehler')
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
      }).eq('id', deal.id)
      await supabase.from('activities').insert({
        lead_id: id, deal_id: deal.id, type: 'note', direction: 'outbound',
        subject: null, content: `Anwalt informiert. Drive: ${driveUrl}`, created_by: profile?.id ?? null,
      })
      await sendWebhook('deal.contract', { google_drive_url: driveUrl })
      showToast(t('crm.lawyerNotified', 'Anwalt informiert'))
      await fetchAll()
    } catch (err) {
      console.error('[LeadDetail] lawyerNotify:', err)
      showToast('❌ Fehler')
    } finally {
      setSaving(false)
    }
  }

  const handleDepositCommission = async () => {
    if (!deal) return
    setSaving(true)
    try {
      await supabase.from('deals').update({ deposit_paid_at: depositDate || new Date().toISOString() }).eq('id', deal.id)
      await supabase.from('activities').insert({
        lead_id: id, deal_id: deal.id, type: 'note', direction: 'outbound',
        subject: null, content: 'Provision angefordert – Anzahlung bezahlt', created_by: profile?.id ?? null,
      })
      await sendWebhook('deal.deposit_paid')
      showToast(t('crm.commissionRequested', 'Provision angefordert'))
      await fetchAll()
    } catch (err) {
      console.error('[LeadDetail] depositCommission:', err)
      showToast('❌ Fehler')
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
      }).eq('id', deal.id)
      await supabase.from('activities').insert({
        lead_id: id, deal_id: deal.id, type: 'note', direction: 'outbound',
        subject: null, content: `Deal abgeschlossen. Provision: ${commissionAmount}`, created_by: profile?.id ?? null,
      })
      await sendWebhook('deal.commission_paid', { commission_amount: commissionAmount })
      showToast(t('crm.dealClosed', 'Deal abgeschlossen'))
      await fetchAll()
    } catch (err) {
      console.error('[LeadDetail] dealClose:', err)
      showToast('❌ Fehler')
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
      showToast('✋ Nachricht abgebrochen')
    } catch (err) {
      console.error('[LeadDetail] cancelScheduledMsg:', err)
      showToast('❌ Fehler')
    } finally {
      setCancellingMsg(null)
    }
  }

  const handleArchive = async () => {
    if (!deal) return
    setSaving(true)
    try {
      await supabase.from('deals').update({ phase: 'archiviert' }).eq('id', deal.id)
      await supabase.from('activities').insert({
        lead_id: id, deal_id: deal.id, type: 'note', direction: 'outbound',
        subject: null, content: 'Deal archiviert', created_by: profile?.id ?? null,
      })
      showToast(t('crm.archivedSuccess', 'Archiviert'))
      navigate('/admin/crm')
    } catch (err) {
      console.error('[LeadDetail] archive:', err)
      showToast('❌ Fehler beim Archivieren')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveDriveUrl = async () => {
    if (!deal) return
    try {
      await supabase.from('deals').update({ google_drive_url: driveUrl }).eq('id', deal.id)
      showToast(t('crm.driveSaved', 'Drive-Link gespeichert'))
      await fetchAll()
    } catch (err) {
      console.error('[LeadDetail] saveDriveUrl:', err)
      showToast('❌ Fehler')
    }
  }

  const handleSaveImmoNotes = async () => {
    if (!deal) return
    try {
      await supabase.from('deals').update({ immobilien_notes: immoNotes || null }).eq('id', deal.id)
      showToast(t('crm.notesSaved', 'Notiz gespeichert'))
      await fetchAll()
    } catch (err) {
      console.error('[LeadDetail] saveImmoNotes:', err)
      showToast('❌ Fehler')
    }
  }

  const handleSaveRegNotes = async () => {
    if (!deal) return
    try {
      await supabase.from('deals').update({ registration_notes: regNotes || null }).eq('id', deal.id)
      showToast(t('crm.notesSaved', 'Notiz gespeichert'))
      await fetchAll()
    } catch (err) {
      console.error('[LeadDetail] saveRegNotes:', err)
      showToast('❌ Fehler')
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
                <h1 className="text-2xl font-bold text-gray-900 truncate">
                  {lead.first_name} {lead.last_name}
                </h1>
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

              {/* Quick actions */}
              <div className="flex flex-wrap gap-2 flex-shrink-0">
                <button
                  onClick={() => setActiveTab('emails')}
                  className="px-3 py-1.5 text-sm rounded-lg bg-orange-50 text-orange-600 hover:bg-orange-100 font-medium"
                >
                  📧 {t('crm.sendEmail', 'E-Mail senden')}
                </button>
                <button
                  onClick={() => setActiveTab('tasks')}
                  className="px-3 py-1.5 text-sm rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 font-medium"
                >
                  ✅ {t('crm.addTask', 'Aufgabe anlegen')}
                </button>
                <button
                  onClick={() => setActiveTab('activities')}
                  className="px-3 py-1.5 text-sm rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 font-medium"
                >
                  📝 {t('crm.addNote', 'Notiz')}
                </button>
              </div>
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
                  <div className="space-y-3">
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
                        onClick={() => navigate('/admin/users')}
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200"
                      >
                        👤 {t('crm.createOwnerAccount', 'Eigentümer-Account anlegen')}
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
          <div className="bg-white rounded-2xl shadow overflow-hidden">
            {/* Tab bar */}
            <div className="flex border-b border-gray-100 overflow-x-auto">
              {([
                { id: 'overview',     label: t('crm.tab.overview',      'Übersicht') },
                { id: 'appointments', label: t('crm.tab.appointments',  `📅 Termine${appointments.length ? ` (${appointments.length})` : ''}`) },
                { id: 'activities',   label: t('crm.tab.activities',    'Aktivitäten') },
                { id: 'emails',       label: t('crm.tab.emails',        'E-Mails') },
                { id: 'tasks',        label: t('crm.tab.tasks',         'Aufgaben') },
                { id: 'documents',    label: t('crm.tab.documents',     'Dokumente') },
                {
                  id: 'scheduled',
                  label: `⚡ ${t('crm.tab.scheduled', 'Geplant')}${scheduledMessages.filter(m => m.status === 'pending').length ? ` (${scheduledMessages.filter(m => m.status === 'pending').length})` : ''}`,
                },
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
                {/* Stammdaten */}
                <div>
                  <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                    {t('crm.masterData', 'Stammdaten')}
                  </h3>
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
                    <div className="flex gap-2">
                      <dt className="text-gray-500 w-28 flex-shrink-0">{t('crm.language', 'Sprache')}</dt>
                      <dd className="text-gray-900">{lead.language.toUpperCase()}</dd>
                    </div>
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
                              <div className="font-medium text-gray-900 mb-1">
                                🏗 {dp.project?.name ?? '–'}
                              </div>
                              {dp.project?.location && (
                                <div className="text-xs text-gray-500 mb-1">📍 {dp.project.location}</div>
                              )}
                              <dl className="space-y-0.5 text-xs text-gray-600">
                                {dp.unit_numbers && (
                                  <div className="flex gap-2">
                                    <dt className="text-gray-400 w-16">Units</dt>
                                    <dd>{dp.unit_numbers}</dd>
                                  </div>
                                )}
                                {dp.price_net != null && (
                                  <div className="flex gap-2">
                                    <dt className="text-gray-400 w-16">Preis</dt>
                                    <dd className="font-medium">€ {dp.price_net.toLocaleString('de-AT')}</dd>
                                  </div>
                                )}
                                {dp.notes && (
                                  <div className="flex gap-2">
                                    <dt className="text-gray-400 w-16">Notiz</dt>
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
                                {isOverdue(task) && ' — Überfällig'}
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
                      <select
                        value={actForm.type}
                        onChange={(e) => setActForm({ ...actForm, type: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400"
                      >
                        <option value="call">📞 {t('crm.actType.call', 'Anruf')}</option>
                        <option value="email">📧 {t('crm.actType.email', 'E-Mail')}</option>
                        <option value="whatsapp">📱 WhatsApp</option>
                        <option value="note">📝 {t('crm.actType.note', 'Notiz')}</option>
                        <option value="meeting">🤝 {t('crm.actType.meeting', 'Meeting')}</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('crm.direction', 'Richtung')}</label>
                      <select
                        value={actForm.direction}
                        onChange={(e) => setActForm({ ...actForm, direction: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400"
                      >
                        <option value="outbound">{t('crm.outbound', 'Ausgehend')}</option>
                        <option value="inbound">{t('crm.inbound', 'Eingehend')}</option>
                      </select>
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

            {/* ── Tab: E-Mails ──────────────────────────────────── */}
            {activeTab === 'emails' && (
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('crm.emailTemplate', 'Vorlage')}</label>
                  <select
                    value={emailForm.templateId}
                    onChange={(e) => handleTemplateSelect(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                  >
                    <option value="">{t('crm.selectTemplate', '– Vorlage wählen –')}</option>
                    {templates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name} ({tpl.language.toUpperCase()})
                      </option>
                    ))}
                  </select>
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
                    {t('crm.placeholders', 'Platzhalter: {{vorname}}, {{nachname}}, {{email}}, {{phone}}')}
                  </p>
                </div>
                <button
                  onClick={handleSendEmail}
                  disabled={sendingEmail || !emailForm.subject.trim() || !emailForm.body.trim()}
                  className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                  style={{ backgroundColor: '#ff795d' }}
                >
                  {sendingEmail ? t('crm.sending', 'Sendet…') : `📧 ${t('crm.sendEmail', 'E-Mail senden')} → ${lead.email}`}
                </button>
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
                      <select
                        value={taskForm.assigned_to}
                        onChange={(e) => setTaskForm({ ...taskForm, assigned_to: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400"
                      >
                        <option value="">— {t('crm.nobody', 'Niemand')} —</option>
                        {staff.map((s) => (
                          <option key={s.id} value={s.id}>{s.full_name}</option>
                        ))}
                      </select>
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
                        inperson: '#22c55e',
                        phone:    '#9ca3af',
                      }
                      const typeLabels: Record<string, string> = {
                        zoom:     '📹 Zoom',
                        inperson: '📍 Vor Ort',
                        phone:    '📞 Telefon',
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
                            </div>
                            <button
                              onClick={async () => {
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
                    title="Automationsregeln für diesen Lead manuell auslösen"
                  >
                    ▶ Manuell auslösen
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
                        pending:    'Ausstehend',
                        processing: 'Wird gesendet',
                        sent:       'Gesendet',
                        cancelled:  'Abgebrochen',
                        failed:     'Fehlgeschlagen',
                      }
                      const typeLabel: Record<string, string> = {
                        email:    '📧 E-Mail',
                        whatsapp: '📱 WhatsApp',
                        both:     '📧 + 📱',
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
                              {cancellingMsg === msg.id ? '…' : 'Abbrechen'}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
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
          onSaved={() => { setShowProjectModal(false); fetchAll() }}
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
          onClose={() => setShowApptModal(false)}
          onCreated={() => { setShowApptModal(false); fetchAll() }}
        />
      )}
    </DashboardLayout>
  )
}
