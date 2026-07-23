import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'
import { DEAL_PHASES, PHASE_ICONS } from '../../../../lib/crmTypes'
import type { AutomationRule, EmailTemplate, DealPhase } from '../../../../lib/crmTypes'
import RecipientPicker from '../../../../components/crm/RecipientPicker'
import WaImageField from '../../../../components/crm/WaImageField'
import { CustomSelect } from '../../../../components/CustomSelect'

// ── Stages = „Neuer Lead" + alle Pipeline-Phasen ────────────────────────────────
// Die event_types entsprechen exakt dem, was die schedule-message Engine als
// Auslöser bekommt (Pipeline.handleDrop → triggerScheduleMessage(phase)).
const STAGES: string[] = ['lead_created', ...DEAL_PHASES]
// Phasen, die (auch) über den WhatsApp-Termin-Bot laufen → in der Liste farblich markiert.
const BOT_STAGES = new Set(['no_show', 'erstkontakt', 'immobilienauswahl'])

type Channel  = 'email' | 'whatsapp' | 'both'
type DelayUnit = 'minutes' | 'hours' | 'days'

interface WaTpl {
  id:               string
  event_type:       string
  name:             string
  message_template: string
  image_url:        string | null
  active:           boolean
}

// Platzhalter, die die schedule-message Engine ersetzt
const PLACEHOLDERS = [
  '{{vorname}}', '{{nachname}}', '{{name}}', '{{email}}', '{{phone}}',
  '{{developers}}', '{{commission_amount}}',
  '{{notiz}}', '{{zoom_link}}', '{{objekt}}', '{{unit}}', '{{kaufpreis}}', '{{drive_link}}',
  '{{doc_vollmacht}}', '{{doc_unterlagen}}',
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
  const [apptCond,    setApptCond]    = useState<string>(rule?.appointment_condition ?? 'none')
  const [timingType,  setTimingType]  = useState<string>(rule?.timing_type ?? 'after_event')
  const [driveTrigger, setDriveTrigger] = useState<boolean>(rule?.drive_trigger ?? false)
  const [driveShare,  setDriveShare]  = useState<string[]>(rule?.drive_share ?? [])
  const [emailSubject, setEmailSubject] = useState(linkedEmail?.subject ?? '')
  const [emailBody,   setEmailBody]   = useState(linkedEmail?.body ?? '')
  const [emailHtml,   setEmailHtml]   = useState(linkedEmail?.html_body ?? '')
  const [waText,      setWaText]      = useState(linkedWa?.message_template ?? '')
  const [waImage,     setWaImage]     = useState<string | null>(linkedWa?.image_url ?? null)
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
            image_url:        waImage,
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
            image_url:        waImage,
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
        appointment_condition: apptCond,
        timing_type:         timingType,
        drive_trigger:       driveTrigger,
        drive_share:         driveTrigger && driveShare.length ? driveShare : null,
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
              <CustomSelect
                className="w-full"
                value={channel}
                onChange={(v) => setChannel(v as Channel)}
                options={[
                  { value: 'whatsapp', label: t('crm.stageEditor.chWhatsapp', '📱 WhatsApp') },
                  { value: 'email', label: t('crm.stageEditor.chEmail', '📧 E-Mail') },
                  { value: 'both', label: t('crm.stageEditor.chBoth', '📧 + 📱 Beides') },
                ]}
              />
            </div>
            <div>
              <label className={labelCls}>{t('crm.stageEditor.timing', 'Timing')}</label>
              <CustomSelect
                className="w-full mb-2"
                value={timingType}
                onChange={(v) => setTimingType(v)}
                options={[
                  { value: 'after_event', label: t('crm.stageEditor.afterEvent', 'Nach Stage-Wechsel') },
                  { value: 'before_appointment', label: t('crm.stageEditor.beforeAppt', 'Vor dem Termin') },
                ]}
              />
              <div className="flex gap-2">
                <input type="number" min={0} className={`${inputCls} w-24`}
                  value={delayValue} onChange={e => setDelayValue(Number(e.target.value))} />
                <CustomSelect
                  className="w-full"
                  value={delayUnit}
                  onChange={(v) => setDelayUnit(v as DelayUnit)}
                  options={[
                    { value: 'minutes', label: t('crm.stageEditor.minutes', 'Minuten') },
                    { value: 'hours', label: t('crm.stageEditor.hours', 'Stunden') },
                    { value: 'days', label: t('crm.stageEditor.days', 'Tage') },
                  ]}
                />
              </div>
              <p className="text-xs text-gray-400 mt-1">
                {timingType === 'before_appointment'
                  ? t('crm.stageEditor.beforeHint', 'Vor dem Calendly-Termin (nur wenn ein Termin existiert)')
                  : delayValue === 0
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

          {/* Bedingung (Calendly-Termin) */}
          <div>
            <label className={labelCls}>{t('crm.stageEditor.condition', 'Bedingung (Calendly-Termin)')}</label>
            <CustomSelect
              className="w-full"
              value={apptCond}
              onChange={(v) => setApptCond(v)}
              options={[
                { value: 'none', label: t('crm.stageEditor.condNone', 'Immer senden') },
                { value: 'no_appointment', label: t('crm.stageEditor.condNo', 'Nur wenn KEIN Termin gebucht') },
                { value: 'has_appointment', label: t('crm.stageEditor.condHas', 'Nur wenn ein Termin existiert') },
                { value: 'has_zoom', label: t('crm.stageEditor.condZoom', 'Nur bei Zoom-Termin (mit Link)') },
                { value: 'no_zoom', label: t('crm.stageEditor.condPhone', 'Nur bei Telefon-Termin (ohne Zoom)') },
              ]}
            />
            <p className="text-xs text-gray-400 mt-1">{t('crm.stageEditor.condHint', 'Wird direkt vor dem Versand geprüft (ersetzt n8n-Logik).')}</p>
          </div>

          {/* Drive-Trigger */}
          <div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={driveTrigger} onChange={e => setDriveTrigger(e.target.checked)} />
              {t('crm.stageEditor.driveTrigger', 'Vor Versand Drive-Kundenordner anlegen/sicherstellen')}
            </label>
            {driveTrigger && (
              <div className="mt-2">
                <p className="text-xs text-gray-500 mb-1">{t('crm.stageEditor.driveShare', 'Zusätzlicher Schreibzugriff (z.B. Finanzierer, Anwalt, Developer):')}</p>
                <RecipientPicker value={driveShare[0] ?? ''} onChange={v => setDriveShare(v ? [v] : [])} channel="email" />
                <p className="text-xs text-gray-400 mt-1">{t('crm.stageEditor.driveHint', 'Kunde + Sven haben immer Zugriff. {{drive_link}} im Text nutzbar.')}</p>
              </div>
            )}
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
              <div className="mt-3"><WaImageField value={waImage} onChange={setWaImage} /></div>
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
// ── Weitere Nachrichten: feste System-Events außerhalb der Pipeline ─────────────
// Jeder Eintrag bearbeitet die WIRKLICH verwendete Vorlage (Mail und/oder WhatsApp).
interface SystemEvent {
  key:               string
  icon:              string
  label:             string
  desc:              string
  emailTemplateId?:  string
  whatsappEventType?: string
  placeholders:      string[]
  note?:             string
}
const SYSTEM_EVENTS: SystemEvent[] = [
  {
    key:             'portal_access',
    icon:            '🔑',
    label:           'Portalzugang',
    desc:            'Zugangsdaten-Mail an neue Nutzer/Eigentümer (Login + Passwort). Geht automatisch raus bei Konto-Anlage und „Portal-Zugang senden“.',
    emailTemplateId: '37b1724c-f71c-4e8b-9116-b92d18f03915',
    placeholders:    ['{{vorname}}', '{{email}}', '{{password}}', '{{login_url}}'],
    note:            '{{password}} und {{login_url}} bitte drin lassen — sonst sendet das System automatisch die fest eingebaute Sicherheits-Mail.',
  },
  // Hinweis: Die Nachrichten für die Stufen „Hold" und „Kontakt übergeben" werden
  // in der PIPELINE (oben) bei der jeweiligen Stufe bearbeitet — nicht hier.
]

const fillSysPreview = (h: string): string => h
  .split('{{vorname}}').join('Anna')
  .split('{{name}}').join('Anna Beispiel')
  .split('{{email}}').join('anna@beispiel.de')
  .split('{{password}}').join('Xk7mZ9q')
  .split('{{login_url}}').join('https://portal.happy-property.com/login')

function SystemMessageModal({ event, onClose, onSaved }: {
  event:   SystemEvent
  onClose: () => void
  onSaved: (m: string) => void
}) {
  const { t } = useTranslation()
  const hasEmail = !!event.emailTemplateId
  const hasWa    = !!event.whatsappEventType
  const [tab,     setTab]     = useState<'email' | 'whatsapp'>(hasEmail ? 'email' : 'whatsapp')
  const [subject, setSubject] = useState('')
  const [body,    setBody]    = useState('')
  const [html,    setHtml]    = useState('')
  const [waText,  setWaText]  = useState('')
  const [waImage, setWaImage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [preview, setPreview] = useState(false)
  const [copied,  setCopied]  = useState<string | null>(null)
  const [error,   setError]   = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      if (event.emailTemplateId) {
        const { data } = await supabase.from('email_templates').select('subject, body, html_body').eq('id', event.emailTemplateId).maybeSingle()
        const tpl = data as { subject?: string; body?: string | null; html_body?: string | null } | null
        if (active && tpl) { setSubject(tpl.subject ?? ''); setBody(tpl.body ?? ''); setHtml(tpl.html_body ?? '') }
      }
      if (event.whatsappEventType) {
        const { data } = await supabase.from('whatsapp_templates').select('message_template, image_url').eq('event_type', event.whatsappEventType).maybeSingle()
        const tpl = data as { message_template?: string; image_url?: string | null } | null
        if (active && tpl) { setWaText(tpl.message_template ?? ''); setWaImage(tpl.image_url ?? null) }
      }
      if (active) setLoading(false)
    }
    void load()
    return () => { active = false }
  }, [event])

  const copy = (k: string) => { navigator.clipboard.writeText(k).catch(() => {}); setCopied(k); setTimeout(() => setCopied(null), 1500) }

  const handleSave = async () => {
    setSaving(true); setError('')
    try {
      if (tab === 'email' && event.emailTemplateId) {
        if (!subject.trim()) { setError(t('crm.sys.errSubject', 'Betreff ist Pflicht')); setSaving(false); return }
        const { error: e } = await supabase.from('email_templates')
          .update({ subject: subject.trim(), body: body.trim() || null, html_body: html.trim() || null })
          .eq('id', event.emailTemplateId)
        if (e) throw e
      } else if (tab === 'whatsapp' && event.whatsappEventType) {
        if (!waText.trim()) { setError(t('crm.sys.errWa', 'WhatsApp-Text ist Pflicht')); setSaving(false); return }
        const { error: e } = await supabase.from('whatsapp_templates')
          .update({ message_template: waText.trim(), image_url: waImage }).eq('event_type', event.whatsappEventType)
        if (e) throw e
      }
      onSaved(t('crm.sys.saved', '✅ Vorlage gespeichert'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-6 flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">{event.icon} {t(`stageMessages.eventLabel_${event.key}`, event.label)}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
            <p className="text-xs text-gray-500">{t(`stageMessages.eventDesc_${event.key}`, event.desc)}</p>
            {event.note && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800">⚠️ {t(`stageMessages.eventNote_${event.key}`, event.note)}</div>
            )}

            {hasEmail && hasWa && (
              <div className="flex gap-1 border-b border-gray-200">
                <button type="button" onClick={() => setTab('email')}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === 'email' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500'}`}>{t('stageMessages.tabEmail', '📧 E-Mail')}</button>
                <button type="button" onClick={() => setTab('whatsapp')}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === 'whatsapp' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500'}`}>{t('stageMessages.tabWhatsapp', '📱 WhatsApp')}</button>
              </div>
            )}

            {/* Platzhalter */}
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-500 mb-2">{t('crm.sys.placeholders', 'Platzhalter (klicken zum Kopieren)')}</p>
              <div className="flex flex-wrap gap-1.5">
                {event.placeholders.map(p => (
                  <button key={p} type="button" onClick={() => copy(p)}
                    className={`text-xs px-2 py-1 rounded-lg border transition-all ${copied === p ? 'bg-green-100 border-green-300 text-green-700' : 'bg-white border-gray-200 text-gray-600 hover:border-orange-300 hover:text-orange-600'}`}>
                    {copied === p ? t('crm.sys.copied', 'kopiert!') : p}
                  </button>
                ))}
              </div>
            </div>

            {tab === 'email' && hasEmail && (
              <>
                <div>
                  <label className={labelCls}>{t('crm.sys.subject', 'Betreff')} *</label>
                  <input className={inputCls} value={subject} onChange={e => setSubject(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>{t('crm.sys.body', 'Text (einfache Version)')}</label>
                  <textarea rows={5} className={`${inputCls} resize-y`} value={body} onChange={e => setBody(e.target.value)} />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className={labelCls + ' mb-0'}>{t('crm.sys.html', 'HTML-Layout (wird beim Versand bevorzugt)')}</span>
                    <button type="button" onClick={() => setPreview(p => !p)}
                      className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600">
                      {preview ? t('crm.sys.previewClose', '✕ Vorschau') : t('crm.sys.preview', '👁 Vorschau')}
                    </button>
                  </div>
                  <textarea rows={9} className={`${inputCls} text-xs font-mono resize-y`} value={html} onChange={e => setHtml(e.target.value)} />
                  {preview && html && (
                    <div className="border border-gray-200 rounded-xl overflow-hidden mt-2">
                      <iframe srcDoc={fillSysPreview(html)} title={t('stageMessages.previewTitle', 'Vorschau')} className="w-full" style={{ height: 360, border: 'none' }} sandbox="allow-same-origin" />
                    </div>
                  )}
                </div>
              </>
            )}

            {tab === 'whatsapp' && hasWa && (
              <div>
                <label className={labelCls}>{t('crm.sys.waText', 'WhatsApp-Text')} *</label>
                <textarea rows={7} className={`${inputCls} resize-y`} value={waText} onChange={e => setWaText(e.target.value)} />
                <div className="mt-3"><WaImageField value={waImage} onChange={setWaImage} /></div>
              </div>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
          <button onClick={handleSave} disabled={saving || loading}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
            {saving ? t('common.saving', 'Speichert…') : t('common.save', 'Speichern')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Termin-Bot: editierbare Eröffnungs-/Nudge-Texte (booking_bot_messages) ──────
// Der Bot schlägt automatisch 2 freie Termine vor (2 Tage, vormittags + nachmittags);
// hier bearbeitet Sven nur die Einleitungstexte je Stufe. Ein/Aus unter KI-Agent.
interface BotMsg { key: string; label: string; delay_label: string | null; intro: string; sort: number }
function BotMessagesCard({ stage, onToast }: { stage: string; onToast: (m: string) => void }) {
  const { t } = useTranslation()
  const [rows, setRows]       = useState<BotMsg[]>([])
  const [editKey, setEditKey] = useState<string | null>(null)
  const [draft, setDraft]     = useState('')
  const [saving, setSaving]   = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase.from('booking_bot_messages').select('key, label, delay_label, intro, sort').order('sort')
    setRows((data ?? []) as BotMsg[])
  }, [])
  useEffect(() => { void load() }, [load])

  const save = async (key: string) => {
    setSaving(true)
    const { error } = await supabase.from('booking_bot_messages').update({ intro: draft.trim(), updated_at: new Date().toISOString() }).eq('key', key)
    setSaving(false)
    if (error) { onToast('❌ ' + error.message); return }
    setEditKey(null); await load(); onToast(t('crm.botMsg.saved', '✅ Bot-Text gespeichert'))
  }

  // Nur die Bot-Texte der aktuellen Phase (No-Show: 6 Stufen · Erstkontakt: 1).
  const shown = rows.filter(r =>
    stage === 'no_show'          ? r.key.startsWith('no_show_') :
    stage === 'erstkontakt'      ? r.key.startsWith('erstkontakt') :
    stage === 'immobilienauswahl' ? (r.key.startsWith('immobilienauswahl_') || r.key === 'deck_viewed_0') : false)
  if (!shown.length) return null
  // Die WhatsApps (Bot) in EINEM Kästchen unter den Mails — mit 🤝-Überschrift.
  return (
    <div className="bg-[#fff9f7] rounded-2xl border border-[#ff795d]/30 shadow-sm p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-lg">🤝</span>
        <span className="font-semibold text-gray-900 text-sm">{t('crm.botMsg.title', 'Termin-Bot · WhatsApp')}</span>
        <span className="text-[11px] text-gray-500">{t('crm.botMsg.hint', 'schlägt automatisch 2 Termine vor (2 Tage · vormittags + nachmittags)')}</span>
      </div>
      <div className="space-y-2">
        {shown.map(r => (
          <div key={r.key} className="bg-white rounded-xl border border-gray-100 p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-gray-800">{r.label}</span>
                {r.delay_label && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-mono">{r.delay_label}</span>}
              </div>
              {editKey !== r.key && (
                <button onClick={() => { setEditKey(r.key); setDraft(r.intro) }}
                  className="text-xs text-gray-500 hover:text-gray-800 font-medium shrink-0">{t('common.edit', 'Bearbeiten')}</button>
              )}
            </div>
            {editKey === r.key ? (
              <div className="mt-2">
                <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={4}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff795d]/40 resize-y" />
                <div className="flex justify-end gap-2 mt-2">
                  <button onClick={() => setEditKey(null)} className="px-3 py-1.5 text-xs text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
                  <button onClick={() => void save(r.key)} disabled={saving || !draft.trim()}
                    className="px-4 py-1.5 text-xs font-medium text-white rounded-lg disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
                    {t('common.save', 'Speichern')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-500 mt-1.5 whitespace-pre-wrap line-clamp-2">{r.intro}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Termin-Bot Ein/Aus — Schalter direkt bei den Nachrichten (auch in KI-Agent) ──
function BotToggle({ onToast }: { onToast: (m: string) => void }) {
  const { t } = useTranslation()
  const [on, setOn]         = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { void (async () => {
    const { data } = await supabase.from('crm_settings').select('value').eq('key', 'booking_bot_enabled').maybeSingle()
    setOn((data as { value?: string } | null)?.value === 'true'); setLoaded(true)
  })() }, [])
  const toggle = async () => {
    const next = !on
    if (next && !window.confirm(t('crm.botToggle.confirm', 'Der Termin-Bot schreibt ab jetzt AUTOMATISCH mit echten Kunden per WhatsApp (No-Show, Erstkontakt, Deck-Ansicht, Immobilienauswahl) und bucht Termine in deinen Kalender. Jetzt scharfschalten?'))) return
    setOn(next)
    const { error } = await supabase.from('crm_settings').upsert({ key: 'booking_bot_enabled', value: next ? 'true' : 'false', updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (error) { setOn(!next); onToast('❌ ' + error.message); return }
    onToast(next ? t('crm.botToggle.on', '✅ Termin-Bot ist scharf') : t('crm.botToggle.off', 'Termin-Bot aus'))
  }
  if (!loaded) return null
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-5 py-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <span className="block font-semibold text-gray-900 text-sm">🤝 {t('crm.botToggle.title', 'Termin-Bot (WhatsApp)')}</span>
        <span className="block text-xs text-gray-500">{t('crm.botToggle.desc', 'Schlägt bei No-Show, Erstkontakt, Deck-Ansicht & Immobilienauswahl automatisch Termine vor und bucht sie. Betrifft die 🤝-Phasen unten.')}</span>
      </div>
      <button onClick={() => void toggle()} aria-label="Bot ein/aus"
        className={`relative w-12 h-6 rounded-full transition-colors shrink-0 ${on ? 'bg-green-500' : 'bg-gray-300'}`}>
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-6' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}

export default function StageMessages() {
  const { t } = useTranslation()

  const [rules,     setRules]     = useState<AutomationRule[]>([])
  const [emailTpls, setEmailTpls] = useState<EmailTemplate[]>([])
  const [waTpls,    setWaTpls]    = useState<WaTpl[]>([])
  const [loading,   setLoading]   = useState(true)
  const [selected,  setSelected]  = useState<string>('lead_created')
  const [editing,   setEditing]   = useState<{ rule: AutomationRule | null } | null>(null)
  const [editingSystem, setEditingSystem] = useState<SystemEvent | null>(null)
  const [pipelineOpen,  setPipelineOpen]  = useState(false)
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
        supabase.from('whatsapp_templates').select('id, event_type, name, message_template, image_url, active'),
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
            {t('crm.stageEditor.title', 'Nachrichten')}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('crm.stageEditor.subtitle2', 'Pipeline-Nachrichten je Lead-Phase und weitere System-Nachrichten — Texte und Vorlagen hier bearbeiten.')}
          </p>
        </div>

        {/* Termin-Bot Ein/Aus */}
        <BotToggle onToast={showToast} />

        {/* ── Pipeline (aufklappbar) ── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <button onClick={() => setPipelineOpen(o => !o)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors">
            <span className="flex items-center gap-2.5">
              <span className="text-lg">📊</span>
              <span className="text-left">
                <span className="block font-semibold text-gray-900">{t('crm.stageEditor.pipelineTitle', 'Pipeline')}</span>
                <span className="block text-xs text-gray-500">{t('crm.stageEditor.pipelineDesc', 'Nachrichten je Lead-Phase (WhatsApp / E-Mail)')}</span>
              </span>
            </span>
            <span className="text-gray-400 text-sm">{pipelineOpen ? '▲' : '▼'}</span>
          </button>

          {pipelineOpen && (
          <div className="border-t border-gray-100 px-5 pb-5 pt-4 space-y-4">
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
                    {BOT_STAGES.has(stage) && (
                      <span title={t('crm.botMsg.stageBadge', 'Termin-Bot aktiv in dieser Phase')}
                        className={`text-xs px-1.5 py-0.5 rounded-full ${isSel ? 'bg-white/25 text-white' : 'bg-[#ff795d]/10 text-[#ff795d]'}`}>
                        🤝
                      </span>
                    )}
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

              {/* Termin-Bot (WhatsApp) — für die Phasen No-Show / Erstkontakt Teil der Pipeline */}
              <BotMessagesCard stage={selected} onToast={showToast} />
            </div>
          </div>
        )}
          </div>
          )}
        </div>

        {/* ── Weitere Nachrichten (feste Liste) ── */}
        <div className="space-y-2">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{t('crm.stageEditor.otherTitle', 'Weitere Nachrichten')}</h2>
            <p className="text-xs text-gray-500">{t('crm.stageEditor.otherDesc', 'System-Nachrichten außerhalb der Pipeline — reinklicken zum Bearbeiten.')}</p>
          </div>
          {SYSTEM_EVENTS.map(ev => (
            <div key={ev.key} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <div className="flex items-start gap-3">
                <span className="shrink-0 text-lg mt-0.5">{ev.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900 text-sm">{t(`stageMessages.eventLabel_${ev.key}`, ev.label)}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">{t('crm.stageEditor.active2', 'Aktiv')}</span>
                    {ev.emailTemplateId && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{t('stageMessages.badgeMail', '📧 Mail')}</span>}
                    {ev.whatsappEventType && <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700">{t('stageMessages.badgeWhatsapp', '📱 WhatsApp')}</span>}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{t(`stageMessages.eventDesc_${ev.key}`, ev.desc)}</p>
                </div>
                <button onClick={() => setEditingSystem(ev)}
                  className="text-sm text-gray-500 hover:text-gray-800 font-medium shrink-0">
                  {t('common.edit', 'Bearbeiten')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {editingSystem && (
        <SystemMessageModal
          event={editingSystem}
          onClose={() => setEditingSystem(null)}
          onSaved={(m) => { setEditingSystem(null); showToast(m) }}
        />
      )}

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
