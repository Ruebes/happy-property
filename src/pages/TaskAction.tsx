import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ── Öffentliche Aufgaben-Seite (per Token, kein Login) ───────────────────────
// Aufgerufen über den Link aus Erinnerungs-Mail/WhatsApp. Der/die Zuständige kann
// die Aufgabe annehmen, als erledigt markieren und eine Bemerkung hinterlassen.
interface Info { title: string; description: string | null; statusLabel: string; assignee: string; accepted: boolean; done: boolean; status: string }

const CORAL = '#ff795d'

export default function TaskAction() {
  const { token } = useParams<{ token: string }>()
  const [info, setInfo] = useState<Info | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [flash, setFlash] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const { data, error } = await supabase.functions.invoke('task-action', { body: { token, action: 'info' } })
      if (error || !data || data.error) { setErr('Dieser Link ist ungültig oder abgelaufen.'); return }
      setInfo(data as Info)
    } catch { setErr('Etwas ist schiefgelaufen.') } finally { setLoading(false) }
  }, [token])
  useEffect(() => { load() }, [load])

  const act = async (action: 'accept' | 'done' | 'note') => {
    setBusy(action); setFlash('')
    try {
      const { data, error } = await supabase.functions.invoke('task-action', { body: { token, action, note: note.trim() || undefined } })
      if (error || data?.error) { setFlash('Konnte nicht gespeichert werden.'); return }
      if (action === 'note') { setFlash('Bemerkung gesendet ✓'); setNote('') }
      else { setNote(''); await load(); setFlash(action === 'done' ? 'Als erledigt markiert ✓' : 'Angenommen ✓') }
    } catch { setFlash('Konnte nicht gespeichert werden.') } finally { setBusy('') }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'linear-gradient(160deg,#fff5f2 0%,#faf7f4 100%)' }}>
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl border border-gray-100 overflow-hidden">
        <div className="px-6 py-5" style={{ backgroundColor: CORAL }}>
          <p className="text-white/80 text-xs font-semibold tracking-wide uppercase">Happy Property · Aufgabe</p>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : err ? (
          <div className="p-8 text-center text-gray-500 text-sm">{err}</div>
        ) : info ? (
          <div className="p-6 space-y-5">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full text-white"
                  style={{ backgroundColor: info.status === 'erledigt' ? '#10b981' : info.status === 'in_arbeit' ? '#f59e0b' : '#94a3b8' }}>
                  {info.statusLabel}
                </span>
              </div>
              <h1 className="text-xl font-bold text-gray-900">{info.title}</h1>
              {info.description && <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">{info.description}</p>}
              <p className="text-xs text-gray-400 mt-3">Hallo {info.assignee.split(' ')[0]}, diese Aufgabe ist dir zugeordnet.</p>
            </div>

            {info.done ? (
              <div className="rounded-2xl bg-green-50 border border-green-100 p-4 text-center">
                <p className="text-2xl">🎉</p>
                <p className="text-sm font-medium text-green-800 mt-1">Diese Aufgabe ist erledigt. Danke!</p>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {!info.accepted && (
                    <button onClick={() => act('accept')} disabled={!!busy}
                      className="w-full py-3 rounded-xl text-white text-sm font-semibold disabled:opacity-60" style={{ backgroundColor: '#f59e0b' }}>
                      {busy === 'accept' ? '…' : '✋ Aufgabe annehmen'}
                    </button>
                  )}
                  <button onClick={() => act('done')} disabled={!!busy}
                    className="w-full py-3 rounded-xl text-white text-sm font-semibold disabled:opacity-60" style={{ backgroundColor: '#10b981' }}>
                    {busy === 'done' ? '…' : '🏁 Als erledigt markieren'}
                  </button>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Bemerkung / Rückfrage (optional)</label>
                  <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                    placeholder="Kurze Nachricht an Happy Property …" />
                  <button onClick={() => act('note')} disabled={!!busy || !note.trim()}
                    className="mt-2 w-full py-2.5 rounded-xl text-sm font-semibold border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                    {busy === 'note' ? '…' : 'Bemerkung senden'}
                  </button>
                </div>
              </>
            )}

            {flash && <p className="text-center text-sm font-medium" style={{ color: CORAL }}>{flash}</p>}
          </div>
        ) : null}

        <div className="px-6 py-3 border-t border-gray-50 text-center">
          <a href="https://happy-property.com" className="text-[11px] text-gray-400">happy-property.com</a>
        </div>
      </div>
    </div>
  )
}
