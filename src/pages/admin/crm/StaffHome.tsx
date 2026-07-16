import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth, hasPerm, type PermissionArea } from '../../../lib/auth'

// ── Mitarbeiter-Startseite ───────────────────────────────────────────────────
// Landeseite nach dem Login. Aufgaben stehen im Zentrum; jede:r stellt sich die
// Seite über Widgets selbst zusammen (an/aus + Reihenfolge, gespeichert in
// profiles.dashboard_prefs). Verfügbare Widgets sind nach freigeschalteten
// Rechten gefiltert.

type TaskStatus = 'offen' | 'in_arbeit' | 'erledigt'
interface Task {
  id: string; title: string; description: string | null
  created_by: string; assigned_to: string | null; status: TaskStatus
  due_date: string | null; created_at: string
}
interface Staff { id: string; full_name: string; email: string; role: string }
interface Appt { id: string; title: string | null; start_time: string; type: string | null }

type WidgetId = 'my_tasks' | 'created_tasks' | 'appointments_today' | 'quick_links'
interface WidgetDef { id: WidgetId; perm: PermissionArea | null }
// Katalog in Standard-Reihenfolge. perm=null → immer verfügbar.
const CATALOG: WidgetDef[] = [
  { id: 'my_tasks',           perm: null },
  { id: 'created_tasks',      perm: null },
  { id: 'appointments_today', perm: 'pipeline' },
  { id: 'quick_links',        perm: null },
]

// Status → Farbakzent (angenommene Aufgaben = amber, erledigt = grün).
const STATUS_STYLE: Record<TaskStatus, { accent: string; bg: string; label: string }> = {
  offen:     { accent: '#94a3b8', bg: '#ffffff', label: 'Gestellt' },
  in_arbeit: { accent: '#f59e0b', bg: '#fffbeb', label: 'In Arbeit' },
  erledigt:  { accent: '#10b981', bg: '#f0fdf4', label: 'Erledigt' },
}

const d2 = (s: string) => new Date(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
const isOverdue = (t: Task) => !!t.due_date && t.status !== 'erledigt' && t.due_date < new Date().toISOString().slice(0, 10)

export default function StaffHome() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const navigate = useNavigate()
  const myId = profile?.id ?? ''

  const [tasks, setTasks] = useState<Task[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [appts, setAppts] = useState<Appt[]>([])
  const [myAssigneeIds, setMyAssigneeIds] = useState<Set<string>>(new Set())
  const [order, setOrder] = useState<WidgetId[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving]   = useState(false)

  const canPipeline = hasPerm(profile, 'pipeline')
  // Nach Rechten gefilterter Katalog.
  const available = CATALOG.filter(w => !w.perm || hasPerm(profile, w.perm))
  const availableIds = available.map(w => w.id)

  const nameOf = (id: string | null) => (id && staff.find(s => s.id === id)?.full_name) || t('crm.tasks.external', 'extern')

  const fetchAll = useCallback(async () => {
    if (!myId) return
    setLoading(true)
    try {
      const now = new Date()
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
      const dayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
      const [tRes, sRes, pRes, aRes, asgRes] = await Promise.all([
        supabase.from('crm_tasks')
          .select('id, title, description, created_by, assigned_to, status, due_date, created_at')
          .eq('archived', false).order('created_at', { ascending: false }),
        supabase.rpc('list_staff'),
        supabase.from('profiles').select('dashboard_prefs').eq('id', myId).single(),
        canPipeline
          ? supabase.from('crm_appointments').select('id, title, start_time, type')
              .gte('start_time', dayStart).lt('start_time', dayEnd).order('start_time', { ascending: true })
          : Promise.resolve({ data: [], error: null }),
        supabase.from('crm_task_assignees').select('task_id').eq('profile_id', myId),
      ])
      if (tRes.error) throw tRes.error
      setTasks((tRes.data ?? []) as Task[])
      setStaff((sRes.data ?? []) as Staff[])
      setAppts((aRes.data ?? []) as Appt[])
      setMyAssigneeIds(new Set(((asgRes.data ?? []) as { task_id: string }[]).map(r => r.task_id)))
      // Prefs laden; leere/unbekannte Werte → Standard = alle verfügbaren Widgets.
      const prefs = (pRes.data?.dashboard_prefs ?? {}) as { widgets?: unknown }
      const saved = Array.isArray(prefs.widgets) ? (prefs.widgets as string[]) : null
      // saved === null → noch nie angepasst → Standard = alle verfügbaren Widgets.
      // saved === [] (bewusst alle aus) bleibt leer. Ungültige (Recht entzogen) fallen raus.
      setOrder(saved
        ? saved.filter((id): id is WidgetId => availableIds.includes(id as WidgetId))
        : availableIds)
    } catch (err) {
      console.error('[StaffHome] fetch:', err)
      setTasks([]); setOrder(availableIds)
    } finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId, canPipeline])
  useEffect(() => { fetchAll() }, [fetchAll])

  const savePrefs = async (next: WidgetId[]) => {
    setOrder(next); setSaving(true)
    try {
      const { error } = await supabase.from('profiles').update({ dashboard_prefs: { widgets: next } }).eq('id', myId)
      if (error) throw error
    } catch (err) { console.error('[StaffHome] savePrefs:', err) } finally { setSaving(false) }
  }

  const toggle = (id: WidgetId) => {
    const next = order.includes(id) ? order.filter(x => x !== id) : [...order, id]
    savePrefs(next)
  }
  const move = (id: WidgetId, dir: -1 | 1) => {
    const i = order.indexOf(id); const j = i + dir
    if (i < 0 || j < 0 || j >= order.length) return
    const next = [...order]; ;[next[i], next[j]] = [next[j], next[i]]
    savePrefs(next)
  }

  const isMine       = (x: Task) => x.assigned_to === myId || myAssigneeIds.has(x.id)
  const myOpenTasks  = tasks.filter(x => isMine(x) && x.status !== 'erledigt')
    .sort((a, b) => (isOverdue(b) ? 1 : 0) - (isOverdue(a) ? 1 : 0)
      || (a.due_date || '9999').localeCompare(b.due_date || '9999'))
  const createdTasks = tasks.filter(x => x.created_by === myId && !isMine(x))

  // ── Aufgaben-Kachel ──────────────────────────────────────────────────────
  const TaskRow = ({ tk, showAssignee }: { tk: Task; showAssignee?: boolean }) => {
    const st = STATUS_STYLE[tk.status]
    const overdue = isOverdue(tk)
    return (
      <button onClick={() => navigate('/admin/crm/tasks')}
        className="w-full text-left rounded-xl border p-3 hover:shadow-sm transition-shadow"
        style={{ backgroundColor: st.bg, borderColor: '#f1f1f1', borderLeft: `3px solid ${st.accent}` }}>
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium text-gray-900 text-sm">{tk.title}</span>
          <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: st.accent }}>{st.label}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-[11px] text-gray-400">
          <span>{t('crm.tasks.createdOn', 'Gestellt')} {d2(tk.created_at)}</span>
          {tk.due_date && (
            <span className={overdue ? 'text-red-500 font-semibold' : ''}>
              {t('crm.tasks.due', 'Frist')} {d2(tk.due_date)}{overdue ? ` · ${t('crm.tasks.overdue', 'überfällig')}` : ''}
            </span>
          )}
          {showAssignee && <span>→ {nameOf(tk.assigned_to)}</span>}
        </div>
      </button>
    )
  }

  const CardShell = ({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) => (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
        {count !== undefined && <span className="text-xs text-gray-400">{count}</span>}
      </div>
      {children}
    </div>
  )

  // ── einzelne Widgets ──────────────────────────────────────────────────────
  const renderWidget = (id: WidgetId) => {
    switch (id) {
      case 'my_tasks':
        return (
          <CardShell title={t('crm.home.myTasks', 'Meine Aufgaben')} count={myOpenTasks.length}>
            {myOpenTasks.length === 0
              ? <p className="text-xs text-gray-400 py-3 text-center">{t('crm.home.noTasks', 'Keine offenen Aufgaben. 🎉')}</p>
              : <div className="space-y-2">{myOpenTasks.map(tk => <TaskRow key={tk.id} tk={tk} />)}</div>}
          </CardShell>
        )
      case 'created_tasks':
        return (
          <CardShell title={t('crm.home.createdTasks', 'Von mir gestellt')} count={createdTasks.length}>
            {createdTasks.length === 0
              ? <p className="text-xs text-gray-400 py-3 text-center">{t('crm.home.noCreated', 'Du hast noch keine Aufgaben verteilt.')}</p>
              : <div className="space-y-2">{createdTasks.map(tk => <TaskRow key={tk.id} tk={tk} showAssignee />)}</div>}
          </CardShell>
        )
      case 'appointments_today':
        return (
          <CardShell title={t('crm.home.apptsToday', 'Termine heute')} count={appts.length}>
            {appts.length === 0
              ? <p className="text-xs text-gray-400 py-3 text-center">{t('crm.home.noAppts', 'Heute keine Termine.')}</p>
              : <div className="space-y-2">
                  {appts.map(a => (
                    <button key={a.id} onClick={() => navigate('/admin/crm/calendar')}
                      className="w-full text-left rounded-xl border border-gray-100 p-3 hover:shadow-sm transition-shadow">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-gray-900 text-sm truncate">{a.title || t('crm.home.appt', 'Termin')}</span>
                        <span className="shrink-0 text-xs text-gray-500">{new Date(a.start_time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </button>
                  ))}
                </div>}
          </CardShell>
        )
      case 'quick_links': {
        const links: { to: string; label: string }[] = [
          { to: '/admin/crm/tasks', label: t('crm.nav.tasks', 'Aufgaben') },
          ...(hasPerm(profile, 'pipeline') ? [
            { to: '/admin/crm/pipeline', label: t('crm.nav.pipeline', 'Pipeline') },
            { to: '/admin/crm/leads',    label: t('crm.nav.leads', 'Leads') },
            { to: '/admin/crm/calendar', label: t('crm.nav.calendar', 'Kalender') },
          ] : []),
          ...(hasPerm(profile, 'funnel') ? [
            { to: '/admin/crm/funnel',     label: t('crm.nav.funnel', 'Funnel') },
            { to: '/admin/crm/newsletter', label: t('crm.nav.newsletter', 'Newsletter') },
          ] : []),
          ...(hasPerm(profile, 'invoices') ? [{ to: '/admin/crm/invoices', label: t('crm.nav.invoices', 'Rechnungen') }] : []),
          ...(hasPerm(profile, 'contacts') ? [{ to: '/admin/crm/settings/contacts', label: t('crm.nav.contacts', 'Kontakte') }] : []),
        ]
        return (
          <CardShell title={t('crm.home.quickLinks', 'Schnellzugriff')}>
            <div className="flex flex-wrap gap-2">
              {links.map(l => (
                <button key={l.to} onClick={() => navigate(l.to)}
                  className="text-xs font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 border border-gray-100 rounded-lg px-3 py-1.5">
                  {l.label}
                </button>
              ))}
            </div>
          </CardShell>
        )
      }
    }
  }

  const first = (profile?.full_name || '').split(' ')[0]

  return (
    <DashboardLayout basePath="/admin/crm/home">
      <div className="p-6 space-y-5 max-w-5xl mx-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {t('crm.home.hello', 'Hallo')}{first ? `, ${first}` : ''} 👋
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {new Date().toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long' })}
            </p>
          </div>
          <button onClick={() => setEditing(e => !e)}
            className={`px-3 py-1.5 rounded-xl text-sm font-medium whitespace-nowrap border ${editing ? 'text-white border-transparent' : 'text-gray-600 border-gray-200 hover:bg-gray-50'}`}
            style={editing ? { backgroundColor: '#ff795d' } : undefined}>
            {editing ? t('crm.home.done', 'Fertig') : `⚙︎ ${t('crm.home.customize', 'Anpassen')}`}
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : (
          <>
            {/* Anpassen-Panel: Widgets an/aus + Reihenfolge */}
            {editing && (
              <div className="bg-gray-50 rounded-2xl border border-gray-100 p-4">
                <p className="text-xs text-gray-500 mb-3">{t('crm.home.customizeHint', 'Wähle, welche Kacheln du auf deiner Startseite sehen willst — und in welcher Reihenfolge.')}{saving ? ` · ${t('common.saving', 'speichert …')}` : ''}</p>
                <div className="space-y-2">
                  {available.map(w => {
                    const on = order.includes(w.id)
                    const pos = order.indexOf(w.id)
                    return (
                      <div key={w.id} className="flex items-center gap-3 bg-white rounded-xl border border-gray-100 px-3 py-2">
                        <button onClick={() => toggle(w.id)}
                          className={`w-9 h-5 rounded-full relative transition-colors ${on ? '' : 'bg-gray-200'}`}
                          style={on ? { backgroundColor: '#ff795d' } : undefined} aria-label="toggle">
                          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${on ? 'left-4' : 'left-0.5'}`} />
                        </button>
                        <span className="flex-1 text-sm text-gray-700">{t(`crm.home.widget.${w.id}`, WIDGET_FALLBACK[w.id])}</span>
                        {on && (
                          <div className="flex items-center gap-1">
                            <button onClick={() => move(w.id, -1)} disabled={pos <= 0}
                              className="w-7 h-7 rounded-lg border border-gray-200 text-gray-500 disabled:opacity-30 hover:bg-gray-50">↑</button>
                            <button onClick={() => move(w.id, 1)} disabled={pos >= order.length - 1}
                              className="w-7 h-7 rounded-lg border border-gray-200 text-gray-500 disabled:opacity-30 hover:bg-gray-50">↓</button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {order.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center">
                <p className="text-sm text-gray-400">{t('crm.home.empty', 'Keine Kacheln aktiv. Über „Anpassen" wieder einschalten.')}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {order.map(id => <div key={id}>{renderWidget(id)}</div>)}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  )
}

// Fallback-Labels für die Anpassen-Liste (falls i18n-Key fehlt).
const WIDGET_FALLBACK: Record<WidgetId, string> = {
  my_tasks: 'Meine Aufgaben',
  created_tasks: 'Von mir gestellt',
  appointments_today: 'Termine heute',
  quick_links: 'Schnellzugriff',
}
