import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'
import type { AutomationRule, ScheduledMessage } from '../../../../lib/crmTypes'

// Ergebnis des Trockenlaufs (simulate-automations)
interface SimRule {
  id: string; name: string; event_type: string; message_type: string; timing: string
  recipient_label: string; recipient_email: string | null; recipient_phone: string | null
  subject: string | null; mail_body: string | null; whatsapp_text: string | null
  ok: boolean; issues: string[]
}
interface SimResult { lead_used: string; total: number; ready: number; problems: number; rules: SimRule[] }

// ── Konstanten ────────────────────────────────────────────────────────────────

const EVENT_TYPES: { value: string; labelKey: string; labelDefault: string; icon: string }[] = [
  { value: 'lead_created',      labelKey: 'eventLeadCreated',      labelDefault: 'Neuer Lead',         icon: '📥' },
  { value: 'erstkontakt',       labelKey: 'eventErstkontakt',      labelDefault: 'Erstkontakt',        icon: '📥' },
  { value: 'termin_gebucht',    labelKey: 'eventTerminGebucht',    labelDefault: 'Termin gebucht',     icon: '📅' },
  { value: 'no_show',           labelKey: 'eventNoShow',           labelDefault: 'No Show',            icon: '❌' },
  { value: 'registrierung',     labelKey: 'eventRegistrierung',    labelDefault: 'Registrierung',      icon: '📋' },
  { value: 'finanzierung_de',   labelKey: 'eventFinanzierungDe',   labelDefault: 'Finanzierung DE',    icon: '🏦' },
  { value: 'finanzierung_cy',   labelKey: 'eventFinanzierungCy',   labelDefault: 'Finanzierung CY',    icon: '🌍' },
  { value: 'immobilienauswahl', labelKey: 'eventImmobilienauswahl',labelDefault: 'Immobilienauswahl',  icon: '🏠' },
  { value: 'reservierung',      labelKey: 'eventReservierung',     labelDefault: 'Reservierung',       icon: '🔖' },
  { value: 'kaufvertrag',       labelKey: 'eventKaufvertrag',      labelDefault: 'Kaufvertrag',        icon: '📝' },
  { value: 'anzahlung',         labelKey: 'eventAnzahlung',        labelDefault: 'Anzahlung',          icon: '✅' },
  { value: 'provision_erhalten',labelKey: 'eventProvisionErhalten',labelDefault: 'Provision erhalten', icon: '🎉' },
  { value: 'deal_verloren',     labelKey: 'eventDealVerloren',     labelDefault: 'Deal verloren',      icon: '🚫' },
]

const MSG_TYPE_KEY: Record<string, { key: string; def: string }> = {
  email:     { key: 'msgTypeEmail',    def: '📧 E-Mail' },
  whatsapp:  { key: 'msgTypeWhatsapp', def: '📱 WhatsApp' },
  both:      { key: 'msgTypeBoth',     def: '📧 + 📱 Beides' },
}

const STATUS_STYLE: Record<string, string> = {
  pending:    'bg-yellow-100 text-yellow-700',
  processing: 'bg-blue-100  text-blue-700',
  sent:       'bg-green-100 text-green-700',
  cancelled:  'bg-gray-100  text-gray-500',
  failed:     'bg-red-100   text-red-700',
}

const STATUS_KEY: Record<string, { key: string; def: string }> = {
  pending:    { key: 'statusPending',    def: 'Ausstehend' },
  processing: { key: 'statusProcessing', def: 'Wird gesendet' },
  sent:       { key: 'statusSent',       def: 'Gesendet' },
  cancelled:  { key: 'statusCancelled',  def: 'Abgebrochen' },
  failed:     { key: 'statusFailed',     def: 'Fehlgeschlagen' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delayLabel(minutes: number, t: (key: string, def: string, opts?: Record<string, unknown>) => string): string {
  if (minutes === 0)    return t('automationRules.delaySofort', 'Sofort')
  if (minutes < 60)     return t('automationRules.delayMin', '{{n}} Min.', { n: minutes })
  if (minutes < 1440)   return t('automationRules.delayStd', '{{n}} Std.', { n: minutes / 60 })
  return minutes === 1440
    ? t('automationRules.delayTag', '{{n}} Tag', { n: minutes / 1440 })
    : t('automationRules.delayTage', '{{n}} Tage', { n: minutes / 1440 })
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white'
const labelCls = 'block text-xs font-medium text-gray-500 mb-1'

// ── RuleModal ─────────────────────────────────────────────────────────────────

interface EmailTpl { id: string; name: string; category: string }
interface WaTpl    { event_type: string; name: string }

interface RuleModalProps {
  rule:       AutomationRule | null  // null = neue Regel
  onClose:    () => void
  onSaved:    () => void
}

function RuleModal({ rule, onClose, onSaved }: RuleModalProps) {
  const { t } = useTranslation()
  const isNew = !rule

  const [name,               setName]               = useState(rule?.name               ?? '')
  const [description,        setDescription]        = useState(rule?.description        ?? '')
  const [eventType,          setEventType]          = useState(rule?.event_type         ?? 'lead_created')
  const [delayUnit,          setDelayUnit]          = useState<'minutes'|'hours'|'days'>(
    (rule?.delay_minutes ?? 0) === 0 ? 'minutes' :
    (rule?.delay_minutes ?? 0) % 1440 === 0 ? 'days' :
    (rule?.delay_minutes ?? 0) % 60   === 0 ? 'hours' : 'minutes'
  )
  const [delayValue,         setDelayValue]         = useState(
    (rule?.delay_minutes ?? 0) === 0 ? 0 :
    (rule?.delay_minutes ?? 0) % 1440 === 0 ? (rule?.delay_minutes ?? 0) / 1440 :
    (rule?.delay_minutes ?? 0) % 60   === 0 ? (rule?.delay_minutes ?? 0) / 60 :
    (rule?.delay_minutes ?? 0)
  )
  const [messageType,        setMessageType]        = useState(rule?.message_type       ?? 'email')
  const [emailTemplateId,    setEmailTemplateId]    = useState(rule?.email_template_id  ?? '')
  const [waEventType,        setWaEventType]        = useState(rule?.whatsapp_event_type ?? '')
  const [isActive,           setIsActive]           = useState(rule?.is_active          ?? true)

  const [emailTpls, setEmailTpls] = useState<EmailTpl[]>([])
  const [waTpls,    setWaTpls]    = useState<WaTpl[]>([])
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')

  useEffect(() => {
    supabase.from('email_templates').select('id, name, category').order('name')
      .then(({ data }) => setEmailTpls((data ?? []) as EmailTpl[]))
    supabase.from('whatsapp_templates').select('event_type, name').order('event_type')
      .then(({ data }) => setWaTpls((data ?? []) as WaTpl[]))
  }, [])

  const resolvedDelay = () => {
    const v = Number(delayValue) || 0
    if (delayUnit === 'hours') return v * 60
    if (delayUnit === 'days')  return v * 1440
    return v
  }

  const handleSave = async () => {
    if (!name.trim()) { setError(t('automationRules.errorNameRequired', 'Name ist Pflicht')); return }
    if ((messageType === 'email' || messageType === 'both') && !emailTemplateId) {
      setError(t('automationRules.errorSelectEmailTemplate', 'Bitte E-Mail-Template wählen')); return
    }
    if ((messageType === 'whatsapp' || messageType === 'both') && !waEventType) {
      setError(t('automationRules.errorSelectWhatsappTemplate', 'Bitte WhatsApp-Template wählen')); return
    }
    setSaving(true)
    setError('')
    try {
      const payload = {
        name:                name.trim(),
        description:         description.trim() || null,
        event_type:          eventType,
        delay_minutes:       resolvedDelay(),
        message_type:        messageType,
        email_template_id:   (messageType === 'email' || messageType === 'both') ? emailTemplateId || null : null,
        whatsapp_event_type: (messageType === 'whatsapp' || messageType === 'both') ? waEventType || null : null,
        is_active:           isActive,
        updated_at:          new Date().toISOString(),
      }
      if (isNew) {
        const { error: e } = await supabase.from('automation_rules').insert(payload)
        if (e) throw e
      } else {
        const { error: e } = await supabase.from('automation_rules').update(payload).eq('id', rule!.id)
        if (e) throw e
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('automationRules.errorSaving', 'Fehler beim Speichern'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">
            {isNew ? t('automationRules.newRuleTitle', '+ Neue Automationsregel') : t('automationRules.editRuleTitle', 'Regel bearbeiten')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* Name + Beschreibung */}
          <div>
            <label className={labelCls}>{t('automationRules.nameLabel', 'Name *')}</label>
            <input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder={t('automationRules.namePlaceholder', 'z.B. No-Show Follow-Up')} />
          </div>
          <div>
            <label className={labelCls}>{t('automationRules.descriptionLabel', 'Beschreibung')}</label>
            <input className={inputCls} value={description} onChange={e => setDescription(e.target.value)} placeholder={t('automationRules.optionalPlaceholder', 'Optional')} />
          </div>

          {/* Auslöser */}
          <div>
            <label className={labelCls}>{t('automationRules.triggerLabel', 'Auslöser *')}</label>
            <select className={inputCls} value={eventType} onChange={e => setEventType(e.target.value)}>
              {EVENT_TYPES.map(et => (
                <option key={et.value} value={et.value}>
                  {et.icon} {t(`automationRules.${et.labelKey}`, et.labelDefault)}
                </option>
              ))}
            </select>
          </div>

          {/* Verzögerung */}
          <div>
            <label className={labelCls}>{t('automationRules.delayLabel', 'Verzögerung nach Auslöser')}</label>
            <div className="flex gap-2">
              <input
                type="number"
                min={0}
                className={`${inputCls} w-24`}
                value={delayValue}
                onChange={e => setDelayValue(Number(e.target.value))}
              />
              <select className={inputCls} value={delayUnit} onChange={e => setDelayUnit(e.target.value as 'minutes'|'hours'|'days')}>
                <option value="minutes">{t('automationRules.unitMinutes', 'Minuten')}</option>
                <option value="hours">{t('automationRules.unitHours', 'Stunden')}</option>
                <option value="days">{t('automationRules.unitDays', 'Tage')}</option>
              </select>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              {t('automationRules.delaySummary', '= {{delay}} nach dem Ereignis', { delay: delayLabel(resolvedDelay(), t) })}
            </p>
          </div>

          {/* Nachrichtentyp */}
          <div>
            <label className={labelCls}>{t('automationRules.messageTypeLabel', 'Nachrichtentyp *')}</label>
            <div className="flex gap-2">
              {(['email', 'whatsapp', 'both'] as const).map(mt => (
                <button
                  key={mt}
                  onClick={() => setMessageType(mt)}
                  className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium border-2 transition-colors ${
                    messageType === mt
                      ? 'border-orange-400 text-orange-600 bg-orange-50'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {t(`automationRules.${MSG_TYPE_KEY[mt].key}`, MSG_TYPE_KEY[mt].def)}
                </button>
              ))}
            </div>
          </div>

          {/* E-Mail-Template */}
          {(messageType === 'email' || messageType === 'both') && (
            <div>
              <label className={labelCls}>{t('automationRules.emailTemplateLabel', 'E-Mail-Template *')}</label>
              <select className={inputCls} value={emailTemplateId} onChange={e => setEmailTemplateId(e.target.value)}>
                <option value="">{t('automationRules.selectTemplatePlaceholder', '– Template wählen –')}</option>
                {emailTpls.map(tpl => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name} ({tpl.category})</option>
                ))}
              </select>
            </div>
          )}

          {/* WhatsApp-Template */}
          {(messageType === 'whatsapp' || messageType === 'both') && (
            <div>
              <label className={labelCls}>{t('automationRules.whatsappTemplateLabel', 'WhatsApp-Template *')}</label>
              <select className={inputCls} value={waEventType} onChange={e => setWaEventType(e.target.value)}>
                <option value="">{t('automationRules.selectTemplatePlaceholder', '– Template wählen –')}</option>
                {waTpls.map(tpl => (
                  <option key={tpl.event_type} value={tpl.event_type}>{tpl.name} ({tpl.event_type})</option>
                ))}
              </select>
            </div>
          )}

          {/* Aktiv */}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => setIsActive(v => !v)}
              className={`relative w-10 h-5 rounded-full transition-colors ${isActive ? 'bg-green-500' : 'bg-gray-200'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${isActive ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
            <span className="text-sm text-gray-700">{isActive ? t('automationRules.activeLabel', 'Aktiv') : t('automationRules.inactiveLabel', 'Inaktiv')}</span>
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">
            {t('automationRules.cancelButton', 'Abbrechen')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#ff795d' }}
          >
            {saving ? t('automationRules.savingButton', 'Speichert…') : (isNew ? t('automationRules.createButton', 'Erstellen') : t('automationRules.saveButton', 'Speichern'))}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Hauptseite ────────────────────────────────────────────────────────────────

type ViewTab = 'rules' | 'queue'

export default function AutomationRules() {
  const { t } = useTranslation()
  const [tab,           setTab]           = useState<ViewTab>('rules')
  const [rules,         setRules]         = useState<AutomationRule[]>([])
  const [queue,         setQueue]         = useState<ScheduledMessage[]>([])
  const [loadingRules,  setLoadingRules]  = useState(true)
  const [loadingQueue,  setLoadingQueue]  = useState(false)
  const [showModal,     setShowModal]     = useState(false)
  const [selectedRule,  setSelectedRule]  = useState<AutomationRule | null>(null)
  const [toggling,      setToggling]      = useState<string | null>(null)
  const [cancelling,    setCancelling]    = useState<string | null>(null)
  const [toast,         setToast]         = useState('')
  const [queueFilter,   setQueueFilter]   = useState('pending')
  // Trockenlauf-Simulation (rendert alle aktiven Automatiken, sendet nichts)
  const [simBusy, setSimBusy] = useState(false)
  const [sim, setSim] = useState<SimResult | null>(null)
  const runSimulation = async () => {
    setSimBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('simulate-automations', { body: {} })
      if (error) throw new Error(error.message)
      setSim(data as SimResult)
    } catch (e) {
      setToast(t('automationRules.simulationFailed', '❌ Simulation fehlgeschlagen: {{msg}}', { msg: e instanceof Error ? e.message : '' }))
      setTimeout(() => setToast(''), 4000)
    } finally { setSimBusy(false) }
  }

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3500) }

  // ── Regeln laden ─────────────────────────────────────────────────────────
  const fetchRules = useCallback(async () => {
    setLoadingRules(true)
    try {
      const { data, error } = await supabase
        .from('automation_rules')
        .select('*')
        .order('event_type')
      if (error) throw error
      setRules((data ?? []) as AutomationRule[])
    } catch (err) {
      console.error('[AutomationRules] fetchRules:', err)
    } finally {
      setLoadingRules(false)
    }
  }, [])

  // ── Queue laden ───────────────────────────────────────────────────────────
  const fetchQueue = useCallback(async () => {
    setLoadingQueue(true)
    try {
      let query = supabase
        .from('scheduled_messages')
        .select('*, lead:leads(first_name, last_name, email)')
        .order('scheduled_at', { ascending: true })
        .limit(100)

      if (queueFilter !== 'all') {
        query = query.eq('status', queueFilter)
      }

      const { data, error } = await query
      if (error) throw error
      setQueue((data ?? []) as unknown as ScheduledMessage[])
    } catch (err) {
      console.error('[AutomationRules] fetchQueue:', err)
    } finally {
      setLoadingQueue(false)
    }
  }, [queueFilter])

  useEffect(() => { fetchRules() }, [fetchRules])
  useEffect(() => { if (tab === 'queue') fetchQueue() }, [tab, fetchQueue])

  // ── Regel aktivieren/deaktivieren ─────────────────────────────────────────
  const handleToggle = async (rule: AutomationRule) => {
    setToggling(rule.id)
    try {
      await supabase
        .from('automation_rules')
        .update({ is_active: !rule.is_active, updated_at: new Date().toISOString() })
        .eq('id', rule.id)
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, is_active: !rule.is_active } : r))
      showToast(rule.is_active ? t('automationRules.ruleDeactivated', '⏸ Regel deaktiviert') : t('automationRules.ruleActivated', '▶️ Regel aktiviert'))
    } catch (err) {
      console.error('[AutomationRules] toggle:', err)
    } finally {
      setToggling(null)
    }
  }

  // ── Regel löschen ─────────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (!window.confirm(t('automationRules.confirmDeleteRule', 'Regel wirklich löschen? Ausstehende geplante Nachrichten bleiben erhalten.'))) return
    try {
      await supabase.from('automation_rules').delete().eq('id', id)
      setRules(prev => prev.filter(r => r.id !== id))
      showToast(t('automationRules.ruleDeleted', '🗑 Regel gelöscht'))
    } catch (err) {
      console.error('[AutomationRules] delete:', err)
    }
  }

  // ── Geplante Nachricht abbrechen ──────────────────────────────────────────
  const handleCancel = async (msgId: string) => {
    setCancelling(msgId)
    try {
      await supabase
        .from('scheduled_messages')
        .update({ status: 'cancelled' })
        .eq('id', msgId)
        .eq('status', 'pending')
      setQueue(prev => prev.map(m => m.id === msgId ? { ...m, status: 'cancelled' } : m))
      showToast(t('automationRules.messageCancelled', '✋ Nachricht abgebrochen'))
    } catch (err) {
      console.error('[AutomationRules] cancel:', err)
    } finally {
      setCancelling(null)
    }
  }

  // ── Manuell auslösen (für Tests) ──────────────────────────────────────────
  const handleManualTrigger = async () => {
    try {
      const { error } = await supabase.functions.invoke('process-scheduled-messages', { body: {} })
      if (error) throw error
      showToast(t('automationRules.schedulerTriggered', '⚡️ Scheduler manuell ausgeführt'))
      if (tab === 'queue') fetchQueue()
    } catch (err) {
      showToast(t('automationRules.genericError', '❌ Fehler: {{msg}}', { msg: err instanceof Error ? err.message : String(err) }))
    }
  }

  const eventLabel = (v: string) => {
    const et = EVENT_TYPES.find(e => e.value === v)
    return et ? t(`automationRules.${et.labelKey}`, et.labelDefault) : v
  }
  const eventIcon  = (v: string) => EVENT_TYPES.find(e => e.value === v)?.icon  ?? '⚡'

  return (
    <DashboardLayout basePath="/admin/crm">

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl shadow-lg text-sm">
          {toast}
        </div>
      )}

      <div className="max-w-4xl space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('automationRules.pageTitle', '⚡ Automationsregeln')}</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {t('automationRules.pageSubtitle', 'Automatische E-Mail + WhatsApp Nachrichten bei CRM-Ereignissen')}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void runSimulation()}
              disabled={simBusy}
              className="px-3 py-2 rounded-lg text-xs font-medium border border-orange-200 text-orange-700 hover:bg-orange-50 flex items-center gap-1.5 disabled:opacity-50"
              title={t('automationRules.simulateAllTitle', 'Alle aktiven Automatiken rendern, ohne zu senden')}
            >
              {simBusy ? t('automationRules.simulatingButton', '⏳ Simuliere…') : t('automationRules.simulateAllButton', '🧪 Alle simulieren')}
            </button>
            <button
              onClick={handleManualTrigger}
              className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 flex items-center gap-1.5"
              title={t('automationRules.runSchedulerTitle', 'Scheduler jetzt ausführen (Test)')}
            >
              {t('automationRules.runSchedulerButton', '▶ Scheduler ausführen')}
            </button>
            <button
              onClick={() => { setSelectedRule(null); setShowModal(true) }}
              className="px-4 py-2 rounded-lg text-white text-sm font-medium flex items-center gap-1.5"
              style={{ backgroundColor: '#ff795d' }}
            >
              {t('automationRules.newRuleButton', '+ Neue Regel')}
            </button>
          </div>
        </div>

        {/* Info */}
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-700">
          <p className="font-medium mb-1">{t('automationRules.howItWorksTitle', 'Wie funktioniert das?')}</p>
          <p className="text-blue-600 text-xs leading-relaxed">
            {t('automationRules.howItWorksBody', 'Bei jedem CRM-Ereignis (Lead erstellt, Phase wechselt) wird ')}<code className="bg-blue-100 px-1 rounded">schedule-message</code>{t('automationRules.howItWorksBody2', ' aufgerufen. Die Funktion liest aktive Regeln, rendert Templates mit Lead-Daten und legt geplante Nachrichten an. Der Scheduler ')}<code className="bg-blue-100 px-1 rounded">process-scheduled-messages</code>{t('automationRules.howItWorksBody3', ' läuft alle 5 Minuten und sendet fällige Nachrichten per E-Mail (Ionos SMTP) und/oder WhatsApp (Timelines API).')}
          </p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 gap-0">
          {([
            { id: 'rules', label: t('automationRules.rulesTab', '📋 Regeln ({{count}})', { count: rules.length }) },
            { id: 'queue', label: t('automationRules.queueTab', '📬 Nachrichten-Queue') },
          ] as { id: ViewTab; label: string }[]).map(tabItem => (
            <button
              key={tabItem.id}
              onClick={() => setTab(tabItem.id)}
              className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === tabItem.id
                  ? 'border-orange-400 text-orange-500'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tabItem.label}
            </button>
          ))}
        </div>

        {/* ── Tab: Regeln ─────────────────────────────────────────────────── */}
        {tab === 'rules' && (
          <div className="space-y-3">
            {loadingRules ? (
              <div className="flex justify-center py-16">
                <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
              </div>
            ) : rules.length === 0 ? (
              <div className="text-center py-16 text-gray-400 text-sm">
                {t('automationRules.noRulesYet', 'Noch keine Regeln. Klicke auf „+ Neue Regel".')}
              </div>
            ) : (
              rules.map(rule => (
                <div
                  key={rule.id}
                  className={`bg-white rounded-2xl border shadow-sm p-5 flex items-center gap-4 transition-opacity ${
                    rule.is_active ? '' : 'opacity-55'
                  }`}
                >
                  {/* Aktiv-Dot */}
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${rule.is_active ? 'bg-green-400' : 'bg-gray-300'}`} />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-gray-900">{rule.name}</span>
                      <span className="text-xs bg-orange-50 text-orange-700 px-2 py-0.5 rounded-full border border-orange-100">
                        {eventIcon(rule.event_type)} {eventLabel(rule.event_type)}
                      </span>
                      <span className="text-xs bg-gray-50 text-gray-600 px-2 py-0.5 rounded-full border border-gray-100">
                        ⏱ {delayLabel(rule.delay_minutes, t)}
                      </span>
                      <span className="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded-full border border-purple-100">
                        {t(`automationRules.${MSG_TYPE_KEY[rule.message_type].key}`, MSG_TYPE_KEY[rule.message_type].def)}
                      </span>
                    </div>
                    {rule.description && (
                      <p className="text-xs text-gray-400 mt-0.5">{rule.description}</p>
                    )}
                  </div>

                  {/* Aktionen */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => handleToggle(rule)}
                      disabled={toggling === rule.id}
                      className={`relative w-10 h-5 rounded-full transition-colors disabled:opacity-50 ${rule.is_active ? 'bg-green-500' : 'bg-gray-200'}`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${rule.is_active ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                    <button
                      onClick={() => { setSelectedRule(rule); setShowModal(true) }}
                      className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:border-orange-300 hover:text-orange-600 transition-colors"
                    >
                      {t('automationRules.editButton', 'Bearbeiten')}
                    </button>
                    <button
                      onClick={() => handleDelete(rule.id)}
                      className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 text-red-400 hover:border-red-300 hover:bg-red-50 transition-colors"
                      title={t('automationRules.deleteTitle', 'Löschen')}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── Tab: Queue ──────────────────────────────────────────────────── */}
        {tab === 'queue' && (
          <div className="space-y-4">
            {/* Filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium">{t('automationRules.statusLabel', 'Status:')}</span>
              {(['all', 'pending', 'sent', 'failed', 'cancelled'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setQueueFilter(s)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    queueFilter === s
                      ? 'bg-gray-800 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {s === 'all' ? t('automationRules.statusAll', 'Alle') : t(`automationRules.${STATUS_KEY[s].key}`, STATUS_KEY[s].def)}
                </button>
              ))}
              <button
                onClick={fetchQueue}
                className="ml-auto text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
              >
                {t('automationRules.refreshButton', '↺ Aktualisieren')}
              </button>
            </div>

            {loadingQueue ? (
              <div className="flex justify-center py-16">
                <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
              </div>
            ) : queue.length === 0 ? (
              <div className="text-center py-16 text-gray-400 text-sm">
                {t('automationRules.noQueueMessages', 'Keine Nachrichten in der Queue.')}
              </div>
            ) : (
              <div className="space-y-2">
                {queue.map(msg => {
                  const lead = (msg as unknown as { lead?: { first_name: string; last_name: string; email: string } }).lead
                  return (
                    <div key={msg.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex items-center gap-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${STATUS_STYLE[msg.status]}`}>
                        {t(`automationRules.${STATUS_KEY[msg.status].key}`, STATUS_KEY[msg.status].def)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-gray-800">
                            {lead ? `${lead.first_name} ${lead.last_name}` : msg.lead_id}
                          </span>
                          <span className="text-xs bg-gray-50 text-gray-500 px-1.5 py-0.5 rounded border border-gray-100">
                            {t(`automationRules.${MSG_TYPE_KEY[msg.type].key}`, MSG_TYPE_KEY[msg.type].def)}
                          </span>
                          <span className="text-xs text-gray-400">
                            {eventIcon(msg.event_type)} {eventLabel(msg.event_type)}
                          </span>
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5 flex gap-3">
                          <span>{t('automationRules.plannedAt', '📅 Geplant: {{date}}', { date: fmtDate(msg.scheduled_at) })}</span>
                          {msg.sent_at && <span>{t('automationRules.sentAt', '✓ Gesendet: {{date}}', { date: fmtDate(msg.sent_at) })}</span>}
                          {msg.error_message && <span className="text-red-500">⚠ {msg.error_message}</span>}
                        </div>
                        {msg.email_subject && (
                          <p className="text-xs text-gray-500 mt-0.5 truncate">
                            📧 {msg.email_subject}
                          </p>
                        )}
                      </div>
                      {msg.status === 'pending' && (
                        <button
                          onClick={() => handleCancel(msg.id)}
                          disabled={cancelling === msg.id}
                          className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-red-300 hover:text-red-500 transition-colors disabled:opacity-50"
                        >
                          {cancelling === msg.id ? '…' : t('automationRules.cancelMessageButton', 'Abbrechen')}
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

      {/* Rule Modal */}
      {showModal && (
        <RuleModal
          rule={selectedRule}
          onClose={() => { setShowModal(false); setSelectedRule(null) }}
          onSaved={() => { fetchRules(); if (tab === 'queue') fetchQueue() }}
        />
      )}

      {/* ── Trockenlauf-Vorschau: zeigt, was jede aktive Automatik senden würde ── */}
      {sim && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setSim(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl my-8" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 sticky top-0 bg-white rounded-t-2xl">
              <div>
                <h3 className="font-semibold text-gray-900">{t('automationRules.simModalTitle', '🧪 Automatik-Simulation')}</h3>
                <p className="text-xs text-gray-500">{t('automationRules.simModalSampleCustomer', 'Beispielkunde „{{lead}}"', { lead: sim.lead_used })} · {t('automationRules.simModalActiveRules', '{{count}} aktive Regeln', { count: sim.total })} · <span className="text-green-600">{t('automationRules.simModalReady', '{{count}} versandfertig', { count: sim.ready })}</span>{sim.problems ? <span className="text-red-600"> · {t('automationRules.simModalProblems', '{{count}} mit Problem', { count: sim.problems })}</span> : null} · {t('automationRules.simModalNothingSent', 'es wird nichts gesendet')}</p>
              </div>
              <button onClick={() => setSim(null)} className="text-gray-400 hover:text-gray-700 text-xl leading-none shrink-0">✕</button>
            </div>
            <div className="p-5 space-y-3">
              {sim.rules.map(r => (
                <div key={r.id} className={`rounded-xl border p-4 ${r.ok ? 'border-gray-100' : 'border-red-200 bg-red-50/40'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-800 text-sm">{r.name}</p>
                      <p className="text-xs text-gray-400">{r.event_type} · {r.timing} · {r.message_type} · → {r.recipient_label}</p>
                    </div>
                    <span className={`text-xs font-medium shrink-0 px-2 py-0.5 rounded-full ${r.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{r.ok ? t('automationRules.simRuleReady', '✅ bereit') : t('automationRules.simRuleProblem', '⚠️ Problem')}</span>
                  </div>
                  {!r.ok && <p className="text-xs text-red-600 mt-2">⚠️ {r.issues.join(' · ')}</p>}
                  {r.subject && (
                    <div className="mt-2.5">
                      <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">{t('automationRules.simEmailTo', '📧 E-Mail an {{recipient}}', { recipient: r.recipient_email || '—' })}</p>
                      <p className="text-sm font-medium text-gray-800 mt-0.5">{r.subject}</p>
                      {r.mail_body && <p className="text-xs text-gray-500 mt-1 whitespace-pre-wrap line-clamp-4">{r.mail_body}</p>}
                    </div>
                  )}
                  {r.whatsapp_text && (
                    <div className="mt-2.5">
                      <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">{t('automationRules.simWhatsappTo', '💬 WhatsApp an {{recipient}}', { recipient: r.recipient_phone || '—' })}</p>
                      <p className="text-xs text-gray-600 mt-1 whitespace-pre-wrap bg-green-50 rounded-lg p-2.5 line-clamp-6">{r.whatsapp_text}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}
