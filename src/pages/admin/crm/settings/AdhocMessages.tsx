import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'
import type { CrmAdhocMessage, AdhocChannel, AdhocStatus } from '../../../../lib/crmTypes'

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
      const payload = {
        label:         label.trim(),
        channel,
        email_subject: isEmail ? (emailSubject.trim() || null) : null,
        email_body:    isEmail ? (emailBody.trim() || null)    : null,
        email_html:    isEmail ? (emailHtml.trim() || null)    : null,
        whatsapp_text: !isEmail ? (waText.trim() || null)      : null,
        scheduled_at:  fromLocalInput(scheduledAt),
        status,
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
              <select className={inputCls} value={channel} onChange={e => setChannel(e.target.value as AdhocChannel)}>
                <option value="whatsapp">{t('crm.adhoc.chWhatsapp', '📱 WhatsApp')}</option>
                <option value="email">{t('crm.adhoc.chEmail', '📧 E-Mail')}</option>
              </select>
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
                        <iframe srcDoc={emailHtml} title="HTML Preview"
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
            <select className={inputCls} value={status} onChange={e => setStatus(e.target.value as AdhocStatus)}>
              <option value="draft">{t('crm.adhoc.stDraft', '📝 Entwurf')}</option>
              <option value="scheduled">{t('crm.adhoc.stScheduled', '⏳ Geplant (geht raus, sobald Versand live ist)')}</option>
              <option value="cancelled">{t('crm.adhoc.stCancelled', '🚫 Abgebrochen')}</option>
            </select>
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
export default function AdhocMessages() {
  const { t, i18n } = useTranslation()

  const [items,   setItems]   = useState<CrmAdhocMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ msg: CrmAdhocMessage | null } | null>(null)
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
    </DashboardLayout>
  )
}
