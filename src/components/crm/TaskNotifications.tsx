import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

// ── Aufgaben-Popup ──────────────────────────────────────────────────────────────
// Global (in DashboardLayout) eingebunden: pollt neue Task-Nachrichten an den
// aktuellen Nutzer und zeigt sie als In-App-Popup. Jede Nachricht poppt genau einmal
// (notified_at). Klick → zur Aufgaben-Seite. E-Mail-Benachrichtigung läuft separat.
interface Popup { id: string; task_id: string; body: string; from: string }

const POLL_MS = 30_000

export default function TaskNotifications() {
  const { profile } = useAuth()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [popups, setPopups] = useState<Popup[]>([])
  const busy = useRef(false)
  const myId = profile?.id ?? ''
  const isStaff = ['admin', 'verwalter', 'mitarbeiter', 'funnel'].includes(profile?.role ?? '')

  const poll = useCallback(async () => {
    if (!myId || busy.current) return
    busy.current = true
    try {
      const { data, error } = await supabase.from('crm_task_messages')
        .select('id, task_id, body, sender_id')
        .eq('recipient_id', myId).is('read_at', null).is('notified_at', null)
        .order('created_at', { ascending: true }).limit(5)
      if (error || !data || data.length === 0) return
      const rows = data as { id: string; task_id: string; body: string; sender_id: string }[]
      // Absendernamen holen
      const { data: staff } = await supabase.rpc('list_staff')
      const nameById = new Map(((staff ?? []) as { id: string; full_name: string }[]).map(s => [s.id, s.full_name]))
      setPopups(prev => [...prev, ...rows.map(r => ({ id: r.id, task_id: r.task_id, body: r.body, from: nameById.get(r.sender_id) || '' }))])
      // als benachrichtigt markieren → poppt nicht erneut
      await supabase.from('crm_task_messages').update({ notified_at: new Date().toISOString() }).in('id', rows.map(r => r.id))
    } catch (e) { console.warn('[TaskNotifications] poll:', e) } finally { busy.current = false }
  }, [myId])

  useEffect(() => {
    if (!isStaff) return
    poll()
    const iv = setInterval(poll, POLL_MS)
    return () => clearInterval(iv)
  }, [isStaff, poll])

  if (!isStaff || popups.length === 0) return null

  const dismiss = (id: string) => setPopups(p => p.filter(x => x.id !== id))
  const open = () => { setPopups([]); navigate('/admin/crm/tasks') }

  return (
    <div className="fixed bottom-4 right-4 z-[60] space-y-2 w-80 max-w-[calc(100vw-2rem)]">
      {popups.slice(-3).map(p => (
        <div key={p.id} className="bg-white rounded-2xl shadow-2xl border border-gray-100 p-4 animate-[fadeIn_0.2s_ease]">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">✅</span>
              <span className="text-sm font-semibold text-gray-900">{t('crm.tasks.newMsg', 'Neue Aufgaben-Nachricht')}</span>
            </div>
            <button onClick={() => dismiss(p.id)} className="text-gray-400 hover:text-gray-600 text-sm leading-none">✕</button>
          </div>
          {p.from && <p className="text-xs text-gray-400 mt-1">{t('crm.tasks.from', 'von')} {p.from}</p>}
          <p className="text-sm text-gray-700 mt-1 line-clamp-3">{p.body}</p>
          <button onClick={open} className="mt-2 text-xs font-semibold text-white px-3 py-1.5 rounded-lg" style={{ backgroundColor: '#ff795d' }}>
            {t('crm.tasks.openTask', 'Zur Aufgabe')} →
          </button>
        </div>
      ))}
    </div>
  )
}
