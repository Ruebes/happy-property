import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import { acceptTask } from '../../lib/crmTasks'

// ── Aufgaben-Popup ──────────────────────────────────────────────────────────────
// Global (in DashboardLayout) eingebunden.
//
// ZWEI Sorten Popup:
//  • ANNEHMEN-Popups: neue Aufgaben, die der Nutzer noch nicht angenommen hat.
//    Sie bleiben — auch beim nächsten Login — bis „Annehmen" gedrückt wird
//    (gated auf crm_task_assignees.accepted_at IS NULL, NICHT auf notified_at).
//    Klick auf Annehmen → Notiz „angenommen", Popup verschwindet, Aufgabe bleibt
//    aber in „Gestellt".
//  • NACHRICHTEN-Popups: neue Aufgaben-Chat-Nachrichten. Poppen genau einmal
//    (notified_at), reine Info.
interface AcceptPopup { id: string; task_id: string; title: string; from: string; creator: string }
interface MsgPopup { id: string; task_id: string; body: string; from: string }

const POLL_MS = 30_000

export default function TaskNotifications() {
  const { profile } = useAuth()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [accepts, setAccepts] = useState<AcceptPopup[]>([])
  const [msgs, setMsgs] = useState<MsgPopup[]>([])
  const [accepting, setAccepting] = useState<string | null>(null)
  const busy = useRef(false)
  const myId = profile?.id ?? ''
  const myName = profile?.full_name ?? ''
  const isStaff = ['admin', 'verwalter', 'mitarbeiter', 'funnel'].includes(profile?.role ?? '')

  const poll = useCallback(async () => {
    if (!myId || busy.current) return
    busy.current = true
    try {
      const now = new Date().toISOString()
      const [asgRes, msgRes] = await Promise.all([
        // Noch nicht angenommene Zuständigkeiten (bleibt bis zur Annahme, auch nach Login).
        supabase.from('crm_task_assignees').select('id, task:crm_tasks!inner(id, title, created_by, archived, status)')
          .eq('profile_id', myId).is('accepted_at', null).limit(20),
        // Neue Chat-Nachrichten an mich (einmalig).
        supabase.from('crm_task_messages').select('id, task_id, body, sender_id')
          .eq('recipient_id', myId).is('read_at', null).is('notified_at', null)
          .order('created_at', { ascending: true }).limit(5),
      ])
      // deno-lint-ignore no-explicit-any
      const asgs = ((asgRes.data ?? []) as any[]).filter(a => a.task && !a.task.archived && a.task.status !== 'erledigt' && a.task.created_by !== myId)
      const newMsgs = (msgRes.data ?? []) as { id: string; task_id: string; body: string; sender_id: string }[]

      const { data: staff } = await supabase.rpc('list_staff')
      const nameById = new Map(((staff ?? []) as { id: string; full_name: string }[]).map(s => [s.id, s.full_name]))

      // Annehmen-Popups: den ganzen Satz ersetzen (verschwinden nach Annahme von selbst).
      setAccepts(asgs.map(a => ({
        id: `asg-${a.id}`, task_id: a.task.id, title: a.task.title,
        from: nameById.get(a.task.created_by) || '', creator: a.task.created_by,
      })))

      // Nachrichten-Popups: anhängen, einmalig.
      if (newMsgs.length) {
        setMsgs(prev => [...prev, ...newMsgs.map(r => ({ id: `msg-${r.id}`, task_id: r.task_id, body: r.body, from: nameById.get(r.sender_id) || '' }))])
        await supabase.from('crm_task_messages').update({ notified_at: now }).in('id', newMsgs.map(r => r.id))
      }
    } catch (e) { console.warn('[TaskNotifications] poll:', e) } finally { busy.current = false }
  }, [myId])

  useEffect(() => {
    if (!isStaff) return
    void poll()
    const iv = setInterval(() => { void poll() }, POLL_MS)
    return () => clearInterval(iv)
  }, [isStaff, poll])

  if (!isStaff || (accepts.length === 0 && msgs.length === 0)) return null

  const doAccept = async (p: AcceptPopup) => {
    setAccepting(p.id)
    try {
      await acceptTask(p.task_id, myId, myName, p.creator)
      setAccepts(prev => prev.filter(x => x.id !== p.id))   // Popup schließt sich
    } catch (e) { console.error('[TaskNotifications] accept:', e) } finally { setAccepting(null) }
  }
  const openTask = () => { setMsgs([]); navigate('/admin/crm/tasks') }
  const dismissMsg = (id: string) => setMsgs(p => p.filter(x => x.id !== id))

  return (
    <div className="fixed bottom-4 right-4 z-[60] space-y-2 w-80 max-w-[calc(100vw-2rem)]">
      {/* Annehmen-Popups zuerst — sie sind eine Aktion, keine Info */}
      {accepts.slice(0, 3).map(p => (
        <div key={p.id} className="bg-white rounded-2xl shadow-2xl border border-amber-100 p-4 animate-[fadeIn_0.2s_ease]">
          <div className="flex items-center gap-2">
            <span className="text-lg">📋</span>
            <span className="text-sm font-semibold text-gray-900">{t('crm.tasks.newTask', 'Neue Aufgabe für dich')}</span>
          </div>
          {p.from && <p className="text-xs text-gray-400 mt-1">{t('crm.tasks.from', 'von')} {p.from}</p>}
          <p className="text-sm text-gray-700 mt-1 line-clamp-3 font-medium">{p.title}</p>
          <div className="flex items-center gap-2 mt-2.5">
            <button onClick={() => void doAccept(p)} disabled={accepting === p.id}
              className="flex-1 text-xs font-semibold text-white px-3 py-2 rounded-lg disabled:opacity-60" style={{ backgroundColor: '#10b981' }}>
              {accepting === p.id ? t('common.saving', '…') : `✋ ${t('crm.tasks.accept', 'Aufgabe annehmen')}`}
            </button>
            <button onClick={openTask} className="text-xs font-medium text-gray-500 px-2 py-2 rounded-lg border border-gray-200 hover:bg-gray-50">
              {t('crm.tasks.openTask', 'Öffnen')}
            </button>
          </div>
        </div>
      ))}
      {/* Nachrichten-Popups */}
      {msgs.slice(-2).map(p => (
        <div key={p.id} className="bg-white rounded-2xl shadow-2xl border border-gray-100 p-4 animate-[fadeIn_0.2s_ease]">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">💬</span>
              <span className="text-sm font-semibold text-gray-900">{t('crm.tasks.newMsg', 'Neue Aufgaben-Nachricht')}</span>
            </div>
            <button onClick={() => dismissMsg(p.id)} className="text-gray-400 hover:text-gray-600 text-sm leading-none">✕</button>
          </div>
          {p.from && <p className="text-xs text-gray-400 mt-1">{t('crm.tasks.from', 'von')} {p.from}</p>}
          <p className="text-sm text-gray-700 mt-1 line-clamp-3">{p.body}</p>
          <button onClick={openTask} className="mt-2 text-xs font-semibold text-white px-3 py-1.5 rounded-lg" style={{ backgroundColor: '#ff795d' }}>
            {t('crm.tasks.openTask', 'Zur Aufgabe')} →
          </button>
        </div>
      ))}
    </div>
  )
}
