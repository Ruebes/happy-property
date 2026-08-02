import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import { CustomSelect } from '../../../components/CustomSelect'

// ── Eigentümer-Inhalte ────────────────────────────────────────────────────────
// Sven lädt Videos (Botschaften) oder Dokumente (z.B. Steuer-Leitfaden) für das
// Eigentümerportal hoch — mit eigenem Titel, für ALLE Eigentümer oder gezielt
// für eine Wohnung. Auf Wunsch benachrichtigt Lotte die betroffenen Eigentümer
// per Mail + WhatsApp (Edge owner-content, action notify).

interface OwnerDoc {
  id: string; title: string; description: string; kind: string
  file_url: string; storage_path: string; property_id: string | null
  notified_at: string | null; created_at: string
}
interface PropOpt { id: string; label: string }

export default function OwnerContent() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const [docs, setDocs] = useState<OwnerDoc[]>([])
  const [props, setProps] = useState<PropOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [target, setTarget] = useState('all')
  const [file, setFile] = useState<File | null>(null)
  const [notify, setNotify] = useState(true)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 5000) }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: d, error }, { data: pr }] = await Promise.all([
        supabase.from('owner_documents').select('*').order('created_at', { ascending: false }),
        supabase.from('properties').select('id, project_name, unit_number, owner:profiles!properties_owner_id_fkey(full_name)').not('owner_id', 'is', null).order('project_name'),
      ])
      if (error) throw error
      setDocs((d as unknown as OwnerDoc[]) ?? [])
      setProps(((pr ?? []) as unknown as Array<{ id: string; project_name: string | null; unit_number: string | null; owner: { full_name: string | null } | null }>).map(x => ({
        id: x.id, label: `${x.project_name ?? '?'} ${x.unit_number ?? ''} · ${x.owner?.full_name ?? '—'}`.trim(),
      })))
    } catch (err) {
      console.error('[OwnerContent] fetchAll:', err)
      setDocs([])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void fetchAll() }, [fetchAll])

  const upload = async () => {
    if (!file || !title.trim() || busy) return
    setBusy(true)
    try {
      const isVideo = file.type.startsWith('video/')
      const ext = file.name.split('.').pop() ?? 'bin'
      const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: upErr } = await supabase.storage.from('owner-docs').upload(path, file, { contentType: file.type || undefined })
      if (upErr) throw upErr
      const url = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/owner-docs/${path}`
      const { data: row, error } = await supabase.from('owner_documents').insert({
        title: title.trim(), kind: isVideo ? 'video' : 'document',
        file_url: url, storage_path: path,
        property_id: target === 'all' ? null : target,
        created_by: profile?.id ?? null,
      }).select('id').single()
      if (error) throw error
      let msg = `✓ ${t('crm.ownerContent.uploaded', 'Hochgeladen')}`
      if (notify) {
        const { data: nd, error: ne } = await supabase.functions.invoke('owner-content', { body: { action: 'notify', doc_id: (row as { id: string }).id } })
        const n = (nd ?? {}) as { success?: boolean; recipients?: number; error?: string }
        msg += ne || n.error ? ` — ❌ ${t('crm.ownerContent.notifyFail', 'Benachrichtigung fehlgeschlagen')}: ${n.error ?? ne?.message}` : ` — 🐾 ${t('crm.ownerContent.notified', '{{n}} Eigentümer benachrichtigt', { n: n.recipients ?? 0 })}`
      }
      showToast(msg)
      setTitle(''); setFile(null); if (fileRef.current) fileRef.current.value = ''
      await fetchAll()
    } catch (err) {
      showToast(`❌ ${err instanceof Error ? err.message : 'Fehler'}`)
    } finally { setBusy(false) }
  }

  const saveRename = async (d: OwnerDoc) => {
    if (!renameVal.trim()) { setRenameId(null); return }
    const { error } = await supabase.from('owner_documents').update({ title: renameVal.trim() }).eq('id', d.id)
    if (error) showToast(`❌ ${error.message}`)
    setRenameId(null); await fetchAll()
  }
  const remove = async (d: OwnerDoc) => {
    if (!window.confirm(t('crm.ownerContent.delConfirm', '„{{t}}" für die Eigentümer löschen?', { t: d.title }) as string)) return
    await supabase.storage.from('owner-docs').remove([d.storage_path]).catch(() => null)
    const { error } = await supabase.from('owner_documents').delete().eq('id', d.id)
    if (error) { showToast(`❌ ${error.message}`); return }
    setDocs(arr => arr.filter(x => x.id !== d.id))
  }
  const notifyNow = async (d: OwnerDoc) => {
    const scope = d.property_id ? props.find(p => p.id === d.property_id)?.label ?? '1 Wohnung' : t('crm.ownerContent.allOwners', 'ALLE Eigentümer')
    if (!window.confirm(t('crm.ownerContent.notifyConfirm', 'Lotte benachrichtigt jetzt {{s}} per Mail + WhatsApp. Fortfahren?', { s: scope }) as string)) return
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('owner-content', { body: { action: 'notify', doc_id: d.id } })
      const n = (data ?? {}) as { success?: boolean; recipients?: number; error?: string }
      if (error || n.error) throw new Error(n.error ?? error?.message)
      showToast(`🐾 ${t('crm.ownerContent.notified', '{{n}} Eigentümer benachrichtigt', { n: n.recipients ?? 0 })}`)
      await fetchAll()
    } catch (err) { showToast(`❌ ${err instanceof Error ? err.message : 'Fehler'}`) } finally { setBusy(false) }
  }

  const input = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'
  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">📢 {t('crm.ownerContent.title', 'Eigentümer-Inhalte')}</h1>
          <p className="text-sm text-gray-500 mt-1">{t('crm.ownerContent.subtitle', 'Videos & Dokumente fürs Eigentümerportal — für alle oder gezielt für eine Wohnung. Lotte sagt den Eigentümern Bescheid.')}</p>
        </div>

        {/* Upload */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
          <input value={title} onChange={e => setTitle(e.target.value)} className={input} placeholder={t('crm.ownerContent.titlePh', 'Titel, z.B. „So werden deine Mieteinnahmen auf Zypern versteuert"')} />
          <div className="flex flex-wrap gap-3 items-center">
            <input ref={fileRef} type="file" accept="video/*,application/pdf,.doc,.docx,.xls,.xlsx,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="text-sm text-gray-600 file:mr-3 file:px-4 file:py-2 file:rounded-xl file:border-0 file:bg-gray-100 file:text-gray-700 file:font-medium file:cursor-pointer" />
            <div className="min-w-[260px] flex-1">
              <CustomSelect value={target} onChange={v => setTarget(v)} options={[{ value: 'all', label: `👥 ${t('crm.ownerContent.allOwners', 'ALLE Eigentümer')}` }, ...props.map(p => ({ value: p.id, label: `🏠 ${p.label}` }))]} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} className="accent-orange-500" />
            🐾 {t('crm.ownerContent.notifyToggle', 'Eigentümer sofort von Lotte benachrichtigen lassen (Mail + WhatsApp)')}
          </label>
          <button onClick={() => void upload()} disabled={busy || !file || !title.trim()}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
            {busy ? t('crm.ownerContent.uploading', 'Lädt hoch…') : `⬆️ ${t('crm.ownerContent.upload', 'Hochladen')}`}
          </button>
        </div>

        {/* Liste */}
        {loading ? (
          <div className="flex justify-center py-10"><div className="w-8 h-8 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : docs.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">{t('crm.ownerContent.empty', 'Noch nichts hochgeladen.')}</p>
        ) : (
          <div className="space-y-2">
            {docs.map(d => (
              <div key={d.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-start gap-3">
                <span className="text-2xl shrink-0">{d.kind === 'video' ? '🎬' : '📄'}</span>
                <div className="min-w-0 flex-1">
                  {renameId === d.id ? (
                    <div className="flex gap-2">
                      <input value={renameVal} onChange={e => setRenameVal(e.target.value)} className={input} autoFocus
                        onKeyDown={e => { if (e.key === 'Enter') void saveRename(d) }} />
                      <button onClick={() => void saveRename(d)} className="text-sm px-3 rounded-lg text-white" style={{ backgroundColor: '#ff795d' }}>✓</button>
                    </div>
                  ) : (
                    <p className="font-semibold text-gray-900 text-sm">{d.title}</p>
                  )}
                  <p className="text-xs text-gray-400 mt-0.5">
                    {d.property_id ? `🏠 ${props.find(p => p.id === d.property_id)?.label ?? t('crm.ownerContent.oneUnit', 'eine Wohnung')}` : `👥 ${t('crm.ownerContent.allOwners', 'ALLE Eigentümer')}`}
                    {' · '}{new Date(d.created_at).toLocaleDateString('de-DE')}
                    {d.notified_at && <span className="ml-1 text-green-600">· 🐾 {t('crm.ownerContent.notifiedBadge', 'benachrichtigt')}</span>}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                  <a href={d.file_url} target="_blank" rel="noreferrer" className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">👁</a>
                  <button onClick={() => { setRenameId(d.id); setRenameVal(d.title) }} className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">✏️</button>
                  {!d.notified_at && <button onClick={() => void notifyNow(d)} disabled={busy} className="text-xs px-2.5 py-1.5 rounded-lg border border-orange-200 text-orange-600 hover:bg-orange-50">🐾 {t('crm.ownerContent.notifyBtn', 'Benachrichtigen')}</button>}
                  <button onClick={() => void remove(d)} className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-400 hover:bg-red-50 hover:text-red-600">🗑</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {toast && <div className="fixed bottom-6 right-6 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg z-50 max-w-sm">{toast}</div>}
    </DashboardLayout>
  )
}
