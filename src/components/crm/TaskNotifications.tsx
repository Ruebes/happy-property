import { useState, useEffect, useSyncExternalStore } from 'react'
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
interface MsgPopup { id: string; task_id: string; body: string; from: string; title: string }
interface AssigneeRow { id: string; task: { id: string; title: string; created_by: string; archived: boolean | null; status: string } | null }

const POLL_MS = 30_000
const REFOCUS_MIN_AGE_MS = 15_000   // Rückkehr in den Tab: sofort prüfen, wenn die letzte Prüfung älter ist
const STAFF_TTL_MS = 10 * 60_000    // Namensliste (list_staff) so lange wiederverwenden

// Stand außerhalb der Komponente: Die alte Navigation baut sie auf jeder Seite
// neu auf. So fragt nicht jeder Seitenwechsel neu ab (höchstens alle 30 s), und
// ein gezeigter Hinweis bleibt nach dem Seitenwechsel stehen, bis er
// geschlossen oder geöffnet wird (notified_at ist beim Anzeigen schon gesetzt).
// Im Hintergrund-Tab ruht die Abfrage (kein Ton, keine System-Benachrichtigung,
// gezeigt wird erst im sichtbaren Tab); bei Rückkehr wird sofort geprüft.
interface Snapshot { user: string; accepts: AcceptPopup[]; msgs: MsgPopup[] }
const store: { at: number; busy: boolean; snap: Snapshot } = { at: 0, busy: false, snap: { user: '', accepts: [], msgs: [] } }
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const getSnap = () => store.snap
function setSnap(next: Snapshot): void { store.snap = next; listeners.forEach(l => l()) }

let staffCache: { user: string; at: number; names: Map<string, string> } | null = null
async function staffNames(myId: string): Promise<Map<string, string>> {
  if (staffCache && staffCache.user === myId && Date.now() - staffCache.at < STAFF_TTL_MS) return staffCache.names
  const { data: staff, error } = await supabase.rpc('list_staff')
  const names = new Map(((staff ?? []) as { id: string; full_name: string }[]).map(s => [s.id, s.full_name]))
  if (!error && staff) staffCache = { user: myId, at: Date.now(), names }
  return names
}

async function pollTasks(myId: string): Promise<void> {
  if (!myId || store.busy) return
  store.busy = true
  store.at = Date.now()
  try {
    const now = new Date().toISOString()
    const [asgRes, msgRes] = await Promise.all([
      // Noch nicht angenommene Zuständigkeiten (bleibt bis zur Annahme, auch nach Login).
      supabase.from('crm_task_assignees').select('id, task:crm_tasks!inner(id, title, created_by, archived, status)')
        .eq('profile_id', myId).is('accepted_at', null).limit(20),
      // Neue Chat-Nachrichten an mich (einmalig).
      // Mit Aufgabentitel: ein Popup "Rückfrage ..." ohne Bezug ist wertlos (15.9.).
      supabase.from('crm_task_messages').select('id, task_id, body, sender_id, task:crm_tasks(title)')
        .eq('recipient_id', myId).is('read_at', null).is('notified_at', null)
        .order('created_at', { ascending: true }).limit(5),
    ])
    const asgs = ((asgRes.data ?? []) as unknown as AssigneeRow[]).filter(a => a.task && !a.task.archived && a.task.status !== 'erledigt' && a.task.created_by !== myId)
    const newMsgs = (msgRes.data ?? []) as unknown as { id: string; task_id: string; body: string; sender_id: string; task: { title: string } | null }[]

    // Namen braucht es nur, wenn es etwas zu zeigen gibt.
    const nameById = asgs.length || newMsgs.length ? await staffNames(myId) : new Map<string, string>()
    if (store.snap.user !== myId) return   // inzwischen abgemeldet oder anderer Nutzer

    // Annehmen-Popups: den ganzen Satz ersetzen (verschwinden nach Annahme von selbst).
    const accepts = asgs.flatMap(a => a.task ? [{
      id: `asg-${a.id}`, task_id: a.task.id, title: a.task.title,
      from: nameById.get(a.task.created_by) || '', creator: a.task.created_by,
    }] : [])

    // Nachrichten-Popups: anhängen, einmalig.
    const known = new Set(store.snap.msgs.map(m => m.id))
    const added = newMsgs.map(r => ({ id: `msg-${r.id}`, task_id: r.task_id, body: r.body, from: nameById.get(r.sender_id) || '', title: r.task?.title ?? '' }))
      .filter(m => !known.has(m.id))
    setSnap({ user: myId, accepts, msgs: added.length ? [...store.snap.msgs, ...added] : store.snap.msgs })
    if (newMsgs.length) {
      await supabase.from('crm_task_messages').update({ notified_at: now }).in('id', newMsgs.map(r => r.id))
    }
  } catch (e) { console.warn('[TaskNotifications] poll:', e) } finally { store.busy = false }
}

export default function TaskNotifications() {
  const { profile } = useAuth()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const snap = useSyncExternalStore(subscribe, getSnap)
  const [accepting, setAccepting] = useState<string | null>(null)
  const myId = profile?.id ?? ''
  const myName = profile?.full_name ?? ''
  const isStaff = ['admin', 'verwalter', 'mitarbeiter', 'funnel'].includes(profile?.role ?? '')
  const accepts = snap.user === myId ? snap.accepts : []
  const msgs = snap.user === myId ? snap.msgs : []

  useEffect(() => {
    if (!isStaff || !myId) return
    if (store.snap.user !== myId) { store.at = 0; setSnap({ user: myId, accepts: [], msgs: [] }) }
    let timer: ReturnType<typeof setTimeout> | null = null
    // Prüft, sobald die letzte Prüfung minAge alt ist; sonst Termin für später.
    const tick = (minAge = POLL_MS) => {
      if (timer) clearTimeout(timer)
      timer = null
      if (document.hidden) return   // Hintergrund-Tab: Pause bis zur Rückkehr
      const age = Date.now() - store.at
      if (age >= minAge) { void pollTasks(myId); timer = setTimeout(() => tick(), POLL_MS) }
      else timer = setTimeout(() => tick(), POLL_MS - age)
    }
    const onVisibility = () => {
      if (document.hidden) { if (timer) clearTimeout(timer); timer = null; return }
      tick(REFOCUS_MIN_AGE_MS)
    }
    tick()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [isStaff, myId])

  if (!isStaff || (accepts.length === 0 && msgs.length === 0)) return null

  const doAccept = async (p: AcceptPopup) => {
    setAccepting(p.id)
    try {
      await acceptTask(p.task_id, myId, myName, p.creator)
      setSnap({ ...store.snap, accepts: store.snap.accepts.filter(x => x.id !== p.id) })   // Popup schließt sich
    } catch (e) { console.error('[TaskNotifications] accept:', e) } finally { setAccepting(null) }
  }
  // Direkt in die Aufgabe springen (Tasks.tsx liest ?task=), nicht nur zur Liste.
  const openTask = (taskId?: string) => { setSnap({ ...store.snap, msgs: [] }); navigate(taskId ? `/admin/crm/tasks?task=${taskId}` : '/admin/crm/tasks') }
  const dismissMsg = (id: string) => setSnap({ ...store.snap, msgs: store.snap.msgs.filter(x => x.id !== id) })

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
            <button onClick={() => openTask(p.task_id)} className="text-xs font-medium text-gray-500 px-2 py-2 rounded-lg border border-gray-200 hover:bg-gray-50">
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
          {p.title && <p className="text-xs font-semibold text-gray-700 mt-1 line-clamp-2">📋 {p.title}</p>}
          {p.from && <p className="text-xs text-gray-400 mt-0.5">{t('crm.tasks.from', 'von')} {p.from}</p>}
          <p className="text-sm text-gray-700 mt-1 line-clamp-3">{p.body}</p>
          <button onClick={() => openTask(p.task_id)} className="mt-2 text-xs font-semibold text-white px-3 py-1.5 rounded-lg" style={{ backgroundColor: '#ff795d' }}>
            {t('crm.tasks.openTask', 'Zur Aufgabe')} →
          </button>
        </div>
      ))}
    </div>
  )
}
