import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

// ── Partner-Akte teilen (z.B. Burkhard) ─────────────────────────────────────
// Aktiviert für einen Lead die öffentliche Verlaufs-Akte (/akte/:token):
// Partner bekommt sofort eine WhatsApp mit Stammdaten + Link und danach bei
// jedem neuen Vorgang automatisch eine Kurzmeldung (Cron alle 10 Min).

interface Props { leadId: string; leadName: string; onClose: () => void }
interface ShareInfo { active: boolean; partner_name: string; whatsapp: string; url: string }

const DEFAULT_PARTNER = { name: 'Burkhard', whatsapp: '+35797689159' }

export default function PartnerShareModal({ leadId, leadName, onClose }: Props) {
  const { t } = useTranslation()
  const [share, setShare] = useState<ShareInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState(DEFAULT_PARTNER.name)
  const [wa, setWa] = useState(DEFAULT_PARTNER.whatsapp)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('partner-akte', { body: { action: 'status', lead_id: leadId } })
      if (error) throw error
      const s = (data as { share?: ShareInfo | null } | null)?.share ?? null
      setShare(s)
      if (s) { setName(s.partner_name); setWa(s.whatsapp) }
    } catch (e) {
      console.error('[PartnerShareModal] status:', e)
    } finally { setLoading(false) }
  }, [leadId])
  useEffect(() => { void load() }, [load])

  const activate = async () => {
    setBusy(true); setErr('')
    try {
      const { data, error } = await supabase.functions.invoke('partner-akte', {
        body: { action: 'create', lead_id: leadId, whatsapp: wa.trim(), partner_name: name.trim() },
      })
      if (error) throw error
      const d = data as { ok?: boolean; url?: string; wa_sent?: boolean; error?: string } | null
      if (!d?.ok) throw new Error(d?.error || t('crm.pshare.err', 'Aktivieren fehlgeschlagen.'))
      setShare({ active: true, partner_name: name.trim(), whatsapp: wa.trim(), url: d.url ?? '' })
      if (d.wa_sent === false) setErr(t('crm.pshare.waWarn', '⚠️ Akte ist aktiv, aber die WhatsApp an den Partner kam nicht durch - bitte Link manuell schicken.'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('crm.pshare.err', 'Aktivieren fehlgeschlagen.'))
    } finally { setBusy(false) }
  }

  const deactivate = async () => {
    setBusy(true); setErr('')
    try {
      const { error } = await supabase.functions.invoke('partner-akte', { body: { action: 'deactivate', lead_id: leadId } })
      if (error) throw error
      setShare(s => s ? { ...s, active: false } : null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Fehler')
    } finally { setBusy(false) }
  }

  const copy = () => {
    if (!share?.url) return
    void navigator.clipboard.writeText(share.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  const inp = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400'

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-bold text-gray-900">📁 {t('crm.pshare.title', 'Partner-Akte')}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{leadName}</p>
        </div>

        {loading ? (
          <div className="flex justify-center py-8"><div className="w-7 h-7 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : share?.active ? (
          <>
            <div className="rounded-xl bg-emerald-50 border border-emerald-100 px-3.5 py-3 text-sm text-emerald-800">
              {t('crm.pshare.activeInfo', 'Aktiv - {{name}} ({{wa}}) bekommt bei jedem neuen Vorgang automatisch eine WhatsApp mit Kurzfassung und Link.', { name: share.partner_name, wa: share.whatsapp })}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.pshare.link', 'Akten-Link')}</label>
              <div className="flex gap-2">
                <input className={`${inp} text-gray-600`} value={share.url} readOnly />
                <button onClick={copy} className="px-3 rounded-xl text-sm border border-gray-200 hover:bg-gray-50 shrink-0">
                  {copied ? '✅' : '📋'}
                </button>
              </div>
            </div>
            {err && <p className="text-sm text-amber-700">{err}</p>}
            <div className="flex justify-between gap-2 pt-1">
              <button onClick={() => void deactivate()} disabled={busy}
                className="px-4 py-2 rounded-xl text-sm border border-gray-200 text-red-600 hover:bg-red-50 disabled:opacity-60">
                {t('crm.pshare.deactivate', 'Teilen beenden')}
              </button>
              <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm border border-gray-200 hover:bg-gray-50">{t('common.close', 'Schließen')}</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600">
              {t('crm.pshare.intro', 'Der Partner bekommt sofort eine WhatsApp mit den Stammdaten und dem Akten-Link. Danach meldet das System jeden neuen Vorgang (Mail, Berechnung, Deck, Termin) automatisch als Kurzfassung.')}
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.pshare.partnerName', 'Partner')}</label>
              <input className={inp} value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.pshare.partnerWa', 'WhatsApp-Nummer')}</label>
              <input className={inp} value={wa} onChange={e => setWa(e.target.value)} placeholder="+357…" />
            </div>
            {share && !share.active && <p className="text-xs text-gray-400">{t('crm.pshare.wasShared', 'Diese Akte war schon einmal geteilt - beim Aktivieren gilt derselbe Link weiter.')}</p>}
            {err && <p className="text-sm text-red-600">{err}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
              <button onClick={() => void activate()} disabled={busy || !wa.trim()}
                className="px-5 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
                {busy ? '…' : t('crm.pshare.activate', 'Aktivieren + Link senden')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
