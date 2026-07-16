import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

// ── Aufgaben-Popup ──────────────────────────────────────────────────────────────
// Global (in DashboardLayout) eingebunden: pollt neue Task-Nachrichten an den
// aktuellen Nutzer und zeigt sie als In-App-Popup. Jede Nachricht poppt genau einmal
// (notified_at). Klick → zur Aufgaben-Seite. E-Mail-Benachrichtigung läuft separat.
interface Popup { id: string; task_id: string; body: string; from: string; kind: 'msg' | 'task' }

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
      const now = new Date().toISOString()
      const [msgRes, taskRes] = await Promise.all([
        // (1) neue Chat-Nachrichten an mich
        supabase.from('crm_task_messages').select('id, task_id, body, sender_id')
          .eq('recipient_id', myId).is('read_at', null).is('notified_at', null)
          .order('created_at', { ascending: true }).limit(5),
        // (2) neu an mich zugewiesene Aufgaben (nicht selbst gestellt)
        supabase.from('crm_tasks').select('id, title, description, created_by')
          .eq('assigned_to', myId).neq('created_by', myId).eq('archived', false)
          .is('assigned_notified_at', null).order('created_at', { ascending: true }).limit(5),
      ])
      const msgs  = (msgRes.data  ?? []) as { id: string; task_id: string; body: string; sender_id: string }[]
      const tasks = (taskRes.data ?? []) as { id: string; title: string; description: string | null; created_by: string }[]
      if (msgs.length === 0 && tasks.length === 0) return
      // Absender-/Ersteller-Namen holen
      const { data: staff } = await supabase.rpc('list_staff')
      const nameById = new Map(((staff ?? []) as { id: string; full_name: string }[]).map(s => [s.id, s.full_name]))
      const fresh: Popup[] = [
        ...tasks.map(tk => ({ id: `task-${tk.id}`, task_id: tk.id, kind: 'task' as const, body: tk.title, from: nameById.get(tk.created_by) || '' })),
        ...msgs.map(r  => ({ id: `msg-${r.id}`,   task_id: r.task_id, kind: 'msg'  as const, body: r.body,   from: nameById.get(r.sender_id)  || '' })),
      ]
      setPopups(prev => [...prev, ...fresh])
      // als benachrichtigt markieren → poppt nicht erneut
      if (msgs.length)  await supabase.from('crm_task_messages').update({ notified_at: now }).in('id', msgs.map(r => r.id))
      if (tasks.length) await supabase.from('crm_tasks').update({ assigned_notified_at: now }).in('id', tasks.map(tk => tk.id))
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
              <span className="text-lg">{p.kind === 'task' ? '📋' : '💬'}</span>
              <span className="text-sm font-semibold text-gray-900">
                {p.kind === 'task' ? t('crm.tasks.newTask', 'Neue Aufgabe für dich') : t('crm.tasks.newMsg', 'Neue Aufgaben-Nachricht')}
              </span>
            </div>
            <button onClick={() => dismiss(p.id)} className="text-gray-400 hover:text-gray-600 text-sm leading-none">✕</button>
          </div>
          {p.from && <p className="text-xs text-gray-400 mt-1">{t('crm.tasks.from', 'von')} {p.from}</p>}
          <p className={`text-sm text-gray-700 mt-1 line-clamp-3${p.kind === 'task' ? ' font-medium' : ''}`}>{p.body}</p>
          <button onClick={open} className="mt-2 text-xs font-semibold text-white px-3 py-1.5 rounded-lg" style={{ backgroundColor: '#ff795d' }}>
            {t('crm.tasks.openTask', 'Zur Aufgabe')} →
          </button>
        </div>
      ))}
    </div>
  )
}
