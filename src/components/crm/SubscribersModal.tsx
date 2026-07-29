import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

// ── Abonnenten einer Empfängerliste ansehen / bearbeiten / entfernen ─────────
// Öffnet sich beim Klick auf eine Listenzeile. Zeigt alle Einträge (aus
// newsletter_list_members → newsletter_subscribers), erlaubt Inline-Bearbeiten
// (Name/E-Mail/Telefon) und „Aus Liste entfernen" (löscht die Mitgliedschaft,
// der Abonnent selbst bleibt für andere Listen erhalten).

interface Sub {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  optout_at: string | null
  source: string | null
  klaviyo_id: string | null
  properties: Record<string, unknown> | null
  added_at: string | null
}

const MAX = 1000

export default function SubscribersModal({ listId, listName, onClose, onChanged }: {
  listId: string; listName: string; onClose: () => void; onChanged?: () => void
}) {
  const { t } = useTranslation()
  const [subs, setSubs] = useState<Sub[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<Sub>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const { data, error } = await supabase.from('newsletter_list_members')
        .select('added_at, subscriber:newsletter_subscribers(id, email, first_name, last_name, phone, optout_at, source, klaviyo_id, properties)')
        .eq('list_id', listId).order('added_at', { ascending: false }).limit(MAX)
      if (error) throw error
      // deno-lint-ignore no-explicit-any
      const rows = ((data ?? []) as any[])
        .filter(m => m.subscriber)
        .map(m => ({ ...(m.subscriber as Sub), added_at: m.added_at as string | null }))
      setSubs(rows)
    } catch (e) {
      console.error('[SubscribersModal] load:', e); setErr(t('crm.subs.loadErr', 'Konnte die Einträge nicht laden.'))
    } finally { setLoading(false) }
  }, [listId, t])
  useEffect(() => { void load() }, [load])

  const statusOf = (s: Sub): { label: string; cls: string } => {
    if (s.optout_at) return { label: t('crm.subs.stOptout', 'Abgemeldet'), cls: 'bg-red-100 text-red-700' }
    if (s.properties?.doi_confirmed === true || s.klaviyo_id) return { label: t('crm.subs.stConfirmed', 'Bestätigt'), cls: 'bg-green-100 text-green-700' }
    return { label: t('crm.subs.stPending', 'Ausstehend'), cls: 'bg-amber-100 text-amber-700' }
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return subs
    return subs.filter(s => [s.email, s.first_name, s.last_name, s.phone].some(v => (v ?? '').toLowerCase().includes(needle)))
  }, [subs, q])

  const startEdit = (s: Sub) => { setEditId(s.id); setDraft({ first_name: s.first_name, last_name: s.last_name, email: s.email, phone: s.phone }); setErr('') }
  const cancelEdit = () => { setEditId(null); setDraft({}) }

  const saveEdit = async (id: string) => {
    setSavingId(id); setErr('')
    try {
      const patch = {
        first_name: (draft.first_name ?? '').trim() || null,
        last_name: (draft.last_name ?? '').trim() || null,
        email: (draft.email ?? '').trim().toLowerCase(),
        phone: (draft.phone ?? '').trim() || null,
      }
      if (!patch.email.includes('@')) { setErr(t('crm.subs.badEmail', 'Bitte eine gültige E-Mail angeben.')); setSavingId(null); return }
      const { error } = await supabase.from('newsletter_subscribers').update(patch).eq('id', id)
      if (error) throw error
      setSubs(list => list.map(s => s.id === id ? { ...s, ...patch } : s))
      cancelEdit()
    } catch (e) {
      console.error('[SubscribersModal] saveEdit:', e)
      setErr(t('crm.subs.saveErr', 'Speichern fehlgeschlagen (E-Mail vielleicht schon vergeben?).'))
    } finally { setSavingId(null) }
  }

  const remove = async (s: Sub) => {
    if (!window.confirm(t('crm.subs.removeConfirm', '„{{n}}" aus dieser Liste entfernen?', { n: s.email }))) return
    const prev = subs
    setSubs(list => list.filter(x => x.id !== s.id))
    const { error } = await supabase.from('newsletter_list_members').delete().eq('list_id', listId).eq('subscriber_id', s.id)
    if (error) { console.error('[SubscribersModal] remove:', error); setSubs(prev); setErr(t('crm.subs.removeErr', 'Entfernen fehlgeschlagen.')) }
    else onChanged?.()
  }

  const d2 = (s: string | null) => s ? new Date(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '–'
  const inp = 'w-full rounded-lg border border-gray-200 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400'

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-8 flex flex-col" style={{ maxHeight: '85vh' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-gray-900">👥 {listName}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{t('crm.subs.count', '{{n}} Einträge', { n: subs.length })}{subs.length >= MAX && ' ' + t('crm.subs.capped', '(erste 1000)')}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-gray-400 hover:bg-gray-100">✕</button>
        </div>

        <div className="px-6 py-3 border-b border-gray-50 shrink-0">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('crm.subs.search', 'Suchen (Name, E-Mail, Telefon) …')}
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400" />
        </div>

        {err && <p className="mx-6 mt-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</p>}

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
          ) : filtered.length === 0 ? (
            <p className="text-center text-sm text-gray-500 py-16">{subs.length === 0 ? t('crm.subs.empty', 'Diese Liste hat noch keine Einträge.') : t('crm.subs.noMatch', 'Kein Treffer.')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                  <th className="px-2 py-2">{t('crm.subs.name', 'Name')}</th>
                  <th className="px-2 py-2">{t('crm.subs.email', 'E-Mail')}</th>
                  <th className="px-2 py-2">{t('crm.subs.phone', 'Telefon')}</th>
                  <th className="px-2 py-2">{t('crm.subs.status', 'Status')}</th>
                  <th className="px-2 py-2">{t('crm.subs.added', 'Hinzugefügt')}</th>
                  <th className="px-2 py-2 text-right">{t('crm.subs.actions', 'Aktion')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(s => {
                  const st = statusOf(s)
                  const editing = editId === s.id
                  return (
                    <tr key={s.id} className="hover:bg-gray-50/60 align-middle">
                      <td className="px-2 py-2">
                        {editing ? (
                          <div className="flex gap-1">
                            <input className={inp} placeholder={t('crm.subs.first', 'Vorname')} value={draft.first_name ?? ''} onChange={e => setDraft(d => ({ ...d, first_name: e.target.value }))} />
                            <input className={inp} placeholder={t('crm.subs.last', 'Nachname')} value={draft.last_name ?? ''} onChange={e => setDraft(d => ({ ...d, last_name: e.target.value }))} />
                          </div>
                        ) : (
                          <span className="text-gray-800">{[s.first_name, s.last_name].filter(Boolean).join(' ') || '–'}</span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {editing ? <input className={inp} type="email" value={draft.email ?? ''} onChange={e => setDraft(d => ({ ...d, email: e.target.value }))} />
                          : <span className="text-gray-600">{s.email}</span>}
                      </td>
                      <td className="px-2 py-2">
                        {editing ? <input className={inp} type="tel" value={draft.phone ?? ''} onChange={e => setDraft(d => ({ ...d, phone: e.target.value }))} />
                          : <span className="text-gray-600">{s.phone || '–'}</span>}
                      </td>
                      <td className="px-2 py-2"><span className={`text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${st.cls}`}>{st.label}</span></td>
                      <td className="px-2 py-2 text-gray-400 whitespace-nowrap">{d2(s.added_at)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        {editing ? (
                          <div className="inline-flex gap-1">
                            <button onClick={() => void saveEdit(s.id)} disabled={savingId === s.id} className="px-2 py-1 rounded-lg text-xs font-medium text-white disabled:opacity-50" style={{ backgroundColor: '#ff795d' }}>
                              {savingId === s.id ? '…' : t('common.save', 'Speichern')}
                            </button>
                            <button onClick={cancelEdit} className="px-2 py-1 rounded-lg text-xs border border-gray-200 text-gray-500 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
                          </div>
                        ) : (
                          <div className="inline-flex gap-1">
                            <button onClick={() => startEdit(s)} className="w-7 h-7 rounded-lg text-gray-400 hover:text-orange-600 hover:bg-orange-50" title={t('common.edit', 'Bearbeiten')}>✏️</button>
                            <button onClick={() => void remove(s)} className="w-7 h-7 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50" title={t('crm.subs.remove', 'Aus Liste entfernen')}>🗑</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
