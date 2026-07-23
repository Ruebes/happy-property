import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'
import type { CrmAdhocMessage, AdhocChannel, AdhocStatus } from '../../../../lib/crmTypes'
import RecipientPicker from '../../../../components/crm/RecipientPicker'
import { CustomSelect } from '../../../../components/CustomSelect'

// ── Sonstige / Ad-hoc Nachrichten ──────────────────────────────────────────────
// Einmalige WhatsApp/E-Mail-Nachrichten, NICHT an eine Pipeline-Phase gebunden.
// Reine Definition (Zweck + Inhalt + gewünschter Sendezeitpunkt). Bleibt inert,
// bis der Versand separat scharfgeschaltet wird – nichts hieraus sendet von selbst.

const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white'
const labelCls = 'block text-xs font-medium text-gray-500 mb-1'

// ── datetime-local ⇄ ISO ──────────────────────────────────────────────────────
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}
function fromLocalInput(val: string): string | null {
  if (!val) return null
  const d = new Date(val)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

const STATUS_STYLE: Record<AdhocStatus, string> = {
  draft:     'bg-gray-100 text-gray-600',
  scheduled: 'bg-blue-50 text-blue-700',
  sent:      'bg-green-100 text-green-700',
  cancelled: 'bg-red-50 text-red-600',
}

// ── Modal ──────────────────────────────────────────────────────────────────────
interface AdhocModalProps {
  msg:     CrmAdhocMessage | null   // null = neue Nachricht
  onClose: () => void
  onSaved: (m: string) => void
}

function AdhocModal({ msg, onClose, onSaved }: AdhocModalProps) {
  const { t } = useTranslation()

  const [label,        setLabel]        = useState(msg?.label ?? '')
  const [channel,      setChannel]      = useState<AdhocChannel>(msg?.channel ?? 'whatsapp')
  const [recipient,    setRecipient]    = useState(msg?.recipient ?? 'client')
  const [waText,       setWaText]       = useState(msg?.whatsapp_text ?? '')
  const [emailSubject, setEmailSubject] = useState(msg?.email_subject ?? '')
  const [emailBody,    setEmailBody]    = useState(msg?.email_body ?? '')
  const [emailHtml,    setEmailHtml]    = useState(msg?.email_html ?? '')
  const [showHtml,     setShowHtml]     = useState<boolean>(!!msg?.email_html)
  const [showPreview,  setShowPreview]  = useState(false)
  const [scheduledAt,  setScheduledAt]  = useState(toLocalInput(msg?.scheduled_at ?? null))
  const [status,       setStatus]       = useState<AdhocStatus>(msg?.status ?? 'draft')
  const [saving,       setSaving]       = useState(false)
  const [error,        setError]        = useState('')

  const isEmail = channel === 'email'

  const handleSave = async () => {
    if (!label.trim()) {
      setError(t('crm.adhoc.errLabel', 'Bezeichnung ist Pflicht')); return
    }
    if (isEmail && (!emailSubject.trim() || (!emailBody.trim() && !emailHtml.trim()))) {
      setError(t('crm.adhoc.errEmail', 'Betreff und Text (oder HTML) der E-Mail sind Pflicht')); return
    }
    if (!isEmail && !waText.trim()) {
      setError(t('crm.adhoc.errWa', 'WhatsApp-Text ist Pflicht')); return
    }
    setSaving(true); setError('')
    try {
      const safeRecipient = (recipient === 'client' || recipient.startsWith('bc:') || recipient.startsWith('dc:'))
        ? recipient : 'client'
      const payload = {
        label:         label.trim(),
        channel,
        email_subject: isEmail ? (emailSubject.trim() || null) : null,
        email_body:    isEmail ? (emailBody.trim() || null)    : null,
        email_html:    isEmail ? (emailHtml.trim() || null)    : null,
        whatsapp_text: !isEmail ? (waText.trim() || null)      : null,
        scheduled_at:  fromLocalInput(scheduledAt),
        status,
        recipient:     safeRecipient,
        updated_at:    new Date().toISOString(),
      }
      if (msg) {
        const { error: e } = await supabase.from('crm_adhoc_messages').update(payload).eq('id', msg.id)
        if (e) throw e
      } else {
        const { error: e } = await supabase.from('crm_adhoc_messages').insert(payload)
        if (e) throw e
      }
      onSaved(msg
        ? t('crm.adhoc.savedEdit', '✅ Nachricht gespeichert')
        : t('crm.adhoc.savedNew',  '✅ Nachricht angelegt'))
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
            {msg
              ? t('crm.adhoc.editTitle', 'Nachricht bearbeiten')
              : t('crm.adhoc.newTitle',  'Neue Nachricht')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {/* Bezeichnung / Zweck */}
          <div>
            <label className={labelCls}>{t('crm.adhoc.label', 'Bezeichnung / Zweck')} *</label>
            <input className={inputCls} value={label} onChange={e => setLabel(e.target.value)}
              placeholder={t('crm.adhoc.labelPh', 'z.B. Newsletter Juni / Einladung Webinar')} />
          </div>

          {/* Kanal + Sendezeitpunkt */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('crm.adhoc.channel', 'Kanal')}</label>
              <CustomSelect
                className="w-full"
                value={channel}
                onChange={(v) => setChannel(v as AdhocChannel)}
                options={[
                  { value: 'whatsapp', label: t('crm.adhoc.chWhatsapp', '📱 WhatsApp') },
                  { value: 'email', label: t('crm.adhoc.chEmail', '📧 E-Mail') },
                ]}
              />
            </div>
            <div>
              <label className={labelCls}>{t('crm.adhoc.scheduledAt', 'Sendezeitpunkt')}</label>
              <input type="datetime-local" className={inputCls}
                value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} />
              <p className="text-xs text-gray-400 mt-1">
                {t('crm.adhoc.scheduledHint', 'Leer lassen = noch offen')}
              </p>
            </div>
          </div>

          {/* Empfänger */}
          <div>
            <label className={labelCls}>{t('crm.recipient.label', 'Empfänger')}</label>
            <RecipientPicker value={recipient} onChange={setRecipient} channel={channel} />
          </div>

          {/* WhatsApp-Text */}
          {!isEmail && (
            <div>
              <label className={labelCls}>{t('crm.adhoc.waText', 'WhatsApp-Text')} *</label>
              <textarea rows={6} className={`${inputCls} resize-y`}
                value={waText} onChange={e => setWaText(e.target.value)}
                placeholder={t('crm.adhoc.waPh', 'Inhalt der WhatsApp-Nachricht …')} />
            </div>
          )}

          {/* E-Mail */}
          {isEmail && (
            <div className="space-y-3 border-t border-gray-100 pt-4">
              <div>
                <label className={labelCls}>{t('crm.adhoc.emailSubject', 'E-Mail Betreff')} *</label>
                <input className={inputCls} value={emailSubject} onChange={e => setEmailSubject(e.target.value)}
                  placeholder={t('crm.adhoc.subjectPh', 'z.B. Neuigkeiten von Happy Property')} />
              </div>
              <div>
                <label className={labelCls}>{t('crm.adhoc.emailBody', 'E-Mail Text')}</label>
                <textarea rows={6} className={`${inputCls} resize-y`}
                  value={emailBody} onChange={e => setEmailBody(e.target.value)}
                  placeholder={t('crm.adhoc.bodyPh', 'Reiner Text – wird genutzt, wenn kein HTML hinterlegt ist.')} />
              </div>

              {/* HTML optional */}
              <div>
                <button type="button" onClick={() => setShowHtml(v => !v)}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-700">
                  {showHtml ? '− ' : '+ '}{t('crm.adhoc.htmlToggle', 'HTML-Layout (optional)')}
                  {emailHtml && !showHtml && <span className="ml-1 text-indigo-400">●</span>}
                </button>
                {showHtml && (
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-gray-500">
                        {t('crm.adhoc.htmlHint', 'HTML überschreibt den reinen Text beim Versand.')}
                      </p>
                      <button type="button" onClick={() => setShowPreview(p => !p)}
                        className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600">
                        {showPreview
                          ? t('crm.adhoc.previewClose', '✕ Vorschau')
                          : t('crm.adhoc.preview', '👁 Vorschau')}
                      </button>
                    </div>
                    <textarea rows={8} className={`${inputCls} text-xs font-mono resize-y`}
                      value={emailHtml} onChange={e => setEmailHtml(e.target.value)}
                      placeholder={'<!DOCTYPE html>\n<html><body>\n  <p>Hallo,</p>\n</body></html>'} />
                    {showPreview && emailHtml && (
                      <div className="border border-gray-200 rounded-xl overflow-hidden">
                        <iframe srcDoc={emailHtml} title={t('adhocMessages.htmlPreviewTitle', 'HTML Preview')}
                          className="w-full" style={{ height: 320, border: 'none' }}
                          sandbox="allow-same-origin" />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Status */}
          <div className="border-t border-gray-100 pt-4">
            <label className={labelCls}>{t('crm.adhoc.status', 'Status')}</label>
            <CustomSelect
              className="w-full"
              value={status}
              onChange={(v) => setStatus(v as AdhocStatus)}
              options={[
                { value: 'draft', label: t('crm.adhoc.stDraft', '📝 Entwurf') },
                { value: 'scheduled', label: t('crm.adhoc.stScheduled', '⏳ Geplant (geht raus, sobald Versand live ist)') },
                { value: 'cancelled', label: t('crm.adhoc.stCancelled', '🚫 Abgebrochen') },
              ]}
            />
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

// ── System-Nachrichten (automatisch, an reale Sende-Vorgänge gebunden) ──────────
// Anders als die Ad-hoc-Nachrichten unten: diese werden bei bestimmten Ereignissen
// automatisch verschickt. Jeder Eintrag bearbeitet die WIRKLICH verwendete Vorlage
// (email_templates), nach dem Vorbild der „Nachrichten je Stage".
interface SystemEvent {
  key:          string
  icon:         string
  templateId:   string
  label:        string
  desc:         string
  placeholders: string[]
  note?:        string
}
const SYSTEM_EVENTS: SystemEvent[] = [
  {
    key:        'portal_access',
    icon:       '🔑',
    templateId: '37b1724c-f71c-4e8b-9116-b92d18f03915',
    label:      'Portal-Aktivierung (Zugangsdaten)',
    desc:       'Geht automatisch an neue Nutzer/Eigentümer (Login + Passwort) — bei Konto-Anlage und „Portal-Zugang senden“.',
    placeholders: ['{{vorname}}', '{{email}}', '{{password}}', '{{login_url}}'],
    note:       '{{password}} und {{login_url}} bitte drin lassen — sonst sendet das System automatisch die fest eingebaute Sicherheits-Mail.',
  },
]

// Platzhalter für die Vorschau mit Beispielwerten füllen
const fillPreview = (h: string): string => h
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
  const [subject, setSubject] = useState('')
  const [body,    setBody]    = useState('')
  const [html,    setHtml]    = useState('')
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [preview, setPreview] = useState(false)
  const [copied,  setCopied]  = useState<string | null>(null)
  const [error,   setError]   = useState('')

  useEffect(() => {
    let active = true
    void supabase.from('email_templates').select('subject, body, html_body').eq('id', event.templateId).maybeSingle()
      .then(({ data }) => {
        if (!active) return
        const tpl = data as { subject?: string; body?: string | null; html_body?: string | null } | null
        setSubject(tpl?.subject ?? '')
        setBody(tpl?.body ?? '')
        setHtml(tpl?.html_body ?? '')
        setLoading(false)
      })
    return () => { active = false }
  }, [event.templateId])

  const copy = (k: string) => { navigator.clipboard.writeText(k).catch(() => {}); setCopied(k); setTimeout(() => setCopied(null), 1500) }

  const handleSave = async () => {
    if (!subject.trim()) { setError(t('crm.adhoc.sysErrSubject', 'Betreff ist Pflicht')); return }
    setSaving(true); setError('')
    try {
      const { error: e } = await supabase.from('email_templates')
        .update({ subject: subject.trim(), body: body.trim() || null, html_body: html.trim() || null })
        .eq('id', event.templateId)
      if (e) throw e
      onSaved(t('crm.adhoc.sysSaved', '✅ System-Nachricht gespeichert'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-6 flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">{event.icon} {t(`adhocMessages.sysEvent.${event.key}.label`, event.label)}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
            <p className="text-xs text-gray-500">{t(`adhocMessages.sysEvent.${event.key}.desc`, event.desc)}</p>
            {event.note && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800">⚠️ {t(`adhocMessages.sysEvent.${event.key}.note`, event.note)}</div>
            )}

            <div>
              <label className={labelCls}>{t('crm.adhoc.emailSubject', 'Betreff')} *</label>
              <input className={inputCls} value={subject} onChange={e => setSubject(e.target.value)} />
            </div>

            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-500 mb-2">{t('crm.adhoc.placeholders', 'Platzhalter (klicken zum Kopieren)')}</p>
              <div className="flex flex-wrap gap-1.5">
                {event.placeholders.map(p => (
                  <button key={p} type="button" onClick={() => copy(p)}
                    className={`text-xs px-2 py-1 rounded-lg border transition-all ${copied === p ? 'bg-green-100 border-green-300 text-green-700' : 'bg-white border-gray-200 text-gray-600 hover:border-orange-300 hover:text-orange-600'}`}>
                    {copied === p ? t('crm.adhoc.copied', 'kopiert!') : p}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className={labelCls}>{t('crm.adhoc.emailBody', 'Text (einfache Version)')}</label>
              <textarea rows={5} className={`${inputCls} resize-y`} value={body} onChange={e => setBody(e.target.value)} />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className={labelCls + ' mb-0'}>{t('crm.adhoc.htmlLayout', 'HTML-Layout (wird beim Versand bevorzugt)')}</span>
                <button type="button" onClick={() => setPreview(p => !p)}
                  className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600">
                  {preview ? t('crm.adhoc.previewClose', '✕ Vorschau') : t('crm.adhoc.preview', '👁 Vorschau')}
                </button>
              </div>
              <textarea rows={9} className={`${inputCls} text-xs font-mono resize-y`} value={html} onChange={e => setHtml(e.target.value)} />
              {preview && html && (
                <div className="border border-gray-200 rounded-xl overflow-hidden mt-2">
                  <iframe srcDoc={fillPreview(html)} title={t('adhocMessages.previewIframeTitle', 'Vorschau')} className="w-full" style={{ height: 360, border: 'none' }} sandbox="allow-same-origin" />
                </div>
              )}
            </div>

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

// ── Hauptseite ──────────────────────────────────────────────────────────────────
export default function AdhocMessages() {
  const { t, i18n } = useTranslation()

  const [items,   setItems]   = useState<CrmAdhocMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ msg: CrmAdhocMessage | null } | null>(null)
  const [editingSystem, setEditingSystem] = useState<SystemEvent | null>(null)
  const [toast,   setToast]   = useState('')

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('crm_adhoc_messages')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      setItems((data ?? []) as CrmAdhocMessage[])
    } catch (err) {
      console.error('[AdhocMessages] fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const deleteItem = async (msg: CrmAdhocMessage) => {
    if (!window.confirm(t('crm.adhoc.deleteConfirm', 'Diese Nachricht löschen?'))) return
    const { error } = await supabase.from('crm_adhoc_messages').delete().eq('id', msg.id)
    if (error) { showToast(`❌ ${error.message}`); return }
    showToast(t('crm.adhoc.deleted', 'Nachricht gelöscht'))
    fetchAll()
  }

  const fmtDate = (iso: string | null): string => {
    if (!iso) return t('crm.adhoc.noDate', 'Kein Termin')
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    return d.toLocaleString(i18n.language === 'en' ? 'en-GB' : 'de-DE',
      { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const statusLabel = (s: AdhocStatus): string => ({
    draft:     t('crm.adhoc.stDraftShort', 'Entwurf'),
    scheduled: t('crm.adhoc.stScheduledShort', 'Geplant'),
    sent:      t('crm.adhoc.stSentShort', 'Gesendet'),
    cancelled: t('crm.adhoc.stCancelledShort', 'Abgebrochen'),
  })[s]

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">
          {toast}
        </div>
      )}

      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {t('crm.adhoc.title', 'Sonstige Nachrichten')}
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {t('crm.adhoc.subtitle', 'Einmalige WhatsApp- oder E-Mail-Nachrichten, unabhängig von der Pipeline.')}
            </p>
          </div>
          <button onClick={() => setEditing({ msg: null })}
            className="px-3 py-1.5 rounded-xl text-white text-sm font-medium whitespace-nowrap"
            style={{ backgroundColor: '#ff795d' }}>
            {t('crm.adhoc.add', '+ Nachricht')}
          </button>
        </div>

        {/* System-Nachrichten (automatisch) — wie die Pipeline-Messages, aber für System-Events */}
        <div className="space-y-2">
          <div>
            <h2 className="text-sm font-bold text-gray-800">{t('crm.adhoc.systemTitle', 'System-Nachrichten (automatisch)')}</h2>
            <p className="text-xs text-gray-500">{t('crm.adhoc.systemSubtitle', 'Werden bei bestimmten Ereignissen automatisch verschickt — hier Betreff und Text bearbeiten.')}</p>
          </div>
          {SYSTEM_EVENTS.map(ev => (
            <div key={ev.key} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <div className="flex items-start gap-3">
                <span className="shrink-0 text-lg mt-0.5">{ev.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900 text-sm">{t(`adhocMessages.sysEvent.${ev.key}.label`, ev.label)}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">{t('crm.adhoc.active', 'Aktiv')}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{t(`adhocMessages.sysEvent.${ev.key}.desc`, ev.desc)}</p>
                </div>
                <button onClick={() => setEditingSystem(ev)}
                  className="text-sm text-gray-500 hover:text-gray-800 font-medium shrink-0">
                  {t('common.edit', 'Bearbeiten')}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Einmalige Nachrichten */}
        <h2 className="text-sm font-bold text-gray-800 pt-1">{t('crm.adhoc.oneoffTitle', 'Einmalige Nachrichten')}</h2>

        {/* Safety-Hinweis */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          {t('crm.adhoc.safetyNote', 'Diese Nachrichten werden nur gespeichert. Solange der Versand nicht scharfgeschaltet ist, wird nichts verschickt.')}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-12 bg-white rounded-2xl border border-dashed border-gray-200">
            {t('crm.adhoc.empty', 'Noch keine sonstigen Nachrichten angelegt.')}
          </p>
        ) : (
          <div className="space-y-2">
            {items.map(msg => {
              const preview = msg.channel === 'email'
                ? (msg.email_subject || msg.email_body || msg.email_html || '—')
                : (msg.whatsapp_text || '—')
              return (
                <div key={msg.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
                  <div className="flex items-start gap-3">
                    <span className="shrink-0 text-lg mt-0.5">
                      {msg.channel === 'email' ? '📧' : '📱'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-gray-900 text-sm">{msg.label}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[msg.status]}`}>
                          {statusLabel(msg.status)}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-mono">
                          {fmtDate(msg.scheduled_at)}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-1 line-clamp-1">{preview}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => setEditing({ msg })}
                        className="text-sm text-gray-500 hover:text-gray-800 font-medium">
                        {t('common.edit', 'Bearbeiten')}
                      </button>
                      <button onClick={() => deleteItem(msg)}
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

      {editing && (
        <AdhocModal
          msg={editing.msg}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); showToast(m); fetchAll() }}
        />
      )}

      {editingSystem && (
        <SystemMessageModal
          event={editingSystem}
          onClose={() => setEditingSystem(null)}
          onSaved={(m) => { setEditingSystem(null); showToast(m) }}
        />
      )}
    </DashboardLayout>
  )
}
