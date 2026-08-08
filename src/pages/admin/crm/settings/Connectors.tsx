import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'

// ── Einstellungen → Connectoren ──────────────────────────────────────────────
// Alle Anbindungen des Systems mit Live-Status (✓/✗), Test-Button und — wo
// vorgesehen (z.B. LinkedIn) — Token-Pflege direkt hier. Secrets bleiben auf
// dem Server (Edge connectors testet dort und liefert nur ok/Detail zurück).

interface Conn { key: string; label: string; editable: boolean; ok: boolean; detail: string }

export default function Connectors() {
  const { t } = useTranslation()
  const [conns, setConns] = useState<Conn[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [editKey, setEditKey] = useState<string | null>(null)
  const [editVal, setEditVal] = useState('')
  const [toast, setToast] = useState('')
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 6000) }

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('connectors', { body: { action: 'status' } })
      const d = (data ?? {}) as { ok?: boolean; error?: string; connectors?: Conn[] }
      if (error || d.error || !d.ok) throw new Error(d.error || error?.message || 'Fehler')
      setConns(d.connectors ?? [])
    } catch (e) {
      console.error('[Connectors] load:', e)
      showToast(`❌ ${e instanceof Error ? e.message : 'Status konnte nicht geladen werden'}`)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const saveToken = async (key: string) => {
    if (!editVal.trim()) return
    setBusy(key)
    try {
      const { data, error } = await supabase.functions.invoke('connectors', { body: { action: 'set', key, value: editVal.trim() } })
      const d = (data ?? {}) as { ok?: boolean; error?: string }
      if (error || d.error || !d.ok) throw new Error(d.error || error?.message || 'Fehler')
      setEditKey(null); setEditVal('')
      showToast(t('crm.conn.saved', '✓ Gespeichert — Verbindung wird getestet…'))
      await load(true)
    } catch (e) {
      showToast(`❌ ${e instanceof Error ? e.message : 'Speichern fehlgeschlagen'}`)
    } finally { setBusy('') }
  }

  const [ytOpen, setYtOpen] = useState(false)
  const ytConns = conns.filter(c => c.key.startsWith('YOUTUBE_'))
  const restConns = conns.filter(c => !c.key.startsWith('YOUTUBE_'))
  const ytOk = ytConns.length > 0 && ytConns.every(c => c.ok)

  const renderCard = (c: (typeof conns)[number], nested = false) => (
    <div key={c.key} className={nested ? 'rounded-xl border border-gray-100 p-3' : 'bg-white rounded-2xl border border-gray-100 shadow-sm p-4'}>

                <div className="flex items-center gap-3">
                  <span className={`text-xl ${c.ok ? '' : ''}`}>{c.ok ? '✅' : '❌'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-900 text-sm">{c.label}</p>
                    <p className={`text-xs mt-0.5 ${c.ok ? 'text-gray-500' : 'text-red-600'}`}>{c.detail}</p>
                  </div>
                  {c.editable && (
                    <button onClick={() => { setEditKey(editKey === c.key ? null : c.key); setEditVal('') }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50 shrink-0">
                      ✏️ {t('crm.conn.change', 'Ändern')}
                    </button>
                  )}
                </div>
                {editKey === c.key && (
                  <div className="mt-3 flex items-end gap-2 flex-wrap">
                    <input type="password" value={editVal} onChange={e => setEditVal(e.target.value)}
                      placeholder={t('crm.conn.tokenPh', 'Neuen Token einfügen …')}
                      className="flex-1 min-w-[240px] rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400" />
                    <button onClick={() => void saveToken(c.key)} disabled={busy === c.key || !editVal.trim()}
                      className="px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
                      {busy === c.key ? t('common.saving', 'Speichert…') : t('common.save', 'Speichern')}
                    </button>
                  </div>
                )}
              
    </div>
  )

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg max-w-md">{toast}</div>}
      <div className="p-6 space-y-5 max-w-3xl">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('crm.conn.title', 'Connectoren')}</h1>
            <p className="text-sm text-gray-500 mt-0.5">{t('crm.conn.subtitle', 'Alle Anbindungen des Systems — Status, Test und Pflege.')}</p>
          </div>
          <button onClick={() => void load()} disabled={loading}
            className="px-3 py-1.5 rounded-xl text-sm font-medium border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
            {loading ? t('crm.conn.testing', 'Testet…') : t('crm.conn.testAll', '🔄 Alle testen')}
          </button>
        </div>

        {loading && conns.length === 0 ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : (
          <div className="space-y-2">
            {restConns.map(c => renderCard(c))}
            {ytConns.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
                <button onClick={() => setYtOpen(o => !o)} className="w-full flex items-center gap-3 p-4 text-left">
                  <span className="text-xl">{ytOk ? '✅' : '❌'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-900 text-sm">YouTube</p>
                    <p className={`text-xs mt-0.5 ${ytOk ? 'text-gray-500' : 'text-red-600'}`}>
                      {ytOk ? t('crm.conn.ytOk', 'Verbunden - Upload & Kommentare aktiv.') : t('crm.conn.ytMissing', 'Noch nicht vollständig verbunden - aufklappen oder „Verbinden" klicken.')}
                    </p>
                  </div>
                  <a href="https://vjlwgajmtqlwjjreowbu.supabase.co/functions/v1/yt-oauth" target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50 shrink-0">
                    🔗 {t('crm.conn.ytConnect', 'Verbinden')}
                  </a>
                  <span className={`text-gray-400 transition-transform ${ytOpen ? 'rotate-180' : ''}`}>▾</span>
                </button>
                {ytOpen && <div className="px-4 pb-4 space-y-2 border-t border-gray-50 pt-3">{ytConns.map(c => renderCard(c, true))}</div>}
              </div>
            )}
          </div>
        )}
        <p className="text-xs text-gray-400">
          {t('crm.conn.hint', 'Schlüssel werden nur auf dem Server geprüft und nie im Browser angezeigt. Anbindungen ohne „Ändern"-Knopf pflegst du über mich (Claude) oder die Supabase-Secrets.')}
        </p>
      </div>
    </DashboardLayout>
  )
}
