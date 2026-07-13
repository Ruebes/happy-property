import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { sendWhatsApp } from '../../lib/whatsapp'
import type { Lead } from '../../lib/crmTypes'

// Schnell-Versand aus der Lead-Kachel (Rechtsklick → Menü):
//  - 'whatsapp'  → WhatsApp an den Kunden
//  - 'mail'      → E-Mail an den Kunden
//  - 'forward'   → Kontakt an einen Partner/Developer-Ansprechpartner weiterleiten
//                  (Kanal WhatsApp ODER E-Mail je Kontakt wählbar)
export type QuickSendMode = 'whatsapp' | 'mail' | 'forward'

type Contact = { id: string; label: string; phone: string; email: string }

export default function LeadQuickSend({ lead, mode, onClose, onSent }: {
  lead:   Lead
  mode:   QuickSendMode
  onClose: () => void
  onSent: (msg: string) => void
}) {
  const { t } = useTranslation()
  const fullName = `${lead.first_name} ${lead.last_name}`.trim()
  const [subject, setSubject] = useState(mode === 'mail' ? t('leadQuickSend.defaultSubject', 'Happy Property') : '')
  const [text, setText] = useState('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactId, setContactId] = useState('')
  const [fwdChannel, setFwdChannel] = useState<'whatsapp' | 'mail'>('whatsapp')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Dateianhänge (nur E-Mail). Gesamt-Limit, damit der Edge-Function-Body nicht platzt
  // (Base64 bläht ~+33 %; 8 MB roh ≈ ~11 MB Base64 — sicher unter dem Request-Limit).
  const MAX_TOTAL = 8 * 1024 * 1024
  const addFiles = (list: FileList | null) => {
    if (!list?.length) return
    const next = [...files, ...Array.from(list)]
    if (next.reduce((s, f) => s + f.size, 0) > MAX_TOTAL) {
      setError(t('crm.quick.attachTooBig', 'Anhänge zusammen zu groß (max. 8 MB).')); return
    }
    setError(''); setFiles(next)
  }
  const removeFile = (i: number) => setFiles(files.filter((_, idx) => idx !== i))
  const fileToB64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')   // data:…;base64,XXX → XXX
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(file)
  })
  const buildAttachments = async () => files.length
    ? await Promise.all(files.map(async f => ({ filename: f.name, content_base64: await fileToB64(f), content_type: f.type || 'application/octet-stream' })))
    : undefined

  useEffect(() => {
    if (mode !== 'forward') return
    void (async () => {
      const [bc, dc] = await Promise.all([
        supabase.from('crm_business_contacts').select('id, first_name, last_name, company, role, phone, whatsapp, email'),
        supabase.from('crm_developer_contacts').select('id, name, role, phone, whatsapp, email, developer_id'),
      ])
      const list: Contact[] = []
      for (const c of (bc.data ?? []) as Array<{ id: string; first_name: string; last_name: string | null; company: string | null; role: string | null; phone: string | null; whatsapp: string | null; email: string | null }>) {
        const tel = c.whatsapp || c.phone || ''; const email = c.email || ''
        if (!tel && !email) continue   // braucht mindestens einen Kanal (WhatsApp oder E-Mail)
        list.push({ id: `bc:${c.id}`, label: `📇 ${`${c.first_name} ${c.last_name ?? ''}`.trim()}${c.company ? ` · ${c.company}` : ''}`, phone: tel, email })
      }
      for (const c of (dc.data ?? []) as Array<{ id: string; name: string; role: string | null; phone: string | null; whatsapp: string | null; email: string | null }>) {
        const tel = c.whatsapp || c.phone || ''; const email = c.email || ''
        if (!tel && !email) continue
        list.push({ id: `dc:${c.id}`, label: `🏗 ${c.name}${c.role ? ` (${c.role})` : ''}`, phone: tel, email })
      }
      setContacts(list)
      if (list.length) setContactId(list[0].id)
    })()
    // Vorbefüllter Weiterleitungstext
    setText(t('leadQuickSend.forwardTemplate', 'Bitte bearbeite diesen Kontakt:\n{{name}}\nTel: {{phone}}\nE-Mail: {{email}}\n\n', {
      name: fullName,
      phone: lead.phone || lead.whatsapp || '–',
      email: lead.email || '–',
    }))
  }, [mode, lead, fullName])

  // Kanal je gewähltem Kontakt vorwählen: WhatsApp wenn Nummer da, sonst E-Mail.
  // (Eigene Wahl bleibt erhalten, solange derselbe Kontakt gewählt ist.)
  useEffect(() => {
    if (mode !== 'forward') return
    const c = contacts.find(x => x.id === contactId)
    if (c) setFwdChannel(c.phone ? 'whatsapp' : 'mail')
  }, [contactId, contacts, mode])

  const handleSend = async () => {
    setError('')
    if (mode === 'mail' && (!subject.trim() || !text.trim())) { setError(t('crm.quick.errMail', 'Betreff und Text sind Pflicht')); return }
    if (mode !== 'mail' && !text.trim()) { setError(t('crm.quick.errText', 'Text ist Pflicht')); return }
    if (mode === 'forward' && !contactId) { setError(t('crm.quick.errContact', 'Empfänger wählen')); return }
    setBusy(true)
    try {
      if (mode === 'mail') {
        if (!lead.email) throw new Error(t('leadQuickSend.errNoEmailOnLead', 'Kein E-Mail am Lead'))
        const html = `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${text.replace(/</g, '&lt;')}</div>`
        const attachments = await buildAttachments()
        const { data, error: e } = await supabase.functions.invoke('send-email', { body: { to: lead.email, subject: subject.trim(), html, lead_id: lead.id, ...(attachments ? { attachments } : {}) } })
        if (e || (data as { error?: string })?.error) throw new Error((data as { error?: string })?.error ?? e?.message)
        onSent(t('crm.quick.mailSent', '✅ E-Mail an den Kunden gesendet'))
      } else if (mode === 'whatsapp') {
        const phone = lead.whatsapp || lead.phone
        if (!phone) throw new Error(t('leadQuickSend.errNoPhoneOnLead', 'Keine Telefonnummer am Lead'))
        const r = await sendWhatsApp({ event_type: 'no_show', override_text: text.trim(), lead_id: lead.id, lead_data: { lead_name: fullName, lead_phone: phone } })
        if (!r.success) throw new Error(r.error || t('leadQuickSend.errWhatsapp', 'WhatsApp Fehler'))
        onSent(t('crm.quick.waSent', '✅ WhatsApp an den Kunden gesendet'))
      } else {
        const target = contacts.find(c => c.id === contactId)
        if (!target) throw new Error(t('leadQuickSend.errRecipientNotFound', 'Empfänger nicht gefunden'))
        if (fwdChannel === 'mail') {
          if (!target.email) throw new Error(t('leadQuickSend.errNoEmailOnContact', 'Keine E-Mail bei diesem Kontakt'))
          const html = `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${text.trim().replace(/</g, '&lt;')}</div>`
          const subj = subject.trim() || t('leadQuickSend.defaultForwardSubject', 'Kontakt: {{name}}', { name: fullName })
          const attachments = await buildAttachments()
          const { data, error: e } = await supabase.functions.invoke('send-email', { body: { to: target.email, subject: subj, html, lead_id: lead.id, ...(attachments ? { attachments } : {}) } })
          if (e || (data as { error?: string })?.error) throw new Error((data as { error?: string })?.error ?? e?.message)
          // send-email protokolliert die Aktivität selbst → kein zweites Insert
          onSent(t('crm.quick.forwardedMail', '✅ Kontakt per E-Mail weitergeleitet'))
        } else {
          if (!target.phone) throw new Error(t('leadQuickSend.errNoPhoneOnContact', 'Keine Telefonnummer bei diesem Kontakt'))
          const r = await sendWhatsApp({ event_type: 'no_show', override_text: text.trim(), lead_id: lead.id, lead_data: { lead_name: target.label, lead_phone: target.phone } })
          if (!r.success) throw new Error(r.error || t('leadQuickSend.errWhatsapp', 'WhatsApp Fehler'))
          await supabase.from('activities').insert({ lead_id: lead.id, type: 'whatsapp', direction: 'outbound', subject: `Kontakt weitergeleitet an ${target.label}`, content: text.trim(), completed_at: new Date().toISOString() })
          onSent(t('crm.quick.forwarded', '✅ Kontakt per WhatsApp weitergeleitet'))
        }
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const sel = contacts.find(c => c.id === contactId)
  const title = mode === 'mail' ? t('crm.quick.titleMail', 'E-Mail an Kunden') : mode === 'whatsapp' ? t('crm.quick.titleWa', 'WhatsApp an Kunden') : t('crm.quick.titleFwd', 'Kontakt versenden')

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-gray-500">{mode === 'forward' ? t('crm.quick.fwdHint', 'An Partner/Developer-Ansprechpartner senden:') : fullName}</p>

        {mode === 'forward' && (
          <>
            <select value={contactId} onChange={e => setContactId(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-300">
              {contacts.length === 0 && <option value="">{t('crm.quick.noContacts', '– keine Kontakte angelegt –')}</option>}
              {contacts.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            {/* Kanal pro Kontakt wählen — nur der Kanal, den der Kontakt hat, ist aktiv */}
            <div className="flex gap-2">
              <button type="button" onClick={() => sel?.phone && setFwdChannel('whatsapp')} disabled={!sel?.phone}
                className={`flex-1 text-sm font-medium rounded-lg px-3 py-2 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${fwdChannel === 'whatsapp' ? 'text-white border-transparent' : 'text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                style={fwdChannel === 'whatsapp' ? { backgroundColor: '#25D366' } : undefined}>💬 {t('crm.quick.chanWa', 'WhatsApp')}</button>
              <button type="button" onClick={() => sel?.email && setFwdChannel('mail')} disabled={!sel?.email}
                className={`flex-1 text-sm font-medium rounded-lg px-3 py-2 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${fwdChannel === 'mail' ? 'text-white border-transparent' : 'text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                style={fwdChannel === 'mail' ? { backgroundColor: '#ff795d' } : undefined}>📧 {t('crm.quick.chanMail', 'E-Mail')}</button>
            </div>
            {sel && <p className="text-xs text-gray-500">{t('crm.quick.to', 'An')}: <span className="font-medium text-gray-700">{fwdChannel === 'whatsapp' ? (sel.phone || t('crm.quick.noWaShort', 'keine Nummer hinterlegt')) : (sel.email || t('crm.quick.noMailShort', 'keine E-Mail hinterlegt'))}</span></p>}
          </>
        )}

        {(mode === 'mail' || (mode === 'forward' && fwdChannel === 'mail')) && (
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder={t('crm.quick.subject', 'Betreff')}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
        )}

        <textarea rows={mode === 'forward' ? 6 : 5} value={text} onChange={e => setText(e.target.value)}
          placeholder={t('crm.quick.message', 'Nachricht…')}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-orange-300" />

        {/* Dateianhänge — nur bei E-Mail */}
        {(mode === 'mail' || (mode === 'forward' && fwdChannel === 'mail')) && (
          <div>
            <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
              <span className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">📎 {t('crm.quick.attach', 'Dateien anhängen')}</span>
              <input type="file" multiple className="hidden"
                onChange={e => { addFiles(e.target.files); e.currentTarget.value = '' }} />
            </label>
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-xs bg-gray-50 rounded-lg px-2.5 py-1.5">
                    <span className="truncate text-gray-700">📄 {f.name} <span className="text-gray-400">({Math.round(f.size / 1024)} KB)</span></span>
                    <button type="button" onClick={() => removeFile(i)} className="shrink-0 w-5 h-5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">×</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

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
