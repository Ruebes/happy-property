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
type Channel = 'mail' | 'whatsapp' | 'both'
interface Task {
  id: string; title: string; description: string | null
  created_by: string; assigned_to: string | null; status: TaskStatus
  archived: boolean; completed_at: string | null; created_at: string
  due_date: string | null; accepted_at?: string | null
  // Gesetzt, wenn dies eine Teilaufgabe (Zuarbeit) zu einer anderen Aufgabe ist.
  parent_task_id?: string | null
}
interface TaskMessage { id: string; task_id: string; sender_id: string | null; sender_label: string | null; recipient_id: string; body: string; read_at: string | null; created_at: string }
interface Staff { id: string; full_name: string; email: string; role: string }
// Kontaktvorschlag (Lead oder Geschäftskontakt) für externe Zuständige / Kundenlink
interface Contact { key: string; id: string; kind: 'lead' | 'biz'; name: string; email: string | null; phone: string | null }
interface ExtAssignee { name: string; email: string; phone: string; channel: Channel }
interface Assignee { id: string; profile_id: string | null; ext_name: string | null; ext_email: string | null; ext_phone: string | null; channel: string; accepted_at: string | null }
interface LinkedLead { lead_id: string; name: string; email: string | null; phone: string | null }

const COLUMNS: { status: TaskStatus; label: string; accent: string }[] = [
  { status: 'offen',     label: 'Gestellt',  accent: '#94a3b8' },
  { status: 'in_arbeit', label: 'In Arbeit', accent: '#f59e0b' },
  { status: 'erledigt',  label: 'Erledigt',  accent: '#10b981' },
]
const accentOf = (s: TaskStatus) => COLUMNS.find(c => c.status === s)?.accent ?? '#94a3b8'
// Angenommene Aufgaben (in Arbeit) heben sich farblich ab, erledigte grünlich.
const cardBg   = (s: TaskStatus) => s === 'in_arbeit' ? '#fffbeb' : s === 'erledigt' ? '#f0fdf4' : '#ffffff'
const d2       = (s: string) => new Date(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
const todayIso = () => new Date().toISOString().slice(0, 10)
const isOverdue = (tk: Task) => !!tk.due_date && tk.status !== 'erledigt' && tk.due_date < todayIso()

// Statuswechsel, den ALLE In-App-Wege teilen. Zwei Dinge sind hier wichtig:
//  · completed_by wird gesetzt — ohne das kann die Fertigmeldung nicht erkennen, ob
//    jemand seine eigene Zuarbeit erledigt hat (dann soll keine Nachricht rausgehen).
//    Vorher setzte nur der Token-Link dieses Feld.
//  · Bei einer erledigten Teilaufgabe wird die Rueckmeldung angestossen. Doppelte
//    Nachrichten sind ausgeschlossen: task-notify riegelt ueber done_notified_at ab.
function statusPatch(tk: Task, status: TaskStatus, myId: string): Record<string, unknown> {
  const patch: Record<string, unknown> = { status }
  if (status === 'in_arbeit' && !tk.accepted_at) { patch.accepted_at = new Date().toISOString(); patch.accepted_by = myId }
  if (status === 'erledigt') patch.completed_by = myId
  return patch
}
function notifyIfSubtaskDone(tk: Task, status: TaskStatus) {
  if (status !== 'erledigt' || !tk.parent_task_id) return
  supabase.functions.invoke('task-notify', { body: { mode: 'subtask_done', task_id: tk.id } })
    .catch(e => console.warn('[Tasks] subtask_done:', e))
}

// ── Aufgabe anlegen ──────────────────────────────────────────────────────────
function CreateModal({ staff, myId, onClose, onCreated }: { staff: Staff[]; myId: string; onClose: () => void; onCreated: (m: string) => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [internalIds, setInternalIds] = useState<string[]>([myId])
  const [externals, setExternals] = useState<ExtAssignee[]>([])
  const [customers, setCustomers] = useState<LinkedLead[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  // Kontaktquellen (Leads + Geschäftskontakte) für Vorschläge / Kundenlink
  const [contacts, setContacts] = useState<Contact[]>([])
  useEffect(() => {
    (async () => {
      const [le, bz] = await Promise.all([
        supabase.from('leads').select('id, first_name, last_name, email, phone, whatsapp').limit(1000),
        supabase.from('crm_business_contacts').select('id, first_name, last_name, company, email, phone, whatsapp').limit(1000),
      ])
      const list: Contact[] = []
      for (const l of (le.data ?? []) as Record<string, string | null>[])
        list.push({ key: `lead:${l.id}`, id: l.id!, kind: 'lead', name: `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || (l.email ?? 'Lead'), email: l.email, phone: l.whatsapp || l.phone })
      for (const b of (bz.data ?? []) as Record<string, string | null>[])
        list.push({ key: `biz:${b.id}`, id: b.id!, kind: 'biz', name: `${b.first_name ?? ''} ${b.last_name ?? ''}`.trim() || b.company || (b.email ?? 'Kontakt'), email: b.email, phone: b.whatsapp || b.phone })
      setContacts(list.filter(c => c.name))
    })()
  }, [])

  // Externe-Add-Formular
  const [exName, setExName] = useState(''); const [exEmail, setExEmail] = useState(''); const [exPhone, setExPhone] = useState(''); const [exCh, setExCh] = useState<Channel>('both')
  const [custQuery, setCustQuery] = useState('')

  const toggleInternal = (id: string) => setInternalIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  const prefillExternal = (key: string) => {
    const c = contacts.find(x => x.key === key); if (!c) return
    setExName(c.name); setExEmail(c.email ?? ''); setExPhone(c.phone ?? '')
  }
  const addExternal = () => {
    if (!exName.trim()) return
    if (!exEmail.trim() && !exPhone.trim()) { setErr(t('crm.tasks.extContactReq', 'Externe brauchen E-Mail oder Telefon.')); return }
    setExternals(prev => [...prev, { name: exName.trim(), email: exEmail.trim(), phone: exPhone.trim(), channel: exCh }])
    setExName(''); setExEmail(''); setExPhone(''); setExCh('both'); setErr('')
  }
  const custMatches = custQuery.trim().length >= 2
    ? contacts.filter(c => c.kind === 'lead' && c.name.toLowerCase().includes(custQuery.toLowerCase()) && !customers.some(x => x.lead_id === c.id)).slice(0, 6)
    : []
  const addCustomer = (c: Contact) => { setCustomers(prev => [...prev, { lead_id: c.id, name: c.name, email: c.email, phone: c.phone }]); setCustQuery('') }

  const chLabel = (c: Channel) => c === 'mail' ? 'Mail' : c === 'whatsapp' ? 'WhatsApp' : 'Mail + WhatsApp'

  const save = async () => {
    if (!title.trim()) { setErr(t('crm.tasks.titleRequired', 'Bitte einen Titel angeben.')); return }
    if (internalIds.length === 0 && externals.length === 0) { setErr(t('crm.tasks.assigneeReq', 'Bitte mindestens eine zuständige Person.')); return }
    setSaving(true); setErr('')
    try {
      const firstInternal = internalIds[0] ?? null
      const { data: created, error } = await supabase.from('crm_tasks').insert({
        title: title.trim(), description: description.trim() || null,
        created_by: myId, assigned_to: firstInternal, status: 'offen', due_date: dueDate || null,
        // In-App-Popups laufen über die assignee-Zeilen → alten assigned_to-Pfad stummschalten
        assigned_notified_at: new Date().toISOString(),
      }).select('id').single()
      if (error) throw error
      const taskId = created.id
      const rows = [
        ...internalIds.map(pid => ({ task_id: taskId, profile_id: pid, channel: 'system' })),
        ...externals.map(e => ({ task_id: taskId, ext_name: e.name, ext_email: e.email || null, ext_phone: e.phone || null, channel: e.channel })),
      ]
      if (rows.length) { const r = await supabase.from('crm_task_assignees').insert(rows); if (r.error) throw r.error }
      if (customers.length) await supabase.from('crm_task_leads').insert(customers.map(c => ({ task_id: taskId, lead_id: c.lead_id })))
      // Zustellung (Mail/WhatsApp an Externe, Mail an Interne) im Hintergrund
      supabase.functions.invoke('task-notify', { body: { mode: 'dispatch', task_id: taskId } }).catch(e => console.warn('[Tasks] dispatch:', e))
      onCreated(t('crm.tasks.created', 'Aufgabe angelegt'))
    } catch (e) {
      const msg = e instanceof Error ? e.message
        : (e && typeof e === 'object' && 'message' in e) ? String((e as { message: unknown }).message) : 'Fehler'
      console.error('[Tasks] create:', e); setErr(msg); setSaving(false)
    }
  }

  const input = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">{t('crm.tasks.new', 'Neue Aufgabe')}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.tasks.titleLabel', 'Aufgabe')}</label>
            <input value={title} onChange={e => setTitle(e.target.value)} autoFocus className={input} placeholder={t('crm.tasks.titlePh', 'Kurzer Titel')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.tasks.descLabel', 'Beschreibung')}</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className={input} placeholder={t('crm.tasks.descPh', 'Details zur Aufgabe …')} />
          </div>

          {/* Interne Zuständige (Mehrfach) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.tasks.internalAssignees', 'Mitarbeiter')}</label>
            <div className="flex flex-wrap gap-1.5">
              {staff.map(s => {
                const on = internalIds.includes(s.id)
                return (
                  <button key={s.id} type="button" onClick={() => toggleInternal(s.id)}
                    className={`text-xs px-3 py-1.5 rounded-full border ${on ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}
                    style={on ? { backgroundColor: '#ff795d' } : undefined}>
                    {(s.full_name || s.email)}{s.id === myId ? ` (${t('crm.tasks.me', 'ich')})` : ''}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Externe Zuständige */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.tasks.externalAssignees', 'Externe Personen (per Mail/WhatsApp)')}</label>
            {externals.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {externals.map((e, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 bg-gray-50 border border-gray-100 rounded-lg px-3 py-1.5">
                    <span className="text-xs text-gray-700 truncate">{e.name} · {e.email || e.phone} · <span className="text-gray-400">{chLabel(e.channel)}</span></span>
                    <button type="button" onClick={() => setExternals(prev => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500 text-xs shrink-0">✕</button>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1.5 bg-gray-50 border border-gray-100 rounded-xl p-2.5">
              {contacts.length > 0 && (
                <select onChange={e => { prefillExternal(e.target.value); e.currentTarget.selectedIndex = 0 }} className={input + ' bg-white'}>
                  <option value="">{t('crm.tasks.pickContact', '— aus Kontakten wählen (optional) —')}</option>
                  {contacts.map(c => <option key={c.key} value={c.key}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>)}
                </select>
              )}
              <input value={exName} onChange={e => setExName(e.target.value)} className={input} placeholder={t('crm.tasks.extName', 'Name')} />
              <div className="flex gap-1.5">
                <input value={exEmail} onChange={e => setExEmail(e.target.value)} className={input} placeholder={t('crm.tasks.extEmail', 'E-Mail')} />
                <input value={exPhone} onChange={e => setExPhone(e.target.value)} className={input} placeholder={t('crm.tasks.extPhone', 'Telefon')} />
              </div>
              <div className="flex gap-1.5">
                <select value={exCh} onChange={e => setExCh(e.target.value as Channel)} className={input + ' bg-white'}>
                  <option value="both">{t('crm.tasks.chBoth', 'Mail + WhatsApp')}</option>
                  <option value="mail">{t('crm.tasks.chMail', 'Nur Mail')}</option>
                  <option value="whatsapp">{t('crm.tasks.chWa', 'Nur WhatsApp')}</option>
                </select>
                <button type="button" onClick={addExternal} className="whitespace-nowrap px-3 py-2 rounded-lg text-sm font-medium text-white" style={{ backgroundColor: '#0f172a' }}>
                  {t('crm.tasks.addPerson', '+ Person')}
                </button>
              </div>
            </div>
          </div>

          {/* Kunden verknüpfen */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.tasks.linkCustomers', 'Kunden verknüpfen (Kontaktdaten in der Aufgabe)')}</label>
            {customers.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {customers.map(c => (
                  <span key={c.lead_id} className="inline-flex items-center gap-1 text-xs bg-orange-50 border border-orange-100 text-gray-700 rounded-full px-2.5 py-1">
                    {c.name}
                    <button type="button" onClick={() => setCustomers(prev => prev.filter(x => x.lead_id !== c.lead_id))} className="text-gray-400 hover:text-red-500">✕</button>
                  </span>
                ))}
              </div>
            )}
            <div className="relative">
              <input value={custQuery} onChange={e => setCustQuery(e.target.value)} className={input} placeholder={t('crm.tasks.custSearch', 'Kunde suchen …')} />
              {custMatches.length > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                  {custMatches.map(c => (
                    <button key={c.key} type="button" onClick={() => addCustomer(c)} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
                      {c.name}{c.phone ? ` · ${c.phone}` : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('crm.tasks.dueLabel', 'Frist (optional)')}</label>
            <input type="date" value={dueDate} min={todayIso()} onChange={e => setDueDate(e.target.value)} className={input} />
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100 shrink-0">
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
  const [subtasks, setSubtasks] = useState<Task[]>([])
  const [subOpen, setSubOpen] = useState(false)
  const [subTitle, setSubTitle] = useState(''); const [subWho, setSubWho] = useState('')
  const [subDue, setSubDue] = useState(''); const [subBusy, setSubBusy] = useState(false)
  const [assignees, setAssignees] = useState<Assignee[]>([])
  const [customers, setCustomers] = useState<LinkedLead[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const nameOf = (id: string | null) => (id && (staff.find(s => s.id === id)?.full_name || staff.find(s => s.id === id)?.email)) || '—'
  const [due, setDue] = useState(task.due_date ?? '')
  const iAmCreator  = task.created_by === myId
  const iAmAssignee = assignees.some(a => a.profile_id === myId)
  // Gegenpart für In-App-Nachricht: Ersteller → erster interner Zuständiger (nicht ich); sonst → Ersteller.
  const internalOther = assignees.map(a => a.profile_id).find(pid => pid && pid !== myId) ?? null
  const recipient = iAmCreator ? internalOther : task.created_by
  const chLabel = (c: string) => c === 'mail' ? 'Mail' : c === 'whatsapp' ? 'WhatsApp' : c === 'both' ? 'Mail + WhatsApp' : 'im System'

  const saveDue = async (v: string) => {
    setDue(v)
    const { error } = await supabase.from('crm_tasks').update({ due_date: v || null }).eq('id', task.id)
    if (!error) onChanged()
  }

  const loadAll = useCallback(async () => {
    const [msgRes, asgRes, leadRes, subRes] = await Promise.all([
      supabase.from('crm_task_messages').select('*').eq('task_id', task.id).order('created_at', { ascending: true }),
      supabase.from('crm_task_assignees').select('id, profile_id, ext_name, ext_email, ext_phone, channel, accepted_at').eq('task_id', task.id),
      supabase.from('crm_task_leads').select('lead_id, lead:leads(first_name, last_name, email, phone, whatsapp)').eq('task_id', task.id),
      supabase.from('crm_tasks').select('*').eq('parent_task_id', task.id).order('created_at', { ascending: true }),
    ])
    setSubtasks((subRes.data ?? []) as Task[])
    setMessages((msgRes.data ?? []) as TaskMessage[])
    setAssignees((asgRes.data ?? []) as Assignee[])
    // deno-lint-ignore no-explicit-any
    setCustomers(((leadRes.data ?? []) as any[]).map(r => ({
      lead_id: r.lead_id, name: `${r.lead?.first_name ?? ''} ${r.lead?.last_name ?? ''}`.trim() || (r.lead?.email ?? 'Kunde'),
      email: r.lead?.email ?? null, phone: r.lead?.whatsapp || r.lead?.phone || null,
    })))
    await supabase.from('crm_task_messages').update({ read_at: new Date().toISOString() }).eq('task_id', task.id).eq('recipient_id', myId).is('read_at', null)
  }, [task.id, myId])
  useEffect(() => { loadAll() }, [loadAll])

  const setStatus = async (status: TaskStatus) => {
    const { error } = await supabase.from('crm_tasks').update(statusPatch(task, status, myId)).eq('id', task.id)
    if (!error) { notifyIfSubtaskDone(task, status); onChanged() }
  }

  const send = async () => {
    if (!text.trim()) return
    setSending(true)
    const body = text.trim()
    try {
      const { error } = await supabase.from('crm_task_messages').insert({
        task_id: task.id, sender_id: myId, sender_label: nameOf(myId), recipient_id: recipient ?? myId, body,
      })
      if (error) throw error
      setText(''); await loadAll()
      const rec = recipient ? staff.find(s => s.id === recipient) : null
      if (rec?.email) {
        supabase.functions.invoke('send-email', { body: {
          to: rec.email, subject: `Aufgabe: ${task.title}`,
          html: `<p>Hallo ${(rec.full_name || '').split(' ')[0]},</p><p>${nameOf(myId)} hat dir zu der Aufgabe <strong>${task.title}</strong> geschrieben:</p><blockquote style="border-left:3px solid #ff795d;padding-left:12px;color:#374151;">${body.replace(/</g, '&lt;')}</blockquote><p style="font-size:13px;color:#6b7280;">Antworte direkt in der App unter Aufgaben.</p>`,
        } }).catch(e => console.warn('[Tasks] Mail-Benachrichtigung:', e))
      }
    } catch (e) { console.error('[Tasks] send:', e) } finally { setSending(false) }
  }

  // Teilaufgabe stellen: eine ganz normale Aufgabe mit Elternteil. Sie erbt damit
  // Annehmen, Erledigen, Chat, Erinnerungen und den Token-Link — nichts davon muss
  // ein zweites Mal gebaut werden.
  const addSubtask = async () => {
    const title = subTitle.trim()
    if (!title || !subWho || subBusy) return
    setSubBusy(true)
    try {
      const { data: created, error } = await supabase.from('crm_tasks').insert({
        title, parent_task_id: task.id, created_by: myId, assigned_to: subWho,
        status: 'offen', due_date: subDue || null,
      }).select('id').single()
      if (error) throw error
      const newId = (created as { id: string }).id
      const { error: aErr } = await supabase.from('crm_task_assignees').insert({ task_id: newId, profile_id: subWho, channel: 'system' })
      if (aErr) throw aErr
      // Zustellung (Mail an interne Zuständige) wie bei jeder anderen Aufgabe.
      supabase.functions.invoke('task-notify', { body: { mode: 'dispatch', task_id: newId } })
        .catch(e => console.warn('[Tasks] subtask dispatch:', e))
      setSubTitle(''); setSubWho(''); setSubDue(''); setSubOpen(false)
      await loadAll(); onChanged()
    } catch (e) { console.error('[Tasks] addSubtask:', e) } finally { setSubBusy(false) }
  }

  const setSubStatus = async (st: Task, status: TaskStatus) => {
    const { error } = await supabase.from('crm_tasks').update(statusPatch(st, status, myId)).eq('id', st.id)
    if (error) { console.error('[Tasks] setSubStatus:', error); return }
    notifyIfSubtaskDone(st, status)
    await loadAll(); onChanged()
  }

  const assigneeLabel = (a: Assignee) => a.profile_id ? nameOf(a.profile_id) : `${a.ext_name ?? 'Extern'} (${chLabel(a.channel)})`

  // ── Bearbeiten (nur Ersteller): Text + Zuständige + Kunden ────────────────
  const [editing, setEditing] = useState(false)
  const [eTitle, setETitle] = useState(task.title)
  const [eDesc, setEDesc] = useState(task.description ?? '')
  const [savingEdit, setSavingEdit] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [exName, setExName] = useState(''); const [exEmail, setExEmail] = useState(''); const [exPhone, setExPhone] = useState(''); const [exCh, setExCh] = useState<Channel>('both')
  const [custQuery, setCustQuery] = useState('')
  const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'

  const startEdit = async () => {
    setETitle(task.title); setEDesc(task.description ?? ''); setEditing(true)
    if (contacts.length === 0) {
      const [le, bz] = await Promise.all([
        supabase.from('leads').select('id, first_name, last_name, email, phone, whatsapp').limit(1000),
        supabase.from('crm_business_contacts').select('id, first_name, last_name, company, email, phone, whatsapp').limit(1000),
      ])
      const list: Contact[] = []
      for (const l of (le.data ?? []) as Record<string, string | null>[]) list.push({ key: `lead:${l.id}`, id: l.id!, kind: 'lead', name: `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim() || (l.email ?? 'Lead'), email: l.email, phone: l.whatsapp || l.phone })
      for (const b of (bz.data ?? []) as Record<string, string | null>[]) list.push({ key: `biz:${b.id}`, id: b.id!, kind: 'biz', name: `${b.first_name ?? ''} ${b.last_name ?? ''}`.trim() || b.company || (b.email ?? 'Kontakt'), email: b.email, phone: b.whatsapp || b.phone })
      setContacts(list.filter(c => c.name))
    }
  }
  const saveText = async () => {
    if (!eTitle.trim()) return
    setSavingEdit(true)
    const { error } = await supabase.from('crm_tasks').update({ title: eTitle.trim(), description: eDesc.trim() || null }).eq('id', task.id)
    setSavingEdit(false)
    if (!error) { setEditing(false); onChanged() }
  }
  const dispatchNew = () => supabase.functions.invoke('task-notify', { body: { mode: 'dispatch', task_id: task.id } }).catch(e => console.warn('[Tasks] dispatch:', e))
  const toggleInternalEdit = async (pid: string) => {
    const existing = assignees.find(a => a.profile_id === pid)
    if (existing) await supabase.from('crm_task_assignees').delete().eq('id', existing.id)
    else { await supabase.from('crm_task_assignees').insert({ task_id: task.id, profile_id: pid, channel: 'system' }); dispatchNew() }
    await loadAll()
  }
  const addExternalEdit = async () => {
    if (!exName.trim() || (!exEmail.trim() && !exPhone.trim())) return
    await supabase.from('crm_task_assignees').insert({ task_id: task.id, ext_name: exName.trim(), ext_email: exEmail.trim() || null, ext_phone: exPhone.trim() || null, channel: exCh })
    setExName(''); setExEmail(''); setExPhone(''); setExCh('both'); dispatchNew(); await loadAll()
  }
  const removeAssignee = async (id: string) => { await supabase.from('crm_task_assignees').delete().eq('id', id); await loadAll() }
  const custMatches = custQuery.trim().length >= 2 ? contacts.filter(c => c.kind === 'lead' && c.name.toLowerCase().includes(custQuery.toLowerCase()) && !customers.some(x => x.lead_id === c.id)).slice(0, 6) : []
  const addCustomerEdit = async (c: Contact) => { await supabase.from('crm_task_leads').insert({ task_id: task.id, lead_id: c.id }); setCustQuery(''); await loadAll() }
  const removeCustomer = async (leadId: string) => { await supabase.from('crm_task_leads').delete().eq('task_id', task.id).eq('lead_id', leadId); await loadAll() }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100">
          <div className="min-w-0 flex-1">
            {editing
              ? <input value={eTitle} onChange={e => setETitle(e.target.value)} className={inputCls + ' font-semibold'} />
              : <h2 className="text-lg font-semibold text-gray-900 truncate">{task.title}</h2>}
            <p className="text-xs text-gray-400 mt-0.5">{t('crm.tasks.from', 'von')} {nameOf(task.created_by)}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            {iAmCreator && !editing && (
              <button onClick={startEdit} className="text-base leading-none" title={t('common.edit', 'Bearbeiten')}>✏️</button>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
          </div>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          {editing ? (
            <div className="space-y-2">
              <textarea value={eDesc} onChange={e => setEDesc(e.target.value)} rows={3} className={inputCls} placeholder={t('crm.tasks.descPh', 'Details zur Aufgabe …')} />
              <div className="flex gap-2">
                <button onClick={saveText} disabled={savingEdit || !eTitle.trim()} className="px-3 py-1.5 rounded-lg text-white text-sm font-medium disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>{savingEdit ? '…' : t('common.save', 'Speichern')}</button>
                <button onClick={() => setEditing(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-600 hover:bg-gray-100">{t('common.done', 'Fertig')}</button>
              </div>
            </div>
          ) : task.description ? (
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{task.description}</p>
          ) : null}

          {editing ? (
            <div className="space-y-3">
              {/* Interne Zuständige */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t('crm.tasks.internalAssignees', 'Mitarbeiter')}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {staff.map(s => {
                    const on = assignees.some(a => a.profile_id === s.id)
                    return (
                      <button key={s.id} onClick={() => toggleInternalEdit(s.id)}
                        className={`text-xs px-3 py-1.5 rounded-full border ${on ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}
                        style={on ? { backgroundColor: '#ff795d' } : undefined}>
                        {(s.full_name || s.email)}{s.id === myId ? ` (${t('crm.tasks.me', 'ich')})` : ''}
                      </button>
                    )
                  })}
                </div>
              </div>
              {/* Externe Zuständige */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t('crm.tasks.externalAssignees', 'Externe Personen (per Mail/WhatsApp)')}</h3>
                {assignees.filter(a => !a.profile_id).length > 0 && (
                  <div className="space-y-1.5 mb-2">
                    {assignees.filter(a => !a.profile_id).map(a => (
                      <div key={a.id} className="flex items-center justify-between gap-2 bg-gray-50 border border-gray-100 rounded-lg px-3 py-1.5">
                        <span className="text-xs text-gray-700 truncate">{a.ext_name} · {a.ext_email || a.ext_phone} · <span className="text-gray-400">{chLabel(a.channel)}</span></span>
                        <button onClick={() => removeAssignee(a.id)} className="text-gray-400 hover:text-red-500 text-xs shrink-0">✕</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="space-y-1.5 bg-gray-50 border border-gray-100 rounded-xl p-2.5">
                  {contacts.length > 0 && (
                    <select onChange={e => { const c = contacts.find(x => x.key === e.target.value); if (c) { setExName(c.name); setExEmail(c.email ?? ''); setExPhone(c.phone ?? '') } e.currentTarget.selectedIndex = 0 }} className={inputCls + ' bg-white'}>
                      <option value="">{t('crm.tasks.pickContact', '— aus Kontakten wählen (optional) —')}</option>
                      {contacts.map(c => <option key={c.key} value={c.key}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>)}
                    </select>
                  )}
                  <input value={exName} onChange={e => setExName(e.target.value)} className={inputCls} placeholder={t('crm.tasks.extName', 'Name')} />
                  <div className="flex gap-1.5">
                    <input value={exEmail} onChange={e => setExEmail(e.target.value)} className={inputCls} placeholder={t('crm.tasks.extEmail', 'E-Mail')} />
                    <input value={exPhone} onChange={e => setExPhone(e.target.value)} className={inputCls} placeholder={t('crm.tasks.extPhone', 'Telefon')} />
                  </div>
                  <div className="flex gap-1.5">
                    <select value={exCh} onChange={e => setExCh(e.target.value as Channel)} className={inputCls + ' bg-white'}>
                      <option value="both">{t('crm.tasks.chBoth', 'Mail + WhatsApp')}</option>
                      <option value="mail">{t('crm.tasks.chMail', 'Nur Mail')}</option>
                      <option value="whatsapp">{t('crm.tasks.chWa', 'Nur WhatsApp')}</option>
                    </select>
                    <button onClick={addExternalEdit} className="whitespace-nowrap px-3 py-2 rounded-lg text-sm font-medium text-white" style={{ backgroundColor: '#0f172a' }}>{t('crm.tasks.addPerson', '+ Person')}</button>
                  </div>
                </div>
              </div>
              {/* Kunden verknüpfen */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t('crm.tasks.customers', 'Kunden')}</h3>
                {customers.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {customers.map(c => (
                      <span key={c.lead_id} className="inline-flex items-center gap-1 text-xs bg-orange-50 border border-orange-100 text-gray-700 rounded-full px-2.5 py-1">
                        {c.name}
                        <button onClick={() => removeCustomer(c.lead_id)} className="text-gray-400 hover:text-red-500">✕</button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="relative">
                  <input value={custQuery} onChange={e => setCustQuery(e.target.value)} className={inputCls} placeholder={t('crm.tasks.custSearch', 'Kunde suchen …')} />
                  {custMatches.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                      {custMatches.map(c => (
                        <button key={c.key} onClick={() => addCustomerEdit(c)} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50">{c.name}{c.phone ? ` · ${c.phone}` : ''}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Zuständige */}
              {assignees.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t('crm.tasks.assignees', 'Zuständig')}</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {assignees.map(a => (
                      <span key={a.id} className="inline-flex items-center gap-1 text-xs rounded-full px-2.5 py-1 border"
                        style={a.accepted_at ? { backgroundColor: '#fffbeb', borderColor: '#fde68a', color: '#92400e' } : { backgroundColor: '#f9fafb', borderColor: '#f1f1f1', color: '#374151' }}>
                        {a.accepted_at && '✓ '}{assigneeLabel(a)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {/* Verknüpfte Kunden mit Kontaktdaten */}
              {customers.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{t('crm.tasks.customers', 'Kunden')}</h3>
                  <div className="space-y-1.5">
                    {customers.map(c => (
                      <div key={c.lead_id} className="text-xs bg-orange-50 border border-orange-100 rounded-lg px-3 py-2">
                        <span className="font-medium text-gray-800">{c.name}</span>
                        {(c.phone || c.email) && <span className="text-gray-500"> · {[c.phone, c.email].filter(Boolean).join(' · ')}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Meta: gestellt am + Frist */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="text-gray-400">{t('crm.tasks.createdOn', 'Gestellt')} {d2(task.created_at)}</span>
            {iAmCreator ? (
              <label className="flex items-center gap-2 text-gray-500">
                {t('crm.tasks.dueLabel', 'Frist (optional)')}
                <input type="date" value={due} onChange={e => saveDue(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-orange-400" />
              </label>
            ) : due ? (
              <span className={isOverdue({ ...task, due_date: due }) ? 'text-red-500 font-semibold' : 'text-gray-500'}>
                {t('crm.tasks.due', 'Frist')} {d2(due)}{isOverdue({ ...task, due_date: due }) ? ` · ${t('crm.tasks.overdue', 'überfällig')}` : ''}
              </span>
            ) : null}
          </div>

          {/* Annehmen: Zuständige:r bestätigt → In Arbeit */}
          {iAmAssignee && task.status === 'offen' && (
            <button onClick={() => setStatus('in_arbeit')}
              className="w-full py-2.5 rounded-xl text-white text-sm font-semibold" style={{ backgroundColor: '#f59e0b' }}>
              ✋ {t('crm.tasks.accept', 'Aufgabe annehmen')}
            </button>
          )}

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

          {/* Teilaufgaben (Zuarbeit) */}
          <div className="pt-2 border-t border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                {t('crm.tasks.subtasks', 'Zuarbeit')}{subtasks.length ? ` (${subtasks.filter(x => x.status !== 'erledigt').length}/${subtasks.length} ${t('crm.tasks.subOpen', 'offen')})` : ''}
              </h3>
              <button onClick={() => setSubOpen(o => !o)} className="text-xs font-medium text-gray-600 border border-gray-200 rounded-lg px-2 py-1 hover:bg-gray-50">
                {subOpen ? t('common.cancel', 'Abbrechen') : `+ ${t('crm.tasks.addSubtask', 'Teilaufgabe')}`}
              </button>
            </div>

            {subOpen && (
              <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-2 mb-3">
                <input value={subTitle} onChange={e => setSubTitle(e.target.value)}
                  placeholder={t('crm.tasks.subTitlePh', 'Was soll zugearbeitet werden?')}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                <div className="flex gap-2">
                  <select value={subWho} onChange={e => setSubWho(e.target.value)}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400">
                    <option value="">{t('crm.tasks.subWho', 'Wer arbeitet zu?')}</option>
                    {staff.filter(sf => sf.id !== myId).map(sf => (
                      <option key={sf.id} value={sf.id}>{sf.full_name || sf.email}</option>
                    ))}
                  </select>
                  <input type="date" value={subDue} onChange={e => setSubDue(e.target.value)}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400" />
                </div>
                <button onClick={addSubtask} disabled={!subTitle.trim() || !subWho || subBusy}
                  className="w-full py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-40"
                  style={{ backgroundColor: '#ff795d' }}>
                  {subBusy ? t('common.saving', 'speichert …') : t('crm.tasks.subAssign', 'Zuarbeit vergeben')}
                </button>
                <p className="text-[11px] text-gray-400">
                  {t('crm.tasks.subHint', 'Der andere nimmt sie an und markiert sie als erledigt — du bekommst dann automatisch Bescheid.')}
                </p>
              </div>
            )}

            {subtasks.length === 0 ? (
              <p className="text-xs text-gray-400">{t('crm.tasks.noSubtasks', 'Noch keine Zuarbeit vergeben.')}</p>
            ) : (
              <div className="space-y-2">
                {subtasks.map(st => {
                  const mineToDo = st.assigned_to === myId
                  return (
                    <div key={st.id} className="rounded-xl border p-2.5" style={{ borderColor: '#f1f1f1', backgroundColor: cardBg(st.status), borderLeft: `3px solid ${accentOf(st.status)}` }}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm text-gray-900">{st.title}</span>
                        <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: accentOf(st.status) }}>
                          {COLUMNS.find(c => c.status === st.status)?.label}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px] text-gray-400">
                        <span>→ {nameOf(st.assigned_to)}</span>
                        {st.due_date && <span className={isOverdue(st) ? 'text-red-500 font-semibold' : ''}>{t('crm.tasks.due', 'Frist')} {d2(st.due_date)}</span>}
                      </div>
                      {mineToDo && st.status !== 'erledigt' && (
                        <div className="flex gap-2 mt-2">
                          {st.status === 'offen' && (
                            <button onClick={() => setSubStatus(st, 'in_arbeit')}
                              className="flex-1 py-1.5 rounded-lg text-white text-xs font-semibold" style={{ backgroundColor: '#f59e0b' }}>
                              ✋ {t('crm.tasks.accept', 'Aufgabe annehmen')}
                            </button>
                          )}
                          <button onClick={() => setSubStatus(st, 'erledigt')}
                            className="flex-1 py-1.5 rounded-lg text-white text-xs font-semibold" style={{ backgroundColor: '#10b981' }}>
                            ✓ {t('crm.tasks.markDone', 'Erledigt')}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Nachrichten / Bemerkungen */}
          <div className="pt-2 border-t border-gray-100">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('crm.tasks.chat', 'Nachrichten')}</h3>
            <div className="space-y-2 max-h-52 overflow-y-auto mb-3">
              {messages.length === 0 && <p className="text-xs text-gray-400">{t('crm.tasks.noMsg', 'Noch keine Nachrichten.')}</p>}
              {messages.map(m => {
                const mine = m.sender_id === myId
                const who = m.sender_id ? nameOf(m.sender_id) : (m.sender_label || 'Extern')
                return (
                  <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-orange-100 text-gray-800' : 'bg-gray-100 text-gray-800'}`}>
                      {!mine && <p className="text-[10px] font-semibold text-gray-500 mb-0.5">{who}</p>}
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
  const [dragId, setDragId]     = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null)
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  // Kachel per Drag & Drop in eine andere Spalte ziehen = Status ändern
  // (z.B. „In Arbeit" = angenommen). Optimistisch mit Rollback bei Fehler.
  const handleDrop = async (status: TaskStatus) => {
    const id = dragId
    setDragId(null); setDragOver(null)
    if (!id) return
    const tk = tasks.find(x => x.id === id)
    if (!tk || tk.status === status) return
    const prev = tasks
    setTasks(ts => ts.map(x => x.id === id ? { ...x, status } : x))
    const { error } = await supabase.from('crm_tasks').update(statusPatch(tk, status, myId)).eq('id', id)
    if (error) { setTasks(prev); showToast(t('common.error', 'Fehler')); return }
    notifyIfSubtaskDone(tk, status)
  }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [tRes, sRes, mRes] = await Promise.all([
        // Nur Hauptaufgaben aufs Board: eine gruen abgehakte Teilaufgabe neben ihrer
        // noch offenen Hauptaufgabe waere irrefuehrend. Teilaufgaben stehen in der
        // Hauptaufgabe und auf der Startseite dessen, der sie erledigen soll.
        supabase.from('crm_tasks').select('*').eq('archived', false).is('parent_task_id', null).order('created_at', { ascending: false }),
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

  const nameOf = (id: string | null) => (id && staff.find(s => s.id === id)?.full_name) || t('crm.tasks.external', 'extern')

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">{toast}</div>}

      <div className="p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('crm.tasks.title', 'Aufgaben')}</h1>
            <p className="text-sm text-gray-500 mt-0.5">{t('crm.tasks.subtitle', 'Aufgaben stellen, zuweisen und den Status verfolgen. Erledigte werden zum Tagesende archiviert.')}</p>
            <p className="hidden md:block text-xs text-gray-400 mt-0.5">{t('crm.tasks.dragHint', 'Tipp: Kachel in eine andere Spalte ziehen, um den Status zu ändern.')}</p>
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
                <div key={col.status}
                  onDragOver={e => { e.preventDefault(); setDragOver(col.status) }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={e => { e.preventDefault(); handleDrop(col.status) }}
                  className={`rounded-2xl p-3 transition-colors ${dragOver === col.status ? 'bg-orange-50 ring-2 ring-orange-300' : 'bg-gray-50'}`}>
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
                          draggable
                          onDragStart={() => setDragId(task.id)}
                          onDragEnd={() => { setDragId(null); setDragOver(null) }}
                          className={`w-full text-left rounded-xl border border-gray-100 shadow-sm p-3 hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing ${dragId === task.id ? 'opacity-50' : ''}`}
                          style={{ backgroundColor: cardBg(task.status), borderLeft: `3px solid ${accentOf(task.status)}` }}>
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-medium text-gray-900 text-sm">{task.title}</span>
                            {unread[task.id] && <span className="shrink-0 text-[10px] font-bold text-white bg-red-500 rounded-full px-1.5 py-0.5">{unread[task.id]}</span>}
                          </div>
                          {task.description && <p className="text-xs text-gray-400 mt-1 line-clamp-2">{task.description}</p>}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-2 text-[11px] text-gray-400">
                            <span>{mine ? `→ ${nameOf(task.assigned_to)}` : `${t('crm.tasks.fromShort', 'von')} ${nameOf(task.created_by)}`}</span>
                            <span>· {t('crm.tasks.createdOn', 'Gestellt')} {d2(task.created_at)}</span>
                            {task.due_date && (
                              <span className={isOverdue(task) ? 'text-red-500 font-semibold' : ''}>
                                · {t('crm.tasks.due', 'Frist')} {d2(task.due_date)}
                              </span>
                            )}
                          </div>
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
