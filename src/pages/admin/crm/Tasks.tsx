import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'

// ── Aufgaben ────────────────────────────────────────────────────────────────────
// Eigenständige Aufgaben, einem Mitarbeiter zugewiesen, Pipeline gestellt → in Arbeit
// → erledigt. Sichtbar: nur selbst gestellte + selbst zugewiesene (RLS). In-Task-Chat
// mit dem jeweils anderen (Popup + E-Mail). Erledigte werden zum Tagesende archiviert.

type TaskStatus = 'offen' | 'in_arbeit' | 'erledigt'
interface Task {
  id: string; title: string; description: string | null
  created_by: string; assigned_to: string; status: TaskStatus
  archived: boolean; completed_at: string | null; created_at: string
}
interface TaskMessage { id: string; task_id: string; sender_id: string; recipient_id: string; body: string; read_at: string | null; created_at: string }
interface Staff { id: string; full_name: string; email: string; role: string }

const COLUMNS: { status: TaskStatus; label: string; accent: string }[] = [
  { status: 'offen',     label: 'Gestellt',  accent: '#94a3b8' },
  { status: 'in_arbeit', label: 'In Arbeit', accent: '#f59e0b' },
  { status: 'erledigt',  label: 'Erledigt',  accent: '#10b981' },
]

// ── Aufgabe anlegen ──────────────────────────────────────────────────────────
function CreateModal({ staff, myId, onClose, onCreated }: { staff: Staff[]; myId: string; onClose: () => void; onCreated: (m: string) => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assignedTo, setAssignedTo] = useState(myId)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    if (!title.trim()) { setErr(t('crm.tasks.titleRequired', 'Bitte einen Titel angeben.')); return }
    setSaving(true); setErr('')
    try {
      const { error } = await supabase.from('crm_tasks').insert({
        title: title.trim(), description: description.trim() || null,
        created_by: myId, assigned_to: assignedTo, status: 'offen',
      })
      if (error) throw error
      onCreated(t('crm.tasks.created', 'Aufgabe angelegt'))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Fehler'); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">{t('crm.tasks.new', 'Neue Aufgabe')}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.tasks.titleLabel', 'Aufgabe')}</label>
            <input value={title} onChange={e => setTitle(e.target.value)} autoFocus
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
              placeholder={t('crm.tasks.titlePh', 'Kurzer Titel')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.tasks.descLabel', 'Beschreibung')}</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={4}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
              placeholder={t('crm.tasks.descPh', 'Details zur Aufgabe …')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.tasks.assignee', 'Zuweisen an')}</label>
            <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-orange-400">
              {staff.map(s => (
                <option key={s.id} value={s.id}>{s.full_name || s.email}{s.id === myId ? ` (${t('crm.tasks.me', 'ich')})` : ''}</option>
              ))}
            </select>
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-gray-600 hover:bg-gray-100">{t('common.cancel', 'Abbrechen')}</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
            {saving ? '…' : t('crm.tasks.create', 'Anlegen')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Aufgabe-Detail + Chat ────────────────────────────────────────────────────
function DetailModal({ task, staff, myId, onClose, onChanged }: { task: Task; staff: Staff[]; myId: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<TaskMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const nameOf = (id: string) => staff.find(s => s.id === id)?.full_name || staff.find(s => s.id === id)?.email || '—'
  const other = task.created_by === myId ? task.assigned_to : task.created_by   // Gegenpart

  const loadMsgs = useCallback(async () => {
    const { data } = await supabase.from('crm_task_messages').select('*').eq('task_id', task.id).order('created_at', { ascending: true })
    setMessages((data ?? []) as TaskMessage[])
    // eingehende als gelesen markieren
    await supabase.from('crm_task_messages').update({ read_at: new Date().toISOString() }).eq('task_id', task.id).eq('recipient_id', myId).is('read_at', null)
  }, [task.id, myId])
  useEffect(() => { loadMsgs() }, [loadMsgs])

  const setStatus = async (status: TaskStatus) => {
    const { error } = await supabase.from('crm_tasks').update({ status }).eq('id', task.id)
    if (!error) onChanged()
  }

  const send = async () => {
    if (!text.trim() || task.created_by === task.assigned_to) return
    setSending(true)
    const body = text.trim()
    try {
      const { error } = await supabase.from('crm_task_messages').insert({ task_id: task.id, sender_id: myId, recipient_id: other, body })
      if (error) throw error
      setText('')
      await loadMsgs()
      // E-Mail an den Gegenpart (fire-and-forget)
      const rec = staff.find(s => s.id === other)
      if (rec?.email) {
        supabase.functions.invoke('send-email', { body: {
          to: rec.email,
          subject: `Aufgabe: ${task.title}`,
          html: `<p>Hallo ${(rec.full_name || '').split(' ')[0]},</p><p>${nameOf(myId)} hat dir zu der Aufgabe <strong>${task.title}</strong> geschrieben:</p><blockquote style="border-left:3px solid #ff795d;padding-left:12px;color:#374151;">${body.replace(/</g, '&lt;')}</blockquote><p style="font-size:13px;color:#6b7280;">Antworte direkt in der App unter Aufgaben.</p>`,
        } }).catch(e => console.warn('[Tasks] Mail-Benachrichtigung:', e))
      }
    } catch (e) { console.error('[Tasks] send:', e) } finally { setSending(false) }
  }

  const canChat = task.created_by !== task.assigned_to

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 truncate">{task.title}</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {t('crm.tasks.from', 'von')} {nameOf(task.created_by)} · {t('crm.tasks.for', 'für')} {nameOf(task.assigned_to)}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none shrink-0">✕</button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          {task.description && <p className="text-sm text-gray-700 whitespace-pre-wrap">{task.description}</p>}

          {/* Status-Umschalter */}
          <div className="flex gap-2">
            {COLUMNS.map(c => (
              <button key={c.status} onClick={() => setStatus(c.status)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${task.status === c.status ? 'text-white border-transparent' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'}`}
                style={task.status === c.status ? { backgroundColor: c.accent } : undefined}>
                {c.label}
              </button>
            ))}
          </div>

          {/* Chat */}
          {canChat && (
            <div className="pt-2 border-t border-gray-100">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('crm.tasks.chat', 'Nachrichten')}</h3>
              <div className="space-y-2 max-h-52 overflow-y-auto mb-3">
                {messages.length === 0 && <p className="text-xs text-gray-400">{t('crm.tasks.noMsg', 'Noch keine Nachrichten.')}</p>}
                {messages.map(m => {
                  const mine = m.sender_id === myId
                  return (
                    <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-orange-100 text-gray-800' : 'bg-gray-100 text-gray-800'}`}>
                        <p className="whitespace-pre-wrap">{m.body}</p>
                        <p className="text-[10px] text-gray-400 mt-0.5">{new Date(m.created_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex gap-2">
                <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send() }}
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                  placeholder={t('crm.tasks.msgPh', 'Rückfrage oder Status …')} />
                <button onClick={send} disabled={sending || !text.trim()} className="px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
                  {t('crm.tasks.sendMsg', 'Senden')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Hauptseite ──────────────────────────────────────────────────────────────
export default function Tasks() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const myId = profile?.id ?? ''

  const [tasks, setTasks]   = useState<Task[]>([])
  const [staff, setStaff]   = useState<Staff[]>([])
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [detail, setDetail] = useState<Task | null>(null)
  const [toast, setToast]   = useState('')
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [tRes, sRes, mRes] = await Promise.all([
        supabase.from('crm_tasks').select('*').eq('archived', false).order('created_at', { ascending: false }),
        supabase.rpc('list_staff'),
        supabase.from('crm_task_messages').select('task_id').eq('recipient_id', myId).is('read_at', null),
      ])
      if (tRes.error) throw tRes.error
      setTasks((tRes.data ?? []) as Task[])
      setStaff((sRes.data ?? []) as Staff[])
      const u: Record<string, number> = {}
      for (const m of ((mRes.data ?? []) as { task_id: string }[])) u[m.task_id] = (u[m.task_id] ?? 0) + 1
      setUnread(u)
    } catch (err) {
      console.error('[Tasks] fetch:', err)
      setTasks([])
    } finally { setLoading(false) }
  }, [myId])
  useEffect(() => { fetchAll() }, [fetchAll])

  const nameOf = (id: string) => staff.find(s => s.id === id)?.full_name || '—'

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">{toast}</div>}

      <div className="p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('crm.tasks.title', 'Aufgaben')}</h1>
            <p className="text-sm text-gray-500 mt-0.5">{t('crm.tasks.subtitle', 'Aufgaben stellen, zuweisen und den Status verfolgen. Erledigte werden zum Tagesende archiviert.')}</p>
          </div>
          <button onClick={() => setCreating(true)} className="px-3 py-1.5 rounded-xl text-white text-sm font-medium whitespace-nowrap" style={{ backgroundColor: '#ff795d' }}>
            {t('crm.tasks.add', '+ Aufgabe')}
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {COLUMNS.map(col => {
              const colTasks = tasks.filter(x => x.status === col.status)
              return (
                <div key={col.status} className="bg-gray-50 rounded-2xl p-3">
                  <div className="flex items-center gap-2 mb-3 px-1">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: col.accent }} />
                    <span className="text-sm font-semibold text-gray-700">{col.label}</span>
                    <span className="text-xs text-gray-400">{colTasks.length}</span>
                  </div>
                  <div className="space-y-2">
                    {colTasks.length === 0 && <p className="text-xs text-gray-400 text-center py-6">—</p>}
                    {colTasks.map(task => {
                      const mine = task.created_by === myId
                      return (
                        <button key={task.id} onClick={() => setDetail(task)}
                          className="w-full text-left bg-white rounded-xl border border-gray-100 shadow-sm p-3 hover:border-gray-300 transition-colors">
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-medium text-gray-900 text-sm">{task.title}</span>
                            {unread[task.id] && <span className="shrink-0 text-[10px] font-bold text-white bg-red-500 rounded-full px-1.5 py-0.5">{unread[task.id]}</span>}
                          </div>
                          {task.description && <p className="text-xs text-gray-400 mt-1 line-clamp-2">{task.description}</p>}
                          <p className="text-[11px] text-gray-400 mt-2">
                            {mine ? `→ ${nameOf(task.assigned_to)}` : `${t('crm.tasks.fromShort', 'von')} ${nameOf(task.created_by)}`}
                          </p>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {creating && <CreateModal staff={staff} myId={myId} onClose={() => setCreating(false)} onCreated={(m) => { setCreating(false); showToast(m); fetchAll() }} />}
      {detail && <DetailModal task={detail} staff={staff} myId={myId} onClose={() => { setDetail(null); fetchAll() }} onChanged={fetchAll} />}
    </DashboardLayout>
  )
}
