import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { sendWhatsApp } from '../../lib/whatsapp'
import type { Lead } from '../../lib/crmTypes'

// Schnell-Versand aus der Lead-Kachel (Rechtsklick → Menü):
//  - 'whatsapp'  → WhatsApp an den Kunden
//  - 'mail'      → E-Mail an den Kunden
//  - 'forward'   → Kontakt per WhatsApp an einen Partner/Developer-Ansprechpartner weiterleiten
export type QuickSendMode = 'whatsapp' | 'mail' | 'forward'

type Contact = { id: string; label: string; phone: string }

export default function LeadQuickSend({ lead, mode, onClose, onSent }: {
  lead:   Lead
  mode:   QuickSendMode
  onClose: () => void
  onSent: (msg: string) => void
}) {
  const { t } = useTranslation()
  const fullName = `${lead.first_name} ${lead.last_name}`.trim()
  const [subject, setSubject] = useState(mode === 'mail' ? 'Happy Property' : '')
  const [text, setText] = useState('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactId, setContactId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (mode !== 'forward') return
    void (async () => {
      const [bc, dc] = await Promise.all([
        supabase.from('crm_business_contacts').select('id, first_name, last_name, company, role, phone, whatsapp'),
        supabase.from('crm_developer_contacts').select('id, name, role, phone, whatsapp, developer_id'),
      ])
      const list: Contact[] = []
      for (const c of (bc.data ?? []) as Array<{ id: string; first_name: string; last_name: string | null; company: string | null; role: string | null; phone: string | null; whatsapp: string | null }>) {
        const tel = c.whatsapp || c.phone; if (!tel) continue
        list.push({ id: `bc:${c.id}`, label: `📇 ${`${c.first_name} ${c.last_name ?? ''}`.trim()}${c.company ? ` · ${c.company}` : ''}`, phone: tel })
      }
      for (const c of (dc.data ?? []) as Array<{ id: string; name: string; role: string | null; phone: string | null; whatsapp: string | null }>) {
        const tel = c.whatsapp || c.phone; if (!tel) continue
        list.push({ id: `dc:${c.id}`, label: `🏗 ${c.name}${c.role ? ` (${c.role})` : ''}`, phone: tel })
      }
      setContacts(list)
      if (list.length) setContactId(list[0].id)
    })()
    // Vorbefüllter Weiterleitungstext
    setText(`Bitte bearbeite diesen Kontakt:\n${fullName}\nTel: ${lead.phone || lead.whatsapp || '–'}\nE-Mail: ${lead.email || '–'}\n\n`)
  }, [mode, lead, fullName])

  const handleSend = async () => {
    setError('')
    if (mode === 'mail' && (!subject.trim() || !text.trim())) { setError(t('crm.quick.errMail', 'Betreff und Text sind Pflicht')); return }
    if (mode !== 'mail' && !text.trim()) { setError(t('crm.quick.errText', 'Text ist Pflicht')); return }
    if (mode === 'forward' && !contactId) { setError(t('crm.quick.errContact', 'Empfänger wählen')); return }
    setBusy(true)
    try {
      if (mode === 'mail') {
        if (!lead.email) throw new Error('Kein E-Mail am Lead')
        const html = `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${text.replace(/</g, '&lt;')}</div>`
        const { data, error: e } = await supabase.functions.invoke('send-email', { body: { to: lead.email, subject: subject.trim(), html, lead_id: lead.id } })
        if (e || (data as { error?: string })?.error) throw new Error((data as { error?: string })?.error ?? e?.message)
        onSent(t('crm.quick.mailSent', '✅ E-Mail an den Kunden gesendet'))
      } else if (mode === 'whatsapp') {
        const phone = lead.whatsapp || lead.phone
        if (!phone) throw new Error('Keine Telefonnummer am Lead')
        const r = await sendWhatsApp({ event_type: 'no_show', override_text: text.trim(), lead_id: lead.id, lead_data: { lead_name: fullName, lead_phone: phone } })
        if (!r.success) throw new Error(r.error || 'WhatsApp Fehler')
        onSent(t('crm.quick.waSent', '✅ WhatsApp an den Kunden gesendet'))
      } else {
        const target = contacts.find(c => c.id === contactId)
        if (!target) throw new Error('Empfänger nicht gefunden')
        const r = await sendWhatsApp({ event_type: 'no_show', override_text: text.trim(), lead_id: lead.id, lead_data: { lead_name: target.label, lead_phone: target.phone } })
        if (!r.success) throw new Error(r.error || 'WhatsApp Fehler')
        await supabase.from('activities').insert({ lead_id: lead.id, type: 'whatsapp', direction: 'outbound', subject: `Kontakt weitergeleitet an ${target.label}`, content: text.trim(), completed_at: new Date().toISOString() })
        onSent(t('crm.quick.forwarded', '✅ Kontakt weitergeleitet'))
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const title = mode === 'mail' ? t('crm.quick.titleMail', 'E-Mail an Kunden') : mode === 'whatsapp' ? t('crm.quick.titleWa', 'WhatsApp an Kunden') : t('crm.quick.titleFwd', 'Kontakt versenden (WhatsApp)')

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-gray-500">{mode === 'forward' ? t('crm.quick.fwdHint', 'An Partner/Developer-Ansprechpartner senden:') : fullName}</p>

        {mode === 'forward' && (
          <select value={contactId} onChange={e => setContactId(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300">
            {contacts.length === 0 && <option value="">{t('crm.quick.noContacts', '– keine Kontakte mit Nummer –')}</option>}
            {contacts.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        )}

        {mode === 'mail' && (
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder={t('crm.quick.subject', 'Betreff')}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
        )}

        <textarea rows={mode === 'forward' ? 6 : 5} value={text} onChange={e => setText(e.target.value)}
          placeholder={t('crm.quick.message', 'Nachricht…')}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-orange-300" />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
          <button onClick={() => void handleSend()} disabled={busy}
            className="px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
            {busy ? t('crm.quick.sending', 'Sendet…') : t('crm.quick.send', 'Senden')}
          </button>
        </div>
      </div>
    </div>
  )
}
