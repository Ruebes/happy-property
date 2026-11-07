import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

// Upload-Link für eine Person holen und kopieren. Verschickt nichts.
const WER = [
  ['kunde', 'Kunde', 'Client'], ['bautraeger', 'Bauträger', 'Developer'], ['anwalt', 'Anwalt', 'Lawyer'],
  ['partner', 'Partner', 'Partner'], ['team', 'Team', 'Team'],
] as const

export default function UploadLinkModal({ leadId, onClose, onDone }: { leadId: string; onClose: () => void; onDone: (msg: string) => void }) {
  const { t, i18n } = useTranslation()
  const [wer, setWer] = useState<string>('kunde')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState('')
  const [link, setLink] = useState('')

  const holen = async () => {
    setBusy(true); setFehler('')
    const { data, error } = await supabase.functions.invoke('owner-drive', { body: { action: 'upload_link', lead_id: leadId, empfaenger: wer, name } })
    setBusy(false)
    const d = (data ?? {}) as { url?: string; error?: string }
    if (error || !d.url) {
      const ctx = (error as { context?: Response } | null)?.context
      const j = ctx && typeof ctx.json === 'function' ? await ctx.json().catch(() => null) as { error?: string } | null : null
      setFehler(j?.error || d.error || t('crm.action.uploadLinkFailed', 'Upload-Link fehlgeschlagen'))
      return
    }
    // Klappt das Kopieren nicht (Browser-Sperre), bleibt der Link zum Markieren stehen
    try { await navigator.clipboard.writeText(d.url); onDone(t('crm.action.uploadLinkCopied', 'Upload-Link kopiert')) }
    catch { setLink(d.url) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <p className="font-semibold text-gray-900">{t('crm.action.uploadLinkTitle', 'Upload-Link kopieren')}</p>
        <p className="text-sm text-gray-500">{t('crm.action.uploadLinkHint', 'Wer den Link hat, kann ohne Google-Konto in den Ordner hochladen, aber nichts lesen. Gültig 30 Tage. Verschickt wird nichts.')}</p>
        <label className="block text-sm text-gray-700">{t('crm.action.uploadLinkWho', 'Für wen?')}
          <select value={wer} onChange={e => setWer(e.target.value)} className="mt-1 w-full border border-gray-200 rounded-xl px-3 py-2 bg-white">
            {WER.map(([k, de, en]) => <option key={k} value={k}>{i18n.language.startsWith('de') ? de : en}</option>)}
          </select>
        </label>
        {wer !== 'kunde' && (
          <label className="block text-sm text-gray-700">{t('crm.action.uploadLinkName', 'Name (steht in der Meldung als „hochgeladen von“)')}
            <input value={name} onChange={e => setName(e.target.value)} className="mt-1 w-full border border-gray-200 rounded-xl px-3 py-2" />
          </label>
        )}
        {fehler && <p className="text-sm text-red-600">{fehler}</p>}
        {link && <input readOnly value={link} onFocus={e => e.target.select()} className="w-full border border-gray-200 rounded-xl px-3 py-2 text-xs" />}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-gray-600 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
          <button onClick={holen} disabled={busy || (wer !== 'kunde' && !name.trim())} className="px-4 py-2 rounded-xl text-sm font-medium text-white bg-hp-highlight disabled:opacity-50">
            {busy ? '…' : t('crm.action.uploadLinkCopy', 'Link kopieren')}
          </button>
        </div>
      </div>
    </div>
  )
}
