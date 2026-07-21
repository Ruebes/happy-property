import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'

// ── Empfängerlisten ─────────────────────────────────────────────────────────────
// Die Adressen aus Klaviyo (Webinar-Anmeldungen, Leadmagneten, Newsletter) liegen
// in newsletter_subscribers — BEWUSST getrennt von den CRM-Leads. Eine Webinar-
// Anmeldung ist kein Vertriebskontakt und darf Kundenliste, Pipeline und
// Auswertungen nicht verschmutzen.
//
// Neu aus Klaviyo geholte Listen kommen INAKTIV rein. Erst wenn sie hier
// freigeschaltet werden, zählen sie für den Newsletter — sonst ginge eine frisch
// in Klaviyo angelegte Liste beim nächsten Versand ungefragt mit.

interface ListRow {
  id: string
  name: string
  source: string
  klaviyo_list_id: string | null
  active: boolean
  synced_at: string | null
  anzahl: number
}

export default function NewsletterLists() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<ListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState('')

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 5000) }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.from('newsletter_lists')
        .select('id, name, source, klaviyo_list_id, active, synced_at, newsletter_list_members(count)')
        .order('name')
      if (error) throw error
      // deno-lint-ignore no-explicit-any
      setRows(((data ?? []) as any[]).map(l => ({
        id: l.id, name: l.name, source: l.source, klaviyo_list_id: l.klaviyo_list_id,
        active: l.active, synced_at: l.synced_at,
        anzahl: l.newsletter_list_members?.[0]?.count ?? 0,
      })))
    } catch (err) {
      console.error('[NewsletterLists] fetchAll:', err)
      setRows([])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void fetchAll() }, [fetchAll])

  const call = async (body: Record<string, unknown>, label: string) => {
    setBusy(label)
    try {
      const { data, error } = await supabase.functions.invoke('klaviyo-sync', { body })
      if (error) throw error
      const d = data as { error?: string; gefunden?: number; neu?: number; listen?: unknown[] } | null
      if (d?.error) { showToast(d.error); return }
      if (d?.gefunden != null) {
        showToast(t('crm.lists.fetched', '{{n}} Listen bei Klaviyo gefunden, {{neu}} neu angelegt.', { n: d.gefunden, neu: d.neu ?? 0 }))
      } else {
        showToast(t('crm.lists.synced', 'Abonnenten aktualisiert.'))
      }
      await fetchAll()
    } catch (err) {
      console.error('[NewsletterLists] call:', err)
      showToast(t('crm.lists.error', 'Fehlgeschlagen — steht der Klaviyo-Schlüssel in den Supabase-Secrets?'))
    } finally { setBusy(null) }
  }

  const toggle = async (r: ListRow) => {
    const prev = rows
    setRows(rs => rs.map(x => x.id === r.id ? { ...x, active: !x.active } : x))
    const { error } = await supabase.from('newsletter_lists').update({ active: !r.active }).eq('id', r.id)
    if (error) { console.error('[NewsletterLists] toggle:', error); setRows(prev) }
  }

  const d2 = (s: string | null) => s ? new Date(s).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'
  const gesamt = rows.filter(r => r.active).reduce((n, r) => n + r.anzahl, 0)

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg max-w-sm">{toast}</div>}
      <div className="p-6 space-y-5 max-w-4xl">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('crm.lists.title', 'Empfängerlisten')}</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {t('crm.lists.subtitle', 'Adressen aus Klaviyo — Webinare, Leadmagneten, Newsletter. Getrennt von deinen CRM-Kunden.')}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => void call({ action: 'lists' }, 'lists')} disabled={!!busy}
              className="px-3 py-1.5 rounded-xl text-sm font-medium border border-gray-200 hover:bg-gray-50 disabled:opacity-50">
              {busy === 'lists' ? t('common.saving', 'lädt …') : t('crm.lists.fetchLists', 'Listen aus Klaviyo holen')}
            </button>
            <button onClick={() => void call({ action: 'sync' }, 'sync')} disabled={!!busy}
              className="px-3 py-1.5 rounded-xl text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
              {busy === 'sync' ? t('crm.lists.syncing', 'holt Adressen …') : t('crm.lists.sync', 'Adressen aktualisieren')}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center">
            <p className="text-sm text-gray-500">{t('crm.lists.empty', 'Noch keine Listen. Klick auf „Listen aus Klaviyo holen".')}</p>
            <p className="text-xs text-gray-400 mt-2">
              {t('crm.lists.keyHint', 'Dafür muss der Klaviyo-Schlüssel als KLAVIYO_API_KEY in den Supabase-Secrets hinterlegt sein.')}
            </p>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {[t('crm.lists.name', 'Liste'), t('crm.lists.count', 'Adressen'), t('crm.lists.lastSync', 'Zuletzt geholt'), t('crm.lists.active', 'Für Newsletter')].map(c => (
                      <th key={c} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map(r => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {r.name}
                        {r.source === 'klaviyo' && <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Klaviyo</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{r.anzahl.toLocaleString('de-DE')}</td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{d2(r.synced_at)}</td>
                      <td className="px-4 py-3">
                        <button onClick={() => void toggle(r)}
                          className={`w-11 h-6 rounded-full relative transition-colors ${r.active ? '' : 'bg-gray-200'}`}
                          style={r.active ? { backgroundColor: '#ff795d' } : undefined}
                          aria-label={r.active ? 'aktiv' : 'inaktiv'}>
                          <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${r.active ? 'left-5' : 'left-0.5'}`} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500">
              {t('crm.lists.total', 'Freigeschaltet: {{n}} Adressen. Deine CRM-Kunden kommen im Newsletter immer dazu; doppelte Adressen werden nur einmal angeschrieben.', { n: gesamt.toLocaleString('de-DE') })}
            </p>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
