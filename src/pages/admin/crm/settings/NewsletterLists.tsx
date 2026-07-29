import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'
import SequenceEditor from '../../../../components/crm/SequenceEditor'
import SubscribersModal from '../../../../components/crm/SubscribersModal'

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
  const [seqFor, setSeqFor] = useState<{ id: string; name: string } | null>(null)
  const [viewList, setViewList] = useState<{ id: string; name: string } | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 5000) }

  const createList = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      const { error } = await supabase.from('newsletter_lists').insert({ name, source: 'manual', active: true })
      if (error) throw error
      setNewName(''); await fetchAll()
      showToast(t('crm.lists.created', 'Liste „{{n}}" angelegt.', { n: name }))
    } catch (err) {
      console.error('[NewsletterLists] createList:', err)
      showToast(t('crm.lists.createErr', 'Liste konnte nicht angelegt werden (Name schon vergeben?).'))
    } finally { setCreating(false) }
  }

  const copySignupLink = async (name: string) => {
    const url = `${window.location.origin}/anmelden?list=${encodeURIComponent(name)}&phone=1`
    try { await navigator.clipboard.writeText(url); showToast(t('crm.lists.linkCopied', 'Anmelde-Link kopiert: {{u}}', { u: url })) }
    catch { showToast(url) }
  }

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
        // Ergebnis je Liste zeigen — sonst weiss niemand, ob wirklich etwas ankam
        // oder eine Liste still auf einen Fehler gelaufen ist.
        const r = (d?.listen ?? []) as Array<{ liste?: string; gesehen?: number; neu?: number; fehler?: string }>
        const fehler = r.filter(x => x.fehler)
        const summe = r.reduce((n, x) => n + (x.neu ?? 0), 0)
        showToast(fehler.length
          ? t('crm.lists.syncedPartly', '{{n}} neue Adressen. {{f}} Liste(n) mit Fehler: {{msg}}', { n: summe, f: fehler.length, msg: fehler[0].fehler ?? '' })
          : t('crm.lists.syncedN', '{{n}} neue Adressen übernommen.', { n: summe }))
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

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.lists.newList', 'Eigene Liste anlegen')}</label>
            <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void createList() }}
              placeholder={t('crm.lists.newListPh', 'z. B. Rendite-Rechner Leads')}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400" />
          </div>
          <button onClick={() => void createList()} disabled={creating || !newName.trim()}
            className="px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
            {creating ? t('common.saving', 'lädt …') : t('crm.lists.add', '+ Liste')}
          </button>
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
                    {[t('crm.lists.name', 'Liste'), t('crm.lists.count', 'Adressen'), t('crm.lists.lastSync', 'Zuletzt geholt'), t('crm.lists.active', 'Für Newsletter'), t('crm.lists.actions', 'Automation & Anmeldung')].map(c => (
                      <th key={c} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map(r => (
                    <tr key={r.id} onClick={() => setViewList({ id: r.id, name: r.name })}
                      className="hover:bg-orange-50/50 cursor-pointer transition-colors"
                      title={t('crm.lists.rowTip', 'Anklicken, um alle Einträge zu sehen & zu bearbeiten')}>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {r.name}
                        {r.source === 'klaviyo' && <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Klaviyo</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{r.anzahl.toLocaleString('de-DE')}</td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{d2(r.synced_at)}</td>
                      <td className="px-4 py-3">
                        <button onClick={e => { e.stopPropagation(); void toggle(r) }}
                          className={`w-11 h-6 rounded-full relative transition-colors ${r.active ? '' : 'bg-gray-200'}`}
                          style={r.active ? { backgroundColor: '#ff795d' } : undefined}
                          aria-label={r.active ? t('crm.lists.ariaActive', 'aktiv') : t('crm.lists.ariaInactive', 'inaktiv')}>
                          <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${r.active ? 'left-5' : 'left-0.5'}`} />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1.5">
                          <button onClick={e => { e.stopPropagation(); setViewList({ id: r.id, name: r.name }) }}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50" title={t('crm.lists.viewTip', 'Alle Einträge ansehen & bearbeiten')}>
                            👥 {t('crm.lists.view', 'Einträge')}
                          </button>
                          <button onClick={e => { e.stopPropagation(); setSeqFor({ id: r.id, name: r.name }) }}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50" title={t('crm.lists.automationTip', 'Mail-/WhatsApp-Automation für diese Liste')}>
                            ⚙️ {t('crm.lists.automation', 'Automation')}
                          </button>
                          <button onClick={e => { e.stopPropagation(); void copySignupLink(r.name) }}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50" title={t('crm.lists.linkTip', 'Öffentlichen Anmelde-Link kopieren')}>
                            🔗 {t('crm.lists.link', 'Anmelde-Link')}
                          </button>
                        </div>
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
      {seqFor && <SequenceEditor listId={seqFor.id} listName={seqFor.name} onClose={() => setSeqFor(null)} />}
      {viewList && <SubscribersModal listId={viewList.id} listName={viewList.name} onClose={() => setViewList(null)} onChanged={() => void fetchAll()} />}
    </DashboardLayout>
  )
}
