import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'
import { DEAL_PHASES, PHASE_ICONS } from '../../../../lib/crmTypes'
import type { AutomationRule, EmailTemplate, DealPhase } from '../../../../lib/crmTypes'
import RecipientPicker from '../../../../components/crm/RecipientPicker'

// ── Stages = „Neuer Lead" + alle Pipeline-Phasen ────────────────────────────────
// Die event_types entsprechen exakt dem, was die schedule-message Engine als
// Auslöser bekommt (Pipeline.handleDrop → triggerScheduleMessage(phase)).
const STAGES: string[] = ['lead_created', ...DEAL_PHASES]

type Channel  = 'email' | 'whatsapp' | 'both'
type DelayUnit = 'minutes' | 'hours' | 'days'

interface WaTpl {
  id:               string
  event_type:       string
  name:             string
  message_template: string
  active:           boolean
}

// Platzhalter, die die schedule-message Engine ersetzt
const PLACEHOLDERS = [
  '{{vorname}}', '{{nachname}}', '{{name}}', '{{email}}',
  '{{phone}}', '{{developers}}', '{{commission_amount}}',
]

// Stage → Default-Kategorie für neu erzeugte E-Mail-Vorlagen
const STAGE_CATEGORY: Record<string, EmailTemplate['category']> = {
  no_show:           'noshow',
  kaufvertrag:       'lawyer',
  finanzierung_de:   'financing',
  finanzierung_cy:   'financing',
  immobilienauswahl: 'project',
  reservierung:      'followup',
}

const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white'
const labelCls = 'block text-xs font-medium text-gray-500 mb-1'

// ── Delay-Helfer ────────────────────────────────────────────────────────────────
function delayToParts(min: number): { value: number; unit: DelayUnit } {
  if (min === 0)        return { value: 0, unit: 'minutes' }
  if (min % 1440 === 0) return { value: min / 1440, unit: 'days' }
  if (min % 60 === 0)   return { value: min / 60,   unit: 'hours' }
  return { value: min, unit: 'minutes' }
}
function partsToDelay(value: number, unit: DelayUnit): number {
  const v = Number(value) || 0
  if (unit === 'days')  return v * 1440
  if (unit === 'hours') return v * 60
  return v
}

function stageIcon(stage: string): string {
  if (stage === 'lead_created') return '📥'
  return PHASE_ICONS[stage as DealPhase] ?? '•'
}

// ── Step-Modal ──────────────────────────────────────────────────────────────────
interface StepModalProps {
  stage:     string
  stageLabel: string
  rule:      AutomationRule | null   // null = neuer Schritt
  rules:     AutomationRule[]        // alle Regeln (für Shared-Template-Erkennung)
  emailTpls: EmailTemplate[]
  waTpls:    WaTpl[]
  onClose:   () => void
  onSaved:   (msg: string) => void
}

function StepModal({ stage, stageLabel, rule, rules, emailTpls, waTpls, onClose, onSaved }: StepModalProps) {
  const { t } = useTranslation()

  const linkedEmail = rule?.email_template_id
    ? emailTpls.find(e => e.id === rule.email_template_id) : undefined
  const linkedWa = rule?.whatsapp_event_type
    ? waTpls.find(w => w.event_type === rule.whatsapp_event_type) : undefined

  const initDelay = delayToParts(rule?.delay_minutes ?? 0)

  const [name,        setName]        = useState(rule?.name ?? '')
  const [channel,     setChannel]     = useState<Channel>((rule?.message_type as Channel) ?? 'whatsapp')
  const [recipient,   setRecipient]   = useState(rule?.recipient ?? 'client')
  const [delayValue,  setDelayValue]  = useState(initDelay.value)
  const [delayUnit,   setDelayUnit]   = useState<DelayUnit>(initDelay.unit)
  const [isActive,    setIsActive]    = useState(rule?.is_active ?? false)
  const [emailSubject, setEmailSubject] = useState(linkedEmail?.subject ?? '')
  const [emailBody,   setEmailBody]   = useState(linkedEmail?.body ?? '')
  const [emailHtml,   setEmailHtml]   = useState(linkedEmail?.html_body ?? '')
  const [waText,      setWaText]      = useState(linkedWa?.message_template ?? '')
  const [showHtml,    setShowHtml]    = useState<boolean>(!!linkedEmail?.html_body)
  const [showPreview, setShowPreview] = useState(false)
  const [copied,      setCopied]      = useState<string | null>(null)
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')

  // Wird die verknüpfte Vorlage von mehreren Regeln genutzt? → beim Bearbeiten
  // forken (Copy-on-Write), damit Geschwister-Schritte nicht mitverändert werden.
  const emailShared = useMemo(() =>
    rule?.email_template_id
      ? rules.filter(r => r.email_template_id === rule.email_template_id).length > 1
      : false, [rules, rule])
  const waShared = useMemo(() =>
    rule?.whatsapp_event_type
      ? rules.filter(r => r.whatsapp_event_type === rule.whatsapp_event_type).length > 1
      : false, [rules, rule])

  const wantEmail = channel === 'email' || channel === 'both'
  const wantWa    = channel === 'whatsapp' || channel === 'both'

  const copyPlaceholder = (key: string) => {
    navigator.clipboard.writeText(key).catch(() => {})
    setCopied(key)
    setTimeout(() => setCopied(null), 1200)
  }

  const previewHtml = (html: string) => html
    .replace(/\{\{vorname\}\}/g,  'Max')
    .replace(/\{\{nachname\}\}/g, 'Mustermann')
    .replace(/\{\{name\}\}/g,     'Max Mustermann')
    .replace(/\{\{email\}\}/g,    'max@beispiel.de')
    .replace(/\{\{phone\}\}/g,    '+49 151 12345678')
    .replace(/\{\{developers\}\}/g, 'Sunrise Developments')
    .replace(/\{\{commission_amount\}\}/g, '12.500,00 €')
    .replace(/\{\{[^}]+\}\}/g, '–')

  const handleSave = async () => {
    if (wantEmail && (!emailSubject.trim() || !emailBody.trim())) {
      setError(t('crm.stageEditor.errEmail', 'Betreff und Text der E-Mail sind Pflicht')); return
    }
    if (wantWa && !waText.trim()) {
      setError(t('crm.stageEditor.errWa', 'WhatsApp-Text ist Pflicht')); return
    }
    setSaving(true); setError('')
    try {
      let emailTemplateId = rule?.email_template_id ?? null
      let waEventType     = rule?.whatsapp_event_type ?? null

      // ── E-Mail-Vorlage anlegen / aktualisieren ──────────────────────────────
      if (wantEmail) {
        const content = {
          subject:   emailSubject.trim(),
          body:      emailBody.trim(),
          html_body: emailHtml.trim() || null,
        }
        if (emailTemplateId && !emailShared) {
          const { error: e } = await supabase.from('email_templates').update(content).eq('id', emailTemplateId)
          if (e) throw e
        } else {
          const { data, error: e } = await supabase.from('email_templates').insert({
            name:     `${stageLabel} · ${name.trim() || t('crm.stageEditor.step', 'Schritt')}`,
            category: STAGE_CATEGORY[stage] ?? 'followup',
            language: 'de',
            ...content,
          }).select('id').single()
          if (e) throw e
          emailTemplateId = (data as { id: string }).id
        }
      } else {
        emailTemplateId = null
      }

      // ── WhatsApp-Vorlage anlegen / aktualisieren ────────────────────────────
      if (wantWa) {
        if (waEventType && !waShared) {
          const { error: e } = await supabase.from('whatsapp_templates').update({
            message_template: waText.trim(),
            active:           true,
            updated_at:       new Date().toISOString(),
          }).eq('event_type', waEventType)
          if (e) throw e
        } else {
          const generated = `stage_${stage}_${Math.random().toString(36).slice(2, 8)}`
          const { error: e } = await supabase.from('whatsapp_templates').insert({
            name:             `${stageLabel} · ${name.trim() || t('crm.stageEditor.step', 'Schritt')}`,
            event_type:       generated,
            message_template: waText.trim(),
            recipients:       [],
            included_fields:  [],
            active:           true,
          })
          if (e) throw e
          waEventType = generated
        }
      } else {
        waEventType = null
      }

      // ── Regel anlegen / aktualisieren ───────────────────────────────────────
      const safeRecipient = (recipient === 'client' || recipient.startsWith('bc:') || recipient.startsWith('dc:'))
        ? recipient : 'client'
      const rulePayload = {
        name:                name.trim() || `${stageLabel} – ${t('crm.stageEditor.step', 'Schritt')}`,
        event_type:          stage,
        delay_minutes:       partsToDelay(delayValue, delayUnit),
        message_type:        channel,
        email_template_id:   emailTemplateId,
        whatsapp_event_type: waEventType,
        is_active:           isActive,
        recipient:           safeRecipient,
        updated_at:          new Date().toISOString(),
      }
      if (rule) {
        const { error: e } = await supabase.from('automation_rules').update(rulePayload).eq('id', rule.id)
        if (e) throw e
      } else {
        const { error: e } = await supabase.from('automation_rules').insert(rulePayload)
        if (e) throw e
      }

      onSaved(rule
        ? t('crm.stageEditor.savedEdit', '✅ Schritt gespeichert')
        : t('crm.stageEditor.savedNew',  '✅ Schritt angelegt'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-6 flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">
            {stageIcon(stage)} {rule
              ? t('crm.stageEditor.editStep', 'Schritt bearbeiten')
              : t('crm.stageEditor.newStep',  'Neuer Schritt')}
            <span className="text-gray-400 font-normal"> · {stageLabel}</span>
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {/* Bezeichnung */}
          <div>
            <label className={labelCls}>{t('crm.stageEditor.stepName', 'Bezeichnung')}</label>
            <input className={inputCls} value={name} onChange={e => setName(e.target.value)}
              placeholder={t('crm.stageEditor.stepNamePh', 'z.B. Erste Erinnerung')} />
          </div>

          {/* Kanal + Timing */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('crm.stageEditor.channel', 'Kanal')}</label>
              <select className={inputCls} value={channel} onChange={e => setChannel(e.target.value as Channel)}>
                <option value="whatsapp">{t('crm.stageEditor.chWhatsapp', '📱 WhatsApp')}</option>
                <option value="email">{t('crm.stageEditor.chEmail', '📧 E-Mail')}</option>
                <option value="both">{t('crm.stageEditor.chBoth', '📧 + 📱 Beides')}</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('crm.stageEditor.timing', 'Wann nach Auslöser')}</label>
              <div className="flex gap-2">
                <input type="number" min={0} className={`${inputCls} w-24`}
                  value={delayValue} onChange={e => setDelayValue(Number(e.target.value))} />
                <select className={inputCls} value={delayUnit} onChange={e => setDelayUnit(e.target.value as DelayUnit)}>
                  <option value="minutes">{t('crm.stageEditor.minutes', 'Minuten')}</option>
                  <option value="hours">{t('crm.stageEditor.hours', 'Stunden')}</option>
                  <option value="days">{t('crm.stageEditor.days', 'Tage')}</option>
                </select>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                {delayValue === 0
                  ? t('crm.stageEditor.immediately', 'Sofort beim Auslöser')
                  : t('crm.stageEditor.afterHint', 'Verzögerung nach Stage-Wechsel')}
              </p>
            </div>
          </div>

          {/* Empfänger */}
          <div>
            <label className={labelCls}>{t('crm.recipient.label', 'Empfänger')}</label>
            <RecipientPicker value={recipient} onChange={setRecipient} channel={channel} />
          </div>

          {/* Platzhalter */}
          <div className="bg-gray-50 rounded-xl p-3">
            <p className="text-xs font-semibold text-gray-500 mb-2">
              {t('crm.stageEditor.placeholders', 'Platzhalter (klicken zum Kopieren)')}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {PLACEHOLDERS.map(p => (
                <button key={p} type="button" onClick={() => copyPlaceholder(p)}
                  className={`text-xs px-2 py-1 rounded-lg border transition-all font-mono ${
                    copied === p
                      ? 'bg-green-100 border-green-300 text-green-700'
                      : 'bg-white border-gray-200 text-gray-600 hover:border-orange-300 hover:text-orange-600'
                  }`}>
                  {copied === p ? '✓' : p}
                </button>
              ))}
            </div>
          </div>

          {/* WhatsApp-Text */}
          {wantWa && (
            <div>
              <label className={labelCls}>{t('crm.stageEditor.waText', 'WhatsApp-Text')} *</label>
              <textarea rows={5} className={`${inputCls} font-mono resize-y`}
                value={waText} onChange={e => setWaText(e.target.value)}
                placeholder={t('crm.stageEditor.waPh', 'Hallo {{vorname}}, …')} />
            </div>
          )}

          {/* E-Mail */}
          {wantEmail && (
            <div className="space-y-3 border-t border-gray-100 pt-4">
              <div>
                <label className={labelCls}>{t('crm.stageEditor.emailSubject', 'E-Mail Betreff')} *</label>
                <input className={inputCls} value={emailSubject} onChange={e => setEmailSubject(e.target.value)}
                  placeholder={t('crm.stageEditor.subjectPh', 'z.B. Ihr Termin bei Happy Property')} />
              </div>
              <div>
                <label className={labelCls}>{t('crm.stageEditor.emailBody', 'E-Mail Text')} *</label>
                <textarea rows={6} className={`${inputCls} resize-y`}
                  value={emailBody} onChange={e => setEmailBody(e.target.value)}
                  placeholder={t('crm.stageEditor.bodyPh', 'Reiner Text – wird genutzt, wenn kein HTML hinterlegt ist.')} />
              </div>

              {/* HTML optional */}
              <div>
                <button type="button" onClick={() => setShowHtml(v => !v)}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-700">
                  {showHtml ? '− ' : '+ '}{t('crm.stageEditor.htmlToggle', 'HTML-Layout (optional)')}
                  {emailHtml && !showHtml && <span className="ml-1 text-indigo-400">●</span>}
                </button>
                {showHtml && (
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-gray-500">
                        {t('crm.stageEditor.htmlHint', 'HTML überschreibt den reinen Text beim Versand.')}
                      </p>
                      <button type="button" onClick={() => setShowPreview(p => !p)}
                        className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600">
                        {showPreview
                          ? t('crm.stageEditor.previewClose', '✕ Vorschau')
                          : t('crm.stageEditor.preview', '👁 Vorschau')}
                      </button>
                    </div>
                    <textarea rows={8} className={`${inputCls} text-xs font-mono resize-y`}
                      value={emailHtml} onChange={e => setEmailHtml(e.target.value)}
                      placeholder={'<!DOCTYPE html>\n<html><body>\n  <p>Hallo {{vorname}},</p>\n</body></html>'} />
                    {showPreview && emailHtml && (
                      <div className="border border-gray-200 rounded-xl overflow-hidden">
                        <iframe srcDoc={previewHtml(emailHtml)} title="HTML Preview"
                          className="w-full" style={{ height: 320, border: 'none' }}
                          sandbox="allow-same-origin" />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Aktiv */}
          <div className="flex items-center gap-3 border-t border-gray-100 pt-4">
            <button onClick={() => setIsActive(v => !v)}
              className={`relative w-10 h-5 rounded-full transition-colors ${isActive ? 'bg-green-500' : 'bg-gray-200'}`}>
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${isActive ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
            <span className="text-sm text-gray-700">
              {isActive
                ? t('crm.stageEditor.activeOn', 'Aktiv – geht raus, sobald der Versand live ist')
                : t('crm.stageEditor.activeOff', 'Inaktiv – wird nicht verschickt')}
            </span>
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
export default function StageMessages() {
  const { t } = useTranslation()

  const [rules,     setRules]     = useState<AutomationRule[]>([])
  const [emailTpls, setEmailTpls] = useState<EmailTemplate[]>([])
  const [waTpls,    setWaTpls]    = useState<WaTpl[]>([])
  const [loading,   setLoading]   = useState(true)
  const [selected,  setSelected]  = useState<string>('lead_created')
  const [editing,   setEditing]   = useState<{ rule: AutomationRule | null } | null>(null)
  const [toast,     setToast]     = useState('')

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const stageLabel = useCallback((stage: string) =>
    stage === 'lead_created'
      ? t('crm.stageEditor.leadCreated', 'Neuer Lead')
      : t(`crm.phases.${stage}`, stage), [t])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [r, e, w] = await Promise.all([
        supabase.from('automation_rules').select('*').order('delay_minutes'),
        supabase.from('email_templates').select('*'),
        supabase.from('whatsapp_templates').select('id, event_type, name, message_template, active'),
      ])
      setRules((r.data ?? []) as AutomationRule[])
      setEmailTpls((e.data ?? []) as EmailTemplate[])
      setWaTpls((w.data ?? []) as WaTpl[])
      // Default-Stage = erste Stage mit Regeln
      const rs = (r.data ?? []) as AutomationRule[]
      const firstWith = STAGES.find(s => rs.some(rule => rule.event_type === s))
      if (firstWith) setSelected(prev => prev === 'lead_created' && !rs.some(x => x.event_type === 'lead_created') ? firstWith : prev)
    } catch (err) {
      console.error('[StageMessages] fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const steps = useMemo(
    () => rules.filter(r => r.event_type === selected).sort((a, b) => a.delay_minutes - b.delay_minutes),
    [rules, selected])

  const countFor = useCallback((stage: string) => {
    const list = rules.filter(r => r.event_type === stage)
    return { total: list.length, active: list.filter(r => r.is_active).length }
  }, [rules])

  const delayLabel = (min: number): string => {
    if (min === 0)      return t('crm.stageEditor.immediatelyShort', 'Sofort')
    const p = delayToParts(min)
    const unit = p.unit === 'days' ? t('crm.stageEditor.daysShort', 'Tg')
      : p.unit === 'hours' ? t('crm.stageEditor.hoursShort', 'Std')
      : t('crm.stageEditor.minutesShort', 'Min')
    return `+${p.value} ${unit}`
  }

  const toggleActive = async (rule: AutomationRule) => {
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, is_active: !r.is_active } : r))
    const { error } = await supabase.from('automation_rules')
      .update({ is_active: !rule.is_active, updated_at: new Date().toISOString() })
      .eq('id', rule.id)
    if (error) { showToast(`❌ ${error.message}`); fetchAll() }
  }

  const deleteStep = async (rule: AutomationRule) => {
    if (!window.confirm(t('crm.stageEditor.deleteConfirm', 'Diesen Schritt löschen?'))) return
    const { error } = await supabase.from('automation_rules').delete().eq('id', rule.id)
    if (error) { showToast(`❌ ${error.message}`); return }
    showToast(t('crm.stageEditor.deleted', 'Schritt gelöscht'))
    fetchAll()
  }

  const channelBadge = (mt: string) =>
    mt === 'both' ? '📧 + 📱' : mt === 'email' ? '📧' : '📱'

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">
          {toast}
        </div>
      )}

      <div className="p-6 space-y-5">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {t('crm.stageEditor.title', 'Nachrichten je Stage')}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('crm.stageEditor.subtitle', 'Pro Lead-Stage festlegen, welche Nachrichten (WhatsApp/E-Mail) in welchen Abständen rausgehen.')}
          </p>
        </div>

        {/* Safety-Hinweis */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          {t('crm.stageEditor.safetyNote', 'Solange der automatische Versand nicht scharfgeschaltet ist, wird nichts verschickt. „Aktiv" bedeutet: geht raus, sobald das System live ist.')}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-5">
            {/* Stage-Liste */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-2 h-fit">
              {STAGES.map(stage => {
                const c = countFor(stage)
                const isSel = selected === stage
                return (
                  <button key={stage} onClick={() => setSelected(stage)}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-left transition-colors ${
                      isSel ? 'text-white' : 'text-gray-700 hover:bg-gray-50'
                    }`}
                    style={isSel ? { backgroundColor: '#ff795d' } : undefined}>
                    <span>{stageIcon(stage)}</span>
                    <span className="flex-1 min-w-0 truncate font-medium">{stageLabel(stage)}</span>
                    {c.total > 0 && (
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                        isSel ? 'bg-white/25 text-white'
                          : c.active > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {c.active > 0 ? `${c.active}/${c.total}` : c.total}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Schritte der gewählten Stage */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">
                  {stageIcon(selected)} {stageLabel(selected)}
                </h2>
                <button onClick={() => setEditing({ rule: null })}
                  className="px-3 py-1.5 rounded-xl text-white text-sm font-medium"
                  style={{ backgroundColor: '#ff795d' }}>
                  {t('crm.stageEditor.addStep', '+ Schritt hinzufügen')}
                </button>
              </div>

              {steps.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-12 bg-white rounded-2xl border border-dashed border-gray-200">
                  {t('crm.stageEditor.noSteps', 'Noch keine Nachrichten für diese Stage.')}
                </p>
              ) : (
                <div className="space-y-2">
                  {steps.map((rule, idx) => {
                    const em = rule.email_template_id ? emailTpls.find(e => e.id === rule.email_template_id) : undefined
                    const wa = rule.whatsapp_event_type ? waTpls.find(w => w.event_type === rule.whatsapp_event_type) : undefined
                    const preview = wa?.message_template || em?.subject || em?.body || '—'
                    return (
                      <div key={rule.id}
                        className={`bg-white rounded-2xl border shadow-sm p-4 ${rule.is_active ? 'border-gray-100' : 'border-gray-100 opacity-70'}`}>
                        <div className="flex items-start gap-3">
                          {/* Stufen-Nummer */}
                          <span className="shrink-0 w-6 h-6 rounded-full bg-gray-100 text-gray-500 text-xs flex items-center justify-center font-semibold mt-0.5">
                            {idx + 1}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-gray-900 text-sm">{rule.name}</span>
                              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                                {channelBadge(rule.message_type)}
                              </span>
                              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-mono">
                                {delayLabel(rule.delay_minutes)}
                              </span>
                            </div>
                            <p className="text-xs text-gray-400 mt-1 line-clamp-1">{preview}</p>
                          </div>
                          {/* Aktionen */}
                          <div className="flex items-center gap-2 shrink-0">
                            <button onClick={() => toggleActive(rule)}
                              title={rule.is_active ? t('crm.stageEditor.inactive', 'Inaktiv') : t('crm.stageEditor.active', 'Aktiv')}
                              className={`relative w-9 h-5 rounded-full transition-colors ${rule.is_active ? 'bg-green-500' : 'bg-gray-200'}`}>
                              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${rule.is_active ? 'translate-x-4' : 'translate-x-0.5'}`} />
                            </button>
                            <button onClick={() => setEditing({ rule })}
                              className="text-sm text-gray-500 hover:text-gray-800 font-medium">
                              {t('common.edit', 'Bearbeiten')}
                            </button>
                            <button onClick={() => deleteStep(rule)}
                              className="text-sm text-red-500 hover:text-red-700 font-medium">
                              {t('common.delete', 'Löschen')}
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {editing && (
        <StepModal
          stage={selected}
          stageLabel={stageLabel(selected)}
          rule={editing.rule}
          rules={rules}
          emailTpls={emailTpls}
          waTpls={waTpls}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); showToast(m); fetchAll() }}
        />
      )}
    </DashboardLayout>
  )
}
