import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'
import { WA_FIELDS, WA_SAMPLE_DATA, substituteTemplate } from '../../../../lib/whatsapp'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Recipient {
  name:  string
  phone: string
}

interface WaTemplate {
  id:               string
  name:             string
  event_type:       string
  recipients:       Recipient[]
  message_template: string
  included_fields:  string[]
  active:           boolean
  created_at:       string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EVENT_BADGE: Record<string, string> = {
  registration: 'bg-blue-100 text-blue-700',
  no_show:      'bg-red-100 text-red-700',
  commission:   'bg-green-100 text-green-700',
  booking:      'bg-purple-100 text-purple-700',
}

const EVENT_LABEL: Record<string, string> = {
  registration: 'Registrierung',
  no_show:      'No Show',
  commission:   'Provision',
  booking:      'Buchung',
}

// ── Edit Modal ────────────────────────────────────────────────────────────────

interface EditModalProps {
  template: WaTemplate
  onClose:  () => void
  onSaved:  () => void
}

function EditModal({ template, onClose, onSaved }: EditModalProps) {
  const { t } = useTranslation()
  const [saving, setSaving]                   = useState(false)
  const [testPhone, setTestPhone]             = useState('')
  const [testSending, setTestSending]         = useState(false)
  const [testResult, setTestResult]           = useState<string | null>(null)
  const [toast, setToast]                     = useState('')
  const textareaRef                           = useRef<HTMLTextAreaElement>(null)

  // Form state
  const [name, setName]                       = useState(template.name)
  const [active, setActive]                   = useState(template.active)
  const [recipients, setRecipients]           = useState<Recipient[]>(template.recipients)
  const [includedFields, setIncludedFields]   = useState<string[]>(template.included_fields)
  const [msgTemplate, setMsgTemplate]         = useState(template.message_template)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  // ── Recipients ─────────────────────────────────────────────────
  const addRecipient = () =>
    setRecipients(prev => [...prev, { name: '', phone: '' }])

  const updateRecipient = (i: number, field: keyof Recipient, val: string) =>
    setRecipients(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r))

  const removeRecipient = (i: number) =>
    setRecipients(prev => prev.filter((_, idx) => idx !== i))

  // ── Included fields ────────────────────────────────────────────
  const toggleField = (key: string) =>
    setIncludedFields(prev =>
      prev.includes(key) ? prev.filter(f => f !== key) : [...prev, key]
    )

  // ── Insert placeholder at cursor ───────────────────────────────
  const insertPlaceholder = (key: string) => {
    const el = textareaRef.current
    if (!el) {
      setMsgTemplate(prev => prev + `{{${key}}}`)
      return
    }
    const start = el.selectionStart
    const end   = el.selectionEnd
    const insert = `{{${key}}}`
    const newVal = msgTemplate.slice(0, start) + insert + msgTemplate.slice(end)
    setMsgTemplate(newVal)
    // Restore cursor after inserted text
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + insert.length
      el.focus()
    })
  }

  // ── Live preview ───────────────────────────────────────────────
  const preview = substituteTemplate(msgTemplate, WA_SAMPLE_DATA)

  // ── Save ───────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!name.trim() || !msgTemplate.trim()) return
    setSaving(true)
    try {
      const { error } = await supabase
        .from('whatsapp_templates')
        .update({
          name:             name.trim(),
          active,
          recipients:       recipients.filter(r => r.phone.trim()),
          included_fields:  includedFields,
          message_template: msgTemplate.trim(),
          updated_at:       new Date().toISOString(),
        })
        .eq('id', template.id)
      if (error) throw error
      onSaved()
      onClose()
    } catch (err) {
      console.error('[WaTemplates] save:', err)
      showToast('❌ Fehler beim Speichern')
    } finally {
      setSaving(false)
    }
  }

  // ── Test send ──────────────────────────────────────────────────
  // Sendet die aktuell angezeigte (substituierte) Nachricht direkt
  // an die eingetragene Testnummer – override_text überschreibt das Template,
  // lead_whatsapp/lead_phone steuern den Empfänger.
  const handleTestSend = async () => {
    if (!testPhone.trim()) return
    setTestSending(true)
    setTestResult(null)
    try {
      const finalMsg = substituteTemplate(msgTemplate, WA_SAMPLE_DATA)

      const { data, error } = await supabase.functions.invoke('send-whatsapp', {
        body: {
          event_type:    template.event_type,
          lead_data:     {
            ...WA_SAMPLE_DATA,
            // Testnummer als Empfänger verwenden
            lead_phone:    testPhone.trim(),
            lead_whatsapp: testPhone.trim(),
          },
          extra_data:    {},
          override_text: finalMsg,
        },
      })

      console.log('[WaTemplates] testSend data:', data, 'error:', error)

      if (error) throw new Error(error.message ?? String(error))

      const result = data as { success?: boolean; error?: string; results?: { ok: boolean; data: unknown }[] }

      if (!result?.success) {
        const detail = result?.error ?? result?.results?.map(r => JSON.stringify(r.data)).join(', ') ?? 'Unbekannter Fehler'
        setTestResult(`❌ ${detail}`)
        showToast(`❌ ${detail}`)
        return
      }

      setTestResult('✅ Test gesendet')
      showToast('📱 Test WhatsApp gesendet')
    } catch (err) {
      console.error('[WaTemplates] testSend Fehler:', err)
      const msg = err instanceof Error ? err.message : String(err)
      setTestResult(`❌ ${msg}`)
    } finally {
      setTestSending(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{name || template.name}</h2>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${EVENT_BADGE[template.event_type] ?? 'bg-gray-100 text-gray-600'}`}>
              {EVENT_LABEL[template.event_type] ?? template.event_type}
            </span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Toast */}
        {toast && (
          <div className="mx-6 mt-3 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm text-center flex-shrink-0">
            {toast}
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* ── 1. Grunddaten ────────────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
              {t('crm.wa.basicData', 'Grunddaten')}
            </h3>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('crm.wa.templateName', 'Name')} *
              </label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <button
                  onClick={() => setActive(v => !v)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${active ? 'bg-green-500' : 'bg-gray-200'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${active ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
                <span className="text-sm text-gray-700">
                  {active ? t('crm.wa.active', 'Aktiv') : t('crm.wa.inactive', 'Inaktiv')}
                </span>
              </label>
            </div>
          </section>

          {/* ── 2. Empfänger ─────────────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
              {t('crm.wa.recipients', 'Empfänger')}
            </h3>
            <p className="text-xs text-gray-400">
              {t('crm.wa.recipientsHint',
                'Leer = Nachricht geht direkt an den Lead (no_show, booking). Feste Empfänger für interne Events.')}
            </p>
            <div className="space-y-2">
              {recipients.map((r, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    value={r.name}
                    onChange={e => updateRecipient(i, 'name', e.target.value)}
                    placeholder={t('crm.wa.recipientName', 'Name')}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400"
                  />
                  <input
                    value={r.phone}
                    onChange={e => updateRecipient(i, 'phone', e.target.value)}
                    placeholder="+49151…"
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-400 font-mono"
                  />
                  <button
                    onClick={() => removeRecipient(i)}
                    className="text-red-400 hover:text-red-600 px-2 py-1.5 rounded-lg hover:bg-red-50 transition-colors"
                    title={t('common.delete', 'Löschen')}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={addRecipient}
              className="text-sm text-orange-600 hover:text-orange-700 font-medium flex items-center gap-1"
            >
              + {t('crm.wa.addRecipient', 'Empfänger hinzufügen')}
            </button>
          </section>

          {/* ── 3. Verfügbare Felder ──────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
              {t('crm.wa.availableFields', 'Verfügbare Felder')}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {WA_FIELDS.map(f => (
                <label key={f.key} className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={includedFields.includes(f.key)}
                    onChange={() => toggleField(f.key)}
                    className="rounded accent-orange-500"
                  />
                  <span className="text-xs text-gray-600">
                    <span className="font-mono text-gray-400 mr-1">{`{{${f.key}}}`}</span>
                    {f.label_de}
                  </span>
                </label>
              ))}
            </div>
          </section>

          {/* ── 4. Nachrichtenvorlage ─────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
              {t('crm.wa.messageTemplate', 'Nachrichtenvorlage')}
            </h3>

            <textarea
              ref={textareaRef}
              value={msgTemplate}
              onChange={e => setMsgTemplate(e.target.value)}
              rows={8}
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm
                         focus:outline-none focus:border-orange-400 resize-none font-mono leading-relaxed"
            />

            {/* Clickable placeholder chips */}
            {includedFields.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1.5">
                  {t('crm.wa.clickToInsert', 'Klicken zum Einfügen:')}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {includedFields.map(key => (
                    <button
                      key={key}
                      onClick={() => insertPlaceholder(key)}
                      className="text-xs font-mono bg-orange-50 text-orange-700 border border-orange-200
                                 px-2 py-0.5 rounded-md hover:bg-orange-100 transition-colors"
                    >
                      {`{{${key}}}`}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Live preview */}
            <div className="bg-green-50 border border-green-100 rounded-xl p-4">
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2">
                {t('crm.wa.preview', 'Vorschau')} (Beispieldaten)
              </p>
              <pre className="text-sm text-green-900 whitespace-pre-wrap font-sans leading-relaxed">
                {preview}
              </pre>
            </div>
          </section>

          {/* ── 5. Test senden ────────────────────────────────────── */}
          <section className="space-y-3 border-t border-gray-100 pt-5">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
              📱 {t('crm.wa.testSend', 'Test senden')}
            </h3>
            <p className="text-xs text-gray-400">
              {t('crm.wa.testHint', 'Sendet die Vorlage mit Beispieldaten an diese Nummer.')}
            </p>
            <div className="flex gap-2">
              <input
                value={testPhone}
                onChange={e => setTestPhone(e.target.value)}
                placeholder="+49151…"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm
                           focus:outline-none focus:border-orange-400 font-mono"
              />
              <button
                onClick={handleTestSend}
                disabled={testSending || !testPhone.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium border-2 border-green-500
                           text-green-700 hover:bg-green-50 disabled:opacity-50 transition-colors
                           flex items-center gap-2"
              >
                {testSending && (
                  <span className="w-3 h-3 border-2 border-green-400 border-t-green-700 rounded-full animate-spin" />
                )}
                📱 {testSending
                  ? t('crm.wa.sending', 'Sendet…')
                  : t('crm.wa.sendTest', 'Test senden')}
              </button>
            </div>
            {testResult && (
              <p className="text-sm font-medium">{testResult}</p>
            )}
          </section>

        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50"
          >
            {t('common.cancel', 'Abbrechen')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim() || !msgTemplate.trim()}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#ff795d' }}
          >
            {saving ? t('common.saving', 'Speichert…') : t('common.save', 'Speichern')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function WhatsappTemplates() {
  const { t } = useTranslation()
  const [templates, setTemplates]   = useState<WaTemplate[]>([])
  const [loading, setLoading]       = useState(true)
  const [editTpl, setEditTpl]       = useState<WaTemplate | null>(null)
  const [toggling, setToggling]     = useState<string | null>(null)
  const [toast, setToast]           = useState('')

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('whatsapp_templates')
        .select('*')
        .order('event_type')
      if (error) throw error
      setTemplates((data ?? []) as WaTemplate[])
    } catch (err) {
      console.error('[WaTemplates] fetch:', err)
      setTemplates([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  const handleToggleActive = async (tpl: WaTemplate) => {
    setToggling(tpl.id)
    try {
      await supabase
        .from('whatsapp_templates')
        .update({ active: !tpl.active, updated_at: new Date().toISOString() })
        .eq('id', tpl.id)
      setTemplates(prev =>
        prev.map(t => t.id === tpl.id ? { ...t, active: !tpl.active } : t)
      )
      showToast(tpl.active
        ? t('crm.wa.deactivated', '{{name}} deaktiviert', { name: tpl.name })
        : t('crm.wa.activated',   '{{name}} aktiviert',   { name: tpl.name })
      )
    } catch (err) {
      console.error('[WaTemplates] toggle:', err)
    } finally {
      setToggling(null)
    }
  }

  return (
    <DashboardLayout basePath="/admin/crm">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl shadow-lg text-sm">
          {toast}
        </div>
      )}

      <div className="max-w-3xl space-y-8">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            📱 {t('crm.wa.title', 'WhatsApp Benachrichtigungen')}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('crm.wa.subtitle',
              'Vorlagen für automatische WhatsApp-Nachrichten konfigurieren')}
          </p>
        </div>

        {/* Template list */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          </div>
        ) : templates.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">
            {t('crm.wa.noTemplates',
              'Keine Templates gefunden. Bitte SQL-Migration ausführen.')}
          </p>
        ) : (
          <div className="space-y-3">
            {templates.map(tpl => (
              <div
                key={tpl.id}
                className={`bg-white rounded-2xl border shadow-sm p-5 flex items-center gap-4 ${
                  tpl.active ? 'border-gray-100' : 'border-gray-100 opacity-60'
                }`}
              >
                {/* Active dot */}
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                  tpl.active ? 'bg-green-400' : 'bg-gray-300'
                }`} />

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900 text-sm">{tpl.name}</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      EVENT_BADGE[tpl.event_type] ?? 'bg-gray-100 text-gray-600'
                    }`}>
                      {EVENT_LABEL[tpl.event_type] ?? tpl.event_type}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {tpl.recipients.length > 0
                      ? `${tpl.recipients.length} ${t('crm.wa.recipientCount', 'Empfänger')}: ${tpl.recipients.map(r => r.name || r.phone).join(', ')}`
                      : t('crm.wa.dynamicRecipient', 'Empfänger dynamisch (Lead / Gast)')}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Toggle */}
                  <button
                    onClick={() => handleToggleActive(tpl)}
                    disabled={toggling === tpl.id}
                    className={`relative w-10 h-5 rounded-full transition-colors disabled:opacity-50 ${
                      tpl.active ? 'bg-green-500' : 'bg-gray-200'
                    }`}
                    title={tpl.active
                      ? t('crm.wa.deactivate', 'Deaktivieren')
                      : t('crm.wa.activate',   'Aktivieren')}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                      tpl.active ? 'translate-x-5' : 'translate-x-0.5'
                    }`} />
                  </button>

                  {/* Edit */}
                  <button
                    onClick={() => setEditTpl(tpl)}
                    className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600
                               hover:border-orange-300 hover:text-orange-600 transition-colors"
                  >
                    {t('common.edit', 'Bearbeiten')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Info box */}
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-700">
          <p className="font-medium mb-1">
            {t('crm.wa.infoTitle', 'Verfügbare Platzhalter in Vorlagen:')}
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {WA_FIELDS.map(f => (
              <code key={f.key} className="text-xs bg-blue-100 rounded px-1.5 py-0.5">
                {`{{${f.key}}}`}
              </code>
            ))}
          </div>
        </div>

      </div>

      {/* Edit Modal */}
      {editTpl && (
        <EditModal
          template={editTpl}
          onClose={() => setEditTpl(null)}
          onSaved={() => { setEditTpl(null); fetchTemplates() }}
        />
      )}
    </DashboardLayout>
  )
}
